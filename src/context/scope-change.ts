import { createHash } from 'node:crypto';
import { createClaim, updateClaim } from '../runtime/claim-store.js';
import { resolveTaskEntityHomeStore } from '../runtime/entity-home-store.js';
import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import {
  createCheckpointRecoveryAction,
  createClaimRecoveryAction,
  createTaskAuthorityFileRecoveryAction,
  createTaskHeadFenceRecoveryAction,
} from '../runtime/operation-recovery-payload.js';
import {
  readCheckoutBranch,
  readProjectRuntimeContext,
} from '../runtime/project-runtime.js';
import type { TaskHeadFenceV1 } from '../runtime/task-head-fence.js';
import { replaceTaskHeadFence } from '../runtime/task-head-store.js';
import {
  type OpenedV3TaskOperation,
  advanceTaskOperation,
  commitTaskOperation,
  createTaskOperationJournal,
  handleTaskOperationFailure,
  openV3TaskOperation,
  serializeTaskAuthority,
  taskEntityKey,
  taskHeadEntityKey,
  writeTaskAuthorityFile,
  writeTaskCheckpoint,
} from '../runtime/task-operation.js';
import { type CheckpointV1, parseCheckpoint } from '../team/checkpoints.js';
import {
  type ClaimV1,
  assertClaimTransition,
  parseClaim,
} from '../team/claims.js';
import {
  deriveClaimValidity,
  evaluateClaimScopeSubset,
} from '../team/conflicts.js';
import { capabilitiesFromProjectConfig } from '../team/transport.js';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
} from './aggregate.js';
import { digestCanonicalJson, sortUtf8StringSet } from './canonical.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { assertSharedTextSafe } from './privacy.js';
import { V3ContextStore } from './store.js';
import {
  assertTaskCodeHeadUnchanged,
  nextTaskHeadFence,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface ChangeV3WorkflowScopeInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  /** JSON object with the complete replacement { include, exclude, modules }. */
  scope: unknown;
  checkpointSummary?: string;
  checkpointNextAction?: string;
  checkpointId?: Ulid;
  /** Optional explicit successor IDs, ordered by predecessor claim ID. */
  successorClaimIds?: Ulid[];
  operationId?: Ulid;
  now?: Date;
}

export interface ChangedV3WorkflowScope {
  metadata: WorkflowMetadataV3;
  checkpoint: CheckpointV1;
  terminatedClaims: ClaimV1[];
  successorClaims: ClaimV1[];
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1;
  operation: OperationJournalV1;
}

/**
 * Replaces a shared team task's implementation scope without ever mutating a
 * claim's immutable acquisition snapshot. Claims still contained by the new
 * scope receive a fresh successor identity; other active claims are released.
 */
export async function changeV3WorkflowScope(
  input: ChangeV3WorkflowScopeInput,
): Promise<ChangedV3WorkflowScope> {
  const taskRef = parseTaskRefValue(input.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_SCOPE_CHANGE_REQUIRES_SHARED_TASK');
  }
  const scope = normalizeImplementationScope(input.scope);
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const checkpointId = input.checkpointId ?? createUlid(now.getTime());
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(checkpointId, 'scope change checkpointId');
  assertUlid(operationId, 'scope change operationId');

  const opened = await openScopeChangeContext({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    scope,
    checkpointId,
    successorClaimIds: input.successorClaimIds,
    operationId,
    now,
  });
  const { context, activeClaims, successorClaimIds, successorPredecessors } =
    opened;
  let journal: OperationJournalV1 | null = null;
  try {
    assertScopeChangeEligible(context, scope);
    assertClaimsFreshForScopeChange(context, activeClaims);
    const pendingMetadata = markScopeChangeOperationPending(
      context.task.metadata,
      context.operationId,
      timestamp,
    );
    const branch = (await readCheckoutBranch(context.projectRoot)) ?? 'HEAD';
    const checkpoint = buildScopeChangedCheckpoint(
      context,
      pendingMetadata,
      checkpointId,
      input.checkpointSummary,
      input.checkpointNextAction,
      branch,
      timestamp,
    );
    const metadata = completeScopeChangeMetadata(
      pendingMetadata,
      scope,
      checkpoint,
      context.operationId,
      timestamp,
    );
    const pendingSuccessorClaims = buildPendingSuccessorClaims(
      successorPredecessors,
      successorClaimIds,
      metadata,
      branch,
      requireCodeHead(context),
      context.operationId,
      timestamp,
      capabilitiesFromProjectConfig(context.project.config),
    );
    const successorByPredecessor = new Map<Ulid, Ulid>(
      successorPredecessors.map((claim, index) => {
        const successorClaimId = successorClaimIds[index];
        if (successorClaimId === undefined) {
          throw new Error('MANCODE_SCOPE_SUCCESSOR_CLAIM_COUNT_INVALID');
        }
        return [claim.claimId, successorClaimId];
      }),
    );
    const terminatedClaims = activeClaims.map((claim) =>
      terminateClaimForScopeChange(
        claim,
        successorByPredecessor.get(claim.claimId) ?? null,
        context.operationId,
        timestamp,
      ),
    );
    const activeSuccessorClaims = pendingSuccessorClaims.map((claim) =>
      activateSuccessorClaim(claim, context.operationId, timestamp),
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: context.task.requirements,
      review: context.task.review,
      verification: context.task.verification,
      planDigest: context.task.plan?.digest ?? null,
      latestCheckpoint: checkpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);
    if (taskHeadFence === null) {
      throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
    }

    journal = await createTaskOperationJournal(context, {
      type: 'scope_change_reclaim',
      action: 'task_complete_scope_change_child_merge',
      expectedRevisions: scopeChangeExpectedRevisions(
        context,
        checkpointId,
        activeClaims,
        successorClaimIds,
      ),
      conditions: { completionGateSatisfied: true },
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-task-operation-pending',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
            targetContent: serializeTaskAuthority(pendingMetadata),
          }),
          createCheckpointRecoveryAction({
            stepId: 'write-scope-changed-checkpoint',
            before: null,
            checkpoint,
          }),
          ...pendingSuccessorClaims.map((claim) =>
            createClaimRecoveryAction({
              stepId: 'create-pending-successor-claims',
              before: null,
              claim,
            }),
          ),
          ...terminatedClaims.map((claim, index) => {
            const before = activeClaims[index];
            if (before === undefined) {
              throw new Error('MANCODE_CLAIM_SET_CHANGED');
            }
            return createClaimRecoveryAction({
              stepId: 'terminate-old-claims',
              before,
              claim,
            });
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'update-metadata-scope',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(pendingMetadata),
            targetContent: serializeTaskAuthority(metadata),
          }),
          ...activeSuccessorClaims.map((claim, index) => {
            const before = pendingSuccessorClaims[index];
            if (before === undefined) {
              throw new Error('MANCODE_SCOPE_SUCCESSOR_CLAIM_COUNT_INVALID');
            }
            return createClaimRecoveryAction({
              stepId: 'activate-successor-claims',
              before,
              claim,
            });
          }),
          createTaskHeadFenceRecoveryAction({
            stepId: 'update-task-head-fence',
            before: context.coordination.taskHeadFence,
            fence: taskHeadFence,
          }),
        ],
        noOpStepIds: [
          ...(pendingSuccessorClaims.length === 0
            ? ['create-pending-successor-claims']
            : []),
          ...(terminatedClaims.length === 0 ? ['terminate-old-claims'] : []),
          ...(activeSuccessorClaims.length === 0
            ? ['activate-successor-claims']
            : []),
        ],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);

    journal = await advanceTaskOperation(
      context,
      journal,
      'mark-task-operation-pending',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await writeTaskAuthorityFile(
      context,
      'metadata.json',
      `${JSON.stringify(pendingMetadata, null, 2)}\n`,
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'write-scope-changed-checkpoint',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await writeTaskCheckpoint(context, checkpoint);

    journal = await advanceTaskOperation(
      context,
      journal,
      'create-pending-successor-claims',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    for (const claim of pendingSuccessorClaims) {
      await createClaim(context.homeStore, claim);
    }

    journal = await advanceTaskOperation(
      context,
      journal,
      'terminate-old-claims',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    for (const [index, claim] of terminatedClaims.entries()) {
      const previous = activeClaims[index];
      if (previous === undefined) {
        throw new Error('MANCODE_CLAIM_SET_CHANGED');
      }
      await updateClaim(context.homeStore, claim, previous.revision);
    }

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-metadata-scope',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await writeTaskAuthorityFile(
      context,
      'metadata.json',
      `${JSON.stringify(metadata, null, 2)}\n`,
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'activate-successor-claims',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    for (const claim of activeSuccessorClaims) {
      await updateClaim(context.homeStore, claim, 1);
    }

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-task-head-fence',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await replaceTaskHeadFence(context.homeStore, taskHeadFence);
    const operation = await commitTaskOperation(context, journal);
    return {
      metadata,
      checkpoint,
      terminatedClaims,
      successorClaims: activeSuccessorClaims,
      aggregate,
      taskHeadFence,
      operation,
    };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A durable write intent leaves this task in the repair envelope.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

interface ScopeChangeContextInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  scope: WorkflowMetadataV3['implementationScope'];
  checkpointId: Ulid;
  successorClaimIds: Ulid[] | undefined;
  operationId: Ulid;
  now: Date;
}

interface OpenedScopeChangeContext {
  context: OpenedV3TaskOperation;
  activeClaims: ClaimV1[];
  successorPredecessors: ClaimV1[];
  successorClaimIds: Ulid[];
}

async function openScopeChangeContext(
  input: ScopeChangeContextInput,
): Promise<OpenedScopeChangeContext> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const runtime = await readProjectRuntimeContext(input.projectRoot);
    const store = new V3ContextStore(input.projectRoot);
    const homeStore = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      input.taskRef,
    );
    const preflight = await store.readCoordinationSnapshot(
      input.taskRef,
      homeStore,
    );
    const preflightClaims = activeClaims(preflight.claims);
    const preflightSuccessors = claimsWithinScope(preflightClaims, input.scope);
    const preflightSuccessorIds = resolveSuccessorClaimIds(
      preflightSuccessors,
      input.successorClaimIds,
      input.operationId,
      input.now.toISOString(),
    );
    const context = await openV3TaskOperation({
      projectRoot: input.projectRoot,
      taskRef: input.taskRef,
      sessionId: input.sessionId,
      expectedTaskRevision: input.expectedTaskRevision,
      operationId: input.operationId,
      extraEntityLocks: [
        `checkpoint:${input.checkpointId}`,
        taskHeadEntityKey(input.taskRef),
        ...preflightClaims.map((claim) => `claim:${claim.claimId}`),
        ...preflightSuccessorIds.map((claimId) => `claim:${claimId}`),
      ],
      now: input.now,
    });
    const lockedClaims = activeClaims(context.coordination.claims);
    if (sameClaimIdSet(preflightClaims, lockedClaims)) {
      const successors = claimsWithinScope(lockedClaims, input.scope);
      const successorIds = resolveSuccessorClaimIds(
        successors,
        input.successorClaimIds,
        input.operationId,
        input.now.toISOString(),
      );
      return {
        context,
        activeClaims: lockedClaims,
        successorPredecessors: successors,
        successorClaimIds: successorIds,
      };
    }
    await context.release();
  }
  throw new Error('MANCODE_CLAIM_SET_CHANGED');
}

function assertScopeChangeEligible(
  context: OpenedV3TaskOperation,
  scope: WorkflowMetadataV3['implementationScope'],
): void {
  const metadata = context.task.metadata;
  if (context.project.config.transport.mode !== 'local') {
    throw new Error('MANCODE_GIT_REF_TRANSPORT_NOT_IMPLEMENTED');
  }
  if (metadata.workflowMode !== 'manteam') {
    throw new Error('MANCODE_SCOPE_CHANGE_WORKFLOW_MODE_INVALID');
  }
  if (metadata.status !== 'in_progress') {
    throw new Error('MANCODE_SCOPE_CHANGE_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.ownerActorId !== context.session.actorId) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
  if (metadata.parent !== null) {
    throw new Error('MANCODE_PARENT_SCOPE_INHERITANCE_REQUIRED');
  }
  if (metadata.implementationScope.digest === scope.digest) {
    throw new Error('MANCODE_SCOPE_CHANGE_NOOP');
  }
}

function assertClaimsFreshForScopeChange(
  context: OpenedV3TaskOperation,
  claims: ClaimV1[],
): void {
  const codeHead = requireCodeHead(context);
  for (const claim of claims) {
    if (claim.authority.mode !== 'local') {
      throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
    }
    const validity = deriveClaimValidity(claim, {
      taskRef: context.taskRef,
      taskRevision: context.task.metadata.revision,
      implementationScopeDigest:
        context.task.metadata.implementationScope.digest,
      ownershipEpoch: context.task.metadata.ownershipEpoch,
      codeRefHead: codeHead,
      now: context.now,
      transportFreshness: 'fresh',
    });
    if (validity !== 'fresh') {
      throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
    }
  }
}

function normalizeImplementationScope(
  value: unknown,
): WorkflowMetadataV3['implementationScope'] {
  assertRecord(value, 'workflow scope change');
  assertKnownKeys(
    value,
    ['include', 'exclude', 'modules'],
    'workflow scope change',
  );
  const scope = {
    source: 'explicit' as const,
    include: normalizeScopeValues(value.include, 'include', true),
    exclude: normalizeScopeValues(value.exclude, 'exclude', true),
    modules: normalizeScopeValues(value.modules, 'modules', false),
  };
  return { ...scope, digest: digestCanonicalJson(scope) };
}

function normalizeScopeValues(
  value: unknown,
  label: string,
  paths: boolean,
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`MANCODE_SCOPE_${label.toUpperCase()}_INVALID`);
  }
  const values = value.map((item) => (item as string).trim());
  const normalized = sortUtf8StringSet(values);
  if (normalized.length !== values.length) {
    throw new Error(`MANCODE_SCOPE_${label.toUpperCase()}_DUPLICATE`);
  }
  for (const item of normalized) {
    assertSharedTextSafe(item, `workflow scope ${label}`);
    if (paths) assertScopePath(item);
  }
  return normalized;
}

function assertScopePath(value: string): void {
  if (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('MANCODE_SCOPE_PATH_INVALID');
  }
}

function markScopeChangeOperationPending(
  previous: WorkflowMetadataV3,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    transitionState: 'operation_pending',
    lastOperationId: operationId,
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function completeScopeChangeMetadata(
  previous: WorkflowMetadataV3,
  scope: WorkflowMetadataV3['implementationScope'],
  checkpoint: CheckpointV1,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    transitionState: 'stable',
    implementationScope: scope,
    latestCheckpointRef: {
      taskRef: checkpoint.taskRef,
      kind: 'checkpoint',
      artifactId: checkpoint.checkpointId,
    },
    lastOperationId: operationId,
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function buildScopeChangedCheckpoint(
  context: OpenedV3TaskOperation,
  pendingMetadata: WorkflowMetadataV3,
  checkpointId: Ulid,
  summary: string | undefined,
  nextAction: string | undefined,
  branch: string,
  timestamp: string,
): CheckpointV1 {
  return parseCheckpoint({
    schemaVersion: 1,
    checkpointId,
    operationId: context.operationId,
    taskRef: context.taskRef,
    taskRevision: pendingMetadata.revision,
    ownershipEpochAtOffer: pendingMetadata.ownershipEpoch,
    kind: 'scope_changed',
    git: {
      branch,
      head: requireCodeHead(context),
      base: pendingMetadata.base?.head ?? null,
    },
    summary:
      summary ??
      'Changed the implementation scope and replaced affected coordination claims.',
    governance: {
      requirementsDigest: context.task.requirements.contentDigest,
      planVersion: pendingMetadata.governance.planVersion,
      reviewLedgerDigest: context.task.review.contentDigest,
      verificationLedgerDigest: context.task.verification.contentDigest,
    },
    nextAction:
      nextAction ??
      'Re-read the updated scope and continue only with the successor claim.',
    createdBy: {
      actorId: context.session.actorId,
      client: context.session.client,
    },
    createdAt: timestamp,
  });
}

function buildPendingSuccessorClaims(
  predecessors: ClaimV1[],
  successorClaimIds: Ulid[],
  metadata: WorkflowMetadataV3,
  branch: string,
  codeHead: string,
  operationId: Ulid,
  timestamp: string,
  capabilities: ReturnType<typeof capabilitiesFromProjectConfig>,
): ClaimV1[] {
  return predecessors.map((previous, index) => {
    const claimId = successorClaimIds[index];
    if (claimId === undefined) {
      throw new Error('MANCODE_SCOPE_SUCCESSOR_CLAIM_COUNT_INVALID');
    }
    return parseClaim({
      ...previous,
      claimId,
      authority: { mode: 'local', remoteRevision: null },
      taskRevisionAtAcquire: metadata.revision,
      lastValidatedTaskRevision: metadata.revision,
      implementationScopeDigest: metadata.implementationScope.digest,
      ownershipEpochAtAcquire: metadata.ownershipEpoch,
      state: 'pending',
      revision: 1,
      codeRefAtAcquire: { branch, head: codeHead },
      lastValidatedCodeRef: { branch, head: codeHead },
      acquisitionEnforcement: capabilities.claimAcquisition,
      writeGuard: capabilities.writeGuard,
      predecessorClaimId: previous.claimId,
      successorClaimId: null,
      lastOperationId: operationId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
}

function terminateClaimForScopeChange(
  previous: ClaimV1,
  successorClaimId: Ulid | null,
  operationId: Ulid,
  timestamp: string,
): ClaimV1 {
  const next = parseClaim({
    ...previous,
    state: successorClaimId === null ? 'released' : 'transferred',
    revision: previous.revision + 1,
    successorClaimId,
    lastOperationId: operationId,
    updatedAt: timestamp,
  });
  assertClaimTransition(previous, next);
  return next;
}

function activateSuccessorClaim(
  previous: ClaimV1,
  operationId: Ulid,
  timestamp: string,
): ClaimV1 {
  const next = parseClaim({
    ...previous,
    state: 'active',
    revision: previous.revision + 1,
    lastOperationId: operationId,
    updatedAt: timestamp,
  });
  assertClaimTransition(previous, next);
  return next;
}

function scopeChangeExpectedRevisions(
  context: OpenedV3TaskOperation,
  checkpointId: Ulid,
  predecessors: ClaimV1[],
  successorClaimIds: Ulid[],
): Record<string, number> {
  const expected: Record<string, number> = {
    [taskEntityKey(context.taskRef)]: context.task.metadata.revision,
    [`checkpoint:${checkpointId}`]: 0,
  };
  for (const claim of predecessors) {
    expected[`claim:${claim.claimId}`] = claim.revision;
  }
  for (const claimId of successorClaimIds) {
    expected[`claim:${claimId}`] = 0;
  }
  const fence = context.coordination.taskHeadFence;
  if (fence === null) throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
  expected[taskHeadEntityKey(context.taskRef)] = fence.fenceRevision;
  return expected;
}

function activeClaims(claims: readonly ClaimV1[]): ClaimV1[] {
  return claims
    .filter((claim) => claim.state === 'active')
    .sort((left, right) => compareUtf8(left.claimId, right.claimId));
}

function claimsWithinScope(
  claims: ClaimV1[],
  scope: WorkflowMetadataV3['implementationScope'],
): ClaimV1[] {
  return claims.filter(
    (claim) =>
      evaluateClaimScopeSubset(claim.scope, {
        source: scope.source,
        include: scope.include,
        exclude: scope.exclude,
        modules: scope.modules,
      }).allowed,
  );
}

function resolveSuccessorClaimIds(
  predecessors: ClaimV1[],
  requested: Ulid[] | undefined,
  operationId: Ulid,
  timestamp: string,
): Ulid[] {
  const ids =
    requested ??
    predecessors.map((claim) =>
      scopeSuccessorClaimId(operationId, claim.claimId, timestamp),
    );
  if (ids.length !== predecessors.length) {
    throw new Error('MANCODE_SCOPE_SUCCESSOR_CLAIM_COUNT_INVALID');
  }
  const predecessorIds = new Set(predecessors.map((claim) => claim.claimId));
  const seen = new Set<Ulid>();
  for (const claimId of ids) {
    assertUlid(claimId, 'scope successor claimId');
    if (predecessorIds.has(claimId) || seen.has(claimId)) {
      throw new Error('MANCODE_SCOPE_SUCCESSOR_CLAIM_INVALID');
    }
    seen.add(claimId);
  }
  return ids;
}

/** Stable successor identity lets forward repair reconstruct the same claim. */
export function scopeSuccessorClaimId(
  operationId: Ulid,
  predecessorClaimId: Ulid,
  timestamp: string,
): Ulid {
  assertUlid(operationId, 'scope change operationId');
  assertUlid(predecessorClaimId, 'scope predecessor claimId');
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds)) {
    throw new Error('MANCODE_SCOPE_TIMESTAMP_INVALID');
  }
  const entropy = createHash('sha256')
    .update(`scope-change:${operationId}:${predecessorClaimId}`, 'utf8')
    .digest()
    .subarray(0, 10);
  return createUlid(milliseconds, entropy);
}

function requireCodeHead(context: OpenedV3TaskOperation): string {
  if (context.codeHead === null) {
    throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
  }
  return context.codeHead;
}

function sameClaimIdSet(left: ClaimV1[], right: ClaimV1[]): boolean {
  return (
    left.length === right.length &&
    left.every((claim, index) => claim.claimId === right[index]?.claimId)
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

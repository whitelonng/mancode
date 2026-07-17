import { createHash } from 'node:crypto';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
} from '../context/aggregate.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { V3ContextStore } from '../context/store.js';
import {
  assertTaskCodeHeadUnchanged,
  nextTaskHeadFence,
} from '../context/task-mutation.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from '../context/workflow-metadata.js';
import { createClaim, readClaim, updateClaim } from '../runtime/claim-store.js';
import { resolveCoordinationEntityHomeStore } from '../runtime/entity-home-store.js';
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
import { readSharedActorProfile } from './actor.js';
import { type CheckpointV1, parseCheckpoint } from './checkpoints.js';
import { parseClaimTtl } from './claim-acquisition.js';
import { type ClaimV1, assertClaimTransition, parseClaim } from './claims.js';
import { type ClaimValidity, deriveClaimValidity } from './conflicts.js';
import { capabilitiesFromProjectConfig } from './transport.js';

interface ExistingClaimOperationInput {
  projectRoot: string;
  claimId: Ulid;
  sessionId: Ulid;
  expectedClaimRevision: number;
  operationId?: Ulid;
  now?: Date;
}

export interface RenewV3ClaimInput extends ExistingClaimOperationInput {
  ttlMs?: number;
}

export interface ReleaseV3ClaimInput extends ExistingClaimOperationInput {}

export interface TransferV3ClaimInput extends ExistingClaimOperationInput {
  toActorId: Ulid;
  successorClaimId?: Ulid;
}

export interface ReclaimV3ClaimInput extends ExistingClaimOperationInput {
  reason: string;
}

export interface RevalidateV3ClaimInput extends ExistingClaimOperationInput {
  checkpointId?: Ulid;
  checkpointSummary?: string;
  checkpointNextAction?: string;
}

export interface UpdatedV3Claim {
  claim: ClaimV1;
  operation: OperationJournalV1;
}

export interface TransferredV3Claim {
  predecessorClaim: ClaimV1;
  successorClaim: ClaimV1;
  operation: OperationJournalV1;
}

export interface RevalidatedV3Claim {
  metadata: WorkflowMetadataV3;
  claim: ClaimV1;
  checkpoint: CheckpointV1 | null;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1;
  operation: OperationJournalV1;
}

/** Extends an active local claim only after its full snapshot is fresh. */
export async function renewV3Claim(
  input: RenewV3ClaimInput,
): Promise<UpdatedV3Claim> {
  const ttlMs = parseClaimTtl(input.ttlMs);
  return mutateOwnedClaim(input, 'renew', (context, claim, timestamp) => {
    assertClaimFreshForRenewOrTransfer(context, claim);
    const next = parseClaim({
      ...claim,
      revision: claim.revision + 1,
      expiresAt: new Date(context.now.getTime() + ttlMs).toISOString(),
      lastOperationId: context.operationId,
      updatedAt: timestamp,
    });
    assertClaimTransition(claim, next);
    return next;
  });
}

/** Releases an active claim; stale claims may always be safely relinquished. */
export async function releaseV3Claim(
  input: ReleaseV3ClaimInput,
): Promise<UpdatedV3Claim> {
  return mutateOwnedClaim(input, 'release', (_context, claim, timestamp) => {
    assertActiveClaim(claim);
    const next = parseClaim({
      ...claim,
      state: 'released',
      revision: claim.revision + 1,
      lastOperationId: _context.operationId,
      updatedAt: timestamp,
    });
    assertClaimTransition(claim, next);
    return next;
  });
}

/**
 * Transfers an active claim by creating a new pending successor first. The
 * original claim's owner and immutable acquisition snapshot are never edited.
 */
export async function transferV3Claim(
  input: TransferV3ClaimInput,
): Promise<TransferredV3Claim> {
  assertUlid(input.toActorId, 'claim transfer target actorId');
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'claim transfer operationId');
  const opened = await openExistingClaimContext({
    projectRoot: input.projectRoot,
    claimId: input.claimId,
    sessionId: input.sessionId,
    expectedClaimRevision: input.expectedClaimRevision,
    operationId,
    now,
    extraEntityLocks: [],
  });
  const { context, claim } = opened;
  const timestamp = context.now.toISOString();
  const successorClaimId =
    input.successorClaimId ??
    claimTransferSuccessorId(operationId, claim.claimId, timestamp);
  assertUlid(successorClaimId, 'claim transfer successorClaimId');
  if (successorClaimId === claim.claimId) {
    await context.release();
    throw new Error('MANCODE_CLAIM_TRANSFER_SUCCESSOR_INVALID');
  }

  // Reopen with the successor lock as well. The first locked snapshot proves
  // the task ref; this second open keeps the create-CAS and predecessor CAS in
  // one canonical lock family.
  await context.release();
  const reopened = await openExistingClaimContext({
    projectRoot: input.projectRoot,
    claimId: input.claimId,
    sessionId: input.sessionId,
    expectedClaimRevision: input.expectedClaimRevision,
    operationId,
    now,
    extraEntityLocks: [`claim:${successorClaimId}`],
  });
  const lockedContext = reopened.context;
  const lockedClaim = reopened.claim;
  let journal: OperationJournalV1 | null = null;
  try {
    assertLocalClaimTransport(lockedContext);
    assertOwnedClaim(lockedContext, lockedClaim);
    assertClaimFreshForRenewOrTransfer(lockedContext, lockedClaim);
    await assertTransferRecipient(lockedContext, input.toActorId);
    if (
      lockedContext.coordination.claims.some(
        (candidate) => candidate.claimId === successorClaimId,
      )
    ) {
      throw new Error('MANCODE_CLAIM_TRANSFER_SUCCESSOR_CONFLICT');
    }
    const branch =
      (await readCheckoutBranch(lockedContext.projectRoot)) ?? 'HEAD';
    const pendingSuccessor = buildPendingTransferSuccessor(
      lockedContext,
      lockedClaim,
      successorClaimId,
      input.toActorId,
      branch,
      timestamp,
    );
    const transferred = transferPredecessorClaim(
      lockedClaim,
      successorClaimId,
      lockedContext.operationId,
      timestamp,
    );
    const activeSuccessor = activateSuccessorClaim(
      pendingSuccessor,
      lockedContext.operationId,
      timestamp,
    );
    journal = await createTaskOperationJournal(lockedContext, {
      type: 'claim_transfer',
      action: 'claim_renew_release_transfer',
      expectedRevisions: {
        [taskEntityKey(lockedContext.taskRef)]:
          lockedContext.task.metadata.revision,
        [`claim:${lockedClaim.claimId}`]: lockedClaim.revision,
        [`claim:${successorClaimId}`]: 0,
      },
      claim: {
        ownerActorId: lockedClaim.ownerActorId,
        transferTargetActorId: input.toActorId,
      },
      recovery: {
        actions: [
          createClaimRecoveryAction({
            stepId: 'create-pending-successor-claim',
            before: null,
            claim: pendingSuccessor,
          }),
          createClaimRecoveryAction({
            stepId: 'transfer-predecessor-claim',
            before: lockedClaim,
            claim: transferred,
          }),
          createClaimRecoveryAction({
            stepId: 'activate-successor-claim',
            before: pendingSuccessor,
            claim: activeSuccessor,
          }),
        ],
      },
    });
    journal = await advanceTaskOperation(
      lockedContext,
      journal,
      'validate',
      true,
    );

    journal = await advanceTaskOperation(
      lockedContext,
      journal,
      'create-pending-successor-claim',
      false,
    );
    await assertTaskCodeHeadUnchanged(
      lockedContext.projectRoot,
      lockedContext.codeHead,
    );
    await createClaim(lockedContext.homeStore, pendingSuccessor);

    journal = await advanceTaskOperation(
      lockedContext,
      journal,
      'transfer-predecessor-claim',
      false,
    );
    await assertTaskCodeHeadUnchanged(
      lockedContext.projectRoot,
      lockedContext.codeHead,
    );
    await updateClaim(
      lockedContext.homeStore,
      transferred,
      lockedClaim.revision,
    );

    journal = await advanceTaskOperation(
      lockedContext,
      journal,
      'activate-successor-claim',
      false,
    );
    await assertTaskCodeHeadUnchanged(
      lockedContext.projectRoot,
      lockedContext.codeHead,
    );
    await updateClaim(lockedContext.homeStore, activeSuccessor, 1);
    const operation = await commitTaskOperation(lockedContext, journal);
    return {
      predecessorClaim: transferred,
      successorClaim: activeSuccessor,
      operation,
    };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(lockedContext, journal);
      } catch {
        // A transfer write intent is repair-only until it is reconciled.
      }
    }
    throw error;
  } finally {
    await lockedContext.release();
  }
}

/** Marks an expired local claim terminal; it never resurrects that identity. */
export async function reclaimV3Claim(
  input: ReclaimV3ClaimInput,
): Promise<UpdatedV3Claim> {
  if (!input.reason.trim()) {
    throw new Error('MANCODE_RECLAIM_REASON_REQUIRED');
  }
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'claim reclaim operationId');
  const { context, claim } = await openExistingClaimContext({
    projectRoot: input.projectRoot,
    claimId: input.claimId,
    sessionId: input.sessionId,
    expectedClaimRevision: input.expectedClaimRevision,
    operationId,
    now,
    extraEntityLocks: [],
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertLocalClaimTransport(context);
    assertActiveClaim(claim);
    if (context.task.metadata.ownerActorId !== context.session.actorId) {
      throw new Error('MANCODE_TASK_OWNER_REQUIRED');
    }
    if (Date.parse(claim.expiresAt) > context.now.getTime()) {
      throw new Error('MANCODE_CLAIM_RECLAIM_NOT_ELIGIBLE');
    }
    const timestamp = context.now.toISOString();
    const expired = parseClaim({
      ...claim,
      state: 'expired',
      revision: claim.revision + 1,
      lastOperationId: context.operationId,
      updatedAt: timestamp,
    });
    assertClaimTransition(claim, expired);
    journal = await createTaskOperationJournal(context, {
      type: 'claim_reclaim',
      action: 'claim_reclaim',
      expectedRevisions: {
        [taskEntityKey(context.taskRef)]: context.task.metadata.revision,
        [`claim:${claim.claimId}`]: claim.revision,
      },
      claim: { ownerActorId: claim.ownerActorId, transferTargetActorId: null },
      conditions: { coordinationStoreFresh: true, reason: input.reason },
      recovery: {
        actions: [
          createClaimRecoveryAction({
            stepId: 'expire-claim',
            before: claim,
            claim: expired,
          }),
        ],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);
    journal = await advanceTaskOperation(
      context,
      journal,
      'expire-claim',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await updateClaim(context.homeStore, expired, claim.revision);
    const operation = await commitTaskOperation(context, journal);
    return { claim: expired, operation };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // The claim state is only recoverable forward after write intent.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

/**
 * Refreshes a claim's derived validity after a task revision or code-head
 * change. Scope and ownership epoch drift are deliberately non-repairable:
 * callers must use scope re-claim or handoff instead.
 */
export async function revalidateV3Claim(
  input: RevalidateV3ClaimInput,
): Promise<RevalidatedV3Claim> {
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const checkpointId = input.checkpointId ?? createUlid(now.getTime());
  assertUlid(operationId, 'claim revalidation operationId');
  assertUlid(checkpointId, 'claim revalidation checkpointId');
  const { context, claim } = await openExistingClaimContext({
    projectRoot: input.projectRoot,
    claimId: input.claimId,
    sessionId: input.sessionId,
    expectedClaimRevision: input.expectedClaimRevision,
    operationId,
    now,
    extraEntityLocks: [`checkpoint:${checkpointId}`],
    includeTaskHeadFence: true,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertLocalClaimTransport(context);
    assertOwnedClaim(context, claim);
    const validity = claimValidity(context, claim);
    assertRevalidatable(validity);
    const timestamp = context.now.toISOString();
    const baseChanged = validity === 'code_ref_stale';
    const pendingMetadata = markClaimValidationPending(
      context.task.metadata,
      context.operationId,
      timestamp,
    );
    const branch = (await readCheckoutBranch(context.projectRoot)) ?? 'HEAD';
    const checkpoint = baseChanged
      ? buildBaseChangedCheckpoint(
          context,
          pendingMetadata,
          checkpointId,
          input.checkpointSummary,
          input.checkpointNextAction,
          branch,
          timestamp,
        )
      : null;
    const metadata = completeClaimValidationMetadata(
      pendingMetadata,
      checkpoint,
      context.operationId,
      timestamp,
    );
    const validatedClaim = parseClaim({
      ...claim,
      revision: claim.revision + 1,
      lastValidatedTaskRevision: metadata.revision,
      lastValidatedCodeRef: { branch, head: requireCodeHead(context) },
      lastOperationId: context.operationId,
      updatedAt: timestamp,
    });
    assertClaimTransition(claim, validatedClaim);
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: context.task.requirements,
      review: context.task.review,
      verification: context.task.verification,
      planDigest: context.task.plan?.digest ?? null,
      latestCheckpoint: checkpoint ?? context.task.latestCheckpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);
    if (taskHeadFence === null) {
      throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
    }
    journal = await createTaskOperationJournal(context, {
      type: 'claim_revalidation',
      action: 'claim_renew_release_transfer',
      expectedRevisions: revalidationExpectedRevisions(
        context,
        claim,
        checkpoint,
      ),
      claim: { ownerActorId: claim.ownerActorId, transferTargetActorId: null },
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-task-operation-pending',
            taskRef: context.taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
            targetContent: serializeTaskAuthority(pendingMetadata),
          }),
          ...(checkpoint === null
            ? []
            : [
                createCheckpointRecoveryAction({
                  stepId: 'write-base-changed-checkpoint',
                  before: null,
                  checkpoint,
                }),
              ]),
          createClaimRecoveryAction({
            stepId: 'update-claim-validation',
            before: claim,
            claim: validatedClaim,
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'complete-task-validation',
            taskRef: context.taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(pendingMetadata),
            targetContent: serializeTaskAuthority(metadata),
          }),
          createTaskHeadFenceRecoveryAction({
            stepId: 'update-task-head-fence',
            before: context.coordination.taskHeadFence,
            fence: taskHeadFence,
          }),
        ],
        noOpStepIds:
          checkpoint === null ? ['write-base-changed-checkpoint'] : [],
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
      'write-base-changed-checkpoint',
      false,
    );
    if (checkpoint !== null) {
      await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
      await writeTaskCheckpoint(context, checkpoint);
    }

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-claim-validation',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await updateClaim(context.homeStore, validatedClaim, claim.revision);

    journal = await advanceTaskOperation(
      context,
      journal,
      'complete-task-validation',
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
      'update-task-head-fence',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await replaceTaskHeadFence(context.homeStore, taskHeadFence);
    const operation = await commitTaskOperation(context, journal);
    return {
      metadata,
      claim: validatedClaim,
      checkpoint,
      aggregate,
      taskHeadFence,
      operation,
    };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // Metadata pending plus the journal remain the recovery boundary.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

async function mutateOwnedClaim(
  input: ExistingClaimOperationInput,
  intent: 'renew' | 'release',
  buildNext: (
    context: OpenedV3TaskOperation,
    claim: ClaimV1,
    timestamp: string,
  ) => ClaimV1,
): Promise<UpdatedV3Claim> {
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, `claim ${intent} operationId`);
  const { context, claim } = await openExistingClaimContext({
    projectRoot: input.projectRoot,
    claimId: input.claimId,
    sessionId: input.sessionId,
    expectedClaimRevision: input.expectedClaimRevision,
    operationId,
    now,
    extraEntityLocks: [],
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertLocalClaimTransport(context);
    assertOwnedClaim(context, claim);
    const timestamp = context.now.toISOString();
    const next = buildNext(context, claim, timestamp);
    journal = await createTaskOperationJournal(context, {
      type: 'claim_renew_release',
      action: 'claim_renew_release_transfer',
      expectedRevisions: {
        [taskEntityKey(context.taskRef)]: context.task.metadata.revision,
        [`claim:${claim.claimId}`]: claim.revision,
      },
      claim: { ownerActorId: claim.ownerActorId, transferTargetActorId: null },
      recovery: {
        actions: [
          createClaimRecoveryAction({
            stepId: 'update-claim',
            before: claim,
            claim: next,
          }),
        ],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);
    journal = await advanceTaskOperation(
      context,
      journal,
      'update-claim',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await updateClaim(context.homeStore, next, claim.revision);
    const operation = await commitTaskOperation(context, journal);
    return { claim: next, operation };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A durable claim mutation remains repair-only after its write intent.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

interface OpenExistingClaimContextInput {
  projectRoot: string;
  claimId: Ulid;
  sessionId: Ulid;
  expectedClaimRevision: number;
  operationId: Ulid;
  now: Date;
  extraEntityLocks: string[];
  includeTaskHeadFence?: boolean;
}

async function openExistingClaimContext(
  input: OpenExistingClaimContextInput,
): Promise<{ context: OpenedV3TaskOperation; claim: ClaimV1 }> {
  assertUlid(input.claimId, 'claimId');
  assertPositiveRevision(input.expectedClaimRevision, 'claim revision');
  const runtime = await readProjectRuntimeContext(input.projectRoot);
  const coordinationStore = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const preflight = await readClaim(coordinationStore, input.claimId);
  if (preflight === null) throw new Error('MANCODE_CLAIM_NOT_FOUND');
  if (preflight.revision !== input.expectedClaimRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  const store = new V3ContextStore(input.projectRoot);
  const snapshot = await store.readTaskSnapshot(preflight.taskRef);
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef: preflight.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: snapshot.metadata.revision,
    operationId: input.operationId,
    extraEntityLocks: [
      `claim:${input.claimId}`,
      ...input.extraEntityLocks,
      ...(input.includeTaskHeadFence === true
        ? [taskHeadEntityKey(preflight.taskRef)]
        : []),
    ],
    now: input.now,
  });
  const claim = context.coordination.claims.find(
    (candidate) => candidate.claimId === input.claimId,
  );
  if (claim === undefined) {
    await context.release();
    throw new Error('MANCODE_CLAIM_NOT_FOUND');
  }
  if (claim.revision !== input.expectedClaimRevision) {
    await context.release();
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  return { context, claim };
}

function assertLocalClaimTransport(context: OpenedV3TaskOperation): void {
  if (
    context.taskRef.namespace !== 'shared' ||
    context.project.config.transport.mode !== 'local'
  ) {
    throw new Error('MANCODE_GIT_REF_TRANSPORT_NOT_IMPLEMENTED');
  }
}

function assertOwnedClaim(
  context: OpenedV3TaskOperation,
  claim: ClaimV1,
): void {
  assertActiveClaim(claim);
  if (claim.ownerActorId !== context.session.actorId) {
    throw new Error('MANCODE_CLAIM_OWNER_REQUIRED');
  }
}

function assertActiveClaim(claim: ClaimV1): void {
  if (claim.state !== 'active') {
    throw new Error('MANCODE_CLAIM_NOT_ACTIVE');
  }
}

function assertClaimFreshForRenewOrTransfer(
  context: OpenedV3TaskOperation,
  claim: ClaimV1,
): void {
  const validity = claimValidity(context, claim);
  if (validity === 'fresh') return;
  if (validity === 'expired') throw new Error('MANCODE_CLAIM_EXPIRED');
  throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
}

function claimValidity(
  context: OpenedV3TaskOperation,
  claim: ClaimV1,
): ClaimValidity {
  return deriveClaimValidity(claim, {
    taskRef: context.taskRef,
    taskRevision: context.task.metadata.revision,
    implementationScopeDigest: context.task.metadata.implementationScope.digest,
    ownershipEpoch: context.task.metadata.ownershipEpoch,
    codeRefHead: requireCodeHead(context),
    now: context.now,
    transportFreshness: 'fresh',
  });
}

function assertRevalidatable(validity: ClaimValidity): void {
  if (validity === 'needs_revalidation' || validity === 'code_ref_stale') {
    return;
  }
  if (validity === 'expired') throw new Error('MANCODE_CLAIM_EXPIRED');
  if (validity === 'fresh') {
    throw new Error('MANCODE_CLAIM_REVALIDATION_NOT_REQUIRED');
  }
  throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
}

async function assertTransferRecipient(
  context: OpenedV3TaskOperation,
  toActorId: Ulid,
): Promise<void> {
  if (toActorId === context.session.actorId) {
    throw new Error('MANCODE_CLAIM_TRANSFER_TARGET_INVALID');
  }
  if (!context.task.metadata.participants.includes(toActorId)) {
    throw new Error('MANCODE_PARTICIPANT_REQUIRED');
  }
  if ((await readSharedActorProfile(context.projectRoot, toActorId)) === null) {
    throw new Error('MANCODE_PARTICIPANT_JOIN_REQUIRED');
  }
}

function buildPendingTransferSuccessor(
  context: OpenedV3TaskOperation,
  predecessor: ClaimV1,
  successorClaimId: Ulid,
  toActorId: Ulid,
  branch: string,
  timestamp: string,
): ClaimV1 {
  const capabilities = capabilitiesFromProjectConfig(context.project.config);
  const codeHead = requireCodeHead(context);
  return parseClaim({
    ...predecessor,
    claimId: successorClaimId,
    authority: { mode: 'local', remoteRevision: null },
    taskRevisionAtAcquire: context.task.metadata.revision,
    lastValidatedTaskRevision: context.task.metadata.revision,
    implementationScopeDigest: context.task.metadata.implementationScope.digest,
    ownershipEpochAtAcquire: context.task.metadata.ownershipEpoch,
    ownerActorId: toActorId,
    state: 'pending',
    revision: 1,
    codeRefAtAcquire: { branch, head: codeHead },
    lastValidatedCodeRef: { branch, head: codeHead },
    acquisitionEnforcement: capabilities.claimAcquisition,
    writeGuard: capabilities.writeGuard,
    predecessorClaimId: predecessor.claimId,
    successorClaimId: null,
    lastOperationId: context.operationId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function transferPredecessorClaim(
  previous: ClaimV1,
  successorClaimId: Ulid,
  operationId: Ulid,
  timestamp: string,
): ClaimV1 {
  const next = parseClaim({
    ...previous,
    state: 'transferred',
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

function markClaimValidationPending(
  previous: WorkflowMetadataV3,
  operationId: Ulid,
  timestamp: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    transitionState: 'operation_pending',
    lastOperationId: operationId,
    updatedAt: timestamp,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function completeClaimValidationMetadata(
  previous: WorkflowMetadataV3,
  checkpoint: CheckpointV1 | null,
  operationId: Ulid,
  timestamp: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    transitionState: 'stable',
    latestCheckpointRef:
      checkpoint === null
        ? previous.latestCheckpointRef
        : {
            taskRef: checkpoint.taskRef,
            kind: 'checkpoint',
            artifactId: checkpoint.checkpointId,
          },
    lastOperationId: operationId,
    updatedAt: timestamp,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function buildBaseChangedCheckpoint(
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
    kind: 'base_changed',
    git: {
      branch,
      head: requireCodeHead(context),
      base: pendingMetadata.base?.head ?? null,
    },
    summary:
      summary ?? 'Refreshed the claim after the checked-out code head changed.',
    governance: {
      requirementsDigest: context.task.requirements.contentDigest,
      planVersion: pendingMetadata.governance.planVersion,
      reviewLedgerDigest: context.task.review.contentDigest,
      verificationLedgerDigest: context.task.verification.contentDigest,
    },
    nextAction:
      nextAction ??
      'Continue only after the refreshed claim snapshot is visible as stable.',
    createdBy: {
      actorId: context.session.actorId,
      client: context.session.client,
    },
    createdAt: timestamp,
  });
}

function revalidationExpectedRevisions(
  context: OpenedV3TaskOperation,
  claim: ClaimV1,
  checkpoint: CheckpointV1 | null,
): Record<string, number> {
  const expected: Record<string, number> = {
    [taskEntityKey(context.taskRef)]: context.task.metadata.revision,
    [`claim:${claim.claimId}`]: claim.revision,
  };
  if (checkpoint !== null) {
    expected[`checkpoint:${checkpoint.checkpointId}`] = 0;
  }
  const fence = context.coordination.taskHeadFence;
  if (fence === null) throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
  expected[taskHeadEntityKey(context.taskRef)] = fence.fenceRevision;
  return expected;
}

/** Stable IDs are essential when a transfer is resumed after a crash. */
export function claimTransferSuccessorId(
  operationId: Ulid,
  predecessorClaimId: Ulid,
  timestamp: string,
): Ulid {
  assertUlid(operationId, 'claim transfer operationId');
  assertUlid(predecessorClaimId, 'claim transfer predecessorClaimId');
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds)) {
    throw new Error('MANCODE_CLAIM_TRANSFER_TIMESTAMP_INVALID');
  }
  const entropy = createHash('sha256')
    .update(`claim-transfer:${operationId}:${predecessorClaimId}`, 'utf8')
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

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `MANCODE_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`,
    );
  }
}

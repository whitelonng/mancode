import {
  type TaskAggregateManifestV1,
  assertTaskCompletionGate,
  buildTaskAggregateManifest,
  taskAggregateDigest,
} from '../context/aggregate.js';
import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { assertManteamPlanContent } from '../context/manteam-plan.js';
import {
  normalizeImplementationScope,
  scopeSuccessorClaimId,
} from '../context/scope-change.js';
import { assertTaskCodeHeadUnchanged } from '../context/task-mutation.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from '../context/workflow-metadata.js';
import {
  type V3WorkflowUpdateStatus,
  buildV3WorkflowUpdateMetadata,
} from '../context/workflow-update.js';
import { recordV3ErrorDiagnostic } from '../runtime/diagnostics.js';
import {
  type OpenedV3TaskOperation,
  openV3TaskOperation,
} from '../runtime/task-operation.js';
import { readSharedActorProfile } from './actor.js';
import { createAuthorizationBasis } from './authorization.js';
import { type CheckpointV1, parseCheckpoint } from './checkpoints.js';
import { type ClaimV1, assertClaimTransition, parseClaim } from './claims.js';
import { deriveClaimValidity, evaluateClaimScopeSubset } from './conflicts.js';
import {
  assertGitRefBundleCodeReachable,
  createGitRefTaskBundle,
} from './git-ref-bundle.js';
import { createGitRefTeamManifestStore } from './git-ref-client.js';
import type { MaterializedGitRefTaskBundleResult } from './git-ref-materialization.js';
import type {
  GitRefOwnershipFenceV1,
  GitRefTaskBundleV1,
  GitRefTeamManifestSnapshot,
  GitRefTeamManifestStore,
} from './git-ref-transport.js';
import {
  type GitRefWorkflowRepairKind,
  prepareGitRefWorkflowRepair,
  recoverGitRefWorkflowRepair,
} from './git-ref-workflow-repair.js';
import { capabilitiesFromProjectConfig } from './transport.js';

export interface ChangeGitRefWorkflowScopeInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  scope: unknown;
  checkpointSummary?: string;
  checkpointNextAction?: string;
  checkpointId?: Ulid;
  successorClaimIds?: Ulid[];
  operationId?: Ulid;
  now?: Date;
}

export interface ChangedGitRefWorkflowScope {
  metadata: WorkflowMetadataV3;
  checkpoint: CheckpointV1;
  terminatedClaims: ClaimV1[];
  successorClaims: ClaimV1[];
  aggregate: TaskAggregateManifestV1;
  taskBundle: GitRefTaskBundleV1;
  remoteRevision: number;
  ownershipEpoch: number;
  receipt: string;
  materialization: MaterializedGitRefTaskBundleResult;
}

export interface CompleteGitRefTaskInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  outcome?: WorkflowMetadataV3['outcome'];
  operationId?: Ulid;
  now?: Date;
}

export interface UpdateGitRefWorkflowInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  status?: V3WorkflowUpdateStatus | 'completed' | 'superseded';
  blockingReason?: string | null;
  operationId?: Ulid;
  now?: Date;
}

export interface CompletedGitRefTask {
  metadata: WorkflowMetadataV3;
  releasedClaims: ClaimV1[];
  aggregate: TaskAggregateManifestV1;
  taskBundle: GitRefTaskBundleV1;
  remoteRevision: number;
  ownershipEpoch: number;
  receipt: string;
  materialization: MaterializedGitRefTaskBundleResult;
}

export interface UpdatedGitRefWorkflow {
  metadata: WorkflowMetadataV3;
  aggregate: TaskAggregateManifestV1;
  taskBundle: GitRefTaskBundleV1;
  remoteRevision: number;
  ownershipEpoch: number;
  receipt: string;
  materialization: MaterializedGitRefTaskBundleResult;
}

/**
 * Replaces scope and reissues affected claims in one remote coordination CAS.
 * The remote bundle is authoritative; local task files are materialized only
 * after that CAS has committed.
 */
export async function changeGitRefWorkflowScope(
  input: ChangeGitRefWorkflowScopeInput,
): Promise<ChangedGitRefWorkflowScope> {
  const taskRef = requireSharedTask(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const checkpointId = input.checkpointId ?? createUlid(now.getTime());
  assertUlid(operationId, 'git-ref scope change operationId');
  assertUlid(checkpointId, 'git-ref scope change checkpointId');
  const scope = normalizeImplementationScope(input.scope);
  const opened = await openGitRefWorkflowOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    now,
  });
  try {
    assertScopeChangeEligible(opened.context, opened.fence, scope);
    assertNoPendingHandoff(opened.manifest, taskRef);
    const activeClaims = activeRemoteClaims(opened.manifest, taskRef);
    assertClaimsFresh(opened.context, opened.bundle, activeClaims);
    const timestamp = now.toISOString();
    const successorPredecessors = activeClaims.filter(
      (claim) => evaluateClaimScopeSubset(claim.scope, scope).allowed,
    );
    const successorClaimIds = resolveSuccessorClaimIds(
      successorPredecessors,
      input.successorClaimIds,
      operationId,
      timestamp,
      opened.manifest.claims,
    );
    const pendingMetadata = markGitRefWorkflowOperationPending(
      opened.context.task.metadata,
      operationId,
      timestamp,
    );
    const metadata = scopeChangedMetadata(
      pendingMetadata,
      scope,
      checkpointId,
      operationId,
      timestamp,
    );
    const checkpoint = scopeChangedCheckpoint({
      context: opened.context,
      metadata: pendingMetadata,
      checkpointId,
      summary: input.checkpointSummary,
      nextAction: input.checkpointNextAction,
      codeRef: opened.bundle.codeRef,
      timestamp,
    });
    const finalMetadata = parseWorkflowMetadata({
      ...metadata,
      latestCheckpointRef: {
        taskRef,
        kind: 'checkpoint',
        artifactId: checkpoint.checkpointId,
      },
    });
    const aggregate = buildTaskAggregateManifest({
      metadata: finalMetadata,
      requirements: opened.context.task.requirements,
      review: opened.context.task.review,
      verification: opened.context.task.verification,
      planDigest: opened.context.task.plan?.digest ?? null,
      latestCheckpoint: checkpoint,
    });
    const nextRemoteRevision = opened.manifest.revision + 1;
    const claims = scopeChangedClaims({
      claims: opened.manifest.claims.filter((claim) =>
        sameTaskRef(claim.taskRef, taskRef),
      ),
      taskRef,
      activeClaims,
      successorPredecessors,
      successorClaimIds,
      metadata: finalMetadata,
      codeRef: opened.bundle.codeRef,
      operationId,
      remoteRevision: nextRemoteRevision,
      timestamp,
    });
    const taskBundle = createGitRefTaskBundle({
      task: {
        ...opened.context.task,
        metadata: finalMetadata,
        latestCheckpoint: checkpoint,
        aggregate,
      },
      codeRef: opened.bundle.codeRef,
      now,
    });
    const result = await publishTaskMutation({
      ...opened,
      kind: 'scope_change',
      pendingMetadata,
      taskBundle,
      claims,
      operationId,
      now,
    });
    return {
      metadata: finalMetadata,
      checkpoint,
      terminatedClaims: claims.filter(
        (claim) =>
          activeClaims.some((previous) => previous.claimId === claim.claimId) &&
          claim.state !== 'active',
      ),
      successorClaims: claims.filter((claim) =>
        successorClaimIds.includes(claim.claimId),
      ),
      aggregate,
      taskBundle,
      ...result,
    };
  } finally {
    await opened.context.release();
  }
}

/** Completes and releases remote claims through the same remote CAS. */
export async function completeGitRefTask(
  input: CompleteGitRefTaskInput,
): Promise<CompletedGitRefTask> {
  const taskRef = requireSharedTask(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'git-ref completion operationId');
  const opened = await openGitRefWorkflowOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    now,
  });
  try {
    assertNoPendingHandoff(opened.manifest, taskRef);
    assertCompletionOutcome(opened.context.task.metadata, input.outcome);
    const activeClaims = activeRemoteClaims(opened.manifest, taskRef);
    const activeChildren =
      await opened.context.store.listActiveChildTaskRefs(taskRef);
    assertTaskCompletionGate(
      {
        metadata: opened.context.task.metadata,
        requirements: opened.context.task.requirements,
        review: opened.context.task.review,
        verification: opened.context.task.verification,
        planDigest: opened.context.task.plan?.digest ?? null,
        latestCheckpoint: opened.context.task.latestCheckpoint,
      },
      {
        activeChildTaskRefs: activeChildren,
        hasPendingRepairOperation: false,
        activeClaimCount: activeClaims.length,
        claimsWillReleaseOrTransfer: activeClaims.length > 0,
      },
    );
    const timestamp = now.toISOString();
    const pendingMetadata = markGitRefWorkflowOperationPending(
      opened.context.task.metadata,
      operationId,
      timestamp,
    );
    const metadata = completedMetadata(
      pendingMetadata,
      input.outcome,
      operationId,
      timestamp,
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: opened.context.task.requirements,
      review: opened.context.task.review,
      verification: opened.context.task.verification,
      planDigest: opened.context.task.plan?.digest ?? null,
      latestCheckpoint: opened.context.task.latestCheckpoint,
    });
    const nextRemoteRevision = opened.manifest.revision + 1;
    const releasedClaims = activeClaims.map((claim) =>
      releaseRemoteClaim(claim, operationId, nextRemoteRevision, timestamp),
    );
    const claims = opened.manifest.claims
      .filter((claim) => sameTaskRef(claim.taskRef, taskRef))
      .map((claim) => {
        const released = releasedClaims.find(
          (candidate) => candidate.claimId === claim.claimId,
        );
        return released ?? claim;
      });
    const taskBundle = createGitRefTaskBundle({
      task: {
        ...opened.context.task,
        metadata,
        aggregate,
      },
      codeRef: opened.bundle.codeRef,
      now,
    });
    const result = await publishTaskMutation({
      ...opened,
      kind: 'task_complete',
      pendingMetadata,
      taskBundle,
      claims,
      operationId,
      now,
    });
    return {
      metadata,
      releasedClaims,
      aggregate,
      taskBundle,
      ...result,
    };
  } finally {
    await opened.context.release();
  }
}

/** Updates only lifecycle metadata through the remote authority and repair path. */
export async function updateGitRefWorkflow(
  input: UpdateGitRefWorkflowInput,
): Promise<UpdatedGitRefWorkflow> {
  const taskRef = requireSharedTask(input.taskRef);
  if (input.status === undefined && input.blockingReason === undefined) {
    throw new Error('MANCODE_WORKFLOW_UPDATE_EMPTY');
  }
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'git-ref workflow update operationId');
  const opened = await openGitRefWorkflowOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    now,
  });
  try {
    assertNoPendingHandoff(opened.manifest, taskRef);
    const timestamp = now.toISOString();
    const pendingMetadata = markGitRefWorkflowOperationPending(
      opened.context.task.metadata,
      operationId,
      timestamp,
    );
    const metadata = buildV3WorkflowUpdateMetadata(
      pendingMetadata,
      input.status,
      input.blockingReason,
      operationId,
      timestamp,
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: opened.context.task.requirements,
      review: opened.context.task.review,
      verification: opened.context.task.verification,
      planDigest: opened.context.task.plan?.digest ?? null,
      latestCheckpoint: opened.context.task.latestCheckpoint,
    });
    const claims = opened.manifest.claims.filter((claim) =>
      sameTaskRef(claim.taskRef, taskRef),
    );
    const taskBundle = createGitRefTaskBundle({
      task: {
        ...opened.context.task,
        metadata,
        aggregate,
      },
      codeRef: opened.bundle.codeRef,
      now,
    });
    const result = await publishTaskMutation({
      ...opened,
      kind: 'workflow_update',
      pendingMetadata,
      taskBundle,
      claims,
      operationId,
      now,
    });
    return { metadata, aggregate, taskBundle, ...result };
  } finally {
    await opened.context.release();
  }
}

interface OpenedGitRefWorkflowOperation {
  context: OpenedV3TaskOperation;
  transport: GitRefTeamManifestStore;
  manifest: NonNullable<GitRefTeamManifestSnapshot['manifest']>;
  bundle: GitRefTaskBundleV1;
  fence: GitRefOwnershipFenceV1;
}

async function openGitRefWorkflowOperation(input: {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  operationId: Ulid;
  now: Date;
}): Promise<OpenedGitRefWorkflowOperation> {
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef: input.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId: input.operationId,
    extraEntityLocks: [`remote:git-ref-${input.taskRef.taskId}`],
    now: input.now,
  });
  try {
    if (context.project.config.transport.mode !== 'git-ref') {
      throw new Error('MANCODE_GIT_REF_SYNC_REQUIRED');
    }
    const transport = createGitRefTeamManifestStore(
      context.projectRoot,
      context.project.config,
      context.project.manifest,
    );
    const snapshot = await transport.pull();
    const manifest = requireRemoteManifest(snapshot);
    const bundle = requireRemoteBundle(manifest, input.taskRef);
    const fence = requireRemoteFence(manifest, input.taskRef);
    if (
      fence.ownerActorId !== context.session.actorId ||
      context.task.metadata.ownerActorId !== context.session.actorId
    ) {
      throw new Error('MANCODE_TASK_OWNER_REQUIRED');
    }
    assertContextMatchesRemoteBundle(context, bundle);
    await assertGitRefBundleCodeReachable(context.projectRoot, bundle);
    return { context, transport, manifest, bundle, fence };
  } catch (error) {
    await context.release();
    throw error;
  }
}

async function publishTaskMutation(
  input: OpenedGitRefWorkflowOperation & {
    kind: GitRefWorkflowRepairKind;
    pendingMetadata: WorkflowMetadataV3;
    taskBundle: GitRefTaskBundleV1;
    claims: ClaimV1[];
    operationId: Ulid;
    now: Date;
  },
): Promise<{
  remoteRevision: number;
  ownershipEpoch: number;
  receipt: string;
  materialization: MaterializedGitRefTaskBundleResult;
}> {
  const nextRemoteRevision = input.manifest.revision + 1;
  const fence: GitRefOwnershipFenceV1 = {
    ...input.fence,
    taskRevision: input.taskBundle.taskRevision,
    aggregateDigest: input.taskBundle.aggregateDigest,
    remoteRevision: nextRemoteRevision,
    lastOperationId: input.operationId,
    updatedAt: input.now.toISOString(),
  };
  const handoffs = input.manifest.handoffs.filter((handoff) =>
    sameTaskRef(handoff.taskRef, input.context.taskRef),
  );
  const prepared = {
    schemaVersion: 1 as const,
    kind: input.kind,
    operationId: input.operationId,
    expectedRemoteRevision: input.manifest.revision,
    expectedOwnershipEpoch: input.fence.ownershipEpoch,
    targetRemoteRevision: nextRemoteRevision,
    targetOwnershipEpoch: fence.ownershipEpoch,
    predecessorBundle: input.bundle,
    predecessorFence: input.fence,
    targetBundle: input.taskBundle,
    targetFence: fence,
    targetClaimsDigest: digestCanonicalJson(input.claims),
    targetHandoffsDigest: digestCanonicalJson(handoffs),
  };
  const authorizationBasis = createAuthorizationBasis(
    {
      action:
        input.kind === 'workflow_update'
          ? 'shared_metadata_plan_mutation'
          : 'task_complete_scope_change_child_merge',
      actorId: input.context.session.actorId,
      session: {
        sessionId: input.context.session.sessionId,
        actorId: input.context.session.actorId,
        status: input.context.session.status,
      },
      joined:
        (await readSharedActorProfile(
          input.context.projectRoot,
          input.context.session.actorId,
        )) !== null,
      sharedWriteGuard: capabilitiesFromProjectConfig(
        input.context.project.config,
      ).writeGuard,
      task: {
        ownerActorId: input.context.task.metadata.ownerActorId,
        participantActorIds: input.context.task.metadata.participants,
      },
      claim: null,
      handoff: null,
      evidence: null,
      profileActorId: null,
      conditions: {
        expectedRevisionMatches: true,
        ownershipEpochFresh: true,
        ...(input.kind === 'workflow_update'
          ? {}
          : { completionGateSatisfied: true }),
      },
    },
    input.now,
  );
  await assertTaskCodeHeadUnchanged(
    input.context.projectRoot,
    input.context.codeHead,
  );
  try {
    await prepareGitRefWorkflowRepair({
      projectRoot: input.context.projectRoot,
      prepared,
      pendingMetadata: input.pendingMetadata,
      actorId: input.context.session.actorId,
      sessionId: input.context.session.sessionId,
      authorizationBasis,
      now: input.now,
    });
    await assertTaskCodeHeadUnchanged(
      input.context.projectRoot,
      input.context.codeHead,
    );
    const mutation = await input.transport.mutateCoordination({
      operationId: input.operationId,
      actorId: input.context.session.actorId,
      taskRef: input.context.taskRef,
      expectedRemoteRevision: input.manifest.revision,
      expectedOwnershipEpoch: input.fence.ownershipEpoch,
      expectedTaskBundleDigest:
        input.manifest.taskBundles.find((bundle) =>
          sameTaskRef(bundle.taskRef, input.context.taskRef),
        )?.bundleDigest ?? null,
      ownershipFence: fence,
      claims: input.claims,
      handoffs,
      taskBundle: input.taskBundle,
    });
    const recovery = await recoverGitRefWorkflowRepair(
      input.context.projectRoot,
      input.operationId,
      mutation.receipt,
      {
        actorId: input.context.session.actorId,
        sessionId: input.context.session.sessionId,
        taskLockHeld: true,
      },
    );
    if (recovery.state !== 'committed' || recovery.materialization === null) {
      throw new Error('MANCODE_REMOTE_RECEIPT_MISMATCH');
    }
    return {
      remoteRevision: mutation.remoteRevision,
      ownershipEpoch: mutation.ownershipEpoch,
      receipt: mutation.receipt,
      materialization: recovery.materialization,
    };
  } catch (error) {
    try {
      await recoverGitRefWorkflowRepair(
        input.context.projectRoot,
        input.operationId,
        null,
        {
          actorId: input.context.session.actorId,
          sessionId: input.context.session.sessionId,
          taskLockHeld: true,
        },
      );
    } catch {
      // A retained write-ahead journal now keeps ordinary writers out.
    }
    await recordV3ErrorDiagnostic(input.context.projectRoot, error).catch(
      () => undefined,
    );
    throw error;
  }
}

function assertScopeChangeEligible(
  context: OpenedV3TaskOperation,
  fence: GitRefOwnershipFenceV1,
  scope: WorkflowMetadataV3['implementationScope'],
): void {
  const metadata = context.task.metadata;
  if (
    metadata.workflowMode !== 'manteam' ||
    metadata.status !== 'in_progress' ||
    metadata.ownerActorId !== context.session.actorId ||
    fence.ownerActorId !== context.session.actorId
  ) {
    throw new Error('MANCODE_SCOPE_CHANGE_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.parent !== null) {
    throw new Error('MANCODE_PARENT_SCOPE_INHERITANCE_REQUIRED');
  }
  if (metadata.implementationScope.digest === scope.digest) {
    throw new Error('MANCODE_SCOPE_CHANGE_NOOP');
  }
  if (
    metadata.governance.planDecision !== 'governed_execution' ||
    context.task.plan === null
  ) {
    throw new Error('MANCODE_MANTEAM_PLAN_CONFIRMATION_REQUIRED');
  }
  assertManteamPlanContent(context.task.plan.content);
}

function assertClaimsFresh(
  context: OpenedV3TaskOperation,
  bundle: GitRefTaskBundleV1,
  claims: readonly ClaimV1[],
): void {
  for (const claim of claims) {
    if (
      claim.authority.mode !== 'git-ref' ||
      deriveClaimValidity(claim, {
        taskRef: context.taskRef,
        taskRevision: bundle.taskRevision,
        implementationScopeDigest:
          context.task.metadata.implementationScope.digest,
        ownershipEpoch: bundle.ownershipEpoch,
        codeRefHead: bundle.codeRef.head,
        now: context.now,
        transportFreshness: 'fresh',
      }) !== 'fresh'
    ) {
      throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
    }
  }
}

function scopeChangedMetadata(
  previous: WorkflowMetadataV3,
  scope: WorkflowMetadataV3['implementationScope'],
  checkpointId: Ulid,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    transitionState: 'stable',
    implementationScope: scope,
    latestCheckpointRef: {
      taskRef: previous.taskRef,
      kind: 'checkpoint',
      artifactId: checkpointId,
    },
    lastOperationId: operationId,
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function scopeChangedCheckpoint(input: {
  context: OpenedV3TaskOperation;
  metadata: WorkflowMetadataV3;
  checkpointId: Ulid;
  summary: string | undefined;
  nextAction: string | undefined;
  codeRef: GitRefTaskBundleV1['codeRef'];
  timestamp: string;
}): CheckpointV1 {
  return parseCheckpoint({
    schemaVersion: 1,
    checkpointId: input.checkpointId,
    operationId: input.context.operationId,
    taskRef: input.context.taskRef,
    taskRevision: input.metadata.revision,
    ownershipEpochAtOffer: input.metadata.ownershipEpoch,
    kind: 'scope_changed',
    git: {
      branch: input.codeRef.branch,
      head: input.codeRef.head,
      base: input.metadata.base?.head ?? null,
    },
    summary:
      input.summary ??
      'Changed the implementation scope and replaced affected coordination claims.',
    governance: {
      requirementsDigest: input.context.task.requirements.contentDigest,
      planVersion: input.metadata.governance.planVersion,
      reviewLedgerDigest: input.context.task.review.contentDigest,
      verificationLedgerDigest: input.context.task.verification.contentDigest,
    },
    nextAction:
      input.nextAction ??
      'Re-read the updated scope and continue only with the successor claim.',
    createdBy: {
      actorId: input.context.session.actorId,
      client: input.context.session.client,
    },
    createdAt: input.timestamp,
  });
}

function scopeChangedClaims(input: {
  claims: readonly ClaimV1[];
  taskRef: TaskRef;
  activeClaims: readonly ClaimV1[];
  successorPredecessors: readonly ClaimV1[];
  successorClaimIds: readonly Ulid[];
  metadata: WorkflowMetadataV3;
  codeRef: GitRefTaskBundleV1['codeRef'];
  operationId: Ulid;
  remoteRevision: number;
  timestamp: string;
}): ClaimV1[] {
  const successorByPredecessor = new Map<Ulid, Ulid>(
    input.successorPredecessors.map((claim, index) => [
      claim.claimId,
      input.successorClaimIds[index] as Ulid,
    ]),
  );
  const terminated = input.activeClaims.map((claim) =>
    terminateRemoteClaimForScopeChange(
      claim,
      successorByPredecessor.get(claim.claimId) ?? null,
      input.operationId,
      input.remoteRevision,
      input.timestamp,
    ),
  );
  const successors = input.successorPredecessors.map((claim, index) =>
    createRemoteScopeSuccessor({
      previous: claim,
      claimId: input.successorClaimIds[index] as Ulid,
      metadata: input.metadata,
      codeRef: input.codeRef,
      operationId: input.operationId,
      remoteRevision: input.remoteRevision,
      timestamp: input.timestamp,
    }),
  );
  const changed = new Map<Ulid, ClaimV1>([
    ...terminated.map((claim) => [claim.claimId, claim] as const),
    ...successors.map((claim) => [claim.claimId, claim] as const),
  ]);
  return input.claims
    .map((claim) => changed.get(claim.claimId) ?? claim)
    .concat(successors)
    .sort((left, right) => compareUtf8(left.claimId, right.claimId));
}

function terminateRemoteClaimForScopeChange(
  previous: ClaimV1,
  successorClaimId: Ulid | null,
  operationId: Ulid,
  remoteRevision: number,
  updatedAt: string,
): ClaimV1 {
  const next = parseClaim({
    ...previous,
    authority: { mode: 'git-ref', remoteRevision: String(remoteRevision) },
    state: successorClaimId === null ? 'released' : 'transferred',
    revision: previous.revision + 1,
    successorClaimId,
    lastOperationId: operationId,
    updatedAt,
  });
  assertClaimTransition(previous, next);
  return next;
}

function createRemoteScopeSuccessor(input: {
  previous: ClaimV1;
  claimId: Ulid;
  metadata: WorkflowMetadataV3;
  codeRef: GitRefTaskBundleV1['codeRef'];
  operationId: Ulid;
  remoteRevision: number;
  timestamp: string;
}): ClaimV1 {
  return parseClaim({
    ...input.previous,
    claimId: input.claimId,
    authority: {
      mode: 'git-ref',
      remoteRevision: String(input.remoteRevision),
    },
    taskRevisionAtAcquire: input.metadata.revision,
    lastValidatedTaskRevision: input.metadata.revision,
    implementationScopeDigest: input.metadata.implementationScope.digest,
    ownershipEpochAtAcquire: input.metadata.ownershipEpoch,
    state: 'active',
    revision: 1,
    codeRefAtAcquire: input.codeRef,
    lastValidatedCodeRef: input.codeRef,
    predecessorClaimId: input.previous.claimId,
    successorClaimId: null,
    lastOperationId: input.operationId,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  });
}

function releaseRemoteClaim(
  previous: ClaimV1,
  operationId: Ulid,
  remoteRevision: number,
  updatedAt: string,
): ClaimV1 {
  const next = parseClaim({
    ...previous,
    authority: { mode: 'git-ref', remoteRevision: String(remoteRevision) },
    state: 'released',
    revision: previous.revision + 1,
    lastOperationId: operationId,
    updatedAt,
  });
  assertClaimTransition(previous, next);
  return next;
}

function completedMetadata(
  previous: WorkflowMetadataV3,
  outcome: WorkflowMetadataV3['outcome'] | undefined,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    status: 'completed',
    currentStep: previous.workflowMode === 'manba' ? 5 : 9,
    blockingReason: null,
    outcome: previous.workflowMode === 'manba' ? (outcome ?? null) : null,
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function markGitRefWorkflowOperationPending(
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

function assertCompletionOutcome(
  metadata: WorkflowMetadataV3,
  outcome: WorkflowMetadataV3['outcome'] | undefined,
): void {
  if (metadata.workflowMode === 'manba') {
    if (outcome === undefined)
      throw new Error('MANCODE_MANBA_OUTCOME_REQUIRED');
    return;
  }
  if (outcome !== undefined)
    throw new Error('MANCODE_WORKFLOW_OUTCOME_INVALID');
}

function activeRemoteClaims(
  manifest: NonNullable<GitRefTeamManifestSnapshot['manifest']>,
  taskRef: TaskRef,
): ClaimV1[] {
  return manifest.claims
    .filter(
      (claim) =>
        sameTaskRef(claim.taskRef, taskRef) && claim.state === 'active',
    )
    .sort((left, right) => compareUtf8(left.claimId, right.claimId));
}

function resolveSuccessorClaimIds(
  predecessors: readonly ClaimV1[],
  requested: Ulid[] | undefined,
  operationId: Ulid,
  timestamp: string,
  allClaims: readonly ClaimV1[],
): Ulid[] {
  const ids =
    requested ??
    predecessors.map((claim) =>
      scopeSuccessorClaimId(operationId, claim.claimId, timestamp),
    );
  if (ids.length !== predecessors.length) {
    throw new Error('MANCODE_SCOPE_SUCCESSOR_CLAIM_COUNT_INVALID');
  }
  const existing = new Set(allClaims.map((claim) => claim.claimId));
  const seen = new Set<Ulid>();
  for (const claimId of ids) {
    assertUlid(claimId, 'scope successor claimId');
    if (existing.has(claimId) || seen.has(claimId)) {
      throw new Error('MANCODE_SCOPE_SUCCESSOR_CLAIM_INVALID');
    }
    seen.add(claimId);
  }
  return ids;
}

function assertNoPendingHandoff(
  manifest: NonNullable<GitRefTeamManifestSnapshot['manifest']>,
  taskRef: TaskRef,
): void {
  if (
    manifest.handoffs.some(
      (handoff) =>
        sameTaskRef(handoff.taskRef, taskRef) &&
        (handoff.state === 'draft' || handoff.state === 'offered'),
    )
  ) {
    throw new Error('MANCODE_HANDOFF_PENDING');
  }
}

function assertContextMatchesRemoteBundle(
  context: OpenedV3TaskOperation,
  bundle: GitRefTaskBundleV1,
): void {
  if (
    context.task.aggregate === null ||
    taskAggregateDigest(context.task.aggregate) !== bundle.aggregateDigest ||
    context.codeHead !== bundle.codeRef.head
  ) {
    throw new Error('MANCODE_TASK_BUNDLE_DIVERGED');
  }
}

function requireSharedTask(value: TaskRef): TaskRef {
  const taskRef = parseTaskRefValue(value);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_REMOTE_COORDINATION_REQUIRES_SHARED_TASK');
  }
  return taskRef;
}

function requireRemoteManifest(
  snapshot: GitRefTeamManifestSnapshot,
): NonNullable<GitRefTeamManifestSnapshot['manifest']> {
  if (snapshot.manifest === null) {
    throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_JOINED');
  }
  return snapshot.manifest;
}

function requireRemoteBundle(
  manifest: NonNullable<GitRefTeamManifestSnapshot['manifest']>,
  taskRef: TaskRef,
): GitRefTaskBundleV1 {
  const bundle = manifest.taskBundles.find((candidate) =>
    sameTaskRef(candidate.taskRef, taskRef),
  );
  if (bundle === undefined) throw new Error('MANCODE_TASK_UNAVAILABLE');
  return bundle;
}

function requireRemoteFence(
  manifest: NonNullable<GitRefTeamManifestSnapshot['manifest']>,
  taskRef: TaskRef,
): GitRefOwnershipFenceV1 {
  const fence = manifest.ownershipFences.find((candidate) =>
    sameTaskRef(candidate.taskRef, taskRef),
  );
  if (fence === undefined) {
    throw new Error('MANCODE_REMOTE_OWNERSHIP_FENCE_MISSING');
  }
  return fence;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

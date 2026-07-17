import { createHash } from 'node:crypto';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
} from '../context/aggregate.js';
import { digestCanonicalJson } from '../context/canonical.js';
import { createV3Checkpoint } from '../context/checkpoint-create.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import {
  assertTaskCodeHeadUnchanged,
  nextTaskHeadFence,
} from '../context/task-mutation.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from '../context/workflow-metadata.js';
import { createClaim, updateClaim } from '../runtime/claim-store.js';
import { resolveCoordinationEntityHomeStore } from '../runtime/entity-home-store.js';
import {
  createHandoff,
  readHandoff,
  updateHandoff,
} from '../runtime/handoff-store.js';
import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import {
  createClaimRecoveryAction,
  createHandoffRecoveryAction,
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
} from '../runtime/task-operation.js';
import { readSharedActorProfile } from './actor.js';
import { type CheckpointV1, checkpointDigest } from './checkpoints.js';
import { type ClaimV1, parseClaim } from './claims.js';
import {
  type HandoffSummary,
  type HandoffV1,
  parseHandoff,
} from './handoff.js';

export interface CreateV3HandoffDraftInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  toActorId: Ulid;
  /** Defaults to all currently active claims owned by the offering actor. */
  claimIds?: Ulid[];
  summary?: HandoffSummary;
  checkpointSummary?: string;
  checkpointNextAction?: string;
  handoffId?: Ulid;
  checkpointId?: Ulid;
  checkpointOperationId?: Ulid;
  operationId?: Ulid;
  now?: Date;
}

export interface CreatedV3HandoffDraft {
  checkpoint: CheckpointV1;
  checkpointOperation: OperationJournalV1;
  handoff: HandoffV1;
  operation: OperationJournalV1;
}

export interface TransitionV3HandoffInput {
  projectRoot: string;
  handoffId: Ulid;
  sessionId: Ulid;
  expectedHandoffRevision: number;
  reason?: string;
  operationId?: Ulid;
  now?: Date;
}

export interface TransitionedV3Handoff {
  handoff: HandoffV1;
  operation: OperationJournalV1;
}

export interface AcceptV3HandoffInput {
  projectRoot: string;
  handoffId: Ulid;
  sessionId: Ulid;
  expectedHandoffRevision: number;
  /** Optional explicit IDs; otherwise they are deterministic from operationId. */
  successorClaimIds?: Ulid[];
  operationId?: Ulid;
  now?: Date;
}

export interface AcceptedV3Handoff {
  metadata: WorkflowMetadataV3;
  handoff: HandoffV1;
  predecessorClaims: ClaimV1[];
  successorClaims: ClaimV1[];
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1;
  operation: OperationJournalV1;
}

/**
 * Creates the required immutable handoff checkpoint first, then records a
 * named draft under the canonical shared task lock. The checkpoint remains a
 * valid recovery artifact if the later draft write is interrupted.
 */
export async function createV3HandoffDraft(
  input: CreateV3HandoffDraftInput,
): Promise<CreatedV3HandoffDraft> {
  const taskRef = parseTaskRefValue(input.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_HANDOFF_REQUIRES_SHARED_TASK');
  }
  assertUlid(input.toActorId, 'handoff receiving actorId');
  const now = input.now ?? new Date();
  const checkpointOperationId =
    input.checkpointOperationId ?? createUlid(now.getTime());
  const handoffOperationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(checkpointOperationId, 'handoff checkpoint operationId');
  assertUlid(handoffOperationId, 'handoff draft operationId');

  const checkpointResult = await createV3Checkpoint({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    kind: 'handoff_offered',
    summary:
      input.checkpointSummary ??
      'Created an immutable checkpoint before offering task ownership.',
    nextAction:
      input.checkpointNextAction ??
      input.summary?.nextAction ??
      'Review the checkpoint and continue the assigned task.',
    checkpointId: input.checkpointId,
    operationId: checkpointOperationId,
    now,
  });
  const handoffId = input.handoffId ?? createUlid(now.getTime());
  assertUlid(handoffId, 'handoffId');
  const { context, handoff } = await openHandoffDraftContext({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: checkpointResult.metadata.revision,
    toActorId: input.toActorId,
    handoffId,
    claimIds: input.claimIds,
    summary: input.summary,
    checkpoint: checkpointResult.checkpoint,
    operationId: handoffOperationId,
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    journal = await createTaskOperationJournal(context, {
      type: 'handoff_transition',
      action: 'handoff_offer_cancel',
      expectedRevisions: {
        [taskEntityKey(taskRef)]: context.task.metadata.revision,
        [`handoff:${handoff.handoffId}`]: 0,
      },
      handoff: {
        fromActorId: handoff.fromActorId,
        toActorId: handoff.toActorId,
        intent: 'offer',
      },
      recovery: {
        actions: [
          createHandoffRecoveryAction({
            stepId: 'write-handoff',
            before: null,
            handoff,
          }),
        ],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);
    journal = await advanceTaskOperation(
      context,
      journal,
      'write-handoff',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await createHandoff(context.homeStore, handoff);
    const operation = await commitTaskOperation(context, journal);
    return {
      checkpoint: checkpointResult.checkpoint,
      checkpointOperation: checkpointResult.operation,
      handoff,
      operation,
    };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A durable intent keeps the coordination snapshot repair-only.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

/** Offers a named draft after rechecking its task bundle and recipient. */
export async function offerV3Handoff(
  input: TransitionV3HandoffInput,
): Promise<TransitionedV3Handoff> {
  return transitionV3Handoff(input, 'offer');
}

/** Rejects an offered handoff; only the receiving actor may do so. */
export async function rejectV3Handoff(
  input: TransitionV3HandoffInput,
): Promise<TransitionedV3Handoff> {
  if (input.reason === undefined || !input.reason.trim()) {
    throw new Error('MANCODE_HANDOFF_REJECTION_REASON_REQUIRED');
  }
  return transitionV3Handoff(input, 'reject');
}

/** Cancels a named draft or offer without changing task ownership. */
export async function cancelV3Handoff(
  input: TransitionV3HandoffInput,
): Promise<TransitionedV3Handoff> {
  return transitionV3Handoff(input, 'cancel');
}

/**
 * Accepts an offered local-coordination handoff as one task operation. The
 * task remains operation_pending until old claims have been terminally
 * transferred, successors are active for the new owner, and the handoff
 * state itself has become accepted.
 */
export async function acceptV3Handoff(
  input: AcceptV3HandoffInput,
): Promise<AcceptedV3Handoff> {
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'handoff accept operationId');
  const opened = await openAcceptHandoffContext({
    projectRoot: input.projectRoot,
    handoffId: input.handoffId,
    sessionId: input.sessionId,
    expectedHandoffRevision: input.expectedHandoffRevision,
    successorClaimIds: input.successorClaimIds,
    operationId,
    now,
  });
  const { context, handoff, predecessorClaims, successorClaimIds } = opened;
  let journal: OperationJournalV1 | null = null;
  try {
    assertHandoffBundleCurrent(context, handoff);
    assertHandoffAcceptable(context, handoff);
    assertTransferablePredecessorClaims(
      predecessorClaims,
      handoff,
      context.now,
    );
    const timestamp = context.now.toISOString();
    const checkpointId = handoffCheckpointId(handoff);
    const pendingMetadata = markHandoffOperationPending(
      context.task.metadata,
      context.operationId,
      timestamp,
    );
    const metadata = transferHandoffOwnership(
      pendingMetadata,
      handoff.toActorId,
      context.operationId,
      timestamp,
    );
    const [branch, successorClaims] = await Promise.all([
      readCheckoutBranch(context.projectRoot),
      Promise.resolve(
        buildPendingSuccessorClaims(
          predecessorClaims,
          successorClaimIds,
          metadata,
          handoff.toActorId,
          requireCodeHead(context),
          context.operationId,
          timestamp,
        ),
      ),
    ]);
    const pendingSuccessorClaims = successorClaims.map((claim) =>
      withSuccessorBranch(claim, branch ?? 'HEAD'),
    );
    const transferredClaims = predecessorClaims.map((claim, index) =>
      transferPredecessorClaim(
        claim,
        successorClaimIds[index] as Ulid,
        context.operationId,
        timestamp,
      ),
    );
    const activeSuccessorClaims = pendingSuccessorClaims.map((claim) =>
      activateSuccessorClaim(claim, context.operationId, timestamp),
    );
    const acceptedHandoff = acceptHandoff(
      handoff,
      context.session.actorId,
      context.operationId,
      timestamp,
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: context.task.requirements,
      review: context.task.review,
      verification: context.task.verification,
      planDigest: context.task.plan?.digest ?? null,
      latestCheckpoint: context.task.latestCheckpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);
    if (taskHeadFence === null) {
      throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
    }

    journal = await createTaskOperationJournal(context, {
      type: 'handoff_accept',
      action: 'handoff_accept_reject',
      expectedRevisions: acceptExpectedRevisions(
        context,
        handoff,
        checkpointId,
        predecessorClaims,
        successorClaimIds,
      ),
      handoff: {
        fromActorId: handoff.fromActorId,
        toActorId: handoff.toActorId,
        intent: 'accept',
      },
      conditions: { taskContextAvailable: true, transportFresh: true },
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-task-operation-pending',
            taskRef: context.taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
            targetContent: serializeTaskAuthority(pendingMetadata),
          }),
          ...pendingSuccessorClaims.map((claim) =>
            createClaimRecoveryAction({
              stepId: 'create-pending-successor-claims',
              before: null,
              claim,
            }),
          ),
          ...transferredClaims.map((claim, index) => {
            const before = predecessorClaims[index];
            if (before === undefined) {
              throw new Error('MANCODE_CLAIM_SET_CHANGED');
            }
            return createClaimRecoveryAction({
              stepId: 'transfer-old-claims',
              before,
              claim,
            });
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'update-owner-and-checkpoint',
            taskRef: context.taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(pendingMetadata),
            targetContent: serializeTaskAuthority(metadata),
          }),
          ...activeSuccessorClaims.map((claim, index) => {
            const before = pendingSuccessorClaims[index];
            if (before === undefined) {
              throw new Error('MANCODE_CLAIM_SET_CHANGED');
            }
            return createClaimRecoveryAction({
              stepId: 'activate-successor-claims',
              before,
              claim,
            });
          }),
          createHandoffRecoveryAction({
            stepId: 'accept-handoff',
            before: handoff,
            handoff: acceptedHandoff,
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
          ...(transferredClaims.length === 0 ? ['transfer-old-claims'] : []),
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
      'transfer-old-claims',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    for (const [index, claim] of transferredClaims.entries()) {
      await updateClaim(
        context.homeStore,
        claim,
        predecessorClaims[index]?.revision ?? 0,
      );
    }

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-owner-and-checkpoint',
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
      'accept-handoff',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await updateHandoff(
      context.homeStore,
      acceptedHandoff,
      handoff.revision,
      context.session.actorId,
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
      handoff: acceptedHandoff,
      predecessorClaims: transferredClaims,
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
        // Existing write intent forces forward repair by the original actor.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

async function openAcceptHandoffContext(input: {
  projectRoot: string;
  handoffId: Ulid;
  sessionId: Ulid;
  expectedHandoffRevision: number;
  successorClaimIds: Ulid[] | undefined;
  operationId: Ulid;
  now: Date;
}): Promise<{
  context: OpenedV3TaskOperation;
  handoff: HandoffV1;
  predecessorClaims: ClaimV1[];
  successorClaimIds: Ulid[];
}> {
  assertUlid(input.handoffId, 'handoffId');
  assertPositiveRevision(input.expectedHandoffRevision, 'handoff revision');
  const runtime = await readProjectRuntimeContext(input.projectRoot);
  const homeStore = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const preflight = await readHandoff(homeStore, input.handoffId);
  if (preflight === null) throw new Error('MANCODE_HANDOFF_NOT_FOUND');
  if (preflight.revision !== input.expectedHandoffRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  const preflightSuccessorIds = resolveSuccessorClaimIds(
    preflight,
    input.successorClaimIds,
    input.operationId,
  );
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef: preflight.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: preflight.taskRevision,
    operationId: input.operationId,
    extraEntityLocks: [
      `handoff:${input.handoffId}`,
      `checkpoint:${handoffCheckpointId(preflight)}`,
      taskHeadEntityKey(preflight.taskRef),
      ...preflight.claimIds.map((claimId) => `claim:${claimId}`),
      ...preflightSuccessorIds.map((claimId) => `claim:${claimId}`),
    ],
    now: input.now,
  });
  try {
    const handoff = context.coordination.handoffs.find(
      (candidate) => candidate.handoffId === input.handoffId,
    );
    if (handoff === undefined) throw new Error('MANCODE_HANDOFF_NOT_FOUND');
    if (handoff.revision !== input.expectedHandoffRevision) {
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    const successorClaimIds = resolveSuccessorClaimIds(
      handoff,
      input.successorClaimIds,
      input.operationId,
    );
    if (!sameUlidSet(preflightSuccessorIds, successorClaimIds)) {
      throw new Error('MANCODE_HANDOFF_CLAIM_SET_CHANGED');
    }
    const predecessorClaims = handoff.claimIds.map((claimId) => {
      const claim = context.coordination.claims.find(
        (candidate) => candidate.claimId === claimId,
      );
      if (claim === undefined)
        throw new Error('MANCODE_HANDOFF_CLAIM_UNAVAILABLE');
      return claim;
    });
    return { context, handoff, predecessorClaims, successorClaimIds };
  } catch (error) {
    await context.release();
    throw error;
  }
}

function assertHandoffAcceptable(
  context: OpenedV3TaskOperation,
  handoff: HandoffV1,
): void {
  if (handoff.state !== 'offered') {
    throw new Error('MANCODE_HANDOFF_NOT_OFFERED');
  }
  if (context.session.actorId !== handoff.toActorId) {
    throw new Error('MANCODE_HANDOFF_ACTOR_MISMATCH');
  }
  if (
    context.task.metadata.ownerActorId !== handoff.fromActorId ||
    context.task.metadata.ownershipEpoch !== handoff.ownershipEpochAtOffer
  ) {
    throw new Error('MANCODE_OWNERSHIP_EPOCH_STALE');
  }
}

function assertTransferablePredecessorClaims(
  claims: readonly ClaimV1[],
  handoff: HandoffV1,
  now: Date,
): void {
  if (claims.length !== handoff.claimIds.length) {
    throw new Error('MANCODE_HANDOFF_CLAIM_SET_CHANGED');
  }
  for (const claim of claims) {
    if (
      claim.state !== 'active' ||
      claim.ownerActorId !== handoff.fromActorId ||
      Date.parse(claim.expiresAt) <= now.getTime()
    ) {
      throw new Error('MANCODE_HANDOFF_CLAIM_UNAVAILABLE');
    }
  }
}

function resolveSuccessorClaimIds(
  handoff: HandoffV1,
  requested: Ulid[] | undefined,
  operationId: Ulid,
): Ulid[] {
  const ids =
    requested ??
    handoff.claimIds.map((claimId) =>
      handoffSuccessorClaimId(operationId, claimId, handoff.createdAt),
    );
  if (ids.length !== handoff.claimIds.length) {
    throw new Error('MANCODE_HANDOFF_SUCCESSOR_CLAIM_COUNT_INVALID');
  }
  const seen = new Set<Ulid>();
  for (const claimId of ids) {
    assertUlid(claimId, 'handoff successor claimId');
    if (seen.has(claimId) || handoff.claimIds.includes(claimId)) {
      throw new Error('MANCODE_HANDOFF_SUCCESSOR_CLAIM_INVALID');
    }
    seen.add(claimId);
  }
  return ids;
}

function handoffCheckpointId(handoff: HandoffV1): Ulid {
  const checkpointId = handoff.checkpointRef.artifactId;
  if (checkpointId === undefined) {
    throw new Error('MANCODE_HANDOFF_CHECKPOINT_INVALID');
  }
  assertUlid(checkpointId, 'handoff checkpointId');
  return checkpointId;
}

function markHandoffOperationPending(
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

function transferHandoffOwnership(
  previous: WorkflowMetadataV3,
  toActorId: Ulid,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    ownerActorId: toActorId,
    ownershipEpoch: previous.ownershipEpoch + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function buildPendingSuccessorClaims(
  predecessors: ClaimV1[],
  successorIds: Ulid[],
  metadata: WorkflowMetadataV3,
  toActorId: Ulid,
  codeHead: string,
  operationId: Ulid,
  updatedAt: string,
): ClaimV1[] {
  return predecessors.map((previous, index) => {
    const successorClaimId = successorIds[index];
    if (successorClaimId === undefined) {
      throw new Error('MANCODE_HANDOFF_SUCCESSOR_CLAIM_COUNT_INVALID');
    }
    return parseClaim({
      ...previous,
      claimId: successorClaimId,
      taskRevisionAtAcquire: metadata.revision,
      lastValidatedTaskRevision: metadata.revision,
      implementationScopeDigest: metadata.implementationScope.digest,
      ownershipEpochAtAcquire: metadata.ownershipEpoch,
      ownerActorId: toActorId,
      state: 'pending',
      revision: 1,
      predecessorClaimId: previous.claimId,
      successorClaimId: null,
      codeRefAtAcquire: { branch: 'HEAD', head: codeHead },
      lastValidatedCodeRef: { branch: 'HEAD', head: codeHead },
      lastOperationId: operationId,
      createdAt: updatedAt,
      updatedAt,
    });
  });
}

function withSuccessorBranch(claim: ClaimV1, branch: string): ClaimV1 {
  return parseClaim({
    ...claim,
    codeRefAtAcquire: { ...claim.codeRefAtAcquire, branch },
    lastValidatedCodeRef: { ...claim.lastValidatedCodeRef, branch },
  });
}

function transferPredecessorClaim(
  previous: ClaimV1,
  successorClaimId: Ulid,
  operationId: Ulid,
  updatedAt: string,
): ClaimV1 {
  return parseClaim({
    ...previous,
    state: 'transferred',
    revision: previous.revision + 1,
    successorClaimId,
    lastOperationId: operationId,
    updatedAt,
  });
}

function activateSuccessorClaim(
  previous: ClaimV1,
  operationId: Ulid,
  updatedAt: string,
): ClaimV1 {
  return parseClaim({
    ...previous,
    state: 'active',
    revision: previous.revision + 1,
    lastOperationId: operationId,
    updatedAt,
  });
}

function acceptHandoff(
  previous: HandoffV1,
  actorId: Ulid,
  operationId: Ulid,
  updatedAt: string,
): HandoffV1 {
  return parseHandoff({
    ...previous,
    state: 'accepted',
    revision: previous.revision + 1,
    lastOperationId: operationId,
    resolution: { state: 'accepted', actorId, at: updatedAt, reason: null },
    updatedAt,
  });
}

function acceptExpectedRevisions(
  context: OpenedV3TaskOperation,
  handoff: HandoffV1,
  checkpointId: Ulid,
  predecessors: ClaimV1[],
  successorClaimIds: Ulid[],
): Record<string, number> {
  const expected: Record<string, number> = {
    [taskEntityKey(handoff.taskRef)]: context.task.metadata.revision,
    [`handoff:${handoff.handoffId}`]: handoff.revision,
    [`checkpoint:${checkpointId}`]:
      context.task.latestCheckpoint?.taskRevision ?? 0,
  };
  for (const claim of predecessors) {
    expected[`claim:${claim.claimId}`] = claim.revision;
  }
  for (const claimId of successorClaimIds) {
    expected[`claim:${claimId}`] = 0;
  }
  const fence = context.coordination.taskHeadFence;
  if (fence === null) throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
  expected[taskHeadEntityKey(handoff.taskRef)] = fence.fenceRevision;
  return expected;
}

async function transitionV3Handoff(
  input: TransitionV3HandoffInput,
  intent: 'offer' | 'reject' | 'cancel',
): Promise<TransitionedV3Handoff> {
  const operationId =
    input.operationId ?? createUlid((input.now ?? new Date()).getTime());
  assertUlid(operationId, 'handoff transition operationId');
  const { context, handoff } = await openExistingHandoffContext({
    projectRoot: input.projectRoot,
    handoffId: input.handoffId,
    sessionId: input.sessionId,
    expectedHandoffRevision: input.expectedHandoffRevision,
    operationId,
    now: input.now ?? new Date(),
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertHandoffBundleCurrent(context, handoff);
    await assertHandoffRecipient(context, handoff.toActorId);
    assertTransitionState(handoff, intent);
    const timestamp = context.now.toISOString();
    const next = nextHandoffTransition(
      handoff,
      intent,
      context.session.actorId,
      input.reason,
      context.operationId,
      timestamp,
    );
    journal = await createTaskOperationJournal(context, {
      type: 'handoff_transition',
      action:
        intent === 'offer' || intent === 'cancel'
          ? 'handoff_offer_cancel'
          : 'handoff_accept_reject',
      expectedRevisions: {
        [taskEntityKey(handoff.taskRef)]: context.task.metadata.revision,
        [`handoff:${handoff.handoffId}`]: handoff.revision,
      },
      handoff: {
        fromActorId: handoff.fromActorId,
        toActorId: handoff.toActorId,
        intent,
      },
      conditions:
        intent === 'reject'
          ? { taskContextAvailable: true, transportFresh: true }
          : undefined,
      recovery: {
        actions: [
          createHandoffRecoveryAction({
            stepId: 'write-handoff',
            before: handoff,
            handoff: next,
          }),
        ],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);
    journal = await advanceTaskOperation(
      context,
      journal,
      'write-handoff',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await updateHandoff(
      context.homeStore,
      next,
      handoff.revision,
      context.session.actorId,
    );
    const operation = await commitTaskOperation(context, journal);
    return { handoff: next, operation };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A durable intent keeps the coordination snapshot repair-only.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

async function openHandoffDraftContext(input: {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  toActorId: Ulid;
  handoffId: Ulid;
  claimIds: Ulid[] | undefined;
  summary: HandoffSummary | undefined;
  checkpoint: CheckpointV1;
  operationId: Ulid;
  now: Date;
}): Promise<{ context: OpenedV3TaskOperation; handoff: HandoffV1 }> {
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef: input.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId: input.operationId,
    extraEntityLocks: [`handoff:${input.handoffId}`],
    now: input.now,
  });
  try {
    assertLocalHandoffTransport(context);
    assertHandoffTaskEligible(context.task.metadata);
    await assertHandoffRecipient(context, input.toActorId);
    if (
      context.task.latestCheckpoint === null ||
      context.task.latestCheckpoint.checkpointId !==
        input.checkpoint.checkpointId
    ) {
      throw new Error('MANCODE_HANDOFF_CHECKPOINT_STALE');
    }
    const claims = selectedOfferClaims(context, input.claimIds);
    const codeHead = requireCodeHead(context);
    const branch = (await readCheckoutBranch(context.projectRoot)) ?? 'HEAD';
    const timestamp = context.now.toISOString();
    const handoff = parseHandoff({
      schemaVersion: 1,
      handoffId: input.handoffId,
      taskRef: input.taskRef,
      taskRevision: context.task.metadata.revision,
      ownershipEpochAtOffer: context.task.metadata.ownershipEpoch,
      state: 'draft',
      revision: 1,
      fromActorId: context.session.actorId,
      toActorId: input.toActorId,
      claimIds: claims.map((claim) => claim.claimId),
      checkpointRef: {
        taskRef: input.taskRef,
        kind: 'checkpoint',
        artifactId: input.checkpoint.checkpointId,
      },
      summary: input.summary ?? defaultHandoffSummary(input.checkpoint),
      transport: {
        mode: 'local',
        state: 'local_only',
        transportRevision: null,
        publishedAt: null,
        fetchedAt: null,
        taskBundleDigest: handoffBundleDigest(
          context,
          input.checkpoint,
          codeHead,
        ),
        codeRef: { branch, head: codeHead },
        codeReachable: true,
        receipt: null,
      },
      lastOperationId: context.operationId,
      offeredAt: null,
      resolution: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { context, handoff };
  } catch (error) {
    await context.release();
    throw error;
  }
}

async function openExistingHandoffContext(input: {
  projectRoot: string;
  handoffId: Ulid;
  sessionId: Ulid;
  expectedHandoffRevision: number;
  operationId: Ulid;
  now: Date;
}): Promise<{ context: OpenedV3TaskOperation; handoff: HandoffV1 }> {
  assertUlid(input.handoffId, 'handoffId');
  assertPositiveRevision(input.expectedHandoffRevision, 'handoff revision');
  const runtime = await readProjectRuntimeContext(input.projectRoot);
  const homeStore = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const preflight = await readHandoff(homeStore, input.handoffId);
  if (preflight === null) throw new Error('MANCODE_HANDOFF_NOT_FOUND');
  if (preflight.revision !== input.expectedHandoffRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef: preflight.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: preflight.taskRevision,
    operationId: input.operationId,
    extraEntityLocks: [`handoff:${input.handoffId}`],
    now: input.now,
  });
  try {
    const handoff = context.coordination.handoffs.find(
      (candidate) => candidate.handoffId === input.handoffId,
    );
    if (handoff === undefined) throw new Error('MANCODE_HANDOFF_NOT_FOUND');
    if (handoff.revision !== input.expectedHandoffRevision) {
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    return { context, handoff };
  } catch (error) {
    await context.release();
    throw error;
  }
}

function assertHandoffTaskEligible(metadata: WorkflowMetadataV3): void {
  if (metadata.workflowMode !== 'manteam') {
    throw new Error('MANCODE_HANDOFF_WORKFLOW_MODE_INVALID');
  }
  if (metadata.status !== 'in_progress') {
    throw new Error('MANCODE_HANDOFF_WORKFLOW_NOT_ACTIVE');
  }
}

function assertLocalHandoffTransport(context: OpenedV3TaskOperation): void {
  if (context.project.config.transport.mode !== 'local') {
    throw new Error('MANCODE_GIT_REF_TRANSPORT_NOT_IMPLEMENTED');
  }
}

async function assertHandoffRecipient(
  context: OpenedV3TaskOperation,
  toActorId: Ulid,
): Promise<void> {
  if (!context.task.metadata.participants.includes(toActorId)) {
    throw new Error('MANCODE_HANDOFF_RECIPIENT_NOT_PARTICIPANT');
  }
  if ((await readSharedActorProfile(context.projectRoot, toActorId)) === null) {
    throw new Error('MANCODE_HANDOFF_RECIPIENT_NOT_JOINED');
  }
}

function selectedOfferClaims(
  context: OpenedV3TaskOperation,
  requested: Ulid[] | undefined,
): ClaimV1[] {
  const owned = context.coordination.claims.filter(
    (claim) =>
      claim.state === 'active' &&
      claim.ownerActorId === context.session.actorId,
  );
  const ids = requested ?? owned.map((claim) => claim.claimId);
  for (const claimId of ids) assertUlid(claimId, 'handoff claimId');
  if (
    !sameUlidSet(
      ids,
      owned.map((claim) => claim.claimId),
    )
  ) {
    throw new Error('MANCODE_HANDOFF_CLAIM_SET_INVALID');
  }
  return owned;
}

function defaultHandoffSummary(checkpoint: CheckpointV1): HandoffSummary {
  return {
    completed: [],
    inProgress: [],
    notStarted: [],
    changedFiles: [],
    verification: [],
    blockers: [],
    risks: [],
    nextAction: checkpoint.nextAction,
  };
}

function handoffBundleDigest(
  context: OpenedV3TaskOperation,
  checkpoint: CheckpointV1,
  codeHead: string,
): string {
  const aggregate = context.task.aggregate;
  if (aggregate === null) throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  return digestCanonicalJson({
    aggregate,
    checkpointDigest: checkpointDigest(checkpoint),
    codeRef: { head: codeHead },
  });
}

function requireCodeHead(context: OpenedV3TaskOperation): string {
  if (context.codeHead === null) {
    throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
  }
  return context.codeHead;
}

function assertHandoffBundleCurrent(
  context: OpenedV3TaskOperation,
  handoff: HandoffV1,
): void {
  assertLocalHandoffTransport(context);
  assertHandoffTaskEligible(context.task.metadata);
  const checkpoint = context.task.latestCheckpoint;
  const codeHead = requireCodeHead(context);
  if (
    context.task.metadata.revision !== handoff.taskRevision ||
    context.task.metadata.ownershipEpoch !== handoff.ownershipEpochAtOffer ||
    checkpoint === null ||
    checkpoint.checkpointId !== handoff.checkpointRef.artifactId ||
    handoff.transport.mode !== 'local' ||
    handoff.transport.state !== 'local_only' ||
    handoff.transport.codeReachable !== true ||
    handoff.transport.codeRef.head !== codeHead ||
    handoff.transport.taskBundleDigest !==
      handoffBundleDigest(context, checkpoint, codeHead)
  ) {
    throw new Error('MANCODE_HANDOFF_TASK_UNAVAILABLE');
  }
}

function assertTransitionState(
  handoff: HandoffV1,
  intent: 'offer' | 'reject' | 'cancel',
): void {
  if (intent === 'offer' && handoff.state !== 'draft') {
    throw new Error('MANCODE_HANDOFF_NOT_DRAFT');
  }
  if (intent === 'reject' && handoff.state !== 'offered') {
    throw new Error('MANCODE_HANDOFF_NOT_OFFERED');
  }
  if (
    intent === 'cancel' &&
    handoff.state !== 'draft' &&
    handoff.state !== 'offered'
  ) {
    throw new Error('MANCODE_HANDOFF_NOT_CANCELLABLE');
  }
}

function nextHandoffTransition(
  previous: HandoffV1,
  intent: 'offer' | 'reject' | 'cancel',
  actorId: Ulid,
  reason: string | undefined,
  operationId: Ulid,
  updatedAt: string,
): HandoffV1 {
  if (intent === 'offer') {
    return parseHandoff({
      ...previous,
      state: 'offered',
      revision: previous.revision + 1,
      lastOperationId: operationId,
      offeredAt: updatedAt,
      updatedAt,
    });
  }
  if (intent === 'reject') {
    return parseHandoff({
      ...previous,
      state: 'rejected',
      revision: previous.revision + 1,
      lastOperationId: operationId,
      resolution: {
        state: 'rejected',
        actorId,
        at: updatedAt,
        reason: reason?.trim() ?? null,
      },
      updatedAt,
    });
  }
  return parseHandoff({
    ...previous,
    state: 'cancelled',
    revision: previous.revision + 1,
    lastOperationId: operationId,
    resolution: {
      state: 'cancelled',
      actorId,
      at: updatedAt,
      reason: reason?.trim() || null,
    },
    updatedAt,
  });
}

function sameUlidSet(left: readonly Ulid[], right: readonly Ulid[]): boolean {
  const normalizedLeft = [...left].sort(compareUtf8);
  const normalizedRight = [...right].sort(compareUtf8);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `MANCODE_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`,
    );
  }
}

/** Stable future successor IDs for the same accept operation and claim. */
export function handoffSuccessorClaimId(
  operationId: Ulid,
  predecessorClaimId: Ulid,
  createdAt: string,
): Ulid {
  assertUlid(operationId, 'handoff accept operationId');
  assertUlid(predecessorClaimId, 'handoff predecessor claimId');
  const timestamp = Date.parse(createdAt);
  if (Number.isNaN(timestamp))
    throw new Error('MANCODE_HANDOFF_TIMESTAMP_INVALID');
  const entropy = createHash('sha256')
    .update(`${operationId}:${predecessorClaimId}`, 'utf8')
    .digest()
    .subarray(0, 10);
  return createUlid(timestamp, entropy);
}

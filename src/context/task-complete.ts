import { updateClaim } from '../runtime/claim-store.js';
import { resolveTaskEntityHomeStore } from '../runtime/entity-home-store.js';
import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import {
  createClaimRecoveryAction,
  createTaskAuthorityFileRecoveryAction,
  createTaskHeadFenceRecoveryAction,
} from '../runtime/operation-recovery-payload.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import {
  enqueueCacheInvalidationProjection,
  enqueueSessionPointerProjection,
  reconcileProjectionIntents,
} from '../runtime/projection-outbox.js';
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
import {
  type ClaimV1,
  assertClaimTransition,
  parseClaim,
} from '../team/claims.js';
import {
  type TaskAggregateManifestV1,
  assertTaskCompletionGate,
  buildTaskAggregateManifest,
} from './aggregate.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { V3ContextStore } from './store.js';
import {
  assertTaskCodeHeadUnchanged,
  nextTaskHeadFence,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface CompleteV3TaskInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  /** Required only for a terminal manba diagnostic task. */
  outcome?: WorkflowMetadataV3['outcome'];
  operationId?: Ulid;
  now?: Date;
}

export interface CompletedV3Task {
  metadata: WorkflowMetadataV3;
  releasedClaims: ClaimV1[];
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/**
 * Completes a task only after the full aggregate gate passes. Team claims are
 * transitioned to released under the same task journal before the completed
 * metadata becomes stable, so a terminal task can never retain an active
 * claim after a successful commit.
 */
export async function completeV3Task(
  input: CompleteV3TaskInput,
): Promise<CompletedV3Task> {
  const taskRef = parseTaskRefValue(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'task completion operationId');
  const { context, activeClaims } = await openCompletionContext({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertCompletionOutcome(context.task.metadata, input.outcome);
    if (
      taskRef.namespace === 'shared' &&
      context.project.config.transport.mode !== 'local'
    ) {
      // A git-ref claim release must be part of the remote CAS. Until P2
      // supplies that commit protocol, a local completed bit would lie.
      throw new Error('MANCODE_GIT_REF_TRANSPORT_NOT_IMPLEMENTED');
    }
    const activeChildren = await context.store.listActiveChildTaskRefs(taskRef);
    assertTaskCompletionGate(
      {
        metadata: context.task.metadata,
        requirements: context.task.requirements,
        review: context.task.review,
        verification: context.task.verification,
        planDigest: context.task.plan?.digest ?? null,
        latestCheckpoint: context.task.latestCheckpoint,
      },
      {
        activeChildTaskRefs: activeChildren,
        hasPendingRepairOperation: false,
        activeClaimCount: activeClaims.length,
        claimsWillReleaseOrTransfer: activeClaims.length > 0,
      },
    );
    const timestamp = context.now.toISOString();
    const pendingMetadata = markCompletionOperationPending(
      context.task.metadata,
      context.operationId,
      timestamp,
    );
    const releasedClaims = activeClaims.map((claim) =>
      releaseClaim(claim, context.operationId, timestamp),
    );
    const metadata = completedMetadata(
      pendingMetadata,
      input.outcome,
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

    await Promise.all([
      enqueueSessionPointerProjection(context.projectRoot, {
        operationId: context.operationId,
        action: 'clear',
        sessionId: context.session.sessionId,
        expectedPreviousTaskRef: context.session.activeTaskRef,
        taskRef,
        workflowMode: metadata.workflowMode,
        taskRevision: metadata.revision,
        now: context.now,
      }),
      enqueueCacheInvalidationProjection(context.projectRoot, {
        operationId: context.operationId,
        cacheKind: 'context_pack',
        taskRef,
        now: context.now,
      }),
      enqueueCacheInvalidationProjection(context.projectRoot, {
        operationId: context.operationId,
        cacheKind: 'status_index',
        taskRef,
        now: context.now,
      }),
    ]);

    journal = await createTaskOperationJournal(context, {
      type: 'task_complete',
      action:
        taskRef.namespace === 'shared'
          ? 'task_complete_scope_change_child_merge'
          : 'local_workflow_mutation',
      expectedRevisions: completionExpectedRevisions(context, activeClaims),
      conditions: { completionGateSatisfied: true },
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-operation-pending',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
            targetContent: serializeTaskAuthority(pendingMetadata),
          }),
          ...releasedClaims.map((claim) => {
            const before = activeClaims.find(
              (candidate) => candidate.claimId === claim.claimId,
            );
            if (before === undefined) {
              throw new Error('MANCODE_CLAIM_SET_CHANGED');
            }
            return createClaimRecoveryAction({
              stepId: 'release-or-transfer-claims',
              before,
              claim,
            });
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'write-completed-metadata',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(pendingMetadata),
            targetContent: serializeTaskAuthority(metadata),
          }),
          ...(taskHeadFence === null
            ? []
            : [
                createTaskHeadFenceRecoveryAction({
                  stepId: 'update-task-head-fence',
                  before: context.coordination.taskHeadFence,
                  fence: taskHeadFence,
                }),
              ]),
        ],
        noOpStepIds: [
          ...(releasedClaims.length === 0
            ? ['release-or-transfer-claims']
            : []),
          ...(taskHeadFence === null ? ['update-task-head-fence'] : []),
        ],
      },
    });
    journal = await advanceTaskOperation(
      context,
      journal,
      'validate-completion-gate',
      true,
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'mark-operation-pending',
      false,
    );
    await writeTaskAuthorityFile(
      context,
      'metadata.json',
      `${JSON.stringify(pendingMetadata, null, 2)}\n`,
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'release-or-transfer-claims',
      false,
    );
    for (const claim of releasedClaims) {
      const previous = activeClaims.find(
        (candidate) => candidate.claimId === claim.claimId,
      );
      if (previous === undefined) {
        throw new Error('MANCODE_CLAIM_SET_CHANGED');
      }
      await updateClaim(context.homeStore, claim, previous.revision);
    }

    journal = await advanceTaskOperation(
      context,
      journal,
      'write-completed-metadata',
      false,
    );
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
    if (taskHeadFence !== null) {
      await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
      await replaceTaskHeadFence(context.homeStore, taskHeadFence);
    }
    const operation = await commitTaskOperation(context, journal);
    try {
      await reconcileProjectionIntents(
        context.projectRoot,
        context.operationId,
        context.now,
      );
    } catch {
      // Terminal authority is committed; projections remain pending for doctor.
    }
    return {
      metadata,
      releasedClaims,
      aggregate,
      taskHeadFence,
      operation,
    };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // Completed write intent is sufficient to keep normal writers out.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

async function openCompletionContext(input: {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  operationId: Ulid;
  now: Date;
}): Promise<{ context: OpenedV3TaskOperation; activeClaims: ClaimV1[] }> {
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
    const preflightClaimIds = activeClaimIds(preflight.claims);
    const context = await openV3TaskOperation({
      projectRoot: input.projectRoot,
      taskRef: input.taskRef,
      sessionId: input.sessionId,
      expectedTaskRevision: input.expectedTaskRevision,
      operationId: input.operationId,
      extraEntityLocks: [
        ...preflightClaimIds.map((claimId) => `claim:${claimId}`),
        ...(input.taskRef.namespace === 'shared'
          ? [taskHeadEntityKey(input.taskRef)]
          : []),
      ],
      now: input.now,
    });
    const activeClaims = context.coordination.claims.filter(
      (claim) => claim.state === 'active',
    );
    if (sameIdSet(preflightClaimIds, activeClaimIds(activeClaims))) {
      return { context, activeClaims };
    }
    await context.release();
  }
  throw new Error('MANCODE_CLAIM_SET_CHANGED');
}

function markCompletionOperationPending(
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

function releaseClaim(
  previous: ClaimV1,
  operationId: Ulid,
  updatedAt: string,
): ClaimV1 {
  const next = parseClaim({
    ...previous,
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
  const expectedOutcome =
    previous.workflowMode === 'manba' ? (outcome ?? null) : null;
  const next = parseWorkflowMetadata({
    ...previous,
    status: 'completed',
    currentStep: previous.workflowMode === 'manba' ? 5 : 9,
    blockingReason: null,
    outcome: expectedOutcome,
    revision: previous.revision + 1,
    transitionState: 'stable',
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
    if (outcome === undefined) {
      throw new Error('MANCODE_MANBA_OUTCOME_REQUIRED');
    }
    return;
  }
  if (outcome !== undefined) {
    throw new Error('MANCODE_WORKFLOW_OUTCOME_INVALID');
  }
}

function completionExpectedRevisions(
  context: OpenedV3TaskOperation,
  activeClaims: ClaimV1[],
): Record<string, number> {
  const expected: Record<string, number> = {
    [taskEntityKey(context.taskRef)]: context.task.metadata.revision,
  };
  for (const claim of activeClaims) {
    expected[`claim:${claim.claimId}`] = claim.revision;
  }
  if (context.taskRef.namespace === 'shared') {
    const fence = context.coordination.taskHeadFence;
    if (fence === null) throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
    expected[taskHeadEntityKey(context.taskRef)] = fence.fenceRevision;
  }
  return expected;
}

function activeClaimIds(claims: ClaimV1[]): Ulid[] {
  return claims
    .filter((claim) => claim.state === 'active')
    .map((claim) => claim.claimId)
    .sort(compareUtf8);
}

function sameIdSet(left: readonly Ulid[], right: readonly Ulid[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

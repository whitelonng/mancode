import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import {
  createCheckpointRecoveryAction,
  createTaskAuthorityFileRecoveryAction,
  createTaskHeadFenceRecoveryAction,
} from '../runtime/operation-recovery-payload.js';
import {
  readCheckoutBranch,
  readCheckoutCodeHead,
} from '../runtime/project-runtime.js';
import {
  enqueueCacheInvalidationProjection,
  reconcileProjectionIntents,
} from '../runtime/projection-outbox.js';
import type { TaskHeadFenceV1 } from '../runtime/task-head-fence.js';
import { replaceTaskHeadFence } from '../runtime/task-head-store.js';
import {
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
import {
  type CheckpointKind,
  type CheckpointV1,
  parseCheckpoint,
} from '../team/checkpoints.js';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
} from './aggregate.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
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

export interface CreateV3CheckpointInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  kind: CheckpointKind;
  summary: string;
  /** Defaults to a stable generic continuation instruction for CLI callers. */
  nextAction?: string;
  checkpointId?: Ulid;
  operationId?: Ulid;
  now?: Date;
}

export interface CreatedV3Checkpoint {
  checkpoint: CheckpointV1;
  metadata: WorkflowMetadataV3;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/**
 * Checkpoints are immutable task snapshots. The journal exposes the pending
 * metadata state before the checkpoint is created, so an interrupted write
 * can only be repaired forward and can never leave a stable metadata pointer
 * to a missing or substituted checkpoint.
 */
export async function createV3Checkpoint(
  input: CreateV3CheckpointInput,
): Promise<CreatedV3Checkpoint> {
  const taskRef = parseTaskRefValue(input.taskRef);
  const now = input.now ?? new Date();
  const checkpointId = input.checkpointId ?? createUlid(now.getTime());
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(checkpointId, 'checkpointId');
  assertUlid(operationId, 'checkpoint operationId');
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    extraEntityLocks: [
      `checkpoint:${checkpointId}`,
      ...(taskRef.namespace === 'shared' ? [taskHeadEntityKey(taskRef)] : []),
    ],
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertCheckpointEligible(context.task.metadata);
    const timestamp = context.now.toISOString();
    const pendingMetadata = markCheckpointOperationPending(
      context.task.metadata,
      context.operationId,
      timestamp,
    );
    const [branch, observedCodeHead] = await Promise.all([
      readCheckoutBranch(context.projectRoot),
      taskRef.namespace === 'shared'
        ? Promise.resolve(context.codeHead)
        : readCheckoutCodeHead(context.projectRoot),
    ]);
    const checkpoint = parseCheckpoint({
      schemaVersion: 1,
      checkpointId,
      operationId: context.operationId,
      taskRef,
      taskRevision: pendingMetadata.revision,
      ownershipEpochAtOffer: pendingMetadata.ownershipEpoch,
      kind: input.kind,
      git: {
        branch,
        head: observedCodeHead,
        base: pendingMetadata.base?.head ?? null,
      },
      summary: input.summary,
      governance: {
        requirementsDigest: context.task.requirements.contentDigest,
        planVersion: pendingMetadata.governance.planVersion,
        reviewLedgerDigest: context.task.review.contentDigest,
        verificationLedgerDigest: context.task.verification.contentDigest,
      },
      nextAction:
        input.nextAction ?? 'Resume the workflow at its current step.',
      createdBy: {
        actorId: context.session.actorId,
        client: context.session.client,
      },
      createdAt: timestamp,
    });
    const metadata = completeCheckpointMetadata(
      pendingMetadata,
      checkpoint,
      context.operationId,
      timestamp,
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

    await Promise.all([
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
      type: 'checkpoint_create',
      action:
        taskRef.namespace === 'shared'
          ? 'shared_metadata_plan_mutation'
          : 'local_workflow_mutation',
      expectedRevisions: checkpointExpectedRevisions(context, checkpointId),
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
            stepId: 'write-checkpoint',
            before: null,
            checkpoint,
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'update-metadata-checkpoint-ref',
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
        noOpStepIds: taskHeadFence === null ? ['update-task-head-fence'] : [],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);

    journal = await advanceTaskOperation(
      context,
      journal,
      'mark-task-operation-pending',
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
      'write-checkpoint',
      false,
    );
    if (taskRef.namespace === 'shared') {
      await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    }
    await writeTaskCheckpoint(context, checkpoint);

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-metadata-checkpoint-ref',
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
      // Cache invalidation is compensable and remains pending for doctor.
    }
    return { checkpoint, metadata, aggregate, taskHeadFence, operation };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // The completed write intent keeps the task in the repair envelope.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

function assertCheckpointEligible(metadata: WorkflowMetadataV3): void {
  if (
    metadata.status !== 'in_progress' &&
    metadata.status !== 'planned' &&
    metadata.status !== 'blocked'
  ) {
    throw new Error('MANCODE_CHECKPOINT_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.transitionState !== 'stable') {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
}

function markCheckpointOperationPending(
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

function completeCheckpointMetadata(
  previous: WorkflowMetadataV3,
  checkpoint: CheckpointV1,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    latestCheckpointRef: {
      taskRef: checkpoint.taskRef,
      kind: 'checkpoint',
      artifactId: checkpoint.checkpointId,
    },
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function checkpointExpectedRevisions(
  context: Awaited<ReturnType<typeof openV3TaskOperation>>,
  checkpointId: Ulid,
): Record<string, number> {
  const expected: Record<string, number> = {
    [taskEntityKey(context.taskRef)]: context.task.metadata.revision,
    [`checkpoint:${checkpointId}`]: 0,
  };
  if (context.taskRef.namespace === 'shared') {
    const fence = context.coordination.taskHeadFence;
    if (fence === null) throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
    expected[taskHeadEntityKey(context.taskRef)] = fence.fenceRevision;
  }
  return expected;
}

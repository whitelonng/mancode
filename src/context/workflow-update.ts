import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import {
  createTaskAuthorityFileRecoveryAction,
  createTaskHeadFenceRecoveryAction,
} from '../runtime/operation-recovery-payload.js';
import type { TaskHeadFenceV1 } from '../runtime/task-head-fence.js';
import { replaceTaskHeadFence } from '../runtime/task-head-store.js';
import {
  advanceTaskOperation,
  commitTaskOperation,
  createTaskOperationJournal,
  handleTaskOperationFailure,
  openV3TaskOperation,
  serializeTaskAuthority,
  taskHeadEntityKey,
  writeTaskAuthorityFile,
} from '../runtime/task-operation.js';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
} from './aggregate.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import {
  assertTaskCodeHeadUnchanged,
  nextTaskHeadFence,
  taskMutationExpectedRevisions,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export type V3WorkflowUpdateStatus = Exclude<
  WorkflowMetadataV3['status'],
  'completed' | 'superseded'
>;

export interface UpdateV3WorkflowInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  /** Completion and supersession have dedicated operations and are rejected. */
  status?: V3WorkflowUpdateStatus | 'completed' | 'superseded';
  /** Only a blocked task may carry a non-empty blocking reason. */
  blockingReason?: string | null;
  operationId?: Ulid;
  now?: Date;
}

export interface UpdatedV3Workflow {
  metadata: WorkflowMetadataV3;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/**
 * Performs the small, lifecycle-only part of `workflow update`. Governance
 * ledgers, implementation scope, completion, and supersession retain their
 * dedicated operations so a generic metadata patch cannot bypass their gates.
 */
export async function updateV3Workflow(
  input: UpdateV3WorkflowInput,
): Promise<UpdatedV3Workflow> {
  const taskRef = parseTaskRefValue(input.taskRef);
  if (input.status === undefined && input.blockingReason === undefined) {
    throw new Error('MANCODE_WORKFLOW_UPDATE_EMPTY');
  }
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'workflow update operationId');
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    extraEntityLocks:
      taskRef.namespace === 'shared' ? [taskHeadEntityKey(taskRef)] : [],
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    const metadata = buildV3WorkflowUpdateMetadata(
      context.task.metadata,
      input.status,
      input.blockingReason,
      context.operationId,
      context.now.toISOString(),
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: context.task.requirements,
      review: context.task.review,
      verification: context.task.verification,
      planDigest: context.task.plan?.digest ?? null,
      latestCheckpoint: context.task.latestCheckpoint,
    });
    const taskHeadFence = nextTaskHeadFence(
      context,
      aggregate,
      context.now.toISOString(),
    );
    journal = await createTaskOperationJournal(context, {
      type: 'workflow_update',
      action:
        taskRef.namespace === 'shared'
          ? 'shared_metadata_plan_mutation'
          : 'local_workflow_mutation',
      expectedRevisions: taskMutationExpectedRevisions(context, []),
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'write-metadata',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
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
      'write-metadata',
      false,
    );
    await writeTaskAuthorityFile(
      context,
      'metadata.json',
      serializeTaskAuthority(metadata),
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
    return { metadata, aggregate, taskHeadFence, operation };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // The prepared journal blocks ordinary writes until recovery.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

/** Shared by local and git-ref lifecycle updates; callers provide the current
 * stable or write-ahead metadata that should receive exactly one transition. */
export function buildV3WorkflowUpdateMetadata(
  previous: WorkflowMetadataV3,
  requestedStatus: UpdateV3WorkflowInput['status'],
  requestedBlockingReason: string | null | undefined,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  if (isTerminal(previous.status)) {
    throw new Error('MANCODE_WORKFLOW_TERMINAL');
  }
  const status = requestedStatus ?? previous.status;
  if (status === 'completed') {
    throw new Error('MANCODE_WORKFLOW_COMPLETE_COMMAND_REQUIRED');
  }
  if (status === 'superseded') {
    throw new Error('MANCODE_WORKFLOW_PROMOTION_COMMAND_REQUIRED');
  }
  if (status === 'blocked') {
    const blockingReason = requestedBlockingReason ?? previous.blockingReason;
    if (typeof blockingReason !== 'string' || !blockingReason.trim()) {
      throw new Error('MANCODE_BLOCKING_REASON_REQUIRED');
    }
    return parseAndAssertMetadata(previous, {
      status,
      blockingReason,
      operationId,
      updatedAt,
    });
  }
  if (
    requestedBlockingReason !== undefined &&
    requestedBlockingReason !== null
  ) {
    throw new Error('MANCODE_BLOCKING_REASON_STATUS_INVALID');
  }
  return parseAndAssertMetadata(previous, {
    status,
    blockingReason: null,
    operationId,
    updatedAt,
  });
}

function parseAndAssertMetadata(
  previous: WorkflowMetadataV3,
  update: {
    status: V3WorkflowUpdateStatus;
    blockingReason: string | null;
    operationId: Ulid;
    updatedAt: string;
  },
): WorkflowMetadataV3 {
  if (
    previous.status === update.status &&
    previous.blockingReason === update.blockingReason
  ) {
    throw new Error('MANCODE_WORKFLOW_UPDATE_NOOP');
  }
  const next = parseWorkflowMetadata({
    ...previous,
    status: update.status,
    blockingReason: update.blockingReason,
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: update.operationId,
    updatedAt: update.updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function isTerminal(status: WorkflowMetadataV3['status']): boolean {
  return (
    status === 'completed' || status === 'abandoned' || status === 'superseded'
  );
}

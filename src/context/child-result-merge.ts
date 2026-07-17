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
import type { TaskHeadFenceV1 } from '../runtime/task-head-fence.js';
import { assertTaskHeadFenceMatchesAggregate } from '../runtime/task-head-fence.js';
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
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
} from './aggregate.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { assertSharedTextSafe } from './privacy.js';
import type { StoredTaskSnapshot } from './store.js';
import {
  assertTaskCodeHeadUnchanged,
  nextTaskHeadFence,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import {
  type WorkflowMetadataV3,
  assertParentWorkflowRelation,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface MergeV3ChildResultInput {
  projectRoot: string;
  parentTaskRef: TaskRef;
  childTaskRef: TaskRef;
  sessionId: Ulid;
  expectedParentRevision: number;
  expectedChildRevision: number;
  /** A privacy-screened, user-confirmed diagnostic result summary. */
  summary: string;
  nextAction: string;
  checkpointId?: Ulid;
  operationId?: Ulid;
  now?: Date;
}

export interface MergedV3ChildResult {
  metadata: WorkflowMetadataV3;
  checkpoint: CheckpointV1;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/**
 * Merges one completed `manba` child's typed outcome into its parent under
 * the parent lock.  A child snapshot is deliberately never refreshed here:
 * if the parent moved since the child was created, its result is stale and
 * the caller must explicitly recreate the diagnostic task instead of guessing
 * which version of the parent the result applies to.
 */
export async function mergeV3ChildResult(
  input: MergeV3ChildResultInput,
): Promise<MergedV3ChildResult> {
  const parentTaskRef = parseTaskRefValue(input.parentTaskRef);
  const childTaskRef = parseTaskRefValue(input.childTaskRef);
  if (sameTaskRef(parentTaskRef, childTaskRef)) {
    throw new Error('MANCODE_CHILD_RESULT_PARENT_REQUIRED');
  }
  if (parentTaskRef.namespace !== childTaskRef.namespace) {
    throw new Error('MANCODE_CHILD_RESULT_NAMESPACE_MISMATCH');
  }
  assertPositiveRevision(
    input.expectedParentRevision,
    'child merge expected parent revision',
  );
  assertPositiveRevision(
    input.expectedChildRevision,
    'child merge expected child revision',
  );
  const summary = requireText(input.summary, 'child result summary');
  const nextAction = requireText(input.nextAction, 'child result nextAction');
  const now = input.now ?? new Date();
  const checkpointId = input.checkpointId ?? createUlid(now.getTime());
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(checkpointId, 'child merge checkpointId');
  assertUlid(operationId, 'child merge operationId');

  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef: parentTaskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedParentRevision,
    operationId,
    extraEntityLocks: [
      taskEntityKey(childTaskRef),
      `checkpoint:${checkpointId}`,
      ...(parentTaskRef.namespace === 'shared'
        ? [taskHeadEntityKey(parentTaskRef), taskHeadEntityKey(childTaskRef)]
        : []),
    ],
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    const [child, childCoordination, branch, observedCodeHead] =
      await Promise.all([
        context.store.readTaskSnapshot(childTaskRef),
        context.store.readCoordinationSnapshot(childTaskRef, context.homeStore),
        readCheckoutBranch(context.projectRoot),
        parentTaskRef.namespace === 'shared'
          ? Promise.resolve(context.codeHead)
          : readCheckoutCodeHead(context.projectRoot),
      ]);
    assertChildResultMergeEligible(
      context,
      child,
      childCoordination.pendingOperations.length,
      input.expectedChildRevision,
    );
    assertChildSharedFence(context, child, childCoordination.taskHeadFence);

    const timestamp = context.now.toISOString();
    const pendingMetadata = markParentOperationPending(
      context.task.metadata,
      context.operationId,
      timestamp,
    );
    const checkpoint = buildChildMergeCheckpoint({
      context,
      child,
      pendingMetadata,
      checkpointId,
      summary,
      nextAction,
      branch,
      codeHead: observedCodeHead,
      timestamp,
    });
    const metadata = completeParentMergeMetadata(
      pendingMetadata,
      child.metadata,
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

    journal = await createTaskOperationJournal(context, {
      type: 'child_result_merge',
      action:
        parentTaskRef.namespace === 'shared'
          ? 'task_complete_scope_change_child_merge'
          : 'local_workflow_mutation',
      expectedRevisions: childMergeExpectedRevisions(
        context,
        child,
        childCoordination.taskHeadFence,
        checkpointId,
      ),
      conditions:
        parentTaskRef.namespace === 'shared'
          ? {
              // This action family is the owner-only, fresh-epoch mutation
              // path. The child/parent snapshot gate above is its concrete
              // precondition; it does not claim that the parent is complete.
              completionGateSatisfied: true,
              requiresParentOwner: true,
              parentOwnerActorId: context.task.metadata.ownerActorId,
            }
          : undefined,
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-parent-operation-pending',
            taskRef: parentTaskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
            targetContent: serializeTaskAuthority(pendingMetadata),
          }),
          createCheckpointRecoveryAction({
            stepId: 'write-merge-checkpoint',
            before: null,
            checkpoint,
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'update-parent-metadata',
            taskRef: parentTaskRef,
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
    journal = await advanceTaskOperation(
      context,
      journal,
      'validate-parent-snapshot',
      true,
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'mark-parent-operation-pending',
      false,
    );
    await writeTaskAuthorityFile(
      context,
      'metadata.json',
      serializeTaskAuthority(pendingMetadata),
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'write-merge-checkpoint',
      false,
    );
    if (parentTaskRef.namespace === 'shared') {
      await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    }
    await writeTaskCheckpoint(context, checkpoint);

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-parent-metadata',
      false,
    );
    if (parentTaskRef.namespace === 'shared') {
      await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    }
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
    return { metadata, checkpoint, aggregate, taskHeadFence, operation };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // Once a parent write intent is durable, it must remain repairable.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

function assertChildResultMergeEligible(
  context: OpenedV3TaskOperation,
  child: StoredTaskSnapshot,
  childPendingOperationCount: number,
  expectedChildRevision: number,
): void {
  const parent = context.task.metadata;
  if (
    (parent.workflowMode !== 'man' && parent.workflowMode !== 'manteam') ||
    (parent.status !== 'in_progress' && parent.status !== 'blocked') ||
    parent.currentStep !== 6 ||
    parent.ownerActorId !== context.session.actorId
  ) {
    throw new Error('MANCODE_CHILD_RESULT_PARENT_NOT_ELIGIBLE');
  }
  if (
    child.aggregate === null ||
    child.metadata.workflowMode !== 'manba' ||
    child.metadata.status !== 'completed' ||
    child.metadata.outcome === null ||
    child.metadata.transitionState !== 'stable' ||
    child.metadata.revision !== expectedChildRevision ||
    childPendingOperationCount > 0
  ) {
    throw new Error('MANCODE_CHILD_RESULT_NOT_READY');
  }
  try {
    assertParentWorkflowRelation(child.metadata, parent);
  } catch {
    throw new Error('MANCODE_CHILD_RESULT_PARENT_MISMATCH');
  }
  const snapshot = child.metadata.parent;
  if (snapshot === null || !sameTaskRef(snapshot.taskRef, parent.taskRef)) {
    throw new Error('MANCODE_CHILD_RESULT_PARENT_MISMATCH');
  }
  const stale =
    snapshot.revisionAtCreate !== parent.revision ||
    snapshot.planVersionAtCreate !== parent.governance.planVersion ||
    snapshot.requirementsDigestAtCreate !==
      parent.governance.requirementsDigest ||
    snapshot.implementationScopeDigestAtCreate !==
      parent.implementationScope.digest ||
    snapshot.visibility !== parent.visibility ||
    snapshot.coordination !== parent.coordination;
  if (stale) throw new Error('MANCODE_PARENT_STALE');
}

function assertChildSharedFence(
  context: OpenedV3TaskOperation,
  child: StoredTaskSnapshot,
  fence: TaskHeadFenceV1 | null,
): void {
  if (child.metadata.taskRef.namespace !== 'shared') return;
  if (child.aggregate === null || fence === null || context.codeHead === null) {
    throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
  }
  assertTaskHeadFenceMatchesAggregate(fence, child.aggregate, context.codeHead);
}

function markParentOperationPending(
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

function buildChildMergeCheckpoint(input: {
  context: OpenedV3TaskOperation;
  child: StoredTaskSnapshot;
  pendingMetadata: WorkflowMetadataV3;
  checkpointId: Ulid;
  summary: string;
  nextAction: string;
  branch: string | null;
  codeHead: string | null;
  timestamp: string;
}): CheckpointV1 {
  const outcome = input.child.metadata.outcome;
  if (outcome === null) throw new Error('MANCODE_CHILD_RESULT_NOT_READY');
  const childRef = `${input.child.metadata.taskRef.namespace}:${input.child.metadata.taskRef.taskId}`;
  const summary = `Merged completed child ${childRef} (${outcome}): ${input.summary}`;
  const nextAction =
    outcome === 'manual_test_required'
      ? `Resolve required manual testing for ${childRef}. ${input.nextAction}`
      : input.nextAction;
  // The checkpoint parser applies the same content safety rules regardless
  // of namespace. Running the checks here produces a stable command error
  // before a journal is created.
  assertSharedTextSafe(summary, 'child merge checkpoint summary');
  assertSharedTextSafe(nextAction, 'child merge checkpoint nextAction');
  return parseCheckpoint({
    schemaVersion: 1,
    checkpointId: input.checkpointId,
    operationId: input.context.operationId,
    taskRef: input.context.taskRef,
    taskRevision: input.pendingMetadata.revision,
    ownershipEpochAtOffer: input.pendingMetadata.ownershipEpoch,
    kind:
      outcome === 'manual_test_required' ? 'blocked' : 'verification_completed',
    git: {
      branch: input.branch,
      head: input.codeHead,
      base: input.pendingMetadata.base?.head ?? null,
    },
    summary,
    governance: {
      requirementsDigest: input.context.task.requirements.contentDigest,
      planVersion: input.pendingMetadata.governance.planVersion,
      reviewLedgerDigest: input.context.task.review.contentDigest,
      verificationLedgerDigest: input.context.task.verification.contentDigest,
    },
    nextAction,
    createdBy: {
      actorId: input.context.session.actorId,
      client: input.context.session.client,
    },
    createdAt: input.timestamp,
  });
}

function completeParentMergeMetadata(
  previous: WorkflowMetadataV3,
  child: WorkflowMetadataV3,
  checkpoint: CheckpointV1,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const needsManualTesting = child.outcome === 'manual_test_required';
  const childRef = `${child.taskRef.namespace}:${child.taskRef.taskId}`;
  const next = parseWorkflowMetadata({
    ...previous,
    ...(needsManualTesting
      ? {
          status: 'blocked',
          blockingReason: `Child ${childRef} requires manual testing.`,
        }
      : {}),
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    latestCheckpointRef: {
      taskRef: previous.taskRef,
      kind: 'checkpoint',
      artifactId: checkpoint.checkpointId,
    },
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function childMergeExpectedRevisions(
  context: OpenedV3TaskOperation,
  child: StoredTaskSnapshot,
  childFence: TaskHeadFenceV1 | null,
  checkpointId: Ulid,
): Record<string, number> {
  const expected: Record<string, number> = {
    [taskEntityKey(context.taskRef)]: context.task.metadata.revision,
    [taskEntityKey(child.metadata.taskRef)]: child.metadata.revision,
    [`checkpoint:${checkpointId}`]: 0,
  };
  if (context.taskRef.namespace === 'shared') {
    const parentFence = context.coordination.taskHeadFence;
    if (parentFence === null || childFence === null) {
      throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
    }
    expected[taskHeadEntityKey(context.taskRef)] = parentFence.fenceRevision;
    expected[taskHeadEntityKey(child.metadata.taskRef)] =
      childFence.fenceRevision;
  }
  return expected;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(
      `MANCODE_${label.toUpperCase().replaceAll(' ', '_')}_REQUIRED`,
    );
  }
  return value;
}

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

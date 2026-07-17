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
import type { Ulid } from './ids.js';
import {
  assertTaskCodeHeadUnchanged,
  nextTaskHeadFence,
  taskMutationExpectedRevisions,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import {
  type VerificationLedgerV1,
  assertVerificationLedgerAgainstContext,
  assertVerificationLedgerRequirements,
  assertVerificationLedgerTransition,
  parseVerificationLedger,
  verificationLedgerDigest,
} from './verification-ledger.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface RecordV3VerificationInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  /** A complete verification ledger bound to the current requirements/plan. */
  verification: unknown;
  operationId?: Ulid;
  now?: Date;
}

export interface RecordedV3Verification {
  metadata: WorkflowMetadataV3;
  verification: VerificationLedgerV1;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/** Records a complete current verification ledger and refreshes metadata cache. */
export async function recordV3Verification(
  input: RecordV3VerificationInput,
): Promise<RecordedV3Verification> {
  const taskRef = parseTaskRefValue(input.taskRef);
  const submitted = parseVerificationLedger(input.verification);
  if (!sameTaskRef(submitted.taskRef, taskRef)) {
    throw new Error('MANCODE_VERIFICATION_TASK_REF_MISMATCH');
  }
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId: input.operationId,
    extraEntityLocks:
      taskRef.namespace === 'shared' ? [taskHeadEntityKey(taskRef)] : [],
    now: input.now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertVerificationEligible(
      context.task.metadata,
      context.task.plan !== null,
    );
    const timestamp = context.now.toISOString();
    const verification = createCurrentVerification(
      context.task.verification,
      submitted,
      context.task.metadata,
      context.task.review.remediationRound,
      context.task.requirements,
      context.operationId,
      timestamp,
    );
    const metadata = updateMetadata(
      context.task.metadata,
      verification,
      context.operationId,
      timestamp,
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: context.task.requirements,
      review: context.task.review,
      verification,
      planDigest: context.task.plan?.digest ?? null,
      latestCheckpoint: context.task.latestCheckpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);

    journal = await createTaskOperationJournal(context, {
      type: 'verification_record',
      action:
        taskRef.namespace === 'shared'
          ? 'shared_ledger_evidence'
          : 'local_workflow_mutation',
      evidence:
        taskRef.namespace === 'shared'
          ? {
              assignedToActor:
                context.task.metadata.ownerActorId === context.session.actorId,
              restrictsWriteToAssignedItem: true,
            }
          : null,
      expectedRevisions: taskMutationExpectedRevisions(context, [
        'verification',
      ]),
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'write-verification-ledger',
            taskRef,
            fileName: 'verification-ledger.json',
            beforeContent: serializeTaskAuthority(context.task.verification),
            targetContent: serializeTaskAuthority(verification),
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'update-metadata',
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
      'write-verification-ledger',
      false,
    );
    await writeTaskAuthorityFile(
      context,
      'verification-ledger.json',
      serializeTaskAuthority(verification),
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-metadata',
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
    return { metadata, verification, aggregate, taskHeadFence, operation };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A durable journal is already enough to block ordinary writes.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

function assertVerificationEligible(
  metadata: WorkflowMetadataV3,
  hasPlan: boolean,
): void {
  if (metadata.status !== 'in_progress' && metadata.status !== 'blocked') {
    throw new Error('MANCODE_VERIFICATION_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.workflowMode === 'manba') return;
  if (
    metadata.governance.planDecision !== 'governed_execution' ||
    metadata.currentStep < 5 ||
    !hasPlan
  ) {
    throw new Error('MANCODE_VERIFICATION_PLAN_GATE_REQUIRED');
  }
}

function createCurrentVerification(
  previous: VerificationLedgerV1,
  submitted: VerificationLedgerV1,
  metadata: WorkflowMetadataV3,
  remediationRound: number,
  requirements: Parameters<typeof assertVerificationLedgerRequirements>[1],
  operationId: Ulid,
  updatedAt: string,
): VerificationLedgerV1 {
  if (
    submitted.requirementsDigest !== metadata.governance.requirementsDigest ||
    submitted.planVersion !== metadata.governance.planVersion ||
    submitted.remediationRound !== remediationRound
  ) {
    throw new Error('MANCODE_VERIFICATION_CONTEXT_STALE');
  }
  const draft: VerificationLedgerV1 = {
    ...submitted,
    taskRef: previous.taskRef,
    revision: previous.revision + 1,
    contentDigest: '',
    lastOperationId: operationId,
    updatedAt,
  };
  const next = parseVerificationLedger(
    {
      ...draft,
      contentDigest: verificationLedgerDigest(draft),
    },
    requirements,
  );
  assertVerificationLedgerTransition(previous, next);
  assertVerificationLedgerRequirements(next, requirements);
  assertVerificationLedgerAgainstContext(next, {
    requirementsDigest: metadata.governance.requirementsDigest,
    planVersion: metadata.governance.planVersion,
    remediationRound,
  });
  return next;
}

function updateMetadata(
  previous: WorkflowMetadataV3,
  verification: VerificationLedgerV1,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    governance: {
      ...previous.governance,
      verificationStatus: verification.status,
      verificationLedgerDigest: verification.contentDigest,
    },
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

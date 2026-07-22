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
  type RequirementsLedgerV1,
  assertRequirementsLedgerTransition,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from './requirements-ledger.js';
import type { ReviewLedgerV1 } from './review-ledger.js';
import {
  assertTaskCodeHeadUnchanged,
  markTaskReviewStale,
  markTaskVerificationStale,
  nextTaskHeadFence,
  taskMutationExpectedRevisions,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import type { VerificationLedgerV1 } from './verification-ledger.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface FinalizeV3RequirementsInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  /** A complete V3 requirements record; control fields are rebuilt at commit. */
  requirements: unknown;
  operationId?: Ulid;
  now?: Date;
}

export type SaveV3RequirementsDraftInput = FinalizeV3RequirementsInput;

export interface FinalizedV3Requirements {
  metadata: WorkflowMetadataV3;
  requirements: RequirementsLedgerV1;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/**
 * Finalizes a replacement requirements ledger under one task journal. Review
 * and verification intentionally retain their old context references, making
 * their explicit stale state provable instead of accidentally reviving old
 * evidence against the new requirements digest.
 */
export async function finalizeV3Requirements(
  input: FinalizeV3RequirementsInput,
): Promise<FinalizedV3Requirements> {
  return writeV3Requirements(input, 'finalize');
}

/**
 * Persists an incomplete clarification ledger without claiming that its scope
 * or coverage is confirmed. A later session can resume the TaskRef and read the
 * open questions from the normal plan Context Pack.
 */
export async function saveV3RequirementsDraft(
  input: SaveV3RequirementsDraftInput,
): Promise<FinalizedV3Requirements> {
  return writeV3Requirements(input, 'draft');
}

async function writeV3Requirements(
  input: FinalizeV3RequirementsInput,
  action: 'draft' | 'finalize',
): Promise<FinalizedV3Requirements> {
  const taskRef = parseTaskRefValue(input.taskRef);
  const submitted = parseRequirementsLedger(input.requirements);
  if (!sameTaskRef(submitted.taskRef, taskRef)) {
    throw new Error('MANCODE_REQUIREMENTS_TASK_REF_MISMATCH');
  }
  if (action === 'finalize' && submitted.status !== 'confirmed') {
    throw new Error('MANCODE_REQUIREMENTS_CONFIRMATION_REQUIRED');
  }
  if (action === 'draft' && submitted.status !== 'draft') {
    throw new Error('MANCODE_REQUIREMENTS_DRAFT_REQUIRED');
  }
  if (
    action === 'draft' &&
    !submitted.blockingUnknowns.some((unknown) => unknown.status === 'open')
  ) {
    throw new Error('MANCODE_REQUIREMENTS_DRAFT_BLOCKER_REQUIRED');
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
    assertRequirementsFinalizeEligible(context.task.metadata);
    const timestamp = context.now.toISOString();
    const requirements = createReplacementRequirements(
      context.task.requirements,
      submitted,
      context.operationId,
      timestamp,
      action === 'draft' ? 'draft' : 'confirmed',
    );
    const review = markTaskReviewStale(
      context.task.review,
      context.operationId,
      timestamp,
    );
    const verification = markTaskVerificationStale(
      context.task.verification,
      context.operationId,
      timestamp,
    );
    const metadata = updateMetadata(
      context.task.metadata,
      requirements,
      review,
      verification,
      context.operationId,
      timestamp,
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements,
      review,
      verification,
      planDigest: context.task.plan?.digest ?? null,
      latestCheckpoint: context.task.latestCheckpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);

    journal = await createTaskOperationJournal(context, {
      type: action === 'draft' ? 'requirements_draft' : 'requirements_finalize',
      action:
        taskRef.namespace === 'shared'
          ? 'shared_metadata_plan_mutation'
          : 'local_workflow_mutation',
      expectedRevisions: taskMutationExpectedRevisions(context, [
        'requirements',
        'review',
        'verification',
      ]),
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'write-requirements',
            taskRef,
            fileName: 'requirements.json',
            beforeContent: serializeTaskAuthority(context.task.requirements),
            targetContent: serializeTaskAuthority(requirements),
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-review-verification-stale',
            taskRef,
            fileName: 'review-ledger.json',
            beforeContent: serializeTaskAuthority(context.task.review),
            targetContent: serializeTaskAuthority(review),
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-review-verification-stale',
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
      'write-requirements',
      false,
    );
    await writeTaskAuthorityFile(
      context,
      'requirements.json',
      serializeTaskAuthority(requirements),
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'mark-review-verification-stale',
      false,
    );
    await writeTaskAuthorityFile(
      context,
      'review-ledger.json',
      serializeTaskAuthority(review),
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
    return {
      metadata,
      requirements,
      review,
      verification,
      aggregate,
      taskHeadFence,
      operation,
    };
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

function assertRequirementsFinalizeEligible(
  metadata: WorkflowMetadataV3,
): void {
  if (metadata.status !== 'in_progress') {
    throw new Error('MANCODE_REQUIREMENTS_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.currentStep > 2) {
    throw new Error('MANCODE_REQUIREMENTS_REVISION_AFTER_PLANNING');
  }
}

function createReplacementRequirements(
  previous: RequirementsLedgerV1,
  submitted: RequirementsLedgerV1,
  operationId: Ulid,
  updatedAt: string,
  status: 'draft' | 'confirmed',
): RequirementsLedgerV1 {
  const draft: RequirementsLedgerV1 = {
    ...submitted,
    taskRef: previous.taskRef,
    revision: previous.revision + 1,
    status,
    contentDigest: '',
    lastOperationId: operationId,
    updatedAt,
  };
  const next = parseRequirementsLedger({
    ...draft,
    contentDigest: requirementsLedgerDigest(draft),
  });
  assertRequirementsLedgerTransition(previous, next);
  return next;
}

function updateMetadata(
  previous: WorkflowMetadataV3,
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
  verification: VerificationLedgerV1,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    currentStep: Math.max(previous.currentStep, 2),
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    governance: {
      ...previous.governance,
      requirementsStatus:
        requirements.status === 'confirmed' ? 'ready' : 'needs_clarification',
      requirementsDigest: requirements.contentDigest,
      reviewStatus: review.status,
      reviewLedgerDigest: review.contentDigest,
      verificationStatus: verification.status,
      verificationLedgerDigest: verification.contentDigest,
    },
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

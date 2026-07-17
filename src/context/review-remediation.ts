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
  type ReviewLedgerV1,
  assertReviewLedgerAgainstContext,
  assertReviewLedgerTransition,
  parseReviewLedger,
  reviewLedgerDigest,
} from './review-ledger.js';
import {
  assertTaskCodeHeadUnchanged,
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

export interface ApplyV3ReviewLedgerInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  /** A complete review ledger evaluated against the current requirements/plan. */
  review: unknown;
  operationId?: Ulid;
  now?: Date;
}

export interface AppliedV3ReviewLedger {
  metadata: WorkflowMetadataV3;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/**
 * Applies a current review result and invalidates all prior verification
 * evidence. Review input is a complete ledger so the persisted digest covers
 * the exact domains, blockers, reports, skips, and remediation round audited.
 */
export async function applyV3ReviewLedger(
  input: ApplyV3ReviewLedgerInput,
): Promise<AppliedV3ReviewLedger> {
  const taskRef = parseTaskRefValue(input.taskRef);
  const submitted = parseReviewLedger(input.review);
  if (!sameTaskRef(submitted.taskRef, taskRef)) {
    throw new Error('MANCODE_REVIEW_TASK_REF_MISMATCH');
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
    assertReviewEligible(context.task.metadata, context.task.plan !== null);
    const timestamp = context.now.toISOString();
    const review = createCurrentReview(
      context.task.review,
      submitted,
      context.task.metadata,
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
      review,
      verification,
      context.operationId,
      timestamp,
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: context.task.requirements,
      review,
      verification,
      planDigest: context.task.plan?.digest ?? null,
      latestCheckpoint: context.task.latestCheckpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);
    const authorization = reviewAuthorization(context, review);

    journal = await createTaskOperationJournal(context, {
      type: 'review_remediation',
      action: authorization.action,
      evidence: authorization.evidence,
      conditions: authorization.conditions,
      expectedRevisions: taskMutationExpectedRevisions(context, [
        'review',
        'verification',
      ]),
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'write-review-ledger',
            taskRef,
            fileName: 'review-ledger.json',
            beforeContent: serializeTaskAuthority(context.task.review),
            targetContent: serializeTaskAuthority(review),
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-verification-stale',
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
      'write-review-ledger',
      false,
    );
    await writeTaskAuthorityFile(
      context,
      'review-ledger.json',
      serializeTaskAuthority(review),
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'mark-verification-stale',
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
    return {
      metadata,
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

function assertReviewEligible(
  metadata: WorkflowMetadataV3,
  hasPlan: boolean,
): void {
  if (metadata.workflowMode !== 'man' && metadata.workflowMode !== 'manteam') {
    throw new Error('MANCODE_REVIEW_WORKFLOW_MODE_INVALID');
  }
  if (metadata.status !== 'in_progress' && metadata.status !== 'blocked') {
    throw new Error('MANCODE_REVIEW_WORKFLOW_NOT_ACTIVE');
  }
  if (
    metadata.currentStep < 5 ||
    metadata.governance.planDecision !== 'governed_execution' ||
    !hasPlan
  ) {
    throw new Error('MANCODE_REVIEW_PLAN_GATE_REQUIRED');
  }
}

function createCurrentReview(
  previous: ReviewLedgerV1,
  submitted: ReviewLedgerV1,
  metadata: WorkflowMetadataV3,
  operationId: Ulid,
  updatedAt: string,
): ReviewLedgerV1 {
  if (
    submitted.requirementsDigest !== metadata.governance.requirementsDigest ||
    submitted.planVersion !== metadata.governance.planVersion
  ) {
    throw new Error('MANCODE_REVIEW_CONTEXT_STALE');
  }
  const draft: ReviewLedgerV1 = {
    ...submitted,
    taskRef: previous.taskRef,
    revision: previous.revision + 1,
    contentDigest: '',
    lastOperationId: operationId,
    updatedAt,
  };
  const next = parseReviewLedger({
    ...draft,
    contentDigest: reviewLedgerDigest(draft),
  });
  assertReviewLedgerTransition(previous, next);
  assertReviewLedgerAgainstContext(next, {
    requirementsDigest: metadata.governance.requirementsDigest,
    planVersion: metadata.governance.planVersion,
  });
  return next;
}

function updateMetadata(
  previous: WorkflowMetadataV3,
  review: ReviewLedgerV1,
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

function reviewAuthorization(
  context: Awaited<ReturnType<typeof openV3TaskOperation>>,
  next: ReviewLedgerV1,
): {
  action:
    | 'local_workflow_mutation'
    | 'shared_ledger_evidence'
    | 'review_skip_or_waiver';
  evidence?: {
    assignedToActor: boolean;
    restrictsWriteToAssignedItem: boolean;
  };
  conditions?: {
    reviewAction?: 'skip' | 'waiver';
    reviewSeverity?: 'p0' | 'p1' | 'p2' | 'legacy_unknown';
    reason?: string | null;
  };
} {
  if (context.taskRef.namespace === 'local') {
    return { action: 'local_workflow_mutation' };
  }
  if (next.skip !== null) {
    return {
      action: 'review_skip_or_waiver',
      conditions: { reviewAction: 'skip', reason: next.skip.reason },
    };
  }
  const waivers = next.blockers.filter(
    (blocker) => blocker.status === 'waived',
  );
  if (waivers.length > 0) {
    for (const blocker of waivers) {
      if (
        blocker.severity === 'p0' ||
        blocker.severity === 'legacy_unknown' ||
        blocker.waiver === null
      ) {
        throw new Error('MANCODE_WAIVER_FORBIDDEN');
      }
    }
    const first = waivers[0];
    if (first?.waiver === null || first === undefined) {
      throw new Error('MANCODE_WAIVER_FORBIDDEN');
    }
    return {
      action: 'review_skip_or_waiver',
      conditions: {
        reviewAction: 'waiver',
        reviewSeverity: first.severity,
        reason: first.waiver.reason,
      },
    };
  }
  return {
    action: 'shared_ledger_evidence',
    evidence: {
      assignedToActor:
        context.task.metadata.ownerActorId === context.session.actorId,
      restrictsWriteToAssignedItem: true,
    },
  };
}

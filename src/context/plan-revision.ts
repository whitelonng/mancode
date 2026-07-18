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
import { digestCanonicalJson } from './canonical.js';
import type { Ulid } from './ids.js';
import { assertManteamPlanContent } from './manteam-plan.js';
import { assertSharedTextSafe } from './privacy.js';
import {
  type RequirementsLedgerV1,
  requirementsAreReady,
} from './requirements-ledger.js';
import type { ReviewLedgerV1 } from './review-ledger.js';
import {
  assertTaskCodeHeadUnchanged,
  markTaskReviewStale,
  markTaskVerificationStale,
  nextTaskHeadFence,
  taskMutationExpectedRevisions,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import type { VerificationLedgerV1 } from './verification-ledger.js';
import {
  type PlanDecision,
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export type V3PlanDecision = Exclude<PlanDecision, 'solo_handoff' | null>;

export interface ReviseV3PlanInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  plan: string;
  /** Omitting the decision leaves the workflow at the step-four plan gate. */
  planDecision?: V3PlanDecision;
  operationId?: Ulid;
  now?: Date;
}

export interface RevisedV3Plan {
  metadata: WorkflowMetadataV3;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  planDigest: string;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/**
 * Writes a new plan version and makes every prior review and verification
 * result explicitly stale before the task becomes stable again.
 */
export async function reviseV3Plan(
  input: ReviseV3PlanInput,
): Promise<RevisedV3Plan> {
  const taskRef = parseTaskRefValue(input.taskRef);
  const plan = requirePlan(input.plan);
  const planDecision = parsePlanDecision(input.planDecision);
  if (taskRef.namespace === 'shared') {
    assertSharedTextSafe(plan, 'plan');
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
    assertPlanRevisionEligible(
      context.task.metadata,
      context.task.requirements,
    );
    if (
      context.task.metadata.workflowMode === 'manteam' &&
      planDecision === 'governed_execution'
    ) {
      assertManteamPlanContent(plan);
    }
    if (context.task.plan?.content === plan && planDecision === null) {
      throw new Error('MANCODE_PLAN_CONTENT_UNCHANGED');
    }
    const timestamp = context.now.toISOString();
    const planDigest = digestCanonicalJson({
      artifactRef: { taskRef, kind: 'plan' },
      content: plan,
    });
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
      context.task.requirements,
      review,
      verification,
      planDecision,
      context.operationId,
      timestamp,
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: context.task.requirements,
      review,
      verification,
      planDigest,
      latestCheckpoint: context.task.latestCheckpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);

    journal = await createTaskOperationJournal(context, {
      type: 'plan_revision',
      action:
        taskRef.namespace === 'shared'
          ? 'shared_metadata_plan_mutation'
          : 'local_workflow_mutation',
      expectedRevisions: taskMutationExpectedRevisions(context, [
        'plan',
        'review',
        'verification',
      ]),
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'write-plan',
            taskRef,
            fileName: 'plan.md',
            beforeContent: context.task.plan?.content ?? null,
            targetContent: plan,
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'update-metadata',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
            targetContent: serializeTaskAuthority(metadata),
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

    journal = await advanceTaskOperation(context, journal, 'write-plan', false);
    await writeTaskAuthorityFile(context, 'plan.md', plan);

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-metadata',
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
      'mark-review-verification-stale',
      false,
    );
    await writeTaskAuthorityFile(
      context,
      'review-ledger.json',
      `${JSON.stringify(review, null, 2)}\n`,
    );
    await writeTaskAuthorityFile(
      context,
      'verification-ledger.json',
      `${JSON.stringify(verification, null, 2)}\n`,
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
      planDigest,
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

function requirePlan(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('MANCODE_PLAN_CONTENT_REQUIRED');
  }
  return value;
}

function parsePlanDecision(value: unknown): V3PlanDecision | null {
  if (value === undefined) return null;
  if (value !== 'plan_only' && value !== 'governed_execution') {
    throw new Error('MANCODE_PLAN_DECISION_INVALID');
  }
  return value;
}

function assertPlanRevisionEligible(
  metadata: WorkflowMetadataV3,
  requirements: RequirementsLedgerV1,
): void {
  if (metadata.workflowMode !== 'man' && metadata.workflowMode !== 'manteam') {
    throw new Error('MANCODE_PLAN_WORKFLOW_MODE_INVALID');
  }
  if (metadata.status !== 'in_progress') {
    throw new Error('MANCODE_PLAN_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.currentStep < 2 || metadata.currentStep > 4) {
    throw new Error('MANCODE_PLAN_STEP_INVALID');
  }
  if (
    metadata.governance.planDecision !== null ||
    metadata.governance.requirementsStatus !== 'ready' ||
    metadata.governance.requirementsDigest !== requirements.contentDigest ||
    requirements.status !== 'confirmed' ||
    !requirementsAreReady(requirements)
  ) {
    throw new Error('MANCODE_PLAN_REQUIREMENTS_OR_DECISION_INVALID');
  }
}

function updateMetadata(
  previous: WorkflowMetadataV3,
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
  verification: VerificationLedgerV1,
  planDecision: V3PlanDecision | null,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const status = planDecision === 'plan_only' ? 'planned' : 'in_progress';
  const currentStep = planDecision === 'governed_execution' ? 5 : 4;
  const next = parseWorkflowMetadata({
    ...previous,
    status,
    currentStep,
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    governance: {
      ...previous.governance,
      requirementsStatus: 'ready',
      requirementsDigest: requirements.contentDigest,
      planVersion: previous.governance.planVersion + 1,
      planDecision,
      reviewStatus: 'stale',
      reviewLedgerDigest: review.contentDigest,
      verificationStatus: 'stale',
      verificationLedgerDigest: verification.contentDigest,
    },
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

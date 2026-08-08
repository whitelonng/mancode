import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import {
  createTaskAuthorityFileRecoveryAction,
  createTaskHeadFenceRecoveryAction,
} from '../runtime/operation-recovery-payload.js';
import {
  enqueueSessionPointerProjection,
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
  assertRequirementsScopeConsistent,
  requirementsAreReady,
} from './requirements-ledger.js';
import type { ReviewLedgerV1 } from './review-ledger.js';
import { normalizeImplementationScope } from './scope-change.js';
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
  assertExecutableImplementationScope,
  assertWorkflowMetadataTransition,
  implementationScopeIsExecutable,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export type V3PlanDecision = Exclude<PlanDecision, 'solo_handoff' | null>;

export interface ReviseV3PlanInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  plan: string;
  /** User-visible file/module boundary confirmed with this plan revision. */
  implementationScope?: unknown;
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
 * Writes one plan authority version when content or execution scope changes,
 * or records a plan decision against unchanged authority.
 */
export async function reviseV3Plan(
  input: ReviseV3PlanInput,
): Promise<RevisedV3Plan> {
  const taskRef = parseTaskRefValue(input.taskRef);
  const plan = requirePlan(input.plan);
  const planDecision = parsePlanDecision(input.planDecision);
  const submittedScope =
    input.implementationScope === undefined
      ? null
      : normalizeImplementationScope(input.implementationScope);
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
    const planChanged = context.task.plan?.content !== plan;
    const executionScopeBinding = assertExecutionScopeBindingAttempt({
      metadata: context.task.metadata,
      currentPlan: context.task.plan?.content ?? null,
      submittedPlan: plan,
      submittedScope,
      planDecisionSupplied: input.planDecision !== undefined,
      sessionActorId: context.session.actorId,
    });
    assertPlanRevisionEligible(
      context.task.metadata,
      context.task.requirements,
      executionScopeBinding,
    );
    const implementationScope =
      submittedScope ?? context.task.metadata.implementationScope;
    const scopeChanged =
      submittedScope !== null &&
      submittedScope.digest !==
        context.task.metadata.implementationScope.digest;
    if (planDecision === 'governed_execution') {
      assertExecutableImplementationScope(implementationScope);
    }
    if (executionScopeBinding) {
      assertExecutableImplementationScope(implementationScope);
    }
    if (
      context.task.metadata.workflowMode === 'manteam' &&
      planDecision === 'governed_execution'
    ) {
      assertManteamPlanContent(plan);
    }
    if (
      context.task.plan?.content === plan &&
      planDecision === null &&
      !scopeChanged
    ) {
      throw new Error('MANCODE_PLAN_CONTENT_UNCHANGED');
    }
    const authorityChanged = planChanged || scopeChanged;
    const timestamp = context.now.toISOString();
    const planDigest = planChanged
      ? digestCanonicalJson({
          artifactRef: { taskRef, kind: 'plan' },
          content: plan,
        })
      : context.task.plan?.digest;
    if (planDigest === undefined) {
      throw new Error('MANCODE_PLAN_FILE_REQUIRED');
    }
    const review = authorityChanged
      ? markTaskReviewStale(context.task.review, context.operationId, timestamp)
      : context.task.review;
    const verification = authorityChanged
      ? markTaskVerificationStale(
          context.task.verification,
          context.operationId,
          timestamp,
        )
      : context.task.verification;
    const metadata = updateMetadata(
      context.task.metadata,
      context.task.requirements,
      review,
      verification,
      implementationScope,
      authorityChanged,
      planDecision,
      executionScopeBinding,
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

    if (planDecision === 'plan_only') {
      await enqueueSessionPointerProjection(context.projectRoot, {
        operationId: context.operationId,
        action: 'clear',
        sessionId: context.session.sessionId,
        expectedPreviousTaskRef: context.session.activeTaskRef,
        taskRef,
        workflowMode: metadata.workflowMode,
        taskRevision: metadata.revision,
        now: context.now,
      });
    }

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
          ...(planChanged
            ? [
                createTaskAuthorityFileRecoveryAction({
                  stepId: 'write-plan',
                  taskRef,
                  fileName: 'plan.md',
                  beforeContent: context.task.plan?.content ?? null,
                  targetContent: plan,
                }),
              ]
            : []),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'update-metadata',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
            targetContent: serializeTaskAuthority(metadata),
          }),
          ...(authorityChanged
            ? [
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
                  beforeContent: serializeTaskAuthority(
                    context.task.verification,
                  ),
                  targetContent: serializeTaskAuthority(verification),
                }),
              ]
            : []),
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
          ...(planChanged ? [] : ['write-plan']),
          ...(authorityChanged ? [] : ['mark-review-verification-stale']),
          ...(taskHeadFence === null ? ['update-task-head-fence'] : []),
        ],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);

    journal = await advanceTaskOperation(context, journal, 'write-plan', false);
    if (planChanged) {
      await writeTaskAuthorityFile(context, 'plan.md', plan);
    }

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
    if (authorityChanged) {
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
    }

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
    if (planDecision === 'plan_only') {
      try {
        await reconcileProjectionIntents(
          context.projectRoot,
          context.operationId,
          context.now,
        );
      } catch {
        // Planned authority is committed; doctor can finish the projection.
      }
    }
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
  executionScopeBinding: boolean,
): void {
  if (executionScopeBinding) {
    assertReadyPlanRequirements(metadata, requirements);
    return;
  }
  if (metadata.workflowMode !== 'man' && metadata.workflowMode !== 'manteam') {
    throw new Error('MANCODE_PLAN_WORKFLOW_MODE_INVALID');
  }
  if (metadata.status !== 'in_progress') {
    throw new Error('MANCODE_PLAN_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.currentStep < 2 || metadata.currentStep > 4) {
    throw new Error('MANCODE_PLAN_STEP_INVALID');
  }
  if (metadata.governance.planDecision !== null) {
    throw new Error('MANCODE_PLAN_REQUIREMENTS_OR_DECISION_INVALID');
  }
  assertReadyPlanRequirements(metadata, requirements);
}

function assertReadyPlanRequirements(
  metadata: WorkflowMetadataV3,
  requirements: RequirementsLedgerV1,
): void {
  if (
    metadata.governance.requirementsStatus !== 'ready' ||
    metadata.governance.requirementsDigest !== requirements.contentDigest ||
    requirements.status !== 'confirmed' ||
    !requirementsAreReady(requirements)
  ) {
    throw new Error('MANCODE_PLAN_REQUIREMENTS_OR_DECISION_INVALID');
  }
  assertRequirementsScopeConsistent(requirements);
}

function assertExecutionScopeBindingAttempt(input: {
  metadata: WorkflowMetadataV3;
  currentPlan: string | null;
  submittedPlan: string;
  submittedScope: WorkflowMetadataV3['implementationScope'] | null;
  planDecisionSupplied: boolean;
  sessionActorId: Ulid | null;
}): boolean {
  const decision = input.metadata.governance.planDecision;
  if (decision !== 'governed_execution' && decision !== 'solo_handoff') {
    return false;
  }
  if (
    input.metadata.workflowMode !== 'man' ||
    input.metadata.coordination !== 'single' ||
    input.metadata.taskRef.namespace !== 'local'
  ) {
    throw new Error('MANCODE_EXECUTION_SCOPE_BINDING_LOCAL_MAN_ONLY');
  }
  const activeExecution =
    (decision === 'governed_execution' &&
      input.metadata.status === 'in_progress' &&
      input.metadata.currentStep >= 5) ||
    (decision === 'solo_handoff' &&
      input.metadata.status === 'planned' &&
      input.metadata.currentStep === 4 &&
      input.metadata.soloExecution?.state === 'active');
  if (!activeExecution) {
    throw new Error('MANCODE_EXECUTION_SCOPE_BINDING_NOT_ACTIVE');
  }
  if (input.metadata.ownerActorId !== input.sessionActorId) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
  if (implementationScopeIsExecutable(input.metadata.implementationScope)) {
    throw new Error('MANCODE_EXECUTION_SCOPE_ALREADY_BOUND');
  }
  if (input.submittedScope === null) {
    throw new Error('MANCODE_IMPLEMENTATION_SCOPE_REQUIRED');
  }
  if (input.currentPlan === null || input.currentPlan !== input.submittedPlan) {
    throw new Error('MANCODE_EXECUTION_SCOPE_BINDING_PLAN_CHANGED');
  }
  if (input.planDecisionSupplied) {
    throw new Error('MANCODE_EXECUTION_SCOPE_BINDING_DECISION_INVALID');
  }
  assertExecutableImplementationScope(input.submittedScope);
  return true;
}

function updateMetadata(
  previous: WorkflowMetadataV3,
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
  verification: VerificationLedgerV1,
  implementationScope: WorkflowMetadataV3['implementationScope'],
  authorityChanged: boolean,
  planDecision: V3PlanDecision | null,
  executionScopeBinding: boolean,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const status = executionScopeBinding
    ? previous.status
    : planDecision === 'plan_only'
      ? 'planned'
      : 'in_progress';
  const currentStep = executionScopeBinding
    ? previous.currentStep
    : planDecision === 'governed_execution'
      ? 5
      : 4;
  const nextPlanVersion =
    previous.governance.planVersion + (authorityChanged ? 1 : 0);
  const next = parseWorkflowMetadata({
    ...previous,
    status,
    currentStep,
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    implementationScope,
    governance: {
      ...previous.governance,
      requirementsStatus: 'ready',
      requirementsDigest: requirements.contentDigest,
      planVersion: nextPlanVersion,
      planDecision: executionScopeBinding
        ? previous.governance.planDecision
        : planDecision,
      reviewStatus: authorityChanged
        ? 'stale'
        : previous.governance.reviewStatus,
      reviewLedgerDigest: review.contentDigest,
      verificationStatus: authorityChanged
        ? 'stale'
        : previous.governance.verificationStatus,
      verificationLedgerDigest: verification.contentDigest,
    },
    soloExecution:
      executionScopeBinding && previous.soloExecution !== null
        ? { ...previous.soloExecution, planVersion: nextPlanVersion }
        : previous.soloExecution,
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

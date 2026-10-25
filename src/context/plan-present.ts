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
import { isManDelivery, readBoundManPlan } from './man-delivery-runtime.js';
import {
  PLAN_PRESENT_INSTRUCTION,
  type PlanPresentationSummary,
  assertPlanGatePolicy,
  buildPlanPresentationSummary,
  planGateTupleOf,
  planPresentationConsumed,
  planPresentationMatches,
} from './plan-gate.js';
import { requirementsAreReady } from './requirements-ledger.js';
import {
  assertTaskCodeHeadUnchanged,
  nextTaskHeadFence,
  taskMutationExpectedRevisions,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import {
  type PlanPresentationRecord,
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface PresentV3PlanInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  operationId?: Ulid;
  now?: Date;
}

export interface PresentedV3Plan {
  metadata: WorkflowMetadataV3;
  presentation: PlanPresentationRecord;
  summary: PlanPresentationSummary;
  instruction: string;
  /** True when the unchanged tuple was already presented; nothing was written. */
  idempotent: boolean;
  aggregate: TaskAggregateManifestV1 | null;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1 | null;
}

/**
 * Records that the current plan, scope and requirements were put in front of
 * the operator. A later revise, scope or requirements change invalidates it.
 * Repeating it for an unchanged tuple returns the existing record and does not
 * advance the task revision.
 */
export async function presentV3Plan(
  input: PresentV3PlanInput,
): Promise<PresentedV3Plan> {
  const taskRef = parseTaskRefValue(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'plan present operationId');
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
    const { metadata: previous } = context.task;
    assertPlanGatePolicy(previous);
    const planDigest = assertPlanPresentEligible(context);
    // A drifted bound plan document must fail before anything is written.
    if (isManDelivery(previous)) {
      await readBoundManPlan(input.projectRoot, context.task);
    }
    const summary = buildPlanPresentationSummary(context.task);
    const existing = previous.governance.planPresentation;
    if (
      existing !== undefined &&
      planPresentationMatches(existing, previous, planDigest) &&
      !planPresentationConsumed(previous, existing)
    ) {
      return {
        metadata: previous,
        presentation: existing,
        summary,
        instruction: PLAN_PRESENT_INSTRUCTION,
        idempotent: true,
        aggregate: null,
        taskHeadFence: null,
        operation: null,
      };
    }
    const tuple = planGateTupleOf(previous, planDigest);
    const timestamp = context.now.toISOString();
    const presentation: PlanPresentationRecord = {
      ...tuple,
      presentedAt: timestamp,
      actorId: context.session.actorId,
      sessionId: context.session.sessionId,
      operationId: context.operationId,
    };
    const metadata = parseWorkflowMetadata({
      ...previous,
      revision: previous.revision + 1,
      transitionState: 'stable',
      lastOperationId: context.operationId,
      governance: { ...previous.governance, planPresentation: presentation },
      updatedAt: timestamp,
    });
    assertWorkflowMetadataTransition(previous, metadata, 'ordinary');
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements: context.task.requirements,
      review: context.task.review,
      verification: context.task.verification,
      planDigest,
      latestCheckpoint: context.task.latestCheckpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);
    journal = await createTaskOperationJournal(context, {
      type: 'plan_present',
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
            beforeContent: serializeTaskAuthority(previous),
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
    return {
      metadata,
      presentation,
      summary,
      instruction: PLAN_PRESENT_INSTRUCTION,
      idempotent: false,
      aggregate,
      taskHeadFence,
      operation,
    };
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

/** Returns the digest of the bound plan once the task is eligible. */
function assertPlanPresentEligible(
  context: Awaited<ReturnType<typeof openV3TaskOperation>>,
): string {
  const { metadata, requirements, plan } = context.task;
  // Owner first, so an existing identical presentation never lets a non-owner in.
  if (metadata.ownerActorId !== context.session.actorId) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
  const decision = metadata.governance.planDecision;
  const confirmationStage =
    decision === null &&
    metadata.status === 'in_progress' &&
    metadata.currentStep === 4;
  const resumptionStage =
    decision === 'plan_only' &&
    (metadata.status === 'planned' || metadata.status === 'in_progress') &&
    metadata.currentStep === 4 &&
    metadata.workflowMode === 'man' &&
    metadata.taskRef.namespace === 'local' &&
    metadata.coordination === 'single' &&
    metadata.soloExecution === null;
  if (
    (!confirmationStage && !resumptionStage) ||
    plan === null ||
    metadata.governance.requirementsStatus !== 'ready' ||
    metadata.governance.requirementsDigest !== requirements.contentDigest ||
    requirements.status !== 'confirmed' ||
    !requirementsAreReady(requirements)
  ) {
    throw new Error(
      'MANCODE_PLAN_PRESENT_NOT_ELIGIBLE: present applies to a ready task with a bound plan at the undecided Step 4 plan gate, or to a plan_only plan before an explicit execution decision',
    );
  }
  return plan.digest;
}

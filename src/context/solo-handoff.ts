import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import { createTaskAuthorityFileRecoveryAction } from '../runtime/operation-recovery-payload.js';
import {
  completeProjectionIntent,
  enqueueSessionPointerProjection,
} from '../runtime/projection-outbox.js';
import { clearSessionTaskPointer, resumeSession } from '../runtime/session.js';
import {
  advanceTaskOperation,
  commitTaskOperation,
  createTaskOperationJournal,
  handleTaskOperationFailure,
  openV3TaskOperation,
  serializeTaskAuthority,
  taskEntityKey,
  writeTaskAuthorityFile,
} from '../runtime/task-operation.js';
import {
  type TaskAggregateManifestV1,
  assertTaskCompletionGate,
  buildTaskAggregateManifest,
} from './aggregate.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { requirementsAreReady } from './requirements-ledger.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface StartV3SoloHandoffInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  operationId?: Ulid;
  now?: Date;
}

export interface CompleteV3SoloHandoffInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  operationId?: Ulid;
  now?: Date;
}

export interface V3SoloHandoffResult {
  metadata: WorkflowMetadataV3;
  aggregate: TaskAggregateManifestV1;
  operation: OperationJournalV1;
  /** False means authority committed; only the local convenience projection failed. */
  sessionPointerUpdated: boolean;
}

/**
 * Makes a local single-owner man plan an explicitly assigned solo execution.
 * The workflow assignment is durable authority; the session pointer is only a
 * compensable local projection and never controls completion eligibility.
 */
export async function startV3SoloHandoff(
  input: StartV3SoloHandoffInput,
): Promise<V3SoloHandoffResult> {
  const taskRef = assertLocalTaskRef(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'solo handoff operationId');
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertSoloStartEligible(context);
    const timestamp = context.now.toISOString();
    const metadata = activeSoloMetadata(
      context.task.metadata,
      context.session.sessionId,
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
    const projection = await enqueueSessionPointerProjection(
      context.projectRoot,
      {
        operationId: context.operationId,
        action: 'resume',
        sessionId: context.session.sessionId,
        expectedPreviousTaskRef: context.session.activeTaskRef,
        taskRef,
        workflowMode: metadata.workflowMode,
        taskRevision: metadata.revision,
        now: context.now,
      },
    );
    journal = await createSoloJournal(context, context.task.metadata, metadata);
    journal = await advanceTaskOperation(context, journal, 'validate', true);
    journal = await advanceTaskOperation(
      context,
      journal,
      'write-workflow-assignment',
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
      'update-session-pointer',
      false,
    );
    const operation = await commitTaskOperation(context, journal);
    const sessionPointerUpdated = await resumeSoloSessionPointer(
      context.projectRoot,
      context.session.sessionId,
      taskRef,
      metadata,
      context.now,
    );
    if (sessionPointerUpdated) {
      await completeProjectionAfterSuccess(
        context.projectRoot,
        projection,
        context.now,
      );
    }
    return { metadata, aggregate, operation, sessionPointerUpdated };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A durable assignment intent blocks ordinary mutation until repair.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

/**
 * Re-runs the ordinary completion gate, then terminally records that the
 * assigned solo session completed. It cannot bypass review or verification.
 */
export async function completeV3SoloHandoff(
  input: CompleteV3SoloHandoffInput,
): Promise<V3SoloHandoffResult> {
  const taskRef = assertLocalTaskRef(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'solo handoff operationId');
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertSoloCompletionEligible(context);
    const timestamp = context.now.toISOString();
    const completionGateMetadata = completedSoloAssignmentMetadata(
      context.task.metadata,
      timestamp,
    );
    const activeChildren = await context.store.listActiveChildTaskRefs(taskRef);
    assertTaskCompletionGate(
      {
        metadata: completionGateMetadata,
        requirements: context.task.requirements,
        review: context.task.review,
        verification: context.task.verification,
        planDigest: context.task.plan?.digest ?? null,
        latestCheckpoint: context.task.latestCheckpoint,
      },
      {
        activeChildTaskRefs: activeChildren,
        hasPendingRepairOperation: false,
        activeClaimCount: 0,
      },
    );
    const metadata = completedSoloMetadata(
      context.task.metadata,
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
    const projection = await enqueueSessionPointerProjection(
      context.projectRoot,
      {
        operationId: context.operationId,
        action: 'clear',
        sessionId: context.session.sessionId,
        expectedPreviousTaskRef: context.session.activeTaskRef,
        taskRef,
        workflowMode: metadata.workflowMode,
        taskRevision: metadata.revision,
        now: context.now,
      },
    );
    journal = await createSoloJournal(context, context.task.metadata, metadata);
    journal = await advanceTaskOperation(context, journal, 'validate', true);
    journal = await advanceTaskOperation(
      context,
      journal,
      'write-workflow-assignment',
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
      'update-session-pointer',
      false,
    );
    const operation = await commitTaskOperation(context, journal);
    const sessionPointerUpdated = await clearSoloSessionPointer(
      context.projectRoot,
      context.session.sessionId,
      taskRef,
      context.now,
    );
    if (sessionPointerUpdated) {
      await completeProjectionAfterSuccess(
        context.projectRoot,
        projection,
        context.now,
      );
    }
    return { metadata, aggregate, operation, sessionPointerUpdated };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A durable completion intent blocks ordinary mutation until repair.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

async function completeProjectionAfterSuccess(
  projectRoot: string,
  projection: Awaited<ReturnType<typeof enqueueSessionPointerProjection>>,
  now: Date,
): Promise<void> {
  try {
    await completeProjectionIntent(
      projectRoot,
      projection.operationId,
      projection.projectionId,
      now,
    );
  } catch {
    // The session is already converged; doctor can close the pending intent.
  }
}

function createSoloJournal(
  context: Awaited<ReturnType<typeof openV3TaskOperation>>,
  before: WorkflowMetadataV3,
  target: WorkflowMetadataV3,
): Promise<OperationJournalV1> {
  return createTaskOperationJournal(context, {
    type: 'solo_handoff',
    action: 'local_workflow_mutation',
    expectedRevisions: {
      [taskEntityKey(context.taskRef)]: context.task.metadata.revision,
    },
    recovery: {
      actions: [
        createTaskAuthorityFileRecoveryAction({
          stepId: 'write-workflow-assignment',
          taskRef: context.taskRef,
          fileName: 'metadata.json',
          beforeContent: serializeTaskAuthority(before),
          targetContent: serializeTaskAuthority(target),
        }),
      ],
      // Session state is a local convenience projection. It never authorizes
      // the assignment or completion and can be repaired by `context resume`.
      noOpStepIds: ['update-session-pointer'],
    },
  });
}

function assertLocalTaskRef(taskRef: TaskRef): TaskRef {
  const parsed = parseTaskRefValue(taskRef);
  if (parsed.namespace !== 'local') {
    throw new Error('MANCODE_SOLO_HANDOFF_LOCAL_ONLY');
  }
  return parsed;
}

function assertSoloStartEligible(
  context: Awaited<ReturnType<typeof openV3TaskOperation>>,
): void {
  const { metadata, requirements, plan } = context.task;
  if (
    metadata.workflowMode !== 'man' ||
    metadata.coordination !== 'single' ||
    metadata.status !== 'in_progress' ||
    metadata.currentStep !== 4 ||
    metadata.governance.planDecision !== null ||
    metadata.soloExecution !== null ||
    metadata.ownerActorId !== context.session.actorId ||
    plan === null ||
    requirements.status !== 'confirmed' ||
    !requirementsAreReady(requirements) ||
    metadata.governance.requirementsStatus !== 'ready' ||
    metadata.governance.requirementsDigest !== requirements.contentDigest
  ) {
    throw new Error('MANCODE_SOLO_HANDOFF_NOT_ELIGIBLE');
  }
}

function assertSoloCompletionEligible(
  context: Awaited<ReturnType<typeof openV3TaskOperation>>,
): void {
  const { metadata } = context.task;
  if (
    metadata.workflowMode !== 'man' ||
    metadata.coordination !== 'single' ||
    metadata.status !== 'planned' ||
    metadata.governance.planDecision !== 'solo_handoff' ||
    metadata.soloExecution?.state !== 'active' ||
    metadata.soloExecution.assignedSessionId !== context.session.sessionId ||
    metadata.ownerActorId !== context.session.actorId
  ) {
    throw new Error('MANCODE_SOLO_HANDOFF_NOT_ACTIVE');
  }
}

function activeSoloMetadata(
  previous: WorkflowMetadataV3,
  sessionId: Ulid,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    status: 'planned',
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    governance: {
      ...previous.governance,
      planDecision: 'solo_handoff',
    },
    soloExecution: {
      state: 'active',
      planVersion: previous.governance.planVersion,
      assignedSessionId: sessionId,
      startedAt: updatedAt,
      completedAt: null,
    },
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function completedSoloMetadata(
  previous: WorkflowMetadataV3,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const soloExecution = previous.soloExecution;
  if (soloExecution === null || soloExecution.state !== 'active') {
    throw new Error('MANCODE_SOLO_HANDOFF_NOT_ACTIVE');
  }
  const next = parseWorkflowMetadata({
    ...previous,
    status: 'completed',
    currentStep: 9,
    blockingReason: null,
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    soloExecution: {
      ...soloExecution,
      state: 'completed',
      completedAt: updatedAt,
    },
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function completedSoloAssignmentMetadata(
  previous: WorkflowMetadataV3,
  completedAt: string,
): WorkflowMetadataV3 {
  const soloExecution = previous.soloExecution;
  if (soloExecution === null || soloExecution.state !== 'active') {
    throw new Error('MANCODE_SOLO_HANDOFF_NOT_ACTIVE');
  }
  return parseWorkflowMetadata({
    ...previous,
    soloExecution: {
      ...soloExecution,
      state: 'completed',
      completedAt,
    },
  });
}

async function resumeSoloSessionPointer(
  projectRoot: string,
  sessionId: Ulid,
  taskRef: TaskRef,
  metadata: WorkflowMetadataV3,
  now: Date,
): Promise<boolean> {
  try {
    await resumeSession(projectRoot, sessionId, {
      taskRef,
      workflowMode: metadata.workflowMode,
      taskRevision: metadata.revision,
      now,
    });
    return true;
  } catch {
    return false;
  }
}

async function clearSoloSessionPointer(
  projectRoot: string,
  sessionId: Ulid,
  taskRef: TaskRef,
  now: Date,
): Promise<boolean> {
  try {
    const session = await clearSessionTaskPointer(projectRoot, sessionId, {
      expectedTaskRef: taskRef,
      now,
    });
    return session.activeTaskRef === null;
  } catch {
    return false;
  }
}

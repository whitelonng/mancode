import { type Ulid, createUlid } from '../../src/context/ids.js';
import { presentV3Plan } from '../../src/context/plan-present.js';
import {
  type ReviseV3PlanInput,
  type RevisedV3Plan,
  type V3PlanDecision,
  reviseV3Plan,
} from '../../src/context/plan-revision.js';
import {
  type StartV3SoloHandoffInput,
  type V3SoloHandoffResult,
  startV3SoloHandoff,
} from '../../src/context/solo-handoff.js';
import { V3ContextStore } from '../../src/context/store.js';
import type { TaskRef } from '../../src/context/task-ref.js';

/**
 * Drives the planning-policy-4 plan gate for fixtures: present the stored plan,
 * then confirm it with a fixture operator reply.
 * Policy 1-3 tasks have no present step and confirm directly.
 */
export async function confirmPlanForTest(input: {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  decision: V3PlanDecision;
  now?: Date;
}): Promise<RevisedV3Plan> {
  const store = new V3ContextStore(input.projectRoot);
  let snapshot = await store.readTaskSnapshot(input.taskRef);
  const gated = snapshot.metadata.governance.policyVersions.planning === 4;
  if (gated) {
    await presentV3Plan({
      projectRoot: input.projectRoot,
      taskRef: input.taskRef,
      sessionId: input.sessionId,
      expectedTaskRevision: snapshot.metadata.revision,
      now: input.now,
    });
    snapshot = await store.readTaskSnapshot(input.taskRef);
  }
  if (snapshot.plan === null) throw new Error('fixture plan missing');
  return reviseV3Plan({
    projectRoot: input.projectRoot,
    taskRef: input.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: snapshot.metadata.revision,
    plan: snapshot.plan.content,
    planDecision: input.decision,
    ...(gated
      ? {
          operatorReply: `Fixture operator approves the presented plan ${createUlid()}`,
        }
      : {}),
    now: input.now,
  });
}

/**
 * Drop-in for pre-gate fixtures that revised and decided in one call. On a
 * planning-policy-4 task it performs revise, present and a confirm with a fixture operator reply;
 * older tasks and calls without a decision go straight to reviseV3Plan.
 */
export async function reviseV3PlanForTest(
  input: ReviseV3PlanInput,
  options: {
    /** Opt in for rejection tests that expect reviseV3Plan's own error. */
    tolerateIneligiblePresent?: boolean;
  } = {},
): Promise<RevisedV3Plan> {
  if (input.planDecision === undefined) return reviseV3Plan(input);
  const store = new V3ContextStore(input.projectRoot);
  const before = await store.readTaskSnapshot(input.taskRef);
  if (before.metadata.governance.policyVersions.planning !== 4) {
    return reviseV3Plan(input);
  }
  const { planDecision, operationId, ...revise } = input;
  const needsRevise =
    input.implementationScope !== undefined ||
    input.planSource !== undefined ||
    input.plan !== before.plan?.content;
  let revision = input.expectedTaskRevision;
  if (needsRevise) {
    try {
      revision = (await reviseV3Plan(revise)).metadata.revision;
    } catch (error) {
      // Re-binding an unchanged plan source is a no-op, not a failure.
      const unchanged =
        input.planSource !== undefined &&
        input.implementationScope === undefined &&
        error instanceof Error &&
        error.message.startsWith('MANCODE_PLAN_CONTENT_UNCHANGED');
      if (!unchanged) throw error;
    }
  }
  const presented = await presentV3Plan({
    projectRoot: input.projectRoot,
    taskRef: input.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: revision,
    now: input.now,
  }).catch((error: unknown) => {
    if (
      options.tolerateIneligiblePresent === true &&
      error instanceof Error &&
      /^MANCODE_(PLAN_PRESENT_NOT_ELIGIBLE|TASK_OWNER_REQUIRED)/.test(
        error.message,
      )
    ) {
      return null;
    }
    throw error;
  });
  const current = await store.readTaskSnapshot(input.taskRef);
  return reviseV3Plan({
    ...input,
    plan: current.plan?.content ?? input.plan,
    planSource: undefined,
    implementationScope: undefined,
    expectedTaskRevision: presented?.metadata.revision ?? revision,
    planDecision,
    operationId,
    operatorReply: `Fixture operator approves the presented plan ${createUlid()}`,
  });
}

/** Solo handoff start that satisfies the planning-policy-4 gate when it applies. */
export async function startSoloForTest(
  input: StartV3SoloHandoffInput,
): Promise<V3SoloHandoffResult> {
  const store = new V3ContextStore(input.projectRoot);
  const before = await store.readTaskSnapshot(input.taskRef);
  if (before.metadata.governance.policyVersions.planning !== 4) {
    return startV3SoloHandoff(input);
  }
  const presented = await presentV3Plan({
    projectRoot: input.projectRoot,
    taskRef: input.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    now: input.now,
  });
  return startV3SoloHandoff({
    ...input,
    expectedTaskRevision: presented.metadata.revision,
    operatorReply: `Fixture operator approves the presented plan ${createUlid()}`,
  });
}

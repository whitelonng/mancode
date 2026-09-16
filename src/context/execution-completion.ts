import path from 'node:path';
import { runBoundedCommand } from '../runtime/execution-runner.js';
import { readCheckoutCodeHead } from '../runtime/project-runtime.js';
import { openV3TaskOperation } from '../runtime/task-operation.js';
import { buildCiObserverArgv } from '../system/ci-observer.js';
import { digestCanonicalJson } from './canonical.js';
import { evaluateExecutionGate } from './execution-gate.js';
import type { ExecutionAction } from './execution-ledger.js';
import {
  assertExecutionActionAuthority,
  ciObserverTarget,
  mutateV3Execution,
} from './execution-mutation.js';
import { createUlid } from './ids.js';
import {
  captureManSubject,
  inspectManDelivery,
  syncManDeliveryRecord,
} from './man-delivery-runtime.js';
import { V3ContextStore } from './store.js';
import type { CompleteV3TaskInput } from './task-complete.js';

/** Remote completion performs a charged fresh observation outside task locks. */
export async function prepareExecutionCompletion(
  input: Pick<
    CompleteV3TaskInput,
    'projectRoot' | 'taskRef' | 'sessionId' | 'expectedTaskRevision'
  >,
): Promise<number> {
  const store = new V3ContextStore(input.projectRoot);
  const initial = await store.readTaskSnapshot(input.taskRef);
  if (
    initial.verification.schemaVersion !== 2 ||
    initial.verification.execution.policy.delivery !== 'remote_required'
  )
    return input.expectedTaskRevision;
  const opened = await openV3TaskOperation(input);
  let task = opened.task;
  try {
    assertExecutionActionAuthority(opened, {
      type: 'run.reserve',
    } as ExecutionAction);
  } finally {
    await opened.release();
  }
  if (task.verification.schemaVersion !== 2)
    throw new Error('MANCODE_EXECUTION_POLICY_REQUIRED');
  const policy = task.verification.execution.policy;
  const ci = policy.ci;
  if (
    !ci ||
    ci.event !== 'push' ||
    ci.testedBinding !== 'approved_workflow_head'
  )
    throw new Error('MANCODE_CI_TESTED_OBJECT_UNVERIFIED');
  const candidateSha = await readCheckoutCodeHead(input.projectRoot);
  if (!candidateSha) throw new Error('MANCODE_EXECUTION_CI_TARGET_REQUIRED');
  const inspection = await inspectManDelivery(input.projectRoot, task);
  const deliveryBlockers = inspection.finalization.blockers.filter(
    (item) => item.code !== 'execution_incomplete',
  );
  if (deliveryBlockers.length)
    throw new Error(
      `MANCODE_MAN_DELIVERY_INCOMPLETE: ${deliveryBlockers.map((item) => item.code).join(', ')}`,
    );
  const currentSubject = inspection.subject;
  const previousGate = evaluateExecutionGate({
    ...task,
    currentSubject,
    candidateSha,
  });
  const localBlockers = previousGate.blockers.filter(
    (item) =>
      !['MANCODE_CI_UNVERIFIED', 'MANCODE_EXECUTION_BUDGET_EXHAUSTED'].includes(
        item.code,
      ),
  );
  if (localBlockers.length)
    throw new Error(
      `MANCODE_EXECUTION_INCOMPLETE: ${localBlockers.map((item) => item.code).join(', ')}`,
    );
  const state = task.verification.execution;
  // Preserve an exact, previously observed selection, then query it afresh. The
  // observer still rejects a newer run, changed attempt or changed complete set.
  const prior = [...state.ciObservations].reverse().find((item) => {
    if (
      item.policyDigest !== state.policyDigest ||
      item.target.candidateSha !== candidateSha ||
      item.target.testedSha !== candidateSha ||
      item.observation.status !== 'passed'
    )
      return false;
    const run = state.runs.find((run) => run.runId === item.runId);
    if (
      !run ||
      run.purpose !== 'ci_observation' ||
      run.state !== 'succeeded' ||
      !run.applicable
    )
      return false;
    try {
      return (
        digestCanonicalJson(ciObserverTarget(run, policy)) ===
        digestCanonicalJson(item.target)
      );
    } catch {
      return false;
    }
  });
  const target = {
    ...ci,
    candidateSha,
    testedSha: candidateSha,
    workflows: ci.workflows.map((workflow) => {
      const selected = prior?.observation.runs.find(
        (run) => run.workflowId === workflow.id,
      );
      return selected ? { ...workflow, runId: selected.runId } : workflow;
    }),
  };
  const argv = buildCiObserverArgv(target, policy.budget.ciTimeoutMs);
  const runId = createUlid();
  let revision = input.expectedTaskRevision;
  const mutate = async (action: ExecutionAction) => {
    const receipt = await mutateV3Execution({
      ...input,
      expectedTaskRevision: revision,
      action,
    });
    revision = receipt.metadata.revision;
    return receipt;
  };
  try {
    await mutate({
      type: 'run.reserve',
      runId,
      purpose: 'ci_observation',
      argv,
      cwd: '.',
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('BUDGET_EXHAUSTED'))
      throw new Error(
        'MANCODE_CI_FRESH_OBSERVATION_BUDGET_REQUIRED: recover existing runs or approve an additive extension',
      );
    throw error;
  }
  const result = await runBoundedCommand({
    runId,
    projectRoot: input.projectRoot,
    argv,
    timeoutMs: policy.budget.ciTimeoutMs,
    maxOutputBytes: 1024 * 1024,
    runDirectory: path.join(
      input.projectRoot,
      '.mancode/local/execution',
      input.taskRef.taskId,
      runId,
    ),
    onReady: async (identity) => {
      await mutate({ type: 'run.start', runId, identity });
    },
  });
  const { stdout, stderr: _stderr, ...persisted } = result;
  await mutate({
    type: 'run.finish',
    runId,
    result: {
      ...persisted,
      outputArtifactRef: null,
      summary: `Completion CI observer ${result.status}; cleanup=${result.cleanupConfirmed}.`,
    },
  });
  if (result.status !== 'succeeded')
    throw new Error(
      `MANCODE_CI_UNVERIFIED: ${result.status}; recover run ${runId}`,
    );
  await mutate({
    type: 'ci.observe',
    runId,
    target,
    observation: JSON.parse(stdout),
  });
  task = await store.readTaskSnapshot(input.taskRef);
  const gate = evaluateExecutionGate({
    ...task,
    currentSubject: await captureManSubject(input.projectRoot, task),
    candidateSha: (await readCheckoutCodeHead(input.projectRoot)) ?? undefined,
  });
  if (gate.status === 'incomplete')
    throw new Error(
      `MANCODE_EXECUTION_INCOMPLETE: ${gate.blockers.map((item) => item.code).join(', ')}`,
    );
  await syncManDeliveryRecord(input.projectRoot, task);
  return revision;
}

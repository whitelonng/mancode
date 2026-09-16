import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from '../context/canonical.js';
import { evaluateExecutionGate } from '../context/execution-gate.js';
import {
  type ExecutionAction,
  type ExecutionRun,
  type PersistedRunResult,
  executionBudget,
  parseCiContract,
} from '../context/execution-ledger.js';
import {
  assertExecutionActionAuthority,
  ciObserverTarget,
  mutateV3Execution,
} from '../context/execution-mutation.js';
import { createUlid } from '../context/ids.js';
import {
  captureManSubject,
  syncManDeliveryRecord,
} from '../context/man-delivery-runtime.js';
import { redactSharedText } from '../context/privacy.js';
import type { StoredTaskSnapshot } from '../context/store.js';
import { parseTaskRef } from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import type {
  BoundedRunResult,
  VitestAssessment,
} from '../runtime/execution-protocol.js';
import {
  cancelBoundedRun,
  inspectBoundedRun,
  recoverBoundedRun,
  runBoundedCommand,
} from '../runtime/execution-runner.js';
import { readCheckoutCodeHead } from '../runtime/project-runtime.js';
import { openV3TaskOperation } from '../runtime/task-operation.js';
import { buildCiObserverArgv } from '../system/ci-observer.js';
import {
  buildVitestArgv,
  captureVitestIdentity,
  readVitestAssessment,
} from '../system/tdd-evidence.js';
import {
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  v3ErrorCode,
} from './v3-support.js';
import type { WorkflowOptions } from './workflow.js';

const actions = [
  'inspect',
  'run',
  'run-inspect',
  'run-cancel',
  'run-recover',
  'run-reconcile',
  'attempt-reserve',
  'attempt-finish',
  'budget-extend',
  'exception-decide',
  'contract-revise',
  'problem-merge',
  'ci-observe',
  'manual-confirm',
] as const;
const semanticActions: Record<string, ExecutionAction['type']> = {
  'run-reconcile': 'run.reconcile',
  'attempt-reserve': 'attempt.reserve',
  'attempt-finish': 'attempt.finish',
  'budget-extend': 'budget.extend',
  'exception-decide': 'exception.decide',
  'contract-revise': 'contract.revise',
  'problem-merge': 'problem.merge',
  'manual-confirm': 'manual.confirm',
};
function executionState(task: StoredTaskSnapshot) {
  if (
    task.verification.schemaVersion !== 2 ||
    task.metadata.governance.policyVersions.verification !== 2
  )
    throw new Error('MANCODE_EXECUTION_POLICY_REQUIRED');
  return task.verification.execution;
}
function persisted(result: BoundedRunResult): PersistedRunResult {
  const { stdout: _stdout, stderr: _stderr, ...rest } = result;
  return {
    ...rest,
    outputArtifactRef: null,
    summary: `Executor ${result.status}; exit=${result.exitCode ?? 'unknown'}; cleanup=${result.cleanupConfirmed}.`,
  };
}
function executionExit(
  purpose: ExecutionRun['purpose'],
  result: BoundedRunResult,
  vitest?: VitestAssessment,
  ciStatus?: string,
): number {
  if (purpose === 'ci_observation')
    return result.status === 'succeeded' && ciStatus === 'passed' ? 0 : 3;
  if (purpose === 'tdd_red')
    return vitest?.assessment === 'assertion_failure' ? 0 : 3;
  if (purpose === 'tdd_green') return vitest?.assessment === 'passed' ? 0 : 3;
  if (purpose === 'regression_replay')
    return vitest && vitest.assessment !== 'unverified' ? 0 : 3;
  return result.status === 'succeeded' ? 0 : 3;
}
function runLocation(root: string, taskId: string, runId: string) {
  return {
    runId,
    runDirectory: path.join(root, '.mancode/local/execution', taskId, runId),
  };
}
async function assessRecoveredTdd(
  root: string,
  task: StoredTaskSnapshot,
  run: ExecutionRun,
  result: BoundedRunResult,
): Promise<VitestAssessment | undefined> {
  if (
    !['tdd_red', 'tdd_green', 'regression_replay'].includes(run.purpose) ||
    !result.identity ||
    !run.testIdentity ||
    !run.configurationIdentity
  )
    return undefined;
  const scenario = executionState(task).policy.scenarios.find(
    (scenario) => scenario.id === run.scenarioId,
  );
  if (!scenario) return undefined;
  const before = {
    testIdentity: run.testIdentity,
    configurationIdentity: run.configurationIdentity,
  };
  // Missing or changed test inputs cannot prevent settling the actual executor result.
  let after = { testIdentity: '', configurationIdentity: '' };
  try {
    after = await captureVitestIdentity(root, scenario);
  } catch {
    /* Assessment reports changed/unavailable input as unverified. */
  }
  return readVitestAssessment({
    reportPath: path.join(
      runLocation(root, task.metadata.taskRef.taskId, run.runId).runDirectory,
      'vitest.json',
    ),
    run: result,
    scenario,
    before,
    after,
  });
}
async function checkedCwd(root: string, cwd: string): Promise<string> {
  const base = await realpath(root);
  const actual = await realpath(path.resolve(base, cwd));
  const relative = path.relative(base, actual);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('MANCODE_EXECUTION_CWD_OUTSIDE_PROJECT');
  // Preserve the checkout's lexical path in the execution identity (for example /var on macOS).
  return path.resolve(root, cwd);
}

/** Results can only enter through a captured executor receipt, never a JSON passed claim. */
export async function executionCommand(
  root: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  try {
    const [ref, action] = args;
    if (
      args.length !== 2 ||
      !ref ||
      !actions.includes(action as (typeof actions)[number])
    )
      throw new Error('MANCODE_EXECUTION_ARGUMENT_INVALID');
    const project = await readV3CommandProject(root);
    const taskRef = parseTaskRef(ref);
    let task = await project.store.readTaskSnapshot(taskRef);
    const state = executionState(task);
    if (action === 'inspect') {
      const currentSubject = await captureManSubject(project.projectRoot, task);
      const candidateSha = await readCheckoutCodeHead(project.projectRoot);
      return printV3Result(options.json, {
        revision: task.metadata.revision,
        execution: state,
        budget: executionBudget(state),
        gate: evaluateExecutionGate({
          ...task,
          currentSubject,
          ...(candidateSha ? { candidateSha } : {}),
        }),
        receiptRoot: path.join(
          project.projectRoot,
          '.mancode/local/execution',
          taskRef.taskId,
        ),
      });
    }
    if (!options.file) throw new Error('MANCODE_EXECUTION_INPUT_REQUIRED');
    const input: unknown = JSON.parse(
      await readFile(path.resolve(project.projectRoot, options.file), 'utf8'),
    );
    assertRecord(input, 'execution command');
    if (action === 'run-inspect') {
      assertKnownKeys(input, ['runId'], 'run inspection');
      const run = state.runs.find((run) => run.runId === input.runId);
      if (!run) throw new Error('MANCODE_EXECUTION_RUN_UNKNOWN');
      const observed = await inspectBoundedRun(
        runLocation(project.projectRoot, taskRef.taskId, run.runId),
      );
      if (observed.state === 'terminal') {
        observed.result.stdout = redactSharedText(observed.result.stdout).text;
        observed.result.stderr = redactSharedText(observed.result.stderr).text;
      }
      return printV3Result(options.json, { run, observed });
    }
    const expectedTaskRevision = Number(options.expectedRevision);
    if (!Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision < 1)
      throw new Error('MANCODE_EXPECTED_REVISION_REQUIRED');
    if (options.sync) throw new Error('MANCODE_GIT_REF_DEFERRED_SYNC_REQUIRED');
    const session = await resolveV3CommandSession(project, options);
    const base = {
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
    };
    // A short CAS protects authority before any process or cancellation is attempted.
    const authority = await openV3TaskOperation({
      ...base,
      expectedTaskRevision,
    });
    try {
      assertExecutionActionAuthority(authority);
      task = authority.task;
      executionState(task);
    } finally {
      await authority.release();
    }
    let revision = expectedTaskRevision;
    const mutate = async (mutation: ExecutionAction, fresh = false) => {
      if (fresh)
        revision = (await project.store.readTaskSnapshot(taskRef)).metadata
          .revision;
      const receipt = await mutateV3Execution({
        ...base,
        expectedTaskRevision: revision,
        action: mutation,
      });
      revision = receipt.metadata.revision;
      return receipt;
    };
    const finish = async (
      run: ExecutionRun,
      result: BoundedRunResult,
      vitest?: VitestAssessment,
    ) => {
      const current = executionState(
        await project.store.readTaskSnapshot(taskRef),
      ).runs.find((item) => item.runId === run.runId);
      if (!current) throw new Error('MANCODE_EXECUTION_RUN_UNKNOWN');
      if (current.state === 'reserved' && result.identity)
        await mutate(
          { type: 'run.start', runId: run.runId, identity: result.identity },
          true,
        );
      return mutate(
        {
          type: 'run.finish',
          runId: run.runId,
          result: {
            ...persisted(result),
            ...(current.result
              ? {
                  summary: current.result.summary,
                  outputArtifactRef: current.result.outputArtifactRef,
                }
              : {}),
          },
          ...(vitest ? { vitest } : {}),
        },
        true,
      );
    };
    if (action === 'run-cancel' || action === 'run-recover') {
      assertKnownKeys(input, ['runId'], 'run recovery');
      const run = executionState(task).runs.find(
        (item) => item.runId === input.runId,
      );
      if (!run) throw new Error('MANCODE_EXECUTION_RUN_UNKNOWN');
      const location = runLocation(
        project.projectRoot,
        taskRef.taskId,
        run.runId,
      );
      const observed =
        action === 'run-cancel'
          ? await cancelBoundedRun(location)
          : await recoverBoundedRun(location);
      if (observed.state === 'terminal') {
        const vitest =
          run.vitest ??
          (await assessRecoveredTdd(
            project.projectRoot,
            task,
            run,
            observed.result,
          ));
        const receipt = await finish(run, observed.result, vitest);
        let ciStatus: string | undefined;
        if (
          run.purpose === 'ci_observation' &&
          observed.result.status === 'succeeded'
        ) {
          const target = ciObserverTarget(run, executionState(task).policy);
          const observation = JSON.parse(observed.result.stdout);
          await mutate(
            { type: 'ci.observe', runId: run.runId, target, observation },
            true,
          );
          ciStatus = observation.status;
        }
        await syncManDeliveryRecord(
          project.projectRoot,
          await project.store.readTaskSnapshot(taskRef),
        );
        printV3Result(options.json, {
          runId: run.runId,
          status: observed.result.status,
          revision,
          vitest,
          ciStatus,
          operation: receipt.operation,
        });
        return executionExit(run.purpose, observed.result, vitest, ciStatus);
      }
      if (
        observed.state === 'interrupted' &&
        (run.state === 'reserved' || run.state === 'running')
      ) {
        const result: BoundedRunResult = {
          identity: run.identity,
          status: 'interrupted',
          started: run.identity !== null,
          exitCode: null,
          signal: null,
          reason: 'executor_receipt_unavailable',
          startedAt: run.identity?.startedAt ?? null,
          finishedAt: new Date().toISOString(),
          durationMs: run.timeoutMs,
          outputTruncated: false,
          cleanupConfirmed: false,
          stdout: '',
          stderr: '',
        };
        await finish(run, result);
      }
      printV3Result(options.json, {
        runId: run.runId,
        revision,
        observed,
        nextAction: 'Inspect or recover this run; no command was replayed.',
      });
      return 3;
    }
    const semanticType = semanticActions[action ?? ''];
    if (semanticType) {
      if ('type' in input)
        throw new Error('MANCODE_EXECUTION_ACTION_FROM_COMMAND_REQUIRED');
      const receipt = await mutate({
        ...input,
        type: semanticType,
      } as ExecutionAction);
      await syncManDeliveryRecord(
        project.projectRoot,
        await project.store.readTaskSnapshot(taskRef),
      );
      return printV3Result(options.json, receipt);
    }
    let reserve: Extract<ExecutionAction, { type: 'run.reserve' }>;
    let target: ReturnType<typeof parseCiContract> | undefined;
    if (action === 'ci-observe') {
      assertKnownKeys(input, ['target', 'runId'], 'CI observation');
      target = parseCiContract(input.target);
      const { candidateSha, testedSha: _testedSha, pr: _pr, ...ci } = target;
      const comparable = {
        ...ci,
        workflows: ci.workflows.map(
          ({ runId: _runId, ...workflow }) => workflow,
        ),
      };
      if (
        digestCanonicalJson(comparable) !== digestCanonicalJson(state.policy.ci)
      )
        throw new Error('MANCODE_EXECUTION_CI_CONTRACT_MISMATCH');
      if (candidateSha !== (await readCheckoutCodeHead(project.projectRoot)))
        throw new Error('MANCODE_EXECUTION_CI_TARGET_MISMATCH');
      const argv = buildCiObserverArgv(target, state.policy.budget.ciTimeoutMs);
      reserve = {
        type: 'run.reserve',
        purpose: 'ci_observation',
        argv,
        cwd: '.',
        ...(input.runId ? { runId: String(input.runId) } : {}),
      };
    } else {
      assertKnownKeys(
        input,
        [
          'runId',
          'purpose',
          'checkId',
          'scenarioId',
          'problemId',
          'attemptId',
          'infrastructureRetryOf',
          'hypothesis',
          'argv',
          'cwd',
          'timeoutMs',
        ],
        'run request',
      );
      if (input.purpose === 'ci_observation')
        throw new Error('MANCODE_EXECUTION_CI_OBSERVER_REQUIRED');
      const check = state.policy.checks.find(
        (check) => check.id === input.checkId,
      );
      const argv = input.argv ?? check?.argv;
      if (
        !Array.isArray(argv) ||
        !argv.length ||
        argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
      )
        throw new Error('MANCODE_EXECUTION_ARGV_INVALID');
      reserve = {
        ...input,
        type: 'run.reserve',
        purpose: input.purpose ?? 'verification',
        argv,
        cwd: input.cwd ?? check?.cwd ?? '.',
      } as typeof reserve;
    }
    const runId = reserve.runId ?? createUlid();
    if (state.runs.some((run) => run.runId === runId))
      throw new Error('MANCODE_EXECUTION_RUN_EXISTS_USE_RECOVER');
    reserve.runId = runId;
    const location = runLocation(project.projectRoot, taskRef.taskId, runId);
    const cwd = await checkedCwd(project.projectRoot, reserve.cwd);
    const scenario = state.policy.scenarios.find(
      (scenario) => scenario.id === reserve.scenarioId,
    );
    const isTdd = ['tdd_red', 'tdd_green', 'regression_replay'].includes(
      reserve.purpose,
    );
    let before: Awaited<ReturnType<typeof captureVitestIdentity>> | undefined;
    if (isTdd) {
      if (!scenario) throw new Error('MANCODE_EXECUTION_SCENARIO_UNKNOWN');
      before = await captureVitestIdentity(project.projectRoot, scenario);
      reserve.testIdentity = before.testIdentity;
      reserve.configurationIdentity = before.configurationIdentity;
      reserve.runnerArgv = buildVitestArgv(reserve.argv);
    }
    // Reserve before launching; the worker waits for run.start to commit before execution.
    const reserved = await mutate(reserve);
    const run = executionState({
      ...task,
      verification: reserved.verification,
    }).runs.find((run) => run.runId === runId);
    if (!run) throw new Error('MANCODE_EXECUTION_RESERVATION_MISSING');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    let result: BoundedRunResult;
    try {
      result = await runBoundedCommand({
        ...location,
        projectRoot: cwd,
        argv: run.runnerArgv,
        timeoutMs: run.timeoutMs,
        maxOutputBytes: 1024 * 1024,
        signal: abort.signal,
        ...(isTdd
          ? {
              env: {
                MANCODE_VITEST_REPORT: path.join(
                  location.runDirectory,
                  'vitest.json',
                ),
                MANCODE_EXECUTION_RUN_ID: runId,
                MANCODE_VITEST_PROJECT_ROOT: await realpath(
                  project.projectRoot,
                ),
              },
            }
          : {}),
        onReady: async (identity) => {
          await mutate({ type: 'run.start', runId, identity }, true);
        },
      });
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
    const vitest = await assessRecoveredTdd(
      project.projectRoot,
      task,
      run,
      result,
    );
    await finish(run, result, vitest);
    let ciStatus: string | undefined;
    if (target && result.status === 'succeeded') {
      const observation = JSON.parse(result.stdout);
      await mutate({ type: 'ci.observe', runId, target, observation }, true);
      ciStatus = observation.status;
    }
    await syncManDeliveryRecord(
      project.projectRoot,
      await project.store.readTaskSnapshot(taskRef),
    );
    printV3Result(options.json, {
      runId,
      revision,
      result: persisted(result),
      ...(vitest ? { vitest } : {}),
      receiptDirectory: location.runDirectory,
      stdout: redactSharedText(result.stdout).text,
      stderr: redactSharedText(result.stderr).text,
    });
    return executionExit(reserve.purpose, result, vitest, ciStatus);
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_EXECUTION_FAILED'),
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Existing delivery entry remains usable; V2 never reaches the old whole-ledger writer. */
export async function executionDeliveryCommand(
  root: string,
  ref: string,
  action: 'verify' | 'confirm',
  options: WorkflowOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(root);
    const state = executionState(
      await project.store.readTaskSnapshot(parseTaskRef(ref)),
    );
    if (!options.file) throw new Error('MANCODE_EXECUTION_INPUT_REQUIRED');
    const input: unknown = JSON.parse(
      await readFile(path.resolve(project.projectRoot, options.file), 'utf8'),
    );
    assertRecord(input, 'delivery verification');
    if (action === 'verify') {
      assertKnownKeys(input, ['argv', 'surface'], 'delivery verification');
      const acceptance =
        options.acceptance
          ?.split(',')
          .map((id) => id.trim())
          .sort() ?? [];
      const check = state.policy.checks.find(
        (check) =>
          JSON.stringify(check.argv) === JSON.stringify(input.argv) &&
          check.surface === input.surface &&
          JSON.stringify([...check.acceptanceIds].sort()) ===
            JSON.stringify(acceptance),
      );
      if (!check) throw new Error('MANCODE_EXECUTION_APPROVED_CHECK_REQUIRED');
      return executionCommandWithInput(
        root,
        ref,
        'run',
        { purpose: 'verification', checkId: check.id },
        options,
      );
    }
    assertKnownKeys(
      input,
      ['confirmed', 'summary', 'surface'],
      'manual verification',
    );
    return executionCommandWithInput(
      root,
      ref,
      'manual-confirm',
      {
        ...input,
        acceptanceIds:
          options.acceptance?.split(',').map((id) => id.trim()) ?? [],
      },
      options,
    );
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_EXECUTION_FAILED'),
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function executionCommandWithInput(
  root: string,
  ref: string,
  action: string,
  input: unknown,
  options: WorkflowOptions,
): Promise<number> {
  // Local transient command input only; canonical authority is written by mutateV3Execution.
  const { mkdir, writeFile } = await import('node:fs/promises');
  const directory = path.join(root, '.mancode/local/drafts/execution');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${createUlid()}.json`);
  await writeFile(file, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
  return executionCommand(root, [ref, action], { ...options, file });
}

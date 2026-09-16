import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executionCommand } from '../src/commands/execution.js';
import { normalizeRequirementsInput } from '../src/commands/requirements-input.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { workflow } from '../src/commands/workflow.js';
import * as mutation from '../src/context/execution-mutation.js';
import { createUlid } from '../src/context/ids.js';
import { reviseV3Plan } from '../src/context/plan-revision.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import { REQUIREMENT_DIMENSIONS } from '../src/context/requirements-ledger.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import type { BoundedRunResult } from '../src/runtime/execution-protocol.js';
import * as runner from '../src/runtime/execution-runner.js';
import { createSession } from '../src/runtime/session.js';
import * as observer from '../src/system/ci-observer.js';
import { createLocalActor } from '../src/team/actor.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const argv = ['node', '-e', 'process.exit(0)'];
const policy = {
  version: 1,
  budget: {
    maxRuns: 1,
    maxExecutionMs: 10000,
    maxRepairAttempts: 2,
    commandTimeoutMs: 2000,
    ciTimeoutMs: 2000,
  },
  checks: [
    {
      id: 'check',
      acceptanceIds: ['AC-1'],
      argv,
      cwd: '.',
      surface: 'component',
    },
  ],
  scenarios: [],
  delivery: 'local',
  ci: null,
};
async function fixture(enabled = true, executionPolicy = policy) {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-execution-cli-'));
  roots.push(root);
  const git = (args: string[]) => execFile('git', args, { cwd: root });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.test']);
  await mkdir(path.join(root, 'docs'));
  const plan =
    '<!-- mancode:plan-baseline:start -->\n# Gate fixture\nAC-1 command succeeds.\n<!-- mancode:plan-baseline:end -->\n<!-- mancode:delivery-record:start -->\nPending.\n<!-- mancode:delivery-record:end -->\n';
  await writeFile(path.join(root, 'docs/plan.md'), plan);
  await writeFile(path.join(root, '.gitignore'), '.mancode/\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'fixture']);
  await initializeV3Project({ projectRoot: root });
  const actorId = createUlid();
  await createLocalActor(root, { actorId, displayName: 'Fixture' });
  const session = await createSession(root, {
    actorId,
    client: 'vitest',
    identitySource: 'explicit',
  });
  const created = await createV3Workflow({
    projectRoot: root,
    workflowMode: 'man',
    task: 'Gate fixture',
    delivery: true,
    sessionId: session.sessionId,
    client: 'vitest',
    ...(enabled ? { executionPolicy } : {}),
  });
  const taskRef = created.taskRef;
  const ready = await finalizeV3Requirements({
    projectRoot: root,
    taskRef,
    sessionId: session.sessionId,
    expectedTaskRevision: created.metadata.revision,
    requirements: normalizeRequirementsInput(
      {
        version: 1,
        goal: 'Gate fixture',
        confirmedScope: ['Run check'],
        excludedScope: [],
        technicalDecisions: [],
        defaults: [],
        blockingUnknowns: [],
        coverage: REQUIREMENT_DIMENSIONS.map((dimension) => ({
          dimension,
          status:
            dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
          rationale: 'Fixture.',
        })),
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Command succeeds',
            required: true,
            method: 'automated',
            verificationSurfaces: { automated: 'component' },
          },
        ],
      },
      taskRef,
    ),
  });
  await reviseV3Plan({
    projectRoot: root,
    taskRef,
    sessionId: session.sessionId,
    expectedTaskRevision: ready.metadata.revision,
    plan,
    planSource: 'docs/plan.md',
    implementationScope: {
      include: ['docs/plan.md'],
      exclude: [],
      modules: [],
    },
    planDecision: 'governed_execution',
  });
  const store = new V3ContextStore(root);
  const ref = `local:${taskRef.taskId}`;
  async function call(action: string, input?: unknown, delivery = false) {
    await mkdir(path.join(root, '.mancode/local/drafts'), { recursive: true });
    if (input)
      await writeFile(
        path.join(root, '.mancode/local/drafts/input.json'),
        JSON.stringify(input),
      );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const options = {
        json: true,
        session: session.sessionId,
        client: 'vitest',
        expectedRevision: String(
          (await store.readTaskSnapshot(taskRef)).metadata.revision,
        ),
        ...(input ? { file: '.mancode/local/drafts/input.json' } : {}),
        ...(delivery ? { acceptance: 'AC-1' } : {}),
      };
      const code = delivery
        ? await workflow(root, 'delivery', [ref, action], options)
        : await executionCommand(root, [ref, action], options);
      return {
        code,
        output: log.mock.calls.map((call) => String(call[0])).join('\n'),
      };
    } finally {
      log.mockRestore();
    }
  }
  return { root, store, taskRef, call };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('execution command authority boundary', () => {
  it('rejects generic commands claiming the dedicated CI purpose before reservation or execution', async () => {
    const f = await fixture();
    const execute = vi
      .spyOn(runner, 'runBoundedCommand')
      .mockRejectedValue(new Error('must not execute'));
    const before = await f.store.readTaskSnapshot(f.taskRef);
    const result = await f.call('run', {
      purpose: 'ci_observation',
      argv: ['node', '-e', 'console.log("passed")'],
    });
    expect(result.code).toBe(3);
    expect(result.output).toContain('CI_OBSERVER_REQUIRED');
    expect(execute).not.toHaveBeenCalled();
    expect((await f.store.readTaskSnapshot(f.taskRef)).metadata.revision).toBe(
      before.metadata.revision,
    );
  });

  it('offers an audited reconciliation for lost receipts without inventing a pass or refunding unknown execution', async () => {
    const f = await fixture();
    const execute = vi
      .spyOn(runner, 'runBoundedCommand')
      .mockRejectedValue(new Error('simulated crash before receipt creation'));
    expect(
      (await f.call('run', { purpose: 'verification', checkId: 'check' })).code,
    ).toBe(3);
    const state = await f.store.readTaskSnapshot(f.taskRef);
    if (state.verification.schemaVersion !== 2) throw new Error('expected V2');
    const runId = state.verification.execution.runs[0]?.runId;
    vi.spyOn(runner, 'recoverBoundedRun').mockResolvedValue({
      state: 'interrupted',
      reason: 'receipt unavailable',
    });
    expect((await f.call('run-recover', { runId })).code).toBe(3);
    const approval = {
      confirmed: true,
      source: 'fixture operator explicit decision',
      reason: 'Original local receipt is unavailable.',
      evidence:
        'Fixture operator checked the executor and accepts the unresolved history.',
    };
    const reconcile = await f.call('run-reconcile', { runId, approval });
    expect(reconcile.code, reconcile.output).toBe(0);
    const inspected = JSON.parse((await f.call('inspect')).output);
    expect(inspected.budget.runs).toBe(1);
    expect(inspected.gate.status).toBe('incomplete');
    expect(
      inspected.gate.blockers.some(
        (item: { code: string }) => item.code === 'MANCODE_RUN_INTERRUPTED',
      ),
    ).toBe(false);
    expect(inspected.execution.runs[0].state).toBe('interrupted');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (await f.call('run', { purpose: 'verification', checkId: 'check' })).code,
    ).toBe(3);
  });
  it('keeps opted-out tasks unchanged and rejects caller-supplied run results', async () => {
    const f = await fixture(false);
    const before = await f.store.readTaskSnapshot(f.taskRef);
    expect(
      (await f.call('run', { purpose: 'verification', checkId: 'check' })).code,
    ).toBe(3);
    expect((await f.call('run.finish', { status: 'succeeded' })).code).toBe(3);
    expect((await f.store.readTaskSnapshot(f.taskRef)).metadata.revision).toBe(
      before.metadata.revision,
    );
  });

  it('routes delivery verify through one reservation and blocks the next run at the task budget', async () => {
    const f = await fixture();
    const execute = vi
      .spyOn(runner, 'runBoundedCommand')
      .mockImplementation(async (input) => {
        const identity = {
          protocolVersion: 1 as const,
          runId: input.runId,
          executorId: createUlid(),
          commandDigest: runner.executionCommandDigest(
            input.projectRoot,
            input.argv,
            input.timeoutMs,
          ),
          startedAt: new Date().toISOString(),
          pid: process.pid,
          platform: process.platform,
        };
        await input.onReady?.(identity);
        return {
          identity,
          status: 'succeeded',
          started: true,
          exitCode: 0,
          signal: null,
          reason: null,
          startedAt: identity.startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 1,
          outputTruncated: false,
          cleanupConfirmed: true,
          stdout: '',
          stderr: '',
        };
      });
    const result = await f.call('verify', { argv, surface: 'component' }, true);
    expect(result.code, result.output).toBe(0);
    const saved = await f.store.readTaskSnapshot(f.taskRef);
    expect(saved.verification.schemaVersion).toBe(2);
    if (saved.verification.schemaVersion !== 2) throw new Error('expected V2');
    expect(saved.verification.execution.runs).toHaveLength(1);
    expect(saved.verification.execution.runs[0]?.state).toBe('succeeded');
    expect(
      (await f.call('run', { purpose: 'verification', checkId: 'check' })).code,
    ).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    const inspect = await f.call('inspect');
    expect(inspect.code, inspect.output).toBe(0);
  });

  it.each(['verification', 'ci_observation'] as const)(
    'recovers %s after a failed authority write without spending another run',
    async (purpose) => {
      const ci = {
        repository: 'fixture/project',
        event: 'push',
        testedBinding: 'approved_workflow_head',
        workflows: [
          {
            id: 1,
            path: '.github/workflows/test.yml',
            configurationSha: 'a'.repeat(40),
            requiredJobs: ['test'],
          },
        ],
      };
      const f = await fixture(
        true,
        purpose === 'ci_observation'
          ? ({ ...policy, delivery: 'remote_required', ci } as typeof policy)
          : policy,
      );
      const sha = (
        await execFile('git', ['rev-parse', 'HEAD'], { cwd: f.root })
      ).stdout.trim();
      const target = { ...ci, candidateSha: sha, testedSha: sha };
      const actualBuild = observer.buildCiObserverArgv;
      if (purpose === 'ci_observation')
        vi.spyOn(observer, 'buildCiObserverArgv').mockImplementation(
          (target, timeout) => {
            const argv = actualBuild(target, timeout, 20);
            argv[3] = JSON.stringify(
              Object.fromEntries(Object.entries(target).reverse()),
            );
            return argv;
          },
        );
      let captured: BoundedRunResult | undefined;
      const execute = vi
        .spyOn(runner, 'runBoundedCommand')
        .mockImplementation(async (input) => {
          const identity = {
            protocolVersion: 1 as const,
            runId: input.runId,
            executorId: createUlid(),
            commandDigest: runner.executionCommandDigest(
              input.projectRoot,
              input.argv,
              input.timeoutMs,
            ),
            startedAt: new Date().toISOString(),
            pid: process.pid,
            platform: process.platform,
          };
          await input.onReady?.(identity);
          captured = {
            identity,
            status: 'succeeded',
            started: true,
            exitCode: 0,
            signal: null,
            reason: null,
            startedAt: identity.startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: 1,
            outputTruncated: false,
            cleanupConfirmed: true,
            stdout:
              purpose === 'ci_observation'
                ? JSON.stringify({
                    provider: 'github',
                    repository: ci.repository,
                    candidateSha: sha,
                    testedSha: sha,
                    event: 'push',
                    observedAt: new Date().toISOString(),
                    status: 'passed',
                    reasons: [],
                    runs: [
                      {
                        runId: 10,
                        attempt: 1,
                        workflowId: 1,
                        workflowPath: ci.workflows[0]?.path ?? '',
                        configurationSha: 'a'.repeat(40),
                        headSha: sha,
                        status: 'completed',
                        conclusion: 'success',
                        jobs: [
                          {
                            id: 11,
                            name: 'test',
                            status: 'completed',
                            conclusion: 'success',
                          },
                        ],
                      },
                    ],
                  })
                : '',
            stderr: '',
          };
          return captured;
        });
      const actual = mutation.mutateV3Execution;
      const failWrite = vi
        .spyOn(mutation, 'mutateV3Execution')
        .mockImplementation((input) => {
          if (input.action.type === 'run.finish')
            throw new Error('simulated result transaction interruption');
          return actual(input);
        });
      expect(
        (
          await f.call(
            purpose === 'ci_observation' ? 'ci-observe' : 'run',
            purpose === 'ci_observation'
              ? { target }
              : { purpose, checkId: 'check' },
          )
        ).code,
      ).toBe(3);
      failWrite.mockRestore();
      if (!captured?.identity) throw new Error('fixture did not execute');
      vi.spyOn(runner, 'recoverBoundedRun').mockResolvedValue({
        state: 'terminal',
        result: captured,
      });
      const recovered = await f.call('run-recover', {
        runId: captured.identity.runId,
      });
      expect(recovered.code, recovered.output).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1);
      const saved = await f.store.readTaskSnapshot(f.taskRef);
      if (saved.verification.schemaVersion !== 2)
        throw new Error('expected V2');
      expect(saved.verification.execution.runs).toHaveLength(1);
      if (purpose === 'ci_observation')
        expect(saved.verification.execution.ciObservations).toHaveLength(1);
      expect(saved.verification.execution.runs[0]?.state).toBe('succeeded');
      expect(
        (await f.call('run', { purpose: 'verification', checkId: 'check' }))
          .code,
      ).toBe(3);
      const repeated = await f.call('run-recover', {
        runId: captured.identity.runId,
      });
      expect(repeated.code, repeated.output).toBe(0);
    },
  );
});

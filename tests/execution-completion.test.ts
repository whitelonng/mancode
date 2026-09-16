import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareExecutionCompletion } from '../src/context/execution-completion.js';
import type { ExecutionPolicy } from '../src/context/execution-ledger.js';
import { mutateV3Execution } from '../src/context/execution-mutation.js';
import { createUlid } from '../src/context/ids.js';
import * as delivery from '../src/context/man-delivery-runtime.js';
import * as runner from '../src/runtime/execution-runner.js';
import { openV3TaskOperation } from '../src/runtime/task-operation.js';
import { argv, fixture, policy, roots } from './helpers/execution-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe('fresh remote completion observation', () => {
  it('charges a fresh observation outside locks and accepts its last legal allowance', async () => {
    const remote: ExecutionPolicy = {
      ...policy,
      version: 1,
      delivery: 'remote_required',
      budget: { ...policy.budget, maxRuns: 2 },
      checks: [
        {
          id: 'check',
          acceptanceIds: ['AC-1'],
          argv,
          cwd: '.',
          surface: 'component',
        },
      ],
      ci: {
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
      },
    };
    const f = await fixture(true, remote as typeof policy);
    const inspect = delivery.inspectManDelivery;
    vi.spyOn(delivery, 'inspectManDelivery').mockImplementation(
      async (...args) => {
        const result = await inspect(...args);
        result.finalization.blockers = result.finalization.blockers.filter(
          (item) => item.code === 'execution_incomplete',
        );
        return result;
      },
    );
    const base = {
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.session.sessionId,
    };
    const mutate = async (
      action: Parameters<typeof mutateV3Execution>[0]['action'],
    ) =>
      mutateV3Execution({
        ...base,
        expectedTaskRevision: (await f.store.readTaskSnapshot(f.taskRef))
          .metadata.revision,
        action,
      });
    const runId = createUlid();
    await mutate({
      type: 'run.reserve',
      runId,
      purpose: 'verification',
      checkId: 'check',
      argv,
      cwd: '.',
    });
    const identity = {
      protocolVersion: 1 as const,
      runId,
      executorId: createUlid(),
      commandDigest: runner.executionCommandDigest(
        f.root,
        argv,
        policy.budget.commandTimeoutMs,
      ),
      startedAt: new Date().toISOString(),
      pid: 42,
      platform: 'fixture',
    };
    await mutate({
      type: 'run.finish',
      runId,
      result: {
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
        outputArtifactRef: null,
        summary: 'passed',
      },
    });
    const execute = vi
      .spyOn(runner, 'runBoundedCommand')
      .mockImplementation(async (input) => {
        // If completion retained its task lock, this nested public open cannot succeed.
        const opened = await openV3TaskOperation({
          ...base,
          expectedTaskRevision: (await f.store.readTaskSnapshot(f.taskRef))
            .metadata.revision,
        });
        await opened.release();
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
          pid: 43,
          platform: 'fixture',
        };
        await input.onReady?.(identity);
        const target = JSON.parse(input.argv[3] ?? 'null');
        const observation = {
          provider: 'github',
          repository: target.repository,
          candidateSha: target.candidateSha,
          testedSha: target.candidateSha,
          event: 'push',
          observedAt: new Date().toISOString(),
          status: 'passed',
          runs: [
            {
              runId: 10,
              attempt: 2,
              workflowId: 1,
              workflowPath: '.github/workflows/test.yml',
              configurationSha: 'a'.repeat(40),
              headSha: target.candidateSha,
              status: 'completed',
              conclusion: 'success',
              jobs: [
                {
                  id: 3,
                  name: 'test',
                  status: 'completed',
                  conclusion: 'success',
                },
              ],
            },
          ],
          reasons: [],
        };
        return {
          identity,
          status: 'succeeded',
          started: true,
          exitCode: 0,
          signal: null,
          reason: null,
          startedAt: identity.startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 10,
          outputTruncated: false,
          cleanupConfirmed: true,
          stdout: JSON.stringify(observation),
          stderr: '',
        };
      });
    const before = (await f.store.readTaskSnapshot(f.taskRef)).metadata
      .revision;
    const after = await prepareExecutionCompletion({
      ...base,
      expectedTaskRevision: before,
    });
    expect(after).toBeGreaterThan(before);
    expect(execute).toHaveBeenCalledOnce();
    const saved = await f.store.readTaskSnapshot(f.taskRef);
    expect(
      saved.verification.schemaVersion === 2 &&
        saved.verification.execution.runs.length,
    ).toBe(2);
    await expect(
      prepareExecutionCompletion({ ...base, expectedTaskRevision: after }),
    ).rejects.toThrow('CI_FRESH_OBSERVATION_BUDGET_REQUIRED');
    expect(execute).toHaveBeenCalledOnce();
  });
});

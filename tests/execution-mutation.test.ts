import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { assertExecutionWriterCapability } from '../src/context/compatibility.js';
import type { ExecutionPolicy } from '../src/context/execution-ledger.js';
import * as mutation from '../src/context/execution-mutation.js';
import { createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { parseVerificationLedger } from '../src/context/verification-ledger.js';
import { recordV3Verification } from '../src/context/verification-record.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { buildCiObserverArgv } from '../src/system/ci-observer.js';
import { argv, fixture, policy, roots } from './helpers/execution-fixture.js';
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('execution mutation persistence', () => {
  it('rejects fabricated CI executors at the authority reservation boundary', async () => {
    const f = await fixture();
    const before = await f.store.readTaskSnapshot(f.taskRef);
    await expect(
      mutation.mutateV3Execution({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.session.sessionId,
        expectedTaskRevision: before.metadata.revision,
        action: {
          type: 'run.reserve',
          purpose: 'ci_observation',
          argv: ['node', '-e', 'console.log("passed")'],
          cwd: '.',
        },
      }),
    ).rejects.toThrow('CI_OBSERVER_REQUIRED');
    expect((await f.store.readTaskSnapshot(f.taskRef)).metadata.revision).toBe(
      before.metadata.revision,
    );
  });

  it('binds CI observation registration to the observer reserved target', async () => {
    const ci: NonNullable<ExecutionPolicy['ci']> = {
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
    const f = await fixture(true, {
      ...policy,
      delivery: 'remote_required',
      ci,
    } as typeof policy);
    const before = await f.store.readTaskSnapshot(f.taskRef);
    const base = {
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.session.sessionId,
    };
    const target = {
      ...ci,
      candidateSha: 'b'.repeat(40),
      testedSha: 'b'.repeat(40),
    };
    const runId = createUlid();
    const reserved = await mutation.mutateV3Execution({
      ...base,
      expectedTaskRevision: before.metadata.revision,
      action: {
        type: 'run.reserve',
        purpose: 'ci_observation',
        runId,
        argv: buildCiObserverArgv(target, policy.budget.ciTimeoutMs),
        cwd: '.',
      },
    });
    await expect(
      mutation.mutateV3Execution({
        ...base,
        expectedTaskRevision: reserved.metadata.revision,
        action: {
          type: 'ci.observe',
          runId,
          target: { ...target, candidateSha: 'c'.repeat(40) },
          observation: {} as never,
        },
      }),
    ).rejects.toThrow('CI_TARGET_MISMATCH');
    expect((await f.store.readTaskSnapshot(f.taskRef)).metadata.revision).toBe(
      reserved.metadata.revision,
    );
  });
  it('creates explicit V2 and rejects legacy whole-ledger writes before any revision changes', async () => {
    const f = await fixture();
    const before = await f.store.readTaskSnapshot(f.taskRef);
    expect(before.verification.schemaVersion).toBe(2);
    expect(parseVerificationLedger(before.verification)).toEqual(
      before.verification,
    );
    await expect(
      recordV3Verification({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.session.sessionId,
        expectedTaskRevision: before.metadata.revision,
        verification: before.verification,
      }),
    ).rejects.toThrow('MANAGED_EVIDENCE_REQUIRED');
    expect((await f.store.readTaskSnapshot(f.taskRef)).metadata.revision).toBe(
      before.metadata.revision,
    );
    expect(() =>
      assertExecutionWriterCapability(2, ['verification-ledger:1'] as never),
    ).toThrow();
    expect(() => assertExecutionWriterCapability(1, [])).not.toThrow();
  });
  it('persists budget and rejects stale CAS and unauthorized mode opt-in', async () => {
    const f = await fixture();
    const before = await f.store.readTaskSnapshot(f.taskRef);
    const input = {
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.session.sessionId,
      expectedTaskRevision: before.metadata.revision,
      action: {
        type: 'run.reserve' as const,
        purpose: 'verification' as const,
        checkId: 'check',
        argv,
        cwd: '.',
      },
    };
    await mutation.mutateV3Execution(input);
    const reloaded = await new V3ContextStore(f.root).readTaskSnapshot(
      f.taskRef,
    );
    expect(
      reloaded.verification.schemaVersion === 2 &&
        reloaded.verification.execution.runs.length,
    ).toBe(1);
    await expect(mutation.mutateV3Execution(input)).rejects.toThrow();
    await expect(
      createV3Workflow({
        projectRoot: f.root,
        workflowMode: 'manba',
        task: 'invalid',
        sessionId: f.session.sessionId,
        client: 'vitest',
        executionPolicy: policy,
      }),
    ).rejects.toThrow('EXECUTION_DELIVERY_REQUIRED');
  });
});

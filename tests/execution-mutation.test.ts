import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { assertExecutionWriterCapability } from '../src/context/compatibility.js';
import * as mutation from '../src/context/execution-mutation.js';
import { V3ContextStore } from '../src/context/store.js';
import { parseVerificationLedger } from '../src/context/verification-ledger.js';
import { recordV3Verification } from '../src/context/verification-record.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { argv, fixture, policy, roots } from './helpers/execution-fixture.js';
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('execution mutation persistence', () => {
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

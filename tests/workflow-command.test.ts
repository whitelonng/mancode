import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import {
  EXIT_INVALID_ARG,
  EXIT_OK,
  workflow,
} from '../src/commands/workflow.js';
import { createWorkflow, readWorkflow } from '../src/system/workflow.js';

describe('mancode workflow command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-workflow-command-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await silentInit(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('workflow list is empty on initialized project', async () => {
    const logs = await captureLog(() => workflow(dir, 'list'));
    expect(logs.code).toBe(EXIT_OK);
    expect(logs.stdout.join('\n')).toContain('No workflows');
  });

  it('workflow create creates metadata through the command path', async () => {
    const logs = await captureLog(() =>
      workflow(dir, 'create', ['man', 'add', 'oauth', 'login'], {
        json: true,
      }),
    );
    const meta = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(meta.mode).toBe('man');
    expect(meta.task).toBe('add oauth login');
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      task: 'add oauth login',
      currentStep: 1,
    });
  });

  it('workflow update updates metadata through the command path', async () => {
    const meta = await createWorkflow(dir, 'fix login bug', 'man');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        step: '9',
        status: 'completed',
        skipped: 'film-1,film-2',
        json: true,
      }),
    );
    const updated = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(updated.currentStep).toBe(9);
    expect(updated.status).toBe('completed');
    expect(updated.skippedSteps).toEqual(['film-1', 'film-2']);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 9,
      status: 'completed',
      skippedSteps: ['film-1', 'film-2'],
    });
  });

  it('workflow update rejects steps beyond the workflow mode max', async () => {
    const meta = await createWorkflow(dir, 'plan only', 'mamba');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '8' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    expect(logs.stderr.join('\n')).toContain('invalid --step: 8');
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 1,
    });
  });

  it('workflow update rejects partially numeric steps', async () => {
    const meta = await createWorkflow(dir, 'invalid step', 'man');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '2garbage' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 1,
    });
  });

  it('workflow update rejects a blocking reason for a non-blocked status', async () => {
    const meta = await createWorkflow(dir, 'invalid blocking reason', 'man');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        status: 'completed',
        blockingReason: 'should not be ignored',
      }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      status: 'in_progress',
    });
  });

  it('workflow update increments plan versions exactly once', async () => {
    const meta = await createWorkflow(dir, 'revise plan', 'man');

    const updated = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        step: '4',
        planVersion: '2',
        json: true,
      }),
    );
    const skipped = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { planVersion: '4' }),
    );

    expect(updated.code).toBe(EXIT_OK);
    expect(skipped.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      planVersion: 2,
    });
  });

  it('workflow update rejects plan revisions before the step 4 gate', async () => {
    const meta = await createWorkflow(dir, 'premature revision', 'man');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { planVersion: '2' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 1,
      planVersion: 1,
    });
  });

  it('workflow show and update reject invalid task ids', async () => {
    const showLogs = await captureLog(() =>
      workflow(dir, 'show', ['../../outside']),
    );
    const updateLogs = await captureLog(() =>
      workflow(dir, 'update', ['../../outside'], { step: '2' }),
    );

    expect(showLogs.code).toBe(EXIT_INVALID_ARG);
    expect(showLogs.stderr.join('\n')).toContain('invalid taskId');
    expect(updateLogs.code).toBe(EXIT_INVALID_ARG);
    expect(updateLogs.stderr.join('\n')).toContain('invalid taskId');
  });

  it('adds Active Plans only after the plan reaches the step 4 gate', async () => {
    const meta = await createWorkflow(dir, 'plan timing', 'man');
    await workflow(dir, 'update', [meta.taskId], { step: '3' });

    const before = await readFile(
      path.join(dir, '.mancode', 'memory', 'spec.md'),
      'utf-8',
    );
    expect(before).not.toContain(meta.taskId);

    await workflow(dir, 'update', [meta.taskId], { step: '4' });
    const after = await readFile(
      path.join(dir, '.mancode', 'memory', 'spec.md'),
      'utf-8',
    );
    expect(after).toContain(meta.taskId);
  });

  it('workflow list shows created workflow', async () => {
    const meta = await createWorkflow(dir, 'add oauth login', 'man');

    const logs = await captureLog(() => workflow(dir, 'list'));

    expect(logs.code).toBe(EXIT_OK);
    const output = logs.stdout.join('\n');
    expect(output).toContain('mancode workflows');
    expect(output).toContain(meta.taskId);
    expect(output).toContain('man');
    expect(output).toContain('in_progress');
    expect(output).toContain('Step 1/9');
    expect(output).toContain('plan=v1');
  });

  it('workflow show displays metadata for existing workflow', async () => {
    const meta = await createWorkflow(dir, 'fix login bug', 'mamba');

    const logs = await captureLog(() => workflow(dir, 'show', [meta.taskId]));

    expect(logs.code).toBe(EXIT_OK);
    const output = logs.stdout.join('\n');
    expect(output).toContain(`Workflow:    ${meta.taskId}`);
    expect(output).toContain('Task:        fix login bug');
    expect(output).toContain('Mode:        mamba');
  });

  it('workflow show displays the current plan version for governed workflows', async () => {
    const meta = await createWorkflow(dir, 'plan visibility', 'man');

    const logs = await captureLog(() => workflow(dir, 'show', [meta.taskId]));

    expect(logs.code).toBe(EXIT_OK);
    expect(logs.stdout.join('\n')).toContain('Plan version: 1');
  });

  it('workflow show --json includes active child workflows', async () => {
    const parent = await createWorkflow(dir, 'parent task', 'man');
    await workflow(dir, 'update', [parent.taskId], { step: '6' });
    const child = await createWorkflow(dir, 'child task', 'mamba', {
      parentTaskId: parent.taskId,
    });

    const logs = await captureLog(() =>
      workflow(dir, 'show', [parent.taskId], { json: true }),
    );
    const shown = JSON.parse(logs.stdout.join('\n'));

    expect(shown.activeChildren).toHaveLength(1);
    expect(shown.activeChildren[0].taskId).toBe(child.taskId);
  });

  it('creates and completes linked mamba workflows through the CLI contract', async () => {
    const parentLogs = await captureLog(() =>
      workflow(dir, 'create', ['man', 'parent', 'implementation'], {
        json: true,
      }),
    );
    const parent = JSON.parse(parentLogs.stdout.join('\n'));
    await captureLog(() =>
      workflow(dir, 'update', [parent.taskId], { step: '6' }),
    );

    const childLogs = await captureLog(() =>
      workflow(dir, 'create', ['mamba', 'verify', 'regression'], {
        parentTask: parent.taskId,
        json: true,
      }),
    );
    const child = JSON.parse(childLogs.stdout.join('\n'));
    const completedLogs = await captureLog(() =>
      workflow(dir, 'update', [child.taskId], {
        step: '5',
        status: 'completed',
        outcome: 'verified',
        json: true,
      }),
    );
    const completed = JSON.parse(completedLogs.stdout.join('\n'));

    expect(childLogs.code).toBe(EXIT_OK);
    expect(child.parentTaskId).toBe(parent.taskId);
    expect(completedLogs.code).toBe(EXIT_OK);
    expect(completed).toMatchObject({
      status: 'completed',
      outcome: 'verified',
      currentStep: 5,
    });
  });

  it('accepts every documented standalone mamba outcome through the CLI', async () => {
    for (const outcome of [
      'fixed',
      'verified',
      'no_repro',
      'manual_test_required',
    ]) {
      const createdLogs = await captureLog(() =>
        workflow(dir, 'create', ['mamba', `outcome-${outcome}`], {
          json: true,
        }),
      );
      const created = JSON.parse(createdLogs.stdout.join('\n'));
      const updatedLogs = await captureLog(() =>
        workflow(dir, 'update', [created.taskId], {
          step: '5',
          status: 'completed',
          outcome,
          json: true,
        }),
      );
      const updated = JSON.parse(updatedLogs.stdout.join('\n'));

      expect(updatedLogs.code).toBe(EXIT_OK);
      expect(updated.outcome).toBe(outcome);
    }
  });

  it('propagates a CLI-blocked mamba child to its parent', async () => {
    const parent = await createWorkflow(dir, 'parent for blocked child', 'man');
    await captureLog(() =>
      workflow(dir, 'update', [parent.taskId], { step: '6' }),
    );
    const childLogs = await captureLog(() =>
      workflow(dir, 'create', ['mamba', 'blocked-child'], {
        parentTask: parent.taskId,
        json: true,
      }),
    );
    const child = JSON.parse(childLogs.stdout.join('\n'));

    const blockedLogs = await captureLog(() =>
      workflow(dir, 'update', [child.taskId], {
        status: 'blocked',
        blockingReason: 'missing test account',
      }),
    );

    expect(blockedLogs.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, parent.taskId)).resolves.toMatchObject({
      status: 'blocked',
      blockingReason: expect.stringContaining(child.taskId),
    });
  });

  it('workflow show returns invalid arg for missing workflow', async () => {
    const logs = await captureLog(() => workflow(dir, 'show', ['nope']));

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    expect(logs.stderr.join('\n')).toContain('Workflow not found');
  });

  it('workflow clean --dry-run does not delete files', async () => {
    const meta = await createWorkflow(dir, 'temp cleanup task', 'man');
    await rewriteMetadata(dir, { ...meta, status: 'completed' });

    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { dryRun: true }),
    );

    expect(logs.code).toBe(EXIT_OK);
    expect(logs.stdout.join('\n')).toContain('Would remove 1 workflow');
    expect(await readWorkflow(dir, meta.taskId)).not.toBeNull();
  });

  it('workflow clean --older-than 30d only deletes old workflows', async () => {
    const oldMeta = await createWorkflow(dir, 'old task', 'man');
    const recentMeta = await createWorkflow(dir, 'recent task', 'man');
    await rewriteMetadata(dir, {
      ...oldMeta,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await rewriteMetadata(dir, { ...recentMeta, status: 'completed' });

    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { olderThan: '30d' }),
    );

    expect(logs.code).toBe(EXIT_OK);
    expect(await readWorkflow(dir, oldMeta.taskId)).toBeNull();
    expect(await readWorkflow(dir, recentMeta.taskId)).not.toBeNull();
  });

  it('workflow clean preserves planned and blocked workflows', async () => {
    const planned = await createWorkflow(dir, 'saved plan', 'man');
    await workflow(dir, 'update', [planned.taskId], {
      step: '4',
      status: 'planned',
    });
    const blocked = await createWorkflow(dir, 'blocked diagnosis', 'mamba');
    await workflow(dir, 'update', [blocked.taskId], {
      status: 'blocked',
      blockingReason: 'missing environment',
    });

    const logs = await captureLog(() => workflow(dir, 'clean'));

    expect(logs.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, planned.taskId)).resolves.not.toBeNull();
    await expect(readWorkflow(dir, blocked.taskId)).resolves.not.toBeNull();
  });

  it('workflow clean reports only workflows it actually removes', async () => {
    const parent = await createWorkflow(
      dir,
      'corrupted terminal parent',
      'man',
    );
    await workflow(dir, 'update', [parent.taskId], { step: '6' });
    await createWorkflow(dir, 'active child', 'mamba', {
      parentTaskId: parent.taskId,
    });
    await rewriteMetadata(dir, {
      ...parent,
      currentStep: 6,
      status: 'completed',
    });

    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { json: true }),
    );
    const result = JSON.parse(logs.stdout.join('\n'));

    expect(result.count).toBe(0);
    expect(result.workflows).toEqual([]);
    await expect(readWorkflow(dir, parent.taskId)).resolves.not.toBeNull();
  });

  it('workflow clean does not orphan a newer terminal child', async () => {
    const parent = await createWorkflow(dir, 'old completed parent', 'man');
    await workflow(dir, 'update', [parent.taskId], { step: '6' });
    const child = await createWorkflow(dir, 'recent completed child', 'mamba', {
      parentTaskId: parent.taskId,
    });
    await rewriteMetadata(dir, {
      ...parent,
      currentStep: 9,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await rewriteMetadata(dir, {
      ...child,
      currentStep: 5,
      status: 'completed',
      outcome: 'verified',
    });

    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { olderThan: '30d', json: true }),
    );
    const result = JSON.parse(logs.stdout.join('\n'));

    expect(result.count).toBe(0);
    await expect(readWorkflow(dir, parent.taskId)).resolves.not.toBeNull();
    await expect(readWorkflow(dir, child.taskId)).resolves.not.toBeNull();
  });

  it('workflow list --json outputs valid JSON', async () => {
    const meta = await createWorkflow(dir, 'json task', 'mamba');

    const logs = await captureLog(() =>
      workflow(dir, 'list', [], { json: true }),
    );
    const parsed = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].taskId).toBe(meta.taskId);
    expect(parsed[0].mode).toBe('mamba');
  });

  it('workflow clean rejects invalid --older-than duration', async () => {
    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { olderThan: 'forever' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    expect(logs.stderr.join('\n')).toContain('Invalid --older-than');
  });
});

async function silentInit(dir: string): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await init(dir);
    if (code !== 0) throw new Error(`silentInit failed: ${code}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function rewriteMetadata(
  dir: string,
  meta: Awaited<ReturnType<typeof createWorkflow>>,
): Promise<void> {
  await writeFile(
    path.join(dir, '.mancode', 'workflows', meta.taskId, 'metadata.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf-8',
  );
}

async function captureLog(
  fn: () => Promise<number>,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

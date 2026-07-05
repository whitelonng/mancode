import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
      workflow(dir, 'create', ['man8', 'add', 'oauth', 'login'], {
        json: true,
      }),
    );
    const meta = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(meta.mode).toBe('man8');
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
        step: '5',
        status: 'completed',
        skipped: 'film-1,film-2',
        json: true,
      }),
    );
    const updated = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(updated.currentStep).toBe(5);
    expect(updated.status).toBe('completed');
    expect(updated.skippedSteps).toEqual(['film-1', 'film-2']);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 5,
      status: 'completed',
      skippedSteps: ['film-1', 'film-2'],
    });
  });

  it('workflow update rejects steps beyond the workflow mode max', async () => {
    const meta = await createWorkflow(dir, 'plan only', 'man8');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '8' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    expect(logs.stderr.join('\n')).toContain('invalid --step: 8');
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 1,
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

  it('workflow list shows created workflow', async () => {
    const meta = await createWorkflow(dir, 'add oauth login', 'man');

    const logs = await captureLog(() => workflow(dir, 'list'));

    expect(logs.code).toBe(EXIT_OK);
    const output = logs.stdout.join('\n');
    expect(output).toContain('mancode workflows');
    expect(output).toContain(meta.taskId);
    expect(output).toContain('man');
    expect(output).toContain('in_progress');
    expect(output).toContain('Step 1/8');
  });

  it('workflow show displays metadata for existing workflow', async () => {
    const meta = await createWorkflow(dir, 'fix login bug', 'man8');

    const logs = await captureLog(() => workflow(dir, 'show', [meta.taskId]));

    expect(logs.code).toBe(EXIT_OK);
    const output = logs.stdout.join('\n');
    expect(output).toContain(`Workflow:    ${meta.taskId}`);
    expect(output).toContain('Task:        fix login bug');
    expect(output).toContain('Mode:        man8');
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

  it('workflow list --json outputs valid JSON', async () => {
    const meta = await createWorkflow(dir, 'json task', 'man8');

    const logs = await captureLog(() =>
      workflow(dir, 'list', [], { json: true }),
    );
    const parsed = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].taskId).toBe(meta.taskId);
    expect(parsed[0].mode).toBe('man8');
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

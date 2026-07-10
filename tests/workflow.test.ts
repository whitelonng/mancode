import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflow,
  deleteWorkflow,
  generateTaskId,
  isValidWorkflowTaskId,
  listWorkflows,
  readWorkflow,
  updateWorkflow,
} from '../src/system/workflow.js';

describe('workflow helpers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-workflow-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  describe('generateTaskId', () => {
    it('formats as YYYYMMDD-HHMMSS-<slug>', () => {
      const id = generateTaskId(
        'add OAuth login button',
        new Date('2026-06-28T14:30:00.000Z'),
      );
      // 注意时区：本地时间可能比 UTC 偏移，这里只校验结构
      expect(id).toMatch(/^2026062[89]-\d{6}-add-oauth-login-button$/);
    });

    it('truncates slug to 30 chars', () => {
      const longTask =
        'this is a really long task description that should be truncated to thirty characters max';
      const id = generateTaskId(longTask, new Date('2026-06-28T14:30:00.000Z'));
      const slug = id.split('-').slice(2).join('-');
      expect(slug.length).toBeLessThanOrEqual(30);
    });

    it('falls back to "task" for empty/non-latin input', () => {
      const id = generateTaskId('???', new Date('2026-06-28T14:30:00.000Z'));
      expect(id).toMatch(/-task$/);
    });
  });

  describe('createWorkflow', () => {
    it('creates directory and metadata.json with initial state', async () => {
      const meta = await createWorkflow(dir, 'add oauth', 'man');

      expect(meta.taskId).toBeTruthy();
      expect(meta.task).toBe('add oauth');
      expect(meta.mode).toBe('man');
      expect(meta.planVersion).toBe(1);
      expect(meta.currentStep).toBe(1);
      expect(meta.skippedSteps).toEqual([]);
      expect(meta.status).toBe('in_progress');

      const metaPath = path.join(
        dir,
        '.mancode',
        'workflows',
        meta.taskId,
        'metadata.json',
      );
      const raw = await readFile(metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.task).toBe('add oauth');
    });

    it('allocates a unique id for duplicate tasks created in the same second', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-28T14:30:00.000Z'));

      const first = await createWorkflow(dir, 'same task', 'man');
      const second = await createWorkflow(dir, 'same task', 'man');

      expect(first.taskId).toMatch(/-same-task$/);
      expect(second.taskId).toBe(`${first.taskId}-2`);
      expect(await readWorkflow(dir, first.taskId)).not.toBeNull();
      expect(await readWorkflow(dir, second.taskId)).not.toBeNull();
    });
  });

  describe('readWorkflow', () => {
    it('rejects task ids that could escape the workflow directory', async () => {
      const outsideDir = path.join(dir, '.mancode', 'outside');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(
        path.join(outsideDir, 'metadata.json'),
        JSON.stringify(
          {
            task: 'outside',
            mode: 'man',
            currentStep: 1,
            skippedSteps: [],
            startedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            status: 'in_progress',
          },
          null,
          2,
        ),
        'utf-8',
      );

      await expect(readWorkflow(dir, '../../outside')).resolves.toBeNull();
    });

    it('returns null when workflow does not exist', async () => {
      const result = await readWorkflow(dir, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns metadata when workflow exists', async () => {
      const created = await createWorkflow(dir, 'fix bug', 'man');
      const result = await readWorkflow(dir, created.taskId);
      expect(result?.taskId).toBe(created.taskId);
      expect(result?.task).toBe('fix bug');
      expect(result?.mode).toBe('man');
    });

    it('supports manteam workflow metadata', async () => {
      const created = await createWorkflow(dir, 'coordinate login', 'manteam');
      const result = await readWorkflow(dir, created.taskId);
      expect(result?.mode).toBe('manteam');
      expect(result?.planVersion).toBe(1);
    });

    it('creates mamba children only for man workflows', async () => {
      const parent = await createWorkflow(dir, 'implement login', 'man');
      await updateWorkflow(dir, parent.taskId, { currentStep: 6 });
      const child = await createWorkflow(dir, 'diagnose login', 'mamba', {
        parentTaskId: parent.taskId,
      });

      expect(child.parentTaskId).toBe(parent.taskId);
      await expect(
        createWorkflow(dir, 'invalid child', 'man', {
          parentTaskId: parent.taskId,
        }),
      ).rejects.toThrow(/only mamba/);
    });

    it('rejects a mamba child unless its parent is active at step 6', async () => {
      const parent = await createWorkflow(dir, 'implement login', 'man');

      await expect(
        createWorkflow(dir, 'too early', 'mamba', {
          parentTaskId: parent.taskId,
        }),
      ).rejects.toThrow(/step 6/);

      await updateWorkflow(dir, parent.taskId, {
        currentStep: 9,
        status: 'completed',
      });
      await expect(
        createWorkflow(dir, 'too late', 'mamba', {
          parentTaskId: parent.taskId,
        }),
      ).rejects.toThrow(/step 6/);
    });

    it('returns null for malformed metadata', async () => {
      // 模拟一个坏的 metadata
      const workflowDir = path.join(
        dir,
        '.mancode',
        'workflows',
        'broken-task',
      );
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, 'metadata.json'),
        'this is not json',
        'utf-8',
      );
      const result = await readWorkflow(dir, 'broken-task');
      expect(result).toBeNull();
    });

    it('rejects mode-specific invalid metadata shapes', async () => {
      const created = await createWorkflow(dir, 'invalid shape', 'mamba');
      const metadataPath = path.join(
        dir,
        '.mancode',
        'workflows',
        created.taskId,
        'metadata.json',
      );
      await writeFile(
        metadataPath,
        `${JSON.stringify({ ...created, planVersion: 1 }, null, 2)}\n`,
        'utf-8',
      );

      await expect(readWorkflow(dir, created.taskId)).resolves.toBeNull();
    });
  });

  describe('updateWorkflow', () => {
    it('rejects invalid task ids before reading or writing metadata', async () => {
      const outsideDir = path.join(dir, '.mancode', 'outside');
      await mkdir(outsideDir, { recursive: true });
      const metadataPath = path.join(outsideDir, 'metadata.json');
      const metadata = JSON.stringify(
        {
          task: 'outside',
          mode: 'man',
          currentStep: 1,
          skippedSteps: [],
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          status: 'in_progress',
        },
        null,
        2,
      );
      await writeFile(metadataPath, metadata, 'utf-8');

      await expect(
        updateWorkflow(dir, '../../outside', { currentStep: 2 }),
      ).rejects.toThrow(/invalid workflow taskId/);
      await expect(readFile(metadataPath, 'utf-8')).resolves.toBe(metadata);
    });

    it('merges patch and refreshes updatedAt', async () => {
      const created = await createWorkflow(dir, 'task a', 'man');
      const originalUpdatedAt = created.updatedAt;

      // 等待一毫秒保证 timestamp 不同
      await new Promise((resolve) => setTimeout(resolve, 5));

      await updateWorkflow(dir, created.taskId, {
        currentStep: 3,
        skippedSteps: ['warmup-drill'],
      });

      const result = await readWorkflow(dir, created.taskId);
      expect(result?.currentStep).toBe(3);
      expect(result?.skippedSteps).toEqual(['warmup-drill']);
      expect(result?.updatedAt).not.toBe(originalUpdatedAt);
      // startedAt 不变
      expect(result?.startedAt).toBe(created.startedAt);
    });

    it('enforces status transitions and mamba outcomes', async () => {
      const mamba = await createWorkflow(dir, 'verify login', 'mamba');

      await expect(
        updateWorkflow(dir, mamba.taskId, {
          currentStep: 5,
          status: 'completed',
        }),
      ).rejects.toThrow(/require an outcome/);
      await expect(
        updateWorkflow(dir, mamba.taskId, { status: 'blocked' }),
      ).rejects.toThrow(/blocking reason/);
      await expect(
        updateWorkflow(dir, mamba.taskId, { outcome: 'verified' }),
      ).rejects.toThrow(/only be set on completed/);

      await updateWorkflow(dir, mamba.taskId, {
        status: 'blocked',
        blockingReason: 'test environment unavailable',
      });
      await updateWorkflow(dir, mamba.taskId, { status: 'abandoned' });
      const abandoned = await readWorkflow(dir, mamba.taskId);
      expect(abandoned?.blockingReason).toBeUndefined();

      const retry = await createWorkflow(dir, 'retry verification', 'mamba');
      await updateWorkflow(dir, retry.taskId, {
        status: 'blocked',
        blockingReason: 'test environment unavailable',
      });
      await updateWorkflow(dir, retry.taskId, {
        status: 'in_progress',
      });
      await updateWorkflow(dir, retry.taskId, {
        currentStep: 5,
        status: 'completed',
        outcome: 'verified',
      });

      await expect(
        updateWorkflow(dir, retry.taskId, { status: 'in_progress' }),
      ).rejects.toThrow(/invalid workflow status transition/);
    });

    it('does not finish a parent with an active mamba child', async () => {
      const parent = await createWorkflow(dir, 'implement login', 'man');
      await updateWorkflow(dir, parent.taskId, { currentStep: 6 });
      await createWorkflow(dir, 'diagnose login', 'mamba', {
        parentTaskId: parent.taskId,
      });

      await expect(
        updateWorkflow(dir, parent.taskId, {
          currentStep: 9,
          status: 'completed',
        }),
      ).rejects.toThrow(/active mamba child/);
    });

    it('rejects lifecycle states before their required workflow step', async () => {
      const man = await createWorkflow(dir, 'early finish', 'man');
      const mamba = await createWorkflow(dir, 'early diagnosis', 'mamba');

      await expect(
        updateWorkflow(dir, man.taskId, { status: 'planned' }),
      ).rejects.toThrow(/step 4/);
      await expect(
        updateWorkflow(dir, man.taskId, {
          status: 'completed',
          currentStep: 8,
        }),
      ).rejects.toThrow(/step 9/);
      await expect(
        updateWorkflow(dir, mamba.taskId, {
          status: 'completed',
          currentStep: 4,
          outcome: 'verified',
        }),
      ).rejects.toThrow(/step 5/);
    });

    it('rejects malformed skipped steps and non-sequential plan versions', async () => {
      const man = await createWorkflow(dir, 'validate metadata patch', 'man');

      await expect(
        updateWorkflow(dir, man.taskId, {
          skippedSteps: [1] as unknown as string[],
        }),
      ).rejects.toThrow(/skipped steps/);
      await expect(
        updateWorkflow(dir, man.taskId, { planVersion: 3 }),
      ).rejects.toThrow(/increase exactly once/);
    });

    it('propagates a blocked child to its parent and removes Active Plans', async () => {
      const parent = await createWorkflow(dir, 'implement login', 'man');
      await updateWorkflow(dir, parent.taskId, { currentStep: 6 });
      const child = await createWorkflow(dir, 'diagnose login', 'mamba', {
        parentTaskId: parent.taskId,
      });

      await updateWorkflow(dir, child.taskId, {
        status: 'blocked',
        blockingReason: 'test environment missing',
      });

      await expect(readWorkflow(dir, parent.taskId)).resolves.toMatchObject({
        status: 'blocked',
        blockingReason: expect.stringContaining(child.taskId),
      });
      const spec = await readFile(
        path.join(dir, '.mancode', 'memory', 'spec.md'),
        'utf-8',
      );
      expect(spec).not.toContain(parent.taskId);
    });

    it('allows an explicitly resolved child to resume its blocked parent', async () => {
      const parent = await createWorkflow(dir, 'implement recovery', 'man');
      await updateWorkflow(dir, parent.taskId, { currentStep: 6 });
      const child = await createWorkflow(dir, 'diagnose recovery', 'mamba', {
        parentTaskId: parent.taskId,
      });
      await updateWorkflow(dir, child.taskId, {
        status: 'blocked',
        blockingReason: 'temporary test outage',
      });

      await updateWorkflow(dir, child.taskId, { status: 'in_progress' });
      await updateWorkflow(dir, child.taskId, {
        currentStep: 5,
        status: 'completed',
        outcome: 'fixed',
      });
      await updateWorkflow(dir, parent.taskId, { status: 'in_progress' });

      await expect(readWorkflow(dir, parent.taskId)).resolves.toMatchObject({
        currentStep: 6,
        status: 'in_progress',
      });
      expect((await readWorkflow(dir, parent.taskId))?.blockingReason).toBe(
        undefined,
      );
    });

    it('propagates a manual-test-required child outcome to its parent', async () => {
      const parent = await createWorkflow(dir, 'implement checkout', 'man');
      await updateWorkflow(dir, parent.taskId, { currentStep: 6 });
      const child = await createWorkflow(dir, 'verify checkout', 'mamba', {
        parentTaskId: parent.taskId,
      });

      await updateWorkflow(dir, child.taskId, {
        currentStep: 5,
        status: 'completed',
        outcome: 'manual_test_required',
      });

      await expect(readWorkflow(dir, parent.taskId)).resolves.toMatchObject({
        status: 'blocked',
        blockingReason: expect.stringContaining('requires manual testing'),
      });
    });

    it('throws when workflow does not exist', async () => {
      await expect(
        updateWorkflow(dir, 'nonexistent', { currentStep: 2 }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('listWorkflows', () => {
    it('returns empty array when workflows dir does not exist', async () => {
      const result = await listWorkflows(dir);
      expect(result).toEqual([]);
    });

    it('lists workflows sorted by startedAt descending', async () => {
      // 创建 3 个 workflow，时间从早到晚
      const a = await createWorkflow(dir, 'task a', 'mamba');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const b = await createWorkflow(dir, 'task b', 'man');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const c = await createWorkflow(dir, 'task c', 'man');

      const result = await listWorkflows(dir);
      expect(result).toHaveLength(3);
      expect(result[0].taskId).toBe(c.taskId);
      expect(result[1].taskId).toBe(b.taskId);
      expect(result[2].taskId).toBe(a.taskId);
    });
  });

  describe('deleteWorkflow', () => {
    it('rejects invalid task ids instead of deleting outside directories', async () => {
      const outsideDir = path.join(dir, '.mancode', 'outside');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(path.join(outsideDir, 'metadata.json'), '{}', 'utf-8');

      await expect(deleteWorkflow(dir, '../../outside')).resolves.toBe(false);
      await expect(
        readFile(path.join(outsideDir, 'metadata.json'), 'utf-8'),
      ).resolves.toBe('{}');
    });

    it('removes workflow directory', async () => {
      const created = await createWorkflow(dir, 'temp task', 'mamba');
      const removed = await deleteWorkflow(dir, created.taskId);
      expect(removed).toBe(true);

      const after = await readWorkflow(dir, created.taskId);
      expect(after).toBeNull();
    });

    it('returns false when workflow does not exist', async () => {
      const removed = await deleteWorkflow(dir, 'nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('isValidWorkflowTaskId', () => {
    it('accepts generated task id shape and rejects path traversal', () => {
      expect(isValidWorkflowTaskId('20260705-120000-add-login-2')).toBe(true);
      expect(isValidWorkflowTaskId('../../outside')).toBe(false);
      expect(isValidWorkflowTaskId('/tmp/outside')).toBe(false);
      expect(isValidWorkflowTaskId('task/child')).toBe(false);
      expect(isValidWorkflowTaskId('.hidden')).toBe(false);
    });
  });
});

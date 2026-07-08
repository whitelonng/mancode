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
      const meta = await createWorkflow(dir, 'add oauth', 'man8');

      expect(meta.taskId).toBeTruthy();
      expect(meta.task).toBe('add oauth');
      expect(meta.mode).toBe('man8');
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
      const a = await createWorkflow(dir, 'task a', 'man8');
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
      const created = await createWorkflow(dir, 'temp task', 'man8');
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

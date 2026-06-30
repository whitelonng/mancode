import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendTeamDecision,
  ensureTeamMemory,
} from '../src/system/team-memory.js';

describe('team memory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-team-memory-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates durable team memory files', async () => {
    const summary = await ensureTeamMemory(dir);

    await expect(readFile(summary.files.prd, 'utf-8')).resolves.toContain(
      'Product Requirements',
    );
    await expect(readFile(summary.files.spec, 'utf-8')).resolves.toContain(
      'Technical Spec',
    );
    await expect(readFile(summary.files.decisions, 'utf-8')).resolves.toContain(
      'Architecture Decisions',
    );
  });

  it('does not overwrite existing memory files', async () => {
    const memoryDir = path.join(dir, '.mancode', 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'prd.md'), '# Custom PRD\n', 'utf-8');

    await ensureTeamMemory(dir);

    const prd = await readFile(path.join(memoryDir, 'prd.md'), 'utf-8');
    expect(prd).toBe('# Custom PRD\n');
  });

  it('appends team decisions', async () => {
    await appendTeamDecision(dir, {
      title: 'Use shadcn/ui',
      decision: 'Keep the existing component library.',
      context: 'MVP-2 UI consistency',
      taskId: '20260629-task',
      date: new Date('2026-06-29T00:00:00.000Z'),
    });

    const decisions = await readFile(
      path.join(dir, '.mancode', 'memory', 'decisions.md'),
      'utf-8',
    );
    expect(decisions).toContain('2026-06-29: Use shadcn/ui');
    expect(decisions).toContain('Keep the existing component library.');
    expect(decisions).toContain('20260629-task');
  });
});

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

  it('preserves concurrent team decision appends', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        appendTeamDecision(dir, {
          title: `Decision ${index}`,
          decision: `Keep decision ${index}.`,
          date: new Date('2026-06-29T00:00:00.000Z'),
        }),
      ),
    );

    const decisions = await readFile(
      path.join(dir, '.mancode', 'memory', 'decisions.md'),
      'utf-8',
    );
    for (let index = 0; index < 10; index++) {
      expect(decisions).toContain(`2026-06-29: Decision ${index}`);
      expect(decisions).toContain(`Keep decision ${index}.`);
    }
  });

  it('does not overwrite decisions already appended by a concurrent caller', async () => {
    // Simulates the fresh-repo race: another caller already created
    // decisions.md and appended an ADR. ensureTeamMemory's writeIfMissing
    // (wx flag) must skip the existing file rather than clobber it.
    const memoryDir = path.join(dir, '.mancode', 'memory');
    await mkdir(memoryDir, { recursive: true });
    const decisionsPath = path.join(memoryDir, 'decisions.md');
    await writeFile(
      decisionsPath,
      '# Architecture Decisions\n\n## 2026-06-29: Existing ADR\n\n- Decision: pre-existing\n',
      'utf-8',
    );

    await ensureTeamMemory(dir);

    const decisions = await readFile(decisionsPath, 'utf-8');
    expect(decisions).toContain('Existing ADR');
    expect(decisions).toContain('pre-existing');
    // Template body must not overwrite the existing content
    expect(decisions).not.toContain(
      'Record team decisions as dated ADR-style notes',
    );
  });

  it('preserves all decisions across 50 concurrent appends on a fresh repo', async () => {
    // Higher concurrency increases scheduling interleaving probability,
    // providing stronger (though not strictly deterministic) coverage
    // than the 10-append test above.
    const count = 50;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        appendTeamDecision(dir, {
          title: `Decision ${index}`,
          decision: `Content ${index}`,
          date: new Date('2026-06-29T00:00:00.000Z'),
        }),
      ),
    );

    const decisions = await readFile(
      path.join(dir, '.mancode', 'memory', 'decisions.md'),
      'utf-8',
    );
    for (let index = 0; index < count; index++) {
      expect(decisions).toContain(`Decision ${index}`);
      expect(decisions).toContain(`Content ${index}`);
    }
  });
});

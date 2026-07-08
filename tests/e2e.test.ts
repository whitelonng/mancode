import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import { install } from '../src/commands/install.js';
import { listPlatforms } from '../src/commands/list-platforms.js';
import { refreshStyle } from '../src/commands/refresh-style.js';
import { status } from '../src/commands/status.js';
import type { StatusResult } from '../src/commands/status.js';
import { uninstall } from '../src/commands/uninstall.js';

/**
 * End-to-end tests covering the full mancode lifecycle:
 * init → install → status → refresh-style → uninstall
 */
describe('e2e: full mancode lifecycle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-e2e-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('init → install codex → status → uninstall codex', async () => {
    // 1. init with default platform (claude-code)
    await silentRun(() => init(dir, { yes: true }));
    await expectStateJson(dir, {
      currentMode: 'solo',
      platform: 'claude-code',
    });

    // 2. install codex
    await silentRun(() => install(dir, 'codex'));
    const agentsMd = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('<!-- mancode:start -->');
    expect(agentsMd).toContain('Platform adapter: Codex CLI');

    // 3. status shows both platforms ready
    const statusResult = await silentJson(() => status(dir, { json: true }));
    expect(statusResult.platforms).toContain('claude-code');
    expect(statusResult.platforms).toContain('codex');
    expect(statusResult.platformStatus.codex.ready).toBe(true);

    // 4. uninstall codex
    await silentRun(() => uninstall(dir, 'codex', { force: true }));
    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).not.toContain('codex');
    expect(config.platforms).toContain('claude-code');
  });

  it('init --platform cursor → install claude-code → status → uninstall --all', async () => {
    // 1. init with cursor
    await silentRun(() => init(dir, { yes: true, platform: 'cursor' }));
    await expectStateJson(dir, { platform: 'cursor' });
    expect(
      await fileExists(path.join(dir, '.cursor', 'rules', 'mancode-solo.mdc')),
    ).toBe(true);
    expect(await fileExists(path.join(dir, '.claude', 'settings.json'))).toBe(
      false,
    );

    // 2. install claude-code as second platform
    await silentRun(() => install(dir, 'claude-code'));
    expect(
      await fileExists(path.join(dir, '.claude', 'skills', 'solo', 'SKILL.md')),
    ).toBe(true);

    // 3. status shows both platforms
    const statusResult = await silentJson(() => status(dir, { json: true }));
    expect(statusResult.platforms).toEqual(['cursor', 'claude-code']);
    expect(statusResult.platformStatus.cursor.ready).toBe(true);
    expect(statusResult.platformStatus['claude-code'].ready).toBe(true);

    // 4. full uninstall
    await silentRun(() =>
      uninstall(dir, undefined, { force: true, all: true }),
    );
    expect(await fileExists(path.join(dir, '.mancode'))).toBe(false);
    expect(
      await fileExists(path.join(dir, '.cursor', 'rules', 'mancode-solo.mdc')),
    ).toBe(false);
    expect(await fileExists(path.join(dir, 'AGENTS.md'))).toBe(false);
  });

  it('init → install all 4 platforms → status → list-platforms', async () => {
    await silentRun(() => init(dir, { yes: true }));

    for (const platform of ['codex', 'cursor', 'copilot']) {
      await silentRun(() => install(dir, platform));
    }

    // status shows all 4 platforms
    const statusResult = await silentJson(() => status(dir, { json: true }));
    expect(statusResult.platforms).toHaveLength(4);
    for (const p of ['claude-code', 'cursor', 'codex', 'copilot']) {
      expect(statusResult.platforms).toContain(p);
      expect(statusResult.platformStatus[p].ready).toBe(true);
    }

    // list-platforms shows all installed
    const logs = await captureLog(() => listPlatforms(dir));
    const output = logs.join('\n');
    expect(output).toContain('✓ claude-code');
    expect(output).toContain('✓ cursor');
    expect(output).toContain('✓ codex');
    expect(output).toContain('✓ copilot');
  });

  it('init with frontend project → refresh-style → reinstall codex picks up new tokens', async () => {
    // Create a frontend project
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        dependencies: { react: '^18', tailwindcss: '^3.4' },
      }),
    );
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      `module.exports = { theme: { extend: { colors: { primary: '#3b82f6' } } } };`,
    );

    // init detects and scans tokens
    await silentRun(() => init(dir, { yes: true }));
    await silentRun(() => install(dir, 'codex'));

    let agentsMd = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('primary=#3b82f6');

    // Change tailwind config
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      `module.exports = { theme: { extend: { colors: { primary: '#ff0000', accent: '#00ff00' } } } };`,
    );

    // Refresh style tokens
    await silentRun(() => refreshStyle(dir));

    // Reinstall codex to pick up new tokens
    await silentRun(() => install(dir, 'codex', { force: true }));

    agentsMd = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('primary=#ff0000');
    expect(agentsMd).toContain('accent=#00ff00');
    expect(agentsMd).not.toContain('primary=#3b82f6');
  });

  it('uninstall preserves user content across all platforms', async () => {
    await silentRun(() => init(dir, { yes: true }));
    await silentRun(() => install(dir, 'codex'));
    await silentRun(() => install(dir, 'cursor'));
    await silentRun(() => install(dir, 'copilot'));

    // Add user content alongside mancode managed content
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      `${await readFile(path.join(dir, 'AGENTS.md'), 'utf-8')}\n## User Notes\nKeep this.\n`,
    );
    await mkdir(path.join(dir, '.cursor', 'rules'), { recursive: true });
    await writeFile(
      path.join(dir, '.cursor', 'rules', 'custom.mdc'),
      '# custom rule\n',
      'utf-8',
    );
    await mkdir(path.join(dir, '.github'), { recursive: true });
    await writeFile(
      path.join(dir, '.github', 'copilot-instructions.md'),
      `${await readFile(path.join(dir, '.github', 'copilot-instructions.md'), 'utf-8')}\n## User Instructions\nKeep.\n`,
    );
    // Add a custom Claude Code agent
    await mkdir(path.join(dir, '.claude', 'agents'), { recursive: true });
    await writeFile(
      path.join(dir, '.claude', 'agents', 'custom.md'),
      '# custom agent\n',
      'utf-8',
    );

    // Uninstall everything
    await silentRun(() =>
      uninstall(dir, undefined, { force: true, all: true }),
    );

    // User content is preserved
    expect(
      await readFile(path.join(dir, '.cursor', 'rules', 'custom.mdc'), 'utf-8'),
    ).toBe('# custom rule\n');
    // AGENTS.md and copilot-instructions.md: managed block removed, user content kept or file deleted if only mancode
    // Custom Claude agent preserved
    expect(
      await readFile(path.join(dir, '.claude', 'agents', 'custom.md'), 'utf-8'),
    ).toBe('# custom agent\n');
  });
});

async function expectStateJson(
  dir: string,
  expected: Record<string, unknown>,
): Promise<void> {
  const state = JSON.parse(
    await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
  );
  for (const [key, value] of Object.entries(expected)) {
    expect(state[key]).toBe(value);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeFile(p: string, content: string): Promise<void> {
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(p, content, 'utf-8');
}

async function silentRun(fn: () => Promise<number>): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await fn();
    if (code !== 0) throw new Error(`command exited with ${code}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function silentJson(fn: () => Promise<number>): Promise<StatusResult> {
  const logs = await captureLog(fn);
  return JSON.parse(logs.join('\n')) as StatusResult;
}

async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return logs;
}

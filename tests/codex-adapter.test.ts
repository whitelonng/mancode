import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import { EXIT_OK, install } from '../src/commands/install.js';

describe('Codex adapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-codex-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs AGENTS.md and records codex in config platforms', async () => {
    await silentInit(dir);

    const code = await install(dir, 'codex');

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:start -->');
    expect(agents).toContain('# mancode Configuration');
    expect(agents).toContain('Platform adapter: Codex CLI');
    expect(agents).toContain('mancode Platform Downgrade');

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).toContain('claude-code');
    expect(config.platforms).toContain('codex');
  });

  it('preserves user AGENTS.md content and remains idempotent', async () => {
    await silentInit(dir);
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# User Guidance\n\nKeep this.\n',
      'utf-8',
    );

    await install(dir, 'codex');
    await install(dir, 'codex', { force: true });

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# User Guidance\n\nKeep this.');
    expect(count(agents, '<!-- mancode:start -->')).toBe(1);
    expect(count(agents, '<!-- mancode:end -->')).toBe(1);
  });

  it('refreshes only the managed block on forced reinstall', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    const agentsPath = path.join(dir, 'AGENTS.md');
    const original = await readFile(agentsPath, 'utf-8');
    await writeFile(
      agentsPath,
      original.replace('Platform adapter: Codex CLI', 'Platform adapter: Old'),
      'utf-8',
    );

    await install(dir, 'codex', { force: true });

    const agents = await readFile(agentsPath, 'utf-8');
    expect(agents).toContain('Platform adapter: Codex CLI');
    expect(agents).not.toContain('Platform adapter: Old');
  });

  it('emits minimal content with --minimal', async () => {
    await silentInit(dir);

    await install(dir, 'codex', { minimal: true });

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('mancode Practice Rules');
    expect(agents).not.toContain('mancode Modes');
    expect(agents).not.toContain('mancode Platform Downgrade');
  });

  it('creates .agents/skills/ with 5 mode SKILL.md files', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    for (const mode of ['man8', 'man', 'manteam', 'manps', 'mansolo']) {
      const skill = await readFile(
        path.join(dir, '.agents', 'skills', mode, 'SKILL.md'),
        'utf-8',
      );
      expect(skill).toContain(`name: ${mode}`);
      expect(skill).toContain('Mode Persistence');
      expect(skill).toContain('YAGNI ladder');
    }
  });

  it('does not create .agents/skills/ with --minimal', async () => {
    await silentInit(dir);
    await install(dir, 'codex', { minimal: true });

    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'man8', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });
});

async function silentInit(dir: string): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await init(dir);
    if (code !== 0) {
      throw new Error(`silentInit failed: init exited with ${code}`);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

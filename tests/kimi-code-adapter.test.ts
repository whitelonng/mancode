import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import {
  EXIT_INSTALL_FAILED,
  EXIT_OK,
  install,
} from '../src/commands/install.js';
import { type StatusResult, status } from '../src/commands/status.js';
import { uninstall } from '../src/commands/uninstall.js';

describe('Kimi Code adapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-kimi-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs AGENTS.md and records kimi-code in config platforms', async () => {
    await silentInit(dir);

    const code = await install(dir, 'kimi-code');

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:kimi-code:start -->');
    expect(agents).toContain('# mancode Configuration');
    expect(agents).toContain('Platform adapter: Kimi Code (desktop/CLI)');

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).toContain('claude-code');
    expect(config.platforms).toContain('kimi-code');
  });

  it('preserves user AGENTS.md content and remains idempotent', async () => {
    await silentInit(dir);
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# User Guidance\n\nKeep this.\n',
      'utf-8',
    );

    await install(dir, 'kimi-code');
    await install(dir, 'kimi-code', { force: true });

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# User Guidance\n\nKeep this.');
    expect(count(agents, '<!-- mancode:kimi-code:start -->')).toBe(1);
    expect(count(agents, '<!-- mancode:kimi-code:end -->')).toBe(1);
  });

  it('creates .agents/skills/ with 5 mode SKILL.md files', async () => {
    await silentInit(dir);
    await install(dir, 'kimi-code');

    for (const mode of ['manba', 'man', 'manteam', 'manps', 'mansolo']) {
      const skill = await readFile(
        path.join(dir, '.agents', 'skills', mode, 'SKILL.md'),
        'utf-8',
      );
      expect(skill).toContain(`name: ${mode}`);
      expect(skill).toContain('Managed by mancode:kimi-skill');
      expect(skill).toContain('Mode Persistence');
    }
  });

  it('does not create .agents/skills/ with --minimal', async () => {
    await silentInit(dir);
    await install(dir, 'kimi-code', { minimal: true });

    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('status reports Kimi Code ready when managed block and skills exist', async () => {
    await silentInit(dir);
    await install(dir, 'kimi-code');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus['kimi-code'].installed).toBe(true);
    expect(result.platformStatus['kimi-code'].ready).toBe(true);
    expect(result.platformStatus['kimi-code'].target).toBe(
      'AGENTS.md + .agents/skills/',
    );
  });

  it('status reports Kimi Code not ready when a generated skill is missing', async () => {
    await silentInit(dir);
    await install(dir, 'kimi-code');
    await rm(path.join(dir, '.agents', 'skills', 'manba'), {
      recursive: true,
      force: true,
    });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus['kimi-code'].installed).toBe(true);
    expect(result.platformStatus['kimi-code'].ready).toBe(false);
    expect(result.platformStatus['kimi-code'].detail).toContain('missing');
  });

  it('refuses to overwrite user-authored same-name skills', async () => {
    await silentInit(dir);
    await mkdir(path.join(dir, '.agents', 'skills', 'manba'), {
      recursive: true,
    });
    await writeFile(
      path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
      '# custom manba\n',
      'utf-8',
    );

    const code = await install(dir, 'kimi-code');

    expect(code).toBe(EXIT_INSTALL_FAILED);
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toBe('# custom manba\n');
  });

  it('coexists with Codex and ZCode AGENTS.md managed blocks', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'zcode');
    await install(dir, 'kimi-code');

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:start -->');
    expect(agents).toContain('<!-- mancode:zcode:start -->');
    expect(agents).toContain('<!-- mancode:kimi-code:start -->');
    expect(agents).toContain('Platform adapter: Kimi Code (desktop/CLI)');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.codex.ready).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(true);
    expect(result.platformStatus['kimi-code'].ready).toBe(true);
  });

  it('uninstall kimi-code preserves Codex block and shared skills', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'kimi-code');

    const code = await uninstall(dir, 'kimi-code', { force: true });

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:start -->');
    expect(agents).not.toContain('<!-- mancode:kimi-code:start -->');
    // Codex still needs the shared .agents/skills/ directory.
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toContain('name: manba');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.codex.installed).toBe(true);
    expect(result.platformStatus.codex.ready).toBe(true);
    expect(result.platformStatus['kimi-code'].installed).toBe(false);
  });

  it('uninstall removes managed skills when no other agents platform remains', async () => {
    await silentInit(dir);
    await install(dir, 'kimi-code');
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# My Project\n\nKeep this.\n\n<!-- mancode:kimi-code:start -->\nmanaged\n<!-- mancode:kimi-code:end -->\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'kimi-code', { force: true });

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('Keep this.');
    expect(agents).not.toContain('<!-- mancode:kimi-code:start -->');
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('uninstall preserves user-authored same-name skills', async () => {
    await silentInit(dir);
    await install(dir, 'kimi-code');
    await writeFile(
      path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
      '# custom manba\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'kimi-code', { force: true });

    expect(code).toBe(EXIT_OK);
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toBe('# custom manba\n');
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

async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

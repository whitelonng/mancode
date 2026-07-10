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

describe('ZCode adapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-zcode-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs AGENTS.md and records zcode in config platforms', async () => {
    await silentInit(dir);

    const code = await install(dir, 'zcode');

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:zcode:start -->');
    expect(agents).toContain('# mancode Configuration');
    expect(agents).toContain('Platform adapter: ZCode');
    expect(agents).toContain('$mamba');

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).toContain('claude-code');
    expect(config.platforms).toContain('zcode');
  });

  it('preserves user AGENTS.md content and remains idempotent', async () => {
    await silentInit(dir);
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# User Guidance\n\nKeep this.\n',
      'utf-8',
    );

    await install(dir, 'zcode');
    await install(dir, 'zcode', { force: true });

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# User Guidance\n\nKeep this.');
    expect(count(agents, '<!-- mancode:zcode:start -->')).toBe(1);
    expect(count(agents, '<!-- mancode:zcode:end -->')).toBe(1);
  });

  it('creates .agents/skills/ with 5 mode SKILL.md files', async () => {
    await silentInit(dir);
    await install(dir, 'zcode');

    for (const mode of ['mamba', 'man', 'manteam', 'manps', 'mansolo']) {
      const skill = await readFile(
        path.join(dir, '.agents', 'skills', mode, 'SKILL.md'),
        'utf-8',
      );
      expect(skill).toContain(`name: ${mode}`);
      expect(skill).toContain('Managed by mancode:zcode-skill');
      expect(skill).toContain('Mode Persistence');
      expect(skill).toContain('YAGNI ladder');
      expect(skill).toContain('$mamba');
    }
  });

  it('does not create .agents/skills/ with --minimal', async () => {
    await silentInit(dir);
    await install(dir, 'zcode', { minimal: true });

    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('minimal force install removes existing skills', async () => {
    await silentInit(dir);
    await install(dir, 'zcode');
    await readFile(
      path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
      'utf-8',
    );

    await install(dir, 'zcode', { force: true, minimal: true });

    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('minimal force install reports ready when generated skills are removed', async () => {
    await silentInit(dir);
    await install(dir, 'zcode');

    await install(dir, 'zcode', { force: true, minimal: true });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.zcode.installed).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(true);
    expect(result.platformStatus.zcode.target).toBe('AGENTS.md');
  });

  it('minimal install reports ready when user custom skills remain', async () => {
    await silentInit(dir);
    await mkdir(path.join(dir, '.agents', 'skills', 'custom'), {
      recursive: true,
    });
    await writeFile(
      path.join(dir, '.agents', 'skills', 'custom', 'SKILL.md'),
      '# custom\n',
      'utf-8',
    );

    await install(dir, 'zcode', { minimal: true });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.zcode.installed).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(true);
    expect(result.platformStatus.zcode.target).toBe('AGENTS.md');
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'custom', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toBe('# custom\n');
  });

  it('status reports ZCode ready when managed block and skills exist', async () => {
    await silentInit(dir);
    await install(dir, 'zcode');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus.zcode.installed).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(true);
    expect(result.platformStatus.zcode.target).toBe(
      'AGENTS.md + .agents/skills/',
    );
  });

  it('status reports ZCode not ready when a generated skill is missing', async () => {
    await silentInit(dir);
    await install(dir, 'zcode');
    await rm(path.join(dir, '.agents', 'skills', 'mamba'), {
      recursive: true,
      force: true,
    });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus.zcode.installed).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(false);
    expect(result.platformStatus.zcode.detail).toContain('missing');
  });

  it('status reports ZCode not ready when the generated skills directory is missing', async () => {
    await silentInit(dir);
    await install(dir, 'zcode');
    await rm(path.join(dir, '.agents', 'skills'), {
      recursive: true,
      force: true,
    });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus.zcode.installed).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(false);
    expect(result.platformStatus.zcode.detail).toContain('missing');
  });

  it('refuses to overwrite user-authored same-name ZCode skills', async () => {
    await silentInit(dir);
    await mkdir(path.join(dir, '.agents', 'skills', 'mamba'), {
      recursive: true,
    });
    await writeFile(
      path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
      '# custom mamba\n',
      'utf-8',
    );

    const code = await install(dir, 'zcode');

    expect(code).toBe(EXIT_INSTALL_FAILED);
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toBe('# custom mamba\n');
  });

  it('minimal install preserves user-authored same-name ZCode skills', async () => {
    await silentInit(dir);
    await mkdir(path.join(dir, '.agents', 'skills', 'mamba'), {
      recursive: true,
    });
    await writeFile(
      path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
      '# custom mamba\n',
      'utf-8',
    );

    const code = await install(dir, 'zcode', { minimal: true });

    expect(code).toBe(EXIT_OK);
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toBe('# custom mamba\n');
  });

  it('coexists with Codex AGENTS.md managed block', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'zcode');

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:start -->');
    expect(agents).toContain('Platform adapter: Codex CLI');
    expect(agents).toContain('<!-- mancode:zcode:start -->');
    expect(agents).toContain('Platform adapter: ZCode');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.codex.ready).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(true);
  });

  it('uninstall zcode preserves Codex AGENTS.md managed block', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'zcode');

    const code = await uninstall(dir, 'zcode', { force: true });

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:start -->');
    expect(agents).toContain('Platform adapter: Codex CLI');
    expect(agents).not.toContain('<!-- mancode:zcode:start -->');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.codex.installed).toBe(true);
    expect(result.platformStatus.codex.ready).toBe(true);
    expect(result.platformStatus.zcode.installed).toBe(false);
    expect(result.platformStatus.zcode.ready).toBe(false);
  });

  it('uninstall codex preserves ZCode AGENTS.md managed block', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'zcode');

    const code = await uninstall(dir, 'codex', { force: true });

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).not.toContain('<!-- mancode:start -->');
    expect(agents).toContain('<!-- mancode:zcode:start -->');
    expect(agents).toContain('Platform adapter: ZCode');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.codex.installed).toBe(false);
    expect(result.platformStatus.codex.ready).toBe(false);
    expect(result.platformStatus.zcode.installed).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(true);
  });

  it('uninstall removes ZCode managed content but preserves user files', async () => {
    await silentInit(dir);
    await install(dir, 'zcode');
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# My Project\n\nKeep this.\n\n<!-- mancode:zcode:start -->\nmanaged\n<!-- mancode:zcode:end -->\n',
      'utf-8',
    );
    await writeFile(
      path.join(dir, '.agents', 'skills', 'custom.md'),
      '# custom\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'zcode', { force: true });

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('Keep this.');
    expect(agents).not.toContain('<!-- mancode:zcode:start -->');
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, '.agents', 'skills', 'custom.md'), 'utf-8'),
    ).resolves.toBe('# custom\n');
  });

  it('uninstall preserves user-authored same-name ZCode skills', async () => {
    await silentInit(dir);
    await install(dir, 'zcode');
    await writeFile(
      path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
      '# custom mamba\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'zcode', { force: true });

    expect(code).toBe(EXIT_OK);
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toBe('# custom mamba\n');
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

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import { EXIT_OK, install } from '../src/commands/install.js';
import { type StatusResult, status } from '../src/commands/status.js';
import { uninstall } from '../src/commands/uninstall.js';
import { renderV3Bootstrap } from '../src/installers/v3-adapter.js';

describe('Qoder adapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-qoder-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs AGENTS.md and records qoder in config platforms', async () => {
    await silentInit(dir);

    const code = await install(dir, 'qoder');

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:qoder:start -->');
    expect(agents).toContain('# mancode Configuration');
    expect(agents).toContain('Platform adapter: Qoder (IDE/CLI)');

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).toContain('claude-code');
    expect(config.platforms).toContain('qoder');
  });

  it('preserves user AGENTS.md content and remains idempotent', async () => {
    await silentInit(dir);
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# User Guidance\n\nKeep this.\n',
      'utf-8',
    );

    await install(dir, 'qoder');
    await install(dir, 'qoder', { force: true });

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# User Guidance\n\nKeep this.');
    expect(count(agents, '<!-- mancode:qoder:start -->')).toBe(1);
    expect(count(agents, '<!-- mancode:qoder:end -->')).toBe(1);
  });

  it('creates .qoder/commands/ with 5 mode command files', async () => {
    await silentInit(dir);
    await install(dir, 'qoder');

    for (const mode of ['manba', 'man', 'manteam', 'manps', 'mansolo']) {
      const command = await readFile(
        path.join(dir, '.qoder', 'commands', `${mode}.md`),
        'utf-8',
      );
      expect(command).toContain(`name: ${mode}`);
      expect(command).toContain('Managed by mancode:mode-file');
      expect(command).toContain('Mode Persistence');
      expect(command).toContain('## Qoder security scan interplay');
      expect(command).toContain('single Step 9 remediation round');
    }
  });

  it('scopes host scan guidance to the qoder V3 bootstrap only', () => {
    const qoderBootstrap = renderV3Bootstrap('qoder');
    expect(qoderBootstrap).toContain(
      'security scan findings (L1/L2/L3) as advisory review input',
    );
    expect(qoderBootstrap).toContain('single remediation round');
    for (const platform of ['codex', 'cursor', 'kimi-code'] as const) {
      expect(renderV3Bootstrap(platform)).not.toContain(
        'security scan findings',
      );
    }
  });

  it('does not create .qoder/commands/ with --minimal', async () => {
    await silentInit(dir);
    await install(dir, 'qoder', { minimal: true });

    await expect(
      readFile(path.join(dir, '.qoder', 'commands', 'manba.md'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('status reports Qoder ready when managed block and commands exist', async () => {
    await silentInit(dir);
    await install(dir, 'qoder');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus.qoder.installed).toBe(true);
    expect(result.platformStatus.qoder.ready).toBe(true);
    expect(result.platformStatus.qoder.target).toBe(
      'AGENTS.md + .qoder/commands/',
    );
  });

  it('status reports Qoder not ready when a generated command is missing', async () => {
    await silentInit(dir);
    await install(dir, 'qoder');
    await rm(path.join(dir, '.qoder', 'commands', 'manba.md'), {
      force: true,
    });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus.qoder.installed).toBe(true);
    expect(result.platformStatus.qoder.ready).toBe(false);
    expect(result.platformStatus.qoder.detail).toContain('missing');
  });

  it('coexists with Codex AGENTS.md managed block', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'qoder');

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:start -->');
    expect(agents).toContain('Platform adapter: Codex (ChatGPT desktop/CLI)');
    expect(agents).toContain('<!-- mancode:qoder:start -->');
    expect(agents).toContain('Platform adapter: Qoder (IDE/CLI)');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.codex.ready).toBe(true);
    expect(result.platformStatus.qoder.ready).toBe(true);
  });

  it('uninstall qoder preserves Codex AGENTS.md managed block', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'qoder');

    const code = await uninstall(dir, 'qoder', { force: true });

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:start -->');
    expect(agents).not.toContain('<!-- mancode:qoder:start -->');
    // Codex shared skills are untouched by a Qoder uninstall.
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
    expect(result.platformStatus.qoder.installed).toBe(false);
  });

  it('uninstall removes Qoder managed content but preserves user files', async () => {
    await silentInit(dir);
    await install(dir, 'qoder');
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# My Project\n\nKeep this.\n\n<!-- mancode:qoder:start -->\nmanaged\n<!-- mancode:qoder:end -->\n',
      'utf-8',
    );
    await writeFile(
      path.join(dir, '.qoder', 'commands', 'custom.md'),
      '# custom\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'qoder', { force: true });

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('Keep this.');
    expect(agents).not.toContain('<!-- mancode:qoder:start -->');
    await expect(
      readFile(path.join(dir, '.qoder', 'commands', 'manba.md'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, '.qoder', 'commands', 'custom.md'), 'utf-8'),
    ).resolves.toBe('# custom\n');
  });

  it('uninstall preserves user-authored same-name Qoder commands', async () => {
    await silentInit(dir);
    await install(dir, 'qoder');
    await writeFile(
      path.join(dir, '.qoder', 'commands', 'manba.md'),
      '# custom manba\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'qoder', { force: true });

    expect(code).toBe(EXIT_OK);
    await expect(
      readFile(path.join(dir, '.qoder', 'commands', 'manba.md'), 'utf-8'),
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

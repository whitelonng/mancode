import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { getPlatformInstaller } from '../src/installers/registry.js';

describe('DeepSeek Harness adapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-dsh-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs an isolated AGENTS.md block and user-only DSH mode skills', async () => {
    expect(getPlatformInstaller('dsh')?.capabilities).toEqual({
      slashCommands: 'partial',
      subagents: true,
      hooks: false,
      skills: 'dsh-skills',
    });
    await silentInit(dir);

    const code = await install(dir, 'dsh');

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:dsh:start -->');
    expect(agents).toContain('Platform adapter: DeepSeek Harness');
    expect(agents).toContain('/manba');
    for (const mode of ['manba', 'man', 'manteam', 'manps', 'mansolo']) {
      const skill = await readFile(
        path.join(dir, '.dsh', 'skills', mode, 'SKILL.md'),
        'utf-8',
      );
      expect(skill).toContain(`name: ${mode}`);
      expect(skill).toContain('disable-model-invocation: true');
      expect(skill).toContain('user-invocable: true');
      expect(skill).toContain('Managed by mancode:dsh-skill');
      expect(skill).toContain('/manba');
    }

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).toContain('dsh');
  });

  it('preserves user AGENTS.md content and does not touch .agents/skills', async () => {
    await silentInit(dir);
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# User Guidance\n\nKeep this.\n',
      'utf-8',
    );
    const codexSkill = path.join(dir, '.agents', 'skills', 'man', 'SKILL.md');
    await mkdir(path.dirname(codexSkill), { recursive: true });
    await writeFile(codexSkill, '# Codex-owned skill\n', 'utf-8');

    await install(dir, 'dsh');
    await install(dir, 'dsh', { force: true });

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# User Guidance\n\nKeep this.');
    expect(count(agents, '<!-- mancode:dsh:start -->')).toBe(1);
    await expect(readFile(codexSkill, 'utf-8')).resolves.toBe(
      '# Codex-owned skill\n',
    );
  });

  it('refuses to overwrite a user-authored same-name DSH skill', async () => {
    await silentInit(dir);
    const skillPath = path.join(dir, '.dsh', 'skills', 'man', 'SKILL.md');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, '# Custom DSH skill\n', 'utf-8');

    const code = await install(dir, 'dsh');

    expect(code).toBe(EXIT_INSTALL_FAILED);
    await expect(readFile(skillPath, 'utf-8')).resolves.toBe(
      '# Custom DSH skill\n',
    );
  });

  it('rejects symlinked DSH artifact paths without writing outside the project', async () => {
    await silentInit(dir);
    const outside = await mkdtemp(path.join(tmpdir(), 'mancode-dsh-outside-'));
    const outsideAgents = path.join(outside, 'AGENTS.md');
    const outsideDsh = path.join(outside, 'dsh');
    await writeFile(outsideAgents, '# External\n', 'utf-8');
    await mkdir(outsideDsh, { recursive: true });

    try {
      await rm(path.join(dir, 'AGENTS.md'), { force: true });
      await symlink(outsideAgents, path.join(dir, 'AGENTS.md'));

      expect(await install(dir, 'dsh')).toBe(EXIT_INSTALL_FAILED);
      await expect(readFile(outsideAgents, 'utf-8')).resolves.toBe(
        '# External\n',
      );

      await rm(path.join(dir, 'AGENTS.md'), { force: true });
      await symlink(outsideDsh, path.join(dir, '.dsh'));

      expect(await install(dir, 'dsh')).toBe(EXIT_INSTALL_FAILED);
      await expect(
        readFile(path.join(outsideDsh, 'skills', 'man', 'SKILL.md'), 'utf-8'),
      ).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked AGENTS.md during uninstall', async () => {
    await silentInit(dir);
    await install(dir, 'dsh');
    const outside = await mkdtemp(path.join(tmpdir(), 'mancode-dsh-outside-'));
    const outsideAgents = path.join(outside, 'AGENTS.md');
    const externalContent = [
      '# External',
      '<!-- mancode:dsh:start -->',
      'external managed-looking content',
      '<!-- mancode:dsh:end -->',
      '',
    ].join('\n');
    await writeFile(outsideAgents, externalContent, 'utf-8');

    try {
      await rm(path.join(dir, 'AGENTS.md'), { force: true });
      await symlink(outsideAgents, path.join(dir, 'AGENTS.md'));

      await expect(uninstall(dir, 'dsh', { force: true })).rejects.toThrow(
        'MANCODE_ARTIFACT_PATH_UNSAFE',
      );
      await expect(readFile(outsideAgents, 'utf-8')).resolves.toBe(
        externalContent,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports readiness and preserves custom DSH skills during minimal install', async () => {
    await silentInit(dir);
    await install(dir, 'dsh');
    const customSkill = path.join(dir, '.dsh', 'skills', 'custom', 'SKILL.md');
    await mkdir(path.dirname(customSkill), { recursive: true });
    await writeFile(customSkill, '# Custom\n', 'utf-8');

    await install(dir, 'dsh', { force: true, minimal: true });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platformStatus.dsh).toMatchObject({
      installed: true,
      ready: true,
      target: 'AGENTS.md',
    });
    await expect(readFile(customSkill, 'utf-8')).resolves.toBe('# Custom\n');
    await expect(
      readFile(path.join(dir, '.dsh', 'skills', 'man', 'SKILL.md'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('uninstalls only DSH-managed content', async () => {
    await silentInit(dir);
    await writeFile(path.join(dir, 'AGENTS.md'), '# Keep\n', 'utf-8');
    await install(dir, 'dsh');
    const customSkill = path.join(dir, '.dsh', 'skills', 'custom', 'SKILL.md');
    await mkdir(path.dirname(customSkill), { recursive: true });
    await writeFile(customSkill, '# Custom\n', 'utf-8');

    const code = await uninstall(dir, 'dsh', { force: true });

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# Keep');
    expect(agents).not.toContain('mancode:dsh');
    await expect(readFile(customSkill, 'utf-8')).resolves.toBe('# Custom\n');
    await expect(
      readFile(path.join(dir, '.dsh', 'skills', 'man', 'SKILL.md'), 'utf-8'),
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
    if (code !== 0) throw new Error(`silentInit failed with ${code}`);
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

function count(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

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
import { getPlatformInstaller } from '../src/installers/registry.js';

describe('Codex adapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-codex-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports partial slash support because desktop skills appear in the slash list', () => {
    expect(getPlatformInstaller('codex')?.capabilities.slashCommands).toBe(
      'partial',
    );
  });

  it('installs AGENTS.md and records codex in config platforms', async () => {
    await silentInit(dir);

    const code = await install(dir, 'codex');

    expect(code).toBe(EXIT_OK);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('<!-- mancode:start -->');
    expect(agents).toContain('# mancode Configuration');
    expect(agents).toContain('Platform adapter: Codex (ChatGPT desktop/CLI)');
    expect(agents).toContain('mancode Platform Downgrade');
    expect(agents).toContain('one bounded self-check');
    expect(agents).toContain('Do not start another reviewer');

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
      original.replace(
        'Platform adapter: Codex (ChatGPT desktop/CLI)',
        'Platform adapter: Old',
      ),
      'utf-8',
    );

    await install(dir, 'codex', { force: true });

    const agents = await readFile(agentsPath, 'utf-8');
    expect(agents).toContain('Platform adapter: Codex (ChatGPT desktop/CLI)');
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

    for (const mode of ['manba', 'man', 'manteam', 'manps', 'mansolo']) {
      const skill = await readFile(
        path.join(dir, '.agents', 'skills', mode, 'SKILL.md'),
        'utf-8',
      );
      expect(skill).toContain(`name: ${mode}`);
      expect(skill).toContain('Managed by mancode:codex-skill');
      expect(skill).toContain('Mode Persistence');
      expect(skill).toContain('YAGNI ladder');
    }
  });

  it('does not create .agents/skills/ with --minimal', async () => {
    await silentInit(dir);
    await install(dir, 'codex', { minimal: true });

    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('minimal force install removes existing skills', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    // Verify skills exist before minimal
    await readFile(
      path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
      'utf-8',
    );

    await install(dir, 'codex', { force: true, minimal: true });

    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('SKILL.md files use $ prefix for mode invocation', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    const manba = await readFile(
      path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
      'utf-8',
    );
    expect(manba).toContain('$manba');
  });

  it('mansolo SKILL.md maps state to solo not mansolo', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    const mansolo = await readFile(
      path.join(dir, '.agents', 'skills', 'mansolo', 'SKILL.md'),
      'utf-8',
    );
    expect(mansolo).toContain('"solo"');
    expect(mansolo).not.toContain('"mansolo"');
  });

  it('AGENTS.md includes $manba invocation guidance for agents-skills', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('$manba');
  });

  it('replaces a managed legacy mamba skill with manba during upgrade', async () => {
    await silentInit(dir);
    const legacyDir = path.join(dir, '.agents', 'skills', 'mamba');
    const legacyPath = path.join(legacyDir, 'SKILL.md');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      legacyPath,
      '<!-- Managed by mancode:codex-skill. Do not edit this file manually. -->\n---\nname: mamba\n---\n',
      'utf-8',
    );

    await install(dir, 'codex', { force: true });

    await expect(readFile(legacyPath, 'utf-8')).rejects.toThrow();
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toContain('name: manba');
  });

  it('preserves a user-authored legacy mamba skill during upgrade', async () => {
    await silentInit(dir);
    const legacyDir = path.join(dir, '.agents', 'skills', 'mamba');
    const legacyPath = path.join(legacyDir, 'SKILL.md');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(legacyPath, '# user-authored mamba skill\n', 'utf-8');

    await install(dir, 'codex', { force: true });

    await expect(readFile(legacyPath, 'utf-8')).resolves.toBe(
      '# user-authored mamba skill\n',
    );
  });

  it('keeps the managed legacy mamba skill when manba cannot be written', async () => {
    await silentInit(dir);
    const skillsDir = path.join(dir, '.agents', 'skills');
    const legacyDir = path.join(skillsDir, 'mamba');
    const legacyPath = path.join(legacyDir, 'SKILL.md');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      legacyPath,
      '<!-- Managed by mancode:codex-skill. Do not edit this file manually. -->\n---\nname: mamba\n---\n',
      'utf-8',
    );
    await mkdir(path.join(skillsDir, 'manba', 'SKILL.md'), {
      recursive: true,
    });

    const code = await install(dir, 'codex', { force: true });

    expect(code).toBe(EXIT_INSTALL_FAILED);
    await expect(readFile(legacyPath, 'utf-8')).resolves.toContain(
      'name: mamba',
    );
  });

  it('refuses to overwrite user-authored same-name Codex skills', async () => {
    await silentInit(dir);
    await mkdir(path.join(dir, '.agents', 'skills', 'manba'), {
      recursive: true,
    });
    await writeFile(
      path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
      '# custom manba\n',
      'utf-8',
    );

    const code = await install(dir, 'codex');

    expect(code).toBe(EXIT_INSTALL_FAILED);
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toBe('# custom manba\n');
  });

  it('minimal install preserves user-authored same-name Codex skills', async () => {
    await silentInit(dir);
    await mkdir(path.join(dir, '.agents', 'skills', 'manba'), {
      recursive: true,
    });
    await writeFile(
      path.join(dir, '.agents', 'skills', 'manba', 'SKILL.md'),
      '# custom manba\n',
      'utf-8',
    );

    const code = await install(dir, 'codex', { minimal: true });

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

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

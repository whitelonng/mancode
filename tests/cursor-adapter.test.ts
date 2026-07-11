import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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

describe('Cursor adapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-cursor-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs Cursor rules and records cursor in config platforms', async () => {
    await silentInit(dir);

    const code = await install(dir, 'cursor');

    expect(code).toBe(EXIT_OK);
    const rules = await readdir(path.join(dir, '.cursor', 'rules'));
    expect(rules.sort()).toEqual([
      'mancode-context.mdc',
      'mancode-mamba.mdc',
      'mancode-man.mdc',
      'mancode-manps.mdc',
      'mancode-manteam.mdc',
      'mancode-practice.mdc',
      'mancode-solo.mdc',
    ]);

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).toContain('claude-code');
    expect(config.platforms).toContain('cursor');
  });

  it('writes mdc frontmatter for rules', async () => {
    await silentInit(dir);

    await install(dir, 'cursor');

    const solo = await readRule('mancode-solo.mdc');
    expect(solo).toContain('Managed by mancode:cursor-rule');
    expect(solo).toMatch(/^---\ndescription: "mancode solo mode/m);
    expect(solo).toContain('alwaysApply: true');
    expect(solo).toContain('globs: "**/*"');
    expect(solo).toContain('# mancode solo');
    expect(solo).toContain('read `.mancode/aesthetics/style-tokens.json`');
    expect(solo).toContain('one bounded self-check');
    expect(solo).toContain('Do not start another reviewer');

    const man = await readRule('mancode-man.mdc');
    expect(man).toContain('alwaysApply: false');
    expect(man).toContain('Mode Persistence');
    expect(man).toContain('/mansolo');
    expect(man).toContain('targeted review');
    expect(man).toContain('one remediation round');
  });

  it('preserves user rules on repeat install', async () => {
    await silentInit(dir);
    const rulesDir = path.join(dir, '.cursor', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(path.join(rulesDir, 'custom.mdc'), '# custom\n', 'utf-8');

    await install(dir, 'cursor');
    await install(dir, 'cursor', { force: true });

    expect(await readFile(path.join(rulesDir, 'custom.mdc'), 'utf-8')).toBe(
      '# custom\n',
    );
  });

  it('refuses to overwrite a user-authored same-name Cursor rule', async () => {
    await silentInit(dir);
    const rulesDir = path.join(dir, '.cursor', 'rules');
    await mkdir(rulesDir, { recursive: true });
    const customPath = path.join(rulesDir, 'mancode-solo.mdc');
    await writeFile(customPath, '# custom solo rule\n', 'utf-8');

    const code = await install(dir, 'cursor');

    expect(code).toBe(EXIT_INSTALL_FAILED);
    await expect(readFile(customPath, 'utf-8')).resolves.toBe(
      '# custom solo rule\n',
    );
  });

  it('minimal force install removes only known advanced mancode rules', async () => {
    await silentInit(dir);
    const rulesDir = path.join(dir, '.cursor', 'rules');
    await install(dir, 'cursor');
    await writeFile(path.join(rulesDir, 'custom.mdc'), '# custom\n', 'utf-8');

    await install(dir, 'cursor', { force: true, minimal: true });

    const rules = await readdir(rulesDir);
    expect(rules).toContain('mancode-context.mdc');
    expect(rules).toContain('mancode-practice.mdc');
    expect(rules).toContain('mancode-solo.mdc');
    expect(rules).toContain('custom.mdc');
    expect(rules).not.toContain('mancode-mamba.mdc');
    expect(rules).not.toContain('mancode-man.mdc');
    expect(rules).not.toContain('mancode-manteam.mdc');
    expect(rules).not.toContain('mancode-manps.mdc');
  });

  it('minimal install preserves a user-authored same-name advanced rule', async () => {
    await silentInit(dir);
    const rulesDir = path.join(dir, '.cursor', 'rules');
    await install(dir, 'cursor');
    const customPath = path.join(rulesDir, 'mancode-man.mdc');
    await writeFile(customPath, '# custom man rule\n', 'utf-8');

    const code = await install(dir, 'cursor', { minimal: true });

    expect(code).toBe(EXIT_OK);
    await expect(readFile(customPath, 'utf-8')).resolves.toBe(
      '# custom man rule\n',
    );
  });

  it('does not create legacy .cursorrules', async () => {
    await silentInit(dir);

    await install(dir, 'cursor');

    await expect(
      readFile(path.join(dir, '.cursorrules'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('creates .cursor/commands/ with 5 mode command files', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');

    for (const mode of ['mamba', 'man', 'manteam', 'manps', 'mansolo']) {
      const cmd = await readFile(
        path.join(dir, '.cursor', 'commands', `${mode}.md`),
        'utf-8',
      );
      expect(cmd).toContain('Mode Persistence');
      expect(cmd).toContain('YAGNI ladder');
    }
  });

  it('preserves a user-authored legacy man8 command during upgrade', async () => {
    await silentInit(dir);
    const commandsDir = path.join(dir, '.cursor', 'commands');
    await mkdir(commandsDir, { recursive: true });
    const legacyPath = path.join(commandsDir, 'man8.md');
    await writeFile(legacyPath, '# user-authored man8 command\n', 'utf-8');

    await install(dir, 'cursor');

    await expect(readFile(legacyPath, 'utf-8')).resolves.toBe(
      '# user-authored man8 command\n',
    );
  });

  it('preserves a user-authored legacy man8 rule during upgrade', async () => {
    await silentInit(dir);
    const rulesDir = path.join(dir, '.cursor', 'rules');
    await mkdir(rulesDir, { recursive: true });
    const legacyPath = path.join(rulesDir, 'mancode-man8.mdc');
    await writeFile(legacyPath, '# user-authored man8 rule\n', 'utf-8');

    await install(dir, 'cursor');

    await expect(readFile(legacyPath, 'utf-8')).resolves.toBe(
      '# user-authored man8 rule\n',
    );
  });

  it('minimal force install removes mode command files', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');
    // Verify commands exist before minimal
    await readFile(path.join(dir, '.cursor', 'commands', 'mamba.md'), 'utf-8');

    await install(dir, 'cursor', { force: true, minimal: true });

    await expect(
      readFile(path.join(dir, '.cursor', 'commands', 'mamba.md'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, '.cursor', 'commands', 'mansolo.md'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('command files use / prefix not $ prefix', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');

    const mamba = await readFile(
      path.join(dir, '.cursor', 'commands', 'mamba.md'),
      'utf-8',
    );
    expect(mamba).toContain('/mamba');
    expect(mamba).not.toContain('$mamba');
  });

  it('mansolo command maps state to solo not mansolo', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');

    const mansolo = await readFile(
      path.join(dir, '.cursor', 'commands', 'mansolo.md'),
      'utf-8',
    );
    expect(mansolo).toContain('"solo"');
    expect(mansolo).not.toContain('"mansolo"');
  });

  async function readRule(name: string): Promise<string> {
    return readFile(path.join(dir, '.cursor', 'rules', name), 'utf-8');
  }
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

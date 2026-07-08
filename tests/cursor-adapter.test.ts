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
import { EXIT_OK, install } from '../src/commands/install.js';

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
      'mancode-man.mdc',
      'mancode-man8.mdc',
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
    expect(solo).toMatch(/^---\ndescription: "mancode solo mode/m);
    expect(solo).toContain('alwaysApply: true');
    expect(solo).toContain('globs: "**/*"');
    expect(solo).toContain('# mancode solo');
    expect(solo).toContain('read `.mancode/aesthetics/style-tokens.json`');

    const man = await readRule('mancode-man.mdc');
    expect(man).toContain('alwaysApply: false');
    expect(man).toContain('Film Analyst Defense');
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
    expect(rules).not.toContain('mancode-man8.mdc');
    expect(rules).not.toContain('mancode-man.mdc');
    expect(rules).not.toContain('mancode-manteam.mdc');
    expect(rules).not.toContain('mancode-manps.mdc');
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

    for (const mode of ['man8', 'man', 'manteam', 'manps', 'mansolo']) {
      const cmd = await readFile(
        path.join(dir, '.cursor', 'commands', `${mode}.md`),
        'utf-8',
      );
      expect(cmd).toContain('Mode Persistence');
      expect(cmd).toContain('YAGNI ladder');
    }
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

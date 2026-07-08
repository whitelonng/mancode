import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import { EXIT_OK, install } from '../src/commands/install.js';

describe('GitHub Copilot adapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-copilot-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs copilot instructions and records copilot in config platforms', async () => {
    await silentInit(dir);

    const code = await install(dir, 'copilot');

    expect(code).toBe(EXIT_OK);
    const instructions = await readInstructions();
    expect(instructions).toContain('<!-- mancode:start -->');
    expect(instructions).toContain('# mancode for GitHub Copilot');
    expect(instructions).toContain('Platform adapter: GitHub Copilot');
    expect(instructions).toContain('mancode Prompt Conventions');

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).toContain('claude-code');
    expect(config.platforms).toContain('copilot');
  });

  it('preserves user instructions and remains idempotent', async () => {
    await silentInit(dir);
    await mkdir(path.join(dir, '.github'), { recursive: true });
    await writeFile(
      path.join(dir, '.github', 'copilot-instructions.md'),
      '# User Instructions\n\nKeep this.\n',
      'utf-8',
    );

    await install(dir, 'copilot');
    await install(dir, 'copilot', { force: true });

    const instructions = await readInstructions();
    expect(instructions).toContain('# User Instructions\n\nKeep this.');
    expect(count(instructions, '<!-- mancode:start -->')).toBe(1);
    expect(count(instructions, '<!-- mancode:end -->')).toBe(1);
  });

  it('refreshes only the managed block on forced reinstall', async () => {
    await silentInit(dir);
    await install(dir, 'copilot');

    const instructionsPath = path.join(
      dir,
      '.github',
      'copilot-instructions.md',
    );
    const original = await readFile(instructionsPath, 'utf-8');
    await writeFile(
      instructionsPath,
      original.replace(
        'Platform adapter: GitHub Copilot',
        'Platform adapter: Old',
      ),
      'utf-8',
    );

    await install(dir, 'copilot', { force: true });

    const instructions = await readInstructions();
    expect(instructions).toContain('Platform adapter: GitHub Copilot');
    expect(instructions).not.toContain('Platform adapter: Old');
  });

  it('emits minimal content with --minimal', async () => {
    await silentInit(dir);

    await install(dir, 'copilot', { minimal: true });

    const instructions = await readInstructions();
    expect(instructions).toContain('mancode Practice Rules');
    expect(instructions).not.toContain('mancode Prompt Conventions');
  });

  it('does not create AGENTS.md for Copilot', async () => {
    await silentInit(dir);

    await install(dir, 'copilot');

    await expect(
      readFile(path.join(dir, 'AGENTS.md'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('creates .github/prompts/ with 5 mode prompt files', async () => {
    await silentInit(dir);
    await install(dir, 'copilot');

    for (const mode of ['man8', 'man', 'manteam', 'manps', 'mansolo']) {
      const prompt = await readFile(
        path.join(dir, '.github', 'prompts', `${mode}.prompt.md`),
        'utf-8',
      );
      expect(prompt).toMatch(/^---\nagent: 'agent'\ndescription: /);
      expect(prompt).toContain('Mode Persistence');
      expect(prompt).toContain('YAGNI ladder');
    }
  });

  it('minimal force install removes existing prompts', async () => {
    await silentInit(dir);
    await install(dir, 'copilot');
    // Verify prompts exist before minimal
    await readFile(
      path.join(dir, '.github', 'prompts', 'man8.prompt.md'),
      'utf-8',
    );

    await install(dir, 'copilot', { force: true, minimal: true });

    await expect(
      readFile(path.join(dir, '.github', 'prompts', 'man8.prompt.md'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('instructions include mansolo in prompt conventions', async () => {
    await silentInit(dir);
    await install(dir, 'copilot');

    const instructions = await readInstructions();
    expect(instructions).toContain('mansolo');
  });

  it('prompt files do not use $ or / prefix', async () => {
    await silentInit(dir);
    await install(dir, 'copilot');

    const man8 = await readFile(
      path.join(dir, '.github', 'prompts', 'man8.prompt.md'),
      'utf-8',
    );
    expect(man8).not.toContain('$man8');
    expect(man8).not.toContain('/man8');
  });

  it('mansolo prompt maps state to solo not mansolo', async () => {
    await silentInit(dir);
    await install(dir, 'copilot');

    const mansolo = await readFile(
      path.join(dir, '.github', 'prompts', 'mansolo.prompt.md'),
      'utf-8',
    );
    expect(mansolo).toContain('"solo"');
    expect(mansolo).not.toContain('"mansolo"');
  });

  async function readInstructions(): Promise<string> {
    return readFile(
      path.join(dir, '.github', 'copilot-instructions.md'),
      'utf-8',
    );
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

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

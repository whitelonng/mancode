import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMancodeCore } from '../src/installers/common.js';
import { DEFAULT_CONFIG } from '../src/templates/defaults.js';

describe('installMancodeCore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-core-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates platform-neutral mancode files and directories', async () => {
    await installMancodeCore(dir);

    await expectExists(path.join(dir, '.mancode', 'hooks'));
    await expectExists(path.join(dir, '.mancode', 'aesthetics'));
    await expectExists(path.join(dir, '.mancode', 'logs'));
    await expectExists(path.join(dir, '.mancode', 'workflows'));
    await expectExists(path.join(dir, '.mancode', 'memory'));
    await expectExists(path.join(dir, '.mancode', 'preseason-reports'));

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config).toEqual(DEFAULT_CONFIG);

    const sessionStart = await readFile(
      path.join(dir, '.mancode', 'hooks', 'session-start.sh'),
      'utf-8',
    );
    expect(sessionStart).toContain('mancode SessionStart hook');

    const userPromptSubmit = await readFile(
      path.join(dir, '.mancode', 'hooks', 'user-prompt-submit.sh'),
      'utf-8',
    );
    expect(userPromptSubmit).toContain('mancode UserPromptSubmit hook');
  });

  it('does not wipe existing style tokens or hooks log', async () => {
    const aestheticsDir = path.join(dir, '.mancode', 'aesthetics');
    const logsDir = path.join(dir, '.mancode', 'logs');
    await mkdir(aestheticsDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      path.join(aestheticsDir, 'style-tokens.json'),
      '{"matchLevel":"high"}\n',
      'utf-8',
    );
    await writeFile(path.join(logsDir, 'hooks.log'), 'existing log\n', 'utf-8');

    await installMancodeCore(dir);

    await expect(
      readFile(path.join(aestheticsDir, 'style-tokens.json'), 'utf-8'),
    ).resolves.toBe('{"matchLevel":"high"}\n');
    await expect(
      readFile(path.join(logsDir, 'hooks.log'), 'utf-8'),
    ).resolves.toBe('existing log\n');
  });

  it('does not overwrite existing config.json', async () => {
    const mancodeDir = path.join(dir, '.mancode');
    const existingConfig = {
      ...DEFAULT_CONFIG,
      platforms: ['codex'],
      forceTeamMode: true,
      defaultStyle: 'brutalist',
    };
    await mkdir(mancodeDir, { recursive: true });
    await writeFile(
      path.join(mancodeDir, 'config.json'),
      `${JSON.stringify(existingConfig, null, 2)}\n`,
      'utf-8',
    );

    await installMancodeCore(dir);

    expect(
      JSON.parse(await readFile(path.join(mancodeDir, 'config.json'), 'utf-8')),
    ).toEqual(existingConfig);
  });
});

async function expectExists(filePath: string): Promise<void> {
  await expect(stat(filePath)).resolves.toBeTruthy();
}

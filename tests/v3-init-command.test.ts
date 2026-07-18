import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_ALREADY_INITIALIZED,
  EXIT_INIT_FAILED,
  EXIT_NOT_A_PROJECT_DIR,
  EXIT_OK,
  init,
  resolveInitAuthority,
} from '../src/commands/init.js';
import { parseSchemaManifest } from '../src/context/manifest.js';
import { runtimeCheckoutRecordPath } from '../src/runtime/project-runtime.js';

describe('journaled V3 init command', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-init-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses V3 for the public CLI entry while retaining an explicit legacy escape hatch', () => {
    expect(resolveInitAuthority({ fromCli: true })).toBe('v3');
    expect(resolveInitAuthority({ fromCli: true, legacy: true })).toBe(
      'legacy',
    );
    expect(resolveInitAuthority({ fromCli: true, v3: true })).toBe('v3');
    expect(resolveInitAuthority({})).toBe('legacy');
  });

  it('routes the ordinary CLI init path into V3 and installs the original mode entry', async () => {
    const result = await init(root, {
      fromCli: true,
      empty: true,
      platform: 'codex',
    });

    expect(result).toBe(EXIT_OK);
    expect(
      parseSchemaManifest(
        JSON.parse(
          await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
        ),
      ).activationState,
    ).toBe('v3_active');
    await expect(
      readFile(path.join(root, '.agents', 'skills', 'man', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('mancode workflow create man');
  });

  it('keeps ordinary CLI platform onboarding on the V3 path', async () => {
    let confirmedGenericProject = false;
    const result = await init(root, {
      fromCli: true,
      interactive: true,
      prompter: {
        confirmGenericProject: async () => {
          confirmedGenericProject = true;
          return true;
        },
        selectPlatforms: async () => ['cursor'],
      },
    });

    expect(result).toBe(EXIT_OK);
    expect(confirmedGenericProject).toBe(true);
    await expect(
      readFile(path.join(root, '.cursor', 'commands', 'man.md'), 'utf8'),
    ).resolves.toContain('mancode workflow create man');
  });

  it('repairs the selected original entry when ordinary init is repeated', async () => {
    expect(
      await init(root, { fromCli: true, empty: true, platform: 'codex' }),
    ).toBe(EXIT_OK);
    await rm(path.join(root, '.agents', 'skills', 'man'), {
      recursive: true,
      force: true,
    });

    expect(await init(root, { fromCli: true, platform: 'codex' })).toBe(
      EXIT_ALREADY_INITIALIZED,
    );
    await expect(
      readFile(path.join(root, '.agents', 'skills', 'man', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('# mancode mode: man');
    expect(await init(root, { fromCli: true, interactive: false })).toBe(
      EXIT_ALREADY_INITIALIZED,
    );
  });

  it('never creates legacy authority inside an active V3 project', async () => {
    expect(await init(root, { v3: true, platform: 'codex' })).toBe(EXIT_OK);
    const schemaBefore = await readFile(
      path.join(root, '.mancode', 'schema.json'),
      'utf8',
    );

    expect(
      await init(root, {
        fromCli: true,
        legacy: true,
        force: true,
        platform: 'codex',
      }),
    ).toBe(EXIT_INIT_FAILED);
    await expect(
      readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ).resolves.toBe(schemaBefore);
  });

  it('preflights adapter ownership before publishing greenfield authority', async () => {
    const modePath = path.join(root, '.agents', 'skills', 'man', 'SKILL.md');
    await mkdir(path.dirname(modePath), { recursive: true });
    await writeFile(modePath, '# My own man skill\n');

    expect(await init(root, { v3: true, platform: 'codex' })).toBe(
      EXIT_INIT_FAILED,
    );
    await expect(readFile(modePath, 'utf8')).resolves.toBe(
      '# My own man skill\n',
    );
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('initializes a greenfield project without creating legacy state', async () => {
    const result = await init(root, { v3: true });

    expect(result).toBe(EXIT_OK);
    expect(
      parseSchemaManifest(
        JSON.parse(
          await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
        ),
      ).activationState,
    ).toBe('v3_active');
    await expect(
      readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(runtimeCheckoutRecordPath(root), 'utf8'),
    ).resolves.toContain('checkoutId');
  });

  it('does not silently discard a legacy-only style option', async () => {
    expect(
      await init(root, {
        fromCli: true,
        empty: true,
        platform: 'codex',
        style: 'custom',
      }),
    ).toBe(EXIT_INIT_FAILED);
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('keeps the original CLI project-boundary safety checks', async () => {
    await writeFile(path.join(root, 'notes.txt'), 'not a project\n');

    expect(
      await init(root, {
        fromCli: true,
        platform: 'codex',
      }),
    ).toBe(EXIT_NOT_A_PROJECT_DIR);
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('refuses to reinterpret legacy authority as a greenfield project', async () => {
    await mkdir(path.join(root, '.mancode'), { recursive: true });
    await writeFile(path.join(root, '.mancode', 'config.json'), '{}\n');
    let platformPrompted = false;

    expect(
      await init(root, {
        fromCli: true,
        interactive: true,
        prompter: {
          confirmGenericProject: async () => true,
          selectPlatforms: async () => {
            platformPrompted = true;
            return ['codex'];
          },
        },
      }),
    ).toBe(EXIT_INIT_FAILED);
    expect(platformPrompted).toBe(false);
    await expect(
      readFile(path.join(root, '.mancode', 'config.json'), 'utf8'),
    ).resolves.toBe('{}\n');
  });
});

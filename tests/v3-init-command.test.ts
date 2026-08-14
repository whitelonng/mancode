import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  EXIT_ALREADY_INITIALIZED,
  EXIT_INIT_FAILED,
  EXIT_NOT_A_PROJECT_DIR,
  EXIT_OK,
  EXIT_USER_CANCEL,
  init,
  resolveInitAuthority,
} from '../src/commands/init.js';
import { parseSchemaManifest } from '../src/context/manifest.js';
import { runtimeCheckoutRecordPath } from '../src/runtime/project-runtime.js';
import { VERSION } from '../src/version.js';

const PLATFORM_HINT_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CODEX_HOME',
  'CURSOR_TRACE_ID',
  'COPILOT_AGENT',
  'GITHUB_COPILOT',
  'DSH_SHELL',
] as const;

describe('journaled V3 init command', () => {
  beforeAll(() => {
    for (const name of PLATFORM_HINT_ENV_VARS) vi.stubEnv(name, undefined);
  });
  afterAll(() => vi.unstubAllEnvs());

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
      ),
    ).toMatchObject({
      manifestVersion: 2,
      activationState: 'v3_active',
      workflowPolicyDefaults: { planning: 2 },
      minReaderVersion: VERSION,
      minWriterVersion: VERSION,
    });
    await expect(
      readFile(path.join(root, '.agents', 'skills', 'man', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('mancode workflow create man');
  });

  it('refuses scratch-only .mancode non-interactively with a descriptive error', async () => {
    await mkdir(path.join(root, '.mancode', 'local', 'release-evidence'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.mancode', 'local', 'release-evidence', 'x.json'),
      '{}',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await init(root, { fromCli: true, empty: true, platform: 'codex' }),
    ).toBe(EXIT_INIT_FAILED);
    expect(error.mock.calls.flat().join(' ')).toContain(
      'MANCODE_V3_SCRATCH_TARGET_REQUIRES_CHOICE',
    );
    // Nothing moved, nothing deleted.
    await expect(
      readFile(
        path.join(root, '.mancode', 'local', 'release-evidence', 'x.json'),
        'utf8',
      ),
    ).resolves.toBe('{}');
    error.mockRestore();
  });

  it('moves scratch-only .mancode aside on consent and restores it after success', async () => {
    await mkdir(path.join(root, '.mancode', 'local', 'release-evidence'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.mancode', 'local', 'release-evidence', 'x.json'),
      '{"sha":"abc"}',
    );
    await writeFile(path.join(root, '.mancode', 'tool-notes.txt'), 'keep me');
    let askedEntries: readonly string[] = [];

    const result = await init(root, {
      fromCli: true,
      empty: true,
      interactive: true,
      platform: 'codex',
      prompter: {
        confirmGenericProject: async () => true,
        selectPlatforms: async () => ['codex'],
        resolveUnsafeAdapterPaths: async () => 'exit',
        resolveScratchMancodeTarget: async ({ entries }) => {
          askedEntries = entries;
          return 'relocate';
        },
      },
    });

    expect(result).toBe(EXIT_OK);
    expect(askedEntries).toEqual(['local', 'tool-notes.txt']);
    // Scratch keeps its old home inside the fresh layout.
    await expect(
      readFile(
        path.join(root, '.mancode', 'local', 'release-evidence', 'x.json'),
        'utf8',
      ),
    ).resolves.toBe('{"sha":"abc"}');
    // Unknown top-level entries land in preinit-scratch.
    await expect(
      readFile(
        path.join(
          root,
          '.mancode',
          'local',
          'preinit-scratch',
          'tool-notes.txt',
        ),
        'utf8',
      ),
    ).resolves.toBe('keep me');
    // No backup directory lingers after a full restore.
    expect(await readdir(root)).not.toContain(
      expect.stringMatching(/^\.mancode\.preinit-scratch-/),
    );
  });

  it('cancels cleanly when the user declines to move scratch aside', async () => {
    await mkdir(path.join(root, '.mancode', 'local', 'other-tool'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.mancode', 'local', 'other-tool', 'note.txt'),
      'untouched',
    );
    const result = await init(root, {
      fromCli: true,
      empty: true,
      interactive: true,
      platform: 'codex',
      prompter: {
        confirmGenericProject: async () => true,
        selectPlatforms: async () => ['codex'],
        resolveUnsafeAdapterPaths: async () => 'exit',
        resolveScratchMancodeTarget: async () => 'exit',
      },
    });

    expect(result).toBe(EXIT_USER_CANCEL);
    await expect(
      readFile(
        path.join(root, '.mancode', 'local', 'other-tool', 'note.txt'),
        'utf8',
      ),
    ).resolves.toBe('untouched');
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ).rejects.toThrow();
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
        resolveUnsafeAdapterPaths: async () => 'exit',
      },
    });

    expect(result).toBe(EXIT_OK);
    expect(confirmedGenericProject).toBe(true);
    await expect(
      readFile(path.join(root, '.cursor', 'commands', 'man.md'), 'utf8'),
    ).resolves.toContain('mancode workflow create man');
  });

  it('does not repair a missing registered adapter through repeated init', async () => {
    expect(
      await init(root, { fromCli: true, empty: true, platform: 'codex' }),
    ).toBe(EXIT_OK);
    await rm(path.join(root, '.agents', 'skills', 'man'), {
      recursive: true,
      force: true,
    });

    expect(await init(root, { fromCli: true, platform: 'codex' })).toBe(
      EXIT_INIT_FAILED,
    );
    await expect(
      readFile(path.join(root, '.agents', 'skills', 'man', 'SKILL.md'), 'utf8'),
    ).rejects.toThrow();
    expect(await init(root, { fromCli: true, interactive: false })).toBe(
      EXIT_ALREADY_INITIALIZED,
    );
  });

  it('does not register a new platform through repeated init', async () => {
    expect(await init(root, { v3: true })).toBe(EXIT_OK);

    expect(await init(root, { v3: true, platform: 'codex' })).toBe(
      EXIT_INIT_FAILED,
    );
    await expect(
      readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    ).rejects.toThrow();
    expect(
      parseSchemaManifest(
        JSON.parse(
          await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
        ),
      ).managedAdapters,
    ).toEqual({});
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

  it('initializes a static web project without Git or a package manifest', async () => {
    await Promise.all([
      writeFile(path.join(root, 'index.html'), '<canvas id="game"></canvas>\n'),
      writeFile(path.join(root, 'game.js'), 'console.log("game");\n'),
      writeFile(path.join(root, 'style.css'), 'body { margin: 0; }\n'),
    ]);

    expect(await init(root, { fromCli: true, platform: 'codex' })).toBe(
      EXIT_OK,
    );
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ).resolves.toContain('"activationState": "v3_active"');
  });

  it('still refuses a home directory even when it contains source files', async () => {
    await writeFile(path.join(root, 'game.js'), 'console.log("game");\n');
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(root);

    try {
      expect(await init(root, { fromCli: true, platform: 'codex' })).toBe(
        EXIT_NOT_A_PROJECT_DIR,
      );
    } finally {
      homedir.mockRestore();
    }
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
          resolveUnsafeAdapterPaths: async () => 'exit',
        },
      }),
    ).toBe(EXIT_INIT_FAILED);
    expect(platformPrompted).toBe(false);
    await expect(
      readFile(path.join(root, '.mancode', 'config.json'), 'utf8'),
    ).resolves.toBe('{}\n');
  });

  it('requires an explicit platform for a non-interactive V3 CLI with no detected hints', async () => {
    await mkdir(path.join(root, '.git'));

    expect(await init(root, { fromCli: true, interactive: false })).toBe(
      EXIT_INIT_FAILED,
    );
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('auto-selects a single detected platform hint on the V3 CLI path', async () => {
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.cursor'));

    expect(await init(root, { fromCli: true, interactive: false })).toBe(
      EXIT_OK,
    );
    await expect(
      readFile(path.join(root, '.cursor', 'commands', 'man.md'), 'utf8'),
    ).resolves.toContain('mancode workflow create man');
  });

  it('keeps --yes from silently choosing an adapter on a non-interactive V3 CLI', async () => {
    await mkdir(path.join(root, '.git'));

    expect(
      await init(root, { fromCli: true, interactive: false, yes: true }),
    ).toBe(EXIT_INIT_FAILED);
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'replaces a symlinked adapter target with a regular file when confirmed',
    async () => {
      await mkdir(path.join(root, '.git'));
      await writeFile(
        path.join(root, 'AGENTS.md'),
        '# shared agent instructions\n',
      );
      await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));
      let promptedPaths: string[] = [];

      const result = await init(root, {
        fromCli: true,
        interactive: true,
        prompter: {
          confirmGenericProject: async () => true,
          selectPlatforms: async () => ['claude-code'],
          resolveUnsafeAdapterPaths: async (context) => {
            promptedPaths = context.paths.map((item) => item.relative);
            return 'replace';
          },
        },
      });

      expect(result).toBe(EXIT_OK);
      expect(promptedPaths).toContain('CLAUDE.md');
      const entry = await lstat(path.join(root, 'CLAUDE.md'));
      expect(entry.isSymbolicLink()).toBe(false);
      const content = await readFile(path.join(root, 'CLAUDE.md'), 'utf8');
      expect(content).toContain('# shared agent instructions');
      expect(content).toContain('mancode:continuity:claude:start');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'lets the user exit cleanly instead of touching the symlink',
    async () => {
      await mkdir(path.join(root, '.git'));
      await writeFile(
        path.join(root, 'AGENTS.md'),
        '# shared agent instructions\n',
      );
      await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));

      const result = await init(root, {
        fromCli: true,
        interactive: true,
        prompter: {
          confirmGenericProject: async () => true,
          selectPlatforms: async () => ['claude-code'],
          resolveUnsafeAdapterPaths: async () => 'exit',
        },
      });

      expect(result).toBe(EXIT_USER_CANCEL);
      const entry = await lstat(path.join(root, 'CLAUDE.md'));
      expect(entry.isSymbolicLink()).toBe(true);
      await expect(
        readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
      ).rejects.toThrow();
    },
  );
});

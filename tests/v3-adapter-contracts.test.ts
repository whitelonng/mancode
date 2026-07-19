import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../src/commands/init.js';
import { install } from '../src/commands/install.js';
import { listPlatforms } from '../src/commands/list-platforms.js';
import { refreshProject } from '../src/commands/refresh-project.js';
import { type V3StatusResult, status } from '../src/commands/status.js';
import {
  EXIT_V3_AUTHORITY_PROTECTED,
  uninstall,
} from '../src/commands/uninstall.js';
import type { PlatformName } from '../src/installers/registry.js';
import {
  V3_MODE_NAMES,
  inspectV3Adapter,
  installV3Adapter,
  removeV3Adapter,
  stageV3Adapter,
  v3ModeEntryPath,
} from '../src/installers/v3-adapter.js';

describe('V3 adapter bootstrap integration', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-adapter-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses V3 status and bootstrap-only adapters without creating legacy authority', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await init(root, { v3: true, platform: 'codex' })).toBe(0);
      await expect(
        readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
      ).rejects.toThrow();
      const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('# mancode bootstrap');
      expect(agents).toContain('mancode context show --purpose orient');
      expect(agents).not.toContain('.mancode/state.json');
      expect(agents).not.toContain('currentMode');

      logs.mockClear();
      expect(await status(root, { json: true })).toBe(0);
      const result = JSON.parse(
        String(logs.mock.calls.at(-1)?.[0]),
      ) as V3StatusResult;
      expect(result).toMatchObject({
        authority: 'v3',
        runtime: { binding: 'ready' },
        adapters: {
          codex: {
            installed: true,
            ready: true,
            capabilities: { sessionIdentity: 'explicit-required' },
          },
          cursor: { installed: false },
        },
        sessionEvidence: {
          ready: false,
          missingPlatforms: expect.arrayContaining(['codex']),
        },
      });
      expect(result.activation.managedAdapters.codex).toBe('3');

      logs.mockClear();
      expect(await status(root, {})).toBe(0);
      const textOutput = logs.mock.calls.flat().join('\n');
      expect(textOutput).toContain('Session evidence: explicit required');
      expect(textOutput).toContain('codex');
      expect(textOutput).not.toContain('explicit required ()');

      expect(await install(root, 'cursor')).toBe(0);
      const cursorRule = await readFile(
        path.join(root, '.cursor', 'rules', 'mancode-v3.mdc'),
        'utf8',
      );
      expect(cursorRule).toContain('# mancode bootstrap');
      await expect(
        readFile(path.join(root, '.mancode', 'config.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it.each(['claude-code', 'codex', 'cursor', 'copilot', 'zcode'] as const)(
    'applies the common V3 bootstrap contract for %s',
    async (platform: PlatformName) => {
      await init(root, { v3: true });

      const installed = await installV3Adapter(root, platform);
      expect(installed).toMatchObject({
        installed: true,
        ready: true,
        version: '3',
        capabilities: {
          sessionIdentity: 'explicit-required',
          sessionHook: false,
          promptHook: false,
        },
      });
      const target = path.join(root, installed.target);
      const bootstrap = await readFile(target, 'utf8');
      expect(bootstrap).toContain('# mancode bootstrap');
      expect(bootstrap).toContain('mancode context show --purpose orient');
      expect(bootstrap).toContain('--session <id>');
      expect(bootstrap).toContain('First run `mancode status --json`');
      expect(bootstrap).toContain(
        'In operator-facing narration, say `mancode`',
      );
      expect(bootstrap).toContain('mancode team identity create --name');
      expect(bootstrap).toContain(
        '`currentTask: null` and `MANCODE_TASK_REQUIRED` do not make a session stale',
      );
      expect(bootstrap).toContain(
        'Do not probe workflow subcommands to work around `MANCODE_TASK_REQUIRED`',
      );
      expect(bootstrap).toContain(
        'An explicitly invoked original `man`, `manba`, `manteam`, `manps`, or `mansolo` entry supplies its authorized action',
      );
      expect(bootstrap).toContain(
        'before the operator explicitly requests task work, do not run `mancode init`, `mancode migrate`, `mancode workflow`',
      );
      expect(bootstrap).toContain(
        'an `export` inside one command tool does not persist to later command tools',
      );
      expect(bootstrap).toContain(
        'reuse any explicit session ID already returned in this conversation',
      );
      expect(bootstrap).not.toMatch(/\bV3\b/);
      expect(bootstrap).not.toContain('.mancode/state.json');
      expect(bootstrap).not.toContain('currentMode');
      const bootstrapSessionCommands = Array.from(
        bootstrap.matchAll(/`(mancode [^`\n]*--session <id>[^`\n]*)`/g),
        (match) => match[1] ?? '',
      );
      expect(bootstrapSessionCommands.length).toBeGreaterThan(0);
      expect(
        bootstrapSessionCommands.every((command) =>
          command.includes('--client'),
        ),
      ).toBe(true);
      if (platform === 'claude-code') {
        expect(bootstrap).toContain('user-invocable: false');
      }

      for (const mode of V3_MODE_NAMES) {
        const entry = await readFile(
          v3ModeEntryPath(root, platform, mode),
          'utf8',
        );
        if (
          platform === 'claude-code' ||
          platform === 'codex' ||
          platform === 'zcode'
        ) {
          expect(entry).toContain(`name: ${mode}`);
        }
        const description = entry.match(/^description: "([^"]+)"$/m)?.[1];
        expect(description).toContain('mancode');
        expect(description).not.toContain('V3');
        expect(entry).toContain('# mancode mode');
        expect(entry).toContain('## Enter through mancode');
        expect(entry).toContain('In operator-facing narration, say `mancode`');
        expect(entry).not.toMatch(/\bV3\b/);
        expect(entry).toContain('mancode status --json');
        expect(entry).not.toContain('.mancode/state.json');
        if (mode !== 'manps') {
          const sessionCommands = Array.from(
            entry.matchAll(/`(mancode [^`\n]*--session <id>[^`\n]*)`/g),
            (match) => match[1] ?? '',
          );
          expect(sessionCommands.length).toBeGreaterThan(0);
          expect(
            sessionCommands.every((command) => command.includes('--client')),
          ).toBe(true);
        }
        if (mode === 'man') {
          expect(entry).toContain('read-only project orientation');
          expect(entry).toContain(
            'without creating an actor, session, TaskRef, or workflow',
          );
          expect(entry).toContain('internal IDs and digests');
        }
        if (mode === 'manps') {
          expect(entry).toContain(
            'A local scan needs no TaskRef, actor identity, or explicit session',
          );
          expect(entry).toContain(
            'do not require a TaskRef, workflow revision, actor, or session',
          );
          expect(entry).not.toContain('For every mutation, use the TaskRef');
        }
        if (mode === 'mansolo') {
          expect(entry).toContain('Ordinary focused work needs no TaskRef');
          expect(entry).toContain(
            'Only an explicit governed handoff mutation requires',
          );
        }
        if (mode === 'man' || mode === 'manba' || mode === 'manteam') {
          expect(entry).toContain(`mancode workflow create ${mode}`);
        }
      }

      // Installation is an idempotent bootstrap renderer, not task authority.
      await installV3Adapter(root, platform);
      expect(await inspectV3Adapter(root, platform)).toMatchObject({
        installed: true,
        ready: true,
      });
      await expect(
        readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
      ).rejects.toThrow();

      await removeV3Adapter(root, platform);
      expect(await inspectV3Adapter(root, platform)).toMatchObject({
        installed: false,
        ready: false,
      });
      if (platform !== 'codex' && platform !== 'zcode') {
        await expect(
          readFile(v3ModeEntryPath(root, platform, 'man'), 'utf8'),
        ).rejects.toThrow();
      }
    },
  );

  it('preserves user instructions outside the V3 managed block', async () => {
    await init(root, { v3: true });
    await writeFile(path.join(root, 'AGENTS.md'), '# User instructions\n');

    expect(await install(root, 'codex')).toBe(0);
    expect(await install(root, 'codex')).toBe(0);
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# User instructions');
    expect(agents.match(/mancode:v3:codex:start/g)).toHaveLength(1);
  });

  it('stages the bootstrap and every original mode entry without changing live files', async () => {
    await mkdir(path.join(root, '.mancode'), { recursive: true });

    const staged = await stageV3Adapter(root, 'cursor');

    expect(staged.modeEntries.map((entry) => entry.mode)).toEqual([
      ...V3_MODE_NAMES,
    ]);
    await expect(
      readFile(path.join(root, staged.stagingTarget), 'utf8'),
    ).resolves.toContain('# mancode bootstrap');
    for (const entry of staged.modeEntries) {
      await expect(
        readFile(path.join(root, entry.stagingTarget), 'utf8'),
      ).resolves.toContain(`# mancode mode: ${entry.mode}`);
    }
    await expect(
      readFile(path.join(root, '.cursor', 'commands', 'man.md'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, '.cursor', 'rules', 'mancode-v3.mdc'), 'utf8'),
    ).rejects.toThrow();
  });

  it('keeps shared Codex and ZCode original mode entries host-neutral', async () => {
    await init(root, { v3: true });
    await installV3Adapter(root, 'codex');
    const modePath = v3ModeEntryPath(root, 'codex', 'man');
    const afterCodex = await readFile(modePath, 'utf8');
    expect(afterCodex).toContain('--client codex');
    expect(afterCodex).toContain('--client zcode');
    const agentsAfterCodex = await readFile(
      path.join(root, 'AGENTS.md'),
      'utf8',
    );

    await installV3Adapter(root, 'zcode');
    await expect(readFile(modePath, 'utf8')).resolves.toBe(afterCodex);
    const agentsAfterZcode = await readFile(
      path.join(root, 'AGENTS.md'),
      'utf8',
    );
    expect(agentsAfterZcode).toContain('--client codex');
    expect(agentsAfterZcode).toContain('--client zcode');
    expect(agentsAfterCodex).toContain('Codex or ZCode');
  });

  it('refuses to overwrite a user-authored original mode entry', async () => {
    await init(root, { v3: true });
    const modePath = v3ModeEntryPath(root, 'codex', 'man');
    await mkdir(path.dirname(modePath), { recursive: true });
    await writeFile(modePath, '# My own man skill\n');

    await expect(installV3Adapter(root, 'codex')).rejects.toThrow(
      'MANCODE_V3_MODE_ENTRY_USER_AUTHORED',
    );
    await expect(readFile(modePath, 'utf8')).resolves.toBe(
      '# My own man skill\n',
    );
    await expect(
      readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked adapter parent without writing outside the project',
    async () => {
      await init(root, { v3: true });
      const outside = `${root}-outside`;
      await mkdir(outside, { recursive: true });
      try {
        await symlink(outside, path.join(root, '.agents'));

        await expect(installV3Adapter(root, 'codex')).rejects.toThrow(
          'MANCODE_ARTIFACT_PATH_UNSAFE',
        );
        await expect(
          readFile(path.join(outside, 'AGENTS.md')),
        ).rejects.toThrow();
        await expect(
          readFile(path.join(outside, 'skills', 'man', 'SKILL.md')),
        ).rejects.toThrow();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('retires legacy managed entrypoints when repairing an active V3 adapter', async () => {
    await init(root, { v3: true });
    const legacyCodexAlias = path.join(
      root,
      '.agents',
      'skills',
      'mamba',
      'SKILL.md',
    );
    await mkdir(path.dirname(legacyCodexAlias), { recursive: true });
    await writeFile(
      legacyCodexAlias,
      '<!-- Managed by mancode:codex-skill. Do not edit this file manually. -->\nRead `.mancode/state.json`.\n',
    );
    await writeFile(
      path.join(root, 'AGENTS.md'),
      [
        '# User instructions',
        '<!-- mancode:start -->',
        'Read `.mancode/state.json`.',
        '<!-- mancode:end -->',
        '<!-- mancode:zcode:start -->',
        'Also read `.mancode/state.json`.',
        '<!-- mancode:zcode:end -->',
      ].join('\n'),
    );
    await installV3Adapter(root, 'codex');
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# User instructions');
    expect(agents).not.toContain('.mancode/state.json');
    const codexAlias = await readFile(legacyCodexAlias, 'utf8');
    expect(codexAlias).toContain('# mancode mode compatibility alias');
    expect(codexAlias).toContain('public mancode mode `manba`');
    expect(codexAlias).not.toContain('.mancode/state.json');
    await removeV3Adapter(root, 'codex');
    await expect(readFile(legacyCodexAlias, 'utf8')).rejects.toThrow();

    await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
    await writeFile(
      path.join(root, '.cursor', 'rules', 'mancode-context.mdc'),
      '<!-- Managed by mancode:cursor-rule. Do not edit this marker. -->\nRead `.mancode/state.json`.\n',
    );
    const legacyCursorAlias = path.join(
      root,
      '.cursor',
      'rules',
      'mancode-mamba.mdc',
    );
    await writeFile(
      legacyCursorAlias,
      '<!-- Managed by mancode:cursor-rule. Do not edit this marker. -->\nRead `.mancode/state.json`.\n',
    );
    await installV3Adapter(root, 'cursor');
    const cursorRule = await readFile(
      path.join(root, '.cursor', 'rules', 'mancode-context.mdc'),
      'utf8',
    );
    expect(cursorRule).toContain('alwaysApply: false');
    expect(cursorRule).not.toContain('.mancode/state.json');
    const cursorAlias = await readFile(legacyCursorAlias, 'utf8');
    expect(cursorAlias).toContain('Use the `/manba` mancode mode command.');
    expect(cursorAlias).not.toContain('.mancode/state.json');
    await removeV3Adapter(root, 'cursor');
    await expect(
      readFile(
        path.join(root, '.cursor', 'rules', 'mancode-context.mdc'),
        'utf8',
      ),
    ).rejects.toThrow();
    await expect(readFile(legacyCursorAlias, 'utf8')).rejects.toThrow();

    await mkdir(path.join(root, '.claude', 'skills', 'solo'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.claude', 'skills', 'solo', 'SKILL.md'),
      '<!-- Managed by mancode:claude-skill. Do not edit this marker. -->\nRead `.mancode/state.json`.\n',
    );
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(
      path.join(root, '.claude', 'settings.json'),
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node ".mancode/hooks/session-start.mjs"',
                },
                { type: 'command', command: 'node user-hook.mjs' },
              ],
            },
          ],
        },
      })}\n`,
    );
    await installV3Adapter(root, 'claude-code');
    const settings = await readFile(
      path.join(root, '.claude', 'settings.json'),
      'utf8',
    );
    expect(settings).not.toContain('session-start.mjs');
    expect(settings).toContain('node user-hook.mjs');
    await expect(
      readFile(
        path.join(root, '.claude', 'skills', 'solo', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toContain('# mancode mode compatibility alias');
    await removeV3Adapter(root, 'claude-code');
    await expect(
      readFile(
        path.join(root, '.claude', 'skills', 'solo', 'SKILL.md'),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('stages a dual-read adapter candidate without changing the live target', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await init(root, { v3: true })).toBe(0);
      const schemaPath = path.join(root, '.mancode', 'schema.json');
      const manifest = JSON.parse(await readFile(schemaPath, 'utf8'));
      await writeFile(
        schemaPath,
        `${JSON.stringify(
          {
            ...manifest,
            activationState: 'dual_read',
            activatedAt: null,
            legacyBaseline: {
              stateDigest: `sha256:${'a'.repeat(64)}`,
              workflowIndexDigest: `sha256:${'b'.repeat(64)}`,
            },
          },
          null,
          2,
        )}\n`,
      );
      const liveAgents = '# User instructions\n';
      await writeFile(path.join(root, 'AGENTS.md'), liveAgents);

      expect(await install(root, 'codex', { shadow: true })).toBe(0);
      await expect(
        readFile(path.join(root, 'AGENTS.md'), 'utf8'),
      ).resolves.toBe(liveAgents);
      await expect(
        readFile(
          path.join(
            root,
            '.mancode',
            'staging',
            'adapters',
            'v3',
            'codex',
            'AGENTS.md',
          ),
          'utf8',
        ),
      ).resolves.toContain('# mancode bootstrap');
      expect(logs.mock.calls.flat().join(' ')).toContain(
        'staged for shadow comparison',
      );
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('persists detected project facts and refreshes them without legacy state', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      );
      expect(await init(root, { v3: true })).toBe(0);

      const initialFacts = JSON.parse(
        await readFile(
          path.join(root, '.mancode', 'shared', 'context', 'project.json'),
          'utf8',
        ),
      );
      expect(initialFacts).toMatchObject({
        schemaVersion: 1,
        revision: 1,
        trust: 'detected',
        profile: {
          projectKind: 'web',
          languages: ['JavaScript/TypeScript'],
          frameworks: ['React'],
          sourceRoots: ['src'],
        },
      });

      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          dependencies: { react: '^19.0.0', tailwindcss: '^4.0.0' },
        }),
      );
      expect(await refreshProject(root)).toBe(0);
      const refreshedFacts = JSON.parse(
        await readFile(
          path.join(root, '.mancode', 'shared', 'context', 'project.json'),
          'utf8',
        ),
      );
      expect(refreshedFacts).toMatchObject({
        revision: 2,
        profile: { frameworks: ['React', 'Tailwind CSS'] },
        uiLibrary: 'Tailwind CSS',
      });
      await expect(
        readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('lists and removes only V3 bootstrap files without treating V3 authority as legacy state', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await init(root, { v3: true, platform: 'codex' })).toBe(0);
      expect(await listPlatforms(root)).toBe(0);
      expect(logs.mock.calls.flat().join(' ')).toContain(
        'Available platforms (mancode bootstrap)',
      );
      expect(logs.mock.calls.flat().join(' ')).toContain('codex');

      expect(await uninstall(root, 'codex', { force: true })).toBe(0);
      await expect(
        readFile(path.join(root, 'AGENTS.md'), 'utf8'),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
      ).resolves.toContain('v3_active');
      expect(await uninstall(root, undefined, { all: true })).toBe(
        EXIT_V3_AUTHORITY_PROTECTED,
      );
      expect(errors.mock.calls.flat().join('\n')).toContain(
        'context compact --dry-run',
      );
      expect(errors.mock.calls.flat().join('\n')).not.toContain(
        'archive/migration workflow',
      );
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });
});

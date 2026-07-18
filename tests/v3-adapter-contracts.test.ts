import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  inspectV3Adapter,
  installV3Adapter,
  removeV3Adapter,
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
      expect(agents).toContain('# mancode V3 bootstrap');
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

      expect(await install(root, 'cursor')).toBe(0);
      const cursorRule = await readFile(
        path.join(root, '.cursor', 'rules', 'mancode-v3.mdc'),
        'utf8',
      );
      expect(cursorRule).toContain('# mancode V3 bootstrap');
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
      expect(bootstrap).toContain('# mancode V3 bootstrap');
      expect(bootstrap).toContain('mancode context show --purpose orient');
      expect(bootstrap).toContain('--session <id>');
      expect(bootstrap).not.toContain('.mancode/state.json');
      expect(bootstrap).not.toContain('currentMode');

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
      ).resolves.toContain('# mancode V3 bootstrap');
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
        'Available platforms (V3 bootstrap)',
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
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AdapterStatusOptions,
  adapterStatus,
} from '../src/commands/adapter.js';
import { init } from '../src/commands/init.js';
import type { PlatformName } from '../src/installers/registry.js';
import {
  type V3PlatformAdapterStatus,
  installV3Adapter,
} from '../src/installers/v3-adapter.js';

interface AdapterStatusJson {
  schemaVersion: 1;
  renderer: 'mancode-adapter-digest-v1';
  ready: boolean;
  manifestAdapters: Partial<Record<PlatformName, string>>;
  adapters: Partial<Record<PlatformName, V3PlatformAdapterStatus>>;
}

describe('adapter status command contracts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-adapter-status-'));
    expect(
      await withoutConsoleOutput(() =>
        init(root, { v3: true, platform: 'codex' }),
      ),
    ).toBe(0);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports a Codex-only project ready while retaining all-platform discovery', async () => {
    const result = await captureJson({ json: true });

    expect(result).toMatchObject({
      schemaVersion: 1,
      renderer: 'mancode-adapter-digest-v1',
      ready: true,
      manifestAdapters: { codex: '3' },
      adapters: {
        codex: { installed: true, ready: true, status: 'ready' },
        cursor: { installed: false, ready: false, status: 'missing' },
      },
    });
    expect(Object.keys(result.adapters)).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'copilot',
      'zcode',
    ]);
  });

  it('reports not ready when a manifest-required adapter is incomplete', async () => {
    await rm(path.join(root, '.agents', 'skills', 'man', 'SKILL.md'));

    const result = await captureJson({ json: true });

    expect(result).toMatchObject({
      ready: false,
      manifestAdapters: { codex: '3' },
      adapters: { codex: { installed: false, ready: false } },
    });
  });

  it('scopes readiness to an explicitly selected platform', async () => {
    const registered = await captureJson({ platform: 'codex', json: true });
    expect(registered).toMatchObject({
      ready: true,
      manifestAdapters: { codex: '3' },
      adapters: { codex: { ready: true } },
    });
    expect(Object.keys(registered.adapters)).toEqual(['codex']);

    const unregistered = await captureJson({
      platform: 'cursor',
      json: true,
    });
    expect(unregistered).toMatchObject({
      ready: false,
      manifestAdapters: {},
      adapters: { cursor: { installed: false, ready: false } },
    });
    expect(Object.keys(unregistered.adapters)).toEqual(['cursor']);
  });

  it('rejects a manifest renderer version that differs from ready disk content', async () => {
    const schemaPath = path.join(root, '.mancode', 'schema.json');
    const manifest = JSON.parse(await readFile(schemaPath, 'utf8')) as {
      managedAdapters: Record<string, string>;
    };
    manifest.managedAdapters.codex = '2';
    await writeFile(schemaPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await captureJson({ json: true });

    expect(result).toMatchObject({
      ready: false,
      manifestAdapters: { codex: '2' },
      adapters: { codex: { version: '3', ready: true } },
    });
  });

  it.each(['missing', 'stale', 'unreadable'] as const)(
    'does not confuse the %s content status with a manifest version',
    async (collision) => {
      const target = path.join(root, '.agents', 'skills', 'man', 'SKILL.md');
      if (collision === 'missing') {
        await rm(target);
      } else if (collision === 'stale') {
        await writeFile(target, 'stale adapter content\n');
      } else {
        await writeFile(target, Buffer.from([0xff]));
      }
      const schemaPath = path.join(root, '.mancode', 'schema.json');
      const manifest = JSON.parse(await readFile(schemaPath, 'utf8')) as {
        managedAdapters: Record<string, string>;
      };
      manifest.managedAdapters.codex = collision;
      await writeFile(schemaPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = await captureJson({ json: true });

      expect(result).toMatchObject({
        ready: false,
        manifestAdapters: { codex: collision },
        adapters: { codex: { status: collision, ready: false } },
      });
    },
  );

  it('rejects an on-disk adapter that is absent from manifest inventory', async () => {
    await installV3Adapter(root, 'cursor');

    const result = await captureJson({ json: true });
    const selected = await captureJson({ platform: 'cursor', json: true });

    expect(result).toMatchObject({
      ready: false,
      manifestAdapters: { codex: '3' },
      adapters: { cursor: { version: '3', ready: true } },
    });
    expect(selected).toMatchObject({
      ready: false,
      manifestAdapters: {},
      adapters: { cursor: { version: '3', ready: true } },
    });
  });

  async function captureJson(
    options: AdapterStatusOptions,
  ): Promise<AdapterStatusJson> {
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((value) => {
      output.push(String(value));
    });
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      expect(await adapterStatus(root, options)).toBe(0);
      const serialized = output.at(-1);
      if (serialized === undefined) {
        throw new Error('missing adapter status JSON output');
      }
      return JSON.parse(serialized) as AdapterStatusJson;
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }
});

async function withoutConsoleOutput(
  operation: () => Promise<number>,
): Promise<number> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return await operation();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

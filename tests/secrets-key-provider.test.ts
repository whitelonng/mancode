import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSecretCommands } from '../src/commands/secret.js';
import { createUlid } from '../src/context/ids.js';
import { MacKeyProvider } from '../src/secrets/key-provider.js';
import * as vaultModule from '../src/secrets/vault.js';

const native = vi.hoisted(() => ({
  stage: 'none',
  detail:
    'synthetic-private-key /synthetic/private/request.json user@example.test',
  get: vi.fn(),
  set: vi.fn(),
  constructor: vi.fn(),
  written: undefined as Uint8Array | undefined,
}));
// Replace only the native dependency. MacKeyProvider, Vault and the CLI error
// boundary are production code; these are not real Keychain lock/denial tests.
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(service: string, keyId: string) {
      native.constructor(service, keyId);
      if (native.stage === 'constructor') throw new Error(native.detail);
    }
    getSecret() {
      native.get();
      if (native.stage === 'get') throw new Error(native.detail);
      return null;
    }
    setSecret(key: Uint8Array) {
      native.set();
      native.written = key;
      if (native.stage === 'set') throw new Error(native.detail);
    }
  },
}));
let root: string;
let context: vaultModule.VaultContext;
let previousExit: typeof process.exitCode;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'mancode-key-provider-')),
  );
  context = {
    directory: path.join(root, 'vault'),
    workspaceId: createUlid(),
    keys: new MacKeyProvider(),
  };
  native.stage = 'none';
  native.written = undefined;
  vi.clearAllMocks();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  previousExit = process.exitCode;
});
afterEach(async () => {
  process.exitCode = previousExit;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
  'MacKeyProvider native exception boundary',
  () => {
    it.each(['constructor', 'get', 'set'])(
      'maps native %s errors and never writes a plaintext fallback',
      async (stage) => {
        native.stage = stage;
        await expect(
          vaultModule.Vault.transaction(context, true, (v) =>
            v.set('contact', 'text', 'neutral', 'synthetic-vault-value'),
          ),
        ).rejects.toMatchObject({
          code: 'KEYSTORE_UNAVAILABLE',
          message: 'KEYSTORE_UNAVAILABLE',
        });
        expect(native.constructor).toHaveBeenCalledWith(
          'mancode.secrets.v1',
          expect.any(String),
        );
        expect(native.set).toHaveBeenCalledTimes(stage === 'set' ? 1 : 0);
        await expect(
          readFile(path.join(context.directory, 'vault.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          readFile(path.join(context.directory, 'registry.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        if (stage === 'set') {
          expect(native.written).toHaveLength(32);
          expect([...(native.written ?? [])]).toEqual(Array(32).fill(0));
        }
      },
    );

    it.each(['constructor', 'get'])(
      'CLI hides native %s exception details before executor startup',
      async (stage) => {
        await vaultModule.Vault.transaction(
          { ...context, keys: { get: async () => Buffer.alloc(32, 83) } },
          true,
          (v) => v.set('contact', 'text', 'neutral', 'synthetic-vault-value'),
        );
        const before = await readFile(
          path.join(context.directory, 'vault.json'),
        );
        const input = path.join(root, 'request.json');
        await writeFile(input, '{}');
        native.stage = stage;
        vi.spyOn(vaultModule, 'vaultContext').mockResolvedValue(context);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const program = new Command();
        registerSecretCommands(program);
        await program.parseAsync(
          ['secret', 'run', 'notice', '--input', input, '--json'],
          { from: 'user' },
        );
        expect(process.exitCode).toBe(5);
        expect(log).toHaveBeenCalledTimes(1);
        const printed = String(log.mock.calls[0]?.[0]);
        expect(JSON.parse(printed)).toEqual({
          schemaVersion: 1,
          runId: expect.any(String),
          action: 'notice',
          status: 'rejected',
          code: 'KEYSTORE_UNAVAILABLE',
        });
        expect(printed).not.toContain(native.detail);
        expect(printed).not.toContain('synthetic-vault-value');
        expect(errors).not.toHaveBeenCalled();
        expect(native.set).not.toHaveBeenCalled();
        expect(
          await readFile(path.join(context.directory, 'vault.json')),
        ).toEqual(before);
        // There is no approved action; reaching action lookup instead of failing at
        // the backend would return ACTION_NOT_APPROVED and fail the exact assertion.
        await expect(
          readFile(path.join(context.directory, 'audit.jsonl')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  },
);

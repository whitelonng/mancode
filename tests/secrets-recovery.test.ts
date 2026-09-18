import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { createUlid } from '../src/context/ids.js';
import type { ApprovedAction } from '../src/secrets/types.js';
import { Vault, type VaultContext } from '../src/secrets/vault.js';

let bundleRoot: string;
let moduleFile: string;
let root: string;
let context: VaultContext;
let original: Buffer;
const childFile = path.resolve('tests/fixtures/secrets/recovery-child.cjs');
const committedPhases = new Set([
  'after-rename',
  'directory-sync',
  'registry-write',
]);
const phases = [
  'partial-write',
  'file-synced',
  'before-rename',
  'after-rename',
  'directory-sync',
  'registry-write',
];
function args(
  operation: string,
  phase = 'none',
  failure = 'none',
  clock = 'current',
) {
  return [
    childFile,
    moduleFile,
    context.directory,
    context.workspaceId,
    operation,
    phase,
    failure,
    clock,
  ];
}
function fresh(operation: string, clock = 'current') {
  const result = spawnSync(
    process.execPath,
    args(operation, 'none', 'none', clock),
    {
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  return { status: result.status, body: JSON.parse(result.stdout) };
}

describe.skipIf(process.platform === 'win32')(
  'Secrets interrupted authority recovery',
  () => {
    beforeAll(async () => {
      bundleRoot = await mkdtemp(
        path.join(os.tmpdir(), 'mancode-secrets-module-'),
      );
      moduleFile = path.join(bundleRoot, 'vault.cjs');
      await build({
        entryPoints: ['src/secrets/vault.ts'],
        outfile: moduleFile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        mainFields: ['module', 'main'],
        external: ['@napi-rs/keyring'],
      });
    });
    afterAll(async () => rm(bundleRoot, { recursive: true, force: true }));
    beforeEach(async () => {
      root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'mancode-secrets-crash-')),
      );
      context = {
        directory: path.join(root, 'vault'),
        workspaceId: createUlid(),
        keys: { get: async () => Buffer.alloc(32, 83) },
      };
      await Vault.transaction(context, true, async (v) => {
        await v.set('contact', 'text', 'neutral', 'synthetic-old');
        const s = v.secret('contact');
        // Authenticated storage fixture only; no executor is installed or launched.
        const action: ApprovedAction = {
          spec: {
            schemaVersion: 1,
            name: 'notice',
            version: '1',
            executable: '/synthetic/node',
            packagePath: '/synthetic/package',
            entry: 'main.cjs',
            fields: {},
            credentials: { token: 'contact' },
            fixed: {},
            target: 'synthetic',
            effects: 'none',
            output: 'status-only',
            timeoutMs: 1000,
            outputBytes: 1024,
          },
          revision: 1,
          workspaceId: context.workspaceId,
          installId: 'synthetic',
          executableDigest: 'synthetic',
          runtimeFiles: {},
          files: {},
          bindings: { contact: { entryId: s.entryId, revision: s.revision } },
        };
        await v.approve(action);
      });
      original = await readFile(path.join(context.directory, 'vault.json'));
    });
    afterEach(async () => rm(root, { recursive: true, force: true }));

    async function verifyRecovery(phase: string, clock: string) {
      const committed = committedPhases.has(phase);
      const recovered = fresh('inspect', clock);
      expect(recovered.status).toBe(0);
      expect(recovered.body).toEqual({
        value: committed ? 'synthetic-new' : 'synthetic-old',
        revision: committed ? 2 : 1,
        metadataRevision: committed ? 2 : 1,
        entryIdMatches: true,
        approvalRevision: 1,
        authorization: committed ? 'ACTION_CHANGED' : 'valid',
      });
      const authority = await readFile(
        path.join(context.directory, 'vault.json'),
      );
      if (!committed) expect(authority).toEqual(original);
      // Inspect real writer leftovers rather than creating a pretend orphan file.
      for (const file of await readdir(context.directory)) {
        if (file === 'vault.json' || file.endsWith('.tmp')) {
          const bytes = await readFile(
            path.join(context.directory, file),
            'utf8',
          );
          expect(bytes).not.toContain('synthetic-old');
          expect(bytes).not.toContain('synthetic-new');
        }
      }
      const repaired = fresh('repair', clock);
      expect(repaired.status).toBe(0);
      expect(
        repaired.body.catalogue.items
          .map((x: { name: string }) => x.name)
          .sort(),
      ).toEqual(['contact', 'second']);
      expect(repaired.body.catalogue.actions).toHaveLength(committed ? 0 : 1);
    }

    it.each(phases)(
      'fails at %s and a new process opens only a consistent authority',
      async (phase) => {
        const failed = spawnSync(
          process.execPath,
          args('update', phase, 'error'),
          { encoding: 'utf8', timeout: 10000 },
        );
        expect(failed.status).toBe(2);
        expect(JSON.parse(failed.stdout)).toEqual({
          error: 'EIO',
          reached: true,
        });
        expect(failed.stderr).toBe('');
        await verifyRecovery(phase, 'current');
      },
      15000,
    );

    it.each(phases)(
      'recovers after an actual writer is killed at %s',
      async (phase) => {
        const child = spawn(process.execPath, args('update', phase, 'kill'), {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = once(child, 'exit');
        let stderr = '';
        child.stderr.on('data', (b) => {
          stderr += b;
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(new Error(`Writer did not reach ${phase}: ${stderr}`)),
              5000,
            );
            child.stdout.on('data', (b) => {
              if (String(b).includes('ready')) {
                clearTimeout(timer);
                resolve();
              }
            });
            child.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once('exit', () => {
              clearTimeout(timer);
              reject(new Error(`Writer exited early: ${stderr}`));
            });
          });
          // A separate delete cannot steal even an expired lock from a living writer.
          expect(fresh('remove', 'expired')).toMatchObject({
            status: 2,
            body: { error: 'MANCODE_LOCK_HELD' },
          });
          child.kill('SIGKILL');
          const [, signal] = await exited;
          expect(signal).toBe('SIGKILL');
          expect(stderr).toBe('');
          // Death alone does not authorize lease bypass. Advance the reader's test clock
          // only after proving that the immediate post-crash attempt remains blocked.
          expect(fresh('inspect')).toMatchObject({
            status: 2,
            body: { error: 'MANCODE_LOCK_HELD' },
          });
          await verifyRecovery(phase, 'expired');
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
          }
        }
      },
      15000,
    );
  },
);

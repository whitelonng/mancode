import * as childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSecretCommands } from '../src/commands/secret.js';
import { createUlid } from '../src/context/ids.js';
import {
  installAction,
  parseAction,
  prepareAction,
} from '../src/secrets/actions.js';
import { regularFile } from '../src/secrets/io.js';
import { runSecret } from '../src/secrets/run.js';
import type { ActionSpec, ApprovedAction } from '../src/secrets/types.js';
import * as vaultModule from '../src/secrets/vault.js';
import { Vault, type VaultContext } from '../src/secrets/vault.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
}));
vi.mock('node:readline/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof readline>()),
}));

const actualSpawn = childProcess.spawn;
let root: string;
let context: VaultContext;
let key: Buffer;
let spec: ActionSpec;
let input: string;
let report: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'secrets-fix-')));
  key = randomBytes(32);
  context = {
    directory: path.join(root, 'vault'),
    workspaceId: createUlid(),
    keys: { get: async () => Buffer.from(key) },
  };
  const pkg = path.join(root, 'package');
  await mkdir(pkg);
  await writeFile(path.join(pkg, 'main.cjs'), 'process.stdin.resume();');
  input = path.join(root, 'input.json');
  report = path.join(root, 'runs.jsonl');
  await writeFile(input, '{}');
  spec = parseAction({
    schemaVersion: 1,
    name: 'fixture',
    version: '1',
    executable: await realpath(process.execPath),
    packagePath: pkg,
    entry: 'main.cjs',
    fields: {},
    credentials: { token: 'credential' },
    fixed: {},
    target: 'Local synthetic fixture',
    effects: 'Write only non-sensitive test observations',
    output: 'status-only',
    timeoutMs: 2000,
    outputBytes: 4096,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  key.fill(0);
  await rm(root, { recursive: true, force: true });
});

async function initialize() {
  await Vault.transaction(context, true, (v) =>
    v.set('credential', 'text', 'Synthetic fixture', 'synthetic-only'),
  );
}
async function approve() {
  await initialize();
  let approved: ApprovedAction | undefined;
  await Vault.transaction(context, false, async (v) => {
    const prepared = await prepareAction(v, spec);
    approved = prepared.action;
    await installAction(v, prepared);
  });
  return approved as ApprovedAction;
}
async function scratchExecutor(tail = '') {
  await writeFile(
    path.join(spec.packagePath, spec.entry),
    `const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
process.stdin.resume();process.stdin.on('end',()=>{
 const temporary=os.tmpdir();
 fs.writeFileSync(path.join(temporary,'scratch.txt'),'non-sensitive');
 fs.appendFileSync(${JSON.stringify(report)},JSON.stringify({temporary,cwd:process.cwd(),mode:fs.statSync(temporary).mode&511})+'\\n');
 ${tail}
});`,
  );
}
async function observations(): Promise<
  { temporary: string; cwd: string; mode: number }[]
> {
  return (await readFile(report, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
async function expectCleanScratch() {
  const runs = await observations();
  for (const run of runs) {
    expect(run.mode).toBe(0o700);
    expect(run.temporary).not.toBe(run.cwd);
    expect(path.relative(run.cwd, run.temporary).startsWith('..')).toBe(true);
    await expect(readdir(run.temporary)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(run.cwd)).toEqual(['main.cjs']);
  }
  return runs;
}

describe('Secrets bounded file storage', () => {
  it('retains compact buffers for a package containing many small files', async () => {
    const values: Buffer[] = [];
    for (let i = 0; i < 16; i++) {
      const file = path.join(root, `small-${i}`);
      await writeFile(file, 'small fixture');
      values.push(await regularFile(file, 16 * 1024 * 1024));
    }
    expect(values.every((value) => value.toString() === 'small fixture')).toBe(
      true,
    );
    const buffers = new Set(values.map((value) => value.buffer));
    const retainedBytes = [...buffers].reduce((n, b) => n + b.byteLength, 0);
    expect(retainedBytes).toBeLessThanOrEqual(128 * 1024);
  });

  it('accepts the exact byte budget and rejects overflow without truncation', async () => {
    const file = path.join(root, 'boundary');
    await writeFile(file, '1234');
    expect((await regularFile(file, 4)).toString()).toBe('1234');
    await writeFile(file, '12345');
    await expect(regularFile(file, 4)).rejects.toThrow('INPUT_INVALID');
  });
});

describe.skipIf(process.platform !== 'darwin')(
  'Secrets confirmation and temporary lifecycle',
  () => {
    it('shows the actual approved entry, credential slots and runtime identities', async () => {
      await initialize();
      await writeFile(
        path.join(spec.packagePath, 'other.cjs'),
        'process.stdin.resume();',
      );
      vi.spyOn(vaultModule, 'vaultContext').mockResolvedValue(context);
      vi.spyOn(readline, 'createInterface').mockReturnValue({
        question: async () => 'approve',
        close: () => {},
      } as unknown as readline.Interface);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const streams = [process.stdin, process.stdout];
      const tty = streams.map((stream) =>
        Object.getOwnPropertyDescriptor(stream, 'isTTY'),
      );
      for (const stream of streams)
        Object.defineProperty(stream, 'isTTY', {
          configurable: true,
          value: true,
        });
      try {
        const displays = [];
        for (const candidate of [
          spec,
          { ...spec, entry: 'other.cjs', credentials: { other: 'credential' } },
        ]) {
          const file = path.join(root, 'candidate.json');
          await writeFile(file, JSON.stringify(candidate));
          const cli = new Command().exitOverride();
          registerSecretCommands(cli);
          log.mockClear();
          await cli.parseAsync(
            ['secret', 'action', 'approve', '--file', file],
            {
              from: 'user',
            },
          );
          const displayed = JSON.parse(String(log.mock.calls[0]?.[0]));
          displays.push(displayed);
          await Vault.transaction(context, false, async (v) => {
            const approved = v.action('fixture');
            expect(displayed).toMatchObject({
              executable: approved.spec.executable,
              entry: approved.spec.entry,
              credentials: approved.spec.credentials,
              runtimeFiles: approved.runtimeFiles,
            });
          });
        }
        expect(displays[0]).not.toEqual(displays[1]);
      } finally {
        streams.forEach((stream, index) => {
          const descriptor = tty[index];
          if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
          else Reflect.deleteProperty(stream, 'isTTY');
        });
      }
    });

    it('uses a fresh private temporary directory on every successful run', async () => {
      await scratchExecutor();
      await approve();
      expect(await runSecret(context, 'fixture', input)).toMatchObject({
        status: 'executor_succeeded',
      });
      expect(await runSecret(context, 'fixture', input)).toMatchObject({
        status: 'executor_succeeded',
      });
      const runs = await expectCleanScratch();
      expect(runs).toHaveLength(2);
      expect(runs[0]?.temporary).not.toBe(runs[1]?.temporary);
    });

    it.each([
      ['failure', 'process.exitCode=1;', 'EXECUTOR_FAILED'],
      ['timeout', 'setInterval(()=>{},1000);', 'EXECUTOR_TIMEOUT'],
      [
        'output limit',
        "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000);",
        'OUTPUT_LIMIT',
      ],
    ])('cleans temporary files after %s', async (_label, tail, code) => {
      await scratchExecutor(tail);
      spec.timeoutMs = 500;
      await approve();
      expect(await runSecret(context, 'fixture', input)).toMatchObject({
        status: 'outcome_unknown',
        code,
      });
      await expectCleanScratch();
    });

    it('cleans temporary files after cancellation of a running executor', async () => {
      await scratchExecutor('setInterval(()=>{},1000);');
      await approve();
      const controller = new AbortController();
      const pending = runSecret(context, 'fixture', input, controller.signal);
      try {
        await vi.waitFor(async () =>
          expect(await observations()).toHaveLength(1),
        );
        controller.abort();
        expect(await pending).toMatchObject({ code: 'CANCELLED' });
        await expectCleanScratch();
      } finally {
        controller.abort();
        await pending;
      }
    });

    it('cleans its temporary directory when the child cannot start', async () => {
      await approve();
      let temporary: string | undefined;
      vi.spyOn(childProcess, 'spawn').mockImplementationOnce(
        (_file, args, options) => {
          temporary = options?.env?.TMPDIR;
          return actualSpawn(
            path.join(root, 'missing-executable'),
            args as string[],
            options,
          );
        },
      );
      expect(await runSecret(context, 'fixture', input)).toMatchObject({
        code: 'EXECUTOR_FAILED',
      });
      expect(temporary).toBeDefined();
      await expect(readdir(temporary as string)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);

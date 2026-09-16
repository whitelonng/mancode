import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cancelBoundedRun,
  executionCommandDigest,
  inspectBoundedRun,
  recoverBoundedRun,
  runBoundedCommand,
} from '../src/runtime/execution-runner.js';

let root: string;
let workerPath: string;
beforeAll(async () => {
  const base = process.env.MANCODE_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  root = await realpath(await mkdtemp(path.join(base, 'bounded-runner-')));
  workerPath = path.join(root, 'worker.mjs');
  await build({
    entryPoints: ['src/runtime/execution-worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: workerPath,
  });
});

const input = (runId: string, code: string, timeoutMs = 2000) => ({
  runId,
  projectRoot: root,
  argv: [process.execPath, '-e', code],
  timeoutMs,
  maxOutputBytes: 4096,
  runDirectory: path.join(root, runId),
  workerPath,
});

describe.skipIf(process.platform === 'win32')(
  'bounded runner ownership and recovery',
  () => {
    it('captures real execution and recovers its receipt without replay', async () => {
      const command = input(
        'success',
        "console.log('hello'); console.error('diagnostic')",
      );
      let ready = false;
      const result = await runBoundedCommand({
        ...command,
        onReady: async (identity) => {
          expect(identity.commandDigest).toBe(
            executionCommandDigest(root, command.argv, command.timeoutMs),
          );
          expect((await inspectBoundedRun(command)).state).toBe('ready');
          ready = true;
        },
      });
      expect(ready).toBe(true);
      expect(result).toMatchObject({
        status: 'succeeded',
        started: true,
        exitCode: 0,
        cleanupConfirmed: true,
        stdout: 'hello\n',
        stderr: 'diagnostic\n',
      });
      expect(await recoverBoundedRun(command)).toEqual({
        state: 'terminal',
        result,
      });
      await expect(runBoundedCommand(command)).rejects.toMatchObject({
        code: 'EEXIST',
      });
    });

    it.skipIf(process.platform !== 'darwin')(
      'accepts the macOS /var alias but rejects a symlink inside the run directory',
      async () => {
        const canonical = await realpath(
          await mkdtemp(path.join(tmpdir(), 'runner-alias-')),
        );
        const lexical = canonical.replace(/^\/private\/var\//, '/var/');
        const success = await runBoundedCommand({
          ...input('alias', ''),
          projectRoot: lexical,
          runDirectory: path.join(lexical, 'run'),
        });
        expect(success.status).toBe('succeeded');
        await symlink(canonical, path.join(canonical, 'linked'), 'dir');
        await expect(
          runBoundedCommand({
            ...input('symlink', ''),
            projectRoot: lexical,
            runDirectory: path.join(lexical, 'linked', 'bad'),
          }),
        ).rejects.toThrow('MANCODE_RUN_DIRECTORY_SYMLINK');
      },
    );

    it('returns a failed command without interpreting nonzero exit as a Red', async () => {
      const result = await runBoundedCommand(
        input('exit-error', "console.error('wrong');process.exit(3)"),
      );
      expect(result).toMatchObject({
        status: 'failed',
        exitCode: 3,
        cleanupConfirmed: true,
      });
    });

    it('bounds hanging processes and overlarge output', async () => {
      const hung = await runBoundedCommand(
        input('timeout', 'setInterval(()=>{},1000)', 150),
      );
      expect(['timed_out', 'interrupted']).toContain(hung.status);
      expect(hung.durationMs).toBeLessThan(3000);
      expect(hung.status === 'timed_out').toBe(hung.cleanupConfirmed);
      const noisy = await runBoundedCommand(
        input(
          'noisy',
          "setInterval(()=>process.stdout.write('x'.repeat(8192)),1)",
        ),
      );
      expect(noisy.outputTruncated).toBe(true);
      expect(
        Buffer.byteLength(noisy.stdout) + Buffer.byteLength(noisy.stderr),
      ).toBeLessThanOrEqual(4096);
      expect(noisy.status).not.toBe('succeeded');
    });

    it('bounds a command with a live descendant without claiming unconfirmed cleanup', async () => {
      const result = await runBoundedCommand(
        input(
          'descendant',
          "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); setInterval(()=>{},1000)",
          300,
        ),
      );
      expect(['timed_out', 'interrupted']).toContain(result.status);
      expect(result.durationMs).toBeLessThan(3500);
      expect(result.status === 'timed_out').toBe(result.cleanupConfirmed);
    });

    it('cancels through authenticated ownership and never acts on a replaced identity', async () => {
      const command = input('cancel', 'setInterval(()=>{},1000)');
      let cancellation: ReturnType<typeof cancelBoundedRun> | undefined;
      const result = await runBoundedCommand({
        ...command,
        onReady: async () => {
          setTimeout(() => {
            cancellation = cancelBoundedRun(command);
          }, 100);
        },
      });
      expect(['cancelled', 'interrupted']).toContain(result.status);
      await expect(cancellation).resolves.toMatchObject({
        state: 'terminal',
        result,
      });
      const tampered = JSON.parse(
        await readFile(path.join(command.runDirectory, 'request.json'), 'utf8'),
      );
      tampered.executorId = 'a-different-executor';
      await writeFile(
        path.join(command.runDirectory, 'request.json'),
        JSON.stringify(tampered),
      );
      expect((await cancelBoundedRun(command)).state).toBe('interrupted');
    });

    it('does not start commands after pre-cancellation or a rejected start transaction', async () => {
      const aborted = await runBoundedCommand({
        ...input('pre-cancel', "throw Error('must not execute')"),
        signal: AbortSignal.abort(),
      });
      expect(aborted).toMatchObject({
        started: false,
        status: 'cancelled',
        cleanupConfirmed: true,
      });
      const rejected = await runBoundedCommand({
        ...input('rejected-start', "throw Error('must not execute')"),
        onReady: async () => {
          throw new Error('CAS failed');
        },
      });
      expect(rejected).toMatchObject({ started: false, status: 'cancelled' });
    });

    it('binds reporter environment to the actual executor and handles spawn failure', async () => {
      const result = await runBoundedCommand({
        ...input('binding', 'console.log(process.env.MANCODE_EXECUTOR_ID)'),
        env: { MANCODE_EXECUTOR_ID: 'forged' },
      });
      expect(result.stdout.trim()).toBe(result.identity?.executorId);
      const failure = await runBoundedCommand({
        ...input('spawn-failed', ''),
        argv: [path.join(root, 'missing-command')],
      });
      expect(failure).toMatchObject({
        started: false,
        status: 'failed',
        cleanupConfirmed: true,
      });
    });

    it('rejects unbounded inputs before creating an execution', async () => {
      await expect(
        runBoundedCommand({ ...input('invalid', ''), timeoutMs: 0 }),
      ).rejects.toThrow('MANCODE_RUN_INPUT_INVALID');
      await expect(
        runBoundedCommand({ ...input('invalid', ''), maxOutputBytes: 0 }),
      ).rejects.toThrow('MANCODE_RUN_INPUT_INVALID');
      expect(
        (
          await recoverBoundedRun({
            runId: 'absent',
            runDirectory: path.join(root, 'absent'),
          })
        ).state,
      ).toBe('interrupted');
    });
  },
);

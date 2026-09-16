import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import {
  cancelBoundedRun,
  inspectBoundedRun,
  runBoundedCommand,
} from '../src/runtime/execution-runner.js';

it.skipIf(process.platform === 'win32')(
  'supervisor disconnect settles an interrupted receipt without replaying side effects',
  async () => {
    const base = process.env.MANCODE_TEST_ROOT ?? tmpdir();
    await mkdir(base, { recursive: true });
    const root = await realpath(
      await mkdtemp(path.join(base, 'execution-worker-')),
    );
    const workerPath = path.join(root, 'worker.mjs');
    await build({
      entryPoints: ['src/runtime/execution-worker.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: workerPath,
    });
    const directory = path.join(root, 'run');
    await mkdir(directory);
    await writeFile(
      path.join(directory, 'request.json'),
      JSON.stringify({
        protocolVersion: 1,
        runId: 'disconnect',
        executorId: 'executor-disconnect',
        commandDigest: `sha256:${'1'.repeat(64)}`,
        projectRoot: root,
        argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        timeoutMs: 2000,
        maxOutputBytes: 4096,
        token: randomBytes(32).toString('hex'),
      }),
    );
    const worker = fork(workerPath, [directory], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    });
    await new Promise<void>((resolve) => {
      worker.once('message', () => resolve());
    });
    const control = JSON.parse(
      await readFile(path.join(directory, 'control.json'), 'utf8'),
    );
    const refused = await fetch(`http://127.0.0.1:${control.port}/cancel`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(refused.status).toBe(403);
    await fetch(`http://127.0.0.1:${control.port}/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${control.token}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    worker.disconnect();
    await new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    const result = await inspectBoundedRun({
      runId: 'disconnect',
      runDirectory: directory,
    });
    expect(result.state).toBe('terminal');
    if (result.state === 'terminal')
      expect(result.result.status).toBe('interrupted');
    expect(
      await cancelBoundedRun({ runId: 'disconnect', runDirectory: directory }),
    ).toEqual(result);
  },
  10000,
);

it('refuses Windows command execution before any side effect when tree ownership is unavailable', async () => {
  const base = process.env.MANCODE_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const root = await realpath(
    await mkdtemp(path.join(base, 'windows-capability-')),
  );
  const workerPath = path.join(root, 'worker.mjs');
  await build({
    entryPoints: ['src/runtime/execution-worker.ts'],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { 'process.platform': '"win32"' },
  });
  const marker = path.join(root, 'must-not-exist');
  const result = await runBoundedCommand({
    runId: 'unsupported',
    projectRoot: root,
    runDirectory: path.join(root, 'run'),
    workerPath,
    argv: [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`,
    ],
    timeoutMs: 2000,
    maxOutputBytes: 4096,
  });
  expect(result).toMatchObject({
    status: 'failed',
    started: false,
    cleanupConfirmed: true,
    reason: 'windows_process_tree_unsupported',
    exitCode: null,
  });
  expect(existsSync(marker)).toBe(false);
});

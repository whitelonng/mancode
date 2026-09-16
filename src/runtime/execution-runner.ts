import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUlid } from '../context/ids.js';
import type {
  BoundedRunResult,
  ExecutionControl,
  ExecutionIdentity,
  ExecutionRequest,
} from './execution-protocol.js';

export interface BoundedCommandInput {
  runId: string;
  projectRoot: string;
  argv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  runDirectory: string;
  env?: Record<string, string>;
  onReady?: (identity: ExecutionIdentity) => Promise<void>;
  signal?: AbortSignal;
  /** Build/test injection only; production defaults to the packaged supervisor. */
  workerPath?: string;
}

export function executionCommandDigest(
  projectRoot: string,
  argv: string[],
  timeoutMs: number,
): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ cwd: path.resolve(projectRoot), argv, timeoutMs }))
    .digest('hex')}`;
}

async function readLocal<T>(directory: string, name: string): Promise<T> {
  const file = path.join(directory, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024)
    throw new Error('MANCODE_RUN_RECEIPT_INVALID');
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function controlRequest(
  control: ExecutionControl,
  action: 'inspect' | 'cancel' | 'start',
): Promise<{ identity: ExecutionIdentity; state?: string }> {
  if (
    !Number.isInteger(control.port) ||
    control.port < 1 ||
    control.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(control.token)
  )
    throw new Error('MANCODE_RUN_CONTROL_INVALID');
  const response = await fetch(`http://127.0.0.1:${control.port}/${action}`, {
    method: action === 'inspect' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${control.token}` },
    signal: AbortSignal.timeout(1000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('MANCODE_RUN_CONTROL_REJECTED');
  const value = (await response.json()) as {
    identity: ExecutionIdentity;
    state?: string;
  };
  if (
    value.identity?.runId !== control.identity.runId ||
    value.identity.executorId !== control.identity.executorId ||
    value.identity.commandDigest !== control.identity.commandDigest
  )
    throw new Error('MANCODE_RUN_IDENTITY_MISMATCH');
  return value;
}

export interface RunLocation {
  runId: string;
  runDirectory: string;
}
export async function inspectBoundedRun(
  input: RunLocation,
): Promise<
  | { state: 'terminal'; result: BoundedRunResult }
  | { state: 'running' | 'ready'; identity: ExecutionIdentity }
  | { state: 'interrupted'; reason: string }
> {
  try {
    const request = await readLocal<ExecutionRequest>(
      input.runDirectory,
      'request.json',
    );
    if (request.runId !== input.runId)
      throw new Error('MANCODE_RUN_IDENTITY_MISMATCH');
    try {
      const result = await readLocal<BoundedRunResult>(
        input.runDirectory,
        'result.json',
      );
      if (
        result.identity?.runId !== request.runId ||
        result.identity.executorId !== request.executorId ||
        result.identity.commandDigest !== request.commandDigest
      )
        throw new Error('MANCODE_RUN_IDENTITY_MISMATCH');
      return { state: 'terminal', result };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const control = await readLocal<ExecutionControl>(
      input.runDirectory,
      'control.json',
    );
    if (
      control.identity.runId !== input.runId ||
      control.identity.executorId !== request.executorId
    )
      throw new Error('MANCODE_RUN_IDENTITY_MISMATCH');
    const observed = await controlRequest(control, 'inspect');
    return {
      state: observed.state === 'ready' ? 'ready' : 'running',
      identity: observed.identity,
    };
  } catch (error) {
    return {
      state: 'interrupted',
      reason: error instanceof Error ? error.message : 'MANCODE_RUN_UNVERIFIED',
    };
  }
}

export const recoverBoundedRun = inspectBoundedRun;

export async function cancelBoundedRun(
  input: RunLocation,
): Promise<Awaited<ReturnType<typeof inspectBoundedRun>>> {
  const current = await inspectBoundedRun(input);
  if (current.state !== 'ready' && current.state !== 'running') return current;
  const control = await readLocal<ExecutionControl>(
    input.runDirectory,
    'control.json',
  );
  // An authenticated live supervisor owns process handles. No PID-only fallback.
  await controlRequest(control, 'cancel');
  const deadline = performance.now() + 1800;
  do {
    const observed = await inspectBoundedRun(input);
    if (observed.state !== 'ready' && observed.state !== 'running')
      return observed;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  return inspectBoundedRun(input);
}

export async function runBoundedCommand(
  input: BoundedCommandInput,
): Promise<BoundedRunResult> {
  if (
    !/^[A-Za-z0-9_-]+$/.test(input.runId) ||
    !input.argv.length ||
    input.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    !input.argv[0] ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 2_147_480_000 ||
    !Number.isSafeInteger(input.maxOutputBytes) ||
    input.maxOutputBytes < 1 ||
    input.maxOutputBytes > 8 * 1024 * 1024
  )
    throw new Error('MANCODE_RUN_INPUT_INVALID');
  const root = await realpath(input.projectRoot);
  // Resolve the checkout alias once (/var -> /private/var on macOS), then
  // still reject symlinks introduced inside the run receipt directory.
  const directory = path.resolve(
    root,
    path.relative(
      path.resolve(input.projectRoot),
      path.resolve(input.runDirectory),
    ),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory)
    throw new Error('MANCODE_RUN_DIRECTORY_SYMLINK');
  const request: ExecutionRequest = {
    protocolVersion: 1,
    runId: input.runId,
    executorId: createUlid(),
    commandDigest: executionCommandDigest(
      input.projectRoot,
      input.argv,
      input.timeoutMs,
    ),
    projectRoot: root,
    argv: input.argv,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    token: randomBytes(32).toString('hex'),
    ...(input.env ? { env: input.env } : {}),
  };
  // Exclusive request creation prevents accidental replay of an uncertain run.
  await writeFile(
    path.join(directory, 'request.json'),
    JSON.stringify(request),
    { mode: 0o600, flag: 'wx' },
  );
  let identity: ExecutionIdentity | null = null;
  const began = performance.now();
  const workerPath =
    input.workerPath ??
    fileURLToPath(new URL('./execution/worker.js', import.meta.url));
  const worker = fork(workerPath, [directory], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
  });
  return new Promise<BoundedRunResult>((resolve) => {
    let done = false;
    const finish = (result: BoundedRunResult) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      input.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const unknown = async (reason: string) => {
      const recovered = await inspectBoundedRun({
        runId: input.runId,
        runDirectory: directory,
      });
      if (recovered.state === 'terminal') finish(recovered.result);
      else
        finish({
          identity,
          status: 'interrupted',
          started: identity !== null,
          exitCode: null,
          signal: null,
          reason,
          startedAt: identity?.startedAt ?? null,
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - began),
          outputTruncated: false,
          cleanupConfirmed: false,
          stdout: '',
          stderr: '',
        });
    };
    const abort = () => {
      void cancelBoundedRun({
        runId: input.runId,
        runDirectory: directory,
      }).catch(() => unknown('cancel_unconfirmed'));
    };
    const deadline = setTimeout(() => {
      if (worker.connected) worker.disconnect();
      worker.unref();
      void unknown('supervisor_deadline');
    }, input.timeoutMs + 4000);
    worker.on('message', (message: unknown) => {
      const event = message as {
        type?: string;
        identity?: ExecutionIdentity;
        result?: BoundedRunResult;
      };
      if (
        event.type === 'ready' &&
        event.identity?.runId === request.runId &&
        event.identity.executorId === request.executorId
      ) {
        identity = event.identity;
        void (async () => {
          if (input.signal?.aborted) {
            abort();
            return;
          }
          await input.onReady?.(event.identity as ExecutionIdentity);
          if (done || input.signal?.aborted) {
            abort();
            return;
          }
          const control = await readLocal<ExecutionControl>(
            directory,
            'control.json',
          );
          await controlRequest(control, 'start');
        })().catch(() => {
          abort();
        });
      } else if (
        event.type === 'terminal' &&
        event.result?.identity?.executorId === request.executorId
      )
        finish(event.result);
    });
    worker.once('error', () => {
      void unknown('supervisor_start_failed');
    });
    worker.once('exit', () => {
      if (!done) void unknown('supervisor_exited');
    });
    input.signal?.addEventListener('abort', abort, { once: true });
  });
}

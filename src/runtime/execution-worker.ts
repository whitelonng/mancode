import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceFileAtomically } from './atomic-file.js';
import type {
  BoundedRunResult,
  ExecutionControl,
  ExecutionIdentity,
  ExecutionRequest,
} from './execution-protocol.js';

/** A separate process keeps the deadline alive if the invoking CLI disappears. */
export async function superviseExecution(directory: string): Promise<void> {
  const request: ExecutionRequest = JSON.parse(
    await readFile(path.join(directory, 'request.json'), 'utf8'),
  );
  if (
    request.protocolVersion !== 1 ||
    !request.argv.length ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 2_147_480_000
  )
    throw new Error('MANCODE_RUN_REQUEST_INVALID');
  const identity: ExecutionIdentity = {
    protocolVersion: 1,
    runId: request.runId,
    executorId: request.executorId,
    commandDigest: request.commandDigest,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    platform: process.platform,
  };
  const began = performance.now();
  let child: ChildProcess | undefined;
  let started = false;
  let startRequested = false;
  let startedAt: string | null = null;
  let stopping = false;
  let settled = false;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputTruncated = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  const save = async (name: string, value: unknown) => {
    const target = path.join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: 'wx',
    });
    await replaceFileAtomically(temporary, target);
  };
  const groupAlive = () => {
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const cleanup = async (): Promise<boolean> => {
    if (!child?.pid) return true;
    if (!groupAlive()) return true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Probe below decides whether cleanup succeeded. */
    }
    await pause(100);
    if (groupAlive()) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Never widen the target to other processes. */
      }
    }
    const deadline = performance.now() + 1200;
    while (groupAlive() && performance.now() < deadline) await pause(20);
    return !groupAlive();
  };
  const finish = async (
    status: BoundedRunResult['status'],
    reason: string | null,
    cleanupConfirmed: boolean,
  ) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const result: BoundedRunResult = {
      identity,
      status: cleanupConfirmed ? status : 'interrupted',
      started,
      exitCode,
      signal: exitSignal,
      reason: cleanupConfirmed ? reason : 'cleanup_unconfirmed',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - began),
      outputTruncated,
      cleanupConfirmed,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
    };
    await save('result.json', result);
    process.send?.({ type: 'terminal', result });
    server.close();
    server.closeAllConnections();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    if (process.connected) process.disconnect();
  };
  const stop = async (status: BoundedRunResult['status'], reason: string) => {
    if (stopping || settled) return;
    stopping = true;
    const cleaned = await cleanup();
    await finish(status, reason, cleaned);
  };
  const append = (stream: 'stdout' | 'stderr', data: Buffer) => {
    const available = Math.max(
      0,
      request.maxOutputBytes - stdout.length - stderr.length,
    );
    const chunk = data.subarray(0, available);
    if (stream === 'stdout') stdout = Buffer.concat([stdout, chunk]);
    else stderr = Buffer.concat([stderr, chunk]);
    if (data.length > available) {
      outputTruncated = true;
      void stop('failed', 'output_limit');
    }
  };
  const start = async () => {
    if (startRequested || stopping || settled) return;
    startRequested = true;
    if (process.platform === 'win32') {
      // A successful root exit does not prove descendant cleanup on Windows.
      // Until an owned Job Object implementation exists, execute nothing.
      await finish('failed', 'windows_process_tree_unsupported', true);
      return;
    }
    // This receipt means a spawn may have happened: recovery must never replay it.
    await save('spawn-intent.json', {
      identity,
      attemptedAt: new Date().toISOString(),
    });
    if (stopping || settled) return;
    child = spawn(request.argv[0] as string, request.argv.slice(1), {
      cwd: request.projectRoot,
      env: {
        ...process.env,
        ...request.env,
        MANCODE_EXECUTION_RUN_ID: request.runId,
        MANCODE_EXECUTOR_ID: request.executorId,
      },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('spawn', () => {
      started = true;
      startedAt = new Date().toISOString();
    });
    child.stdout?.on('data', (data: Buffer) => append('stdout', data));
    child.stderr?.on('data', (data: Buffer) => append('stderr', data));
    child.once('error', () => {
      void stop('failed', 'spawn_failed');
    });
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (stopping || settled) return;
      if (groupAlive()) void stop('interrupted', 'descendants_survived');
    });
    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (!stopping && !settled)
        void finish(
          code === 0 ? 'succeeded' : 'failed',
          code === 0 ? null : 'command_failed',
          true,
        );
    });
  };
  const server = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${request.token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/inspect') {
      res.end(
        JSON.stringify({
          identity,
          state: settled ? 'terminal' : started ? 'running' : 'ready',
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/start') {
      res.end(JSON.stringify({ identity }));
      void start().catch(() => stop('interrupted', 'start_failed'));
      return;
    }
    if (req.method === 'POST' && req.url === '/cancel') {
      res.end(JSON.stringify({ identity }));
      void stop('cancelled', 'requested');
      return;
    }
    res.writeHead(404).end();
  });
  const timer = setTimeout(() => {
    void stop('timed_out', 'deadline');
  }, request.timeoutMs);
  process.once('disconnect', () => {
    void stop('interrupted', 'invoker_disconnected');
  });
  process.once('SIGTERM', () => {
    void stop('cancelled', 'signal');
  });
  process.once('SIGINT', () => {
    void stop('cancelled', 'signal');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('MANCODE_RUN_CONTROL_UNAVAILABLE');
  const control: ExecutionControl = {
    identity,
    port: address.port,
    token: request.token,
  };
  await save('control.json', control);
  process.send?.({ type: 'ready', identity });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2]
) {
  superviseExecution(process.argv[2]).catch(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}

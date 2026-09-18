import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseAction, verifyExecutor } from './actions.js';
import { regularFile, strictJson } from './io.js';
import { resolveInput, validateInput } from './resolve.js';
import {
  LIMITS,
  type Receipt,
  type SecretCode,
  SecretError,
  fail,
  name,
} from './types.js';
import { Vault, type VaultContext } from './vault.js';

export async function runSecret(
  context: VaultContext,
  action: string,
  file: string,
  signal?: AbortSignal,
): Promise<Receipt> {
  name(action);
  const runId = randomUUID();
  let started = false;
  try {
    if (process.platform === 'win32') fail('CAPABILITY_UNAVAILABLE');
    const input = strictJson(await regularFile(file, LIMITS.input));
    return await Vault.transaction(context, false, async (vault) => {
      const approved = vault.action(action);
      const spec = parseAction(approved.spec);
      const data = validateInput(spec, input); // Reject unapproved fields before opening secret records.
      const executor = await verifyExecutor(vault, approved);
      if (signal?.aborted) fail('CANCELLED');
      const secrets = vault.check(approved);
      const payload = resolveInput(spec, data, secrets);
      for (const s of Object.values(secrets)) s.value = '';
      let code: SecretCode | undefined;
      let temporary: string | undefined;
      try {
        temporary = await mkdtemp(path.join(context.directory, 'run-'));
        code = await new Promise<SecretCode | undefined>((resolve) => {
          let done = false;
          let total = 0;
          let failure: SecretCode | undefined;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const child = spawn(executor.executable, [executor.entry], {
            cwd: executor.cwd,
            shell: false,
            detached: true,
            env: {
              PATH: '/usr/bin:/bin',
              LANG: 'en_US.UTF-8',
              HOME: executor.cwd,
              TMPDIR: temporary,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const kill = (sig: NodeJS.Signals) => {
            if (child.pid)
              try {
                process.kill(-child.pid, sig);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                  failure = 'EXECUTOR_FAILED';
              }
          };
          const stop = (why: SecretCode) => {
            if (done) return;
            failure ??= why;
            child.stdin.destroy();
            kill('SIGTERM');
            killTimer ??= setTimeout(() => kill('SIGKILL'), 200);
          };
          const cancel = () => stop('CANCELLED');
          const timer = setTimeout(
            () => stop('EXECUTOR_TIMEOUT'),
            spec.timeoutMs,
          );
          signal?.addEventListener('abort', cancel, { once: true });
          const finish = (status: number | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            signal?.removeEventListener('abort', cancel);
            kill('SIGKILL');
            resolve(failure ?? (status === 0 ? undefined : 'EXECUTOR_FAILED'));
          };
          child.once('spawn', () => {
            started = true;
            if (signal?.aborted) stop('CANCELLED');
          });
          child.once('error', () => {
            failure = 'EXECUTOR_FAILED';
            finish(null);
          });
          child.once('close', finish);
          child.stdin.on('error', () => stop('EXECUTOR_FAILED'));
          for (const stream of [child.stdout, child.stderr])
            stream.on('data', (b: Buffer) => {
              total += b.length;
              if (total > spec.outputBytes) stop('OUTPUT_LIMIT');
            });
          child.stdin.end(payload, () => payload.fill(0));
        });
      } finally {
        payload.fill(0);
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
      const receipt: Receipt = {
        schemaVersion: 1,
        runId,
        action,
        status: code ? 'outcome_unknown' : 'executor_succeeded',
        ...(code ? { code } : {}),
      };
      await audit(context, receipt);
      return receipt;
    });
  } catch (error) {
    const code =
      error instanceof SecretError ? error.code : 'STORAGE_UNAVAILABLE';
    return {
      schemaVersion: 1,
      runId,
      action,
      status: started ? 'outcome_unknown' : 'rejected',
      code,
    };
  }
}
async function audit(context: VaultContext, receipt: Receipt): Promise<void> {
  const file = path.join(context.directory, 'audit.jsonl');
  try {
    const st = await lstat(file);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      (st.mode & 0o077) !== 0
    )
      fail('STORAGE_UNAVAILABLE');
    if (st.size > 256 * 1024) await rename(file, `${file}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await appendFile(
    file,
    `${JSON.stringify({ runId: receipt.runId, action: receipt.action, event: receipt.code ?? receipt.status, time: new Date().toISOString().slice(0, 13) })}\n`,
    { mode: 0o600, flag: 'a' },
  );
}

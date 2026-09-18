import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import {
  installAction,
  parseAction,
  prepareAction,
} from '../secrets/actions.js';
import { regularFile, strictJson } from '../secrets/io.js';
import { runSecret } from '../secrets/run.js';
import {
  LIMITS,
  SECRET_TYPES,
  SecretError,
  type SecretType,
  fail,
  name,
} from '../secrets/types.js';
import { Vault, catalogue, vaultContext } from '../secrets/vault.js';

export function secretExit(code?: string): number {
  if (!code) return 0;
  if (['KEYSTORE_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'].includes(code))
    return 5;
  if (['EXECUTOR_TIMEOUT', 'CANCELLED'].includes(code)) return 4;
  if (['EXECUTOR_FAILED', 'OUTPUT_LIMIT'].includes(code)) return 3;
  return 2;
}
function human(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    fail('CAPABILITY_UNAVAILABLE');
}
export function eraseHiddenCodePoint(chunks: Buffer[]): number {
  let removed = 0;
  for (;;) {
    const last = chunks.pop();
    if (!last) break;
    const byte = last[0] ?? 0;
    removed += last.length;
    last.fill(0);
    if ((byte & 0xc0) !== 0x80) break;
  }
  return removed;
}
export async function hiddenInput(): Promise<string> {
  human();
  const input = process.stdin;
  const previous = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      input.off('data', receive);
      input.off('end', end);
      process.off('SIGINT', end);
      process.off('SIGTERM', end);
      input.setRawMode(previous);
      input.pause();
      process.stdout.write('\n');
    };
    const finish = (cancel = false) => {
      cleanup();
      const all = Buffer.concat(chunks);
      try {
        if (cancel) reject(new SecretError('CANCELLED'));
        else resolve(new TextDecoder('utf-8', { fatal: true }).decode(all));
      } catch {
        reject(new SecretError('INPUT_INVALID'));
      } finally {
        all.fill(0);
        for (const c of chunks) c.fill(0);
      }
    };
    const end = () => finish(true);
    const receive = (buffer: Buffer) => {
      for (const byte of buffer) {
        if (byte === 3) {
          finish(true);
          return;
        }
        if (byte === 4) {
          finish();
          return;
        }
        if (byte === 127 || byte === 8) {
          size -= eraseHiddenCodePoint(chunks);
          continue;
        }
        size++;
        if (size > LIMITS.secret) {
          finish(true);
          return;
        }
        chunks.push(Buffer.from([byte === 13 ? 10 : byte]));
      }
    };
    input.on('data', receive);
    input.once('end', end);
    process.once('SIGINT', end);
    process.once('SIGTERM', end);
    process.stdout.write('Secret (hidden; Ctrl+D finishes, Ctrl+C cancels): ');
  });
}
async function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
async function safe(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const code =
      error instanceof SecretError ? error.code : 'STORAGE_UNAVAILABLE';
    console.log(JSON.stringify({ schemaVersion: 1, status: 'rejected', code }));
    process.exitCode = secretExit(code);
  }
}
export function registerSecretCommands(program: Command): void {
  const secret = program
    .command('secret')
    .description('Local protected text and approved status-only actions');
  secret
    .command('set <name>')
    .description('Enter protected text in an independent local terminal')
    .action((n) =>
      safe(async () => {
        human();
        name(n);
        const context = await vaultContext(process.cwd());
        const type = await question(`Type (${SECRET_TYPES.join(', ')}): `);
        if (!SECRET_TYPES.includes(type as SecretType)) fail('INPUT_INVALID');
        const description = await question(
          'Neutral purpose (no personal data): ',
        );
        const value = await hiddenInput();
        await Vault.transaction(context, true, (v) =>
          v.set(n, type as SecretType, description, value),
        );
        console.log(
          'Encrypted record saved. Existing approvals for this name require confirmation again.',
        );
      }),
    );
  secret
    .command('list')
    .option('--json', 'Output minimal project catalogue')
    .action(() =>
      safe(async () => {
        const result = await catalogue(await vaultContext(process.cwd()));
        console.log(
          JSON.stringify({
            schemaVersion: 1,
            securityMode: 'exposure-reduction',
            items: result.items,
          }),
        );
      }),
    );
  secret
    .command('remove <name>')
    .description(
      'Remove a local record and its bindings; does not revoke remote credentials',
    )
    .action((n) =>
      safe(async () => {
        human();
        name(n);
        if (
          (await question(
            `Remove ${n}? Existing external actions cannot be undone. Type remove: `,
          )) !== 'remove'
        )
          fail('CANCELLED');
        await Vault.transaction(await vaultContext(process.cwd()), false, (v) =>
          v.remove(n),
        );
        console.log(JSON.stringify({ schemaVersion: 1, status: 'removed' }));
      }),
    );
  secret
    .command('run <action>')
    .requiredOption(
      '--input <file>',
      'JSON business fields and structured references',
    )
    .option('--json', 'Output fixed receipt only')
    .action((action, options) =>
      safe(async () => {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        try {
          const result = await runSecret(
            await vaultContext(process.cwd()),
            action,
            options.input,
            controller.signal,
          );
          console.log(JSON.stringify(result));
          process.exitCode = secretExit(result.code);
        } finally {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
        }
      }),
    );
  const actions = secret
    .command('action')
    .description('Approve and manage fixed execution packages');
  actions
    .command('approve')
    .requiredOption(
      '--file <spec>',
      'Candidate json-stdin-v1 Node package specification',
    )
    .action((options) =>
      safe(async () => {
        human();
        const spec = parseAction(
          strictJson(await regularFile(options.file, LIMITS.input)),
        );
        await Vault.transaction(
          await vaultContext(process.cwd()),
          false,
          async (vault) => {
            const prepared = await prepareAction(vault, spec);
            const approvedSpec = prepared.action.spec;
            console.log(
              JSON.stringify(
                {
                  name: approvedSpec.name,
                  version: approvedSpec.version,
                  executable: approvedSpec.executable,
                  entry: approvedSpec.entry,
                  executableDigest: prepared.action.executableDigest,
                  runtimeFiles: prepared.action.runtimeFiles,
                  files: prepared.action.files,
                  workspace: prepared.action.workspaceId,
                  bindings: prepared.action.bindings,
                  fields: approvedSpec.fields,
                  credentials: approvedSpec.credentials,
                  fixed: approvedSpec.fixed,
                  target: approvedSpec.target,
                  effects: approvedSpec.effects,
                  output: approvedSpec.output,
                  timeoutMs: approvedSpec.timeoutMs,
                  outputBytes: approvedSpec.outputBytes,
                },
                null,
                2,
              ),
            );
            console.log(
              'Trust this executor, dependencies and runtime. This is not a network/file sandbox. No automatic retries. Pause related calls before rotation.',
            );
            if (
              (await question(
                'Type approve to install this exact snapshot: ',
              )) !== 'approve'
            )
              fail('CANCELLED');
            await installAction(vault, prepared);
          },
        );
        console.log(JSON.stringify({ schemaVersion: 1, status: 'approved' }));
      }),
    );
  actions
    .command('list')
    .option('--json', 'Output approved action catalogue and input requirements')
    .action(() =>
      safe(async () => {
        const result = await catalogue(await vaultContext(process.cwd()));
        console.log(
          JSON.stringify({
            schemaVersion: 1,
            securityMode: 'exposure-reduction',
            actions: result.actions,
          }),
        );
      }),
    );
  actions.command('remove <name>').action((n) =>
    safe(async () => {
      human();
      name(n);
      if (
        (await question(
          `Revoke ${n}? Started actions cannot be undone. Type remove: `,
        )) !== 'remove'
      )
        fail('CANCELLED');
      await Vault.transaction(await vaultContext(process.cwd()), false, (v) =>
        v.removeAction(n),
      );
      console.log(JSON.stringify({ schemaVersion: 1, status: 'removed' }));
    }),
  );
}

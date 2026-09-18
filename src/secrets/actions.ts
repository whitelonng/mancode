import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { privateDirectory, regularFile } from './io.js';
import { runtimeIdentity } from './runtime.js';
import {
  type ActionSpec,
  type ApprovedAction,
  LIMITS,
  fail,
  name,
  record,
  text,
} from './types.js';
import type { Vault } from './vault.js';
const digest = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');
function relative(value: unknown): string {
  const s = text(value);
  if (
    path.isAbsolute(s) ||
    /[\\\0]/.test(s) ||
    s.split('/').some((v) => !v || v === '.' || v === '..')
  )
    fail('INPUT_INVALID');
  return s;
}
export function parseAction(value: unknown): ActionSpec {
  record(value, [
    'schemaVersion',
    'name',
    'version',
    'executable',
    'packagePath',
    'entry',
    'fields',
    'credentials',
    'fixed',
    'target',
    'effects',
    'output',
    'timeoutMs',
    'outputBytes',
  ]);
  if (value.schemaVersion !== 1 || value.output !== 'status-only')
    fail('INPUT_INVALID');
  name(value.name);
  text(value.version, 80);
  text(value.target);
  text(value.effects);
  relative(value.entry);
  for (const key of ['executable', 'packagePath'])
    if (!path.isAbsolute(text(value[key]))) fail('INPUT_INVALID');
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 ||
    Number(value.timeoutMs) > 300000 ||
    !Number.isSafeInteger(value.outputBytes) ||
    Number(value.outputBytes) < 1 ||
    Number(value.outputBytes) > LIMITS.output
  )
    fail('INPUT_INVALID');
  for (const key of ['fields', 'credentials', 'fixed']) {
    const map = value[key];
    if (
      !map ||
      typeof map !== 'object' ||
      Array.isArray(map) ||
      Object.keys(map).length > 32
    )
      fail('INPUT_INVALID');
    for (const k of Object.keys(map)) name(k);
  }
  for (const field of Object.values(value.fields as Record<string, unknown>)) {
    record(field, ['type', 'name', 'maxBytes']);
    if (field.type === 'secret') {
      name(field.name);
      if (field.maxBytes !== undefined) fail('INPUT_INVALID');
    } else if (field.type === 'string') {
      if (
        field.name !== undefined ||
        !Number.isSafeInteger(field.maxBytes) ||
        Number(field.maxBytes) < 1 ||
        Number(field.maxBytes) > LIMITS.input
      )
        fail('INPUT_INVALID');
    } else if (
      !['integer', 'boolean'].includes(String(field.type)) ||
      field.name !== undefined ||
      field.maxBytes !== undefined
    )
      fail('INPUT_INVALID');
  }
  for (const v of Object.values(value.credentials as Record<string, unknown>))
    name(v);
  for (const v of Object.values(value.fixed as Record<string, unknown>))
    text(v, 4096);
  const spec = value as unknown as ActionSpec;
  if (
    Object.values(spec.fields).filter((f) => f.type === 'secret').length +
      Object.keys(spec.credentials).length >
    LIMITS.references
  )
    fail('INPUT_INVALID');
  return structuredClone(spec);
}
async function inventory(root: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = Object.create(null);
  let total = 0;
  async function walk(
    dir: string,
    prefix: string,
    depth: number,
  ): Promise<void> {
    if (depth > 8) fail('ACTION_CHANGED');
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ACTION_CHANGED');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('ACTION_CHANGED');
      const key = prefix + entry.name;
      if (entry.isDirectory())
        await walk(path.join(dir, entry.name), `${key}/`, depth + 1);
      else {
        if (Object.keys(files).length >= 256) fail('ACTION_CHANGED');
        const bytes = await regularFile(path.join(root, key), 16 * 1024 * 1024);
        total += bytes.length;
        if (total > 16 * 1024 * 1024) fail('ACTION_CHANGED');
        files[key] = bytes;
      }
    }
  }
  await walk(root, '', 0);
  return files;
}
export interface PreparedAction {
  action: ApprovedAction;
  files: Record<string, Buffer>;
}
/** Capture all bytes before the human sees the confirmation; approval installs this snapshot. */
export async function prepareAction(
  vault: Vault,
  spec: ActionSpec,
): Promise<PreparedAction> {
  const executable = await realpath(spec.executable);
  // V1 supports fixed Node entry packages only; no shell, eval flags or arbitrary trailing argv.
  if (!/^node(?:\.exe)?$/.test(path.basename(executable)))
    fail('CAPABILITY_UNAVAILABLE');
  const runtime = await regularFile(executable, 128 * 1024 * 1024);
  const files = await inventory(spec.packagePath);
  if (!files[spec.entry]) fail('INPUT_INVALID');
  const bindings: ApprovedAction['bindings'] = Object.create(null);
  const aliases = [
    ...Object.values(spec.credentials),
    ...Object.values(spec.fields).flatMap((f) =>
      f.type === 'secret' ? [f.name] : [],
    ),
  ];
  for (const n of new Set(aliases)) {
    const secret = vault.metadata(n);
    bindings[n] = { entryId: secret.entryId, revision: secret.revision };
  }
  return {
    files,
    action: {
      spec: { ...spec, executable },
      revision: 1,
      workspaceId: vault.context.workspaceId,
      installId: randomUUID(),
      executableDigest: digest(runtime),
      runtimeFiles: await runtimeIdentity(executable),
      files: Object.fromEntries(
        Object.entries(files).map(([k, v]) => [k, digest(v)]),
      ),
      bindings,
    },
  };
}
export async function installAction(
  vault: Vault,
  prepared: PreparedAction,
): Promise<void> {
  const base = path.join(vault.context.directory, 'executors');
  await privateDirectory(base);
  const root = path.join(base, prepared.action.installId);
  await mkdir(root, { mode: 0o700 });
  const pkg = path.join(root, 'package');
  await mkdir(pkg, { mode: 0o700 });
  for (const [key, bytes] of Object.entries(prepared.files)) {
    const file = path.join(pkg, key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o400, flag: 'wx' });
  }
  await vault.approve(prepared.action);
}
export async function verifyExecutor(
  vault: Vault,
  a: ApprovedAction,
): Promise<{ executable: string; entry: string; cwd: string }> {
  if (!/^[a-f0-9-]{36}$/.test(a.installId)) fail('ACTION_CHANGED');
  const base = path.join(vault.context.directory, 'executors', a.installId);
  if ((await realpath(base)) !== base) fail('ACTION_CHANGED');
  const executable = a.spec.executable;
  const identity = await runtimeIdentity(executable);
  if (JSON.stringify(identity) !== JSON.stringify(a.runtimeFiles))
    fail('ACTION_CHANGED');
  if (
    digest(await regularFile(executable, 128 * 1024 * 1024)) !==
    a.executableDigest
  )
    fail('ACTION_CHANGED');
  const cwd = path.join(base, 'package');
  const files = await inventory(cwd);
  if (
    JSON.stringify(Object.keys(files).sort()) !==
    JSON.stringify(Object.keys(a.files).sort())
  )
    fail('ACTION_CHANGED');
  for (const [key, bytes] of Object.entries(files))
    if (digest(bytes) !== a.files[key]) fail('ACTION_CHANGED');
  return { executable, entry: path.join(cwd, relative(a.spec.entry)), cwd };
}

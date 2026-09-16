import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { assertUlid, createUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  type PlatformName,
  getPlatformInstaller,
} from '../installers/registry.js';
import { resolveLocalEntityHomeStore } from './entity-home-store.js';
import { acquireLocalLock } from './local-lock.js';
import { readProjectRuntimeContext } from './project-runtime.js';

/** A local upgrade receipt, never a replacement for the adapter journal. */
export interface UpgradeContinuation {
  schemaVersion: 1;
  projectRoot: string;
  operationId: string;
  platforms: PlatformName[];
  targetVersion: string;
  initialVersion: string;
  installationEntry: string | null;
  sessionId: string;
  client: string;
  createdSession: boolean;
  phase: 'installing' | 'project';
}

async function receiptPath(root: string, create = false): Promise<string> {
  const directory = path.join(root, '.mancode', 'local', 'upgrade');
  // Validate existing parents before recursive mkdir can follow a redirected
  // ancestor and create an upgrade directory outside this checkout.
  for (const relative of ['.mancode', '.mancode/local']) {
    const parent = path.join(root, relative);
    try {
      const stat = await lstat(parent);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(parent)) !== path.resolve(parent)
      )
        throw new Error('MANCODE_UPGRADE_RECEIPT_PATH_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('MANCODE_UPGRADE_RECEIPT_PATH_INVALID');
    }
    if ((await realpath(directory)) !== path.resolve(directory))
      throw new Error('MANCODE_UPGRADE_RECEIPT_PATH_INVALID');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path.join(directory, 'continuation.json');
}

export async function readUpgradeContinuation(
  root: string,
): Promise<UpgradeContinuation | null> {
  const target = await receiptPath(root);
  let value: unknown;
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('MANCODE_UPGRADE_RECEIPT_PATH_INVALID');
    value = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  assertRecord(value, 'upgrade continuation');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'projectRoot',
      'operationId',
      'platforms',
      'targetVersion',
      'initialVersion',
      'installationEntry',
      'sessionId',
      'client',
      'createdSession',
      'phase',
    ],
    'upgrade continuation',
  );
  if (
    value.schemaVersion !== 1 ||
    value.projectRoot !== (await realpath(root)) ||
    !Array.isArray(value.platforms) ||
    value.platforms.some(
      (p) => typeof p !== 'string' || !getPlatformInstaller(p),
    ) ||
    typeof value.targetVersion !== 'string' ||
    !value.targetVersion.trim() ||
    typeof value.initialVersion !== 'string' ||
    !value.initialVersion.trim() ||
    (value.installationEntry !== null &&
      (typeof value.installationEntry !== 'string' ||
        !path.isAbsolute(value.installationEntry))) ||
    typeof value.client !== 'string' ||
    !value.client.trim() ||
    typeof value.createdSession !== 'boolean' ||
    !['installing', 'project'].includes(String(value.phase))
  ) {
    throw new Error('MANCODE_UPGRADE_RECEIPT_INVALID');
  }
  assertUlid(value.operationId, 'upgrade operationId');
  assertUlid(value.sessionId, 'upgrade sessionId');
  return value as unknown as UpgradeContinuation;
}

export async function writeUpgradeContinuation(
  root: string,
  receipt: UpgradeContinuation,
): Promise<void> {
  const target = await receiptPath(root, true);
  const temporary = `${target}.${createUlid()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function clearUpgradeContinuation(root: string): Promise<void> {
  await rm(await receiptPath(root), { force: true });
}

/** Separate from adapter entity locks, which remain owned by its journal. */
export async function withUpgradeProjectLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const runtime = await readProjectRuntimeContext(root);
  const lock = await acquireLocalLock(resolveLocalEntityHomeStore(runtime), {
    operationId: createUlid(),
    entityLockKey: 'upgrade:project',
    leaseMs: 300_000,
  });
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

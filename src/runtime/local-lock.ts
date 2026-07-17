import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { type EntityHomeStore, lockDirectory } from './entity-home-store.js';

export interface LocalLockOwnerV1 {
  schemaVersion: 1;
  operationId: Ulid;
  processId: number;
  storeId: string;
  entityLockKey: string;
  acquiredAt: string;
  /**
   * A bounded lease makes an abandoned lock diagnosable and renewable. Older
   * lock files omit it; they remain readable but are never stolen blindly.
   */
  leaseExpiresAt: string | null;
}

export interface AcquireLocalLockInput {
  operationId: Ulid;
  entityLockKey: string;
  processId?: number;
  now?: Date;
  leaseMs?: number;
}

export interface LocalLockHandle {
  readonly storeId: string;
  readonly entityLockKey: string;
  readonly owner: LocalLockOwnerV1;
  renew(now?: Date): Promise<void>;
  release(): Promise<void>;
}

/**
 * A durable multi-store operation holds each store's canonical locks in one
 * deterministic global order. Secondary operation reservations describe the
 * same lock keys for recovery after the original process exits.
 */
export interface OperationEntityLockTarget {
  store: EntityHomeStore;
  entityLockKeys: string[];
}

const ENTITY_LOCK_KEY_PATTERN = /^[a-z][a-z0-9_-]*:[^\0/\\]+$/;
const DEFAULT_LOCK_LEASE_MS = 30_000;
const MINIMUM_LOCK_LEASE_MS = 1_000;
const MAXIMUM_LOCK_LEASE_MS = 5 * 60_000;

export async function acquireLocalLock(
  store: EntityHomeStore,
  input: AcquireLocalLockInput,
): Promise<LocalLockHandle> {
  const owner = createLockOwner(store, input);
  const directory = lockPath(store, owner.entityLockKey);
  await mkdir(lockDirectory(store), { recursive: true });
  let acquiredDirectory = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(directory);
      acquiredDirectory = true;
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (!(await reclaimExpiredDeadLock(store, owner.entityLockKey, owner))) {
        throw new Error('MANCODE_LOCK_HELD');
      }
    }
  }
  if (!acquiredDirectory) throw new Error('MANCODE_LOCK_HELD');
  try {
    await writeFile(
      path.join(directory, 'owner.json'),
      `${JSON.stringify(owner, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  let currentOwner = owner;
  return {
    storeId: store.storeId,
    entityLockKey: owner.entityLockKey,
    get owner(): LocalLockOwnerV1 {
      return currentOwner;
    },
    async renew(now: Date = new Date()): Promise<void> {
      if (released) throw new Error('MANCODE_LOCK_OWNERSHIP_LOST');
      const next = renewLockOwner(currentOwner, now);
      const current = await readLocalLock(store, currentOwner.entityLockKey);
      if (!sameLockOwner(current, currentOwner)) {
        throw new Error('MANCODE_LOCK_OWNERSHIP_LOST');
      }
      await atomicWriteLockOwner(directory, next);
      currentOwner = next;
    },
    async release(): Promise<void> {
      if (released) return;
      const current = await readLocalLock(store, currentOwner.entityLockKey);
      if (!sameLockOwner(current, currentOwner)) {
        throw new Error('MANCODE_LOCK_OWNERSHIP_LOST');
      }
      await rm(directory, { recursive: true, force: false });
      released = true;
    },
  };
}

/** Acquires every store-local lock in UTF-8 key order to avoid lock cycles. */
export async function acquireEntityLocks(
  store: EntityHomeStore,
  operationId: Ulid,
  entityLockKeys: string[],
  options: { processId?: number; now?: Date; leaseMs?: number } = {},
): Promise<LocalLockHandle[]> {
  assertUlid(operationId, 'local lock operationId');
  const orderedKeys = normalizeEntityLockKeys(entityLockKeys);
  const locks: LocalLockHandle[] = [];
  try {
    for (const entityLockKey of orderedKeys) {
      locks.push(
        await acquireLocalLock(store, {
          operationId,
          entityLockKey,
          processId: options.processId,
          now: options.now,
          leaseMs: options.leaseMs,
        }),
      );
    }
    return locks;
  } catch (error) {
    await Promise.allSettled(
      [...locks].reverse().map((lock) => lock.release()),
    );
    throw error;
  }
}

/**
 * Acquires canonical locks across one or more entity-home stores. Stores are
 * ordered before their locally ordered keys, avoiding source/destination
 * lock cycles for operations such as local-to-shared promotion.
 */
export async function acquireOperationEntityLocks(
  operationId: Ulid,
  targets: OperationEntityLockTarget[],
  options: { processId?: number; now?: Date; leaseMs?: number } = {},
): Promise<LocalLockHandle[]> {
  assertUlid(operationId, 'operation lock operationId');
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('operation lock targets must not be empty');
  }
  const byStoreId = new Map<string, OperationEntityLockTarget>();
  for (const target of targets) {
    const normalizedKeys = normalizeEntityLockKeys(target.entityLockKeys);
    const existing = byStoreId.get(target.store.storeId);
    if (existing !== undefined) {
      throw new Error('operation lock targets must not repeat a store');
    }
    byStoreId.set(target.store.storeId, {
      store: target.store,
      entityLockKeys: normalizedKeys,
    });
  }
  const locks: LocalLockHandle[] = [];
  try {
    for (const target of [...byStoreId.values()].sort((left, right) =>
      compareUtf8(left.store.storeId, right.store.storeId),
    )) {
      locks.push(
        ...(await acquireEntityLocks(
          target.store,
          operationId,
          target.entityLockKeys,
          options,
        )),
      );
    }
    return locks;
  } catch (error) {
    await Promise.allSettled(
      [...locks].reverse().map((lock) => lock.release()),
    );
    throw error;
  }
}

export async function readLocalLock(
  store: EntityHomeStore,
  entityLockKey: string,
): Promise<LocalLockOwnerV1 | null> {
  assertEntityLockKey(entityLockKey);
  try {
    const raw = await readFile(
      path.join(lockPath(store, entityLockKey), 'owner.json'),
      'utf8',
    );
    const owner = parseLocalLockOwner(JSON.parse(raw));
    if (
      owner.storeId !== store.storeId ||
      owner.entityLockKey !== entityLockKey
    ) {
      throw new Error('MANCODE_LOCK_CORRUPT');
    }
    return owner;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) throw new Error('MANCODE_LOCK_CORRUPT');
    throw error;
  }
}

export function entityLockPath(
  store: EntityHomeStore,
  entityLockKey: string,
): string {
  return lockPath(store, entityLockKey);
}

export function parseLocalLockOwner(value: unknown): LocalLockOwnerV1 {
  assertRecord(value, 'local lock owner');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'processId',
      'storeId',
      'entityLockKey',
      'acquiredAt',
      'leaseExpiresAt',
    ],
    'local lock owner',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('local lock owner schemaVersion must be 1');
  }
  assertUlid(value.operationId, 'local lock operationId');
  assertEntityLockKey(value.entityLockKey);
  if (
    typeof value.processId !== 'number' ||
    !Number.isSafeInteger(value.processId) ||
    value.processId < 1
  ) {
    throw new Error('local lock processId must be a positive integer');
  }
  if (typeof value.storeId !== 'string' || !value.storeId.trim()) {
    throw new Error('local lock storeId is required');
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    processId: value.processId,
    storeId: value.storeId,
    entityLockKey: value.entityLockKey,
    acquiredAt: parseTimestamp(value.acquiredAt, 'local lock acquiredAt'),
    leaseExpiresAt:
      value.leaseExpiresAt === undefined
        ? null
        : value.leaseExpiresAt === null
          ? null
          : parseTimestamp(value.leaseExpiresAt, 'local lock leaseExpiresAt'),
  };
}

export function normalizeEntityLockKeys(entityLockKeys: string[]): string[] {
  if (!Array.isArray(entityLockKeys) || entityLockKeys.length === 0) {
    throw new Error('entity lock keys must be a non-empty array');
  }
  const keys = new Set<string>();
  for (const key of entityLockKeys) {
    assertEntityLockKey(key);
    if (keys.has(key)) throw new Error('entity lock keys must not repeat');
    keys.add(key);
  }
  return [...keys].sort(compareUtf8);
}

function createLockOwner(
  store: EntityHomeStore,
  input: AcquireLocalLockInput,
): LocalLockOwnerV1 {
  assertUlid(input.operationId, 'local lock operationId');
  assertEntityLockKey(input.entityLockKey);
  const processId = input.processId ?? process.pid;
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error('local lock processId must be a positive integer');
  }
  const now = input.now ?? new Date();
  const leaseMs = parseLeaseMs(input.leaseMs);
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    processId,
    storeId: store.storeId,
    entityLockKey: input.entityLockKey,
    acquiredAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  };
}

function renewLockOwner(owner: LocalLockOwnerV1, now: Date): LocalLockOwnerV1 {
  if (owner.leaseExpiresAt === null) {
    throw new Error('MANCODE_LOCK_LEASE_UNAVAILABLE');
  }
  return {
    ...owner,
    leaseExpiresAt: new Date(now.getTime() + lockLeaseMs(owner)).toISOString(),
  };
}

/**
 * A crashed process must not leave an unrecoverable directory lock behind.
 * We reclaim only an expired lease whose process is demonstrably gone. An
 * expired but live process remains protected: stealing it could create two
 * writers during a long operation.
 */
async function reclaimExpiredDeadLock(
  store: EntityHomeStore,
  entityLockKey: string,
  contender: LocalLockOwnerV1,
): Promise<boolean> {
  const existing = await readLocalLock(store, entityLockKey);
  if (
    existing === null ||
    existing.leaseExpiresAt === null ||
    Date.parse(existing.leaseExpiresAt) >= Date.parse(contender.acquiredAt) ||
    processIsAlive(existing.processId)
  ) {
    return false;
  }
  const directory = lockPath(store, entityLockKey);
  const staleDirectory = `${directory}.stale.${process.pid}.${Date.now()}`;
  try {
    await rename(directory, staleDirectory);
  } catch (error) {
    if (isNotFound(error) || isAlreadyExists(error)) return true;
    throw error;
  }
  await rm(staleDirectory, { recursive: true, force: true });
  return true;
}

function processIsAlive(processId: number): boolean {
  if (processId === process.pid) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

async function atomicWriteLockOwner(
  directory: string,
  owner: LocalLockOwnerV1,
): Promise<void> {
  const target = path.join(directory, 'owner.json');
  const temporary = path.join(
    directory,
    `.owner.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporary, target);
}

function parseLeaseMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOCK_LEASE_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_LOCK_LEASE_MS ||
    value > MAXIMUM_LOCK_LEASE_MS
  ) {
    throw new Error('local lock leaseMs is invalid');
  }
  return value;
}

function lockLeaseMs(owner: LocalLockOwnerV1): number {
  if (owner.leaseExpiresAt === null) return DEFAULT_LOCK_LEASE_MS;
  const duration =
    Date.parse(owner.leaseExpiresAt) - Date.parse(owner.acquiredAt);
  return duration >= MINIMUM_LOCK_LEASE_MS && duration <= MAXIMUM_LOCK_LEASE_MS
    ? duration
    : DEFAULT_LOCK_LEASE_MS;
}

function lockPath(store: EntityHomeStore, entityLockKey: string): string {
  assertEntityLockKey(entityLockKey);
  const fileName = createHash('sha256')
    .update(entityLockKey, 'utf8')
    .digest('hex');
  return path.join(lockDirectory(store), `${fileName}.lock`);
}

function assertEntityLockKey(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !ENTITY_LOCK_KEY_PATTERN.test(value) ||
    value.includes('..')
  ) {
    throw new Error('entity lock key is invalid');
  }
}

function sameLockOwner(
  current: LocalLockOwnerV1 | null,
  expected: LocalLockOwnerV1,
): boolean {
  return (
    current !== null &&
    current.operationId === expected.operationId &&
    current.processId === expected.processId &&
    current.storeId === expected.storeId &&
    current.entityLockKey === expected.entityLockKey &&
    current.acquiredAt === expected.acquiredAt &&
    current.leaseExpiresAt === expected.leaseExpiresAt
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

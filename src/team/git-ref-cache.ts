import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import {
  type GitRefTeamManifestSnapshot,
  type GitRefTeamManifestV1,
  parseGitRefTeamManifest,
} from './git-ref-transport.js';
import type { ProjectConfigV1 } from './policy.js';
import type { CoordinationCapabilitiesV1 } from './transport.js';

export const DEFAULT_GIT_REF_FRESHNESS_TTL_MS = 5 * 60 * 1000;

export interface GitRefTeamCacheV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  remote: string;
  transportEpoch: number;
  fetchedAt: string;
  commit: string | null;
  receipt: string | null;
  manifest: GitRefTeamManifestV1 | null;
}

/** Persists only a snapshot already validated by GitRefTeamManifestStore.pull. */
export async function writeGitRefTeamCache(
  projectRoot: string,
  config: ProjectConfigV1,
  snapshot: GitRefTeamManifestSnapshot,
): Promise<GitRefTeamCacheV1> {
  const remote = gitRefRemote(config);
  const cache = parseGitRefTeamCache({
    schemaVersion: 1,
    workspaceId: config.workspaceId,
    remote,
    transportEpoch: config.transport.epoch,
    fetchedAt: snapshot.fetchedAt,
    commit: snapshot.commit,
    receipt: snapshot.receipt,
    manifest: snapshot.manifest,
  });
  const directory = await ensureSafeCacheDirectory(projectRoot);
  const target = gitRefCachePath(projectRoot);
  const temporary = path.join(
    directory,
    `.snapshot.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await replaceFileAtomically(temporary, target);
  return cache;
}

export async function readGitRefTeamCache(
  projectRoot: string,
  config: ProjectConfigV1,
): Promise<GitRefTeamCacheV1 | null> {
  if (config.transport.mode !== 'git-ref') return null;
  const target = gitRefCachePath(projectRoot);
  try {
    await assertSafeCacheDirectory(projectRoot);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('MANCODE_TRANSPORT_CACHE_UNSAFE');
    }
    const cache = parseGitRefTeamCache(
      JSON.parse(await readFile(target, 'utf8')),
    );
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('MANCODE_TRANSPORT_CACHE_CHANGED_DURING_READ');
    }
    if (
      cache.workspaceId !== config.workspaceId ||
      cache.remote !== config.transport.remote ||
      cache.transportEpoch !== config.transport.epoch
    ) {
      return null;
    }
    return cache;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_TRANSPORT_CACHE_CORRUPT');
    }
    throw error;
  }
}

/** Derives status without network access; only explicit sync refreshes the cache. */
export function capabilitiesFromGitRefCache(
  config: ProjectConfigV1,
  cache: GitRefTeamCacheV1 | null,
  now: Date = new Date(),
  freshnessTtlMs: number = DEFAULT_GIT_REF_FRESHNESS_TTL_MS,
): CoordinationCapabilitiesV1 {
  if (config.transport.mode !== 'git-ref') {
    throw new Error('MANCODE_TRANSPORT_MODE_INVALID');
  }
  if (!Number.isSafeInteger(freshnessTtlMs) || freshnessTtlMs < 1) {
    throw new Error('MANCODE_TRANSPORT_FRESHNESS_TTL_INVALID');
  }
  if (cache === null) {
    return {
      claimAcquisition: 'unavailable',
      writeGuard: 'advisory',
      transport: 'git-ref',
      transportFreshness: 'unknown',
      lastSuccessfulSyncAt: null,
      remoteRevision: null,
    };
  }
  const age = now.getTime() - Date.parse(cache.fetchedAt);
  const fresh = age >= 0 && age <= freshnessTtlMs;
  const authorityActive = cache.manifest?.authorityState === 'active';
  return {
    claimAcquisition: authorityActive
      ? fresh
        ? 'enforced'
        : 'advisory'
      : 'unavailable',
    writeGuard: 'advisory',
    transport: 'git-ref',
    transportFreshness: fresh ? 'fresh' : 'stale',
    lastSuccessfulSyncAt: cache.fetchedAt,
    remoteRevision: cache.manifest?.revision ?? 0,
  };
}

export function parseGitRefTeamCache(value: unknown): GitRefTeamCacheV1 {
  assertRecord(value, 'git-ref cache');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'workspaceId',
      'remote',
      'transportEpoch',
      'fetchedAt',
      'commit',
      'receipt',
      'manifest',
    ],
    'git-ref cache',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('git-ref cache schemaVersion is invalid');
  }
  assertUlid(value.workspaceId, 'git-ref cache workspaceId');
  const remote = parseRemote(value.remote);
  const transportEpoch = parsePositiveInteger(
    value.transportEpoch,
    'git-ref cache transportEpoch',
  );
  const fetchedAt = parseTimestamp(value.fetchedAt, 'git-ref cache fetchedAt');
  const commit = parseCommitOrNull(value.commit);
  const receipt = parseReceiptOrNull(value.receipt);
  const manifest =
    value.manifest === null ? null : parseGitRefTeamManifest(value.manifest);
  if (
    (commit === null) !== (manifest === null) ||
    (receipt === null) !== (manifest === null)
  ) {
    throw new Error('git-ref cache commit, receipt, and manifest must coexist');
  }
  if (
    manifest !== null &&
    (manifest.workspaceId !== value.workspaceId ||
      manifest.transportEpoch !== transportEpoch)
  ) {
    throw new Error('MANCODE_TRANSPORT_CACHE_IDENTITY_MISMATCH');
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    remote,
    transportEpoch,
    fetchedAt,
    commit,
    receipt,
    manifest,
  };
}

export function gitRefCachePath(projectRoot: string): string {
  return path.join(gitRefCacheDirectory(projectRoot), 'snapshot.json');
}

function gitRefCacheDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'cache',
    'git-ref',
  );
}

function gitRefRemote(config: ProjectConfigV1): string {
  if (config.transport.mode !== 'git-ref' || config.transport.remote === null) {
    throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  }
  return parseRemote(config.transport.remote);
}

function parseRemote(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('git-ref cache remote is invalid');
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseCommitOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error('git-ref cache commit is invalid');
  }
  return value;
}

function parseReceiptOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^git-ref:[0-9a-f]{40,64}:sha256:[0-9a-f]{64}$/.test(value)
  ) {
    throw new Error('git-ref cache receipt is invalid');
  }
  return value;
}

async function ensureSafeCacheDirectory(projectRoot: string): Promise<string> {
  const root = path.resolve(projectRoot);
  let current = root;
  for (const segment of ['.mancode', 'local', 'cache', 'git-ref']) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertDirectoryNotLinked(current);
  }
  return current;
}

async function assertSafeCacheDirectory(projectRoot: string): Promise<void> {
  let current = path.resolve(projectRoot);
  for (const segment of ['.mancode', 'local', 'cache', 'git-ref']) {
    current = path.join(current, segment);
    await assertDirectoryNotLinked(current);
  }
}

async function assertDirectoryNotLinked(directory: string): Promise<void> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_TRANSPORT_CACHE_UNSAFE');
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

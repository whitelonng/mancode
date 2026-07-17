import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from '../context/canonical.js';
import { assertUlid } from '../context/ids.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import {
  type ClaimV1,
  assertClaimTransition,
  parseClaim,
} from '../team/claims.js';
import { replaceFileAtomically } from './atomic-file.js';
import { type EntityHomeStore, claimDirectory } from './entity-home-store.js';

/** Creates one immutable claim identity, or proves a retry is byte-equivalent. */
export async function createClaim(
  store: EntityHomeStore,
  value: ClaimV1,
): Promise<ClaimV1> {
  const claim = assertClaimMatchesStore(store, parseClaim(value));
  const target = claimPath(store, claim.claimId);
  await mkdir(path.dirname(target), { recursive: true });
  await assertSafeClaimDirectory(store);
  try {
    await writeFile(target, serialize(claim), { encoding: 'utf8', flag: 'wx' });
    await assertSafeClaimFile(target);
    return claim;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readClaim(store, claim.claimId);
    if (
      existing !== null &&
      digestCanonicalJson(existing) === digestCanonicalJson(claim)
    ) {
      return existing;
    }
    throw new Error('MANCODE_CLAIM_ID_CONFLICT');
  }
}

/** Reads a single coordination-authority claim without accepting links. */
export async function readClaim(
  store: EntityHomeStore,
  claimId: string,
): Promise<ClaimV1 | null> {
  assertUlid(claimId, 'claimId');
  const target = claimPath(store, claimId);
  try {
    await assertSafeClaimDirectory(store);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('MANCODE_CLAIM_PATH_UNSAFE');
    }
    const claim = assertClaimMatchesStore(
      store,
      parseClaim(JSON.parse(await readFile(target, 'utf8'))),
    );
    if (claim.claimId !== claimId) {
      throw new Error('MANCODE_CLAIM_CORRUPT');
    }
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('MANCODE_CLAIM_PATH_UNSAFE');
    }
    return claim;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_CLAIM_CORRUPT');
    }
    throw error;
  }
}

/**
 * Performs the revision CAS required for a mutable claim transition. The
 * caller must already hold the canonical task and claim entity locks.
 */
export async function updateClaim(
  store: EntityHomeStore,
  nextValue: ClaimV1,
  expectedRevision: number,
): Promise<ClaimV1> {
  const next = assertClaimMatchesStore(store, parseClaim(nextValue));
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('MANCODE_CLAIM_REVISION_INVALID');
  }
  const previous = await readClaim(store, next.claimId);
  if (previous === null) throw new Error('MANCODE_CLAIM_NOT_FOUND');
  if (previous.revision !== expectedRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  assertClaimTransition(previous, next);
  await atomicWriteClaim(store, next);
  return next;
}

/** Lists all coordination claims, optionally narrowed to one shared task. */
export async function listClaims(
  store: EntityHomeStore,
  taskRef?: TaskRef,
): Promise<ClaimV1[]> {
  const requested = taskRef === undefined ? null : parseTaskRefValue(taskRef);
  if (requested?.namespace === 'local') {
    throw new Error('claims may only target shared TaskRefs');
  }
  let entries: string[];
  try {
    await assertSafeClaimDirectory(store);
    entries = await readdir(claimDirectory(store));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const claims: ClaimV1[] = [];
  for (const entry of entries.sort(compareUtf8)) {
    if (!entry.endsWith('.json')) continue;
    const claimId = entry.slice(0, -'.json'.length);
    try {
      assertUlid(claimId, 'claim filename');
    } catch {
      throw new Error('MANCODE_CLAIM_CORRUPT');
    }
    const claim = await readClaim(store, claimId);
    if (claim === null) throw new Error('MANCODE_CLAIM_CHANGED_DURING_READ');
    if (requested === null || sameTaskRef(claim.taskRef, requested)) {
      claims.push(claim);
    }
  }
  return claims;
}

export function claimPath(store: EntityHomeStore, claimId: string): string {
  assertUlid(claimId, 'claimId');
  return path.join(claimDirectory(store), `${claimId}.json`);
}

async function atomicWriteClaim(
  store: EntityHomeStore,
  claim: ClaimV1,
): Promise<void> {
  const target = claimPath(store, claim.claimId);
  await mkdir(path.dirname(target), { recursive: true });
  await assertSafeClaimDirectory(store);
  const temporary = path.join(
    path.dirname(target),
    `.${claim.claimId}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, serialize(claim), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await replaceFileAtomically(temporary, target);
  await assertSafeClaimFile(target);
}

function assertClaimMatchesStore(
  store: EntityHomeStore,
  claim: ClaimV1,
): ClaimV1 {
  if (claim.workspaceId !== store.workspaceId) {
    throw new Error('MANCODE_CLAIM_WORKSPACE_MISMATCH');
  }
  return claim;
}

async function assertSafeClaimFile(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_CLAIM_PATH_UNSAFE');
  }
}

async function assertSafeClaimDirectory(store: EntityHomeStore): Promise<void> {
  const directory = claimDirectory(store);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_CLAIM_PATH_UNSAFE');
  }
}

function serialize(claim: ClaimV1): string {
  return `${JSON.stringify(claim, null, 2)}\n`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
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

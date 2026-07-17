import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { assertSharedTextSafe } from '../context/privacy.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';

/** A machine-local workflow identity, not a portable account or credential. */
export interface LocalActorIdentityV1 {
  schemaVersion: 1;
  actorId: Ulid;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

/** The deliberately small profile that `team join` may publish. */
export interface SharedActorProfileV1 {
  schemaVersion: 1;
  actorId: Ulid;
  displayName: string;
  joinedAt: string;
  updatedAt: string;
}

export interface CreateLocalActorInput {
  displayName: string;
  actorId?: Ulid;
  now?: Date;
}

export interface ResolveLocalActorInput extends CreateLocalActorInput {}

export interface ResolvedLocalActor {
  actor: LocalActorIdentityV1;
  created: boolean;
}

export async function createLocalActor(
  projectRoot: string,
  input: CreateLocalActorInput,
): Promise<LocalActorIdentityV1> {
  const now = (input.now ?? new Date()).toISOString();
  const actor: LocalActorIdentityV1 = {
    schemaVersion: 1,
    actorId: input.actorId ?? createUlid(),
    displayName: parseDisplayName(input.displayName, 'local actor displayName'),
    createdAt: now,
    updatedAt: now,
  };
  if (input.actorId !== undefined) assertUlid(input.actorId, 'local actorId');
  await mkdir(path.dirname(localActorPath(projectRoot)), { recursive: true });
  try {
    await writeFile(localActorPath(projectRoot), serialize(actor), {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (isAlreadyExists(error)) throw new Error('MANCODE_LOCAL_ACTOR_EXISTS');
    throw error;
  }
  return actor;
}

/** Returns the existing machine-local identity or creates one explicitly. */
export async function resolveOrCreateLocalActor(
  projectRoot: string,
  input: ResolveLocalActorInput,
): Promise<ResolvedLocalActor> {
  const existing = await readLocalActor(projectRoot);
  if (existing !== null) return { actor: existing, created: false };
  return { actor: await createLocalActor(projectRoot, input), created: true };
}

export async function readLocalActor(
  projectRoot: string,
): Promise<LocalActorIdentityV1 | null> {
  return readJsonOrNull(localActorPath(projectRoot), parseLocalActorIdentity);
}

/**
 * Creates the exact data that may cross the local/shared boundary. The local
 * identity never gets copied wholesale, which prevents later private fields
 * from accidentally becoming publishable.
 */
export function createSharedActorProfile(
  actor: LocalActorIdentityV1,
  now: Date = new Date(),
): SharedActorProfileV1 {
  const local = parseLocalActorIdentity(actor);
  assertSharedTextSafe(local.displayName, 'shared actor displayName');
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    actorId: local.actorId,
    displayName: local.displayName,
    joinedAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Publishing is idempotent for the same actor/profile and rejects any actor
 * ID collision that would silently merge identities from two machines.
 */
export async function publishSharedActorProfile(
  projectRoot: string,
  profile: SharedActorProfileV1,
): Promise<SharedActorProfileV1> {
  const parsed = parseSharedActorProfile(profile);
  const target = sharedActorProfilePath(projectRoot, parsed.actorId);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, serialize(parsed), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return parsed;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readSharedActorProfile(projectRoot, parsed.actorId);
    if (
      existing !== null &&
      existing.actorId === parsed.actorId &&
      existing.displayName === parsed.displayName
    ) {
      return existing;
    }
    throw new Error('MANCODE_ACTOR_PROFILE_CONFLICT');
  }
}

export async function readSharedActorProfile(
  projectRoot: string,
  actorId: string,
): Promise<SharedActorProfileV1 | null> {
  assertUlid(actorId, 'shared actor profile actorId');
  return readJsonOrNull(
    sharedActorProfilePath(projectRoot, actorId),
    parseSharedActorProfile,
  );
}

export function parseLocalActorIdentity(value: unknown): LocalActorIdentityV1 {
  assertRecord(value, 'local actor identity');
  assertKnownKeys(
    value,
    ['schemaVersion', 'actorId', 'displayName', 'createdAt', 'updatedAt'],
    'local actor identity',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('local actor identity schemaVersion must be 1');
  }
  assertUlid(value.actorId, 'local actor identity actorId');
  return {
    schemaVersion: 1,
    actorId: value.actorId,
    displayName: parseDisplayName(value.displayName, 'local actor displayName'),
    createdAt: parseTimestamp(value.createdAt, 'local actor createdAt'),
    updatedAt: parseTimestamp(value.updatedAt, 'local actor updatedAt'),
  };
}

export function parseSharedActorProfile(value: unknown): SharedActorProfileV1 {
  assertRecord(value, 'shared actor profile');
  assertKnownKeys(
    value,
    ['schemaVersion', 'actorId', 'displayName', 'joinedAt', 'updatedAt'],
    'shared actor profile',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('shared actor profile schemaVersion must be 1');
  }
  assertUlid(value.actorId, 'shared actor profile actorId');
  const displayName = parseDisplayName(
    value.displayName,
    'shared actor displayName',
  );
  assertSharedTextSafe(displayName, 'shared actor displayName');
  return {
    schemaVersion: 1,
    actorId: value.actorId,
    displayName,
    joinedAt: parseTimestamp(value.joinedAt, 'shared actor joinedAt'),
    updatedAt: parseTimestamp(value.updatedAt, 'shared actor updatedAt'),
  };
}

export function localActorPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'actor.json',
  );
}

export function sharedActorProfileDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'shared',
    'team',
    'actors',
  );
}

export function sharedActorProfilePath(
  projectRoot: string,
  actorId: string,
): string {
  assertUlid(actorId, 'shared actor profile actorId');
  return path.join(sharedActorProfileDirectory(projectRoot), `${actorId}.json`);
}

export function sharedActorProfileDigest(
  profile: SharedActorProfileV1,
): string {
  return digestCanonicalJson(parseSharedActorProfile(profile));
}

async function readJsonOrNull<T>(
  target: string,
  parser: (value: unknown) => T,
): Promise<T | null> {
  try {
    return parser(JSON.parse(await readFile(target, 'utf8')));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError)
      throw new Error('MANCODE_ACTOR_RECORD_CORRUPT');
    throw error;
  }
}

function parseDisplayName(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.trim().length > 128
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

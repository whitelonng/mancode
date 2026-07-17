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
  type HandoffV1,
  assertHandoffTransition,
  parseHandoff,
} from '../team/handoff.js';
import { replaceFileAtomically } from './atomic-file.js';
import { type EntityHomeStore, handoffDirectory } from './entity-home-store.js';

/** Creates one immutable handoff identity, or proves a retry is identical. */
export async function createHandoff(
  store: EntityHomeStore,
  value: HandoffV1,
): Promise<HandoffV1> {
  const handoff = parseHandoff(value);
  const target = handoffPath(store, handoff.handoffId);
  await mkdir(path.dirname(target), { recursive: true });
  await assertSafeHandoffDirectory(store);
  try {
    await writeFile(target, serialize(handoff), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await assertSafeHandoffFile(target);
    return handoff;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readHandoff(store, handoff.handoffId);
    if (
      existing !== null &&
      digestCanonicalJson(existing) === digestCanonicalJson(handoff)
    ) {
      return existing;
    }
    throw new Error('MANCODE_HANDOFF_ID_CONFLICT');
  }
}

/** Reads one coordination-authority handoff without accepting a symlink. */
export async function readHandoff(
  store: EntityHomeStore,
  handoffId: string,
): Promise<HandoffV1 | null> {
  assertUlid(handoffId, 'handoffId');
  const target = handoffPath(store, handoffId);
  try {
    await assertSafeHandoffDirectory(store);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('MANCODE_HANDOFF_PATH_UNSAFE');
    }
    const handoff = parseHandoff(JSON.parse(await readFile(target, 'utf8')));
    if (handoff.handoffId !== handoffId) {
      throw new Error('MANCODE_HANDOFF_CORRUPT');
    }
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('MANCODE_HANDOFF_PATH_UNSAFE');
    }
    return handoff;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError)
      throw new Error('MANCODE_HANDOFF_CORRUPT');
    throw error;
  }
}

/** Performs the revision CAS required for a mutable handoff transition. */
export async function updateHandoff(
  store: EntityHomeStore,
  nextValue: HandoffV1,
  expectedRevision: number,
  actorId: string,
): Promise<HandoffV1> {
  const next = parseHandoff(nextValue);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('MANCODE_HANDOFF_REVISION_INVALID');
  }
  const previous = await readHandoff(store, next.handoffId);
  if (previous === null) throw new Error('MANCODE_HANDOFF_NOT_FOUND');
  if (previous.revision !== expectedRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  assertHandoffTransition(previous, next, actorId as HandoffV1['fromActorId']);
  await atomicWriteHandoff(store, next);
  return next;
}

/** Lists coordination handoffs, optionally narrowed to one shared task. */
export async function listHandoffs(
  store: EntityHomeStore,
  taskRef?: TaskRef,
): Promise<HandoffV1[]> {
  const requested = taskRef === undefined ? null : parseTaskRefValue(taskRef);
  if (requested?.namespace === 'local') {
    throw new Error('handoffs may only target shared TaskRefs');
  }
  let entries: string[];
  try {
    await assertSafeHandoffDirectory(store);
    entries = await readdir(handoffDirectory(store));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const handoffs: HandoffV1[] = [];
  for (const entry of entries.sort(compareUtf8)) {
    if (!entry.endsWith('.json')) continue;
    const handoffId = entry.slice(0, -'.json'.length);
    try {
      assertUlid(handoffId, 'handoff filename');
    } catch {
      throw new Error('MANCODE_HANDOFF_CORRUPT');
    }
    const handoff = await readHandoff(store, handoffId);
    if (handoff === null)
      throw new Error('MANCODE_HANDOFF_CHANGED_DURING_READ');
    if (requested === null || sameTaskRef(handoff.taskRef, requested)) {
      handoffs.push(handoff);
    }
  }
  return handoffs;
}

export function handoffPath(store: EntityHomeStore, handoffId: string): string {
  assertUlid(handoffId, 'handoffId');
  return path.join(handoffDirectory(store), `${handoffId}.json`);
}

async function atomicWriteHandoff(
  store: EntityHomeStore,
  handoff: HandoffV1,
): Promise<void> {
  const target = handoffPath(store, handoff.handoffId);
  await mkdir(path.dirname(target), { recursive: true });
  await assertSafeHandoffDirectory(store);
  const temporary = path.join(
    path.dirname(target),
    `.${handoff.handoffId}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, serialize(handoff), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await replaceFileAtomically(temporary, target);
  await assertSafeHandoffFile(target);
}

async function assertSafeHandoffFile(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_HANDOFF_PATH_UNSAFE');
  }
}

async function assertSafeHandoffDirectory(
  store: EntityHomeStore,
): Promise<void> {
  const stat = await lstat(handoffDirectory(store));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_HANDOFF_PATH_UNSAFE');
  }
}

function serialize(handoff: HandoffV1): string {
  return `${JSON.stringify(handoff, null, 2)}\n`;
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

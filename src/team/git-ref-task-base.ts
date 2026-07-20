import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Ulid, assertUlid } from '../context/ids.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import {
  type GitRefTaskBundleV1,
  parseGitRefTaskBundle,
} from './git-ref-transport.js';

export interface GitRefTaskRemoteBaseV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  taskRef: TaskRef;
  remoteRevision: number;
  bundle: GitRefTaskBundleV1;
}

export async function readGitRefTaskRemoteBase(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<GitRefTaskRemoteBaseV1 | null> {
  const parsedTaskRef = parseTaskRefValue(taskRef);
  const runtime = await readProjectRuntimeContext(projectRoot);
  const target = remoteBasePath(projectRoot, parsedTaskRef);
  try {
    await assertRemoteBaseDirectory(projectRoot);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    const state = parseGitRefTaskRemoteBase(
      JSON.parse(await readFile(target, 'utf8')),
    );
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    if (
      state.workspaceId !== runtime.workspaceId ||
      !sameTaskRef(state.taskRef, parsedTaskRef)
    ) {
      return null;
    }
    return state;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_TRANSPORT_CACHE_CORRUPT');
    }
    throw error;
  }
}

export async function recordGitRefTaskRemoteBase(
  projectRoot: string,
  remoteRevision: number,
  bundle: GitRefTaskBundleV1,
): Promise<GitRefTaskRemoteBaseV1> {
  const parsedBundle = parseGitRefTaskBundle(bundle);
  const revision = positiveInteger(remoteRevision);
  const runtime = await readProjectRuntimeContext(projectRoot);
  const state = parseGitRefTaskRemoteBase({
    schemaVersion: 1,
    workspaceId: runtime.workspaceId,
    taskRef: parsedBundle.taskRef,
    remoteRevision: revision,
    bundle: parsedBundle,
  });
  const directory = await ensureRemoteBaseDirectory(projectRoot);
  const target = remoteBasePath(projectRoot, parsedBundle.taskRef);
  const temporary = path.join(
    directory,
    `.${parsedBundle.taskRef.taskId}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await replaceFileAtomically(temporary, target);
  return state;
}

export function parseGitRefTaskRemoteBase(
  value: unknown,
): GitRefTaskRemoteBaseV1 {
  assertRecord(value, 'git-ref task remote base');
  assertKnownKeys(
    value,
    ['schemaVersion', 'workspaceId', 'taskRef', 'remoteRevision', 'bundle'],
    'git-ref task remote base',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('git-ref task remote base schemaVersion must be 1');
  }
  assertUlid(value.workspaceId, 'git-ref task remote base workspaceId');
  const taskRef = parseTaskRefValue(value.taskRef);
  const bundle = parseGitRefTaskBundle(value.bundle);
  if (!sameTaskRef(taskRef, bundle.taskRef)) {
    throw new Error('MANCODE_TRANSPORT_CACHE_IDENTITY_MISMATCH');
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    taskRef,
    remoteRevision: positiveInteger(value.remoteRevision),
    bundle,
  };
}

async function ensureRemoteBaseDirectory(projectRoot: string): Promise<string> {
  let current = path.resolve(projectRoot);
  for (const segment of [
    '.mancode',
    'local',
    'cache',
    'git-ref',
    'remote-bases',
  ]) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  }
  return current;
}

async function assertRemoteBaseDirectory(projectRoot: string): Promise<void> {
  let current = path.resolve(projectRoot);
  for (const segment of [
    '.mancode',
    'local',
    'cache',
    'git-ref',
    'remote-bases',
  ]) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  }
}

function remoteBasePath(projectRoot: string, taskRef: TaskRef): string {
  const parsed = parseTaskRefValue(taskRef);
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'cache',
    'git-ref',
    'remote-bases',
    `${parsed.taskId}.json`,
  );
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('MANCODE_TRANSPORT_REVISION_INVALID');
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

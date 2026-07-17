import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { locateTask } from './task-locator.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';

export interface LocalOverlayArtifactV1 {
  schemaVersion: 1;
  taskRef: TaskRef;
  artifactId: Ulid;
  byteLength: number;
  contentDigest: string;
  path: string;
}

export interface WriteLocalOverlayArtifactInput {
  projectRoot: string;
  taskRef: TaskRef;
  artifactId?: Ulid;
  content: string | Uint8Array;
}

/**
 * Stores private evidence for an existing shared task under local authority.
 * The artifact ID is immutable and never becomes a shared ArtifactRef.
 */
export async function writeLocalOverlayArtifact(
  input: WriteLocalOverlayArtifactInput,
): Promise<LocalOverlayArtifactV1> {
  const taskRef = sharedTaskRef(input.taskRef);
  await locateTask(input.projectRoot, taskRef);
  const artifactId = input.artifactId ?? createUlid();
  assertUlid(artifactId, 'local overlay artifactId');
  const content = overlayContent(input.content);
  const directory = await ensureSafeOverlayDirectory(
    input.projectRoot,
    taskRef,
  );
  const target = path.join(directory, artifactId);
  try {
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    await assertSafeFile(target);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readSafeFile(target);
    if (!existing.equals(content)) {
      throw new Error('MANCODE_OVERLAY_ARTIFACT_CONFLICT');
    }
  }
  return overlayArtifact(taskRef, artifactId, content, target);
}

export async function readLocalOverlayArtifact(
  projectRoot: string,
  taskRef: TaskRef,
  artifactId: Ulid,
): Promise<Buffer> {
  const parsedTaskRef = sharedTaskRef(taskRef);
  assertUlid(artifactId, 'local overlay artifactId');
  await assertSafeOverlayDirectory(projectRoot, parsedTaskRef);
  try {
    return await readSafeFile(
      localOverlayArtifactPath(projectRoot, parsedTaskRef, artifactId),
    );
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error('MANCODE_OVERLAY_ARTIFACT_NOT_FOUND');
    }
    throw error;
  }
}

export function localOverlayArtifactsDirectory(
  projectRoot: string,
  taskRef: TaskRef,
): string {
  const parsed = sharedTaskRef(taskRef);
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'overlays',
    parsed.taskId,
    'artifacts',
  );
}

export function localOverlayArtifactPath(
  projectRoot: string,
  taskRef: TaskRef,
  artifactId: Ulid,
): string {
  assertUlid(artifactId, 'local overlay artifactId');
  return path.join(
    localOverlayArtifactsDirectory(projectRoot, taskRef),
    artifactId,
  );
}

function sharedTaskRef(value: TaskRef): TaskRef {
  const taskRef = parseTaskRefValue(value);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_OVERLAY_REQUIRES_SHARED_TASK');
  }
  return taskRef;
}

function overlayContent(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('MANCODE_OVERLAY_CONTENT_INVALID');
}

function overlayArtifact(
  taskRef: TaskRef,
  artifactId: Ulid,
  content: Buffer,
  target: string,
): LocalOverlayArtifactV1 {
  return {
    schemaVersion: 1,
    taskRef,
    artifactId,
    byteLength: content.byteLength,
    contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    path: target,
  };
}

async function ensureSafeOverlayDirectory(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<string> {
  let current = path.resolve(projectRoot);
  for (const segment of [
    '.mancode',
    'local',
    'overlays',
    taskRef.taskId,
    'artifacts',
  ]) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertSafeDirectory(current);
  }
  return current;
}

async function assertSafeOverlayDirectory(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<void> {
  let current = path.resolve(projectRoot);
  for (const segment of [
    '.mancode',
    'local',
    'overlays',
    taskRef.taskId,
    'artifacts',
  ]) {
    current = path.join(current, segment);
    try {
      await assertSafeDirectory(current);
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error('MANCODE_OVERLAY_ARTIFACT_NOT_FOUND');
      }
      throw error;
    }
  }
}

async function assertSafeDirectory(target: string): Promise<void> {
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_OVERLAY_PATH_UNSAFE');
  }
}

async function assertSafeFile(target: string): Promise<void> {
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_OVERLAY_PATH_UNSAFE');
  }
}

async function readSafeFile(target: string): Promise<Buffer> {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_OVERLAY_PATH_UNSAFE');
  }
  const content = await readFile(target);
  const after = await lstat(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error('MANCODE_OVERLAY_PATH_UNSAFE');
  }
  return content;
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

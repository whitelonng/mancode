import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from '../context/canonical.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import { replaceFileAtomically } from './atomic-file.js';
import {
  type EntityHomeStore,
  taskHeadDirectory,
} from './entity-home-store.js';
import { type TaskHeadFenceV1, parseTaskHeadFence } from './task-head-fence.js';

/**
 * The task-head fence is coordination-store authority, not an artifact under
 * the task directory. Keeping its storage API separate prevents ordinary
 * workflow writers from accidentally treating it as a local projection.
 */
export async function createTaskHeadFence(
  store: EntityHomeStore,
  fence: TaskHeadFenceV1,
): Promise<TaskHeadFenceV1> {
  const parsed = parseTaskHeadFence(fence);
  const target = taskHeadFencePath(store, parsed.taskRef);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, serialize(parsed), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return parsed;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readTaskHeadFence(store, parsed.taskRef);
    if (
      existing !== null &&
      digestCanonicalJson(existing) === digestCanonicalJson(parsed)
    ) {
      return existing;
    }
    throw new Error('MANCODE_TASK_HEAD_FENCE_CONFLICT');
  }
}

/** Writes a replacement only after the caller has performed its fence CAS. */
export async function replaceTaskHeadFence(
  store: EntityHomeStore,
  fence: TaskHeadFenceV1,
): Promise<TaskHeadFenceV1> {
  const parsed = parseTaskHeadFence(fence);
  const target = taskHeadFencePath(store, parsed.taskRef);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, serialize(parsed), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await replaceFileAtomically(temporary, target);
  return parsed;
}

export async function readTaskHeadFence(
  store: EntityHomeStore,
  taskRef: TaskRef,
): Promise<TaskHeadFenceV1 | null> {
  const parsedTaskRef = parseTaskRefValue(taskRef);
  if (parsedTaskRef.namespace !== 'shared') {
    throw new Error('task head fences require a shared TaskRef');
  }
  try {
    const parsed = parseTaskHeadFence(
      JSON.parse(
        await readFile(taskHeadFencePath(store, parsedTaskRef), 'utf8'),
      ),
    );
    if (
      parsed.taskRef.namespace !== parsedTaskRef.namespace ||
      parsed.taskRef.taskId !== parsedTaskRef.taskId
    ) {
      throw new Error('MANCODE_TASK_HEAD_FENCE_CORRUPT');
    }
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_TASK_HEAD_FENCE_CORRUPT');
    }
    throw error;
  }
}

export function taskHeadFencePath(
  store: EntityHomeStore,
  taskRef: TaskRef,
): string {
  const parsedTaskRef = parseTaskRefValue(taskRef);
  if (parsedTaskRef.namespace !== 'shared') {
    throw new Error('task head fences require a shared TaskRef');
  }
  return path.join(taskHeadDirectory(store), `${parsedTaskRef.taskId}.json`);
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

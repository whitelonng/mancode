import { type Ulid, assertUlid } from './ids.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type TaskNamespace = 'local' | 'shared';

export interface TaskRef {
  namespace: TaskNamespace;
  taskId: Ulid;
}

const TASK_REF_PATTERN = /^(local|shared):([0-7][0-9A-HJKMNPQRSTVWXYZ]{25})$/;

export function formatTaskRef(taskRef: TaskRef): string {
  assertTaskRef(taskRef);
  return `${taskRef.namespace}:${taskRef.taskId}`;
}

export function parseTaskRef(input: unknown): TaskRef {
  if (typeof input !== 'string') {
    throw new Error('TaskRef must be a string in namespace:ULID form');
  }
  const match = TASK_REF_PATTERN.exec(input);
  if (!match) {
    throw new Error('TaskRef must use local:<ULID> or shared:<ULID>');
  }
  return {
    namespace: match[1] as TaskNamespace,
    taskId: match[2] as Ulid,
  };
}

export function parseTaskRefValue(value: unknown): TaskRef {
  assertRecord(value, 'TaskRef');
  assertKnownKeys(value, ['namespace', 'taskId'], 'TaskRef');
  if (value.namespace !== 'local' && value.namespace !== 'shared') {
    throw new Error('TaskRef namespace must be local or shared');
  }
  assertUlid(value.taskId, 'TaskRef taskId');
  return {
    namespace: value.namespace,
    taskId: value.taskId,
  };
}

export function assertTaskRef(value: unknown): asserts value is TaskRef {
  parseTaskRefValue(value);
}

export function sameTaskRef(left: TaskRef, right: TaskRef): boolean {
  return left.namespace === right.namespace && left.taskId === right.taskId;
}

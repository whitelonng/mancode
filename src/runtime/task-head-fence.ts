import {
  type TaskAggregateManifestV1,
  taskAggregateDigest,
} from '../context/aggregate.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';

export interface TaskHeadFenceV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  taskRef: TaskRef;
  fenceRevision: number;
  taskRevision: number;
  aggregateDigest: string;
  ownershipEpoch: number;
  codeRef: {
    head: string;
  };
  checkoutId: Ulid;
  remoteRevision: number | null;
  lastOperationId: Ulid;
  updatedAt: string;
}

export interface TaskHeadFenceTransitionOptions {
  expectedFenceRevision: number;
  /** Only explicit reconcile may adopt a new aggregate or code head at the same task revision. */
  allowSameTaskRevision?: boolean;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseTaskHeadFence(value: unknown): TaskHeadFenceV1 {
  assertRecord(value, 'task head fence');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'workspaceId',
      'taskRef',
      'fenceRevision',
      'taskRevision',
      'aggregateDigest',
      'ownershipEpoch',
      'codeRef',
      'checkoutId',
      'remoteRevision',
      'lastOperationId',
      'updatedAt',
    ],
    'task head fence',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('task head fence schemaVersion must be 1');
  }
  assertUlid(value.workspaceId, 'task head fence workspaceId');
  const taskRef = parseTaskRefValue(value.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('task head fences may only target shared TaskRefs');
  }
  assertUlid(value.checkoutId, 'task head fence checkoutId');
  assertUlid(value.lastOperationId, 'task head fence lastOperationId');
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    taskRef,
    fenceRevision: parsePositiveInteger(
      value.fenceRevision,
      'task head fence fenceRevision',
    ),
    taskRevision: parsePositiveInteger(
      value.taskRevision,
      'task head fence taskRevision',
    ),
    aggregateDigest: parseDigest(
      value.aggregateDigest,
      'task head fence aggregateDigest',
    ),
    ownershipEpoch: parseNonNegativeInteger(
      value.ownershipEpoch,
      'task head fence ownershipEpoch',
    ),
    codeRef: parseCodeRef(value.codeRef),
    checkoutId: value.checkoutId,
    remoteRevision: parseNonNegativeIntegerOrNull(
      value.remoteRevision,
      'task head fence remoteRevision',
    ),
    lastOperationId: value.lastOperationId,
    updatedAt: parseTimestamp(value.updatedAt, 'task head fence updatedAt'),
  };
}

export function assertTaskHeadFenceMatchesAggregate(
  fence: TaskHeadFenceV1,
  manifest: TaskAggregateManifestV1,
  codeHead: string,
): void {
  const normalizedCodeHead = parseCodeHead(
    codeHead,
    'task head fence codeHead',
  );
  if (
    !sameTaskRef(fence.taskRef, manifest.taskRef) ||
    fence.taskRevision !== manifest.taskRevision ||
    fence.ownershipEpoch !== manifest.ownershipEpoch ||
    fence.aggregateDigest !== taskAggregateDigest(manifest) ||
    fence.codeRef.head !== normalizedCodeHead
  ) {
    throw new Error(
      'task aggregate does not match the shared task head fence; reconcile or repair is required',
    );
  }
}

export function assertTaskHeadFenceTransition(
  previous: TaskHeadFenceV1,
  next: TaskHeadFenceV1,
  options: TaskHeadFenceTransitionOptions,
): void {
  if (
    !Number.isSafeInteger(options.expectedFenceRevision) ||
    options.expectedFenceRevision < 1
  ) {
    throw new Error(
      'task head fence expectedFenceRevision must be a positive integer',
    );
  }
  if (previous.fenceRevision !== options.expectedFenceRevision) {
    throw new Error('MANCODE_TASK_HEAD_FENCE_CONFLICT');
  }
  if (
    previous.schemaVersion !== next.schemaVersion ||
    previous.workspaceId !== next.workspaceId ||
    !sameTaskRef(previous.taskRef, next.taskRef)
  ) {
    throw new Error(
      'task head fence schema, workspace, and TaskRef are immutable',
    );
  }
  if (next.fenceRevision !== previous.fenceRevision + 1) {
    throw new Error('task head fence fenceRevision must increase exactly once');
  }
  if (next.taskRevision < previous.taskRevision) {
    throw new Error('task head fence taskRevision cannot decrease');
  }
  if (
    next.taskRevision === previous.taskRevision &&
    options.allowSameTaskRevision !== true
  ) {
    throw new Error(
      'task head fence may only adopt the same taskRevision during explicit reconcile',
    );
  }
  if (
    next.taskRevision === previous.taskRevision &&
    next.aggregateDigest === previous.aggregateDigest &&
    next.codeRef.head === previous.codeRef.head
  ) {
    throw new Error(
      'same-revision task head reconcile requires a different aggregate digest or code head',
    );
  }
}

function parseCodeRef(value: unknown): TaskHeadFenceV1['codeRef'] {
  assertRecord(value, 'task head fence codeRef');
  assertKnownKeys(value, ['head'], 'task head fence codeRef');
  return { head: parseCodeHead(value.head, 'task head fence codeRef head') };
}

function parseCodeHead(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseNonNegativeIntegerOrNull(
  value: unknown,
  label: string,
): number | null {
  if (value === null) return null;
  return parseNonNegativeInteger(value, label);
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

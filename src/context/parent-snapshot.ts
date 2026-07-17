import { sortUtf8StringSet } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import {
  type TaskNamespace,
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export interface ParentSnapshot {
  taskRef: TaskRef;
  revisionAtCreate: number;
  planVersionAtCreate: number;
  requirementsDigestAtCreate: string;
  implementationScopeDigestAtCreate: string;
  visibility: TaskNamespace;
  coordination: 'single' | 'team';
  participants: Ulid[];
}

export interface ParentSnapshotSource {
  taskRef: TaskRef;
  revision: number;
  planVersion: number;
  requirementsDigest: string;
  implementationScopeDigest: string;
  visibility: TaskNamespace;
  coordination: 'single' | 'team';
}

export type ParentStaleReason =
  | 'task_ref'
  | 'revision'
  | 'plan_version'
  | 'requirements_digest'
  | 'implementation_scope_digest'
  | 'visibility'
  | 'coordination';

export function parseParentSnapshot(value: unknown): ParentSnapshot {
  assertRecord(value, 'parent snapshot envelope');
  assertKnownKeys(value, ['parent'], 'parent snapshot envelope');
  assertRecord(value.parent, 'parent snapshot');
  assertKnownKeys(
    value.parent,
    [
      'taskRef',
      'revisionAtCreate',
      'planVersionAtCreate',
      'requirementsDigestAtCreate',
      'implementationScopeDigestAtCreate',
      'visibility',
      'coordination',
      'participants',
    ],
    'parent snapshot',
  );
  const parent = value.parent;
  if (parent.visibility !== 'local' && parent.visibility !== 'shared') {
    throw new Error('parent snapshot visibility must be local or shared');
  }
  if (parent.coordination !== 'single' && parent.coordination !== 'team') {
    throw new Error('parent snapshot coordination must be single or team');
  }
  const taskRef = parseTaskRefValue(parent.taskRef);
  if (taskRef.namespace !== parent.visibility) {
    throw new Error('parent snapshot TaskRef namespace must match visibility');
  }
  return {
    taskRef,
    revisionAtCreate: parsePositiveInteger(
      parent.revisionAtCreate,
      'parent snapshot revisionAtCreate',
    ),
    planVersionAtCreate: parsePositiveInteger(
      parent.planVersionAtCreate,
      'parent snapshot planVersionAtCreate',
    ),
    requirementsDigestAtCreate: parseDigest(
      parent.requirementsDigestAtCreate,
      'parent snapshot requirementsDigestAtCreate',
    ),
    implementationScopeDigestAtCreate: parseDigest(
      parent.implementationScopeDigestAtCreate,
      'parent snapshot implementationScopeDigestAtCreate',
    ),
    visibility: parent.visibility,
    coordination: parent.coordination,
    participants: parseParticipants(parent.participants),
  };
}

export function parentSnapshotStaleReasons(
  snapshot: ParentSnapshot,
  source: ParentSnapshotSource,
): ParentStaleReason[] {
  const reasons: ParentStaleReason[] = [];
  if (!sameTaskRef(snapshot.taskRef, source.taskRef)) reasons.push('task_ref');
  if (snapshot.revisionAtCreate !== source.revision) reasons.push('revision');
  if (snapshot.planVersionAtCreate !== source.planVersion)
    reasons.push('plan_version');
  if (snapshot.requirementsDigestAtCreate !== source.requirementsDigest) {
    reasons.push('requirements_digest');
  }
  if (
    snapshot.implementationScopeDigestAtCreate !==
    source.implementationScopeDigest
  ) {
    reasons.push('implementation_scope_digest');
  }
  if (snapshot.visibility !== source.visibility) reasons.push('visibility');
  if (snapshot.coordination !== source.coordination)
    reasons.push('coordination');
  return reasons;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseParticipants(value: unknown): Ulid[] {
  if (!Array.isArray(value)) {
    throw new Error('parent snapshot participants must be an array');
  }
  for (const participant of value) {
    assertUlid(participant, 'parent snapshot participant');
  }
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length) {
    throw new Error('parent snapshot participants must not contain duplicates');
  }
  return normalized as Ulid[];
}

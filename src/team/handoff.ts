import {
  type ArtifactRef,
  assertReferenceNamespace,
  parseArtifactRef,
} from '../context/artifact-ref.js';
import { sortUtf8StringSet } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertSharedTextSafe } from '../context/privacy.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import type { CodeRef, CoordinationMode } from './claims.js';

export type HandoffState =
  | 'draft'
  | 'offered'
  | 'accepted'
  | 'rejected'
  | 'cancelled';
export type HandoffTransportState =
  | 'local_only'
  | 'published'
  | 'fetched'
  | 'stale';

export interface HandoffSummary {
  completed: string[];
  inProgress: string[];
  notStarted: string[];
  changedFiles: string[];
  verification: string[];
  blockers: string[];
  risks: string[];
  nextAction: string;
}

export interface HandoffTransport {
  mode: CoordinationMode;
  state: HandoffTransportState;
  transportRevision: number | null;
  publishedAt: string | null;
  fetchedAt: string | null;
  taskBundleDigest: string;
  codeRef: CodeRef;
  codeReachable: boolean;
  receipt: string | null;
}

export interface HandoffResolution {
  state: Extract<HandoffState, 'accepted' | 'rejected' | 'cancelled'>;
  actorId: Ulid;
  at: string;
  reason: string | null;
}

export interface HandoffV1 {
  schemaVersion: 1;
  handoffId: Ulid;
  taskRef: TaskRef;
  taskRevision: number;
  /** Durable fence snapshot used to reject a stale owner transfer. */
  ownershipEpochAtOffer: number;
  state: HandoffState;
  revision: number;
  fromActorId: Ulid;
  toActorId: Ulid;
  claimIds: Ulid[];
  checkpointRef: ArtifactRef;
  summary: HandoffSummary;
  transport: HandoffTransport;
  lastOperationId: Ulid | null;
  offeredAt: string | null;
  resolution: HandoffResolution | null;
  createdAt: string;
  updatedAt: string;
}

const HANDOFF_STATES = new Set<HandoffState>([
  'draft',
  'offered',
  'accepted',
  'rejected',
  'cancelled',
]);
const TRANSPORT_STATES = new Set<HandoffTransportState>([
  'local_only',
  'published',
  'fetched',
  'stale',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseHandoff(value: unknown): HandoffV1 {
  assertRecord(value, 'handoff');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'handoffId',
      'taskRef',
      'taskRevision',
      'ownershipEpochAtOffer',
      'state',
      'revision',
      'fromActorId',
      'toActorId',
      'claimIds',
      'checkpointRef',
      'summary',
      'transport',
      'lastOperationId',
      'offeredAt',
      'resolution',
      'createdAt',
      'updatedAt',
    ],
    'handoff',
  );
  if (value.schemaVersion !== 1)
    throw new Error('handoff schemaVersion must be 1');
  assertUlid(value.handoffId, 'handoffId');
  assertUlid(value.fromActorId, 'handoff fromActorId');
  assertUlid(value.toActorId, 'handoff toActorId');
  if (value.fromActorId === value.toActorId) {
    throw new Error('handoff requires a distinct receiving actor');
  }
  const taskRef = parseTaskRefValue(value.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('handoffs may only target shared TaskRefs');
  }
  const checkpointRef = parseArtifactRef(value.checkpointRef);
  assertReferenceNamespace('shared', checkpointRef);
  if (
    checkpointRef.kind !== 'checkpoint' ||
    !sameTaskRef(checkpointRef.taskRef, taskRef)
  ) {
    throw new Error(
      'handoff checkpointRef must be a checkpoint for the same task',
    );
  }
  const state = parseHandoffState(value.state);
  const handoff: HandoffV1 = {
    schemaVersion: 1,
    handoffId: value.handoffId,
    taskRef,
    taskRevision: parsePositiveInteger(
      value.taskRevision,
      'handoff taskRevision',
    ),
    ownershipEpochAtOffer: parseNonNegativeInteger(
      value.ownershipEpochAtOffer,
      'handoff ownershipEpochAtOffer',
    ),
    state,
    revision: parsePositiveInteger(value.revision, 'handoff revision'),
    fromActorId: value.fromActorId,
    toActorId: value.toActorId,
    claimIds: parseUlidSet(value.claimIds, 'handoff claimIds'),
    checkpointRef,
    summary: parseSummary(value.summary),
    transport: parseTransport(value.transport),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'handoff lastOperationId',
    ),
    offeredAt: parseTimestampOrNull(value.offeredAt, 'handoff offeredAt'),
    resolution: parseResolution(value.resolution),
    createdAt: parseTimestamp(value.createdAt, 'handoff createdAt'),
    updatedAt: parseTimestamp(value.updatedAt, 'handoff updatedAt'),
  };
  assertHandoffStateShape(handoff);
  if (handoff.transport.receipt !== null) {
    assertSharedTextSafe(
      handoff.transport.receipt,
      'handoff transport receipt',
    );
  }
  if (handoff.resolution !== null && handoff.resolution.reason !== null) {
    assertSharedTextSafe(
      handoff.resolution.reason,
      'handoff resolution reason',
    );
  }
  return handoff;
}

export function assertHandoffTransition(
  previous: HandoffV1,
  next: HandoffV1,
  actorId: Ulid,
): void {
  assertUlid(actorId, 'handoff transition actorId');
  assertHandoffIdentityIsStable(previous, next);
  if (next.revision !== previous.revision + 1) {
    throw new Error('handoff revision must increase exactly once per mutation');
  }
  if (previous.state === next.state) return;
  if (!allowedHandoffTransitions(previous.state).has(next.state)) {
    throw new Error(
      `invalid handoff state transition: ${previous.state} -> ${next.state}`,
    );
  }
  if (
    (next.state === 'accepted' || next.state === 'rejected') &&
    actorId !== next.toActorId
  ) {
    throw new Error('only the receiving actor can accept or reject a handoff');
  }
}

function parseHandoffState(value: unknown): HandoffState {
  if (typeof value !== 'string' || !HANDOFF_STATES.has(value as HandoffState)) {
    throw new Error('handoff state is invalid');
  }
  return value as HandoffState;
}

function parseSummary(value: unknown): HandoffSummary {
  assertRecord(value, 'handoff summary');
  const fields = [
    'completed',
    'inProgress',
    'notStarted',
    'changedFiles',
    'verification',
    'blockers',
    'risks',
    'nextAction',
  ] as const;
  assertKnownKeys(value, fields, 'handoff summary');
  if (typeof value.nextAction !== 'string' || !value.nextAction.trim()) {
    throw new Error('handoff summary nextAction is required');
  }
  const summary: HandoffSummary = {
    completed: parseSummaryItems(value.completed, 'handoff summary completed'),
    inProgress: parseSummaryItems(
      value.inProgress,
      'handoff summary inProgress',
    ),
    notStarted: parseSummaryItems(
      value.notStarted,
      'handoff summary notStarted',
    ),
    changedFiles: parseSummaryItems(
      value.changedFiles,
      'handoff summary changedFiles',
    ),
    verification: parseSummaryItems(
      value.verification,
      'handoff summary verification',
    ),
    blockers: parseSummaryItems(value.blockers, 'handoff summary blockers'),
    risks: parseSummaryItems(value.risks, 'handoff summary risks'),
    nextAction: value.nextAction,
  };
  for (const [label, items] of [
    ['completed', summary.completed],
    ['inProgress', summary.inProgress],
    ['notStarted', summary.notStarted],
    ['changedFiles', summary.changedFiles],
    ['verification', summary.verification],
    ['blockers', summary.blockers],
    ['risks', summary.risks],
    ['nextAction', [summary.nextAction]],
  ] as const) {
    for (const item of items) {
      assertSharedTextSafe(item, `handoff summary ${label}`);
    }
  }
  return summary;
}

function parseTransport(value: unknown): HandoffTransport {
  assertRecord(value, 'handoff transport');
  assertKnownKeys(
    value,
    [
      'mode',
      'state',
      'transportRevision',
      'publishedAt',
      'fetchedAt',
      'taskBundleDigest',
      'codeRef',
      'codeReachable',
      'receipt',
    ],
    'handoff transport',
  );
  if (value.mode !== 'local' && value.mode !== 'git-ref') {
    throw new Error('handoff transport mode must be local or git-ref');
  }
  if (
    typeof value.state !== 'string' ||
    !TRANSPORT_STATES.has(value.state as HandoffTransportState)
  ) {
    throw new Error('handoff transport state is invalid');
  }
  if (
    typeof value.taskBundleDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.taskBundleDigest)
  ) {
    throw new Error('handoff transport taskBundleDigest is invalid');
  }
  if (typeof value.codeReachable !== 'boolean') {
    throw new Error('handoff transport codeReachable must be boolean');
  }
  const transport: HandoffTransport = {
    mode: value.mode,
    state: value.state as HandoffTransportState,
    transportRevision: parseRevisionOrNull(
      value.transportRevision,
      'handoff transportRevision',
    ),
    publishedAt: parseTimestampOrNull(value.publishedAt, 'handoff publishedAt'),
    fetchedAt: parseTimestampOrNull(value.fetchedAt, 'handoff fetchedAt'),
    taskBundleDigest: value.taskBundleDigest,
    codeRef: parseCodeRef(value.codeRef, 'handoff transport codeRef'),
    codeReachable: value.codeReachable,
    receipt: parseNonEmptyStringOrNull(
      value.receipt,
      'handoff transport receipt',
    ),
  };
  if (transport.mode === 'local' && transport.state !== 'local_only') {
    throw new Error('local handoff transport can only be local_only');
  }
  if (
    transport.state === 'published' &&
    (transport.publishedAt === null || transport.receipt === null)
  ) {
    throw new Error(
      'published handoffs require publishedAt and a transport receipt',
    );
  }
  if (transport.state === 'fetched' && transport.fetchedAt === null) {
    throw new Error('fetched handoffs require fetchedAt');
  }
  return transport;
}

function parseResolution(value: unknown): HandoffResolution | null {
  if (value === null) return null;
  assertRecord(value, 'handoff resolution');
  assertKnownKeys(
    value,
    ['state', 'actorId', 'at', 'reason'],
    'handoff resolution',
  );
  if (
    value.state !== 'accepted' &&
    value.state !== 'rejected' &&
    value.state !== 'cancelled'
  ) {
    throw new Error('handoff resolution state is invalid');
  }
  assertUlid(value.actorId, 'handoff resolution actorId');
  return {
    state: value.state,
    actorId: value.actorId,
    at: parseTimestamp(value.at, 'handoff resolution at'),
    reason: parseNonEmptyStringOrNull(
      value.reason,
      'handoff resolution reason',
    ),
  };
}

function parseCodeRef(value: unknown, label: string): CodeRef {
  assertRecord(value, label);
  assertKnownKeys(value, ['branch', 'head'], label);
  if (
    typeof value.branch !== 'string' ||
    !value.branch.trim() ||
    typeof value.head !== 'string' ||
    !value.head.trim()
  ) {
    throw new Error(`${label} branch and head are required`);
  }
  return { branch: value.branch, head: value.head };
}

function parseSummaryItems(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function parseUlidSet(value: unknown, label: string): Ulid[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  for (const item of normalized) {
    assertUlid(item, label);
  }
  return normalized as Ulid[];
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

function parseRevisionOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  return parsePositiveInteger(value, label);
}

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, label);
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseTimestampOrNull(value: unknown, label: string): string | null {
  return value === null ? null : parseTimestamp(value, label);
}

function parseNonEmptyStringOrNull(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string or null`);
  }
  return value;
}

function assertHandoffStateShape(handoff: HandoffV1): void {
  if (handoff.state === 'draft') {
    if (handoff.offeredAt !== null || handoff.resolution !== null) {
      throw new Error('draft handoffs cannot have offeredAt or a resolution');
    }
    return;
  }
  if (handoff.state === 'offered') {
    if (handoff.offeredAt === null || handoff.resolution !== null) {
      throw new Error(
        'offered handoffs require offeredAt and cannot have a resolution',
      );
    }
    return;
  }
  if (
    handoff.resolution === null ||
    handoff.resolution.state !== handoff.state
  ) {
    throw new Error('terminal handoffs require a matching resolution');
  }
  if (handoff.state === 'cancelled') {
    // A sender may cancel a named draft before it is offered. Once offered,
    // the original timestamp remains as audit evidence, but it is not a
    // prerequisite for the cancellation transition itself.
    return;
  }
  if (handoff.offeredAt === null) {
    throw new Error('terminal handoffs must have been offered first');
  }
  if (handoff.state === 'accepted' && handoff.resolution.reason !== null) {
    throw new Error('accepted handoffs cannot have a resolution reason');
  }
  if (
    (handoff.state === 'accepted' || handoff.state === 'rejected') &&
    handoff.resolution.actorId !== handoff.toActorId
  ) {
    throw new Error(
      'accepted or rejected handoffs require the receiving actor',
    );
  }
  if (handoff.state === 'rejected' && handoff.resolution.reason === null) {
    throw new Error('rejected handoffs require a resolution reason');
  }
}

function assertHandoffIdentityIsStable(
  previous: HandoffV1,
  next: HandoffV1,
): void {
  if (
    previous.handoffId !== next.handoffId ||
    !sameTaskRef(previous.taskRef, next.taskRef) ||
    previous.taskRevision !== next.taskRevision ||
    previous.ownershipEpochAtOffer !== next.ownershipEpochAtOffer ||
    previous.fromActorId !== next.fromActorId ||
    previous.toActorId !== next.toActorId ||
    JSON.stringify(previous.claimIds) !== JSON.stringify(next.claimIds) ||
    JSON.stringify(previous.checkpointRef) !==
      JSON.stringify(next.checkpointRef) ||
    previous.createdAt !== next.createdAt
  ) {
    throw new Error(
      'handoff identity, recipient, claims, and checkpoint are immutable',
    );
  }
}

function allowedHandoffTransitions(from: HandoffState): Set<HandoffState> {
  switch (from) {
    case 'draft':
      return new Set(['offered', 'cancelled']);
    case 'offered':
      return new Set(['accepted', 'rejected', 'cancelled']);
    case 'accepted':
    case 'rejected':
    case 'cancelled':
      return new Set();
  }
}

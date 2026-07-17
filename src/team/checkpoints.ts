import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertSharedTextSafe } from '../context/privacy.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';

export type CheckpointKind =
  | 'plan_confirmed'
  | 'scope_changed'
  | 'diagnostic_started'
  | 'base_changed'
  | 'verification_completed'
  | 'blocked'
  | 'handoff_offered'
  | 'completed';

export interface CheckpointV1 {
  schemaVersion: 1;
  checkpointId: Ulid;
  /** Immutable provenance for the journal that created this checkpoint. */
  operationId: Ulid;
  taskRef: TaskRef;
  taskRevision: number;
  ownershipEpochAtOffer: number;
  kind: CheckpointKind;
  git: {
    branch: string | null;
    head: string | null;
    base: string | null;
  };
  summary: string;
  governance: {
    requirementsDigest: string;
    planVersion: number;
    reviewLedgerDigest: string;
    verificationLedgerDigest: string;
  };
  nextAction: string;
  createdBy: {
    actorId: Ulid;
    client: string;
  };
  createdAt: string;
}

const CHECKPOINT_KINDS = new Set<CheckpointKind>([
  'plan_confirmed',
  'scope_changed',
  'diagnostic_started',
  'base_changed',
  'verification_completed',
  'blocked',
  'handoff_offered',
  'completed',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseCheckpoint(value: unknown): CheckpointV1 {
  assertRecord(value, 'checkpoint');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'checkpointId',
      'operationId',
      'taskRef',
      'taskRevision',
      'ownershipEpochAtOffer',
      'kind',
      'git',
      'summary',
      'governance',
      'nextAction',
      'createdBy',
      'createdAt',
    ],
    'checkpoint',
  );
  if (value.schemaVersion !== 1)
    throw new Error('checkpoint schemaVersion must be 1');
  assertUlid(value.checkpointId, 'checkpointId');
  assertUlid(value.operationId, 'checkpoint operationId');
  const kind = parseCheckpointKind(value.kind);
  if (typeof value.summary !== 'string' || !value.summary.trim()) {
    throw new Error('checkpoint summary is required');
  }
  if (typeof value.nextAction !== 'string' || !value.nextAction.trim()) {
    throw new Error('checkpoint nextAction is required');
  }
  assertSharedTextSafe(value.summary, 'checkpoint summary');
  assertSharedTextSafe(value.nextAction, 'checkpoint nextAction');
  return {
    schemaVersion: 1,
    checkpointId: value.checkpointId,
    operationId: value.operationId,
    taskRef: parseTaskRefValue(value.taskRef),
    taskRevision: parsePositiveInteger(
      value.taskRevision,
      'checkpoint taskRevision',
    ),
    ownershipEpochAtOffer: parseNonNegativeInteger(
      value.ownershipEpochAtOffer,
      'checkpoint ownershipEpochAtOffer',
    ),
    kind,
    git: parseGitSnapshot(value.git),
    summary: value.summary,
    governance: parseGovernance(value.governance),
    nextAction: value.nextAction,
    createdBy: parseCreatedBy(value.createdBy),
    createdAt: parseTimestamp(value.createdAt, 'checkpoint createdAt'),
  };
}

export function parseCheckpointKind(value: unknown): CheckpointKind {
  if (
    typeof value !== 'string' ||
    !CHECKPOINT_KINDS.has(value as CheckpointKind)
  ) {
    throw new Error('checkpoint kind is invalid');
  }
  return value as CheckpointKind;
}

/**
 * Checkpoints are immutable, so their aggregate reference digest covers the
 * complete typed snapshot, including provenance and its creation time.
 */
export function checkpointDigest(checkpoint: CheckpointV1): string {
  return digestCanonicalJson(checkpoint);
}

function parseGitSnapshot(value: unknown): CheckpointV1['git'] {
  assertRecord(value, 'checkpoint git');
  assertKnownKeys(value, ['branch', 'head', 'base'], 'checkpoint git');
  return {
    branch: parseGitValueOrNull(value.branch, 'checkpoint git branch'),
    head: parseGitValueOrNull(value.head, 'checkpoint git head'),
    base: parseGitValueOrNull(value.base, 'checkpoint git base'),
  };
}

function parseGovernance(value: unknown): CheckpointV1['governance'] {
  assertRecord(value, 'checkpoint governance');
  assertKnownKeys(
    value,
    [
      'requirementsDigest',
      'planVersion',
      'reviewLedgerDigest',
      'verificationLedgerDigest',
    ],
    'checkpoint governance',
  );
  return {
    requirementsDigest: parseDigest(
      value.requirementsDigest,
      'checkpoint requirementsDigest',
    ),
    planVersion: parsePositiveInteger(
      value.planVersion,
      'checkpoint planVersion',
    ),
    reviewLedgerDigest: parseDigest(
      value.reviewLedgerDigest,
      'checkpoint reviewLedgerDigest',
    ),
    verificationLedgerDigest: parseDigest(
      value.verificationLedgerDigest,
      'checkpoint verificationLedgerDigest',
    ),
  };
}

function parseCreatedBy(value: unknown): CheckpointV1['createdBy'] {
  assertRecord(value, 'checkpoint createdBy');
  assertKnownKeys(value, ['actorId', 'client'], 'checkpoint createdBy');
  assertUlid(value.actorId, 'checkpoint createdBy actorId');
  if (typeof value.client !== 'string' || !value.client.trim()) {
    throw new Error('checkpoint createdBy client is required');
  }
  return { actorId: value.actorId, client: value.client };
}

function parseGitValueOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string or null`);
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
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

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

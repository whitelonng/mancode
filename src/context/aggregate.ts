import { type CheckpointV1, checkpointDigest } from '../team/checkpoints.js';
import { digestCanonicalJson } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import {
  type RequirementsLedgerV1,
  requirementsAreReady,
} from './requirements-ledger.js';
import {
  type ReviewLedgerV1,
  assertReviewLedgerAgainstContext,
} from './review-ledger.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';
import {
  type VerificationLedgerV1,
  assertVerificationLedgerAgainstContext,
  assertVerificationLedgerRequirements,
} from './verification-ledger.js';
import {
  type WorkflowMetadataV3,
  workflowMetadataDigest,
} from './workflow-metadata.js';

export interface TaskAggregateManifestV1 {
  taskRef: TaskRef;
  taskRevision: number;
  ownershipEpoch: number;
  metadataDigest: string;
  requirementsDigest: string;
  reviewDigest: string;
  verificationDigest: string;
  planVersion: number;
  planDigest: string | null;
  latestCheckpointId: Ulid | null;
  latestCheckpointDigest: string | null;
  parentSnapshotDigest: string | null;
}

export interface TaskAggregateInput {
  metadata: WorkflowMetadataV3;
  requirements: RequirementsLedgerV1;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  planDigest: string | null;
  latestCheckpoint: CheckpointV1 | null;
}

export interface TaskCompletionContext {
  activeChildTaskRefs: TaskRef[];
  hasPendingRepairOperation: boolean;
  activeClaimCount: number;
  claimsWillReleaseOrTransfer?: boolean;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function buildTaskAggregateManifest(
  input: TaskAggregateInput,
): TaskAggregateManifestV1 {
  assertTaskAggregateConsistency(input);
  const latestCheckpoint = input.latestCheckpoint;
  return {
    taskRef: input.metadata.taskRef,
    taskRevision: input.metadata.revision,
    ownershipEpoch: input.metadata.ownershipEpoch,
    metadataDigest: workflowMetadataDigest(input.metadata),
    requirementsDigest: input.requirements.contentDigest,
    reviewDigest: input.review.contentDigest,
    verificationDigest: input.verification.contentDigest,
    planVersion: input.metadata.governance.planVersion,
    planDigest: input.planDigest,
    latestCheckpointId: latestCheckpoint?.checkpointId ?? null,
    latestCheckpointDigest:
      latestCheckpoint === null ? null : checkpointDigest(latestCheckpoint),
    parentSnapshotDigest:
      input.metadata.parent === null
        ? null
        : digestCanonicalJson(input.metadata.parent),
  };
}

export function taskAggregateDigest(manifest: TaskAggregateManifestV1): string {
  return digestCanonicalJson(manifest);
}

export function parseTaskAggregateManifest(
  value: unknown,
): TaskAggregateManifestV1 {
  assertRecord(value, 'task aggregate manifest');
  assertKnownKeys(
    value,
    [
      'taskRef',
      'taskRevision',
      'ownershipEpoch',
      'metadataDigest',
      'requirementsDigest',
      'reviewDigest',
      'verificationDigest',
      'planVersion',
      'planDigest',
      'latestCheckpointId',
      'latestCheckpointDigest',
      'parentSnapshotDigest',
    ],
    'task aggregate manifest',
  );
  const latestCheckpointId = parseUlidOrNull(
    value.latestCheckpointId,
    'task aggregate manifest latestCheckpointId',
  );
  const latestCheckpointDigest = parseDigestOrNull(
    value.latestCheckpointDigest,
    'task aggregate manifest latestCheckpointDigest',
  );
  if ((latestCheckpointId === null) !== (latestCheckpointDigest === null)) {
    throw new Error(
      'task aggregate manifest checkpoint ID and digest must be supplied together',
    );
  }
  return {
    taskRef: parseTaskRefValue(value.taskRef),
    taskRevision: parsePositiveInteger(
      value.taskRevision,
      'task aggregate manifest taskRevision',
    ),
    ownershipEpoch: parseNonNegativeInteger(
      value.ownershipEpoch,
      'task aggregate manifest ownershipEpoch',
    ),
    metadataDigest: parseDigest(
      value.metadataDigest,
      'task aggregate manifest metadataDigest',
    ),
    requirementsDigest: parseDigest(
      value.requirementsDigest,
      'task aggregate manifest requirementsDigest',
    ),
    reviewDigest: parseDigest(
      value.reviewDigest,
      'task aggregate manifest reviewDigest',
    ),
    verificationDigest: parseDigest(
      value.verificationDigest,
      'task aggregate manifest verificationDigest',
    ),
    planVersion: parsePositiveInteger(
      value.planVersion,
      'task aggregate manifest planVersion',
    ),
    planDigest: parseDigestOrNull(
      value.planDigest,
      'task aggregate manifest planDigest',
    ),
    latestCheckpointId,
    latestCheckpointDigest,
    parentSnapshotDigest: parseDigestOrNull(
      value.parentSnapshotDigest,
      'task aggregate manifest parentSnapshotDigest',
    ),
  };
}

export function assertTaskAggregateConsistency(
  input: TaskAggregateInput,
): void {
  const { metadata, requirements, review, verification } = input;
  assertDigestOrNull(input.planDigest, 'task aggregate planDigest');
  assertSameTaskRef(metadata.taskRef, requirements.taskRef, 'requirements');
  assertSameTaskRef(metadata.taskRef, review.taskRef, 'review ledger');
  assertSameTaskRef(
    metadata.taskRef,
    verification.taskRef,
    'verification ledger',
  );
  assertRequirementsCache(metadata, requirements);
  assertReviewCache(metadata, review, requirements);
  assertVerificationCache(metadata, verification, requirements, review);
  assertLatestCheckpoint(metadata, input.latestCheckpoint);
}

export function assertTaskCompletionGate(
  input: TaskAggregateInput,
  context: TaskCompletionContext,
): void {
  assertTaskAggregateConsistency(input);
  const { metadata, requirements, review, verification } = input;
  if (metadata.status !== 'in_progress' && metadata.status !== 'planned') {
    throw new Error('only active workflows may pass the task completion gate');
  }
  if (metadata.transitionState !== 'stable') {
    throw new Error('workflows with a pending operation cannot complete');
  }
  if (metadata.governance.planDecision === null) {
    throw new Error('task completion requires a plan decision');
  }
  if (metadata.governance.planDecision === 'solo_handoff') {
    assertSoloHandoffCompletionGate(input, context);
    return;
  }
  if (metadata.soloExecution?.state === 'active') {
    throw new Error(
      'an active solo execution must complete before the workflow',
    );
  }
  if (
    metadata.governance.requirementsStatus !== 'ready' ||
    requirements.status !== 'confirmed' ||
    !requirementsAreReady(requirements)
  ) {
    throw new Error('task completion requires ready confirmed requirements');
  }
  assertReviewLedgerAgainstContext(review, {
    requirementsDigest: requirements.contentDigest,
    planVersion: metadata.governance.planVersion,
  });
  if (review.status !== 'passed' && review.status !== 'skipped') {
    throw new Error(
      'task completion requires a current passing or skipped review',
    );
  }
  assertVerificationLedgerRequirements(verification, requirements);
  assertVerificationLedgerAgainstContext(verification, {
    requirementsDigest: requirements.contentDigest,
    planVersion: metadata.governance.planVersion,
    remediationRound: review.remediationRound,
  });
  if (verification.status !== 'passed') {
    throw new Error(
      'task completion requires current required acceptance evidence',
    );
  }
  assertTaskCompletionContext(metadata, context);
}

/**
 * A solo handoff preserves the legacy contract: a confirmed plan is handed to
 * one local session instead of traversing the governed review/verification
 * stages. It still requires ready requirements, a stable completed assignment,
 * a plan artifact, and the normal child/repair/claim context checks.
 */
function assertSoloHandoffCompletionGate(
  input: TaskAggregateInput,
  context: TaskCompletionContext,
): void {
  const { metadata, requirements } = input;
  if (
    metadata.workflowMode !== 'man' ||
    metadata.coordination !== 'single' ||
    metadata.soloExecution?.state !== 'completed' ||
    metadata.soloExecution.planVersion !== metadata.governance.planVersion ||
    input.planDigest === null
  ) {
    throw new Error('task completion solo handoff assignment is invalid');
  }
  if (
    metadata.governance.requirementsStatus !== 'ready' ||
    requirements.status !== 'confirmed' ||
    !requirementsAreReady(requirements)
  ) {
    throw new Error('task completion requires ready confirmed requirements');
  }
  assertTaskCompletionContext(metadata, context);
}

function assertRequirementsCache(
  metadata: WorkflowMetadataV3,
  requirements: RequirementsLedgerV1,
): void {
  if (metadata.governance.requirementsDigest !== requirements.contentDigest) {
    throw new Error(
      'workflow metadata requirementsDigest must match the requirements ledger',
    );
  }
  const expectedStatus =
    requirements.status === 'confirmed' && requirementsAreReady(requirements)
      ? 'ready'
      : 'needs_clarification';
  if (metadata.governance.requirementsStatus !== expectedStatus) {
    throw new Error(
      `workflow metadata requirementsStatus must be ${expectedStatus}`,
    );
  }
}

function assertReviewCache(
  metadata: WorkflowMetadataV3,
  review: ReviewLedgerV1,
  requirements: RequirementsLedgerV1,
): void {
  if (metadata.governance.reviewLedgerDigest !== review.contentDigest) {
    throw new Error(
      'workflow metadata reviewLedgerDigest must match the review ledger',
    );
  }
  if (metadata.governance.reviewStatus !== review.status) {
    throw new Error(
      'workflow metadata reviewStatus must match the review ledger',
    );
  }
  // Legacy migration may faithfully preserve a review that predates the
  // requirements/plan foreign keys. Its dedicated compatibility gate was
  // already checked during migration parity; ordinary V3 review writes must
  // replace it with a fully bound ledger before changing governance state.
  if (
    review.legacySource !== null &&
    (review.requirementsDigest === null || review.planVersion === null)
  ) {
    return;
  }
  assertReviewLedgerAgainstContext(review, {
    requirementsDigest: requirements.contentDigest,
    planVersion: metadata.governance.planVersion,
  });
}

function assertVerificationCache(
  metadata: WorkflowMetadataV3,
  verification: VerificationLedgerV1,
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
): void {
  if (
    metadata.governance.verificationLedgerDigest !== verification.contentDigest
  ) {
    throw new Error(
      'workflow metadata verificationLedgerDigest must match the verification ledger',
    );
  }
  if (metadata.governance.verificationStatus !== verification.status) {
    throw new Error(
      'workflow metadata verificationStatus must match the verification ledger',
    );
  }
  assertVerificationLedgerAgainstContext(verification, {
    requirementsDigest: requirements.contentDigest,
    planVersion: metadata.governance.planVersion,
    remediationRound: review.remediationRound,
  });
  if (verification.status !== 'stale') {
    assertVerificationLedgerRequirements(verification, requirements);
  }
}

function assertLatestCheckpoint(
  metadata: WorkflowMetadataV3,
  latestCheckpoint: CheckpointV1 | null,
): void {
  if (metadata.latestCheckpointRef === null) {
    if (latestCheckpoint !== null) {
      throw new Error(
        'an aggregate checkpoint requires metadata.latestCheckpointRef',
      );
    }
    return;
  }
  if (latestCheckpoint === null) {
    throw new Error(
      'metadata.latestCheckpointRef requires an aggregate checkpoint',
    );
  }
  if (
    metadata.latestCheckpointRef.kind !== 'checkpoint' ||
    metadata.latestCheckpointRef.artifactId === undefined ||
    metadata.latestCheckpointRef.artifactId !== latestCheckpoint.checkpointId ||
    !sameTaskRef(metadata.latestCheckpointRef.taskRef, metadata.taskRef) ||
    !sameTaskRef(latestCheckpoint.taskRef, metadata.taskRef)
  ) {
    throw new Error(
      'metadata.latestCheckpointRef must identify the aggregate latest checkpoint',
    );
  }
}

function assertTaskCompletionContext(
  metadata: WorkflowMetadataV3,
  context: TaskCompletionContext,
): void {
  if (!Array.isArray(context.activeChildTaskRefs)) {
    throw new Error('task completion activeChildTaskRefs must be an array');
  }
  for (const taskRef of context.activeChildTaskRefs) {
    parseTaskRefValue(taskRef);
  }
  if (context.activeChildTaskRefs.length > 0) {
    throw new Error('task completion requires no active child workflows');
  }
  if (typeof context.hasPendingRepairOperation !== 'boolean') {
    throw new Error(
      'task completion hasPendingRepairOperation must be boolean',
    );
  }
  if (context.hasPendingRepairOperation) {
    throw new Error('task completion requires no pending repair operation');
  }
  if (
    typeof context.activeClaimCount !== 'number' ||
    !Number.isSafeInteger(context.activeClaimCount) ||
    context.activeClaimCount < 0
  ) {
    throw new Error(
      'task completion activeClaimCount must be a non-negative integer',
    );
  }
  if (
    context.claimsWillReleaseOrTransfer !== undefined &&
    typeof context.claimsWillReleaseOrTransfer !== 'boolean'
  ) {
    throw new Error(
      'task completion claimsWillReleaseOrTransfer must be boolean when supplied',
    );
  }
  if (
    metadata.coordination === 'team' &&
    context.activeClaimCount > 0 &&
    context.claimsWillReleaseOrTransfer !== true
  ) {
    throw new Error(
      'team task completion requires active claims to release or transfer in the same operation',
    );
  }
}

function assertSameTaskRef(
  expected: TaskRef,
  actual: TaskRef,
  label: string,
): void {
  if (!sameTaskRef(expected, actual)) {
    throw new Error(`task aggregate ${label} must target the metadata TaskRef`);
  }
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

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseDigestOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  return parseDigest(value, label);
}

function assertDigestOrNull(value: unknown, label: string): void {
  parseDigestOrNull(value, label);
}

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, label);
  return value;
}

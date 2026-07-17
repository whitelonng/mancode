import {
  type ArtifactRef,
  assertReferenceNamespace,
  parseArtifactRef,
} from './artifact-ref.js';
import { digestCanonicalJson } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import { assertSharedTextSafe } from './privacy.js';
import type {
  ItemIdentity,
  RequirementsLedgerV1,
  VerificationRequirement,
} from './requirements-ledger.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type VerificationComponentStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'manual_required'
  | 'blocked';
export type VerificationLedgerStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'stale'
  | 'manual_required'
  | 'blocked';

export interface VerificationLedgerContext {
  requirementsDigest: string;
  planVersion: number;
  remediationRound: number;
}

export interface VerificationComponentEvidence {
  evidenceId: Ulid;
  status: VerificationComponentStatus;
  summary: string | null;
  command: string | null;
  exitCode: number | null;
  artifactRef: ArtifactRef | null;
  confirmedByActorId: Ulid | null;
  confirmationSource: 'actor' | 'legacy_migration' | null;
  updatedAt: string | null;
}

export interface VerificationLedgerV1 {
  schemaVersion: 1;
  canonicalizationVersion: 'mancode-jcs-v1';
  taskRef: TaskRef;
  revision: number;
  status: VerificationLedgerStatus;
  requirementsDigest: string;
  planVersion: number;
  remediationRound: number;
  checks: Array<
    ItemIdentity & {
      checkId: Ulid;
      criterionId: Ulid;
      required: boolean;
      verificationRequirement: VerificationRequirement;
      automated: VerificationComponentEvidence | null;
      manual: VerificationComponentEvidence | null;
    }
  >;
  legacySource: {
    sourceSchema: 'verification-v1';
    sourceDigest: string;
    sourceRequirementsDigest: string;
    fieldMapVersion: 1;
  } | null;
  contentDigest: string;
  lastOperationId: Ulid | null;
  updatedAt: string;
}

const COMPONENT_STATUSES = new Set<VerificationComponentStatus>([
  'pending',
  'passed',
  'failed',
  'manual_required',
  'blocked',
]);
const LEDGER_STATUSES = new Set<VerificationLedgerStatus>([
  'pending',
  'passed',
  'failed',
  'stale',
  'manual_required',
  'blocked',
]);
const VERIFICATION_REQUIREMENTS = new Set<VerificationRequirement>([
  'automated',
  'manual',
  'hybrid',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseVerificationLedger(
  value: unknown,
  requirements?: RequirementsLedgerV1,
): VerificationLedgerV1 {
  assertRecord(value, 'verification ledger');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'canonicalizationVersion',
      'taskRef',
      'revision',
      'status',
      'requirementsDigest',
      'planVersion',
      'remediationRound',
      'checks',
      'legacySource',
      'contentDigest',
      'lastOperationId',
      'updatedAt',
    ],
    'verification ledger',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('verification ledger schemaVersion must be 1');
  }
  if (value.canonicalizationVersion !== 'mancode-jcs-v1') {
    throw new Error('verification ledger canonicalizationVersion is invalid');
  }
  const taskRef = parseTaskRefValue(value.taskRef);
  const ledger: VerificationLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef,
    revision: parsePositiveInteger(
      value.revision,
      'verification ledger revision',
    ),
    status: parseLedgerStatus(value.status),
    requirementsDigest: parseDigest(
      value.requirementsDigest,
      'verification ledger requirementsDigest',
    ),
    planVersion: parsePositiveInteger(
      value.planVersion,
      'verification ledger planVersion',
    ),
    remediationRound: parseNonNegativeInteger(
      value.remediationRound,
      'verification ledger remediationRound',
    ),
    checks: parseChecks(value.checks, taskRef),
    legacySource: parseLegacySource(value.legacySource),
    contentDigest: parseDigest(
      value.contentDigest,
      'verification ledger contentDigest',
    ),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'verification ledger lastOperationId',
    ),
    updatedAt: parseTimestamp(value.updatedAt, 'verification ledger updatedAt'),
  };
  assertVerificationLedgerShape(ledger);
  if (ledger.contentDigest !== verificationLedgerDigest(ledger)) {
    throw new Error(
      'verification ledger contentDigest does not match canonical content',
    );
  }
  assertStoredVerificationStatus(ledger);
  if (requirements !== undefined) {
    assertVerificationLedgerRequirements(ledger, requirements);
  }
  return ledger;
}

export function verificationLedgerDigest(ledger: VerificationLedgerV1): string {
  return digestCanonicalJson({
    schemaVersion: ledger.schemaVersion,
    canonicalizationVersion: ledger.canonicalizationVersion,
    taskRef: ledger.taskRef,
    status: ledger.status,
    requirementsDigest: ledger.requirementsDigest,
    planVersion: ledger.planVersion,
    remediationRound: ledger.remediationRound,
    checks: ledger.checks,
    legacySource: ledger.legacySource,
  });
}

export function deriveVerificationLedgerStatus(
  ledger: VerificationLedgerV1,
  context?: VerificationLedgerContext,
): VerificationLedgerStatus {
  if (context !== undefined && isVerificationStale(ledger, context)) {
    return 'stale';
  }
  const statuses = ledger.checks
    .filter((check) => check.required)
    .flatMap((check) => verificationComponents(check));
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  if (statuses.some((status) => status === 'manual_required')) {
    return 'manual_required';
  }
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'pending')) return 'pending';
  return statuses.length > 0 ? 'passed' : 'pending';
}

export function assertVerificationLedgerAgainstContext(
  ledger: VerificationLedgerV1,
  context: VerificationLedgerContext,
): void {
  parseDigest(
    context.requirementsDigest,
    'verification ledger context requirementsDigest',
  );
  parsePositiveInteger(
    context.planVersion,
    'verification ledger context planVersion',
  );
  parseNonNegativeInteger(
    context.remediationRound,
    'verification ledger context remediationRound',
  );
  const expectedStatus = deriveVerificationLedgerStatus(ledger, context);
  if (ledger.status !== expectedStatus) {
    throw new Error(
      `verification ledger status must be ${expectedStatus} for the current aggregate`,
    );
  }
}

export function assertVerificationLedgerRequirements(
  ledger: VerificationLedgerV1,
  requirements: RequirementsLedgerV1,
): void {
  if (!sameTaskRef(ledger.taskRef, requirements.taskRef)) {
    throw new Error(
      'verification ledger and requirements ledger must target the same task',
    );
  }
  if (ledger.requirementsDigest !== requirements.contentDigest) {
    throw new Error(
      'verification ledger requirementsDigest must match the requirements ledger contentDigest',
    );
  }
  if (ledger.checks.length !== requirements.acceptanceCriteria.length) {
    throw new Error(
      'verification ledger must contain exactly one check per acceptance criterion',
    );
  }
  const criteria = new Map(
    requirements.acceptanceCriteria.map((criterion) => [
      criterion.criterionId,
      criterion,
    ]),
  );
  for (const check of ledger.checks) {
    const criterion = criteria.get(check.criterionId);
    if (criterion === undefined) {
      throw new Error(
        'verification ledger check references an unknown acceptance criterion',
      );
    }
    if (
      check.displayId !== criterion.displayId ||
      check.legacyId !== criterion.legacyId ||
      check.required !== criterion.required ||
      check.verificationRequirement !== criterion.verificationRequirement
    ) {
      throw new Error(
        'verification ledger check must preserve its acceptance criterion identity and requirement',
      );
    }
  }
}

export function assertVerificationLedgerTransition(
  previous: VerificationLedgerV1,
  next: VerificationLedgerV1,
): void {
  if (next.revision !== previous.revision + 1) {
    throw new Error(
      'verification ledger revision must increase exactly once per mutation',
    );
  }
  if (
    previous.schemaVersion !== next.schemaVersion ||
    previous.canonicalizationVersion !== next.canonicalizationVersion ||
    !sameTaskRef(previous.taskRef, next.taskRef)
  ) {
    throw new Error('verification ledger schema and TaskRef are immutable');
  }
  if (next.remediationRound < previous.remediationRound) {
    throw new Error('verification ledger remediationRound cannot decrease');
  }
  if (next.remediationRound > previous.remediationRound + 1) {
    throw new Error(
      'verification ledger remediationRound can increase by at most one',
    );
  }
  if (previous.legacySource === null && next.legacySource !== null) {
    throw new Error('verification ledger cannot introduce a legacy source');
  }
  if (!allowedVerificationTransitions(previous.status).has(next.status)) {
    throw new Error(
      `invalid verification ledger status transition: ${previous.status} -> ${next.status}`,
    );
  }
}

function assertVerificationLedgerShape(ledger: VerificationLedgerV1): void {
  const checkIds = new Set<string>();
  const criterionIds = new Set<string>();
  const displayIds = new Set<string>();
  for (const check of ledger.checks) {
    if (checkIds.has(check.checkId)) {
      throw new Error('verification ledger checkIds must be unique');
    }
    if (criterionIds.has(check.criterionId)) {
      throw new Error('verification ledger criterionIds must be unique');
    }
    if (displayIds.has(check.displayId)) {
      throw new Error('verification ledger displayIds must be unique');
    }
    checkIds.add(check.checkId);
    criterionIds.add(check.criterionId);
    displayIds.add(check.displayId);
  }
}

function assertStoredVerificationStatus(ledger: VerificationLedgerV1): void {
  if (ledger.status === 'stale') return;
  const expectedStatus = deriveVerificationLedgerStatus(ledger);
  if (ledger.status !== expectedStatus) {
    throw new Error(
      `verification ledger status must be derived as ${expectedStatus} from its required evidence`,
    );
  }
}

function isVerificationStale(
  ledger: VerificationLedgerV1,
  context: VerificationLedgerContext,
): boolean {
  return (
    ledger.requirementsDigest !== context.requirementsDigest ||
    ledger.planVersion !== context.planVersion ||
    ledger.remediationRound !== context.remediationRound
  );
}

function parseLedgerStatus(value: unknown): VerificationLedgerStatus {
  if (
    typeof value !== 'string' ||
    !LEDGER_STATUSES.has(value as VerificationLedgerStatus)
  ) {
    throw new Error('verification ledger status is invalid');
  }
  return value as VerificationLedgerStatus;
}

function parseChecks(
  value: unknown,
  taskRef: TaskRef,
): VerificationLedgerV1['checks'] {
  if (!Array.isArray(value)) {
    throw new Error('verification ledger checks must be an array');
  }
  return value.map((item) => {
    const identity = parseItemIdentity(item, 'verification ledger check');
    assertRecord(item, 'verification ledger check');
    assertKnownKeys(
      item,
      [
        'displayId',
        'legacyId',
        'checkId',
        'criterionId',
        'required',
        'verificationRequirement',
        'automated',
        'manual',
      ],
      'verification ledger check',
    );
    assertUlid(item.checkId, 'verification ledger checkId');
    assertUlid(item.criterionId, 'verification ledger criterionId');
    if (typeof item.required !== 'boolean') {
      throw new Error('verification ledger check required must be boolean');
    }
    if (
      typeof item.verificationRequirement !== 'string' ||
      !VERIFICATION_REQUIREMENTS.has(
        item.verificationRequirement as VerificationRequirement,
      )
    ) {
      throw new Error(
        'verification ledger check verificationRequirement is invalid',
      );
    }
    const verificationRequirement =
      item.verificationRequirement as VerificationRequirement;
    const automated = parseEvidence(item.automated, taskRef, 'automated');
    const manual = parseEvidence(item.manual, taskRef, 'manual');
    assertVerificationSlots(verificationRequirement, automated, manual);
    return {
      ...identity,
      checkId: item.checkId,
      criterionId: item.criterionId,
      required: item.required,
      verificationRequirement,
      automated,
      manual,
    };
  });
}

function assertVerificationSlots(
  requirement: VerificationRequirement,
  automated: VerificationComponentEvidence | null,
  manual: VerificationComponentEvidence | null,
): void {
  if (requirement === 'automated' && (automated === null || manual !== null)) {
    throw new Error(
      'automated acceptance criteria require only an automated evidence slot',
    );
  }
  if (requirement === 'manual' && (automated !== null || manual === null)) {
    throw new Error(
      'manual acceptance criteria require only a manual evidence slot',
    );
  }
  if (requirement === 'hybrid' && (automated === null || manual === null)) {
    throw new Error(
      'hybrid acceptance criteria require both automated and manual evidence slots',
    );
  }
}

function parseEvidence(
  value: unknown,
  taskRef: TaskRef,
  kind: 'automated' | 'manual',
): VerificationComponentEvidence | null {
  if (value === null) return null;
  assertRecord(value, `verification ledger ${kind} evidence`);
  assertKnownKeys(
    value,
    [
      'evidenceId',
      'status',
      'summary',
      'command',
      'exitCode',
      'artifactRef',
      'confirmedByActorId',
      'confirmationSource',
      'updatedAt',
    ],
    `verification ledger ${kind} evidence`,
  );
  assertUlid(value.evidenceId, `verification ledger ${kind} evidenceId`);
  if (
    typeof value.status !== 'string' ||
    !COMPONENT_STATUSES.has(value.status as VerificationComponentStatus)
  ) {
    throw new Error(`verification ledger ${kind} evidence status is invalid`);
  }
  const status = value.status as VerificationComponentStatus;
  if (kind === 'automated' && status === 'manual_required') {
    throw new Error('automated evidence cannot be manual_required');
  }
  if (
    value.confirmationSource !== null &&
    value.confirmationSource !== 'actor' &&
    value.confirmationSource !== 'legacy_migration'
  ) {
    throw new Error(
      `verification ledger ${kind} confirmationSource is invalid`,
    );
  }
  const confirmedByActorId = parseUlidOrNull(
    value.confirmedByActorId,
    `verification ledger ${kind} confirmedByActorId`,
  );
  const confirmationSource = value.confirmationSource;
  if (confirmationSource === 'actor' && confirmedByActorId === null) {
    throw new Error(
      `verification ledger ${kind} actor confirmation requires an actor`,
    );
  }
  if (confirmationSource === null && confirmedByActorId !== null) {
    throw new Error(
      `verification ledger ${kind} confirmation source is required for an actor`,
    );
  }
  if (
    confirmationSource === 'legacy_migration' &&
    confirmedByActorId !== null
  ) {
    throw new Error(
      `verification ledger ${kind} legacy confirmation cannot invent an actor`,
    );
  }
  if (kind === 'automated' && confirmedByActorId !== null) {
    throw new Error('automated evidence cannot contain manual confirmation');
  }
  if (kind === 'manual' && status === 'passed' && confirmationSource === null) {
    throw new Error('passed manual evidence requires an explicit confirmation');
  }
  if (kind === 'manual' && status !== 'passed' && confirmationSource !== null) {
    throw new Error('only passed manual evidence may contain a confirmation');
  }
  const summary = parseNonEmptyStringOrNull(
    value.summary,
    `verification ledger ${kind} evidence summary`,
  );
  const command = parseNonEmptyStringOrNull(
    value.command,
    `verification ledger ${kind} evidence command`,
  );
  if (taskRef.namespace === 'shared') {
    if (summary !== null) {
      assertSharedTextSafe(
        summary,
        `verification ledger ${kind} evidence summary`,
      );
    }
    if (command !== null) {
      assertSharedTextSafe(
        command,
        `verification ledger ${kind} evidence command`,
      );
    }
  }
  return {
    evidenceId: value.evidenceId,
    status,
    summary,
    command,
    exitCode: parseExitCodeOrNull(
      value.exitCode,
      `verification ledger ${kind} evidence exitCode`,
    ),
    artifactRef:
      value.artifactRef === null
        ? null
        : parseEvidenceArtifactRef(value.artifactRef, taskRef),
    confirmedByActorId,
    confirmationSource,
    updatedAt:
      value.updatedAt === null
        ? null
        : parseTimestamp(
            value.updatedAt,
            `verification ledger ${kind} evidence updatedAt`,
          ),
  };
}

function parseEvidenceArtifactRef(
  value: unknown,
  taskRef: TaskRef,
): ArtifactRef {
  const artifactRef = parseArtifactRef(value);
  assertReferenceNamespace(taskRef.namespace, artifactRef);
  if (
    artifactRef.kind !== 'evidence_summary' ||
    !sameTaskRef(artifactRef.taskRef, taskRef)
  ) {
    throw new Error(
      'verification evidence artifactRef must be an evidence_summary for the same task',
    );
  }
  return artifactRef;
}

function parseLegacySource(
  value: unknown,
): VerificationLedgerV1['legacySource'] {
  if (value === null) return null;
  assertRecord(value, 'verification ledger legacySource');
  assertKnownKeys(
    value,
    [
      'sourceSchema',
      'sourceDigest',
      'sourceRequirementsDigest',
      'fieldMapVersion',
    ],
    'verification ledger legacySource',
  );
  if (value.sourceSchema !== 'verification-v1' || value.fieldMapVersion !== 1) {
    throw new Error('verification ledger legacySource is invalid');
  }
  return {
    sourceSchema: 'verification-v1',
    sourceDigest: parseDigest(
      value.sourceDigest,
      'verification ledger legacySource sourceDigest',
    ),
    sourceRequirementsDigest: parseDigest(
      value.sourceRequirementsDigest,
      'verification ledger legacySource sourceRequirementsDigest',
    ),
    fieldMapVersion: 1,
  };
}

function verificationComponents(
  check: VerificationLedgerV1['checks'][number],
): VerificationComponentStatus[] {
  return [check.automated, check.manual]
    .filter(
      (component): component is VerificationComponentEvidence =>
        component !== null,
    )
    .map((component) => component.status);
}

function allowedVerificationTransitions(
  status: VerificationLedgerStatus,
): Set<VerificationLedgerStatus> {
  switch (status) {
    case 'pending':
      return new Set([
        'pending',
        'passed',
        'failed',
        'manual_required',
        'blocked',
        'stale',
      ]);
    case 'passed':
      return new Set(['passed', 'stale']);
    case 'failed':
      return new Set([
        'failed',
        'pending',
        'passed',
        'manual_required',
        'blocked',
        'stale',
      ]);
    case 'manual_required':
      return new Set([
        'manual_required',
        'passed',
        'failed',
        'blocked',
        'stale',
      ]);
    case 'blocked':
      return new Set([
        'blocked',
        'pending',
        'passed',
        'failed',
        'manual_required',
        'stale',
      ]);
    case 'stale':
      return new Set([
        'stale',
        'pending',
        'passed',
        'failed',
        'manual_required',
        'blocked',
      ]);
  }
}

function parseItemIdentity(value: unknown, label: string): ItemIdentity {
  assertRecord(value, label);
  if (typeof value.displayId !== 'string' || !value.displayId.trim()) {
    throw new Error(`${label} displayId is required`);
  }
  if (
    value.legacyId !== null &&
    (typeof value.legacyId !== 'string' || !value.legacyId.trim())
  ) {
    throw new Error(`${label} legacyId must be a non-empty string or null`);
  }
  return { displayId: value.displayId, legacyId: value.legacyId };
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

function parseExitCodeOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer or null`);
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, label);
  return value;
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

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

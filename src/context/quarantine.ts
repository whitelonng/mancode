import path from 'node:path';
import { digestCanonicalJson } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import {
  type SharedPrivacyFindingKind,
  assertSafeSharedRelativePath,
  scanSharedText,
} from './privacy.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type QuarantinePurpose =
  | 'legacy_migration'
  | 'publish_promote'
  | 'transport_pull';
export type QuarantineStage =
  | 'staged'
  | 'path_validated'
  | 'privacy_scanned'
  | 'privacy_blocked'
  | 'previewed'
  | 'confirmed'
  | 'promoted';
export type QuarantineArtifactClass =
  | 'authority'
  | 'human_view'
  | 'raw_evidence'
  | 'session'
  | 'overlay';

export interface QuarantineArtifact {
  relativePath: string;
  classification: QuarantineArtifactClass;
  includeInPromotion: boolean;
  contentDigest: string | null;
}

export interface QuarantinePrivacySummary {
  status: 'pending' | 'passed' | 'blocked';
  findings: Array<{ kind: SharedPrivacyFindingKind; count: number }>;
}

/**
 * A local-only candidate. It never has a shared destination TaskRef, so a
 * migration or promote flow cannot accidentally skip privacy preflight.
 */
export interface QuarantineCandidateV1 {
  schemaVersion: 1;
  quarantineId: Ulid;
  purpose: QuarantinePurpose;
  sourceTaskRef: TaskRef | null;
  candidateTaskRef: TaskRef;
  stage: QuarantineStage;
  artifacts: QuarantineArtifact[];
  privacy: QuarantinePrivacySummary;
  previewDigest: string | null;
  confirmedByActorId: Ulid | null;
  confirmedAt: string | null;
  promotionOperationId: Ulid | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateQuarantineCandidateInput {
  quarantineId: Ulid;
  purpose: QuarantinePurpose;
  sourceTaskRef: TaskRef | null;
  candidateTaskRef: TaskRef;
  artifacts: QuarantineArtifact[];
  now?: Date;
}

export interface PromotionFromQuarantinePlanV1 {
  schemaVersion: 1;
  operationId: Ulid;
  quarantineId: Ulid;
  sourceTaskRef: TaskRef;
  destinationTaskRef: TaskRef;
  previewDigest: string;
  confirmedByActorId: Ulid;
  includedArtifacts: QuarantineArtifact[];
  omittedArtifacts: QuarantineArtifact[];
}

const PURPOSES = new Set<QuarantinePurpose>([
  'legacy_migration',
  'publish_promote',
  'transport_pull',
]);
const STAGES = new Set<QuarantineStage>([
  'staged',
  'path_validated',
  'privacy_scanned',
  'privacy_blocked',
  'previewed',
  'confirmed',
  'promoted',
]);
const ARTIFACT_CLASSES = new Set<QuarantineArtifactClass>([
  'authority',
  'human_view',
  'raw_evidence',
  'session',
  'overlay',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function createQuarantineCandidate(
  input: CreateQuarantineCandidateInput,
): QuarantineCandidateV1 {
  assertUlid(input.quarantineId, 'quarantineId');
  const candidateTaskRef = parseTaskRefValue(input.candidateTaskRef);
  if (candidateTaskRef.namespace !== 'local') {
    throw new Error('MANCODE_QUARANTINE_CANDIDATE_MUST_BE_LOCAL');
  }
  const sourceTaskRef =
    input.sourceTaskRef === null
      ? null
      : parseTaskRefValue(input.sourceTaskRef);
  assertSourcePlacement(input.purpose, sourceTaskRef, candidateTaskRef);
  const now = (input.now ?? new Date()).toISOString();
  return parseQuarantineCandidate({
    schemaVersion: 1,
    quarantineId: input.quarantineId,
    purpose: input.purpose,
    sourceTaskRef,
    candidateTaskRef,
    stage: 'staged',
    artifacts: input.artifacts,
    privacy: { status: 'pending', findings: [] },
    previewDigest: null,
    confirmedByActorId: null,
    confirmedAt: null,
    promotionOperationId: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function validateQuarantinePaths(
  candidate: QuarantineCandidateV1,
  now: Date = new Date(),
): QuarantineCandidateV1 {
  const parsed = parseQuarantineCandidate(candidate);
  requireStage(parsed, 'staged');
  return parseQuarantineCandidate({
    ...parsed,
    stage: 'path_validated',
    updatedAt: now.toISOString(),
  });
}

/**
 * Inspects candidate content without retaining any raw text in the manifest.
 * A blocked scan cannot be silently redacted and advanced; the user must
 * change the local candidate and start a new scan.
 */
export function scanQuarantineCandidate(
  candidate: QuarantineCandidateV1,
  content: readonly string[],
  now: Date = new Date(),
): QuarantineCandidateV1 {
  const parsed = parseQuarantineCandidate(candidate);
  requireStage(parsed, 'path_validated');
  if (
    !Array.isArray(content) ||
    content.some((item) => typeof item !== 'string')
  ) {
    throw new Error('quarantine scan content must be strings');
  }
  const findings = summarizePrivacyFindings(content);
  return parseQuarantineCandidate({
    ...parsed,
    stage: findings.length === 0 ? 'privacy_scanned' : 'privacy_blocked',
    privacy: {
      status: findings.length === 0 ? 'passed' : 'blocked',
      findings,
    },
    updatedAt: now.toISOString(),
  });
}

export function previewQuarantineCandidate(
  candidate: QuarantineCandidateV1,
  now: Date = new Date(),
): QuarantineCandidateV1 {
  const parsed = parseQuarantineCandidate(candidate);
  if (parsed.stage === 'privacy_blocked') {
    throw new Error('MANCODE_PRIVACY_BLOCKED');
  }
  requireStage(parsed, 'privacy_scanned');
  const previewDigest = digestCanonicalJson({
    candidateTaskRef: parsed.candidateTaskRef,
    artifacts: parsed.artifacts,
  });
  return parseQuarantineCandidate({
    ...parsed,
    stage: 'previewed',
    previewDigest,
    updatedAt: now.toISOString(),
  });
}

export function confirmQuarantineCandidate(
  candidate: QuarantineCandidateV1,
  actorId: Ulid,
  now: Date = new Date(),
): QuarantineCandidateV1 {
  const parsed = parseQuarantineCandidate(candidate);
  requireStage(parsed, 'previewed');
  assertUlid(actorId, 'quarantine confirmation actorId');
  return parseQuarantineCandidate({
    ...parsed,
    stage: 'confirmed',
    confirmedByActorId: actorId,
    confirmedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}

/**
 * Produces the journal input after user confirmation. It does not promote or
 * mutate the candidate yet; the caller must use the returned operationId as
 * the durable operation journal identity.
 */
export function preparePromotionFromQuarantine(
  candidate: QuarantineCandidateV1,
  destinationTaskRef: TaskRef,
  operationId: Ulid,
): PromotionFromQuarantinePlanV1 {
  const parsed = parseQuarantineCandidate(candidate);
  if (parsed.stage === 'privacy_blocked')
    throw new Error('MANCODE_PRIVACY_BLOCKED');
  requireStage(parsed, 'confirmed');
  const destination = parseTaskRefValue(destinationTaskRef);
  assertUlid(operationId, 'promotion operationId');
  if (destination.namespace !== 'shared') {
    throw new Error('MANCODE_PROMOTION_DESTINATION_MUST_BE_SHARED');
  }
  if (
    parsed.previewDigest === null ||
    parsed.confirmedByActorId === null ||
    parsed.confirmedAt === null
  ) {
    throw new Error('MANCODE_PROMOTION_CONFIRMATION_REQUIRED');
  }
  const includedArtifacts = parsed.artifacts.filter(
    (artifact) => artifact.includeInPromotion,
  );
  const omittedArtifacts = parsed.artifacts.filter(
    (artifact) => !artifact.includeInPromotion,
  );
  return {
    schemaVersion: 1,
    operationId,
    quarantineId: parsed.quarantineId,
    sourceTaskRef: parsed.candidateTaskRef,
    destinationTaskRef: destination,
    previewDigest: parsed.previewDigest,
    confirmedByActorId: parsed.confirmedByActorId,
    includedArtifacts,
    omittedArtifacts,
  };
}

export function markQuarantinePromoted(
  candidate: QuarantineCandidateV1,
  promotion: PromotionFromQuarantinePlanV1,
  now: Date = new Date(),
): QuarantineCandidateV1 {
  const parsed = parseQuarantineCandidate(candidate);
  requireStage(parsed, 'confirmed');
  assertUlid(promotion.operationId, 'promotion operationId');
  const sourceTaskRef = parseTaskRefValue(promotion.sourceTaskRef);
  const destinationTaskRef = parseTaskRefValue(promotion.destinationTaskRef);
  if (
    promotion.quarantineId !== parsed.quarantineId ||
    !sameTaskRef(sourceTaskRef, parsed.candidateTaskRef) ||
    destinationTaskRef.namespace !== 'shared' ||
    promotion.previewDigest !== parsed.previewDigest ||
    promotion.confirmedByActorId !== parsed.confirmedByActorId ||
    promotion.confirmedByActorId === null
  ) {
    throw new Error('MANCODE_PROMOTION_PLAN_MISMATCH');
  }
  return parseQuarantineCandidate({
    ...parsed,
    stage: 'promoted',
    promotionOperationId: promotion.operationId,
    updatedAt: now.toISOString(),
  });
}

export function quarantineDirectory(
  projectRoot: string,
  quarantineId: string,
): string {
  assertUlid(quarantineId, 'quarantineId');
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'quarantine',
    quarantineId,
  );
}

export function publishStagingDirectory(
  projectRoot: string,
  operationId: string,
): string {
  assertUlid(operationId, 'promotion operationId');
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'publish',
    operationId,
  );
}

export function parseQuarantineCandidate(
  value: unknown,
): QuarantineCandidateV1 {
  assertRecord(value, 'quarantine candidate');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'quarantineId',
      'purpose',
      'sourceTaskRef',
      'candidateTaskRef',
      'stage',
      'artifacts',
      'privacy',
      'previewDigest',
      'confirmedByActorId',
      'confirmedAt',
      'promotionOperationId',
      'createdAt',
      'updatedAt',
    ],
    'quarantine candidate',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('quarantine candidate schemaVersion must be 1');
  }
  assertUlid(value.quarantineId, 'quarantine candidate quarantineId');
  if (
    typeof value.purpose !== 'string' ||
    !PURPOSES.has(value.purpose as QuarantinePurpose)
  ) {
    throw new Error('quarantine candidate purpose is invalid');
  }
  if (
    typeof value.stage !== 'string' ||
    !STAGES.has(value.stage as QuarantineStage)
  ) {
    throw new Error('quarantine candidate stage is invalid');
  }
  const candidate: QuarantineCandidateV1 = {
    schemaVersion: 1,
    quarantineId: value.quarantineId,
    purpose: value.purpose as QuarantinePurpose,
    sourceTaskRef:
      value.sourceTaskRef === null
        ? null
        : parseTaskRefValue(value.sourceTaskRef),
    candidateTaskRef: parseTaskRefValue(value.candidateTaskRef),
    stage: value.stage as QuarantineStage,
    artifacts: parseArtifacts(value.artifacts),
    privacy: parsePrivacy(value.privacy),
    previewDigest: parseDigestOrNull(
      value.previewDigest,
      'quarantine candidate previewDigest',
    ),
    confirmedByActorId: parseUlidOrNull(
      value.confirmedByActorId,
      'quarantine candidate confirmedByActorId',
    ),
    confirmedAt: parseTimestampOrNull(
      value.confirmedAt,
      'quarantine candidate confirmedAt',
    ),
    promotionOperationId: parseUlidOrNull(
      value.promotionOperationId,
      'quarantine candidate promotionOperationId',
    ),
    createdAt: parseTimestamp(
      value.createdAt,
      'quarantine candidate createdAt',
    ),
    updatedAt: parseTimestamp(
      value.updatedAt,
      'quarantine candidate updatedAt',
    ),
  };
  if (candidate.candidateTaskRef.namespace !== 'local') {
    throw new Error('MANCODE_QUARANTINE_CANDIDATE_MUST_BE_LOCAL');
  }
  assertSourcePlacement(
    candidate.purpose,
    candidate.sourceTaskRef,
    candidate.candidateTaskRef,
  );
  assertCandidateShape(candidate);
  return candidate;
}

function assertSourcePlacement(
  purpose: QuarantinePurpose,
  sourceTaskRef: TaskRef | null,
  candidateTaskRef: TaskRef,
): void {
  if (purpose === 'legacy_migration' && sourceTaskRef !== null) {
    throw new Error(
      'legacy migration quarantine cannot claim a V3 source TaskRef',
    );
  }
  if (purpose === 'publish_promote') {
    if (
      sourceTaskRef === null ||
      sourceTaskRef.namespace !== 'local' ||
      sourceTaskRef.taskId !== candidateTaskRef.taskId
    ) {
      throw new Error(
        'publish quarantine must stage its matching local TaskRef',
      );
    }
  }
  if (purpose === 'transport_pull' && sourceTaskRef?.namespace !== 'shared') {
    throw new Error(
      'transport pull quarantine must identify a shared source TaskRef',
    );
  }
}

function parseArtifacts(value: unknown): QuarantineArtifact[] {
  if (!Array.isArray(value))
    throw new Error('quarantine artifacts must be an array');
  const paths = new Set<string>();
  return value.map((item) => {
    assertRecord(item, 'quarantine artifact');
    assertKnownKeys(
      item,
      ['relativePath', 'classification', 'includeInPromotion', 'contentDigest'],
      'quarantine artifact',
    );
    const relativePath = assertSafeSharedRelativePath(
      item.relativePath as string,
    );
    if (paths.has(relativePath)) {
      throw new Error('quarantine artifacts must not repeat a relativePath');
    }
    paths.add(relativePath);
    if (
      typeof item.classification !== 'string' ||
      !ARTIFACT_CLASSES.has(item.classification as QuarantineArtifactClass)
    ) {
      throw new Error('quarantine artifact classification is invalid');
    }
    if (typeof item.includeInPromotion !== 'boolean') {
      throw new Error('quarantine artifact includeInPromotion must be boolean');
    }
    const classification = item.classification as QuarantineArtifactClass;
    if (
      (classification === 'raw_evidence' ||
        classification === 'session' ||
        classification === 'overlay') &&
      item.includeInPromotion
    ) {
      throw new Error('MANCODE_RAW_ARTIFACT_CANNOT_BE_PROMOTED');
    }
    return {
      relativePath,
      classification,
      includeInPromotion: item.includeInPromotion,
      contentDigest: parseDigestOrNull(
        item.contentDigest,
        'quarantine artifact contentDigest',
      ),
    };
  });
}

function parsePrivacy(value: unknown): QuarantinePrivacySummary {
  assertRecord(value, 'quarantine privacy');
  assertKnownKeys(value, ['status', 'findings'], 'quarantine privacy');
  if (
    value.status !== 'pending' &&
    value.status !== 'passed' &&
    value.status !== 'blocked'
  ) {
    throw new Error('quarantine privacy status is invalid');
  }
  if (!Array.isArray(value.findings)) {
    throw new Error('quarantine privacy findings must be an array');
  }
  const kinds = new Set<SharedPrivacyFindingKind>();
  const findings = value.findings.map((finding) => {
    assertRecord(finding, 'quarantine privacy finding');
    assertKnownKeys(finding, ['kind', 'count'], 'quarantine privacy finding');
    if (!isPrivacyFindingKind(finding.kind) || kinds.has(finding.kind)) {
      throw new Error('quarantine privacy finding kind is invalid');
    }
    if (
      typeof finding.count !== 'number' ||
      !Number.isSafeInteger(finding.count) ||
      finding.count < 1
    ) {
      throw new Error('quarantine privacy finding count is invalid');
    }
    kinds.add(finding.kind);
    return { kind: finding.kind, count: finding.count };
  });
  return { status: value.status, findings };
}

function assertCandidateShape(candidate: QuarantineCandidateV1): void {
  const isPending =
    candidate.stage === 'staged' || candidate.stage === 'path_validated';
  if (
    isPending &&
    (candidate.privacy.status !== 'pending' ||
      candidate.privacy.findings.length > 0)
  ) {
    throw new Error(
      'pending quarantine stages require an empty pending privacy scan',
    );
  }
  if (
    candidate.stage === 'privacy_scanned' &&
    (candidate.privacy.status !== 'passed' ||
      candidate.privacy.findings.length > 0)
  ) {
    throw new Error('privacy_scanned quarantine requires a clean scan');
  }
  if (
    candidate.stage === 'privacy_blocked' &&
    (candidate.privacy.status !== 'blocked' ||
      candidate.privacy.findings.length === 0)
  ) {
    throw new Error('privacy_blocked quarantine requires findings');
  }
  const needsPreview =
    candidate.stage === 'previewed' ||
    candidate.stage === 'confirmed' ||
    candidate.stage === 'promoted';
  if (
    needsPreview &&
    (candidate.privacy.status !== 'passed' || candidate.previewDigest === null)
  ) {
    throw new Error('previewed quarantine requires a clean preview digest');
  }
  if (!needsPreview && candidate.previewDigest !== null) {
    throw new Error('unpreviewed quarantine cannot carry a preview digest');
  }
  const needsConfirmation =
    candidate.stage === 'confirmed' || candidate.stage === 'promoted';
  if (
    needsConfirmation &&
    (candidate.confirmedByActorId === null || candidate.confirmedAt === null)
  ) {
    throw new Error('confirmed quarantine requires actor confirmation');
  }
  if (
    candidate.stage === 'promoted' &&
    candidate.promotionOperationId === null
  ) {
    throw new Error('promoted quarantine requires promotionOperationId');
  }
  if (!needsConfirmation && candidate.confirmedByActorId !== null) {
    throw new Error('unconfirmed quarantine cannot carry confirmedByActorId');
  }
  if (!needsConfirmation && candidate.confirmedAt !== null) {
    throw new Error('unconfirmed quarantine cannot carry confirmedAt');
  }
  if (
    candidate.stage !== 'promoted' &&
    candidate.promotionOperationId !== null
  ) {
    throw new Error('unpromoted quarantine cannot carry promotionOperationId');
  }
}

function requireStage(
  candidate: QuarantineCandidateV1,
  expected: QuarantineStage,
): void {
  if (candidate.stage !== expected) {
    throw new Error(`MANCODE_QUARANTINE_STAGE_INVALID: expected ${expected}`);
  }
}

function summarizePrivacyFindings(
  content: readonly string[],
): QuarantinePrivacySummary['findings'] {
  const counts = new Map<SharedPrivacyFindingKind, number>();
  for (const value of content) {
    for (const finding of scanSharedText(value)) {
      counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([kind, count]) => ({ kind, count }));
}

function isPrivacyFindingKind(
  value: unknown,
): value is SharedPrivacyFindingKind {
  return (
    value === 'authorization' ||
    value === 'cookie' ||
    value === 'private_key' ||
    value === 'secret' ||
    value === 'absolute_path' ||
    value === 'email'
  );
}

function parseDigestOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest or null`);
  }
  return value;
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

import {
  type ArtifactRef,
  assertReferenceNamespace,
  parseArtifactRef,
} from './artifact-ref.js';
import { digestCanonicalJson, sortUtf8StringSet } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import { assertSharedTextSafe } from './privacy.js';
import type { ItemIdentity } from './requirements-ledger.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type ReviewDomain = 'quality' | 'security';
export type ReviewLedgerStatus =
  | 'pending'
  | 'in_review'
  | 'passed'
  | 'blocked'
  | 'skipped'
  | 'stale';
export type ReviewDomainStatus =
  | 'pending'
  | 'passed'
  | 'blocked'
  | 'manual_required'
  | 'skipped';
export type ReviewBlockerSeverity = 'p0' | 'p1' | 'p2' | 'legacy_unknown';
export type ReviewBlockerStatus = 'open' | 'resolved' | 'waived';

export interface ReviewLedgerContext {
  requirementsDigest: string;
  planVersion: number;
}

export interface ReviewLedgerV1 {
  schemaVersion: 1;
  canonicalizationVersion: 'mancode-jcs-v1';
  taskRef: TaskRef;
  revision: number;
  status: ReviewLedgerStatus;
  depth: 'targeted' | 'full';
  requirementsDigest: string | null;
  planVersion: number | null;
  requiredDomains: ReviewDomain[];
  domains: Array<{
    domain: ReviewDomain;
    status: ReviewDomainStatus;
    reportRef: ArtifactRef | null;
  }>;
  blockers: Array<
    ItemIdentity & {
      blockerId: Ulid;
      domain: ReviewDomain;
      severity: ReviewBlockerSeverity;
      status: ReviewBlockerStatus;
      summary: string | null;
      waiver: {
        reason: string;
        approvedByActorId: Ulid;
        approvedAt: string;
      } | null;
    }
  >;
  remediationRound: number;
  skip: {
    reason: string;
    approvedByActorId: Ulid | null;
    approvedAt: string;
    source: 'actor' | 'legacy_migration';
  } | null;
  legacySource: {
    sourceSchema: 'review-ledger-1.0';
    sourceDigest: string;
    sourceRequirementsDigest: string | null;
    fieldMapVersion: 1;
  } | null;
  contentDigest: string;
  lastOperationId: Ulid | null;
  updatedAt: string;
}

const REVIEW_DOMAINS = new Set<ReviewDomain>(['quality', 'security']);
const REVIEW_STATUSES = new Set<ReviewLedgerStatus>([
  'pending',
  'in_review',
  'passed',
  'blocked',
  'skipped',
  'stale',
]);
const DOMAIN_STATUSES = new Set<ReviewDomainStatus>([
  'pending',
  'passed',
  'blocked',
  'manual_required',
  'skipped',
]);
const BLOCKER_SEVERITIES = new Set<ReviewBlockerSeverity>([
  'p0',
  'p1',
  'p2',
  'legacy_unknown',
]);
const BLOCKER_STATUSES = new Set<ReviewBlockerStatus>([
  'open',
  'resolved',
  'waived',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseReviewLedger(value: unknown): ReviewLedgerV1 {
  assertRecord(value, 'review ledger');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'canonicalizationVersion',
      'taskRef',
      'revision',
      'status',
      'depth',
      'requirementsDigest',
      'planVersion',
      'requiredDomains',
      'domains',
      'blockers',
      'remediationRound',
      'skip',
      'legacySource',
      'contentDigest',
      'lastOperationId',
      'updatedAt',
    ],
    'review ledger',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('review ledger schemaVersion must be 1');
  }
  if (value.canonicalizationVersion !== 'mancode-jcs-v1') {
    throw new Error('review ledger canonicalizationVersion is invalid');
  }
  if (value.depth !== 'targeted' && value.depth !== 'full') {
    throw new Error('review ledger depth is invalid');
  }
  const taskRef = parseTaskRefValue(value.taskRef);
  const ledger: ReviewLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef,
    revision: parsePositiveInteger(value.revision, 'review ledger revision'),
    status: parseReviewStatus(value.status),
    depth: value.depth,
    requirementsDigest: parseDigestOrNull(
      value.requirementsDigest,
      'review ledger requirementsDigest',
    ),
    planVersion: parsePositiveIntegerOrNull(
      value.planVersion,
      'review ledger planVersion',
    ),
    requiredDomains: parseReviewDomainSet(
      value.requiredDomains,
      'review ledger requiredDomains',
    ),
    domains: parseDomains(value.domains, taskRef),
    blockers: parseBlockers(value.blockers, taskRef),
    remediationRound: parseNonNegativeInteger(
      value.remediationRound,
      'review ledger remediationRound',
    ),
    skip: parseSkip(value.skip, taskRef),
    legacySource: parseLegacySource(value.legacySource),
    contentDigest: parseDigest(
      value.contentDigest,
      'review ledger contentDigest',
    ),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'review ledger lastOperationId',
    ),
    updatedAt: parseTimestamp(value.updatedAt, 'review ledger updatedAt'),
  };
  assertReviewLedgerShape(ledger);
  if (ledger.contentDigest !== reviewLedgerDigest(ledger)) {
    throw new Error(
      'review ledger contentDigest does not match canonical content',
    );
  }
  assertStoredReviewStatus(ledger);
  return ledger;
}

export function reviewLedgerDigest(ledger: ReviewLedgerV1): string {
  return digestCanonicalJson({
    schemaVersion: ledger.schemaVersion,
    canonicalizationVersion: ledger.canonicalizationVersion,
    taskRef: ledger.taskRef,
    status: ledger.status,
    depth: ledger.depth,
    requirementsDigest: ledger.requirementsDigest,
    planVersion: ledger.planVersion,
    requiredDomains: ledger.requiredDomains,
    domains: ledger.domains,
    blockers: ledger.blockers,
    remediationRound: ledger.remediationRound,
    skip: ledger.skip,
    legacySource: ledger.legacySource,
  });
}

export function deriveReviewLedgerStatus(
  ledger: ReviewLedgerV1,
  context?: ReviewLedgerContext,
): ReviewLedgerStatus {
  if (context !== undefined && isReviewStale(ledger, context)) return 'stale';
  if (ledger.skip !== null) return 'skipped';
  if (
    ledger.blockers.some((blocker) => blocker.status === 'open') ||
    ledger.domains.some((domain) => domain.status === 'blocked')
  ) {
    return 'blocked';
  }
  if (ledger.domains.every((domain) => domain.status === 'passed')) {
    return 'passed';
  }
  if (ledger.domains.every((domain) => domain.status === 'pending')) {
    return 'pending';
  }
  return 'in_review';
}

export function assertReviewLedgerAgainstContext(
  ledger: ReviewLedgerV1,
  context: ReviewLedgerContext,
): void {
  parseDigest(
    context.requirementsDigest,
    'review ledger context requirementsDigest',
  );
  parsePositiveInteger(
    context.planVersion,
    'review ledger context planVersion',
  );
  if (ledger.legacySource !== null && hasLegacyCompatibilityGap(ledger)) {
    throw new Error(
      'legacy review ledger with missing requirementsDigest or planVersion requires the legacy compatibility gate',
    );
  }
  const expectedStatus = deriveReviewLedgerStatus(ledger, context);
  if (ledger.status !== expectedStatus) {
    throw new Error(
      `review ledger status must be ${expectedStatus} for the current aggregate`,
    );
  }
}

export function assertReviewLedgerTransition(
  previous: ReviewLedgerV1,
  next: ReviewLedgerV1,
): void {
  if (next.revision !== previous.revision + 1) {
    throw new Error(
      'review ledger revision must increase exactly once per mutation',
    );
  }
  if (
    previous.schemaVersion !== next.schemaVersion ||
    previous.canonicalizationVersion !== next.canonicalizationVersion ||
    !sameTaskRef(previous.taskRef, next.taskRef)
  ) {
    throw new Error('review ledger schema and TaskRef are immutable');
  }
  if (next.remediationRound < previous.remediationRound) {
    throw new Error('review ledger remediationRound cannot decrease');
  }
  if (next.remediationRound > previous.remediationRound + 1) {
    throw new Error(
      'review ledger remediationRound can increase by at most one',
    );
  }
  if (previous.legacySource === null && next.legacySource !== null) {
    throw new Error('review ledger cannot introduce a legacy source');
  }
  if (!allowedReviewTransitions(previous.status).has(next.status)) {
    throw new Error(
      `invalid review ledger status transition: ${previous.status} -> ${next.status}`,
    );
  }
}

function assertReviewLedgerShape(ledger: ReviewLedgerV1): void {
  assertUniqueBlockerIdentity(ledger.blockers);
  if (ledger.legacySource === null) {
    if (ledger.requirementsDigest === null || ledger.planVersion === null) {
      throw new Error(
        'native review ledger requires requirementsDigest and planVersion',
      );
    }
  }
  if (ledger.skip !== null) {
    if (
      ledger.requiredDomains.length !== 0 ||
      ledger.domains.length !== 0 ||
      ledger.blockers.length !== 0 ||
      ledger.remediationRound !== 0
    ) {
      throw new Error(
        'a skipped review cannot have required domains, reports, blockers, or remediation',
      );
    }
    return;
  }
  const expectedDomains = ledger.depth === 'targeted' ? 1 : REVIEW_DOMAINS.size;
  if (ledger.requiredDomains.length !== expectedDomains) {
    throw new Error(
      `review ledger ${ledger.depth} depth has an invalid required domain count`,
    );
  }
  if (ledger.domains.length !== ledger.requiredDomains.length) {
    throw new Error(
      'review ledger must contain exactly one domain record per required domain',
    );
  }
  const domainNames = new Set(ledger.domains.map((domain) => domain.domain));
  for (const requiredDomain of ledger.requiredDomains) {
    if (!domainNames.has(requiredDomain)) {
      throw new Error('review ledger is missing a required domain record');
    }
  }
  for (const blocker of ledger.blockers) {
    if (!domainNames.has(blocker.domain)) {
      throw new Error('review ledger blocker must target a required domain');
    }
  }
}

function assertStoredReviewStatus(ledger: ReviewLedgerV1): void {
  if (ledger.status === 'stale') return;
  const expectedStatus = deriveReviewLedgerStatus(ledger);
  if (ledger.status !== expectedStatus) {
    throw new Error(
      `review ledger status must be derived as ${expectedStatus} from its content`,
    );
  }
}

function isReviewStale(
  ledger: ReviewLedgerV1,
  context: ReviewLedgerContext,
): boolean {
  return (
    ledger.requirementsDigest !== context.requirementsDigest ||
    ledger.planVersion !== context.planVersion
  );
}

function hasLegacyCompatibilityGap(ledger: ReviewLedgerV1): boolean {
  return ledger.requirementsDigest === null || ledger.planVersion === null;
}

function parseReviewStatus(value: unknown): ReviewLedgerStatus {
  if (
    typeof value !== 'string' ||
    !REVIEW_STATUSES.has(value as ReviewLedgerStatus)
  ) {
    throw new Error('review ledger status is invalid');
  }
  return value as ReviewLedgerStatus;
}

function parseReviewDomainSet(value: unknown, label: string): ReviewDomain[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    if (typeof item !== 'string' || !REVIEW_DOMAINS.has(item as ReviewDomain)) {
      throw new Error(`${label} contains an invalid review domain`);
    }
  }
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized as ReviewDomain[];
}

function parseDomains(
  value: unknown,
  taskRef: TaskRef,
): ReviewLedgerV1['domains'] {
  if (!Array.isArray(value)) {
    throw new Error('review ledger domains must be an array');
  }
  const domains = new Set<ReviewDomain>();
  return value.map((item) => {
    assertRecord(item, 'review ledger domain');
    assertKnownKeys(
      item,
      ['domain', 'status', 'reportRef'],
      'review ledger domain',
    );
    if (
      typeof item.domain !== 'string' ||
      !REVIEW_DOMAINS.has(item.domain as ReviewDomain)
    ) {
      throw new Error('review ledger domain is invalid');
    }
    const domain = item.domain as ReviewDomain;
    if (domains.has(domain)) {
      throw new Error('review ledger domain records must be unique');
    }
    domains.add(domain);
    if (
      typeof item.status !== 'string' ||
      !DOMAIN_STATUSES.has(item.status as ReviewDomainStatus)
    ) {
      throw new Error('review ledger domain status is invalid');
    }
    const reportRef =
      item.reportRef === null
        ? null
        : parseReviewReportRef(item.reportRef, taskRef);
    if (item.status === 'pending' && reportRef !== null) {
      throw new Error('pending review domains cannot have a reportRef');
    }
    return {
      domain,
      status: item.status as ReviewDomainStatus,
      reportRef,
    };
  });
}

function parseReviewReportRef(value: unknown, taskRef: TaskRef): ArtifactRef {
  const artifactRef = parseArtifactRef(value);
  assertReferenceNamespace(taskRef.namespace, artifactRef);
  if (
    artifactRef.kind !== 'review_report' ||
    !sameTaskRef(artifactRef.taskRef, taskRef)
  ) {
    throw new Error(
      'review ledger reportRef must be a review_report for the same task',
    );
  }
  return artifactRef;
}

function parseBlockers(
  value: unknown,
  taskRef: TaskRef,
): ReviewLedgerV1['blockers'] {
  if (!Array.isArray(value)) {
    throw new Error('review ledger blockers must be an array');
  }
  return value.map((item) => {
    const identity = parseItemIdentity(item, 'review ledger blocker');
    assertRecord(item, 'review ledger blocker');
    assertKnownKeys(
      item,
      [
        'displayId',
        'legacyId',
        'blockerId',
        'domain',
        'severity',
        'status',
        'summary',
        'waiver',
      ],
      'review ledger blocker',
    );
    assertUlid(item.blockerId, 'review ledger blockerId');
    if (
      typeof item.domain !== 'string' ||
      !REVIEW_DOMAINS.has(item.domain as ReviewDomain)
    ) {
      throw new Error('review ledger blocker domain is invalid');
    }
    if (
      typeof item.severity !== 'string' ||
      !BLOCKER_SEVERITIES.has(item.severity as ReviewBlockerSeverity)
    ) {
      throw new Error('review ledger blocker severity is invalid');
    }
    if (
      typeof item.status !== 'string' ||
      !BLOCKER_STATUSES.has(item.status as ReviewBlockerStatus)
    ) {
      throw new Error('review ledger blocker status is invalid');
    }
    const waiver = parseWaiver(item.waiver);
    const status = item.status as ReviewBlockerStatus;
    const severity = item.severity as ReviewBlockerSeverity;
    if (status === 'waived') {
      if (waiver === null) {
        throw new Error('waived review blockers require a waiver');
      }
      if (severity === 'p0' || severity === 'legacy_unknown') {
        throw new Error(
          'p0 and legacy_unknown review blockers cannot be waived',
        );
      }
    } else if (waiver !== null) {
      throw new Error('only waived review blockers may contain a waiver');
    }
    const summary = parseNonEmptyStringOrNull(
      item.summary,
      'review ledger blocker summary',
    );
    if (taskRef.namespace === 'shared' && summary !== null) {
      assertSharedTextSafe(summary, 'review ledger blocker summary');
    }
    if (taskRef.namespace === 'shared' && waiver !== null) {
      assertSharedTextSafe(
        waiver.reason,
        'review ledger blocker waiver reason',
      );
    }
    return {
      ...identity,
      blockerId: item.blockerId,
      domain: item.domain as ReviewDomain,
      severity,
      status,
      summary,
      waiver,
    };
  });
}

function parseWaiver(
  value: unknown,
): ReviewLedgerV1['blockers'][number]['waiver'] {
  if (value === null) return null;
  assertRecord(value, 'review ledger blocker waiver');
  assertKnownKeys(
    value,
    ['reason', 'approvedByActorId', 'approvedAt'],
    'review ledger blocker waiver',
  );
  assertUlid(value.approvedByActorId, 'review ledger waiver approvedByActorId');
  return {
    reason: parseNonEmptyString(value.reason, 'review ledger waiver reason'),
    approvedByActorId: value.approvedByActorId,
    approvedAt: parseTimestamp(
      value.approvedAt,
      'review ledger waiver approvedAt',
    ),
  };
}

function parseSkip(value: unknown, taskRef: TaskRef): ReviewLedgerV1['skip'] {
  if (value === null) return null;
  assertRecord(value, 'review ledger skip');
  assertKnownKeys(
    value,
    ['reason', 'approvedByActorId', 'approvedAt', 'source'],
    'review ledger skip',
  );
  if (value.source !== 'actor' && value.source !== 'legacy_migration') {
    throw new Error('review ledger skip source is invalid');
  }
  const approvedByActorId = parseUlidOrNull(
    value.approvedByActorId,
    'review ledger skip approvedByActorId',
  );
  if (value.source === 'actor' && approvedByActorId === null) {
    throw new Error('actor review skips require an approving actor');
  }
  const reason = parseNonEmptyString(value.reason, 'review ledger skip reason');
  if (taskRef.namespace === 'shared') {
    assertSharedTextSafe(reason, 'review ledger skip reason');
  }
  return {
    reason,
    approvedByActorId,
    approvedAt: parseTimestamp(
      value.approvedAt,
      'review ledger skip approvedAt',
    ),
    source: value.source,
  };
}

function parseLegacySource(value: unknown): ReviewLedgerV1['legacySource'] {
  if (value === null) return null;
  assertRecord(value, 'review ledger legacySource');
  assertKnownKeys(
    value,
    [
      'sourceSchema',
      'sourceDigest',
      'sourceRequirementsDigest',
      'fieldMapVersion',
    ],
    'review ledger legacySource',
  );
  if (
    value.sourceSchema !== 'review-ledger-1.0' ||
    value.fieldMapVersion !== 1
  ) {
    throw new Error('review ledger legacySource is invalid');
  }
  return {
    sourceSchema: 'review-ledger-1.0',
    sourceDigest: parseDigest(
      value.sourceDigest,
      'review ledger legacySource sourceDigest',
    ),
    sourceRequirementsDigest: parseDigestOrNull(
      value.sourceRequirementsDigest,
      'review ledger legacySource sourceRequirementsDigest',
    ),
    fieldMapVersion: 1,
  };
}

function assertUniqueBlockerIdentity(
  blockers: ReviewLedgerV1['blockers'],
): void {
  const displayIds = new Set<string>();
  const blockerIds = new Set<string>();
  for (const blocker of blockers) {
    if (displayIds.has(blocker.displayId)) {
      throw new Error('review ledger blocker displayIds must be unique');
    }
    if (blockerIds.has(blocker.blockerId)) {
      throw new Error('review ledger blockerIds must be unique');
    }
    displayIds.add(blocker.displayId);
    blockerIds.add(blocker.blockerId);
  }
}

function allowedReviewTransitions(
  status: ReviewLedgerStatus,
): Set<ReviewLedgerStatus> {
  switch (status) {
    case 'pending':
      return new Set([
        'pending',
        'in_review',
        'passed',
        'blocked',
        'skipped',
        'stale',
      ]);
    case 'in_review':
      return new Set(['in_review', 'passed', 'blocked', 'skipped', 'stale']);
    case 'passed':
      return new Set(['passed', 'stale']);
    case 'blocked':
      return new Set(['blocked', 'in_review', 'passed', 'skipped', 'stale']);
    case 'skipped':
      return new Set(['skipped', 'pending', 'in_review', 'stale']);
    case 'stale':
      return new Set([
        'stale',
        'pending',
        'in_review',
        'passed',
        'blocked',
        'skipped',
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

function parsePositiveIntegerOrNull(
  value: unknown,
  label: string,
): number | null {
  if (value === null) return null;
  return parsePositiveInteger(value, label);
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

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, label);
  return value;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function parseNonEmptyStringOrNull(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  return parseNonEmptyString(value, label);
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

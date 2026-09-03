import { assertKnownKeys, assertRecord } from './validation.js';

export interface ManEvidenceSubject {
  contentDigest: string;
  environment: string;
}

export type ManVerificationSurface =
  | 'unit'
  | 'component'
  | 'handler'
  | 'real_http'
  | 'browser'
  | 'device'
  | 'external_service'
  | 'manual_observation';

const MAN_VERIFICATION_SURFACES = new Set<ManVerificationSurface>([
  'unit',
  'component',
  'handler',
  'real_http',
  'browser',
  'device',
  'external_service',
  'manual_observation',
]);

export interface ManReviewEvidence {
  subject: ManEvidenceSubject;
  reviewer: 'independent' | 'self';
  direction: string;
  correctness: string;
  proportionality: string;
  nextAction: string;
  coverage: Array<{
    acceptanceId: string;
    status: 'met' | 'missing' | 'unverified';
    evidence: string;
  }>;
}

export function parseManEvidenceSubject(value: unknown): ManEvidenceSubject {
  assertRecord(value, 'man evidence subject');
  assertKnownKeys(
    value,
    ['contentDigest', 'environment'],
    'man evidence subject',
  );
  if (
    typeof value.contentDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.contentDigest)
  ) {
    throw new Error('MANCODE_MAN_EVIDENCE_SUBJECT_INVALID');
  }
  return {
    contentDigest: value.contentDigest,
    environment: text(value.environment),
  };
}

export function parseManVerificationSurface(
  value: unknown,
): ManVerificationSurface {
  if (
    typeof value !== 'string' ||
    !MAN_VERIFICATION_SURFACES.has(value as ManVerificationSurface)
  )
    throw new Error('MANCODE_MAN_VERIFICATION_SURFACE_INVALID');
  return value as ManVerificationSurface;
}

export function parseManReviewEvidence(value: unknown): ManReviewEvidence {
  assertRecord(value, 'man review evidence');
  assertKnownKeys(
    value,
    [
      'subject',
      'reviewer',
      'direction',
      'correctness',
      'proportionality',
      'nextAction',
      'coverage',
    ],
    'man review evidence',
  );
  if (value.reviewer !== 'independent' && value.reviewer !== 'self')
    throw new Error('MANCODE_MAN_REVIEWER_INVALID');
  if (!Array.isArray(value.coverage))
    throw new Error('MANCODE_MAN_REVIEW_COVERAGE_INVALID');
  const ids = new Set<string>();
  const coverage = value.coverage.map(
    (item): ManReviewEvidence['coverage'][number] => {
      assertRecord(item, 'man review coverage');
      assertKnownKeys(
        item,
        ['acceptanceId', 'status', 'evidence'],
        'man review coverage',
      );
      const acceptanceId = text(item.acceptanceId);
      if (
        ids.has(acceptanceId) ||
        (item.status !== 'met' &&
          item.status !== 'missing' &&
          item.status !== 'unverified')
      ) {
        throw new Error('MANCODE_MAN_REVIEW_COVERAGE_INVALID');
      }
      ids.add(acceptanceId);
      return {
        acceptanceId,
        status: item.status,
        evidence: text(item.evidence),
      };
    },
  );
  return {
    subject: parseManEvidenceSubject(value.subject),
    reviewer: value.reviewer,
    direction: text(value.direction),
    correctness: text(value.correctness),
    proportionality: text(value.proportionality),
    nextAction: text(value.nextAction),
    coverage,
  };
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('MANCODE_MAN_EVIDENCE_TEXT_REQUIRED');
  return value;
}

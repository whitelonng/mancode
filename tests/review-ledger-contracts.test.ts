import { describe, expect, it } from 'vitest';
import {
  type ReviewLedgerV1,
  assertReviewLedgerAgainstContext,
  assertReviewLedgerTransition,
  deriveReviewLedgerStatus,
  parseReviewLedger,
  reviewLedgerDigest,
} from '../src/context/review-ledger.js';

const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const REPORT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const BLOCKER_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const REQUIREMENTS_DIGEST = `sha256:${'a'.repeat(64)}`;

describe('review ledger V3 contract', () => {
  it('requires complete targeted/full coverage and derives passed from content', () => {
    const parsed = parseReviewLedger(reviewLedger());
    expect(deriveReviewLedgerStatus(parsed)).toBe('passed');
    expect(() =>
      assertReviewLedgerAgainstContext(parsed, {
        requirementsDigest: REQUIREMENTS_DIGEST,
        planVersion: 2,
      }),
    ).not.toThrow();
  });

  it('requires stale status when the aggregate version changes', () => {
    const stale = withDigest({
      ...reviewLedger(),
      revision: 2,
      status: 'stale',
    });
    const parsed = parseReviewLedger(stale);
    expect(() =>
      assertReviewLedgerAgainstContext(parsed, {
        requirementsDigest: `sha256:${'b'.repeat(64)}`,
        planVersion: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertReviewLedgerAgainstContext(parsed, {
        requirementsDigest: REQUIREMENTS_DIGEST,
        planVersion: 2,
      }),
    ).toThrow(/must be passed/);
  });

  it('rejects illegal waivers and skips, and enforces revision transitions', () => {
    expect(() =>
      parseReviewLedger(
        withDigest({
          ...reviewLedger(),
          blockers: [
            {
              displayId: 'B-1',
              legacyId: null,
              blockerId: BLOCKER_ID,
              domain: 'quality',
              severity: 'p0',
              status: 'waived',
              summary: 'Critical weakness.',
              waiver: {
                reason: 'Not allowed.',
                approvedByActorId: ACTOR_ID,
                approvedAt: '2026-07-17T10:01:00.000Z',
              },
            },
          ],
        }),
      ),
    ).toThrow(/cannot be waived/);
    expect(() =>
      parseReviewLedger(
        withDigest({
          ...reviewLedger(),
          status: 'skipped',
          skip: {
            reason: 'No review is applicable.',
            approvedByActorId: ACTOR_ID,
            approvedAt: '2026-07-17T10:01:00.000Z',
            source: 'actor',
          },
        }),
      ),
    ).toThrow(/cannot have required domains/);

    const previous = parseReviewLedger(reviewLedger());
    const next = parseReviewLedger(
      withDigest({ ...reviewLedger(), revision: 2, status: 'stale' }),
    );
    expect(() => assertReviewLedgerTransition(previous, next)).not.toThrow();
    expect(() =>
      assertReviewLedgerTransition(previous, { ...next, revision: 3 }),
    ).toThrow(/increase exactly once/);
    expect(() =>
      parseReviewLedger(
        withDigest({
          ...reviewLedger(),
          status: 'skipped',
          requiredDomains: [],
          domains: [],
          blockers: [],
          remediationRound: 0,
          skip: {
            reason: 'Use Authorization: Bearer secret-token.',
            approvedByActorId: null,
            approvedAt: '2026-07-17T10:01:00.000Z',
            source: 'legacy_migration',
          },
        }),
      ),
    ).toThrow(/MANCODE_PRIVACY_BLOCKED/);
  });
});

function reviewLedger(): ReviewLedgerV1 {
  const draft: ReviewLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    revision: 1,
    status: 'passed',
    depth: 'targeted',
    requirementsDigest: REQUIREMENTS_DIGEST,
    planVersion: 2,
    requiredDomains: ['quality'],
    domains: [
      {
        domain: 'quality',
        status: 'passed',
        reportRef: {
          taskRef: { namespace: 'shared', taskId: TASK_ID },
          kind: 'review_report',
          artifactId: REPORT_ID,
        },
      },
    ],
    blockers: [],
    remediationRound: 0,
    skip: null,
    legacySource: null,
    contentDigest: '',
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
  return withDigest(draft);
}

function withDigest(draft: ReviewLedgerV1): ReviewLedgerV1 {
  return { ...draft, contentDigest: reviewLedgerDigest(draft) };
}

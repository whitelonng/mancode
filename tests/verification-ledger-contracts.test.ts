import { describe, expect, it } from 'vitest';
import type { RequirementsLedgerV1 } from '../src/context/requirements-ledger.js';
import {
  type VerificationLedgerV1,
  assertVerificationLedgerAgainstContext,
  assertVerificationLedgerTransition,
  deriveVerificationLedgerStatus,
  parseVerificationLedger,
  verificationLedgerDigest,
} from '../src/context/verification-ledger.js';

const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const CRITERION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const CHECK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const AUTOMATED_EVIDENCE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const MANUAL_EVIDENCE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const ARTIFACT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7P';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7Q';
const REQUIREMENTS_DIGEST = `sha256:${'a'.repeat(64)}`;

describe('verification ledger V3 contract', () => {
  it('derives status from required evidence and validates acceptance identity', () => {
    const parsed = parseVerificationLedger(
      verificationLedger(),
      requirements(),
    );
    expect(deriveVerificationLedgerStatus(parsed)).toBe('manual_required');
    expect(() =>
      assertVerificationLedgerAgainstContext(parsed, {
        requirementsDigest: REQUIREMENTS_DIGEST,
        planVersion: 2,
        remediationRound: 0,
      }),
    ).not.toThrow();
    expect(() =>
      assertVerificationLedgerAgainstContext(parsed, {
        requirementsDigest: REQUIREMENTS_DIGEST,
        planVersion: 3,
        remediationRound: 0,
      }),
    ).toThrow(/must be stale/);
  });

  it('requires both hybrid slots and an explicit manual confirmation for pass', () => {
    expect(() =>
      parseVerificationLedger(
        withDigest({
          ...verificationLedger(),
          checks: verificationLedger().checks.map((check) => ({
            ...check,
            manual: null,
          })),
        }),
      ),
    ).toThrow(/both automated and manual evidence slots/);

    expect(() =>
      parseVerificationLedger(
        withDigest({
          ...verificationLedger(),
          status: 'passed',
          checks: verificationLedger().checks.map((check) => ({
            ...check,
            manual:
              check.manual === null
                ? null
                : { ...check.manual, status: 'passed' },
          })),
        }),
      ),
    ).toThrow(/requires an explicit confirmation/);
  });

  it('permits a confirmed hybrid pass and enforces ledger revisions', () => {
    const previous = parseVerificationLedger(
      verificationLedger(),
      requirements(),
    );
    const next = parseVerificationLedger(
      withDigest({
        ...verificationLedger(),
        revision: 2,
        status: 'passed',
        checks: verificationLedger().checks.map((check) => ({
          ...check,
          manual:
            check.manual === null
              ? null
              : {
                  ...check.manual,
                  status: 'passed',
                  confirmedByActorId: ACTOR_ID,
                  confirmationSource: 'actor',
                  updatedAt: '2026-07-17T10:01:00.000Z',
                },
        })),
      }),
      requirements(),
    );
    expect(deriveVerificationLedgerStatus(next)).toBe('passed');
    expect(() =>
      assertVerificationLedgerTransition(previous, next),
    ).not.toThrow();
    expect(() =>
      assertVerificationLedgerTransition(previous, { ...next, revision: 3 }),
    ).toThrow(/increase exactly once/);
  });

  it('preserves a historical manual confirmation without inventing an actor', () => {
    const migrated = parseVerificationLedger(
      withDigest({
        ...verificationLedger(),
        status: 'passed',
        legacySource: {
          sourceSchema: 'verification-v1',
          sourceDigest: `sha256:${'b'.repeat(64)}`,
          sourceRequirementsDigest: `sha256:${'c'.repeat(64)}`,
          fieldMapVersion: 1,
        },
        checks: verificationLedger().checks.map((check) => ({
          ...check,
          manual:
            check.manual === null
              ? null
              : {
                  ...check.manual,
                  status: 'passed',
                  summary: 'A legacy reviewer confirmed the behavior.',
                  confirmationSource: 'legacy_migration',
                  updatedAt: '2026-07-17T10:01:00.000Z',
                },
        })),
      }),
    );
    expect(migrated.checks[0]?.manual?.confirmationSource).toBe(
      'legacy_migration',
    );
  });
});

function verificationLedger(): VerificationLedgerV1 {
  const draft: VerificationLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    revision: 1,
    status: 'manual_required',
    requirementsDigest: REQUIREMENTS_DIGEST,
    planVersion: 2,
    remediationRound: 0,
    checks: [
      {
        displayId: 'AC-1',
        legacyId: 'AC-1',
        checkId: CHECK_ID,
        criterionId: CRITERION_ID,
        required: true,
        verificationRequirement: 'hybrid',
        automated: {
          evidenceId: AUTOMATED_EVIDENCE_ID,
          status: 'passed',
          summary: 'Automated checks passed.',
          command: 'npm test',
          exitCode: 0,
          artifactRef: {
            taskRef: { namespace: 'shared', taskId: TASK_ID },
            kind: 'evidence_summary',
            artifactId: ARTIFACT_ID,
          },
          confirmedByActorId: null,
          confirmationSource: null,
          updatedAt: '2026-07-17T10:00:00.000Z',
        },
        manual: {
          evidenceId: MANUAL_EVIDENCE_ID,
          status: 'manual_required',
          summary: null,
          command: null,
          exitCode: null,
          artifactRef: null,
          confirmedByActorId: null,
          confirmationSource: null,
          updatedAt: null,
        },
      },
    ],
    legacySource: null,
    contentDigest: '',
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
  return withDigest(draft);
}

function requirements(): RequirementsLedgerV1 {
  return {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    revision: 1,
    status: 'confirmed',
    goal: 'Verify the shared acceptance criterion.',
    functionalScope: { inScope: ['Verify it.'], outOfScope: [] },
    technicalDecisions: [],
    defaults: [],
    coverage: [],
    requirements: [],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: 'AC-1',
        criterionId: CRITERION_ID,
        requirementIds: [],
        statement: 'A reviewer confirms the result.',
        required: true,
        verificationRequirement: 'hybrid',
      },
    ],
    blockingUnknowns: [],
    legacySource: null,
    contentDigest: REQUIREMENTS_DIGEST,
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function withDigest(draft: VerificationLedgerV1): VerificationLedgerV1 {
  return { ...draft, contentDigest: verificationLedgerDigest(draft) };
}

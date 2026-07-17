import { describe, expect, it } from 'vitest';
import {
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsAreReady,
  requirementsLedgerDigest,
} from '../src/context/requirements-ledger.js';

const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const DECISION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const REQUIREMENT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const CRITERION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const COVERAGE_IDS = [
  '01JZ4B6W5Z0A1B2C3D4E5F6G7N',
  '01JZ4B6W5Z0A1B2C3D4E5F6G7P',
  '01JZ4B6W5Z0A1B2C3D4E5F6G7Q',
  '01JZ4B6W5Z0A1B2C3D4E5F6G7R',
  '01JZ4B6W5Z0A1B2C3D4E5F6G7S',
  '01JZ4B6W5Z0A1B2C3D4E5F6G7T',
  '01JZ4B6W5Z0A1B2C3D4E5F6G7V',
];

describe('requirements ledger V3 contract', () => {
  it('preserves stable item identities and computes a canonical authoritative digest', () => {
    const parsed = parseRequirementsLedger(ledger());
    expect(parsed.status).toBe('confirmed');
    expect(requirementsAreReady(parsed)).toBe(true);
    expect(parsed.acceptanceCriteria[0]?.requirementIds).toEqual([
      REQUIREMENT_ID,
    ]);
  });

  it('rejects invalid ready ledgers, dangling requirement references, and digest drift', () => {
    expect(() =>
      parseRequirementsLedger(
        withDigest({
          ...ledger(),
          blockingUnknowns: [
            {
              displayId: 'U-1',
              legacyId: null,
              unknownId: '01JZ4B6W5Z0A1B2C3D4E5F6G7W',
              statement: 'Unknown deployment target.',
              status: 'open',
            },
          ],
        }),
      ),
    ).toThrow(/unresolved blocking unknowns/);
    expect(() =>
      parseRequirementsLedger(
        withDigest({
          ...ledger(),
          acceptanceCriteria: ledger().acceptanceCriteria.map((criterion) => ({
            ...criterion,
            requirementIds: ['01JZ4B6W5Z0A1B2C3D4E5F6G7W'],
          })),
        }),
      ),
    ).toThrow(/unknown requirementId/);
    expect(() =>
      parseRequirementsLedger({
        ...ledger(),
        contentDigest: `sha256:${'0'.repeat(64)}`,
      }),
    ).toThrow(/does not match canonical content/);
    expect(() =>
      parseRequirementsLedger(
        withDigest({
          ...ledger(),
          goal: 'Send the token=super-secret-value to the deployment service.',
        }),
      ),
    ).toThrow(/MANCODE_PRIVACY_BLOCKED/);
  });
});

function ledger(): RequirementsLedgerV1 {
  const draft: RequirementsLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    revision: 1,
    status: 'confirmed',
    goal: 'Add login rate limits.',
    functionalScope: {
      inScope: ['Limit repeated login attempts.'],
      outOfScope: ['Change account recovery.'],
    },
    technicalDecisions: [
      {
        displayId: 'TD-1',
        legacyId: null,
        decisionId: DECISION_ID,
        statement: 'Use the existing Redis client.',
      },
    ],
    defaults: [],
    coverage: [
      'platform',
      'core_scope',
      'technical_stack',
      'data_and_persistence',
      'performance',
      'compatibility',
      'security',
    ].map((dimension, index) => ({
      coverageId:
        COVERAGE_IDS[index] ??
        (() => {
          throw new Error(`missing coverage id at index ${index}`);
        })(),
      dimension:
        dimension as RequirementsLedgerV1['coverage'][number]['dimension'],
      status: 'confirmed' as const,
      rationale: `${dimension} is covered.`,
    })),
    requirements: [
      {
        displayId: 'R-1',
        legacyId: 'REQ-1',
        requirementId: REQUIREMENT_ID,
        statement: 'Throttle repeated failed login attempts.',
        priority: 'must',
      },
    ],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: 'AC-1',
        criterionId: CRITERION_ID,
        requirementIds: [REQUIREMENT_ID],
        statement: 'A repeated failed login receives a rate-limit response.',
        required: true,
        verificationRequirement: 'hybrid',
      },
    ],
    blockingUnknowns: [],
    legacySource: null,
    contentDigest: '',
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
  return { ...draft, contentDigest: requirementsLedgerDigest(draft) };
}

function withDigest(draft: RequirementsLedgerV1): RequirementsLedgerV1 {
  return { ...draft, contentDigest: requirementsLedgerDigest(draft) };
}

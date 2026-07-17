import { describe, expect, it } from 'vitest';
import {
  OPERATION_CRASH_FIXTURES,
  OPERATION_DEFINITIONS,
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from '../src/runtime/operation-definition.js';
import type { OperationJournalV1 } from '../src/runtime/operation-journal.js';

const ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';

describe('machine-readable operation definitions', () => {
  it('gives every hard-consistency operation steps, a visible commit point, and crash recovery fixtures', () => {
    expect(Object.keys(OPERATION_DEFINITIONS)).toHaveLength(22);
    for (const definition of Object.values(OPERATION_DEFINITIONS)) {
      expect(definition.steps.at(-1)).toMatchObject({
        id: 'commit',
        visibility: 'commit',
      });
      expect(
        definition.steps.some(
          (step) => step.id === definition.primaryCommitStep,
        ),
      ).toBe(true);
      const fixtures = OPERATION_CRASH_FIXTURES[definition.type];
      expect(fixtures[0]).toMatchObject({
        crashAfter: 'prepared',
        expectedRecovery: 'safe_abort',
      });
      expect(fixtures).toHaveLength(definition.steps.length + 1);
      expect(
        fixtures
          .slice(1)
          .every(
            (fixture) =>
              fixture.expectedRecovery === 'forward_repair' ||
              fixture.expectedRecovery === 'safe_abort',
          ),
      ).toBe(true);
    }
  });

  it('requires journals to carry the revision and lock families declared by their operation', () => {
    const definition = getOperationDefinition('verification_record');
    const journal = journalForDefinition(definition.type);
    expect(() =>
      assertOperationJournalMatchesDefinition(journal),
    ).not.toThrow();
    expect(() =>
      assertOperationJournalMatchesDefinition({
        ...journal,
        expectedRevisions: { [`task:${ID}`]: 1 },
      }),
    ).toThrow(/missing verification:/);
    expect(() =>
      assertOperationJournalMatchesDefinition({
        ...journal,
        authorizationBasis: {
          ...journal.authorizationBasis,
          action: 'claim_create',
        },
      }),
    ).toThrow('MANCODE_OPERATION_AUTHORIZATION_ACTION_MISMATCH');
  });

  it('requires the task-head fence only when a fenced shared task is mutated', () => {
    const definition = getOperationDefinition('verification_record');
    const localJournal = journalForDefinition(definition.type);
    const { [`task_head:${ID}`]: _localFence, ...localExpectedRevisions } =
      localJournal.expectedRevisions;

    expect(() =>
      assertOperationJournalMatchesDefinition({
        ...localJournal,
        expectedRevisions: localExpectedRevisions,
      }),
    ).not.toThrow();

    const sharedJournal = journalForDefinition(definition.type, 'shared');
    expect(() =>
      assertOperationJournalMatchesDefinition(sharedJournal),
    ).not.toThrow();

    const { [`task_head:${ID}`]: _sharedFence, ...sharedExpectedRevisions } =
      sharedJournal.expectedRevisions;
    expect(() =>
      assertOperationJournalMatchesDefinition({
        ...sharedJournal,
        expectedRevisions: sharedExpectedRevisions,
      }),
    ).toThrow(/missing task_head:/);
    expect(() =>
      assertOperationJournalMatchesDefinition({
        ...sharedJournal,
        entityLocks: sharedJournal.entityLocks.filter(
          (key) => !key.startsWith('task_head:'),
        ),
      }),
    ).toThrow(/entity locks are missing task_head:/);
  });

  it('allows task completion with no claims but pairs every claimed revision with its lock', () => {
    const journal = journalForDefinition('task_complete');
    expect(() =>
      assertOperationJournalMatchesDefinition(journal),
    ).not.toThrow();

    const claimKey = `claim:${ID}`;
    const withClaim: OperationJournalV1 = {
      ...journal,
      expectedRevisions: { ...journal.expectedRevisions, [claimKey]: 1 },
      entityLocks: [...journal.entityLocks, claimKey],
    };
    expect(() =>
      assertOperationJournalMatchesDefinition(withClaim),
    ).not.toThrow();
    expect(() =>
      assertOperationJournalMatchesDefinition({
        ...withClaim,
        entityLocks: withClaim.entityLocks.filter((key) => key !== claimKey),
      }),
    ).toThrow(/entity locks are missing optional claim:/);
    expect(() =>
      assertOperationJournalMatchesDefinition({
        ...withClaim,
        expectedRevisions: journal.expectedRevisions,
      }),
    ).toThrow(/expected revisions are missing optional claim:/);
  });
});

function journalForDefinition(
  type: keyof typeof OPERATION_DEFINITIONS,
  namespace: 'local' | 'shared' = 'local',
): OperationJournalV1 {
  const definition = getOperationDefinition(type);
  const revisionPrefixes = [
    ...new Set(
      definition.steps.flatMap((step) => step.expectedRevisionPrefixes),
    ),
  ];
  const lockPrefixes = [
    ...new Set(definition.steps.flatMap((step) => step.requiredLockPrefixes)),
  ];
  return {
    schemaVersion: 1,
    operationId: ID,
    type,
    state: 'prepared',
    primaryStoreId: `workspace:${ID}`,
    checkoutId: ID,
    secondaryReservations: [],
    actorId: ID,
    sessionId: ID,
    authorizationBasis: {
      schemaVersion: 1,
      action: definition.authorizationActions[0] ?? 'local_workflow_mutation',
      actorId: ID,
      sessionId: ID,
      trustBoundary: 'repo-collaborators',
      decisionDigest: `sha256:${'a'.repeat(64)}`,
      authorizedAt: '2026-07-17T10:00:00.000Z',
    },
    entityLocks: [
      ...lockPrefixes.map((prefix) =>
        prefix === 'task:' ? `${prefix}${namespace}:${ID}` : `${prefix}${ID}`,
      ),
      ...(namespace === 'shared' ? [`task_head:${ID}`] : []),
    ],
    expectedRevisions: Object.fromEntries(
      revisionPrefixes.map((prefix) => [`${prefix}${ID}`, 1]),
    ),
    steps: definition.steps.map((step) => ({ id: step.id, state: 'pending' })),
    startedAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

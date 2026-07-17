import { describe, expect, it } from 'vitest';
import {
  type OperationJournalV1,
  assertOperationJournalTransition,
  parseOperationJournal,
} from '../src/runtime/operation-journal.js';

const ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('operation journal contract', () => {
  it('rejects malformed entity locks, reservations, and steps before they can become durable', () => {
    expect(() =>
      parseOperationJournal({
        ...journal(),
        entityLocks: ['task:shared:one', 'task:shared:one'],
      }),
    ).toThrow(/duplicates/);
    expect(() =>
      parseOperationJournal({
        ...journal(),
        secondaryReservations: [
          {
            storeId: 'local:one',
            entityKeys: ['task:shared:one'],
            journalDigest: DIGEST,
          },
          {
            storeId: 'local:one',
            entityKeys: ['task:shared:two'],
            journalDigest: DIGEST,
          },
        ],
      }),
    ).toThrow(/repeat a store/);
    expect(() =>
      parseOperationJournal({
        ...journal(),
        steps: [],
      }),
    ).toThrow(/non-empty/);
    expect(() =>
      parseOperationJournal({
        ...journal(),
        state: 'committed',
      }),
    ).toThrow(/every step/);
    expect(() =>
      parseOperationJournal({
        ...journal(),
        state: 'applying',
        steps: [
          { id: 'validate', state: 'pending' },
          { id: 'write', state: 'completed' },
        ],
      }),
    ).toThrow(/contiguous prefix/);
  });

  it('only moves forward through prepared, applying, repair, and committed states', () => {
    const prepared = parseOperationJournal(journal());
    const applying = parseOperationJournal({ ...prepared, state: 'applying' });
    const repair = parseOperationJournal({
      ...applying,
      state: 'repair_required',
    });
    const committed = parseOperationJournal({
      ...repair,
      state: 'committed',
      steps: repair.steps.map((step) => ({
        ...step,
        state: 'completed' as const,
      })),
    });
    expect(() =>
      assertOperationJournalTransition(prepared, applying, { canAbort: false }),
    ).not.toThrow();
    expect(() =>
      assertOperationJournalTransition(applying, repair, { canAbort: false }),
    ).not.toThrow();
    expect(() =>
      assertOperationJournalTransition(repair, committed, { canAbort: false }),
    ).not.toThrow();
    expect(() =>
      assertOperationJournalTransition(prepared, committed, {
        canAbort: false,
      }),
    ).toThrow(/invalid operation state transition/);
  });

  it('cannot commit incomplete work, regress a completed step, or abort after an external write', () => {
    const applying = parseOperationJournal({ ...journal(), state: 'applying' });
    const completedStep = parseOperationJournal({
      ...applying,
      steps: [
        { id: 'validate', state: 'completed' },
        { id: 'write', state: 'pending' },
      ],
    });
    const regressedStep = parseOperationJournal({
      ...completedStep,
      steps: [
        { id: 'validate', state: 'pending' },
        { id: 'write', state: 'pending' },
      ],
    });
    expect(() =>
      assertOperationJournalTransition(completedStep, regressedStep, {
        canAbort: false,
      }),
    ).toThrow(/cannot become pending/);
    const aborted = parseOperationJournal({ ...applying, state: 'aborted' });
    expect(() =>
      assertOperationJournalTransition(applying, aborted, { canAbort: false }),
    ).toThrow(/cannot abort/);
  });
});

function journal(): OperationJournalV1 {
  return {
    schemaVersion: 1,
    operationId: ID,
    type: 'handoff_accept',
    state: 'prepared',
    primaryStoreId: 'workspace:01JZ',
    checkoutId: ID,
    secondaryReservations: [],
    actorId: ID,
    sessionId: ID,
    authorizationBasis: {
      schemaVersion: 1,
      action: 'handoff_accept_reject',
      actorId: ID,
      sessionId: ID,
      trustBoundary: 'repo-collaborators',
      decisionDigest: DIGEST,
      authorizedAt: '2026-07-17T10:00:00.000Z',
    },
    entityLocks: ['task:shared:01JZ', 'handoff:01JY'],
    expectedRevisions: { 'task:shared:01JZ': 7, 'handoff:01JY': 2 },
    steps: [
      { id: 'validate', state: 'pending' },
      { id: 'write', state: 'pending' },
    ],
    startedAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

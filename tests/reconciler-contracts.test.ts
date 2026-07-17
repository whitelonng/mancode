import { describe, expect, it } from 'vitest';
import type { OperationJournalV1 } from '../src/runtime/operation-journal.js';
import {
  assertOperationCrashFixtureCoverage,
  planOperationRecovery,
} from '../src/runtime/reconciler.js';

const ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const OTHER_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('operation reconciler contract', () => {
  it('maps all declared crash points to one explicit recovery result', () => {
    expect(() => assertOperationCrashFixtureCoverage()).not.toThrow();
  });

  it('aborts before a business write and forward-repairs after one', () => {
    const beforeWrite = journal(1);
    expect(planOperationRecovery({ journal: beforeWrite })).toMatchObject({
      action: 'safe_abort',
      nextJournalState: 'aborted',
      reason: 'no_external_write',
    });
    const afterWrite = journal(2);
    expect(planOperationRecovery({ journal: afterWrite })).toMatchObject({
      action: 'forward_repair',
      nextJournalState: 'repair_required',
      reason: 'business_write_visible',
      pendingEntityLocks: expect.arrayContaining([`task:shared:${ID}`]),
    });
  });

  it('keeps a committed task committed when only event/session/cache projections need retry', () => {
    const committed = journal(9, 'committed');
    expect(
      planOperationRecovery({
        journal: committed,
        projections: { auditEvent: 'missing', cache: 'missing' },
      }),
    ).toMatchObject({
      action: 'projection_retry',
      nextJournalState: 'committed',
      retryProjections: ['auditEvent', 'cache'],
      pendingEntityLocks: [],
    });
  });
});

function journal(
  completedCount: number,
  state: OperationJournalV1['state'] = 'applying',
): OperationJournalV1 {
  const stepIds = [
    'validate',
    'mark-task-operation-pending',
    'create-pending-successor-claims',
    'transfer-old-claims',
    'update-owner-and-checkpoint',
    'activate-successor-claims',
    'accept-handoff',
    'update-task-head-fence',
    'commit',
  ];
  return {
    schemaVersion: 1,
    operationId: ID,
    type: 'handoff_accept',
    state,
    primaryStoreId: `workspace:${ID}`,
    checkoutId: ID,
    secondaryReservations: [],
    actorId: ID,
    sessionId: OTHER_ID,
    authorizationBasis: {
      schemaVersion: 1,
      action: 'handoff_accept_reject',
      actorId: ID,
      sessionId: OTHER_ID,
      trustBoundary: 'repo-collaborators',
      decisionDigest: DIGEST,
      authorizedAt: '2026-07-17T10:00:00.000Z',
    },
    entityLocks: [
      `task:shared:${ID}`,
      `task_head:${ID}`,
      `handoff:${ID}`,
      `claim:${ID}`,
      `checkpoint:${ID}`,
    ],
    expectedRevisions: {
      [`task:shared:${ID}`]: 7,
      [`handoff:${ID}`]: 2,
      [`claim:${ID}`]: 1,
      [`checkpoint:${ID}`]: 0,
      [`task_head:${ID}`]: 7,
    },
    steps: stepIds.map((id, index) => ({
      id,
      state:
        index < completedCount ? ('completed' as const) : ('pending' as const),
    })),
    startedAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

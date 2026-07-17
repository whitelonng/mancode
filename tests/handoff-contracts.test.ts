import { describe, expect, it } from 'vitest';
import {
  type HandoffV1,
  assertHandoffTransition,
  parseHandoff,
} from '../src/team/handoff.js';

const HANDOFF_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const FROM_ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const TO_ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const CHECKPOINT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('handoff contract', () => {
  it('keeps business handoff state independent from local transport availability', () => {
    const offered = parseHandoff({
      ...handoff(),
      state: 'offered',
      offeredAt: '2026-07-17T10:01:00.000Z',
    });
    expect(offered.transport.state).toBe('local_only');
    expect(offered.state).toBe('offered');
    expect(() =>
      parseHandoff({
        ...offered,
        transport: { ...offered.transport, mode: 'local', state: 'published' },
      }),
    ).toThrow(/local_only/);
  });

  it('requires a named recipient and an offered handoff before acceptance', () => {
    const draft = parseHandoff(handoff());
    const accepted = parseHandoff({
      ...draft,
      state: 'accepted',
      revision: 2,
      offeredAt: '2026-07-17T10:01:00.000Z',
      resolution: {
        state: 'accepted',
        actorId: TO_ACTOR_ID,
        at: '2026-07-17T10:02:00.000Z',
        reason: null,
      },
    });
    expect(() => assertHandoffTransition(draft, accepted, TO_ACTOR_ID)).toThrow(
      /invalid handoff state transition/,
    );
    const offered = parseHandoff({
      ...draft,
      state: 'offered',
      revision: 2,
      offeredAt: '2026-07-17T10:01:00.000Z',
    });
    const offeredAccepted = parseHandoff({ ...accepted, revision: 3 });
    expect(() =>
      assertHandoffTransition(offered, offeredAccepted, FROM_ACTOR_ID),
    ).toThrow(/only the receiving actor/);
    expect(() =>
      assertHandoffTransition(offered, offeredAccepted, TO_ACTOR_ID),
    ).not.toThrow();
  });

  it('rejects open handoffs and references that escape the shared task', () => {
    expect(() =>
      parseHandoff({ ...handoff(), toActorId: FROM_ACTOR_ID }),
    ).toThrow(/distinct receiving actor/);
    expect(() =>
      parseHandoff({
        ...handoff(),
        checkpointRef: {
          taskRef: { namespace: 'local', taskId: TASK_ID },
          kind: 'checkpoint',
          artifactId: CHECKPOINT_ID,
        },
      }),
    ).toThrow(/cannot reference local/);
  });

  it('blocks sensitive text from the shared handoff projection', () => {
    expect(() =>
      parseHandoff({
        ...handoff(),
        summary: {
          ...handoff().summary,
          nextAction: 'Inspect /Users/alice/private/report.txt before merge.',
        },
      }),
    ).toThrow(/MANCODE_PRIVACY_BLOCKED/);
  });
});

function handoff(): HandoffV1 {
  return {
    schemaVersion: 1,
    handoffId: HANDOFF_ID,
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    taskRevision: 7,
    ownershipEpochAtOffer: 3,
    state: 'draft',
    revision: 1,
    fromActorId: FROM_ACTOR_ID,
    toActorId: TO_ACTOR_ID,
    claimIds: [],
    checkpointRef: {
      taskRef: { namespace: 'shared', taskId: TASK_ID },
      kind: 'checkpoint',
      artifactId: CHECKPOINT_ID,
    },
    summary: {
      completed: [],
      inProgress: [],
      notStarted: [],
      changedFiles: [],
      verification: [],
      blockers: [],
      risks: [],
      nextAction: 'Run the security review.',
    },
    transport: {
      mode: 'local',
      state: 'local_only',
      transportRevision: null,
      publishedAt: null,
      fetchedAt: null,
      taskBundleDigest: DIGEST,
      codeRef: { branch: 'feature/login', head: 'abc1234' },
      codeReachable: true,
      receipt: null,
    },
    lastOperationId: null,
    offeredAt: null,
    resolution: null,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

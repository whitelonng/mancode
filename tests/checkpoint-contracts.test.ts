import { describe, expect, it } from 'vitest';
import { type CheckpointV1, parseCheckpoint } from '../src/team/checkpoints.js';

const ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('checkpoint contract', () => {
  it('creates immutable, typed task snapshots with all aggregate governance digests', () => {
    const checkpoint = parseCheckpoint(rawCheckpoint());
    expect(checkpoint.kind).toBe('handoff_offered');
    expect(checkpoint.taskRef).toEqual({
      namespace: 'shared',
      taskId: TASK_ID,
    });
  });

  it('rejects unknown kinds and incomplete governance snapshots', () => {
    expect(() =>
      parseCheckpoint({ ...rawCheckpoint(), kind: 'custom' }),
    ).toThrow(/checkpoint kind/);
    expect(() =>
      parseCheckpoint({
        ...rawCheckpoint(),
        governance: { requirementsDigest: DIGEST },
      }),
    ).toThrow(/unknown field|planVersion/);
  });

  it('blocks sensitive text before it becomes a shared checkpoint', () => {
    expect(() =>
      parseCheckpoint({
        ...rawCheckpoint(),
        summary: 'Authorization: Bearer super-secret',
      }),
    ).toThrow(/MANCODE_PRIVACY_BLOCKED/);
  });
});

function rawCheckpoint(): CheckpointV1 {
  return {
    schemaVersion: 1,
    checkpointId: ID,
    operationId: ID,
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    taskRevision: 7,
    ownershipEpochAtOffer: 3,
    kind: 'handoff_offered',
    git: { branch: 'feature/login', head: 'abc1234', base: 'def5678' },
    summary: 'Login path is ready for review.',
    governance: {
      requirementsDigest: DIGEST,
      planVersion: 2,
      reviewLedgerDigest: DIGEST,
      verificationLedgerDigest: DIGEST,
    },
    nextAction: 'Accept the handoff.',
    createdBy: { actorId: ID, client: 'codex' },
    createdAt: '2026-07-17T10:00:00.000Z',
  };
}

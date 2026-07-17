import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enqueueAuditEventProjection,
  listProjectionIntents,
  reconcileProjectionIntents,
} from '../src/runtime/projection-outbox.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import { type TeamEventV1, listTeamEvents } from '../src/team/events.js';

const EVENT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const OTHER_EVENT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const OTHER_ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const NOW = new Date('2026-07-18T10:00:00.000Z');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('durable projection outbox contract', () => {
  it('does not guess an event before authority exists and repairs the exact intent afterwards', async () => {
    const root = await temporaryRoot();
    const event = actorJoinedEvent();
    await enqueueAuditEventProjection(root, event, NOW);

    await expect(
      reconcileProjectionIntents(root, OPERATION_ID, NOW),
    ).resolves.toMatchObject({
      state: 'repair_required',
      projections: [
        {
          kind: 'audit_event',
          availability: 'conflict',
          state: 'pending',
        },
      ],
    });
    await expect(listTeamEvents(root)).resolves.toEqual([]);
    await expect(listProjectionIntents(root)).resolves.toHaveLength(1);

    const actor = await createLocalActor(root, {
      actorId: ACTOR_ID,
      displayName: 'Projection User',
      now: NOW,
    });
    await publishSharedActorProfile(root, createSharedActorProfile(actor, NOW));
    await expect(
      reconcileProjectionIntents(root, OPERATION_ID, NOW),
    ).resolves.toMatchObject({
      state: 'converged',
      projections: [
        {
          kind: 'audit_event',
          availability: 'present',
          state: 'completed',
        },
      ],
    });
    await expect(listTeamEvents(root)).resolves.toEqual([event]);
    await expect(listProjectionIntents(root)).resolves.toEqual([]);
  });

  it('rejects a different target behind the same operation projection key', async () => {
    const root = await temporaryRoot();
    await enqueueAuditEventProjection(root, actorJoinedEvent(), NOW);
    await expect(
      enqueueAuditEventProjection(
        root,
        {
          ...actorJoinedEvent(),
          eventId: OTHER_EVENT_ID,
          entityRef: { kind: 'actor', id: OTHER_ACTOR_ID },
          actorId: OTHER_ACTOR_ID,
        },
        NOW,
      ),
    ).rejects.toThrow('MANCODE_PROJECTION_INTENT_CONFLICT');
  });
});

function actorJoinedEvent(): TeamEventV1 {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    eventType: 'actor_joined',
    operationId: OPERATION_ID,
    entityRef: { kind: 'actor', id: ACTOR_ID },
    taskRef: null,
    actorId: ACTOR_ID,
    taskRevision: null,
    createdAt: NOW.toISOString(),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-projection-'));
  roots.push(root);
  return root;
}

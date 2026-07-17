import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type TeamEventV1,
  dedupeTeamEvents,
  listTeamEvents,
  parseTeamEvent,
  teamEventDedupeKey,
  writeTeamEvent,
} from '../src/team/events.js';

const EVENT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const RETRY_EVENT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('team event contract', () => {
  it('accepts a compact shared audit projection without any text payload', () => {
    const event = parseTeamEvent(teamEvent());
    expect(teamEventDedupeKey(event)).toBe(`${OPERATION_ID}:handoff_accepted`);
    expect(event.taskRef).toEqual({ namespace: 'shared', taskId: TASK_ID });
  });

  it('does not allow events to carry local task references or arbitrary logs', () => {
    expect(() =>
      parseTeamEvent({
        ...teamEvent(),
        taskRef: { namespace: 'local', taskId: TASK_ID },
      }),
    ).toThrow(/shared TaskRefs/);
    expect(() =>
      parseTeamEvent({
        ...teamEvent(),
        rawPrompt: 'Authorization: Bearer super-secret',
      }),
    ).toThrow(/unknown field/);
  });

  it('deduplicates retried projection writes by operation and event type', () => {
    const original = parseTeamEvent(teamEvent());
    const retry = parseTeamEvent({
      ...teamEvent(),
      eventId: RETRY_EVENT_ID,
      createdAt: '2026-07-17T10:01:00.000Z',
    });
    expect(dedupeTeamEvents([retry, original])).toEqual([original]);
  });

  it('rejects conflicting payloads hidden behind one idempotency key', () => {
    const conflicting = parseTeamEvent({
      ...teamEvent(),
      eventId: RETRY_EVENT_ID,
      entityRef: { kind: 'handoff', id: RETRY_EVENT_ID },
    });
    expect(() => dedupeTeamEvents([teamEvent(), conflicting])).toThrow(
      'MANCODE_TEAM_EVENT_DEDUPE_CONFLICT',
    );
  });

  it('persists one retry-safe audit projection after the business commit point', async () => {
    const root = await temporaryRoot();
    const original = parseTeamEvent(teamEvent());
    const retry = parseTeamEvent({ ...teamEvent(), eventId: RETRY_EVENT_ID });
    await expect(writeTeamEvent(root, original)).resolves.toEqual(original);
    await expect(writeTeamEvent(root, retry)).resolves.toEqual(original);
    await expect(listTeamEvents(root)).resolves.toEqual([original]);
    await expect(
      readdir(path.join(root, '.mancode', 'shared', 'team', 'events')),
    ).resolves.toEqual([`${EVENT_ID}.json`]);
  });
});

function teamEvent(): TeamEventV1 {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    eventType: 'handoff_accepted',
    operationId: OPERATION_ID,
    entityRef: { kind: 'handoff', id: EVENT_ID },
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    actorId: ACTOR_ID,
    taskRevision: 8,
    createdAt: '2026-07-17T10:00:00.000Z',
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-event-contract-'));
  roots.push(root);
  return root;
}

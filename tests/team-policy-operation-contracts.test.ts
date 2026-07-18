import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import {
  listProjectionIntents,
  reconcileProjectionIntents,
} from '../src/runtime/projection-outbox.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import { listTeamEvents } from '../src/team/events.js';
import {
  setTeamTransport,
  updateTeamPolicy,
} from '../src/team/policy-operation.js';

const NOW = new Date('2026-07-18T15:00:00.000Z');

describe('team policy/config audit projection durability', () => {
  let root: string;
  let actorId: Ulid;
  let sessionId: Ulid;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-team-policy-operation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    actorId = id(4);
    sessionId = id(5);
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
    const actor = await createLocalActor(root, {
      actorId,
      displayName: 'Policy Operator',
      now: NOW,
    });
    await publishSharedActorProfile(root, createSharedActorProfile(actor, NOW));
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now: NOW,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('commits a policy update and leaves a replayable audit outbox item when event storage is unavailable', async () => {
    const eventsPath = await blockTeamEventWrites(root);
    const result = await updateTeamPolicy({
      projectRoot: root,
      sessionId,
      expectedPolicyRevision: 1,
      policy: 'on',
      operationId: id(10),
      now: NOW,
    });

    expect(result.auditProjection).toBe('pending');
    await expect(
      new V3ContextStore(root).readProjectSnapshot(),
    ).resolves.toMatchObject({
      policy: { policy: 'on', revision: 2, lastOperationId: id(10) },
    });
    await expect(listProjectionIntents(root)).resolves.toMatchObject([
      {
        operationId: id(10),
        state: 'pending',
        target: {
          kind: 'audit_event',
          event: { eventType: 'team_policy_updated' },
        },
      },
    ]);

    await rm(eventsPath);
    await expect(
      reconcileProjectionIntents(root, id(10), NOW),
    ).resolves.toMatchObject({
      state: 'converged',
    });
    await expect(listTeamEvents(root)).resolves.toMatchObject([
      { operationId: id(10), eventType: 'team_policy_updated' },
    ]);
    await expect(listProjectionIntents(root)).resolves.toEqual([]);
  });

  it('commits an empty-authority transport set and preserves its audit event for retry', async () => {
    const eventsPath = await blockTeamEventWrites(root);
    const result = await setTeamTransport({
      projectRoot: root,
      sessionId,
      expectedConfigRevision: 1,
      mode: 'git-ref',
      remote: 'origin',
      operationId: id(20),
      now: NOW,
    });

    expect(result.auditProjection).toBe('pending');
    await expect(
      new V3ContextStore(root).readProjectSnapshot(),
    ).resolves.toMatchObject({
      config: {
        revision: 2,
        transport: { mode: 'git-ref', remote: 'origin', epoch: 2 },
        lastOperationId: id(20),
      },
    });
    await expect(listProjectionIntents(root)).resolves.toMatchObject([
      {
        operationId: id(20),
        state: 'pending',
        target: {
          kind: 'audit_event',
          event: { eventType: 'team_transport_set' },
        },
      },
    ]);

    await rm(eventsPath);
    await expect(
      reconcileProjectionIntents(root, id(20), NOW),
    ).resolves.toMatchObject({
      state: 'converged',
    });
    await expect(listTeamEvents(root)).resolves.toMatchObject([
      { operationId: id(20), eventType: 'team_transport_set' },
    ]);
  });
});

async function blockTeamEventWrites(projectRoot: string): Promise<string> {
  const target = path.join(projectRoot, '.mancode', 'shared', 'team', 'events');
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await writeFile(target, 'event writes deliberately blocked\n');
  return target;
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

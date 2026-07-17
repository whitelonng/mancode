import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalActorIdentityV1,
  createLocalActor,
  readSharedActorProfile,
} from '../src/team/actor.js';
import { listTeamEvents } from '../src/team/events.js';
import { joinTeam, prepareTeamJoin } from '../src/team/join.js';
import type { ProjectConfigV1, TeamPolicyV1 } from '../src/team/policy.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const EVENT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('team join contract', () => {
  it('requires an explicit confirmation and rejects sync when transport is local', () => {
    const actor = actorFixture();
    expect(() =>
      prepareTeamJoin(joinInput(actor, { confirmed: false })),
    ).toThrow('MANCODE_JOIN_CONFIRMATION_REQUIRED');
    expect(() => prepareTeamJoin(joinInput(actor, { sync: true }))).toThrow(
      'MANCODE_TRANSPORT_UNAVAILABLE',
    );
  });

  it('publishes a narrow profile then appends one join audit event', async () => {
    const root = await temporaryRoot();
    const actor = await createLocalActor(root, {
      actorId: ACTOR_ID,
      displayName: 'Alice Example',
    });
    const result = await joinTeam({
      ...joinInput(actor),
      projectRoot: root,
    });
    expect(result.syncReceipt).toBeNull();
    await expect(readSharedActorProfile(root, ACTOR_ID)).resolves.toEqual(
      result.profile,
    );
    await expect(listTeamEvents(root)).resolves.toEqual([result.event]);
  });

  it('only invokes a git-ref publisher when the user explicitly requests sync', async () => {
    const root = await temporaryRoot();
    const actor = await createLocalActor(root, {
      actorId: ACTOR_ID,
      displayName: 'Alice Example',
    });
    const calls: string[] = [];
    const result = await joinTeam({
      ...joinInput(actor, { transport: 'git-ref', sync: true }),
      projectRoot: root,
      syncPublisher: {
        async publishActorProfile({ profile }) {
          calls.push(profile.actorId);
          return { receipt: 'receipt:abc123' };
        },
      },
    });
    expect(calls).toEqual([ACTOR_ID]);
    expect(result.syncReceipt).toBe('receipt:abc123');
  });
});

function joinInput(
  actor: LocalActorIdentityV1,
  overrides: {
    confirmed?: boolean;
    sync?: boolean;
    transport?: 'local' | 'git-ref';
  } = {},
) {
  const transport = overrides.transport ?? 'local';
  return {
    actor,
    projectConfig: config(transport),
    teamPolicy: policy(),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
    confirmed: overrides.confirmed ?? true,
    sync: overrides.sync ?? false,
    now: new Date('2026-07-17T10:00:00.000Z'),
  };
}

function actorFixture(): LocalActorIdentityV1 {
  return {
    schemaVersion: 1,
    actorId: ACTOR_ID,
    displayName: 'Alice Example',
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function config(transport: 'local' | 'git-ref'): ProjectConfigV1 {
  return {
    schemaVersion: 1,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    transport: {
      mode: transport,
      remote: transport === 'git-ref' ? 'origin/mancode-team' : null,
    },
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function policy(): TeamPolicyV1 {
  return {
    schemaVersion: 1,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    policy: 'auto',
    recentDays: 30,
    defaultVisibility: 'local',
    shareConfirmedDecisions: true,
    retention: {
      localRawArtifactDays: 7,
      localCacheDays: 7,
      completedSessionDays: 30,
    },
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-join-contract-'));
  roots.push(root);
  return root;
}

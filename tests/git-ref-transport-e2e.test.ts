import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { teamJoin } from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createSession } from '../src/runtime/session.js';
import type { SharedActorProfileV1 } from '../src/team/actor.js';
import { createLocalActor } from '../src/team/actor.js';
import { GitRefTeamManifestStore } from '../src/team/git-ref-transport.js';

const execFile = promisify(execFileCallback);
const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('git-ref profile transport cross-clone E2E', () => {
  it('pulls profiles across clones and rejects a stale revision', async () => {
    const fixture = await createFixture();
    const storeA = store(fixture.cloneA);
    const storeB = store(fixture.cloneB);

    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: null,
      commit: null,
      receipt: null,
    });
    const first = await storeA.publishActorProfile({
      operationId: id(10),
      expectedRemoteRevision: 0,
      profile: profile(id(1), 'Alice'),
    });
    expect(first).toMatchObject({
      remoteRevision: 1,
      receipt: expect.stringMatching(/^git-ref:[0-9a-f]{40}:/),
    });

    await expect(storeB.pull()).resolves.toMatchObject({
      manifest: {
        revision: 1,
        actorProfiles: [expect.objectContaining({ displayName: 'Alice' })],
      },
      receipt: first.receipt,
    });
    await expect(
      storeB.publishActorProfile({
        operationId: id(11),
        expectedRemoteRevision: 1,
        profile: profile(id(2), 'Bob'),
      }),
    ).resolves.toMatchObject({ remoteRevision: 2 });
    await expect(
      storeA.publishActorProfile({
        operationId: id(12),
        expectedRemoteRevision: 1,
        profile: profile(id(3), 'Carol'),
      }),
    ).rejects.toThrow('MANCODE_TRANSPORT_REVISION_CONFLICT');
  });

  it('allows exactly one concurrent compare-and-swap push', async () => {
    const fixture = await createFixture();
    const storeA = store(fixture.cloneA);
    const storeB = store(fixture.cloneB);
    await storeA.publishActorProfile({
      operationId: id(20),
      expectedRemoteRevision: 0,
      profile: profile(id(4), 'Alice'),
    });
    await Promise.all([storeA.pull(), storeB.pull()]);

    const results = await Promise.allSettled([
      storeA.publishActorProfile({
        operationId: id(21),
        expectedRemoteRevision: 1,
        profile: profile(id(5), 'Bob'),
      }),
      storeB.publishActorProfile({
        operationId: id(22),
        expectedRemoteRevision: 1,
        profile: profile(id(6), 'Carol'),
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toMatch(
      /MANCODE_TRANSPORT_(CAS|REVISION)_CONFLICT/,
    );
    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: { revision: 2, actorProfiles: expect.any(Array) },
    });
  });

  it('publishes a joined profile through the explicit command sync path', async () => {
    const fixture = await createFixture();
    await initializeV3Project({
      projectRoot: fixture.cloneA,
      operationId: id(30),
      workspaceId: WORKSPACE_ID,
      schemaEpoch: id(31),
      now: new Date('2026-07-18T10:00:00.000Z'),
    });
    const configPath = path.join(
      fixture.cloneA,
      '.mancode',
      'shared',
      'config.json',
    );
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      revision: number;
      transport: { mode: 'local' | 'git-ref'; remote: string | null };
      updatedAt: string;
    };
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...config,
          revision: config.revision + 1,
          transport: { mode: 'git-ref', remote: 'origin' },
          updatedAt: '2026-07-18T10:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );
    const actor = await createLocalActor(fixture.cloneA, {
      actorId: id(32),
      displayName: 'Command Alice',
      now: new Date('2026-07-18T10:00:00.000Z'),
    });
    const sessionId = id(33);
    await createSession(fixture.cloneA, {
      actorId: actor.actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now: new Date('2026-07-18T10:00:00.000Z'),
    });
    const writes: string[] = [];
    const previousLog = console.log;
    console.log = (value: unknown) => writes.push(String(value));
    try {
      await expect(
        teamJoin(fixture.cloneA, {
          name: actor.displayName,
          session: sessionId,
          client: 'vitest',
          sync: true,
          json: true,
        }),
      ).resolves.toBe(0);
    } finally {
      console.log = previousLog;
    }
    expect(JSON.parse(writes.at(-1) ?? '{}')).toMatchObject({
      syncReceipt: expect.stringMatching(/^git-ref:[0-9a-f]{40}:/),
    });
    await expect(store(fixture.cloneB).pull()).resolves.toMatchObject({
      manifest: {
        actorProfiles: [
          expect.objectContaining({
            actorId: actor.actorId,
            displayName: 'Command Alice',
          }),
        ],
      },
    });
  });
});

function store(projectRoot: string): GitRefTeamManifestStore {
  return new GitRefTeamManifestStore({
    projectRoot,
    remote: 'origin',
    workspaceId: WORKSPACE_ID,
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  });
}

function profile(actorId: string, displayName: string): SharedActorProfileV1 {
  return {
    schemaVersion: 1,
    actorId,
    displayName,
    joinedAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };
}

function id(value: number): string {
  return `01JZ4B6W5Z0A1B2C3D4E5F${value.toString().padStart(4, '0')}`;
}

async function createFixture(): Promise<{
  cloneA: string;
  cloneB: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-git-ref-e2e-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const cloneA = path.join(root, 'clone-a');
  const cloneB = path.join(root, 'clone-b');
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['clone', remote, cloneA]);
  await execFile('git', ['clone', remote, cloneB]);
  return { cloneA, cloneB };
}

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import type { SharedActorProfileV1 } from '../src/team/actor.js';
import {
  GitRefTeamManifestStore,
  type GitRefTeamManifestStoreOptions,
  parseGitRefTaskBundle,
  parseGitRefTeamManifest,
  resolveGitRefRemoteIdentityHash,
} from '../src/team/git-ref-transport.js';

const execFile = promisify(execFileCallback);
const WORKSPACE_ID = id(1);
const SCHEMA_EPOCH = id(2);
const ACTOR_ID = id(3);
const TASK_ID = id(4);
const NOW = '2026-07-18T10:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('git-ref remote manifest contracts', () => {
  it('only upgrades the exact legacy profile shape and enforces size/count/schema gates', () => {
    const legacy = {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      revision: 1,
      lastOperationId: id(10),
      actorProfiles: [profile(ACTOR_ID)],
      updatedAt: NOW,
    };
    const upgraded = parseGitRefTeamManifest(legacy);
    expect(upgraded).toMatchObject({
      authorityState: 'active',
      authorityTombstone: null,
      schemaEpoch: WORKSPACE_ID,
      transportEpoch: 1,
      ownershipFences: [],
      claims: [],
      handoffs: [],
      taskBundles: [],
    });
    expect(() => parseGitRefTeamManifest(upgraded)).toThrow(
      'git-ref manifest receipts require lastMutation',
    );
    expect(() =>
      parseGitRefTeamManifest({ ...legacy, unexpected: true }),
    ).toThrow();
    expect(() =>
      parseGitRefTeamManifest({
        ...legacy,
        actorProfiles: Array.from({ length: 257 }, () => profile(ACTOR_ID)),
      }),
    ).toThrow('exceeds the entity limit');
    expect(() =>
      parseGitRefTeamManifest({
        ...legacy,
        updatedAt: 'x'.repeat(1_000_001),
      }),
    ).toThrow('MANCODE_TRANSPORT_MANIFEST_TOO_LARGE');
  });

  it('rejects unsafe paths, private content, and invalid artifact digests before materialization', () => {
    expect(() =>
      parseGitRefTaskBundle(
        bundleWithArtifact('../metadata.json', {}, digest({})),
      ),
    ).toThrow('MANCODE_ARTIFACT_PATH_UNSAFE');
    expect(() =>
      parseGitRefTaskBundle(
        bundleWithArtifact(
          'metadata.json',
          'api_key=do-not-publish',
          digest('api_key=do-not-publish'),
        ),
      ),
    ).toThrow('MANCODE_PRIVACY_BLOCKED');
    expect(() =>
      parseGitRefTaskBundle(
        bundleWithArtifact('metadata.json', {}, digest({ different: true })),
      ),
    ).toThrow('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_DIGEST_MISMATCH');
    expect(() =>
      parseGitRefTaskBundle(
        bundleWithArtifact('nested/metadata.json', {}, digest({})),
      ),
    ).toThrow('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_PATH_MISMATCH');
  });

  it('fences task mutations, leaves a read-only tombstone, and establishes a new epoch', async () => {
    const fixture = await createFixture();
    const epochOne = store(fixture.clone, 1, 1);
    await epochOne.publishActorProfile({
      operationId: id(20),
      expectedRemoteRevision: 0,
      profile: profile(ACTOR_ID),
    });
    await expect(
      epochOne.mutateCoordination({
        operationId: id(21),
        actorId: ACTOR_ID,
        taskRef: taskRef(),
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 0,
        ownershipFence: fence(id(21), 2),
        claims: [],
        handoffs: [],
        taskBundle: null,
      }),
    ).resolves.toMatchObject({ remoteRevision: 2, ownershipEpoch: 0 });
    await expect(
      epochOne.mutateCoordination({
        operationId: id(22),
        actorId: ACTOR_ID,
        taskRef: taskRef(),
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 0,
        ownershipFence: fence(id(22), 2),
        claims: [],
        handoffs: [],
        taskBundle: null,
      }),
    ).rejects.toThrow('MANCODE_TRANSPORT_REVISION_CONFLICT');
    await expect(
      epochOne.mutateCoordination({
        operationId: id(23),
        actorId: id(99),
        taskRef: taskRef(),
        expectedRemoteRevision: 2,
        expectedOwnershipEpoch: 0,
        ownershipFence: { ...fence(id(23), 3), ownerActorId: id(99) },
        claims: [],
        handoffs: [],
        taskBundle: null,
      }),
    ).rejects.toThrow('MANCODE_TRANSPORT_ACTOR_NOT_JOINED');
    await expect(
      epochOne.freezeCoordinationAuthority({
        operationId: id(24),
        actorId: ACTOR_ID,
        expectedRemoteRevision: 2,
        expectedPriorTransportEpoch: 1,
        successorMode: 'git-ref',
        successorEpoch: 2,
      }),
    ).resolves.toMatchObject({ remoteRevision: 3, transportEpoch: 1 });
    await expect(
      epochOne.publishActorProfile({
        operationId: id(25),
        expectedRemoteRevision: 3,
        profile: profile(id(5)),
      }),
    ).rejects.toThrow('MANCODE_TRANSPORT_AUTHORITY_NOT_ACTIVE');
    await expect(
      epochOne.unfreezeCoordinationAuthority({
        operationId: id(25),
        actorId: ACTOR_ID,
        expectedRemoteRevision: 3,
        expectedPriorTransportEpoch: 1,
        freezeOperationId: id(24),
      }),
    ).resolves.toMatchObject({ remoteRevision: 4, transportEpoch: 1 });
    await expect(
      epochOne.freezeCoordinationAuthority({
        operationId: id(26),
        actorId: ACTOR_ID,
        expectedRemoteRevision: 4,
        expectedPriorTransportEpoch: 1,
        successorMode: 'git-ref',
        successorEpoch: 2,
      }),
    ).resolves.toMatchObject({ remoteRevision: 5, transportEpoch: 1 });
    await expect(
      epochOne.tombstoneCoordinationAuthority({
        operationId: id(26),
        actorId: ACTOR_ID,
        expectedRemoteRevision: 5,
        expectedPriorTransportEpoch: 1,
        successorMode: 'git-ref',
        successorEpoch: 2,
      }),
    ).resolves.toMatchObject({ remoteRevision: 6, transportEpoch: 1 });
    await expect(
      epochOne.tombstoneCoordinationAuthority({
        operationId: id(26),
        actorId: ACTOR_ID,
        expectedRemoteRevision: 5,
        expectedPriorTransportEpoch: 1,
        successorMode: 'git-ref',
        successorEpoch: 2,
      }),
    ).resolves.toMatchObject({ remoteRevision: 6, transportEpoch: 1 });
    await expect(
      epochOne.publishActorProfile({
        operationId: id(27),
        expectedRemoteRevision: 6,
        profile: profile(id(5)),
      }),
    ).rejects.toThrow('MANCODE_TRANSPORT_AUTHORITY_NOT_ACTIVE');

    const epochTwo = store(fixture.clone, 2, 2);
    await expect(
      epochTwo.establishCoordinationAuthority({
        operationId: id(28),
        actorId: ACTOR_ID,
        expectedRemoteRevision: 6,
        expectedPriorTransportEpoch: 1,
        targetTransportEpoch: 2,
        actorProfiles: [profile(ACTOR_ID)],
        ownershipFences: [],
        claims: [],
        handoffs: [],
        taskBundles: [],
      }),
    ).resolves.toMatchObject({ remoteRevision: 7, transportEpoch: 2 });
    await expect(epochTwo.pull()).resolves.toMatchObject({
      manifest: {
        authorityState: 'active',
        authorityFreeze: null,
        authorityTombstone: null,
        transportEpoch: 2,
        revision: 7,
        lastMutation: { kind: 'authority_establish' },
      },
    });
    await epochTwo.freezeCoordinationAuthority({
      operationId: id(29),
      actorId: ACTOR_ID,
      expectedRemoteRevision: 7,
      expectedPriorTransportEpoch: 2,
      successorMode: 'local',
      successorEpoch: 3,
    });
    await epochTwo.tombstoneCoordinationAuthority({
      operationId: id(29),
      actorId: ACTOR_ID,
      expectedRemoteRevision: 8,
      expectedPriorTransportEpoch: 2,
      successorMode: 'local',
      successorEpoch: 3,
    });
    const epochFour = store(fixture.clone, 4, 4);
    await expect(
      epochFour.establishCoordinationAuthority({
        operationId: id(30),
        actorId: ACTOR_ID,
        expectedRemoteRevision: 9,
        expectedRemoteTransportEpoch: 2,
        expectedPriorTransportEpoch: 3,
        targetTransportEpoch: 4,
        actorProfiles: [profile(ACTOR_ID)],
        ownershipFences: [],
        claims: [],
        handoffs: [],
        taskBundles: [],
      }),
    ).resolves.toMatchObject({ remoteRevision: 10, transportEpoch: 4 });
  });

  it('derives remote identity from its URL rather than the local alias', async () => {
    const fixture = await createFixture();
    await execFile(
      'git',
      [
        'remote',
        'add',
        'credentialed',
        'https://user:password@example.com/team/repo.git',
      ],
      { cwd: fixture.clone },
    );
    await expect(
      Promise.all([
        resolveGitRefRemoteIdentityHash(fixture.clone, 'origin'),
        resolveGitRefRemoteIdentityHash(fixture.clone, fixture.remote),
      ]),
    ).resolves.toSatisfy(([fromAlias, fromUrl]: string[]) => {
      return fromAlias === fromUrl && /^sha256:[a-f0-9]{64}$/.test(fromAlias);
    });
    await expect(
      Promise.all([
        resolveGitRefRemoteIdentityHash(fixture.clone, 'credentialed'),
        resolveGitRefRemoteIdentityHash(
          fixture.clone,
          'https://example.com/team/repo.git',
        ),
      ]),
    ).resolves.toSatisfy(([credentialed, publicUrl]: string[]) => {
      return credentialed === publicUrl;
    });
  });

  it('rejects schema and version header mismatches before remote writes', async () => {
    const fixture = await createFixture();
    await store(fixture.clone, 1, 1).publishActorProfile({
      operationId: id(31),
      expectedRemoteRevision: 0,
      profile: profile(ACTOR_ID),
    });

    const mismatches: Array<
      [
        Partial<GitRefTeamManifestStoreOptions>,
        `MANCODE_TRANSPORT_${string}_MISMATCH`,
      ]
    > = [
      [{ schemaEpoch: id(99) }, 'MANCODE_TRANSPORT_SCHEMA_EPOCH_MISMATCH'],
      [
        { minReaderVersion: '0.4.0' },
        'MANCODE_TRANSPORT_MIN_READER_VERSION_MISMATCH',
      ],
      [
        { minWriterVersion: '0.4.0' },
        'MANCODE_TRANSPORT_MIN_WRITER_VERSION_MISMATCH',
      ],
    ];
    for (const [overrides, errorCode] of mismatches) {
      const incompatible = store(fixture.clone, 1, 1, overrides);
      await expect(incompatible.pull()).rejects.toThrowError(
        new RegExp(`^${errorCode}$`),
      );
      await expect(
        incompatible.publishActorProfile({
          operationId: id(32),
          expectedRemoteRevision: 1,
          profile: profile(id(5)),
        }),
      ).rejects.toThrowError(new RegExp(`^${errorCode}$`));
    }
  });
});

function store(
  projectRoot: string,
  transportEpoch: number,
  configRevision: number,
  overrides: Partial<GitRefTeamManifestStoreOptions> = {},
) {
  return new GitRefTeamManifestStore({
    projectRoot,
    remote: 'origin',
    workspaceId: WORKSPACE_ID,
    schemaEpoch: SCHEMA_EPOCH,
    minReaderVersion: '0.3.9',
    minWriterVersion: '0.3.9',
    transportEpoch,
    configRevision,
    configDigest: digest({ configRevision, transportEpoch }),
    now: () => new Date(NOW),
    ...overrides,
  });
}

function fence(operationId: string, remoteRevision: number) {
  return {
    schemaVersion: 1 as const,
    taskRef: taskRef(),
    ownerActorId: ACTOR_ID,
    ownershipEpoch: 0,
    taskRevision: 1,
    aggregateDigest: digest({ task: TASK_ID }),
    remoteRevision,
    lastOperationId: operationId,
    updatedAt: NOW,
  };
}

function taskRef() {
  return { namespace: 'shared' as const, taskId: TASK_ID };
}

function profile(actorId: string): SharedActorProfileV1 {
  return {
    schemaVersion: 1,
    actorId,
    displayName: `Actor ${actorId.slice(-4)}`,
    joinedAt: NOW,
    updatedAt: NOW,
  };
}

function bundleWithArtifact(
  relativePath: string,
  content: unknown,
  contentDigest: string,
) {
  const aggregate = {
    taskRef: taskRef(),
    taskRevision: 1,
    ownershipEpoch: 0,
    metadataDigest: digest('metadata'),
    requirementsDigest: digest('requirements'),
    reviewDigest: digest('review'),
    verificationDigest: digest('verification'),
    planVersion: 1,
    planDigest: null,
    latestCheckpointId: null,
    latestCheckpointDigest: null,
    parentSnapshotDigest: null,
  };
  return {
    schemaVersion: 1,
    taskRef: taskRef(),
    taskRevision: 1,
    ownershipEpoch: 0,
    aggregate,
    aggregateDigest: digest(aggregate),
    codeRef: { branch: 'main', head: 'a'.repeat(40) },
    artifacts: [{ kind: 'metadata', relativePath, content, contentDigest }],
    bundleDigest: digest('bundle'),
    createdAt: NOW,
  };
}

function digest(value: unknown): string {
  return digestCanonicalJson(value);
}

function id(value: number): string {
  return `01JZ4B6W5Z0A1B2C3D4E5F${value.toString().padStart(4, '0')}`;
}

async function createFixture(): Promise<{
  remote: string;
  clone: string;
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'mancode-git-ref-authority-'),
  );
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const clone = path.join(root, 'clone');
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['clone', remote, clone]);
  return { remote, clone };
}

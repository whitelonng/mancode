import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  teamTransportMigrate,
  teamTransportRecover,
} from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createV3Checkpoint } from '../src/context/checkpoint-create.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { listClaims } from '../src/runtime/claim-store.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import { acquireV3Claim } from '../src/team/claim-acquisition.js';
import { GitRefTeamManifestStore } from '../src/team/git-ref-transport.js';
import { handoffSuccessorClaimId } from '../src/team/handoff-operation.js';
import { createTransportMigrationFileAdapters } from '../src/team/transport-migration-adapters.js';
import {
  assertLocalCoordinationWriteAllowed,
  readLocalTransportAuthorityState,
} from '../src/team/transport-migration-freeze.js';
import type { TransportMigrationConfigAdapter } from '../src/team/transport-migration.js';
import {
  executeTransportMigration,
  recoverTransportMigration,
  stageTransportMigration,
} from '../src/team/transport-migration.js';
import { confirmManteamPlan } from './helpers/manteam-plan.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-18T02:00:00.000Z');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('filesystem and git-ref transport migration adapters', () => {
  it('repairs a visible local-to-git-ref config CAS and then migrates back to a fresh local authority', async () => {
    const fixture = await bootstrap();
    const firstOperationId = id(20);
    const first = await createTransportMigrationFileAdapters({
      projectRoot: fixture.projectRoot,
      actorId: fixture.actorId,
      targetMode: 'git-ref',
      targetRemote: 'origin',
      operationId: firstOperationId,
      now: () => NOW,
    });
    let crashAfterConfigWrite = true;
    const crashConfig: TransportMigrationConfigAdapter = {
      read: () => first.config.read(),
      compareAndSwap: async (input) => {
        const written = await first.config.compareAndSwap(input);
        if (crashAfterConfigWrite) {
          throw new Error('simulated process loss after filesystem config CAS');
        }
        return written;
      },
    };

    await expect(
      executeTransportMigration({
        ...first,
        config: crashConfig,
        operationId: firstOperationId,
        actorId: fixture.actorId,
        sessionId: fixture.sessionId,
        expectedConfigRevision: 1,
        joined: true,
        explicitConfirmation: true,
        now: NOW,
      }),
    ).rejects.toThrow('simulated process loss after filesystem config CAS');

    await expect(readProjectConfig(fixture.projectRoot)).resolves.toMatchObject(
      {
        revision: 2,
        transport: { mode: 'git-ref', remote: 'origin', epoch: 2 },
      },
    );
    await expect(
      readOperationJournal(first.operationStore, firstOperationId),
    ).resolves.toMatchObject({ state: 'repair_required' });
    await expect(
      readLocalTransportAuthorityState(first.operationStore),
    ).resolves.toMatchObject({
      state: 'frozen',
      operationId: firstOperationId,
      transportEpoch: 1,
    });

    crashAfterConfigWrite = false;
    const recoveredAdapters = await createTransportMigrationFileAdapters({
      projectRoot: fixture.projectRoot,
      actorId: fixture.actorId,
      targetMode: 'git-ref',
      targetRemote: 'origin',
      operationId: firstOperationId,
      now: () => NOW,
    });
    const recovered = await recoverTransportMigration({
      ...recoveredAdapters,
      operationId: firstOperationId,
      actorId: fixture.actorId,
      sessionId: fixture.sessionId,
    });
    expect(recovered).toMatchObject({
      state: 'repaired',
      journal: { state: 'committed' },
      activatedConfig: {
        revision: 2,
        transport: { mode: 'git-ref', epoch: 2 },
      },
      established: {
        transportEpoch: 2,
        activeClaims: [{ predecessorClaimId: fixture.claimId }],
      },
    });
    await expect(
      assertLocalCoordinationWriteAllowed(first.operationStore, 1),
    ).rejects.toThrow('MANCODE_TRANSPORT_AUTHORITY_TOMBSTONED');

    const remoteAfterFirst = await remoteSnapshot(fixture.projectRoot);
    expect(remoteAfterFirst).toMatchObject({
      authorityState: 'active',
      transportEpoch: 2,
      configRevision: 2,
      claims: [{ predecessorClaimId: fixture.claimId, state: 'active' }],
    });
    const remoteClaimId = remoteAfterFirst.claims[0]?.claimId;
    if (remoteClaimId === undefined) throw new Error('missing remote claim');
    expect(remoteClaimId).toBe(
      handoffSuccessorClaimId(
        firstOperationId,
        fixture.claimId,
        NOW.toISOString(),
      ),
    );

    const secondOperationId = id(21);
    const second = await createTransportMigrationFileAdapters({
      projectRoot: fixture.projectRoot,
      actorId: fixture.actorId,
      targetMode: 'local',
      operationId: secondOperationId,
      now: () => new Date(NOW.getTime() + 1_000),
    });
    const migratedBack = await executeTransportMigration({
      ...second,
      operationId: secondOperationId,
      actorId: fixture.actorId,
      sessionId: fixture.sessionId,
      expectedConfigRevision: 2,
      joined: true,
      explicitConfirmation: true,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(migratedBack).toMatchObject({
      journal: { state: 'committed' },
      activatedConfig: {
        revision: 3,
        transport: { mode: 'local', remote: null, epoch: 3 },
      },
      established: {
        transportEpoch: 3,
        activeClaims: [{ predecessorClaimId: remoteClaimId }],
      },
    });
    await expect(
      assertLocalCoordinationWriteAllowed(second.operationStore, 3),
    ).resolves.toBeUndefined();
    await expect(
      assertLocalCoordinationWriteAllowed(second.operationStore, 1),
    ).rejects.toThrow('MANCODE_TRANSPORT_MIGRATION_SPLIT_BRAIN');
    await expect(listClaims(second.operationStore)).resolves.toMatchObject([
      {
        claimId: handoffSuccessorClaimId(
          secondOperationId,
          remoteClaimId,
          new Date(NOW.getTime() + 1_000).toISOString(),
        ),
        state: 'active',
        predecessorClaimId: remoteClaimId,
        coordinationDomainId: second.target.coordinationDomainId,
        authority: { mode: 'local', remoteRevision: null },
      },
    ]);
    await expect(remoteSnapshot(fixture.projectRoot)).resolves.toMatchObject({
      authorityState: 'tombstoned',
      authorityTombstone: {
        operationId: secondOperationId,
        successorMode: 'local',
        successorEpoch: 3,
      },
    });
  });

  it('discards a durable staged target and unfreezes the local write fence on abort', async () => {
    const fixture = await bootstrap();
    const operationId = id(30);
    const adapters = await createTransportMigrationFileAdapters({
      projectRoot: fixture.projectRoot,
      actorId: fixture.actorId,
      targetMode: 'git-ref',
      targetRemote: 'origin',
      operationId,
      now: () => NOW,
    });
    await stageTransportMigration({
      ...adapters,
      operationId,
      actorId: fixture.actorId,
      sessionId: fixture.sessionId,
      expectedConfigRevision: 1,
      joined: true,
      explicitConfirmation: true,
      now: NOW,
    });
    await expect(
      assertLocalCoordinationWriteAllowed(adapters.operationStore, 1),
    ).rejects.toThrow('MANCODE_TRANSPORT_MIGRATION_FROZEN');
    await expect(
      createV3Checkpoint({
        projectRoot: fixture.projectRoot,
        taskRef: fixture.taskRef,
        sessionId: fixture.sessionId,
        expectedTaskRevision: fixture.taskRevision,
        kind: 'diagnostic_started',
        summary: 'This write must remain blocked during migration.',
        operationId: id(31),
        checkpointId: id(32),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_TRANSPORT_MIGRATION_FROZEN');
    await expect(
      createV3Workflow({
        projectRoot: fixture.projectRoot,
        task: 'This new shared task must not race transport migration.',
        workflowMode: 'manteam',
        sessionId: fixture.sessionId,
        client: 'vitest',
        taskId: id(33),
        operationId: id(34),
        sharedPrivacyConfirmed: true,
        implementationScope: { include: ['src/team/**'] },
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_TRANSPORT_MIGRATION_FROZEN');

    const rebuilt = await createTransportMigrationFileAdapters({
      projectRoot: fixture.projectRoot,
      actorId: fixture.actorId,
      targetMode: 'git-ref',
      targetRemote: 'origin',
      operationId,
      now: () => NOW,
    });
    await expect(
      recoverTransportMigration({
        ...rebuilt,
        operationId,
        actorId: fixture.actorId,
        sessionId: fixture.sessionId,
        mode: 'abort',
      }),
    ).resolves.toMatchObject({ state: 'aborted' });
    await expect(
      assertLocalCoordinationWriteAllowed(adapters.operationStore, 1),
    ).resolves.toBeUndefined();
    await expect(rebuilt.target.readStaged(operationId)).resolves.toBeNull();
    await expect(readProjectConfig(fixture.projectRoot)).resolves.toMatchObject(
      {
        revision: 1,
        transport: { mode: 'local', epoch: 1 },
      },
    );
  });

  it('exposes dry-run, safe abort, and committed migration through the team command', async () => {
    const fixture = await bootstrap();
    const dryRun = await captureJson(() =>
      teamTransportMigrate(fixture.projectRoot, {
        to: 'git-ref',
        remote: 'origin',
        expectedConfigRevision: '1',
        confirm: true,
        dryRun: true,
        session: fixture.sessionId,
        client: 'vitest',
        json: true,
      }),
    );
    expect(dryRun).toMatchObject({
      exitCode: 0,
      value: {
        dryRun: true,
        source: { config: { transport: { mode: 'local', epoch: 1 } } },
        target: { mode: 'git-ref', remote: 'origin', transportEpoch: 2 },
        taskCount: 1,
        activeClaimCount: 1,
      },
    });
    await expect(readProjectConfig(fixture.projectRoot)).resolves.toMatchObject(
      { revision: 1, transport: { mode: 'local', epoch: 1 } },
    );

    const abortedOperationId = id(40);
    const stagedAdapters = await createTransportMigrationFileAdapters({
      projectRoot: fixture.projectRoot,
      actorId: fixture.actorId,
      targetMode: 'git-ref',
      targetRemote: 'origin',
      operationId: abortedOperationId,
      now: () => NOW,
    });
    await stageTransportMigration({
      ...stagedAdapters,
      operationId: abortedOperationId,
      actorId: fixture.actorId,
      sessionId: fixture.sessionId,
      expectedConfigRevision: 1,
      joined: true,
      explicitConfirmation: true,
      now: NOW,
    });
    const aborted = await captureJson(() =>
      teamTransportRecover(fixture.projectRoot, abortedOperationId, {
        to: 'git-ref',
        remote: 'origin',
        abort: true,
        session: fixture.sessionId,
        client: 'vitest',
        json: true,
      }),
    );
    expect(aborted).toMatchObject({
      exitCode: 0,
      value: { result: { state: 'aborted', journal: { state: 'aborted' } } },
    });

    const migrated = await captureJson(() =>
      teamTransportMigrate(fixture.projectRoot, {
        to: 'git-ref',
        remote: 'origin',
        expectedConfigRevision: '1',
        confirm: true,
        session: fixture.sessionId,
        client: 'vitest',
        json: true,
      }),
    );
    expect(migrated).toMatchObject({
      exitCode: 0,
      value: {
        dryRun: false,
        target: { mode: 'git-ref', transportEpoch: 2 },
        config: { revision: 2, transport: { mode: 'git-ref', epoch: 2 } },
        authority: { transportEpoch: 2, activeClaims: [expect.any(Object)] },
        operation: { type: 'transport_migrate', state: 'committed' },
      },
    });
  });
});

interface Fixture {
  projectRoot: string;
  actorId: Ulid;
  sessionId: Ulid;
  claimId: Ulid;
  taskRef: TaskRef;
  taskRevision: number;
}

async function bootstrap(): Promise<Fixture> {
  const container = await mkdtemp(
    path.join(tmpdir(), 'mancode-migration-adapters-'),
  );
  roots.push(container);
  const projectRoot = path.join(container, 'project');
  const remote = path.join(container, 'remote.git');
  await mkdir(projectRoot);
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['init', '-b', 'main'], { cwd: projectRoot });
  await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
    cwd: projectRoot,
  });
  await execFile('git', ['config', 'user.name', 'Vitest'], {
    cwd: projectRoot,
  });
  await execFile('git', ['remote', 'add', 'origin', remote], {
    cwd: projectRoot,
  });
  await writeFile(path.join(projectRoot, 'README.md'), '# adapter fixture\n');
  await execFile('git', ['add', 'README.md'], { cwd: projectRoot });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: projectRoot });
  await execFile('git', ['push', '-u', 'origin', 'main'], { cwd: projectRoot });

  await initializeV3Project({
    projectRoot,
    operationId: id(1),
    workspaceId: id(2),
    schemaEpoch: id(3),
    now: NOW,
  });
  const actorId = id(4);
  const sessionId = id(5);
  const localActor = await createLocalActor(projectRoot, {
    actorId,
    displayName: 'Migration Adapter Owner',
    now: NOW,
  });
  await publishSharedActorProfile(
    projectRoot,
    createSharedActorProfile(localActor, NOW),
  );
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  const workflow = await createV3Workflow({
    projectRoot,
    task: 'Exercise both real transport migration authorities.',
    workflowMode: 'manteam',
    sessionId,
    client: 'vitest',
    taskId: id(10),
    operationId: id(11),
    sharedPrivacyConfirmed: true,
    implementationScope: { include: ['src/team/**'] },
    now: NOW,
  });
  const confirmed = await confirmManteamPlan({
    projectRoot,
    taskRef: workflow.taskRef,
    sessionId,
    requirements: workflow.requirements,
    now: NOW,
  });
  const claimId = id(12);
  await acquireV3Claim({
    projectRoot,
    taskRef: workflow.taskRef,
    sessionId,
    expectedTaskRevision: confirmed.taskRevision,
    scope: {
      paths: ['src/team/**'],
      modules: [],
      apis: [],
      schemas: [],
    },
    claimId,
    operationId: id(13),
    now: NOW,
  });
  return {
    projectRoot,
    actorId,
    sessionId,
    claimId,
    taskRef: workflow.taskRef,
    taskRevision: confirmed.taskRevision,
  };
}

async function remoteSnapshot(projectRoot: string) {
  const config = await readProjectConfig(projectRoot);
  const store = new GitRefTeamManifestStore({
    projectRoot,
    remote: 'origin',
    workspaceId: config.workspaceId,
  });
  const snapshot = await store.pull();
  if (snapshot.manifest === null) throw new Error('missing remote manifest');
  return snapshot.manifest;
}

async function readProjectConfig(projectRoot: string) {
  return JSON.parse(
    await readFile(
      path.join(projectRoot, '.mancode', 'shared', 'config.json'),
      'utf8',
    ),
  ) as {
    revision: number;
    workspaceId: Ulid;
    transport: {
      mode: 'local' | 'git-ref';
      remote: string | null;
      epoch: number;
    };
  };
}

async function captureJson(action: () => Promise<number>): Promise<{
  exitCode: number;
  value: Record<string, unknown>;
}> {
  const writes: string[] = [];
  const previous = console.log;
  console.log = (value: unknown) => writes.push(String(value));
  try {
    return {
      exitCode: await action(),
      value: JSON.parse(writes.at(-1) ?? '{}'),
    };
  } finally {
    console.log = previous;
  }
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

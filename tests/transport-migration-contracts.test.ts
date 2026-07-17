import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import type { Ulid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import {
  type EntityHomeStore,
  resolveCoordinationEntityHomeStore,
} from '../src/runtime/entity-home-store.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession } from '../src/runtime/session.js';
import { readTaskHeadFence } from '../src/runtime/task-head-store.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import type { ClaimV1 } from '../src/team/claims.js';
import { createGitRefTaskBundle } from '../src/team/git-ref-bundle.js';
import type { GitRefTaskBundleV1 } from '../src/team/git-ref-transport.js';
import type {
  CoordinationTransport,
  ProjectConfigV1,
} from '../src/team/policy.js';
import {
  type EstablishedTransportAuthorityV1,
  type StagedTransportAuthorityV1,
  type TransportAuthorityTombstoneV1,
  type TransportMigrationAuthoritySnapshotV1,
  type TransportMigrationConfigAdapter,
  type TransportMigrationManifestV1,
  type TransportMigrationSourceAdapter,
  type TransportMigrationStartInput,
  type TransportMigrationTargetAdapter,
  executeTransportMigration,
  previewTransportMigration,
  recoverTransportMigration,
  stageTransportMigration,
} from '../src/team/transport-migration.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H' as Ulid;
const CHECKOUT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J' as Ulid;
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K' as Ulid;
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M' as Ulid;
const SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N' as Ulid;
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7P' as Ulid;
const CLAIM_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7Q' as Ulid;
const TARGET_CLAIM_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7R' as Ulid;
const INIT_OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7S' as Ulid;
const SCHEMA_EPOCH = '01JZ4B6W5Z0A1B2C3D4E5F6G7T' as Ulid;
const WORKFLOW_OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7V' as Ulid;
const NOW = new Date('2026-07-18T01:00:00.000Z');
const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('journaled transport migration', () => {
  it('previews without writes and stages under a durable freeze without switching config', async () => {
    const fixture = await migrationFixture('local', 'git-ref');

    const preview = await previewTransportMigration(fixture.input);
    expect(preview.manifest.target).toMatchObject({
      mode: 'git-ref',
      transportEpoch: 2,
      coordinationDomainId: fixture.target.coordinationDomainId,
    });
    expect(fixture.events).toEqual([]);
    await expect(
      readOperationJournal(fixture.store, OPERATION_ID),
    ).resolves.toBeNull();

    const staged = await stageTransportMigration(fixture.input);
    expect(staged.journal).toMatchObject({
      state: 'applying',
      steps: [
        { id: 'freeze-shared-coordination-writes', state: 'completed' },
        { id: 'validate-old-authority', state: 'completed' },
        { id: 'stage-new-authority', state: 'completed' },
        { id: 'establish-new-epoch', state: 'pending' },
        { id: 'switch-config-authority', state: 'pending' },
        { id: 'commit', state: 'pending' },
      ],
    });
    expect(fixture.config.current.transport).toEqual({
      mode: 'local',
      remote: null,
      epoch: 1,
    });
    expect(fixture.source.frozen).toBe(true);
    expect(fixture.events).toEqual(['freeze', 'stage']);
  });

  it.each([
    ['local', 'git-ref'],
    ['git-ref', 'local'],
  ] as const)(
    'switches %s to %s only after establishment and tombstones the old authority',
    async (sourceMode, targetMode) => {
      const fixture = await migrationFixture(sourceMode, targetMode);
      const result = await executeTransportMigration(fixture.input);

      expect(result.journal.state).toBe('committed');
      expect(result.activatedConfig).toMatchObject({
        revision: 2,
        lastOperationId: OPERATION_ID,
        transport: {
          mode: targetMode,
          remote: targetMode === 'git-ref' ? 'origin' : null,
          epoch: 2,
        },
      });
      expect(result.established.activeClaims).toHaveLength(1);
      expect(result.established.activeClaims[0]).toMatchObject({
        claimId: TARGET_CLAIM_ID,
        predecessorClaimId: CLAIM_ID,
        coordinationDomainId: fixture.target.coordinationDomainId,
        authority: { mode: targetMode },
      });
      expect(fixture.events).toEqual([
        'freeze',
        'stage',
        'establish',
        'config-cas',
        'tombstone',
      ]);
      expect(fixture.source.tombstone).toMatchObject({
        operationId: OPERATION_ID,
        targetTransportEpoch: 2,
        activatedConfigRevision: 2,
      });
    },
  );

  it('can discard a staged authority and unfreeze before config activation', async () => {
    const fixture = await migrationFixture('local', 'git-ref');
    await stageTransportMigration(fixture.input);

    const recovered = await recoverTransportMigration({
      ...fixture.recovery,
      mode: 'abort',
    });

    expect(recovered.state).toBe('aborted');
    expect(fixture.source.frozen).toBe(false);
    expect(fixture.target.staged).toBeNull();
    expect(fixture.events).toEqual(['freeze', 'stage', 'discard', 'unfreeze']);
    expect(fixture.config.current.transport.mode).toBe('local');
  });

  it('repairs forward when config became visible before the writer crashed', async () => {
    const fixture = await migrationFixture('local', 'git-ref');
    fixture.config.throwAfterWrite = true;

    await expect(executeTransportMigration(fixture.input)).rejects.toThrow(
      'simulated crash after config CAS',
    );
    expect(fixture.config.current.transport).toMatchObject({
      mode: 'git-ref',
      epoch: 2,
    });
    await expect(
      readOperationJournal(fixture.store, OPERATION_ID),
    ).resolves.toMatchObject({ state: 'repair_required' });
    await expect(
      recoverTransportMigration({ ...fixture.recovery, mode: 'abort' }),
    ).rejects.toThrow('MANCODE_OPERATION_ABORT_UNSAFE');

    fixture.config.throwAfterWrite = false;
    const recovered = await recoverTransportMigration(fixture.recovery);
    expect(recovered).toMatchObject({
      state: 'repaired',
      journal: { state: 'committed' },
      activatedConfig: { transport: { mode: 'git-ref', epoch: 2 } },
    });
    expect(
      fixture.events.filter((event) => event === 'config-cas'),
    ).toHaveLength(1);
    expect(fixture.events.at(-1)).toBe('tombstone');
  });

  it('recovers every declared transport migration crash point', async () => {
    for (const crashFixture of OPERATION_CRASH_FIXTURES.transport_migrate) {
      const fixture = await migrationFixture('local', 'git-ref');

      await expect(
        withOperationCrashInjectionForTesting(crashFixture, () =>
          executeTransportMigration(fixture.input),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      if (crashFixture.crashAfter === 'commit') {
        await expect(
          recoverTransportMigration(fixture.recovery),
        ).resolves.toMatchObject({
          state: 'already_committed',
          journal: { state: 'committed' },
        });
      } else if (crashFixture.expectedRecovery === 'safe_abort') {
        await expect(
          recoverTransportMigration({ ...fixture.recovery, mode: 'abort' }),
        ).resolves.toMatchObject({
          state: 'aborted',
          journal: { state: 'aborted' },
        });
        expect(fixture.source.frozen).toBe(false);
        expect(fixture.config.current.transport.mode).toBe('local');
      } else {
        await expect(
          recoverTransportMigration(fixture.recovery),
        ).resolves.toMatchObject({
          state: 'repaired',
          journal: { state: 'committed' },
          activatedConfig: { transport: { mode: 'git-ref', epoch: 2 } },
        });
      }
    }
  });

  it('rejects pending source operations before freezing or staging', async () => {
    const fixture = await migrationFixture('local', 'git-ref');
    fixture.source.snapshot.pendingOperationIds = [
      '01JZ4B6W5Z0A1B2C3D4E5F6G7S' as Ulid,
    ];

    await expect(previewTransportMigration(fixture.input)).rejects.toThrow(
      'MANCODE_OPERATION_REPAIR_REQUIRED',
    );
    expect(fixture.events).toEqual([]);
  });

  it('applies authorization and confirmation gates during dry-run', async () => {
    const fixture = await migrationFixture('local', 'git-ref');
    fixture.input.explicitConfirmation = false;

    await expect(previewTransportMigration(fixture.input)).rejects.toThrow(
      'MANCODE_EXPLICIT_CONFIRMATION_REQUIRED',
    );
    expect(fixture.events).toEqual([]);
    await expect(
      readOperationJournal(fixture.store, OPERATION_ID),
    ).resolves.toBeNull();
  });
});

interface Fixture {
  input: TransportMigrationStartInput;
  recovery: Omit<Parameters<typeof recoverTransportMigration>[0], 'mode'>;
  store: EntityHomeStore;
  source: MemorySource;
  target: MemoryTarget;
  config: MemoryConfig;
  events: string[];
}

async function migrationFixture(
  sourceMode: CoordinationTransport,
  targetMode: CoordinationTransport,
): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(tmpdir(), 'mancode-transport-migration-'),
  );
  roots.push(root);
  const events: string[] = [];
  await initializeGitFixture(root);
  await initializeV3Project({
    projectRoot: root,
    operationId: INIT_OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    schemaEpoch: SCHEMA_EPOCH,
    now: NOW,
  });
  const actor = await createLocalActor(root, {
    actorId: ACTOR_ID,
    displayName: 'Migration Owner',
    now: NOW,
  });
  const actorProfile = await publishSharedActorProfile(
    root,
    createSharedActorProfile(actor, NOW),
  );
  await createSession(root, {
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  const workflow = await createV3Workflow({
    projectRoot: root,
    task: 'Migrate a stable shared coordination authority.',
    workflowMode: 'manteam',
    sessionId: SESSION_ID,
    client: 'vitest',
    taskId: TASK_ID,
    operationId: WORKFLOW_OPERATION_ID,
    sharedPrivacyConfirmed: true,
    implementationScope: { include: ['src/team/**'] },
    now: NOW,
  });
  const runtime = await readProjectRuntimeContext(root);
  const coordinationStore = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const task = await new V3ContextStore(root).readTaskSnapshot(
    workflow.taskRef,
  );
  const taskHeadFence = await readTaskHeadFence(
    coordinationStore,
    workflow.taskRef,
  );
  if (taskHeadFence === null)
    throw new Error('missing fixture task-head fence');
  const codeHead = taskHeadFence.codeRef.head;
  const taskBundle = createGitRefTaskBundle({
    task,
    codeRef: { branch: 'main', head: codeHead },
    now: NOW,
  });
  const store: EntityHomeStore = {
    kind: 'non_git_shared',
    storeId: `non-git:${WORKSPACE_ID}`,
    root: path.join(root, 'migration-operation-store'),
    workspaceId: WORKSPACE_ID,
    checkoutId: null,
    repositoryBindingId: null,
  };
  const sourceRemote = sourceMode === 'git-ref' ? 'origin' : null;
  const targetRemote = targetMode === 'git-ref' ? 'origin' : null;
  const sourceDomain = domain(sourceMode, 1);
  const targetDomain = domain(targetMode, 2);
  const config = new MemoryConfig(
    {
      schemaVersion: 1,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      transport: { mode: sourceMode, remote: sourceRemote, epoch: 1 },
      lastOperationId: null,
      updatedAt: NOW.toISOString(),
    },
    events,
  );
  const source = new MemorySource(
    sourceMode,
    sourceRemote,
    sourceDomain,
    authoritySnapshot(
      sourceMode,
      sourceDomain,
      taskBundle,
      taskHeadFence,
      actorProfile,
    ),
    events,
  );
  const target = new MemoryTarget(
    targetMode,
    targetRemote,
    targetDomain,
    events,
  );
  const input: TransportMigrationStartInput = {
    operationStore: store,
    config,
    source,
    target,
    operationId: OPERATION_ID,
    checkoutId: CHECKOUT_ID,
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    expectedConfigRevision: 1,
    joined: true,
    explicitConfirmation: true,
    now: NOW,
  };
  return {
    input,
    recovery: {
      operationStore: store,
      config,
      source,
      target,
      operationId: OPERATION_ID,
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    },
    store,
    source,
    target,
    config,
    events,
  };
}

class MemoryConfig implements TransportMigrationConfigAdapter {
  throwAfterWrite = false;

  constructor(
    public current: ProjectConfigV1,
    private readonly events: string[],
  ) {}

  async read(): Promise<unknown> {
    return structuredClone(this.current);
  }

  async compareAndSwap(input: {
    expectedRevision: number;
    expectedTransportEpoch: number;
    next: ProjectConfigV1;
  }): Promise<unknown> {
    if (
      this.current.revision !== input.expectedRevision ||
      this.current.transport.epoch !== input.expectedTransportEpoch
    ) {
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    this.events.push('config-cas');
    this.current = structuredClone(input.next);
    if (this.throwAfterWrite)
      throw new Error('simulated crash after config CAS');
    return structuredClone(this.current);
  }
}

class MemorySource implements TransportMigrationSourceAdapter {
  readonly authorityId: string;
  frozen = false;
  frozenBy: Ulid | null = null;
  tombstone: TransportAuthorityTombstoneV1 | null = null;

  constructor(
    readonly mode: CoordinationTransport,
    readonly remote: string | null,
    coordinationDomainId: string,
    public snapshot: TransportMigrationAuthoritySnapshotV1,
    private readonly events: string[],
  ) {
    this.authorityId = `${mode}-authority`;
    this.snapshot.authorityId = this.authorityId;
    this.snapshot.coordinationDomainId = coordinationDomainId;
  }

  async freeze(input: { operationId: Ulid }): Promise<void> {
    if (
      this.tombstone !== null &&
      this.tombstone.operationId === input.operationId
    ) {
      return;
    }
    if (this.frozenBy !== null && this.frozenBy !== input.operationId) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_FREEZE_CONFLICT');
    }
    if (!this.frozen) this.events.push('freeze');
    this.frozen = true;
    this.frozenBy = input.operationId;
  }

  async assertFrozen(input: { operationId: Ulid }): Promise<void> {
    if (
      this.tombstone?.operationId !== input.operationId &&
      (!this.frozen || this.frozenBy !== input.operationId)
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_NOT_FROZEN');
    }
  }

  async inspect(): Promise<unknown> {
    return structuredClone(this.snapshot);
  }

  async unfreeze(input: { operationId: Ulid }): Promise<void> {
    if (this.frozenBy !== null && this.frozenBy !== input.operationId) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_FREEZE_CONFLICT');
    }
    if (this.frozen) this.events.push('unfreeze');
    this.frozen = false;
    this.frozenBy = null;
  }

  async writeTombstone(
    tombstone: TransportAuthorityTombstoneV1,
  ): Promise<void> {
    if (
      this.tombstone !== null &&
      digestCanonicalJson(this.tombstone) !== digestCanonicalJson(tombstone)
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_TOMBSTONE_CONFLICT');
    }
    if (this.tombstone === null) this.events.push('tombstone');
    this.tombstone = structuredClone(tombstone);
    this.frozen = true;
    this.frozenBy = tombstone.operationId;
  }
}

class MemoryTarget implements TransportMigrationTargetAdapter {
  readonly authorityId: string;
  staged: StagedTransportAuthorityV1 | null = null;
  established: EstablishedTransportAuthorityV1 | null = null;

  constructor(
    readonly mode: CoordinationTransport,
    readonly remote: string | null,
    readonly coordinationDomainId: string,
    private readonly events: string[],
  ) {
    this.authorityId = `${mode}-target-authority`;
  }

  async stage(manifest: TransportMigrationManifestV1): Promise<unknown> {
    const staged: StagedTransportAuthorityV1 = {
      schemaVersion: 1,
      operationId: manifest.operationId,
      manifest: structuredClone(manifest),
      manifestDigest: digestCanonicalJson(manifest),
      transportEpoch: manifest.target.transportEpoch,
      coordinationDomainId: manifest.target.coordinationDomainId,
      stagedAt: manifest.createdAt,
    };
    if (this.staged === null) this.events.push('stage');
    this.staged = staged;
    return structuredClone(staged);
  }

  async readStaged(): Promise<unknown | null> {
    return structuredClone(this.staged);
  }

  async establish(manifest: TransportMigrationManifestV1): Promise<unknown> {
    if (this.established === null) this.events.push('establish');
    const activeClaims = manifest.sourceClaims
      .filter((claim) => claim.state === 'active')
      .map((claim) => reissuedClaim(claim, manifest));
    this.established = {
      schemaVersion: 1,
      operationId: manifest.operationId,
      manifestDigest: digestCanonicalJson(manifest),
      transportEpoch: manifest.target.transportEpoch,
      coordinationDomainId: manifest.target.coordinationDomainId,
      authorityRevision: 1,
      activeClaims,
      receipt: `receipt:${manifest.operationId}`,
      establishedAt: manifest.createdAt,
    };
    return structuredClone(this.established);
  }

  async readEstablished(): Promise<unknown | null> {
    return structuredClone(this.established);
  }

  async discard(): Promise<void> {
    this.events.push('discard');
    this.staged = null;
    this.established = null;
  }
}

function authoritySnapshot(
  mode: CoordinationTransport,
  coordinationDomainId: string,
  taskBundle: GitRefTaskBundleV1,
  taskHeadFence: TransportMigrationAuthoritySnapshotV1['tasks'][number]['taskHeadFence'],
  actorProfile: TransportMigrationAuthoritySnapshotV1['actorProfiles'][number],
): TransportMigrationAuthoritySnapshotV1 {
  const aggregateDigest = taskBundle.aggregateDigest;
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    authorityId: `${mode}-authority`,
    transportMode: mode,
    transportEpoch: 1,
    coordinationDomainId,
    pendingOperationIds: [],
    actorProfiles: [actorProfile],
    tasks: [
      {
        taskRef: taskBundle.taskRef,
        transitionState: 'stable',
        taskRevision: taskBundle.taskRevision,
        ownerActorId: ACTOR_ID,
        ownershipEpoch: taskBundle.ownershipEpoch,
        aggregateDigest,
        taskHeadFence: {
          ...taskHeadFence,
          aggregateDigest,
          remoteRevision: mode === 'git-ref' ? 1 : null,
        },
      },
    ],
    taskBundles: [taskBundle],
    claims: [claim(mode, coordinationDomainId, taskBundle)],
    handoffs: [],
  };
}

function claim(
  mode: CoordinationTransport,
  coordinationDomainId: string,
  taskBundle: GitRefTaskBundleV1,
): ClaimV1 {
  const scope = { paths: ['src/team/**'], modules: [], apis: [], schemas: [] };
  return {
    schemaVersion: 1,
    claimId: CLAIM_ID,
    workspaceId: WORKSPACE_ID,
    coordinationDomainId,
    authority: {
      mode,
      remoteRevision: mode === 'git-ref' ? 'remote:1' : null,
    },
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    taskRevisionAtAcquire: taskBundle.taskRevision,
    lastValidatedTaskRevision: taskBundle.taskRevision,
    implementationScopeDigest: `sha256:${'b'.repeat(64)}`,
    ownershipEpochAtAcquire: taskBundle.ownershipEpoch,
    ownerActorId: ACTOR_ID,
    state: 'active',
    revision: 1,
    scope,
    scopeDigest: digestCanonicalJson(scope),
    codeRefAtAcquire: { branch: 'main', head: taskBundle.codeRef.head },
    lastValidatedCodeRef: { branch: 'main', head: taskBundle.codeRef.head },
    acquisitionEnforcement: 'enforced',
    writeGuard: 'advisory',
    expiresAt: '2026-07-19T01:00:00.000Z',
    predecessorClaimId: null,
    successorClaimId: null,
    lastOperationId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function reissuedClaim(
  source: ClaimV1,
  manifest: TransportMigrationManifestV1,
): ClaimV1 {
  return {
    ...structuredClone(source),
    claimId: TARGET_CLAIM_ID,
    coordinationDomainId: manifest.target.coordinationDomainId,
    authority: {
      mode: manifest.target.mode,
      remoteRevision: manifest.target.mode === 'git-ref' ? 'remote:2' : null,
    },
    revision: 1,
    predecessorClaimId: source.claimId,
    lastOperationId: manifest.operationId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
  };
}

function domain(mode: CoordinationTransport, epoch: number): string {
  return mode === 'git-ref'
    ? `git-ref:remotehash:${WORKSPACE_ID}:${epoch}`
    : `local:binding:${WORKSPACE_ID}`;
}

async function initializeGitFixture(root: string): Promise<void> {
  await execFile('git', ['init', '-b', 'main'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
    cwd: root,
  });
  await execFile('git', ['config', 'user.name', 'Vitest'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# migration fixture\n');
  await execFile('git', ['add', 'README.md'], { cwd: root });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: root });
}

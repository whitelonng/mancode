import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { V3ContextStore } from '../context/store.js';
import type { TaskRef } from '../context/task-ref.js';
import { parseWorkflowMetadata } from '../context/workflow-metadata.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { createClaim, listClaims } from '../runtime/claim-store.js';
import {
  type EntityHomeStore,
  claimDirectory,
  handoffDirectory,
  resolveCoordinationEntityHomeStore,
  taskHeadDirectory,
} from '../runtime/entity-home-store.js';
import { createHandoff, listHandoffs } from '../runtime/handoff-store.js';
import { acquireEntityLocks } from '../runtime/local-lock.js';
import { listUnfinishedOperationJournals } from '../runtime/operation-store.js';
import {
  readCheckoutBranch,
  readProjectRuntimeContext,
} from '../runtime/project-runtime.js';
import { parseTaskHeadFence } from '../runtime/task-head-fence.js';
import {
  readTaskHeadFence,
  replaceTaskHeadFence,
} from '../runtime/task-head-store.js';
import {
  gitRefCoordinationDomainId,
  localCoordinationDomainId,
} from '../runtime/workspace-binding.js';
import {
  publishSharedActorProfile,
  readSharedActorProfile,
  sharedActorProfileDirectory,
} from './actor.js';
import { checkpointDigest, parseCheckpoint } from './checkpoints.js';
import { type ClaimV1, parseClaim } from './claims.js';
import {
  assertGitRefBundleCodeReachable,
  createGitRefTaskBundle,
} from './git-ref-bundle.js';
import { materializeGitRefTaskBundle } from './git-ref-materialization.js';
import {
  type GitRefOwnershipFenceV1,
  type GitRefTaskBundleV1,
  GitRefTeamManifestStore,
  type GitRefTeamManifestV1,
  resolveGitRefRemoteIdentityHash,
} from './git-ref-transport.js';
import { handoffSuccessorClaimId } from './handoff-operation.js';
import { type HandoffV1, parseHandoff } from './handoff.js';
import {
  type CoordinationTransport,
  type ProjectConfigV1,
  assertProjectConfigTransition,
  parseProjectConfig,
  projectConfigDigest,
} from './policy.js';
import {
  type LocalTransportAuthorityStateV1,
  parseTransportAuthorityTombstone,
  readLocalTransportAuthorityState,
  writeLocalTransportAuthorityState,
} from './transport-migration-freeze.js';
import {
  type EstablishedTransportAuthorityV1,
  type StagedTransportAuthorityV1,
  type TransportAuthorityTombstoneV1,
  type TransportMigrationAuthoritySnapshotV1,
  type TransportMigrationConfigAdapter,
  type TransportMigrationManifestV1,
  type TransportMigrationSourceAdapter,
  type TransportMigrationTargetAdapter,
  parseEstablishedTransportAuthority,
  parseStagedTransportAuthority,
  parseTransportMigrationManifest,
} from './transport-migration.js';

const STAGE_DIRECTORY = 'transport-migrations';
const COLLECTIONS = ['claims', 'handoffs', 'task-heads'] as const;

export {
  type LocalTransportAuthorityStateV1,
  assertLocalCoordinationWriteAllowed,
  localTransportAuthorityStatePath,
  parseLocalTransportAuthorityState,
  readLocalTransportAuthorityState,
} from './transport-migration-freeze.js';

export interface CreateTransportMigrationFileAdaptersInput {
  projectRoot: string;
  actorId: Ulid;
  targetMode: CoordinationTransport;
  targetRemote?: string | null;
  /** Allows recovery to bind adapters from the durable stage after config CAS. */
  operationId?: Ulid;
  now?: () => Date;
}

export interface TransportMigrationFileAdapters {
  operationStore: EntityHomeStore;
  checkoutId: Ulid;
  config: FileSystemTransportMigrationConfigAdapter;
  source: TransportMigrationSourceAdapter;
  target: TransportMigrationTargetAdapter;
}

interface AdapterContext {
  projectRoot: string;
  actorId: Ulid;
  operationStore: EntityHomeStore;
  checkoutId: Ulid;
  repositoryBindingId: Ulid | null;
  schemaEpoch: Ulid;
  minReaderVersion: string;
  minWriterVersion: string;
  sourceConfig: ProjectConfigV1;
  targetMode: CoordinationTransport;
  targetRemote: string | null;
  now: () => Date;
}

/**
 * Builds the real filesystem/git-ref adapter pair used by execute and recover.
 * Recovery reads the staged manifest first, so a visible config switch cannot
 * accidentally reverse source and target.
 */
export async function createTransportMigrationFileAdapters(
  input: CreateTransportMigrationFileAdaptersInput,
): Promise<TransportMigrationFileAdapters> {
  const projectRoot = path.resolve(input.projectRoot);
  assertUlid(input.actorId, 'transport migration adapter actorId');
  if (input.operationId !== undefined) {
    assertUlid(input.operationId, 'transport migration adapter operationId');
  }
  const runtime = await readProjectRuntimeContext(projectRoot);
  const operationStore = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const project = await new V3ContextStore(projectRoot).readProjectSnapshot();
  const staged =
    input.operationId === undefined
      ? null
      : await readStagedRecord(operationStore, input.operationId);
  const sourceConfig = staged?.manifest.source.config ?? project.config;
  const targetMode = staged?.manifest.target.mode ?? input.targetMode;
  const targetRemote =
    staged?.manifest.target.remote ??
    normalizeTargetRemote(targetMode, input.targetRemote);
  if (
    targetMode !== input.targetMode ||
    (input.targetRemote !== undefined &&
      normalizeTargetRemote(input.targetMode, input.targetRemote) !==
        targetRemote)
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_CONFLICT');
  }
  if (sourceConfig.transport.mode === targetMode) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_MODE_UNCHANGED');
  }
  const context: AdapterContext = {
    projectRoot,
    actorId: input.actorId,
    operationStore,
    checkoutId: runtime.checkoutId,
    repositoryBindingId: runtime.repositoryBindingId,
    schemaEpoch: project.manifest.epoch,
    minReaderVersion: project.manifest.minReaderVersion,
    minWriterVersion: project.manifest.minWriterVersion,
    sourceConfig,
    targetMode,
    targetRemote,
    now: input.now ?? (() => new Date()),
  };
  const [source, target] = await Promise.all([
    createSourceAdapter(context),
    createTargetAdapter(context),
  ]);
  return {
    operationStore,
    checkoutId: runtime.checkoutId,
    config: new FileSystemTransportMigrationConfigAdapter(
      projectRoot,
      operationStore,
    ),
    source,
    target,
  };
}

export class FileSystemTransportMigrationConfigAdapter
  implements TransportMigrationConfigAdapter
{
  readonly projectRoot: string;

  constructor(
    projectRoot: string,
    private readonly coordinationStore: EntityHomeStore,
  ) {
    this.projectRoot = path.resolve(projectRoot);
  }

  async read(): Promise<unknown> {
    return readProjectConfigFile(this.projectRoot);
  }

  async compareAndSwap(input: {
    expectedRevision: number;
    expectedTransportEpoch: number;
    next: ProjectConfigV1;
  }): Promise<unknown> {
    const next = parseProjectConfig(input.next);
    if (next.workspaceId !== this.coordinationStore.workspaceId) {
      throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
    }
    const lockId = createUlid();
    const locks = await acquireEntityLocks(this.coordinationStore, lockId, [
      `config:${next.workspaceId}`,
    ]);
    try {
      const current = await readProjectConfigFile(this.projectRoot);
      if (current.workspaceId !== this.coordinationStore.workspaceId) {
        throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
      }
      if (digestCanonicalJson(current) === digestCanonicalJson(next)) {
        return current;
      }
      if (
        current.revision !== input.expectedRevision ||
        current.transport.epoch !== input.expectedTransportEpoch
      ) {
        throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
      }
      assertProjectConfigTransition(current, next, 'transport_migrate');
      await writeJsonAtomic(projectConfigPath(this.projectRoot), next);
      return readProjectConfigFile(this.projectRoot);
    } finally {
      await Promise.allSettled(
        [...locks].reverse().map((lock) => lock.release()),
      );
    }
  }
}

class LocalTransportMigrationSourceAdapter
  implements TransportMigrationSourceAdapter
{
  readonly mode = 'local' as const;
  readonly remote = null;

  constructor(
    private readonly context: AdapterContext,
    readonly authorityId: string,
    private readonly coordinationDomainId: string,
  ) {}

  async freeze(input: {
    operationId: Ulid;
    expectedTransportEpoch: number;
  }): Promise<void> {
    assertUlid(input.operationId, 'local authority freeze operationId');
    await this.withAuthorityLock(input.operationId, async () => {
      const current = await readLocalTransportAuthorityState(
        this.context.operationStore,
      );
      if (isTombstoneRetry(current, input.operationId)) return;
      if (current?.state === 'frozen') {
        assertLocalStateIdentity(
          current,
          this.context.sourceConfig.workspaceId,
          this.authorityId,
          this.coordinationDomainId,
          input.expectedTransportEpoch,
        );
        if (
          current.operationId === input.operationId &&
          current.successorMode === this.context.targetMode &&
          current.successorEpoch === input.expectedTransportEpoch + 1
        ) {
          return;
        }
        throw new Error('MANCODE_TRANSPORT_MIGRATION_FREEZE_CONFLICT');
      }
      if (current !== null) {
        assertLocalStateIdentity(
          current,
          this.context.sourceConfig.workspaceId,
          this.authorityId,
          this.coordinationDomainId,
          input.expectedTransportEpoch,
        );
        if (current.state !== 'active') {
          throw new Error('MANCODE_TRANSPORT_MIGRATION_FREEZE_CONFLICT');
        }
      } else if (
        input.expectedTransportEpoch !==
        this.context.sourceConfig.transport.epoch
      ) {
        throw new Error('MANCODE_TRANSPORT_EPOCH_CONFLICT');
      }
      await writeLocalTransportAuthorityState(this.context.operationStore, {
        schemaVersion: 1,
        workspaceId: this.context.sourceConfig.workspaceId,
        authorityId: this.authorityId,
        coordinationDomainId: this.coordinationDomainId,
        transportEpoch: input.expectedTransportEpoch,
        state: 'frozen',
        operationId: input.operationId,
        successorMode: this.context.targetMode,
        successorEpoch: input.expectedTransportEpoch + 1,
        tombstone: null,
        updatedAt: this.context.now().toISOString(),
      });
    });
  }

  async assertFrozen(input: {
    operationId: Ulid;
    expectedTransportEpoch: number;
  }): Promise<void> {
    const current = await readLocalTransportAuthorityState(
      this.context.operationStore,
    );
    if (current === null) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_NOT_FROZEN');
    }
    assertLocalStateIdentity(
      current,
      this.context.sourceConfig.workspaceId,
      this.authorityId,
      this.coordinationDomainId,
      input.expectedTransportEpoch,
    );
    if (
      current.operationId !== input.operationId ||
      (current.state !== 'frozen' && current.state !== 'tombstoned')
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_NOT_FROZEN');
    }
  }

  async inspect(): Promise<unknown> {
    const current = await readLocalTransportAuthorityState(
      this.context.operationStore,
    );
    if (current !== null) {
      assertLocalStateIdentity(
        current,
        this.context.sourceConfig.workspaceId,
        this.authorityId,
        this.coordinationDomainId,
        this.context.sourceConfig.transport.epoch,
      );
      if (current.state === 'tombstoned') {
        throw new Error('MANCODE_TRANSPORT_AUTHORITY_TOMBSTONED');
      }
    }
    const [actorProfiles, taskRefs, claims, handoffs, pending, branch] =
      await Promise.all([
        listActorProfiles(this.context.projectRoot),
        listSharedTaskRefs(this.context.projectRoot),
        listClaims(this.context.operationStore),
        listHandoffs(this.context.operationStore),
        listUnfinishedOperationJournals(this.context.operationStore),
        readCheckoutBranch(this.context.projectRoot),
      ]);
    const tasks = await Promise.all(
      taskRefs.map((taskRef) => this.localTaskSnapshot(taskRef, branch)),
    );
    return {
      schemaVersion: 1,
      workspaceId: this.context.sourceConfig.workspaceId,
      authorityId: this.authorityId,
      transportMode: 'local',
      transportEpoch: this.context.sourceConfig.transport.epoch,
      coordinationDomainId: this.coordinationDomainId,
      pendingOperationIds: pending.map((journal) => journal.operationId),
      actorProfiles,
      tasks: tasks.map((item) => item.task),
      taskBundles: tasks.map((item) => item.bundle),
      claims,
      handoffs,
    } satisfies TransportMigrationAuthoritySnapshotV1;
  }

  async unfreeze(input: { operationId: Ulid }): Promise<void> {
    await this.withAuthorityLock(input.operationId, async () => {
      const current = await readLocalTransportAuthorityState(
        this.context.operationStore,
      );
      if (current === null) return;
      if (
        current.state === 'active' &&
        current.operationId === input.operationId
      ) {
        return;
      }
      if (
        current.state !== 'frozen' ||
        current.operationId !== input.operationId
      ) {
        throw new Error('MANCODE_TRANSPORT_MIGRATION_FREEZE_CONFLICT');
      }
      await writeLocalTransportAuthorityState(this.context.operationStore, {
        ...current,
        state: 'active',
        successorMode: null,
        successorEpoch: null,
        updatedAt: this.context.now().toISOString(),
      });
    });
  }

  async writeTombstone(
    tombstone: TransportAuthorityTombstoneV1,
  ): Promise<void> {
    const parsed = parseTransportAuthorityTombstone(tombstone);
    await this.withAuthorityLock(parsed.operationId, async () => {
      const current = await readLocalTransportAuthorityState(
        this.context.operationStore,
      );
      if (
        current?.state === 'tombstoned' &&
        digestCanonicalJson(current.tombstone) === digestCanonicalJson(parsed)
      ) {
        return;
      }
      if (
        current === null ||
        current.state !== 'frozen' ||
        current.operationId !== parsed.operationId ||
        current.transportEpoch !== parsed.sourceTransportEpoch ||
        current.authorityId !== parsed.sourceAuthorityId
      ) {
        throw new Error('MANCODE_TRANSPORT_MIGRATION_TOMBSTONE_CONFLICT');
      }
      await writeLocalTransportAuthorityState(this.context.operationStore, {
        ...current,
        state: 'tombstoned',
        successorMode: this.context.targetMode,
        successorEpoch: parsed.targetTransportEpoch,
        tombstone: parsed,
        updatedAt: parsed.createdAt,
      });
    });
  }

  private async localTaskSnapshot(taskRef: TaskRef, branch: string | null) {
    const store = new V3ContextStore(this.context.projectRoot);
    const [snapshot, fence] = await Promise.all([
      store.readTaskSnapshot(taskRef),
      readTaskHeadFence(this.context.operationStore, taskRef),
    ]);
    if (
      snapshot.metadata.transitionState !== 'stable' ||
      snapshot.metadata.ownerActorId === null ||
      snapshot.aggregate === null ||
      fence === null ||
      fence.remoteRevision !== null ||
      fence.taskRevision !== snapshot.metadata.revision ||
      fence.ownershipEpoch !== snapshot.metadata.ownershipEpoch ||
      fence.aggregateDigest !== digestCanonicalJson(snapshot.aggregate) ||
      fence.codeRef.head.length === 0
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_TASK_SNAPSHOT_INVALID');
    }
    const bundle = createGitRefTaskBundle({
      task: snapshot,
      codeRef: {
        branch: branch ?? snapshot.metadata.base?.branch ?? 'HEAD',
        head: fence.codeRef.head,
      },
      now: new Date(snapshot.metadata.updatedAt),
    });
    return {
      task: {
        taskRef,
        transitionState: 'stable' as const,
        taskRevision: snapshot.metadata.revision,
        ownerActorId: snapshot.metadata.ownerActorId,
        ownershipEpoch: snapshot.metadata.ownershipEpoch,
        aggregateDigest: bundle.aggregateDigest,
        taskHeadFence: fence,
      },
      bundle,
    };
  }

  private async withAuthorityLock<T>(
    operationId: Ulid,
    action: () => Promise<T>,
  ): Promise<T> {
    const locks = await acquireEntityLocks(
      this.context.operationStore,
      operationId,
      [`transport_authority:${this.context.sourceConfig.workspaceId}`],
    );
    try {
      return await action();
    } finally {
      await Promise.allSettled(
        [...locks].reverse().map((lock) => lock.release()),
      );
    }
  }
}

class GitRefTransportMigrationSourceAdapter
  implements TransportMigrationSourceAdapter
{
  readonly mode = 'git-ref' as const;
  readonly remote: string;

  constructor(
    private readonly context: AdapterContext,
    readonly authorityId: string,
    private readonly store: GitRefTeamManifestStore,
  ) {
    this.remote = requireRemote(context.sourceConfig.transport.remote);
  }

  async freeze(input: {
    operationId: Ulid;
    expectedTransportEpoch: number;
  }): Promise<void> {
    const snapshot = await this.store.pull();
    const manifest = requireRemoteManifest(snapshot.manifest);
    if (
      (manifest.authorityState === 'frozen' ||
        manifest.authorityState === 'tombstoned') &&
      (manifest.authorityFreeze?.operationId === input.operationId ||
        manifest.authorityTombstone?.operationId === input.operationId)
    ) {
      assertRemoteFreezeTarget(
        manifest,
        this.context.targetMode,
        input.expectedTransportEpoch + 1,
      );
      return;
    }
    await this.store.freezeCoordinationAuthority({
      operationId: input.operationId,
      actorId: this.context.actorId,
      expectedRemoteRevision: manifest.revision,
      expectedPriorTransportEpoch: input.expectedTransportEpoch,
      successorMode: this.context.targetMode,
      successorEpoch: input.expectedTransportEpoch + 1,
    });
  }

  async assertFrozen(input: {
    operationId: Ulid;
    expectedTransportEpoch: number;
  }): Promise<void> {
    const manifest = requireRemoteManifest((await this.store.pull()).manifest);
    if (
      manifest.transportEpoch !== input.expectedTransportEpoch ||
      (manifest.authorityState !== 'frozen' &&
        manifest.authorityState !== 'tombstoned') ||
      (manifest.authorityFreeze?.operationId !== input.operationId &&
        manifest.authorityTombstone?.operationId !== input.operationId)
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_NOT_FROZEN');
    }
  }

  async inspect(): Promise<unknown> {
    const manifest = requireRemoteManifest((await this.store.pull()).manifest);
    if (manifest.authorityState === 'tombstoned') {
      throw new Error('MANCODE_TRANSPORT_AUTHORITY_TOMBSTONED');
    }
    const tasks = manifest.ownershipFences.map((fence) => {
      const bundle = manifest.taskBundles.find(
        (candidate) => candidate.taskRef.taskId === fence.taskRef.taskId,
      );
      if (bundle === undefined) {
        throw new Error('MANCODE_TRANSPORT_MIGRATION_TASK_SNAPSHOT_INVALID');
      }
      const metadata = bundleMetadata(bundle);
      if (
        metadata.transitionState !== 'stable' ||
        metadata.ownerActorId !== fence.ownerActorId ||
        metadata.ownershipEpoch !== fence.ownershipEpoch ||
        metadata.revision !== fence.taskRevision
      ) {
        throw new Error('MANCODE_TRANSPORT_MIGRATION_TASK_SNAPSHOT_INVALID');
      }
      return {
        taskRef: fence.taskRef,
        transitionState: 'stable' as const,
        taskRevision: fence.taskRevision,
        ownerActorId: fence.ownerActorId,
        ownershipEpoch: fence.ownershipEpoch,
        aggregateDigest: fence.aggregateDigest,
        taskHeadFence: parseTaskHeadFence({
          schemaVersion: 1,
          workspaceId: manifest.workspaceId,
          taskRef: fence.taskRef,
          fenceRevision: fence.remoteRevision,
          taskRevision: fence.taskRevision,
          aggregateDigest: fence.aggregateDigest,
          ownershipEpoch: fence.ownershipEpoch,
          codeRef: { head: bundle.codeRef.head },
          checkoutId: this.context.checkoutId,
          remoteRevision: fence.remoteRevision,
          lastOperationId: fence.lastOperationId,
          updatedAt: fence.updatedAt,
        }),
      };
    });
    return {
      schemaVersion: 1,
      workspaceId: manifest.workspaceId,
      authorityId: this.authorityId,
      transportMode: 'git-ref',
      transportEpoch: manifest.transportEpoch,
      coordinationDomainId: gitRefCoordinationDomainId(
        await resolveGitRefRemoteIdentityHash(
          this.context.projectRoot,
          this.remote,
        ),
        manifest.workspaceId,
        manifest.transportEpoch,
      ),
      pendingOperationIds: [],
      actorProfiles: manifest.actorProfiles,
      tasks,
      taskBundles: manifest.taskBundles,
      claims: manifest.claims,
      handoffs: manifest.handoffs,
    } satisfies TransportMigrationAuthoritySnapshotV1;
  }

  async unfreeze(input: { operationId: Ulid }): Promise<void> {
    const manifest = requireRemoteManifest((await this.store.pull()).manifest);
    if (
      manifest.authorityState === 'active' &&
      manifest.lastOperationId === input.operationId &&
      manifest.lastMutation?.kind === 'authority_unfreeze'
    ) {
      return;
    }
    if (
      manifest.authorityState !== 'frozen' ||
      manifest.authorityFreeze?.operationId !== input.operationId
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_FREEZE_CONFLICT');
    }
    await this.store.unfreezeCoordinationAuthority({
      operationId: input.operationId,
      actorId: this.context.actorId,
      expectedRemoteRevision: manifest.revision,
      expectedPriorTransportEpoch: manifest.transportEpoch,
      freezeOperationId: input.operationId,
    });
  }

  async writeTombstone(
    tombstone: TransportAuthorityTombstoneV1,
  ): Promise<void> {
    const parsed = parseTransportAuthorityTombstone(tombstone);
    const manifest = requireRemoteManifest((await this.store.pull()).manifest);
    if (
      manifest.authorityState === 'tombstoned' &&
      manifest.authorityTombstone?.operationId === parsed.operationId &&
      manifest.authorityTombstone.successorMode === this.context.targetMode &&
      manifest.authorityTombstone.successorEpoch === parsed.targetTransportEpoch
    ) {
      return;
    }
    await this.store.tombstoneCoordinationAuthority({
      operationId: parsed.operationId,
      actorId: this.context.actorId,
      expectedRemoteRevision: manifest.revision,
      expectedPriorTransportEpoch: parsed.sourceTransportEpoch,
      successorMode: this.context.targetMode,
      successorEpoch: parsed.targetTransportEpoch,
    });
  }
}

abstract class FileStagedTransportTarget
  implements TransportMigrationTargetAdapter
{
  abstract readonly mode: CoordinationTransport;
  abstract readonly remote: string | null;
  abstract establish(manifest: TransportMigrationManifestV1): Promise<unknown>;

  constructor(
    protected readonly context: AdapterContext,
    readonly authorityId: string,
    readonly coordinationDomainId: string,
  ) {}

  async stage(manifestValue: TransportMigrationManifestV1): Promise<unknown> {
    const manifest = parseTransportMigrationManifest(manifestValue);
    this.assertManifestTarget(manifest);
    const staged = parseStagedTransportAuthority({
      schemaVersion: 1,
      operationId: manifest.operationId,
      manifest,
      manifestDigest: digestCanonicalJson(manifest),
      transportEpoch: manifest.target.transportEpoch,
      coordinationDomainId: manifest.target.coordinationDomainId,
      stagedAt: manifest.createdAt,
    });
    await writeJsonExclusiveOrEqual(
      stagedPath(this.context.operationStore, manifest.operationId),
      staged,
      parseStagedTransportAuthority,
      'MANCODE_TRANSPORT_MIGRATION_STAGE_CONFLICT',
    );
    return staged;
  }

  async readStaged(operationId: Ulid): Promise<unknown | null> {
    return readStagedRecord(this.context.operationStore, operationId);
  }

  async readEstablished(operationId: Ulid): Promise<unknown | null> {
    const stored = await readJsonOrNull(
      establishedPath(this.context.operationStore, operationId),
      parseEstablishedTransportAuthority,
      'MANCODE_TRANSPORT_MIGRATION_ESTABLISHED_CORRUPT',
    );
    return stored ?? this.recoverEstablished(operationId);
  }

  async discard(input: {
    operationId: Ulid;
    manifestDigest: string;
  }): Promise<void> {
    const established = await this.readEstablished(input.operationId);
    if (established !== null) {
      throw new Error('MANCODE_OPERATION_ABORT_UNSAFE');
    }
    const staged = await readStagedRecord(
      this.context.operationStore,
      input.operationId,
    );
    if (staged === null) return;
    if (staged.manifestDigest !== input.manifestDigest) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_CONFLICT');
    }
    await unlinkIfExists(
      stagedPath(this.context.operationStore, input.operationId),
    );
  }

  protected abstract recoverEstablished(
    operationId: Ulid,
  ): Promise<EstablishedTransportAuthorityV1 | null>;

  protected async writeEstablished(
    value: EstablishedTransportAuthorityV1,
  ): Promise<EstablishedTransportAuthorityV1> {
    const parsed = parseEstablishedTransportAuthority(value);
    await writeJsonExclusiveOrEqual(
      establishedPath(this.context.operationStore, parsed.operationId),
      parsed,
      parseEstablishedTransportAuthority,
      'MANCODE_TRANSPORT_MIGRATION_ESTABLISH_CONFLICT',
    );
    return parsed;
  }

  protected assertManifestTarget(manifest: TransportMigrationManifestV1): void {
    if (
      manifest.target.mode !== this.mode ||
      manifest.target.remote !== this.remote ||
      manifest.target.authorityId !== this.authorityId ||
      manifest.target.coordinationDomainId !== this.coordinationDomainId
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_CONFLICT');
    }
  }
}

class GitRefTransportMigrationTargetAdapter extends FileStagedTransportTarget {
  readonly mode = 'git-ref' as const;
  readonly remote: string;

  constructor(
    context: AdapterContext,
    authorityId: string,
    coordinationDomainId: string,
  ) {
    super(context, authorityId, coordinationDomainId);
    this.remote = requireRemote(context.targetRemote);
  }

  async establish(
    manifestValue: TransportMigrationManifestV1,
  ): Promise<unknown> {
    const manifest = parseTransportMigrationManifest(manifestValue);
    this.assertManifestTarget(manifest);
    const existing = await this.readEstablished(manifest.operationId);
    if (existing !== null) return existing;
    await requireStagedManifest(this.context.operationStore, manifest);
    const nextConfig = migrationTargetConfig(manifest);
    const store = this.targetStore(manifest, nextConfig);
    const probe = await new GitRefTeamManifestStore({
      projectRoot: this.context.projectRoot,
      remote: this.remote,
      workspaceId: manifest.workspaceId,
      now: () => new Date(manifest.createdAt),
    }).pull();
    const remoteRevision = probe.manifest?.revision ?? 0;
    const nextRemoteRevision = remoteRevision + 1;
    const activeClaims = reissueActiveClaims(manifest, nextRemoteRevision);
    const handoffs = migrateHandoffs(manifest, nextRemoteRevision);
    const ownershipFences = manifest.tasks.map((task) => ({
      schemaVersion: 1 as const,
      taskRef: task.taskRef,
      ownerActorId: requireOwner(task.ownerActorId),
      ownershipEpoch: task.ownershipEpoch,
      taskRevision: task.taskRevision,
      aggregateDigest: task.aggregateDigest,
      remoteRevision: nextRemoteRevision,
      lastOperationId: manifest.operationId,
      updatedAt: manifest.createdAt,
    }));
    const result = await store.establishCoordinationAuthority({
      operationId: manifest.operationId,
      actorId: manifest.actorId,
      expectedRemoteRevision: remoteRevision,
      expectedRemoteTransportEpoch: probe.manifest?.transportEpoch ?? null,
      expectedPriorTransportEpoch: manifest.source.config.transport.epoch,
      targetTransportEpoch: manifest.target.transportEpoch,
      actorProfiles: manifest.actorProfiles,
      ownershipFences,
      claims: activeClaims,
      handoffs,
      taskBundles: manifest.taskBundles,
    });
    return this.writeEstablished({
      schemaVersion: 1,
      operationId: manifest.operationId,
      manifestDigest: digestCanonicalJson(manifest),
      transportEpoch: manifest.target.transportEpoch,
      coordinationDomainId: manifest.target.coordinationDomainId,
      authorityRevision: result.remoteRevision,
      activeClaims,
      receipt: result.receipt,
      establishedAt: manifest.createdAt,
    });
  }

  protected async recoverEstablished(
    operationId: Ulid,
  ): Promise<EstablishedTransportAuthorityV1 | null> {
    const staged = await readStagedRecord(
      this.context.operationStore,
      operationId,
    );
    if (staged === null || staged.manifest.target.mode !== 'git-ref')
      return null;
    const manifest = staged.manifest;
    const snapshot = await new GitRefTeamManifestStore({
      projectRoot: this.context.projectRoot,
      remote: this.remote,
      workspaceId: manifest.workspaceId,
      now: () => new Date(manifest.createdAt),
    }).pull();
    const remote = snapshot.manifest;
    if (
      remote === null ||
      remote.authorityState !== 'active' ||
      remote.transportEpoch !== manifest.target.transportEpoch ||
      remote.lastOperationId !== operationId ||
      remote.lastMutation?.kind !== 'authority_establish' ||
      snapshot.receipt === null
    ) {
      return null;
    }
    return this.writeEstablished({
      schemaVersion: 1,
      operationId,
      manifestDigest: staged.manifestDigest,
      transportEpoch: manifest.target.transportEpoch,
      coordinationDomainId: manifest.target.coordinationDomainId,
      authorityRevision: remote.revision,
      activeClaims: remote.claims.filter((claim) => claim.state === 'active'),
      receipt: snapshot.receipt,
      establishedAt: remote.updatedAt,
    });
  }

  private targetStore(
    manifest: TransportMigrationManifestV1,
    nextConfig: ProjectConfigV1,
  ): GitRefTeamManifestStore {
    return new GitRefTeamManifestStore({
      projectRoot: this.context.projectRoot,
      remote: this.remote,
      workspaceId: manifest.workspaceId,
      schemaEpoch: this.context.schemaEpoch,
      minReaderVersion: this.context.minReaderVersion,
      minWriterVersion: this.context.minWriterVersion,
      transportEpoch: manifest.target.transportEpoch,
      configRevision: nextConfig.revision,
      configDigest: projectConfigDigest(nextConfig),
      now: () => new Date(manifest.createdAt),
    });
  }
}

class LocalTransportMigrationTargetAdapter extends FileStagedTransportTarget {
  readonly mode = 'local' as const;
  readonly remote = null;

  async establish(
    manifestValue: TransportMigrationManifestV1,
  ): Promise<unknown> {
    const manifest = parseTransportMigrationManifest(manifestValue);
    this.assertManifestTarget(manifest);
    const existing = await this.readEstablished(manifest.operationId);
    if (existing !== null) return existing;
    await requireStagedManifest(this.context.operationStore, manifest);
    const locks = await acquireEntityLocks(
      this.context.operationStore,
      manifest.operationId,
      [`transport_authority:${manifest.workspaceId}`],
    );
    try {
      const marker = await readLocalTransportAuthorityState(
        this.context.operationStore,
      );
      if (
        marker?.state === 'active' &&
        marker.transportEpoch === manifest.target.transportEpoch &&
        marker.operationId === manifest.operationId
      ) {
        return this.finishLocalEstablishment(manifest);
      }
      if (marker?.state === 'active') {
        throw new Error('MANCODE_TRANSPORT_MIGRATION_SPLIT_BRAIN');
      }
      await archiveLocalCoordinationCollections(
        this.context.operationStore,
        manifest.operationId,
      );
      await publishMigrationActorProfiles(
        this.context.projectRoot,
        manifest.actorProfiles,
      );
      for (const task of manifest.tasks) {
        const bundle = requireTaskBundle(manifest, task.taskRef);
        await assertGitRefBundleCodeReachable(this.context.projectRoot, bundle);
        await materializeLocalMigrationTask(
          this.context,
          manifest,
          task,
          bundle,
        );
      }
      const activeClaims = reissueActiveClaims(manifest, 1);
      for (const claim of activeClaims) {
        await createClaim(this.context.operationStore, claim);
      }
      for (const handoff of migrateHandoffs(manifest, 1)) {
        await createHandoff(this.context.operationStore, handoff);
      }
      await writeLocalTransportAuthorityState(this.context.operationStore, {
        schemaVersion: 1,
        workspaceId: manifest.workspaceId,
        authorityId: manifest.target.authorityId,
        coordinationDomainId: manifest.target.coordinationDomainId,
        transportEpoch: manifest.target.transportEpoch,
        state: 'active',
        operationId: manifest.operationId,
        successorMode: null,
        successorEpoch: null,
        tombstone: null,
        updatedAt: manifest.createdAt,
      });
      return this.finishLocalEstablishment(manifest, activeClaims);
    } finally {
      await Promise.allSettled(
        [...locks].reverse().map((lock) => lock.release()),
      );
    }
  }

  protected async recoverEstablished(
    operationId: Ulid,
  ): Promise<EstablishedTransportAuthorityV1 | null> {
    const staged = await readStagedRecord(
      this.context.operationStore,
      operationId,
    );
    if (staged === null || staged.manifest.target.mode !== 'local') return null;
    const marker = await readLocalTransportAuthorityState(
      this.context.operationStore,
    );
    if (
      marker?.state !== 'active' ||
      marker.operationId !== operationId ||
      marker.transportEpoch !== staged.manifest.target.transportEpoch ||
      marker.authorityId !== staged.manifest.target.authorityId
    ) {
      return null;
    }
    return this.finishLocalEstablishment(staged.manifest);
  }

  private async finishLocalEstablishment(
    manifest: TransportMigrationManifestV1,
    claims?: ClaimV1[],
  ): Promise<EstablishedTransportAuthorityV1> {
    const activeClaims =
      claims ??
      (await listClaims(this.context.operationStore)).filter(
        (claim) =>
          claim.state === 'active' &&
          claim.lastOperationId === manifest.operationId,
      );
    return this.writeEstablished({
      schemaVersion: 1,
      operationId: manifest.operationId,
      manifestDigest: digestCanonicalJson(manifest),
      transportEpoch: manifest.target.transportEpoch,
      coordinationDomainId: manifest.target.coordinationDomainId,
      authorityRevision: 1,
      activeClaims,
      receipt: `local:${digestCanonicalJson(manifest).slice(7)}`,
      establishedAt: manifest.createdAt,
    });
  }
}

async function createSourceAdapter(
  context: AdapterContext,
): Promise<TransportMigrationSourceAdapter> {
  if (context.sourceConfig.transport.mode === 'local') {
    const domain = localDomain(context);
    const marker = await readLocalTransportAuthorityState(
      context.operationStore,
    );
    const authorityId =
      marker !== null &&
      marker.transportEpoch === context.sourceConfig.transport.epoch &&
      marker.coordinationDomainId === domain
        ? marker.authorityId
        : localAuthorityId(domain, context.sourceConfig.transport.epoch);
    return new LocalTransportMigrationSourceAdapter(
      context,
      authorityId,
      domain,
    );
  }
  const remote = requireRemote(context.sourceConfig.transport.remote);
  const remoteIdentity = await resolveGitRefRemoteIdentityHash(
    context.projectRoot,
    remote,
  );
  const domain = gitRefCoordinationDomainId(
    remoteIdentity,
    context.sourceConfig.workspaceId,
    context.sourceConfig.transport.epoch,
  );
  return new GitRefTransportMigrationSourceAdapter(
    context,
    gitRefAuthorityId(domain),
    new GitRefTeamManifestStore({
      projectRoot: context.projectRoot,
      remote,
      workspaceId: context.sourceConfig.workspaceId,
      schemaEpoch: context.schemaEpoch,
      minReaderVersion: context.minReaderVersion,
      minWriterVersion: context.minWriterVersion,
      transportEpoch: context.sourceConfig.transport.epoch,
      configRevision: context.sourceConfig.revision,
      configDigest: projectConfigDigest(context.sourceConfig),
      now: context.now,
    }),
  );
}

async function createTargetAdapter(
  context: AdapterContext,
): Promise<TransportMigrationTargetAdapter> {
  const targetEpoch = context.sourceConfig.transport.epoch + 1;
  if (context.targetMode === 'local') {
    const domain = localDomain(context);
    return new LocalTransportMigrationTargetAdapter(
      context,
      localAuthorityId(domain, targetEpoch),
      domain,
    );
  }
  const remote = requireRemote(context.targetRemote);
  const remoteIdentity = await resolveGitRefRemoteIdentityHash(
    context.projectRoot,
    remote,
  );
  const domain = gitRefCoordinationDomainId(
    remoteIdentity,
    context.sourceConfig.workspaceId,
    targetEpoch,
  );
  return new GitRefTransportMigrationTargetAdapter(
    context,
    gitRefAuthorityId(domain),
    domain,
  );
}

async function materializeLocalMigrationTask(
  context: AdapterContext,
  manifest: TransportMigrationManifestV1,
  task: TransportMigrationAuthoritySnapshotV1['tasks'][number],
  bundle: GitRefTaskBundleV1,
): Promise<void> {
  const existingFence = await readTaskHeadFence(
    context.operationStore,
    task.taskRef,
  );
  const existingTask = await readTaskSnapshotOrNull(
    context.projectRoot,
    task.taskRef,
  );
  const alreadyLocal =
    existingFence !== null &&
    existingFence.remoteRevision === null &&
    existingFence.lastOperationId === manifest.operationId &&
    existingFence.taskRevision === bundle.taskRevision &&
    existingFence.aggregateDigest === bundle.aggregateDigest &&
    existingTask?.aggregate !== null &&
    existingTask !== null &&
    digestCanonicalJson(existingTask.aggregate) === bundle.aggregateDigest;
  if (alreadyLocal) return;
  const remoteRevision = task.taskHeadFence.remoteRevision;
  if (remoteRevision === null) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_TASK_SNAPSHOT_INVALID');
  }
  const remoteFence: GitRefOwnershipFenceV1 = {
    schemaVersion: 1,
    taskRef: task.taskRef,
    ownerActorId: requireOwner(task.ownerActorId),
    ownershipEpoch: task.ownershipEpoch,
    taskRevision: task.taskRevision,
    aggregateDigest: task.aggregateDigest,
    remoteRevision,
    lastOperationId: task.taskHeadFence.lastOperationId,
    updatedAt: task.taskHeadFence.updatedAt,
  };
  const result = await materializeGitRefTaskBundle({
    projectRoot: context.projectRoot,
    remoteRevision,
    ownershipFence: remoteFence,
    bundle,
    operationId: handoffSuccessorClaimId(
      manifest.operationId,
      task.taskRef.taskId,
      manifest.createdAt,
    ),
    now: new Date(manifest.createdAt),
  });
  await replaceTaskHeadFence(
    context.operationStore,
    parseTaskHeadFence({
      ...result.taskHeadFence,
      fenceRevision: result.taskHeadFence.fenceRevision + 1,
      remoteRevision: null,
      lastOperationId: manifest.operationId,
      updatedAt: manifest.createdAt,
    }),
  );
}

function reissueActiveClaims(
  manifest: TransportMigrationManifestV1,
  authorityRevision: number,
): ClaimV1[] {
  return manifest.sourceClaims
    .filter((claim) => claim.state === 'active')
    .map((claim) =>
      parseClaim({
        ...claim,
        claimId: handoffSuccessorClaimId(
          manifest.operationId,
          claim.claimId,
          manifest.createdAt,
        ),
        coordinationDomainId: manifest.target.coordinationDomainId,
        authority: {
          mode: manifest.target.mode,
          remoteRevision:
            manifest.target.mode === 'git-ref'
              ? String(authorityRevision)
              : null,
        },
        state: 'active',
        revision: 1,
        acquisitionEnforcement: 'enforced',
        writeGuard: 'advisory',
        predecessorClaimId: claim.claimId,
        successorClaimId: null,
        lastOperationId: manifest.operationId,
        createdAt: manifest.createdAt,
        updatedAt: manifest.createdAt,
      }),
    )
    .sort((left, right) => compareUtf8(left.claimId, right.claimId));
}

function migrateHandoffs(
  manifest: TransportMigrationManifestV1,
  authorityRevision: number,
): HandoffV1[] {
  const claimIds = new Map(
    manifest.sourceClaims
      .filter((claim) => claim.state === 'active')
      .map((claim) => [
        claim.claimId,
        handoffSuccessorClaimId(
          manifest.operationId,
          claim.claimId,
          manifest.createdAt,
        ),
      ]),
  );
  return manifest.handoffs.map((handoff) => {
    const bundle = requireTaskBundle(manifest, handoff.taskRef);
    const targetDigest =
      manifest.target.mode === 'git-ref'
        ? bundle.bundleDigest
        : localHandoffBundleDigest(bundle, handoff);
    return parseHandoff({
      ...handoff,
      claimIds: handoff.claimIds.map((id) => claimIds.get(id) ?? id),
      transport:
        manifest.target.mode === 'git-ref'
          ? {
              mode: 'git-ref',
              state: 'published',
              transportRevision: authorityRevision,
              publishedAt: manifest.createdAt,
              fetchedAt: null,
              taskBundleDigest: targetDigest,
              codeRef: bundle.codeRef,
              codeReachable: true,
              receipt: `migration:${manifest.operationId}`,
            }
          : {
              mode: 'local',
              state: 'local_only',
              transportRevision: null,
              publishedAt: null,
              fetchedAt: null,
              taskBundleDigest: targetDigest,
              codeRef: bundle.codeRef,
              codeReachable: true,
              receipt: null,
            },
      lastOperationId: manifest.operationId,
      updatedAt: manifest.createdAt,
    });
  });
}

function localHandoffBundleDigest(
  bundle: GitRefTaskBundleV1,
  handoff: HandoffV1,
): string {
  const artifact = bundle.artifacts.find(
    (candidate) =>
      candidate.kind === 'checkpoint' &&
      candidate.relativePath.endsWith(
        `/${handoff.checkpointRef.artifactId}.json`,
      ),
  );
  if (artifact === undefined) return handoff.transport.taskBundleDigest;
  const checkpoint = parseCheckpoint(artifact.content);
  return digestCanonicalJson({
    aggregate: bundle.aggregate,
    checkpointDigest: checkpointDigest(checkpoint),
    codeRef: { head: bundle.codeRef.head },
  });
}

async function publishMigrationActorProfiles(
  projectRoot: string,
  profiles: TransportMigrationManifestV1['actorProfiles'],
): Promise<void> {
  for (const profile of profiles) {
    const existing = await readSharedActorProfile(projectRoot, profile.actorId);
    if (
      existing !== null &&
      digestCanonicalJson(existing) !== digestCanonicalJson(profile)
    ) {
      throw new Error('MANCODE_ACTOR_PROFILE_CONFLICT');
    }
    await publishSharedActorProfile(projectRoot, profile);
  }
}

async function archiveLocalCoordinationCollections(
  store: EntityHomeStore,
  operationId: Ulid,
): Promise<void> {
  const archiveRoot = path.join(
    store.root,
    STAGE_DIRECTORY,
    'archive',
    operationId,
  );
  await mkdir(archiveRoot, { recursive: true });
  const directories: Record<(typeof COLLECTIONS)[number], string> = {
    claims: claimDirectory(store),
    handoffs: handoffDirectory(store),
    'task-heads': taskHeadDirectory(store),
  };
  for (const name of COLLECTIONS) {
    const archived = path.join(archiveRoot, name);
    const absent = path.join(archiveRoot, `${name}.absent`);
    if (
      (await pathKind(archived)) === 'directory' ||
      (await pathKind(absent)) === 'file'
    ) {
      continue;
    }
    const sourceKind = await pathKind(directories[name]);
    if (sourceKind === null) {
      await writeFile(absent, '\n', { encoding: 'utf8', flag: 'wx' });
      continue;
    }
    if (sourceKind !== 'directory') {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_LOCAL_AUTHORITY_UNSAFE');
    }
    await rename(directories[name], archived);
  }
}

async function listActorProfiles(projectRoot: string) {
  const directory = sharedActorProfileDirectory(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const profiles = [];
  for (const entry of entries.sort(compareUtf8)) {
    if (!entry.endsWith('.json')) continue;
    const actorId = entry.slice(0, -'.json'.length);
    assertUlid(actorId, 'shared actor profile filename');
    const profile = await readSharedActorProfile(projectRoot, actorId);
    if (profile === null) {
      throw new Error('MANCODE_CONTEXT_COLLECTION_CHANGED_DURING_READ');
    }
    profiles.push(profile);
  }
  return profiles;
}

async function listSharedTaskRefs(projectRoot: string): Promise<TaskRef[]> {
  const directory = path.join(projectRoot, '.mancode', 'shared', 'workflows');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const refs: TaskRef[] = [];
  for (const taskId of entries.sort(compareUtf8)) {
    assertUlid(taskId, 'shared workflow directory');
    const stat = await lstat(path.join(directory, taskId));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
    }
    refs.push({ namespace: 'shared', taskId });
  }
  return refs;
}

async function readTaskSnapshotOrNull(projectRoot: string, taskRef: TaskRef) {
  try {
    return await new V3ContextStore(projectRoot).readTaskSnapshot(taskRef);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'MANCODE_TASK_NOT_FOUND' || isNotFound(error))
    ) {
      return null;
    }
    throw error;
  }
}

function bundleMetadata(bundle: GitRefTaskBundleV1) {
  const artifact = bundle.artifacts.find(
    (candidate) => candidate.kind === 'metadata',
  );
  if (artifact === undefined) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_INVALID');
  }
  return parseWorkflowMetadata(artifact.content);
}

function requireTaskBundle(
  manifest: TransportMigrationManifestV1,
  taskRef: TaskRef,
): GitRefTaskBundleV1 {
  const bundle = manifest.taskBundles.find(
    (candidate) => candidate.taskRef.taskId === taskRef.taskId,
  );
  if (bundle === undefined) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_TASK_SNAPSHOT_INVALID');
  }
  return bundle;
}

function requireOwner(value: Ulid | null): Ulid {
  if (value === null) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_TASK_SNAPSHOT_INVALID');
  }
  return value;
}

function migrationTargetConfig(
  manifest: TransportMigrationManifestV1,
): ProjectConfigV1 {
  const previous = manifest.source.config;
  const next = parseProjectConfig({
    ...previous,
    revision: previous.revision + 1,
    transport: {
      mode: manifest.target.mode,
      remote: manifest.target.remote,
      epoch: manifest.target.transportEpoch,
    },
    lastOperationId: manifest.operationId,
    updatedAt: manifest.createdAt,
  });
  assertProjectConfigTransition(previous, next, 'transport_migrate');
  return next;
}

async function requireStagedManifest(
  store: EntityHomeStore,
  manifest: TransportMigrationManifestV1,
): Promise<StagedTransportAuthorityV1> {
  const staged = await readStagedRecord(store, manifest.operationId);
  if (
    staged === null ||
    staged.manifestDigest !== digestCanonicalJson(manifest) ||
    digestCanonicalJson(staged.manifest) !== digestCanonicalJson(manifest)
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_CONFLICT');
  }
  return staged;
}

async function readStagedRecord(
  store: EntityHomeStore,
  operationId: Ulid,
): Promise<StagedTransportAuthorityV1 | null> {
  assertUlid(operationId, 'transport migration staged operationId');
  return readJsonOrNull(
    stagedPath(store, operationId),
    parseStagedTransportAuthority,
    'MANCODE_TRANSPORT_MIGRATION_STAGE_CORRUPT',
  );
}

function stagedPath(store: EntityHomeStore, operationId: Ulid): string {
  return path.join(
    store.root,
    STAGE_DIRECTORY,
    'staged',
    `${operationId}.json`,
  );
}

function establishedPath(store: EntityHomeStore, operationId: Ulid): string {
  return path.join(
    store.root,
    STAGE_DIRECTORY,
    'established',
    `${operationId}.json`,
  );
}

function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.mancode', 'shared', 'config.json');
}

async function readProjectConfigFile(
  projectRoot: string,
): Promise<ProjectConfigV1> {
  try {
    return parseProjectConfig(
      JSON.parse(await readFile(projectConfigPath(projectRoot), 'utf8')),
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_CONTEXT_ENTITY_CORRUPT: shared/config.json');
    }
    throw error;
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await assertPlainDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${createUlid()}.tmp`,
  );
  try {
    await writeFile(temporary, serialize(value), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await replaceFileAtomically(temporary, target);
  } catch (error) {
    await unlinkIfExists(temporary);
    throw error;
  }
}

async function writeJsonExclusiveOrEqual<T>(
  target: string,
  value: T,
  parser: (raw: unknown) => T,
  conflictCode: string,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await assertPlainDirectory(path.dirname(target));
  try {
    await writeFile(target, serialize(value), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readJsonOrNull(target, parser, conflictCode);
    if (
      existing !== null &&
      digestCanonicalJson(existing) === digestCanonicalJson(value)
    ) {
      return;
    }
    throw new Error(conflictCode);
  }
}

async function readJsonOrNull<T>(
  target: string,
  parser: (raw: unknown) => T,
  corruptCode: string,
): Promise<T | null> {
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_UNSAFE');
    }
    const parsed = parser(JSON.parse(await readFile(target, 'utf8')));
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_UNSAFE');
    }
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) throw new Error(corruptCode);
    throw error;
  }
}

function assertLocalStateIdentity(
  state: LocalTransportAuthorityStateV1,
  workspaceId: Ulid,
  authorityId: string,
  coordinationDomainId: string,
  transportEpoch: number,
): void {
  if (
    state.workspaceId !== workspaceId ||
    state.authorityId !== authorityId ||
    state.coordinationDomainId !== coordinationDomainId ||
    state.transportEpoch !== transportEpoch
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_SPLIT_BRAIN');
  }
}

function isTombstoneRetry(
  state: LocalTransportAuthorityStateV1 | null,
  operationId: Ulid,
): boolean {
  return state?.state === 'tombstoned' && state.operationId === operationId;
}

function assertRemoteFreezeTarget(
  manifest: GitRefTeamManifestV1,
  successorMode: CoordinationTransport,
  successorEpoch: number,
): void {
  const freeze = manifest.authorityFreeze;
  if (
    freeze === null ||
    freeze.successorMode !== successorMode ||
    freeze.successorEpoch !== successorEpoch
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_FREEZE_CONFLICT');
  }
}

function requireRemoteManifest(
  value: GitRefTeamManifestV1 | null,
): GitRefTeamManifestV1 {
  if (value === null) throw new Error('MANCODE_TRANSPORT_MANIFEST_MISSING');
  return value;
}

function localDomain(context: AdapterContext): string {
  return context.repositoryBindingId === null
    ? `local:non-git:${context.sourceConfig.workspaceId}`
    : localCoordinationDomainId(
        context.repositoryBindingId,
        context.sourceConfig.workspaceId,
      );
}

function localAuthorityId(domain: string, epoch: number): string {
  return `authority:${domain}:epoch:${epoch}`;
}

function gitRefAuthorityId(domain: string): string {
  return `authority:${domain}`;
}

function normalizeTargetRemote(
  mode: CoordinationTransport,
  remote: string | null | undefined,
): string | null {
  if (mode === 'local') {
    if (remote !== undefined && remote !== null) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_REMOTE_INVALID');
    }
    return null;
  }
  return requireRemote(remote ?? null);
}

function requireRemote(value: string | null): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_REMOTE_INVALID');
  }
  return value;
}

async function pathKind(
  target: string,
): Promise<'file' | 'directory' | 'other' | null> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) return 'other';
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function assertPlainDirectory(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_UNSAFE');
  }
}

async function unlinkIfExists(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

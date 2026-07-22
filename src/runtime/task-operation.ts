import { execFile as execFileCallback } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { taskAggregateDigest } from '../context/aggregate.js';
import {
  CURRENT_WRITER_CAPABILITIES,
  type CompatibilityOperation,
  assertCompatibilityGate,
} from '../context/compatibility.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { scanLegacyAuthority } from '../context/layout.js';
import { managedAdapterNames } from '../context/manifest.js';
import {
  type StoredCoordinationSnapshot,
  type StoredProjectSnapshot,
  type StoredTaskSnapshot,
  V3ContextStore,
} from '../context/store.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { assertParentWorkflowRelation } from '../context/workflow-metadata.js';
import { inspectV3AdapterVersions } from '../installers/v3-adapter.js';
import { readSharedActorProfile } from '../team/actor.js';
import {
  type AuthorizationAction,
  type AuthorizationClaimContext,
  type AuthorizationConditions,
  type AuthorizationEvidenceContext,
  type AuthorizationHandoffContext,
  type AuthorizationTaskContext,
  createAuthorizationBasis,
} from '../team/authorization.js';
import {
  type CheckpointV1,
  checkpointDigest,
  parseCheckpoint,
} from '../team/checkpoints.js';
import { assertTransportCoordinationWriteAllowed } from '../team/transport-migration-freeze.js';
import { capabilitiesFromProjectConfig } from '../team/transport.js';
import { VERSION } from '../version.js';
import { replaceFileAtomically } from './atomic-file.js';
import { recordV3ErrorDiagnostic } from './diagnostics.js';
import {
  type EntityHomeStore,
  resolveTaskEntityHomeStore,
} from './entity-home-store.js';
import {
  type LocalLockHandle,
  type OperationEntityLockTarget,
  acquireOperationEntityLocks,
} from './local-lock.js';
import {
  armOperationCrashAfterVisibleWrite,
  pauseIfOperationLockInjectedForTesting,
  throwIfDeferredOperationCrashInjected,
  throwIfOperationCrashInjected,
} from './operation-crash-injection.js';
import {
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from './operation-definition.js';
import type {
  OperationJournalV1,
  OperationStep,
  OperationType,
} from './operation-journal.js';
import {
  type OperationRecoveryActionV1,
  TASK_AUTHORITY_FILE_NAMES,
  type TaskArchiveRecoveryAction,
  type TaskAuthorityFileName,
  assertOperationRecoveryPayloadCoversJournal,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
  taskArchiveDigest,
  taskArchiveManifest,
} from './operation-recovery-payload.js';
import { writeOperationRecoveryPayload } from './operation-recovery-store.js';
import {
  createPreparedOperationJournal,
  updateOperationJournal,
} from './operation-store.js';
import {
  type ProjectRuntimeContext,
  readCheckoutCodeHead,
  readProjectRuntimeContext,
} from './project-runtime.js';
import { acquireProjectWriteBarrier } from './project-write-barrier.js';
import { type SessionStateV1, readSession, resumeSession } from './session.js';
import { assertTaskHeadFenceMatchesAggregate } from './task-head-fence.js';

const execFile = promisify(execFileCallback);

export interface OpenV3TaskOperationInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  operationId?: Ulid;
  compatibilityOperation?: Extract<
    CompatibilityOperation,
    'v3_business_write' | 'reframe'
  >;
  /** Additional entities use the same task-store lock family. */
  extraEntityLocks?: string[];
  /**
   * Extra entity-home stores needed by a single multi-store operation. They
   * are acquired together with the task store in global store/key order.
   */
  additionalEntityLockTargets?: OperationEntityLockTarget[];
  /** Reserved for the explicit task-head reconcile adoption operation. */
  allowTaskHeadFenceMismatch?: boolean;
  now?: Date;
}

export interface OpenedV3TaskOperation {
  projectRoot: string;
  taskRef: TaskRef;
  operationId: Ulid;
  now: Date;
  runtime: ProjectRuntimeContext;
  project: StoredProjectSnapshot;
  store: V3ContextStore;
  homeStore: EntityHomeStore;
  session: SessionStateV1;
  task: StoredTaskSnapshot;
  coordination: StoredCoordinationSnapshot;
  codeHead: string | null;
  entityLocks: string[];
  renewLocks(): Promise<void>;
  releaseProjectBarrier(): Promise<void>;
  release(): Promise<void>;
}

export interface CreateTaskOperationJournalInput {
  type: OperationType;
  action: AuthorizationAction;
  expectedRevisions: Record<string, number>;
  entityLocks?: string[];
  conditions?: AuthorizationConditions;
  task?: AuthorizationTaskContext | null;
  claim?: AuthorizationClaimContext | null;
  handoff?: AuthorizationHandoffContext | null;
  evidence?: AuthorizationEvidenceContext | null;
  profileActorId?: Ulid | null;
  /** Exact targets that make a crash after a durable write intent repairable. */
  recovery?: {
    actions: OperationRecoveryActionV1[];
    noOpStepIds?: string[];
  };
}

const TASK_AUTHORITY_FILES = new Set<string>(TASK_AUTHORITY_FILE_NAMES);

/**
 * Opens a V3 task mutation only after all current authority has been reread
 * under the canonical task lock. This prevents a stale caller from composing
 * a journal using a snapshot captured before another writer committed.
 */
export async function openV3TaskOperation(
  input: OpenV3TaskOperationInput,
): Promise<OpenedV3TaskOperation> {
  const projectRoot = path.resolve(requireProjectRoot(input.projectRoot));
  const taskRef = parseTaskRefValue(input.taskRef);
  assertUlid(input.sessionId, 'task operation sessionId');
  assertRevision(
    input.expectedTaskRevision,
    'task operation expectedTaskRevision',
  );
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'task operation operationId');
  const runtime = await readProjectRuntimeContext(projectRoot);
  const projectBarrier = await acquireProjectWriteBarrier(
    runtime,
    operationId,
    now,
  );
  let projectBarrierReleased = false;
  const releaseProjectBarrier = async (): Promise<void> => {
    if (projectBarrierReleased) return;
    await projectBarrier.release();
    projectBarrierReleased = true;
  };
  const store = new V3ContextStore(projectRoot);
  let locks: LocalLockHandle[] = [];
  try {
    const homeStore = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      taskRef,
    );
    const taskKey = taskEntityKey(taskRef);
    const entityLocks = uniqueEntityLocks([
      taskKey,
      ...(input.extraEntityLocks ?? []),
    ]);
    const project = await store.readProjectSnapshot();
    const [legacy, session, adapterVersions] = await Promise.all([
      scanLegacyAuthority(projectRoot),
      readSession(projectRoot, input.sessionId),
      inspectV3AdapterVersions(
        projectRoot,
        managedAdapterNames(project.manifest.managedAdapters),
      ),
    ]);
    if (session === null || session.status !== 'active') {
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    }
    assertCompatibilityGate({
      manifest: project.manifest,
      expectedSchemaEpoch: project.manifest.epoch,
      readerVersion: VERSION,
      writerVersion: VERSION,
      writerCapabilities: CURRENT_WRITER_CAPABILITIES,
      adapterVersions,
      currentLegacyBaseline: legacy.baseline,
      legacyAuthorityPresent: legacy.authorityPresent,
      operation: input.compatibilityOperation ?? 'v3_business_write',
    });
    locks = await acquireOperationEntityLocks(
      operationId,
      [
        { store: homeStore, entityLockKeys: entityLocks },
        ...(input.additionalEntityLockTargets ?? []),
      ],
      { now },
    );
    if (taskRef.namespace === 'shared') {
      await assertTransportCoordinationWriteAllowed(homeStore, project.config);
    }
    const [task, coordination, codeHead] = await Promise.all([
      store.readTaskSnapshot(taskRef),
      store.readCoordinationSnapshot(taskRef, homeStore),
      taskRef.namespace === 'shared'
        ? readCheckoutCodeHead(projectRoot)
        : Promise.resolve(null),
    ]);
    if (task.aggregate === null || task.metadata.transitionState !== 'stable') {
      throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
    }
    if (coordination.pendingOperations.length > 0) {
      throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
    }
    if (task.metadata.revision !== input.expectedTaskRevision) {
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    await assertTaskParentIsWritable(store, task);
    if (taskRef.namespace === 'shared') {
      if (coordination.taskHeadFence === null || codeHead === null) {
        throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
      }
      if (input.allowTaskHeadFenceMismatch !== true) {
        try {
          assertTaskHeadFenceMatchesAggregate(
            coordination.taskHeadFence,
            task.aggregate,
            codeHead,
          );
        } catch (error) {
          await assertOwnerCodeHeadAdvance({
            projectRoot,
            task,
            fence: coordination.taskHeadFence,
            codeHead,
            actorId: session.actorId,
            originalError: error,
          });
        }
      }
    }
    return {
      projectRoot,
      taskRef,
      operationId,
      now,
      runtime,
      project,
      store,
      homeStore,
      session,
      task,
      coordination,
      codeHead,
      entityLocks,
      async renewLocks(): Promise<void> {
        await Promise.all([
          ...locks.map((lock) => lock.renew()),
          ...(projectBarrierReleased ? [] : [projectBarrier.renew()]),
        ]);
      },
      async releaseProjectBarrier(): Promise<void> {
        await releaseProjectBarrier();
      },
      async release(): Promise<void> {
        await releaseLocks(locks);
        await releaseProjectBarrier();
      },
    };
  } catch (error) {
    await releaseLocks(locks);
    await releaseProjectBarrier().catch(() => undefined);
    await recordV3ErrorDiagnostic(projectRoot, error).catch(() => undefined);
    throw error;
  }
}

async function assertOwnerCodeHeadAdvance(input: {
  projectRoot: string;
  task: StoredTaskSnapshot;
  fence: NonNullable<StoredCoordinationSnapshot['taskHeadFence']>;
  codeHead: string;
  actorId: Ulid;
  originalError: unknown;
}): Promise<void> {
  const { task, fence } = input;
  if (
    task.aggregate === null ||
    task.metadata.ownerActorId !== input.actorId ||
    fence.taskRevision !== task.metadata.revision ||
    fence.ownershipEpoch !== task.metadata.ownershipEpoch ||
    fence.aggregateDigest !== taskAggregateDigest(task.aggregate)
  ) {
    throw input.originalError;
  }
  try {
    await execFile(
      'git',
      ['merge-base', '--is-ancestor', fence.codeRef.head, input.codeHead],
      { cwd: input.projectRoot, windowsHide: true },
    );
  } catch {
    throw input.originalError;
  }
}

/**
 * A child may continue to be read for diagnosis after its parent changes, but
 * no child mutation may race ahead of the parent snapshot it was created from.
 * This check lives at the shared task-operation boundary so every V3 writer
 * receives the same gate rather than relying on individual command handlers.
 */
async function assertTaskParentIsWritable(
  store: V3ContextStore,
  task: StoredTaskSnapshot,
): Promise<void> {
  if (task.metadata.parent === null) return;
  try {
    const parent = await store.readParentSnapshot(task.metadata);
    if (parent === null) throw new Error('MANCODE_PARENT_UNAVAILABLE');
    assertParentWorkflowRelation(task.metadata, parent.metadata);
    if (parent.staleReasons.length > 0) {
      throw new Error('MANCODE_PARENT_STALE');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'MANCODE_PARENT_STALE') {
      throw error;
    }
    throw new Error('MANCODE_PARENT_UNAVAILABLE');
  }
}

/**
 * Writes the durable prepared journal after authorizing against the locked
 * snapshot. Operation definitions still validate all required key families.
 */
export async function createTaskOperationJournal(
  context: OpenedV3TaskOperation,
  input: CreateTaskOperationJournalInput,
): Promise<OperationJournalV1> {
  const action = input.action;
  const shared = context.taskRef.namespace === 'shared';
  if (shared) {
    await assertTransportCoordinationWriteAllowed(
      context.homeStore,
      context.project.config,
    );
  }
  const joined = shared
    ? (await readSharedActorProfile(
        context.projectRoot,
        context.session.actorId,
      )) !== null
    : false;
  const taskContext: AuthorizationTaskContext = {
    ownerActorId: context.task.metadata.ownerActorId,
    participantActorIds: context.task.metadata.participants,
  };
  const authorizationBasis = createAuthorizationBasis(
    {
      action,
      actorId: context.session.actorId,
      session: {
        sessionId: context.session.sessionId,
        actorId: context.session.actorId,
        status: context.session.status,
      },
      joined,
      sharedWriteGuard: capabilitiesFromProjectConfig(context.project.config)
        .writeGuard,
      task: input.task ?? taskContext,
      claim: input.claim ?? null,
      handoff: input.handoff ?? null,
      evidence: input.evidence ?? null,
      profileActorId: input.profileActorId ?? null,
      conditions: {
        expectedRevisionMatches: true,
        ownershipEpochFresh: shared,
        ...input.conditions,
      },
    },
    context.now,
  );
  const definition = getOperationDefinition(input.type);
  const entityLocks = uniqueEntityLocks([
    ...context.entityLocks,
    ...(input.entityLocks ?? []),
  ]);
  const recovery =
    input.recovery === undefined
      ? null
      : parseOperationRecoveryPayload({
          schemaVersion: 1,
          operationId: context.operationId,
          type: input.type,
          primaryStoreId: context.homeStore.storeId,
          actions: input.recovery.actions,
          noOpStepIds: input.recovery.noOpStepIds ?? [],
        });
  const journal: OperationJournalV1 = {
    schemaVersion: 1,
    operationId: context.operationId,
    type: input.type,
    state: 'prepared',
    primaryStoreId: context.homeStore.storeId,
    checkoutId: context.runtime.checkoutId,
    secondaryReservations: [],
    actorId: context.session.actorId,
    sessionId: context.session.sessionId,
    authorizationBasis,
    ...(recovery === null
      ? {}
      : { recoveryPayloadDigest: operationRecoveryPayloadDigest(recovery) }),
    entityLocks,
    expectedRevisions: { ...input.expectedRevisions },
    steps: definition.steps.map((step) => ({ id: step.id, state: 'pending' })),
    startedAt: context.now.toISOString(),
    updatedAt: context.now.toISOString(),
  };
  assertOperationJournalMatchesDefinition(journal);
  if (recovery !== null) {
    assertOperationRecoveryPayloadCoversJournal(journal, recovery);
    await writeOperationRecoveryPayload(context.homeStore, recovery);
  }
  const created = await createPreparedOperationJournal(
    context.homeStore,
    journal,
  );
  await context.releaseProjectBarrier();
  throwIfOperationCrashInjected(input.type, 'prepared');
  const lockPause = pauseIfOperationLockInjectedForTesting(
    context.operationId,
    'entity_locks_held',
  );
  if (lockPause !== null) await lockPause;
  return created;
}

/** Mark a step's durable intent before executing the corresponding write. */
export async function advanceTaskOperation(
  context: OpenedV3TaskOperation,
  previous: OperationJournalV1,
  stepId: string,
  canAbort: boolean,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(previous.type);
  await context.renewLocks();
  const next = await updateOperationJournal(
    context.homeStore,
    {
      ...previous,
      state: 'applying',
      steps: completeOperationStep(previous.steps, stepId),
      updatedAt: context.now.toISOString(),
    },
    { canAbort },
  );
  injectAfterTaskOperationStep(previous.type, stepId);
  return next;
}

export async function commitTaskOperation(
  context: OpenedV3TaskOperation,
  previous: OperationJournalV1,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(previous.type);
  await context.renewLocks();
  const next = await updateOperationJournal(
    context.homeStore,
    {
      ...previous,
      state: 'committed',
      steps: completeOperationStep(previous.steps, 'commit'),
      updatedAt: context.now.toISOString(),
    },
    { canAbort: false },
  );
  throwIfOperationCrashInjected(previous.type, 'commit');
  await refreshActiveSessionRevision(context);
  return next;
}

async function refreshActiveSessionRevision(
  context: OpenedV3TaskOperation,
): Promise<void> {
  try {
    const session = await readSession(
      context.projectRoot,
      context.session.sessionId,
    );
    if (
      session === null ||
      session.status !== 'active' ||
      session.activeTaskRef === null ||
      !sameTaskRef(session.activeTaskRef, context.taskRef)
    ) {
      return;
    }
    const task = await context.store.readTaskSnapshot(context.taskRef);
    if (
      task.metadata.status !== 'in_progress' &&
      task.metadata.status !== 'blocked'
    ) {
      return;
    }
    await resumeSession(context.projectRoot, session.sessionId, {
      taskRef: context.taskRef,
      workflowMode: task.metadata.workflowMode,
      taskRevision: task.metadata.revision,
      now: context.now,
    });
  } catch {
    // Workflow authority is already committed. A later context resume can
    // repair this session-only convenience projection.
  }
}

export async function handleTaskOperationFailure(
  context: OpenedV3TaskOperation,
  journal: OperationJournalV1,
): Promise<void> {
  if (journal.state === 'committed' || journal.state === 'aborted') return;
  if (hasBusinessWriteIntent(journal)) {
    try {
      await updateOperationJournal(
        context.homeStore,
        {
          ...journal,
          state: 'repair_required',
          updatedAt: context.now.toISOString(),
        },
        { canAbort: false },
      );
    } catch {
      // The already-durable write intent remains enough to block normal work.
    }
    return;
  }
  await updateOperationJournal(
    context.homeStore,
    {
      ...journal,
      state: 'aborted',
      updatedAt: context.now.toISOString(),
    },
    { canAbort: true },
  );
}

/** Fixed-name authority writer; callers cannot smuggle arbitrary paths. */
export async function writeTaskAuthorityFile(
  context: OpenedV3TaskOperation,
  fileName: string,
  content: string,
): Promise<void> {
  await writeTaskAuthorityFileAtRoot(
    context.task.location.taskRoot,
    context.operationId,
    fileName,
    content,
  );
}

export async function writeTaskArchive(
  context: OpenedV3TaskOperation,
  action: TaskArchiveRecoveryAction,
): Promise<void> {
  if (
    !sameTaskRef(action.taskRef, context.taskRef) ||
    action.archiveId !== context.operationId
  ) {
    throw new Error('MANCODE_REFRAME_ARCHIVE_OPERATION_MISMATCH');
  }
  await writeTaskArchiveAtRoot(
    context.task.location.taskRoot,
    context.operationId,
    action,
  );
}

/** Atomically publishes one immutable operation-owned archive directory. */
export async function writeTaskArchiveAtRoot(
  taskRoot: string,
  operationId: Ulid,
  action: TaskArchiveRecoveryAction,
): Promise<void> {
  assertUlid(operationId, 'task archive operationId');
  if (action.archiveId !== operationId) {
    throw new Error('MANCODE_REFRAME_ARCHIVE_OPERATION_MISMATCH');
  }
  await assertSafeTaskDirectory(taskRoot);
  const archiveRoot = await ensureSafeTaskChildDirectory(taskRoot, 'archives');
  if ((await readTaskArchiveDigestAtRoot(taskRoot, action)) !== null) return;

  const staging = path.join(archiveRoot, `.${operationId}.staging`);
  const target = path.join(archiveRoot, operationId);
  await removeSafeArchiveStaging(staging);
  await mkdir(staging);
  try {
    await writeFile(
      path.join(staging, 'archive.json'),
      serializeTaskAuthority(taskArchiveManifest(action)),
      { encoding: 'utf8', flag: 'wx' },
    );
    await writeFile(
      path.join(staging, 'requirements.json'),
      action.requirementsContent,
      { encoding: 'utf8', flag: 'wx' },
    );
    if (action.planContent !== null) {
      await writeFile(path.join(staging, 'plan.md'), action.planContent, {
        encoding: 'utf8',
        flag: 'wx',
      });
    }
    await rename(staging, target);
  } catch (error) {
    await removeSafeArchiveStaging(staging);
    if (isAlreadyExists(error) || isDirectoryNotEmpty(error)) {
      const existing = await readTaskArchiveDigestAtRoot(taskRoot, action);
      if (existing === taskArchiveDigest(action)) return;
      throw new Error('MANCODE_REFRAME_ARCHIVE_CONFLICT');
    }
    throw error;
  }
}

export async function readTaskArchiveDigestAtRoot(
  taskRoot: string,
  action: TaskArchiveRecoveryAction,
): Promise<string | null> {
  await assertSafeTaskDirectory(taskRoot);
  const archiveRoot = path.join(taskRoot, 'archives');
  try {
    const rootEntry = await lstat(archiveRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const target = path.join(archiveRoot, action.archiveId);
  try {
    const targetEntry = await lstat(target);
    if (!targetEntry.isDirectory() || targetEntry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const expectedNames = [
    'archive.json',
    'requirements.json',
    ...(action.planContent === null ? [] : ['plan.md']),
  ].sort();
  const names = (await readdir(target)).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error('MANCODE_REFRAME_ARCHIVE_CONFLICT');
  }
  const archiveContent = await readImmutableArchiveFile(
    path.join(target, 'archive.json'),
  );
  const requirementsContent = await readImmutableArchiveFile(
    path.join(target, 'requirements.json'),
  );
  const planContent =
    action.planContent === null
      ? null
      : await readImmutableArchiveFile(path.join(target, 'plan.md'));
  if (
    archiveContent !== serializeTaskAuthority(taskArchiveManifest(action)) ||
    requirementsContent !== action.requirementsContent ||
    planContent !== action.planContent
  ) {
    throw new Error('MANCODE_REFRAME_ARCHIVE_CONFLICT');
  }
  return taskArchiveDigest(action);
}

/** Fixed-name authority reader used by forward repair; it never follows links. */
export async function readTaskAuthorityFileAtRoot(
  taskRoot: string,
  fileName: TaskAuthorityFileName,
): Promise<string | null> {
  assertTaskAuthorityFileName(fileName);
  await assertSafeTaskDirectory(taskRoot);
  const target = path.join(taskRoot, fileName);
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    const content = await readFile(target, 'utf8');
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    return content;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Fixed-name authority writer usable by normal paths and recovery alike. */
export async function writeTaskAuthorityFileAtRoot(
  taskRoot: string,
  operationId: Ulid,
  fileName: string,
  content: string,
): Promise<void> {
  if (!TASK_AUTHORITY_FILES.has(fileName) || content.includes('\0')) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  assertUlid(operationId, 'task authority operationId');
  await assertSafeTaskDirectory(taskRoot);
  const target = path.join(taskRoot, fileName);
  const temporary = path.join(
    taskRoot,
    `.${fileName}.${operationId}.${process.pid}.tmp`,
  );
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await replaceFileAtomically(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const written = await lstat(target);
  if (!written.isFile() || written.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

/**
 * Creates one immutable checkpoint under its canonical task-local path. A
 * retry may observe the exact same snapshot, but a different value for the
 * same checkpoint ID is always a durable conflict rather than an overwrite.
 */
export async function writeTaskCheckpoint(
  context: OpenedV3TaskOperation,
  value: CheckpointV1,
): Promise<CheckpointV1> {
  const checkpoint = parseCheckpoint(value);
  if (
    !sameTaskRef(checkpoint.taskRef, context.taskRef) ||
    checkpoint.operationId !== context.operationId
  ) {
    throw new Error('MANCODE_CHECKPOINT_OPERATION_MISMATCH');
  }
  return writeTaskCheckpointAtRoot(context.task.location.taskRoot, checkpoint);
}

/** Immutable checkpoint writer usable by the original operation and repair. */
export async function writeTaskCheckpointAtRoot(
  taskRoot: string,
  value: CheckpointV1,
): Promise<CheckpointV1> {
  const checkpoint = parseCheckpoint(value);
  await assertSafeTaskDirectory(taskRoot);
  const directory = await ensureSafeTaskChildDirectory(taskRoot, 'checkpoints');
  const target = path.join(directory, `${checkpoint.checkpointId}.json`);
  const serialized = serializeTaskAuthority(checkpoint);
  try {
    await writeFile(target, serialized, { encoding: 'utf8', flag: 'wx' });
    const written = await lstat(target);
    if (!written.isFile() || written.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    return checkpoint;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readImmutableCheckpoint(target);
    if (checkpointDigest(existing) === checkpointDigest(checkpoint)) {
      return existing;
    }
    throw new Error('MANCODE_CHECKPOINT_ID_CONFLICT');
  }
}

/** Reads a fixed checkpoint path without permitting a linked task subtree. */
export async function readTaskCheckpointAtRoot(
  taskRoot: string,
  checkpointId: Ulid,
): Promise<CheckpointV1 | null> {
  assertUlid(checkpointId, 'checkpointId');
  await assertSafeTaskDirectory(taskRoot);
  const directory = path.join(taskRoot, 'checkpoints');
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    return await readImmutableCheckpoint(
      path.join(directory, `${checkpointId}.json`),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'MANCODE_CHECKPOINT_ID_CONFLICT'
    ) {
      return null;
    }
    throw error;
  }
}

export function serializeTaskAuthority(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function taskEntityKey(taskRef: TaskRef): string {
  const parsed = parseTaskRefValue(taskRef);
  return `task:${parsed.namespace}:${parsed.taskId}`;
}

export function taskHeadEntityKey(taskRef: TaskRef): string {
  const parsed = parseTaskRefValue(taskRef);
  if (parsed.namespace !== 'shared') {
    throw new Error('task head entity keys require shared TaskRef');
  }
  return `task_head:${parsed.taskId}`;
}

function completeOperationStep(
  steps: OperationStep[],
  stepId: string,
): OperationStep[] {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error('MANCODE_OPERATION_STEP_INVALID');
  if (steps[index]?.state === 'completed') {
    throw new Error('MANCODE_OPERATION_STEP_ALREADY_COMPLETED');
  }
  if (steps.slice(0, index).some((step) => step.state !== 'completed')) {
    throw new Error('MANCODE_OPERATION_STEP_ORDER_INVALID');
  }
  return steps.map((step, currentIndex) =>
    currentIndex === index ? { ...step, state: 'completed' as const } : step,
  );
}

function injectAfterTaskOperationStep(
  operationType: OperationType,
  stepId: string,
): void {
  const step = getOperationDefinition(operationType).steps.find(
    (candidate) => candidate.id === stepId,
  );
  if (step?.visibility === 'business_write') {
    armOperationCrashAfterVisibleWrite(operationType, stepId);
    return;
  }
  throwIfOperationCrashInjected(operationType, stepId);
}

function hasBusinessWriteIntent(journal: OperationJournalV1): boolean {
  const definition = getOperationDefinition(journal.type);
  return journal.steps.some(
    (step, index) =>
      step.state === 'completed' &&
      definition.steps[index]?.visibility === 'business_write',
  );
}

function assertTaskAuthorityFileName(
  value: string,
): asserts value is TaskAuthorityFileName {
  if (!TASK_AUTHORITY_FILES.has(value)) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

function uniqueEntityLocks(keys: string[]): string[] {
  if (keys.length === 0)
    throw new Error('task operation requires an entity lock');
  const unique = new Set<string>();
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_-]*:[^\0/\\]+$/.test(key) || key.includes('..')) {
      throw new Error('MANCODE_ENTITY_LOCK_INVALID');
    }
    unique.add(key);
  }
  return [...unique].sort((left, right) =>
    Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
  );
}

async function assertSafeTaskDirectory(taskRoot: string): Promise<void> {
  const entry = await lstat(taskRoot);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

async function ensureSafeTaskChildDirectory(
  taskRoot: string,
  child: 'checkpoints' | 'archives',
): Promise<string> {
  const directory = path.join(taskRoot, child);
  try {
    await mkdir(directory);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  return directory;
}

async function readImmutableArchiveFile(target: string): Promise<string> {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const content = await readFile(target, 'utf8');
  const after = await lstat(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  return content;
}

async function removeSafeArchiveStaging(staging: string): Promise<void> {
  try {
    const entry = await lstat(staging);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    await rm(staging, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function readImmutableCheckpoint(target: string): Promise<CheckpointV1> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(target);
  } catch (error) {
    if (isNotFound(error)) throw new Error('MANCODE_CHECKPOINT_ID_CONFLICT');
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  try {
    const checkpoint = parseCheckpoint(
      JSON.parse(await readFile(target, 'utf8')),
    );
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    return checkpoint;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_CHECKPOINT_CORRUPT');
    }
    throw error;
  }
}

async function releaseLocks(locks: LocalLockHandle[]): Promise<void> {
  await Promise.allSettled([...locks].reverse().map((lock) => lock.release()));
}

function requireProjectRoot(value: string): string {
  if (!value.trim() || value.includes('\0')) {
    throw new Error('task operation projectRoot is required');
  }
  return value;
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isDirectoryNotEmpty(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOTEMPTY'
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

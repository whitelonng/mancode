import type { Stats } from 'node:fs';
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
import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import {
  assertSchemaManifestPolicyUpgrade,
  assertSchemaManifestTransition,
  parseSchemaManifest,
} from '../context/manifest.js';
import { parseMigrationStage } from '../context/migrate.js';
import { V3ContextStore } from '../context/store.js';
import { taskRootPath } from '../context/task-locator.js';
import { type TaskRef, sameTaskRef } from '../context/task-ref.js';
import {
  applyV3AdapterFilePlan,
  assertV3AdapterTargetSafe,
  v3AdapterTargetPath,
} from '../installers/v3-adapter.js';
import {
  assertProjectConfigTransition,
  assertTeamPolicyTransition,
  parseProjectConfig,
  parseTeamPolicy,
} from '../team/policy.js';
import { createClaim, readClaim, updateClaim } from './claim-store.js';
import { recordLocalDiagnostic } from './diagnostics.js';
import {
  type EntityHomeStore,
  resolveCoordinationEntityHomeStore,
  resolveLocalEntityHomeStore,
} from './entity-home-store.js';
import { createHandoff, readHandoff, updateHandoff } from './handoff-store.js';
import {
  type LocalLockHandle,
  acquireOperationEntityLocks,
} from './local-lock.js';
import { getOperationDefinition } from './operation-definition.js';
import type { OperationJournalV1 } from './operation-journal.js';
import {
  type OperationRecoveryActionV1,
  type OperationRecoveryPayloadV1,
  adapterFileContentDigest,
  assertOperationRecoveryPayloadCoversJournal,
  migrationStageContentDigest,
  migrationTaskDirectoryDigest,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
  projectAuthorityContentDigest,
  recoveryActionResourceKey,
  recoveryActionTargetDigest,
  taskAuthorityContentDigest,
  workflowTaskDirectoryDigest,
} from './operation-recovery-payload.js';
import { readOperationRecoveryPayload } from './operation-recovery-store.js';
import {
  readOperationReservation,
  removeOperationReservation,
} from './operation-reservation.js';
import {
  listUnfinishedOperationJournals,
  readOperationJournal,
  updateOperationJournal,
} from './operation-store.js';
import { readProjectRuntimeContext } from './project-runtime.js';
import { inspectOperationProjectionState } from './projection-outbox.js';
import { assertRecoveryActor, planOperationRecovery } from './reconciler.js';
import { readSession } from './session.js';
import { readTaskHeadFence, replaceTaskHeadFence } from './task-head-store.js';
import {
  readTaskArchiveDigestAtRoot,
  readTaskAuthorityFileAtRoot,
  readTaskCheckpointAtRoot,
  writeTaskArchiveAtRoot,
  writeTaskAuthorityFileAtRoot,
  writeTaskCheckpointAtRoot,
} from './task-operation.js';

export type OperationRecoveryExecutionState =
  | 'already_terminal'
  | 'aborted'
  | 'repaired'
  | 'repair_required';

export interface ExecuteOperationRecoveryInput {
  projectRoot: string;
  operationId: Ulid;
  actorId: Ulid;
  sessionId: Ulid;
  mode?: 'repair' | 'abort';
  now?: Date;
}

export interface ExecutedOperationRecovery {
  state: OperationRecoveryExecutionState;
  journal: OperationJournalV1;
  reason: string;
}

export interface InspectedOperationRecovery {
  journal: OperationJournalV1;
  recoveryAction: ReturnType<typeof planOperationRecovery>['action'];
  recoveryReason: ReturnType<typeof planOperationRecovery>['reason'];
  payloadBound: boolean;
}

export async function inspectOperationRecovery(
  projectRoot: string,
  operationId: Ulid,
): Promise<InspectedOperationRecovery> {
  assertUlid(operationId, 'operation recovery operationId');
  const stores = await knownOperationStores(projectRoot);
  const located = await locateJournal(stores, operationId);
  if (located === null) throw new Error('MANCODE_OPERATION_JOURNAL_NOT_FOUND');
  const plan = planOperationRecovery({
    journal: located.journal,
    reservations: await readReservations(located.journal, stores),
    projections: await inspectOperationProjectionState(
      projectRoot,
      operationId,
    ),
  });
  return {
    journal: located.journal,
    recoveryAction: plan.action,
    recoveryReason: plan.reason,
    payloadBound: located.journal.recoveryPayloadDigest !== undefined,
  };
}

export async function listUnfinishedOperationRecoveries(
  projectRoot: string,
): Promise<InspectedOperationRecovery[]> {
  const stores = await knownOperationStores(projectRoot);
  const journals = (
    await Promise.all(
      stores.map(async (store) =>
        (
          await listUnfinishedOperationJournals(store)
        ).map((journal) => ({
          journal,
        })),
      ),
    )
  ).flat();
  return Promise.all(
    journals.map(async ({ journal }) => {
      const plan = planOperationRecovery({
        journal,
        reservations: await readReservations(journal, stores),
      });
      return {
        journal,
        recoveryAction: plan.action,
        recoveryReason: plan.reason,
        payloadBound: journal.recoveryPayloadDigest !== undefined,
      };
    }),
  );
}

/**
 * Applies only exact, journal-bound recovery targets under the original
 * canonical locks. It never substitutes a different actor, session, plan,
 * claim, or handoff after a crash.
 */
export async function executeOperationRecovery(
  input: ExecuteOperationRecoveryInput,
): Promise<ExecutedOperationRecovery> {
  assertUlid(input.operationId, 'operation recovery operationId');
  assertUlid(input.actorId, 'operation recovery actorId');
  assertUlid(input.sessionId, 'operation recovery sessionId');
  const now = input.now ?? new Date();
  const mode = input.mode ?? 'repair';
  const stores = await knownOperationStores(input.projectRoot);
  const located = await locateJournal(stores, input.operationId);
  if (located === null) throw new Error('MANCODE_OPERATION_JOURNAL_NOT_FOUND');
  const session = await readSession(input.projectRoot, input.sessionId);
  if (
    session === null ||
    session.status !== 'active' ||
    session.actorId !== input.actorId
  ) {
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  }
  const initialPlan = planOperationRecovery({
    journal: located.journal,
    reservations: await readReservations(located.journal, stores),
  });
  assertRecoveryActor(initialPlan, input.actorId, input.sessionId);
  if (
    located.journal.state === 'committed' ||
    located.journal.state === 'aborted'
  ) {
    return {
      state: 'already_terminal',
      journal: located.journal,
      reason: 'terminal',
    };
  }

  const locks = await acquireRecoveryOperationLocks(
    located.store,
    located.journal,
    stores,
    now,
  );
  try {
    const journal = await readOperationJournal(
      located.store,
      input.operationId,
    );
    if (journal === null)
      throw new Error('MANCODE_OPERATION_JOURNAL_NOT_FOUND');
    const plan = planOperationRecovery({
      journal,
      reservations: await readReservations(journal, stores),
    });
    assertRecoveryActor(plan, input.actorId, input.sessionId);
    if (journal.state === 'committed' || journal.state === 'aborted') {
      return { state: 'already_terminal', journal, reason: 'terminal' };
    }
    const payload = await loadBoundPayload(located.store, journal);
    if (payload === null) {
      if (plan.action === 'safe_abort') {
        const aborted = await abortOperation(
          located.store,
          journal,
          stores,
          now,
        );
        return {
          state: 'aborted',
          journal: aborted,
          reason: 'no_external_write',
        };
      }
      if (mode === 'abort') throw new Error('MANCODE_OPERATION_ABORT_UNSAFE');
      const blocked = await markRepairRequired(located.store, journal, now);
      return {
        state: 'repair_required',
        journal: blocked,
        reason: 'MANCODE_OPERATION_RECOVERY_PAYLOAD_REQUIRED',
      };
    }
    assertOperationRecoveryPayloadCoversJournal(journal, payload);
    try {
      await removePrivateWorkflowStaging(input.projectRoot, journal, payload);
    } catch (error) {
      const blocked = await markRepairRequired(located.store, journal, now);
      return {
        state: 'repair_required',
        journal: blocked,
        reason:
          error instanceof Error &&
          error.message === 'MANCODE_OPERATION_RECOVERY_STAGING_UNSAFE'
            ? 'MANCODE_OPERATION_RECOVERY_STAGING_UNSAFE'
            : 'MANCODE_OPERATION_RECOVERY_FAILED',
      };
    }
    if (await allActionsAtInitialState(input.projectRoot, stores, payload)) {
      const aborted = await abortOperation(located.store, journal, stores, now);
      return {
        state: 'aborted',
        journal: aborted,
        reason: 'no_external_write',
      };
    }
    if (mode === 'abort') throw new Error('MANCODE_OPERATION_ABORT_UNSAFE');
    try {
      const repaired = await applyPayload(
        input.projectRoot,
        located.store,
        stores,
        journal,
        payload,
        now,
      );
      try {
        await removeReservations(repaired, stores);
      } catch {
        // The primary journal is already committed. Retaining a stale
        // reservation is diagnosable, but it must not be rewritten back to a
        // non-terminal state after the durable commit point.
      }
      await recordLocalDiagnostic(input.projectRoot, {
        kind: 'repair_operation',
      }).catch(() => undefined);
      return {
        state: 'repaired',
        journal: repaired,
        reason: 'forward_repair',
      };
    } catch (error) {
      const blocked = await markRepairRequired(located.store, journal, now);
      return {
        state: 'repair_required',
        journal: blocked,
        reason:
          error instanceof Error &&
          error.message === 'MANCODE_OPERATION_RECOVERY_CONFLICT'
            ? 'MANCODE_OPERATION_RECOVERY_CONFLICT'
            : 'MANCODE_OPERATION_RECOVERY_FAILED',
      };
    }
  } finally {
    await releaseLocks(locks);
  }
}

async function knownOperationStores(
  projectRoot: string,
): Promise<EntityHomeStore[]> {
  const runtime = await readProjectRuntimeContext(projectRoot);
  const stores = [
    resolveLocalEntityHomeStore(runtime.entityHomeStoreContext),
    resolveCoordinationEntityHomeStore(runtime.entityHomeStoreContext),
  ];
  return stores.filter(
    (store, index) =>
      stores.findIndex((candidate) => candidate.storeId === store.storeId) ===
      index,
  );
}

async function locateJournal(
  stores: EntityHomeStore[],
  operationId: Ulid,
): Promise<{ store: EntityHomeStore; journal: OperationJournalV1 } | null> {
  const found = (
    await Promise.all(
      stores.map(async (store) => ({
        store,
        journal: await readOperationJournal(store, operationId),
      })),
    )
  ).filter(
    (
      candidate,
    ): candidate is { store: EntityHomeStore; journal: OperationJournalV1 } =>
      candidate.journal !== null,
  );
  if (found.length > 1) throw new Error('MANCODE_OPERATION_JOURNAL_CONFLICT');
  return found[0] ?? null;
}

async function readReservations(
  journal: OperationJournalV1,
  stores: EntityHomeStore[],
) {
  const byId = new Map(stores.map((store) => [store.storeId, store]));
  return Promise.all(
    journal.secondaryReservations.map(async (reservation) => {
      const store = byId.get(reservation.storeId);
      return store === undefined
        ? null
        : readOperationReservation(store, journal.operationId);
    }),
  ).then((values) => values.filter((value) => value !== null));
}

async function acquireRecoveryOperationLocks(
  primaryStore: EntityHomeStore,
  journal: OperationJournalV1,
  stores: EntityHomeStore[],
  now: Date,
): Promise<LocalLockHandle[]> {
  const byId = new Map(stores.map((store) => [store.storeId, store]));
  const secondaryTargets = journal.secondaryReservations.map((reservation) => {
    const store = byId.get(reservation.storeId);
    if (store === undefined) {
      throw new Error('MANCODE_OPERATION_RESERVATION_STORE_UNAVAILABLE');
    }
    return { store, entityLockKeys: reservation.entityKeys };
  });
  return acquireOperationEntityLocks(
    journal.operationId,
    [
      { store: primaryStore, entityLockKeys: journal.entityLocks },
      ...secondaryTargets,
    ],
    { now },
  );
}

async function loadBoundPayload(
  store: EntityHomeStore,
  journal: OperationJournalV1,
): Promise<OperationRecoveryPayloadV1 | null> {
  if (journal.recoveryPayloadDigest === undefined) return null;
  const payload = await readOperationRecoveryPayload(
    store,
    journal.operationId,
  );
  if (payload === null) {
    throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_MISSING');
  }
  const parsed = parseOperationRecoveryPayload(payload);
  if (
    parsed.operationId !== journal.operationId ||
    parsed.type !== journal.type ||
    parsed.primaryStoreId !== journal.primaryStoreId ||
    operationRecoveryPayloadDigest(parsed) !== journal.recoveryPayloadDigest
  ) {
    throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_MISMATCH');
  }
  return parsed;
}

async function allActionsAtInitialState(
  projectRoot: string,
  stores: EntityHomeStore[],
  payload: OperationRecoveryPayloadV1,
): Promise<boolean> {
  const initialByResource = new Map<string, OperationRecoveryActionV1>();
  for (const action of payload.actions) {
    const key = recoveryActionResourceKey(action);
    if (!initialByResource.has(key)) initialByResource.set(key, action);
  }
  for (const action of initialByResource.values()) {
    const current = await currentActionDigest(projectRoot, stores, action);
    if (current !== action.beforeDigest) return false;
  }
  return true;
}

async function applyPayload(
  projectRoot: string,
  primaryStore: EntityHomeStore,
  stores: EntityHomeStore[],
  initialJournal: OperationJournalV1,
  payload: OperationRecoveryPayloadV1,
  now: Date,
): Promise<OperationJournalV1> {
  let journal = initialJournal;
  const definition = getOperationDefinition(journal.type);
  for (const [index, action] of payload.actions.entries()) {
    const stepIndex = definition.steps.findIndex(
      (step) => step.id === action.stepId,
    );
    if (stepIndex < 0) {
      throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_STEP_INVALID');
    }
    const current = await currentActionDigest(projectRoot, stores, action);
    const target = recoveryActionTargetDigest(action);
    const laterTarget = payload.actions
      .slice(index + 1)
      .some(
        (candidate) =>
          recoveryActionResourceKey(candidate) ===
            recoveryActionResourceKey(action) &&
          recoveryActionTargetDigest(candidate) === current,
      );
    if (current !== target && current !== action.beforeDigest && !laterTarget) {
      throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
    }
    journal = await completeJournalThrough(
      primaryStore,
      journal,
      stepIndex,
      now,
    );
    if (current === target || laterTarget) continue;
    await applyAction(
      projectRoot,
      stores,
      journal.operationId,
      journal.actorId,
      journal.type,
      action,
    );
  }
  const applying = await completeJournalThrough(
    primaryStore,
    journal,
    journal.steps.length - 1,
    now,
  );
  return updateOperationJournal(
    primaryStore,
    {
      ...applying,
      state: 'committed',
      updatedAt: now.toISOString(),
    },
    { canAbort: false },
  );
}

async function completeJournalThrough(
  store: EntityHomeStore,
  initial: OperationJournalV1,
  lastIndex: number,
  now: Date,
): Promise<OperationJournalV1> {
  let journal = initial;
  for (let index = 0; index <= lastIndex; index += 1) {
    if (journal.steps[index]?.state === 'completed') continue;
    journal = await updateOperationJournal(
      store,
      {
        ...journal,
        state: journal.state === 'prepared' ? 'applying' : journal.state,
        steps: journal.steps.map((step, stepIndex) =>
          stepIndex === index ? { ...step, state: 'completed' as const } : step,
        ),
        updatedAt: now.toISOString(),
      },
      { canAbort: false },
    );
  }
  return journal;
}

async function applyAction(
  projectRoot: string,
  stores: EntityHomeStore[],
  operationId: Ulid,
  actorId: Ulid,
  operationType: OperationJournalV1['type'],
  action: OperationRecoveryActionV1,
): Promise<void> {
  switch (action.kind) {
    case 'task_authority_file': {
      const root = await taskRoot(projectRoot, action.taskRef);
      await writeTaskAuthorityFileAtRoot(
        root,
        operationId,
        action.fileName,
        action.targetContent,
      );
      return;
    }
    case 'task_archive': {
      const root = await taskRoot(projectRoot, action.taskRef);
      await writeTaskArchiveAtRoot(root, operationId, action);
      return;
    }
    case 'workflow_task_directory':
      await publishWorkflowDirectory(projectRoot, operationId, action);
      return;
    case 'migration_task_directory':
      await publishMigrationDirectory(projectRoot, operationId, action);
      return;
    case 'project_authority_file':
      assertProjectAuthorityTransition(action, operationType);
      await writeProjectAuthorityFile(
        projectRoot,
        operationId,
        action.fileName,
        action.targetContent,
      );
      return;
    case 'migration_stage_file':
      assertMigrationStageTransition(action);
      await writeMigrationStageFile(
        projectRoot,
        operationId,
        action.stageId,
        action.targetContent,
      );
      return;
    case 'v3_adapter_file':
      await applyV3AdapterFilePlan(projectRoot, {
        target: action.target,
        beforeContent: action.beforeContent,
        targetContent: action.targetContent,
      });
      return;
    case 'checkpoint': {
      const root = await taskRoot(projectRoot, action.checkpoint.taskRef);
      await writeTaskCheckpointAtRoot(root, action.checkpoint);
      return;
    }
    case 'task_head_fence':
      await replaceTaskHeadFence(
        taskEntityHomeStore(stores, action.fence.taskRef),
        action.fence,
      );
      return;
    case 'claim': {
      const store = coordinationEntityHomeStore(stores);
      const current = await readClaim(store, action.claim.claimId);
      if (current === null) {
        await createClaim(store, action.claim);
      } else {
        await updateClaim(store, action.claim, current.revision);
      }
      return;
    }
    case 'handoff': {
      const store = coordinationEntityHomeStore(stores);
      const current = await readHandoff(store, action.handoff.handoffId);
      if (current === null) {
        await createHandoff(store, action.handoff);
      } else {
        await updateHandoff(store, action.handoff, current.revision, actorId);
      }
      return;
    }
  }
}

function assertProjectAuthorityTransition(
  action: Extract<
    OperationRecoveryActionV1,
    { kind: 'project_authority_file' }
  >,
  operationType: OperationJournalV1['type'],
): void {
  if (action.beforeContent === null) {
    throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
  }
  switch (action.fileName) {
    case 'schema.json': {
      const previous = parseSchemaManifest(JSON.parse(action.beforeContent));
      const next = parseSchemaManifest(JSON.parse(action.targetContent));
      if (operationType === 'project_policy_upgrade') {
        assertSchemaManifestPolicyUpgrade(previous, next);
      } else {
        assertSchemaManifestTransition(previous, next);
      }
      return;
    }
    case 'shared/config.json':
      assertProjectConfigTransition(
        parseProjectConfig(JSON.parse(action.beforeContent)),
        parseProjectConfig(JSON.parse(action.targetContent)),
        'ordinary',
      );
      return;
    case 'shared/team/policy.json':
      assertTeamPolicyTransition(
        parseTeamPolicy(JSON.parse(action.beforeContent)),
        parseTeamPolicy(JSON.parse(action.targetContent)),
      );
  }
}

function assertMigrationStageTransition(
  action: Extract<OperationRecoveryActionV1, { kind: 'migration_stage_file' }>,
): void {
  if (action.beforeContent === null) {
    throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
  }
  const previous = parseMigrationStage(JSON.parse(action.beforeContent));
  const next = parseMigrationStage(JSON.parse(action.targetContent));
  if (
    previous.stageId !== action.stageId ||
    next.stageId !== action.stageId ||
    previous.state !== 'staged' ||
    next.state !== 'activated' ||
    next.revision !== previous.revision + 1 ||
    previous.sourceInventoryDigest !== next.sourceInventoryDigest ||
    previous.sourceBaseline.stateDigest !== next.sourceBaseline.stateDigest ||
    previous.sourceBaseline.workflowIndexDigest !==
      next.sourceBaseline.workflowIndexDigest
  ) {
    throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
  }
}

async function currentActionDigest(
  projectRoot: string,
  stores: EntityHomeStore[],
  action: OperationRecoveryActionV1,
): Promise<string | null> {
  switch (action.kind) {
    case 'task_authority_file': {
      const content = await readTaskAuthorityFileAtRoot(
        await taskRoot(projectRoot, action.taskRef),
        action.fileName,
      );
      return content === null
        ? null
        : taskAuthorityContentDigest(action.fileName, content);
    }
    case 'task_archive':
      return readTaskArchiveDigestAtRoot(
        await taskRoot(projectRoot, action.taskRef),
        action,
      );
    case 'workflow_task_directory':
      return currentWorkflowDirectoryDigest(projectRoot, action);
    case 'migration_task_directory':
      return currentMigrationDirectoryDigest(projectRoot, action);
    case 'project_authority_file': {
      const content = await readProjectAuthorityFile(
        projectRoot,
        action.fileName,
      );
      return content === null
        ? null
        : projectAuthorityContentDigest(action.fileName, content);
    }
    case 'migration_stage_file': {
      const content = await readMigrationStageFile(projectRoot, action.stageId);
      return content === null ? null : migrationStageContentDigest(content);
    }
    case 'v3_adapter_file': {
      const content = await readAdapterFile(projectRoot, action.target);
      return adapterFileContentDigest(action.target, content);
    }
    case 'checkpoint': {
      const checkpoint = await readTaskCheckpointAtRoot(
        await taskRoot(projectRoot, action.checkpoint.taskRef),
        action.checkpoint.checkpointId,
      );
      return checkpoint === null ? null : digestCanonicalJson(checkpoint);
    }
    case 'task_head_fence': {
      const fence = await readTaskHeadFence(
        taskEntityHomeStore(stores, action.fence.taskRef),
        action.fence.taskRef,
      );
      return fence === null ? null : digestCanonicalJson(fence);
    }
    case 'claim': {
      const claim = await readClaim(
        coordinationEntityHomeStore(stores),
        action.claim.claimId,
      );
      return claim === null ? null : digestCanonicalJson(claim);
    }
    case 'handoff': {
      const handoff = await readHandoff(
        coordinationEntityHomeStore(stores),
        action.handoff.handoffId,
      );
      return handoff === null ? null : digestCanonicalJson(handoff);
    }
  }
}

async function currentWorkflowDirectoryDigest(
  projectRoot: string,
  action: Extract<
    OperationRecoveryActionV1,
    { kind: 'workflow_task_directory' }
  >,
): Promise<string | null> {
  const root = taskRootPath(projectRoot, action.taskRef);
  try {
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const entries = await readdir(root);
  const expectedNames = new Set<string>(
    action.files.map((file) => file.fileName),
  );
  if (
    entries.length !== expectedNames.size ||
    entries.some((entry) => !expectedNames.has(entry))
  ) {
    return digestCanonicalJson({
      unexpectedEntries: [...entries].sort((left, right) =>
        Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
      ),
    });
  }
  const files = [] as typeof action.files;
  for (const target of action.files) {
    const content = await readTaskAuthorityFileAtRoot(root, target.fileName);
    if (content === null)
      return digestCanonicalJson({ missing: target.fileName });
    files.push({ fileName: target.fileName, content });
  }
  return workflowTaskDirectoryDigest({ ...action, files });
}

async function currentMigrationDirectoryDigest(
  projectRoot: string,
  action: Extract<
    OperationRecoveryActionV1,
    { kind: 'migration_task_directory' }
  >,
): Promise<string | null> {
  const root = taskRootPath(projectRoot, action.taskRef);
  try {
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const expectedRootEntries = new Set<string>([
    ...action.files.map((file) => file.fileName),
    ...(action.reports.length > 0 ? ['reports'] : []),
  ]);
  const entries = await readdir(root);
  if (
    entries.length !== expectedRootEntries.size ||
    entries.some((entry) => !expectedRootEntries.has(entry))
  ) {
    return digestCanonicalJson({
      unexpectedEntries: [...entries].sort((left, right) =>
        Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
      ),
    });
  }
  const files = [] as typeof action.files;
  for (const target of action.files) {
    const content = await readTaskAuthorityFileAtRoot(root, target.fileName);
    if (content === null)
      return digestCanonicalJson({ missing: target.fileName });
    files.push({ fileName: target.fileName, content });
  }
  const reports = [] as typeof action.reports;
  const reportNames = new Set(action.reports.map(migrationReportFileName));
  if (action.reports.length > 0) {
    const reportsDirectory = path.join(root, 'reports');
    const reportDirectoryEntry = await lstat(reportsDirectory);
    if (
      !reportDirectoryEntry.isDirectory() ||
      reportDirectoryEntry.isSymbolicLink()
    ) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    const entries = await readdir(reportsDirectory);
    if (
      entries.length !== reportNames.size ||
      entries.some((entry) => !reportNames.has(entry))
    ) {
      return digestCanonicalJson({
        unexpectedReports: [...entries].sort((left, right) =>
          Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
        ),
      });
    }
  }
  for (const target of action.reports) {
    const content = await readMigrationReport(root, target);
    if (content === null) {
      return digestCanonicalJson({
        missing: `${target.kind}:${target.artifactId}`,
      });
    }
    reports.push({ ...target, content });
  }
  return migrationTaskDirectoryDigest({ ...action, files, reports });
}

async function publishWorkflowDirectory(
  projectRoot: string,
  operationId: Ulid,
  action: Extract<
    OperationRecoveryActionV1,
    { kind: 'workflow_task_directory' }
  >,
): Promise<void> {
  const target = taskRootPath(projectRoot, action.taskRef);
  const parent = await ensureSafeTaskParent(projectRoot, action.taskRef);
  const existing = await currentWorkflowDirectoryDigest(projectRoot, action);
  if (existing === workflowTaskDirectoryDigest(action)) return;
  if (existing !== null) throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
  const staging = path.join(
    parent,
    `.${action.taskRef.taskId}.${operationId}.recovery.staging`,
  );
  try {
    await mkdir(staging);
    for (const file of action.files) {
      await writeFile(path.join(staging, file.fileName), file.content, {
        encoding: 'utf8',
        flag: 'wx',
      });
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (isAlreadyExists(error)) {
      const after = await currentWorkflowDirectoryDigest(projectRoot, action);
      if (after === workflowTaskDirectoryDigest(action)) return;
      throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
    }
    throw error;
  }
}

async function publishMigrationDirectory(
  projectRoot: string,
  operationId: Ulid,
  action: Extract<
    OperationRecoveryActionV1,
    { kind: 'migration_task_directory' }
  >,
): Promise<void> {
  const target = taskRootPath(projectRoot, action.taskRef);
  const parent = await ensureSafeTaskParent(projectRoot, action.taskRef);
  const existing = await currentMigrationDirectoryDigest(projectRoot, action);
  if (existing === migrationTaskDirectoryDigest(action)) return;
  if (existing !== null) throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
  const staging = path.join(
    parent,
    `.${action.taskRef.taskId}.${operationId}.recovery.staging`,
  );
  try {
    await mkdir(staging);
    for (const file of action.files) {
      await writeFile(path.join(staging, file.fileName), file.content, {
        encoding: 'utf8',
        flag: 'wx',
      });
    }
    if (action.reports.length > 0) {
      const reports = path.join(staging, 'reports');
      await mkdir(reports);
      for (const report of action.reports) {
        await writeFile(
          path.join(reports, migrationReportFileName(report)),
          report.content,
          { encoding: 'utf8', flag: 'wx' },
        );
      }
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (isAlreadyExists(error)) {
      const after = await currentMigrationDirectoryDigest(projectRoot, action);
      if (after === migrationTaskDirectoryDigest(action)) return;
      throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
    }
    throw error;
  }
}

function migrationReportFileName(
  report: Extract<
    OperationRecoveryActionV1,
    { kind: 'migration_task_directory' }
  >['reports'][number],
): string {
  return report.kind === 'review_report'
    ? `${report.artifactId}.md`
    : `evidence-${report.artifactId}.md`;
}

async function readMigrationReport(
  taskRoot: string,
  report: Extract<
    OperationRecoveryActionV1,
    { kind: 'migration_task_directory' }
  >['reports'][number],
): Promise<string | null> {
  const reportsDirectory = path.join(taskRoot, 'reports');
  const target = path.join(reportsDirectory, migrationReportFileName(report));
  try {
    const directory = await lstat(reportsDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
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

async function readProjectAuthorityFile(
  projectRoot: string,
  fileName: Extract<
    OperationRecoveryActionV1,
    { kind: 'project_authority_file' }
  >['fileName'],
): Promise<string | null> {
  return readSafeFixedFile(projectRoot, fileName.split('/'));
}

async function writeProjectAuthorityFile(
  projectRoot: string,
  operationId: Ulid,
  fileName: Extract<
    OperationRecoveryActionV1,
    { kind: 'project_authority_file' }
  >['fileName'],
  content: string,
): Promise<void> {
  await writeSafeFixedFile(
    projectRoot,
    operationId,
    fileName.split('/'),
    content,
  );
}

async function readMigrationStageFile(
  projectRoot: string,
  stageId: Ulid,
): Promise<string | null> {
  return readSafeFixedFile(projectRoot, [
    'local',
    'migration',
    'stages',
    `${stageId}.json`,
  ]);
}

async function readAdapterFile(
  projectRoot: string,
  target: Extract<
    OperationRecoveryActionV1,
    { kind: 'v3_adapter_file' }
  >['target'],
): Promise<string | null> {
  await assertV3AdapterTargetSafe(projectRoot, target);
  const filePath = v3AdapterTargetPath(projectRoot, target);
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function ensureSafeTaskParent(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<string> {
  let current = path.resolve(projectRoot);
  const root = await lstat(current);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  for (const segment of ['.mancode', taskRef.namespace, 'workflows']) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await mkdir(current);
    }
  }
  return current;
}

async function writeMigrationStageFile(
  projectRoot: string,
  operationId: Ulid,
  stageId: Ulid,
  content: string,
): Promise<void> {
  await writeSafeFixedFile(
    projectRoot,
    operationId,
    ['local', 'migration', 'stages', `${stageId}.json`],
    content,
  );
}

async function readSafeFixedFile(
  projectRoot: string,
  segments: string[],
): Promise<string | null> {
  const target = path.join(projectRoot, '.mancode', ...segments);
  try {
    await assertSafeFixedParent(projectRoot, segments.slice(0, -1), false);
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

async function writeSafeFixedFile(
  projectRoot: string,
  operationId: Ulid,
  segments: string[],
  content: string,
): Promise<void> {
  if (content.includes('\0') || segments.length === 0) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const parent = await assertSafeFixedParent(
    projectRoot,
    segments.slice(0, -1),
    true,
  );
  const fileName = segments.at(-1);
  if (fileName === undefined || !/^[A-Za-z0-9._-]+$/.test(fileName)) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const target = path.join(parent, fileName);
  const temporary = path.join(
    parent,
    `.${fileName}.${operationId}.${process.pid}.tmp`,
  );
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const written = await lstat(target);
  if (!written.isFile() || written.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

async function assertSafeFixedParent(
  projectRoot: string,
  segments: string[],
  create: boolean,
): Promise<string> {
  let current = path.join(projectRoot, '.mancode');
  const root = await lstat(current);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
      }
    } catch (error) {
      if (!isNotFound(error) || !create) throw error;
      await mkdir(current);
    }
  }
  return current;
}

/**
 * A workflow-directory staging path is deliberately private: it is not an
 * authority artifact until the atomic rename publishes the task directory.
 * Recovery removes only that exact operation-owned path before either an
 * abort or a forward repair. A symlink or non-directory requires manual
 * repair instead of deleting an untrusted path.
 */
async function removePrivateWorkflowStaging(
  projectRoot: string,
  journal: OperationJournalV1,
  payload: OperationRecoveryPayloadV1,
): Promise<void> {
  const actions = payload.actions.filter(
    (
      candidate,
    ): candidate is Extract<
      OperationRecoveryActionV1,
      { kind: 'workflow_task_directory' | 'migration_task_directory' }
    > =>
      candidate.kind === 'workflow_task_directory' ||
      candidate.kind === 'migration_task_directory',
  );
  for (const action of actions) {
    await removePrivateTaskDirectoryStaging(projectRoot, journal, action);
  }
}

async function removePrivateTaskDirectoryStaging(
  projectRoot: string,
  journal: OperationJournalV1,
  action: Extract<
    OperationRecoveryActionV1,
    { kind: 'workflow_task_directory' | 'migration_task_directory' }
  >,
): Promise<void> {
  const parent = path.dirname(taskRootPath(projectRoot, action.taskRef));
  let parentEntry: Stats;
  try {
    parentEntry = await lstat(parent);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new Error('MANCODE_OPERATION_RECOVERY_STAGING_UNSAFE');
  }
  for (const suffix of ['staging', 'recovery.staging']) {
    const staging = path.join(
      parent,
      `.${action.taskRef.taskId}.${journal.operationId}.${suffix}`,
    );
    let stagingEntry: Stats;
    try {
      stagingEntry = await lstat(staging);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if (!stagingEntry.isDirectory() || stagingEntry.isSymbolicLink()) {
      throw new Error('MANCODE_OPERATION_RECOVERY_STAGING_UNSAFE');
    }
    await rm(staging, { recursive: true, force: false });
  }
}

async function taskRoot(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<string> {
  const location = await new V3ContextStore(projectRoot).locateTask(taskRef);
  if (!sameTaskRef(location.taskRef, taskRef)) {
    throw new Error('MANCODE_CONTEXT_TASK_LOCATION_MISMATCH');
  }
  return location.taskRoot;
}

function taskEntityHomeStore(
  stores: EntityHomeStore[],
  taskRef: TaskRef,
): EntityHomeStore {
  const expectedKind = taskRef.namespace === 'local' ? 'checkout_local' : null;
  const store = stores.find((candidate) =>
    expectedKind === null
      ? candidate.kind !== 'checkout_local'
      : candidate.kind === expectedKind,
  );
  if (store === undefined) {
    throw new Error('MANCODE_OPERATION_RESERVATION_STORE_UNAVAILABLE');
  }
  return store;
}

function coordinationEntityHomeStore(
  stores: EntityHomeStore[],
): EntityHomeStore {
  const store = stores.find((candidate) => candidate.kind !== 'checkout_local');
  if (store === undefined) {
    throw new Error('MANCODE_OPERATION_RESERVATION_STORE_UNAVAILABLE');
  }
  return store;
}

async function abortOperation(
  store: EntityHomeStore,
  journal: OperationJournalV1,
  stores: EntityHomeStore[],
  now: Date,
): Promise<OperationJournalV1> {
  const aborted = await updateOperationJournal(
    store,
    { ...journal, state: 'aborted', updatedAt: now.toISOString() },
    { canAbort: true },
  );
  await removeReservations(aborted, stores);
  return aborted;
}

async function markRepairRequired(
  store: EntityHomeStore,
  journal: OperationJournalV1,
  now: Date,
): Promise<OperationJournalV1> {
  if (journal.state === 'repair_required') return journal;
  const applying =
    journal.state === 'prepared'
      ? await updateOperationJournal(
          store,
          { ...journal, state: 'applying', updatedAt: now.toISOString() },
          { canAbort: true },
        )
      : journal;
  return updateOperationJournal(
    store,
    { ...applying, state: 'repair_required', updatedAt: now.toISOString() },
    { canAbort: false },
  );
}

async function removeReservations(
  journal: OperationJournalV1,
  stores: EntityHomeStore[],
): Promise<void> {
  const byId = new Map(stores.map((store) => [store.storeId, store]));
  for (const reservation of journal.secondaryReservations) {
    const store = byId.get(reservation.storeId);
    if (store === undefined) {
      throw new Error('MANCODE_OPERATION_RESERVATION_STORE_UNAVAILABLE');
    }
    await removeOperationReservation(
      store,
      journal.operationId,
      journal.primaryStoreId,
    );
  }
}

async function releaseLocks(locks: LocalLockHandle[]): Promise<void> {
  await Promise.allSettled([...locks].reverse().map((lock) => lock.release()));
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

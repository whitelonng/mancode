import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { V3ContextStore } from '../context/store.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { type CheckpointV1, parseCheckpoint } from '../team/checkpoints.js';
import {
  type EntityHomeStore,
  operationDirectory,
  resolveCoordinationEntityHomeStore,
  resolveLocalEntityHomeStore,
} from './entity-home-store.js';
import { listHandoffs } from './handoff-store.js';
import {
  type OperationJournalV1,
  parseOperationJournal,
} from './operation-journal.js';
import { operationRecoveryPayloadPath } from './operation-recovery-store.js';
import { readProjectRuntimeContext } from './project-runtime.js';
import { parseSessionState } from './session.js';

const TERMINAL_JOURNAL_RETENTION_DAYS = 30;
const RETAINED_NON_MILESTONE_CHECKPOINTS = 10;

export type RetentionCandidateKind =
  | 'completed_session'
  | 'terminal_operation'
  | 'checkpoint';

export interface RetentionCandidate {
  kind: RetentionCandidateKind;
  target: string;
  reason: string;
  taskRef: TaskRef | null;
  relatedTargets: string[];
}

export interface ContextCompactionPlan {
  schemaVersion: 1;
  generatedAt: string;
  candidates: RetentionCandidate[];
  skippedReferencedCheckpoints: Array<{
    taskRef: TaskRef;
    checkpointId: string;
  }>;
}

export interface CompactContextInput {
  projectRoot: string;
  taskRef?: TaskRef;
  now?: Date;
}

export interface AppliedContextCompaction extends ContextCompactionPlan {
  deleted: string[];
}

interface OperationRetentionPlan {
  candidates: RetentionCandidate[];
  protectedSessionIds: Set<string>;
  protectedTaskRefs: Set<string>;
}

/**
 * Lists only fixed V3 runtime entities whose retention rules are mechanically
 * provable. Context packs are currently ephemeral, so they have no on-disk
 * candidate here. Checkpoint removal is deliberately restricted to completed
 * tasks and explicit compaction callers.
 */
export async function planContextCompaction(
  input: CompactContextInput,
): Promise<ContextCompactionPlan> {
  const root = path.resolve(input.projectRoot);
  const now = input.now ?? new Date();
  const store = new V3ContextStore(root);
  const [project, runtime] = await Promise.all([
    store.readProjectSnapshot(),
    readProjectRuntimeContext(root),
  ]);
  const localStore = resolveLocalEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const coordinationStore = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const operationPlan = await planOperationRetention(
    uniqueStores([localStore, coordinationStore]),
    now,
  );
  const taskRefs =
    input.taskRef === undefined
      ? await listTaskRefs(root)
      : [parseTaskRefValue(input.taskRef)];
  const [checkpointPlan, sessions] = await Promise.all([
    planCheckpointCompaction(
      store,
      coordinationStore,
      taskRefs,
      operationPlan.protectedTaskRefs,
    ),
    planCompletedSessionRetention(
      root,
      project.policy.retention.completedSessionDays,
      now,
      operationPlan.protectedSessionIds,
    ),
  ]);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    candidates: [
      ...sessions,
      ...operationPlan.candidates,
      ...checkpointPlan.candidates,
    ].sort((left, right) =>
      Buffer.from(left.target, 'utf8').compare(
        Buffer.from(right.target, 'utf8'),
      ),
    ),
    skippedReferencedCheckpoints: checkpointPlan.skippedReferencedCheckpoints,
  };
}

/** Applies a previously rendered deletion list after rechecking every target. */
export async function applyContextCompaction(
  plan: ContextCompactionPlan,
): Promise<AppliedContextCompaction> {
  const deleted: string[] = [];
  for (const candidate of plan.candidates) {
    await removeRegularFile(candidate.target);
    deleted.push(candidate.target);
    for (const target of candidate.relatedTargets) {
      if (await regularFileExists(target)) {
        await removeRegularFile(target);
        deleted.push(target);
      }
    }
  }
  return { ...plan, deleted };
}

async function planCheckpointCompaction(
  store: V3ContextStore,
  coordinationStore: EntityHomeStore,
  taskRefs: TaskRef[],
  protectedTaskRefs: ReadonlySet<string>,
): Promise<{
  candidates: RetentionCandidate[];
  skippedReferencedCheckpoints: ContextCompactionPlan['skippedReferencedCheckpoints'];
}> {
  const candidates: RetentionCandidate[] = [];
  const skippedReferencedCheckpoints: ContextCompactionPlan['skippedReferencedCheckpoints'] =
    [];
  for (const taskRef of taskRefs) {
    const task = await store.readTaskSnapshot(taskRef);
    if (task.metadata.status !== 'completed') continue;
    if (protectedTaskRefs.has(taskRefKey(taskRef))) continue;
    const referenced = new Set<string>();
    if (task.metadata.latestCheckpointRef?.artifactId !== undefined) {
      referenced.add(task.metadata.latestCheckpointRef.artifactId);
    }
    if (taskRef.namespace === 'shared') {
      const handoffs = await listHandoffs(coordinationStore, taskRef);
      for (const handoff of handoffs) {
        if (
          handoff.checkpointRef.kind === 'checkpoint' &&
          handoff.checkpointRef.artifactId !== undefined
        ) {
          referenced.add(handoff.checkpointRef.artifactId);
        }
      }
    }
    const checkpoints = await listTaskCheckpoints(
      task.location.taskRoot,
      taskRef,
    );
    const removable = checkpoints
      .filter((checkpoint) => !isMilestone(checkpoint))
      .sort(compareCheckpointNewestFirst)
      .slice(RETAINED_NON_MILESTONE_CHECKPOINTS);
    for (const checkpoint of removable) {
      if (referenced.has(checkpoint.checkpointId)) {
        skippedReferencedCheckpoints.push({
          taskRef,
          checkpointId: checkpoint.checkpointId,
        });
        continue;
      }
      candidates.push({
        kind: 'checkpoint',
        target: path.join(
          task.location.taskRoot,
          'checkpoints',
          `${checkpoint.checkpointId}.json`,
        ),
        reason: `completed task retains only ${RETAINED_NON_MILESTONE_CHECKPOINTS} non-milestone checkpoints`,
        taskRef,
        relatedTargets: [],
      });
    }
  }
  return { candidates, skippedReferencedCheckpoints };
}

async function planCompletedSessionRetention(
  root: string,
  completedSessionDays: number,
  now: Date,
  protectedSessionIds: ReadonlySet<string>,
): Promise<RetentionCandidate[]> {
  const directory = path.join(root, '.mancode', 'local', 'sessions');
  const entries = await readDirectoryOrEmpty(directory);
  const threshold = now.getTime() - completedSessionDays * 86_400_000;
  const candidates: RetentionCandidate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const target = path.join(directory, entry);
    const session = parseSessionState(
      JSON.parse(await readRegularFile(target)),
    );
    if (
      session.status === 'closed' &&
      session.closedAt !== null &&
      Date.parse(session.closedAt) < threshold &&
      !protectedSessionIds.has(session.sessionId)
    ) {
      candidates.push({
        kind: 'completed_session',
        target,
        reason: `closed session exceeds ${completedSessionDays} day retention`,
        taskRef: null,
        relatedTargets: [],
      });
    }
  }
  return candidates;
}

async function planOperationRetention(
  stores: EntityHomeStore[],
  now: Date,
): Promise<OperationRetentionPlan> {
  const threshold =
    now.getTime() - TERMINAL_JOURNAL_RETENTION_DAYS * 86_400_000;
  const candidates: RetentionCandidate[] = [];
  const protectedSessionIds = new Set<string>();
  const protectedTaskRefs = new Set<string>();
  for (const store of stores) {
    const directory = operationDirectory(store);
    const entries = await readDirectoryOrEmpty(directory);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const target = path.join(directory, entry);
      const journal = parseOperationJournal(
        JSON.parse(await readRegularFile(target)),
      );
      const terminal =
        journal.state === 'committed' || journal.state === 'aborted';
      if (!terminal) {
        protectedSessionIds.add(journal.sessionId);
        for (const entityKey of operationEntityKeys(journal)) {
          const protectedTaskRef = taskRefKeyFromEntityKey(entityKey);
          if (protectedTaskRef !== null) {
            protectedTaskRefs.add(protectedTaskRef);
          }
        }
      } else if (Date.parse(journal.updatedAt) < threshold) {
        candidates.push(operationRetentionCandidate(store, journal, target));
      }
    }
  }
  return { candidates, protectedSessionIds, protectedTaskRefs };
}

function operationRetentionCandidate(
  store: EntityHomeStore,
  journal: OperationJournalV1,
  target: string,
): RetentionCandidate {
  return {
    kind: 'terminal_operation',
    target,
    reason: `${journal.state} operation exceeds ${TERMINAL_JOURNAL_RETENTION_DAYS} day retention`,
    taskRef: null,
    relatedTargets:
      journal.recoveryPayloadDigest === undefined
        ? []
        : [operationRecoveryPayloadPath(store, journal.operationId)],
  };
}

function operationEntityKeys(journal: OperationJournalV1): string[] {
  return [
    ...journal.entityLocks,
    ...journal.secondaryReservations.flatMap(
      (reservation) => reservation.entityKeys,
    ),
  ];
}

function taskRefKey(taskRef: TaskRef): string {
  return `${taskRef.namespace}:${taskRef.taskId}`;
}

function taskRefKeyFromEntityKey(entityKey: string): string | null {
  const match = /^task:(local|shared):([0-9A-HJKMNP-TV-Z]{26})$/.exec(
    entityKey,
  );
  return match === null ? null : `${match[1]}:${match[2]}`;
}

async function listTaskRefs(root: string): Promise<TaskRef[]> {
  const refs: TaskRef[] = [];
  for (const namespace of ['local', 'shared'] as const) {
    const directory = path.join(root, '.mancode', namespace, 'workflows');
    for (const entry of await readDirectoryOrEmpty(directory)) {
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry)) continue;
      refs.push({ namespace, taskId: entry });
    }
  }
  return refs.sort((left, right) =>
    Buffer.from(`${left.namespace}:${left.taskId}`, 'utf8').compare(
      Buffer.from(`${right.namespace}:${right.taskId}`, 'utf8'),
    ),
  );
}

async function listTaskCheckpoints(
  taskRoot: string,
  taskRef: TaskRef,
): Promise<CheckpointV1[]> {
  const directory = path.join(taskRoot, 'checkpoints');
  const checkpoints: CheckpointV1[] = [];
  for (const entry of await readDirectoryOrEmpty(directory)) {
    if (!entry.endsWith('.json')) continue;
    const checkpoint = parseCheckpoint(
      JSON.parse(await readRegularFile(path.join(directory, entry))),
    );
    if (
      !sameTaskRef(checkpoint.taskRef, taskRef) ||
      entry !== `${checkpoint.checkpointId}.json`
    ) {
      throw new Error('MANCODE_RETENTION_CHECKPOINT_CORRUPT');
    }
    checkpoints.push(checkpoint);
  }
  return checkpoints;
}

function isMilestone(checkpoint: CheckpointV1): boolean {
  return checkpoint.kind !== 'diagnostic_started';
}

function compareCheckpointNewestFirst(
  left: CheckpointV1,
  right: CheckpointV1,
): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    Buffer.from(right.checkpointId, 'utf8').compare(
      Buffer.from(left.checkpointId, 'utf8'),
    )
  );
}

function uniqueStores(stores: EntityHomeStore[]): EntityHomeStore[] {
  return stores.filter(
    (store, index) =>
      stores.findIndex((candidate) => candidate.storeId === store.storeId) ===
      index,
  );
}

async function readDirectoryOrEmpty(directory: string): Promise<string[]> {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_RETENTION_PATH_UNSAFE');
    }
    return (await readdir(directory)).sort((left, right) =>
      Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
    );
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readRegularFile(target: string): Promise<string> {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_RETENTION_PATH_UNSAFE');
  }
  const content = await readFile(target, 'utf8');
  const after = await lstat(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error('MANCODE_RETENTION_PATH_UNSAFE');
  }
  return content;
}

async function removeRegularFile(target: string): Promise<void> {
  await readRegularFile(target);
  await rm(target);
}

async function regularFileExists(target: string): Promise<boolean> {
  try {
    await readRegularFile(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

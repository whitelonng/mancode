import {
  lstat,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { taskAggregateDigest } from '../context/aggregate.js';
import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { V3ContextStore } from '../context/store.js';
import { taskRootPath } from '../context/task-locator.js';
import { sameTaskRef } from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
} from '../context/workflow-metadata.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { resolveCoordinationEntityHomeStore } from '../runtime/entity-home-store.js';
import { acquireEntityLocks } from '../runtime/local-lock.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import {
  type TaskHeadFenceV1,
  parseTaskHeadFence,
} from '../runtime/task-head-fence.js';
import {
  createTaskHeadFence,
  readTaskHeadFence,
  replaceTaskHeadFence,
} from '../runtime/task-head-store.js';
import { taskEntityKey } from '../runtime/task-operation.js';
import { readQuarantinedGitRefTaskBundle } from './git-ref-bundle.js';
import {
  readGitRefTaskRemoteBase,
  recordGitRefTaskRemoteBase,
} from './git-ref-task-base.js';
import {
  type GitRefOwnershipFenceV1,
  type GitRefTaskBundleArtifactV1,
  type GitRefTaskBundleV1,
  parseGitRefOwnershipFence,
  parseGitRefTaskBundle,
} from './git-ref-transport.js';

type MaterializationState = 'prepared' | 'applying' | 'committed';

interface GitRefMaterializationJournalV1 {
  schemaVersion: 1;
  operationId: Ulid;
  workspaceId: Ulid;
  remoteRevision: number;
  state: MaterializationState;
  predecessorBundle: GitRefTaskBundleV1 | null;
  pendingMetadata: WorkflowMetadataV3 | null;
  targetBundle: GitRefTaskBundleV1;
  targetFence: TaskHeadFenceV1;
  createdAt: string;
  updatedAt: string;
}

export interface MaterializeGitRefTaskBundleInput {
  projectRoot: string;
  remoteRevision: number;
  ownershipFence: GitRefOwnershipFenceV1;
  bundle: GitRefTaskBundleV1;
  predecessorBundle?: GitRefTaskBundleV1 | null;
  pendingMetadata?: WorkflowMetadataV3 | null;
  /** The caller already holds the canonical task lock. */
  taskLockHeld?: boolean;
  operationId?: Ulid;
  now?: Date;
}

export interface MaterializedGitRefTaskBundleResult {
  status: 'created' | 'updated' | 'unchanged';
  taskRevision: number;
  aggregateDigest: string;
  journalPath: string | null;
  taskHeadFence: TaskHeadFenceV1;
}

/**
 * Materializes only a missing task or an exact verified predecessor. The
 * local journal makes every visible write idempotently forward-repairable.
 */
export async function materializeGitRefTaskBundle(
  input: MaterializeGitRefTaskBundleInput,
): Promise<MaterializedGitRefTaskBundleResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const remoteRevision = positiveInteger(
    input.remoteRevision,
    'git-ref materialization remoteRevision',
  );
  const bundle = parseGitRefTaskBundle(input.bundle);
  const ownershipFence = parseGitRefOwnershipFence(input.ownershipFence);
  if (
    !sameTaskRef(bundle.taskRef, ownershipFence.taskRef) ||
    bundle.taskRevision !== ownershipFence.taskRevision ||
    bundle.ownershipEpoch !== ownershipFence.ownershipEpoch ||
    bundle.aggregateDigest !== ownershipFence.aggregateDigest ||
    ownershipFence.remoteRevision > remoteRevision
  ) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_FENCE_MISMATCH');
  }
  const predecessor =
    input.predecessorBundle === undefined || input.predecessorBundle === null
      ? null
      : parseGitRefTaskBundle(input.predecessorBundle);
  const pendingMetadata =
    input.pendingMetadata === undefined || input.pendingMetadata === null
      ? null
      : parseWorkflowMetadata(input.pendingMetadata);
  assertPendingMetadata(pendingMetadata, predecessor, bundle);
  const runtime = await readProjectRuntimeContext(projectRoot);
  const operationId =
    input.operationId ?? createUlid((input.now ?? new Date()).getTime());
  assertUlid(operationId, 'git-ref materialization operationId');
  const now = input.now ?? new Date();
  const store = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const locks = input.taskLockHeld
    ? []
    : await acquireEntityLocks(
        store,
        operationId,
        [taskEntityKey(bundle.taskRef)],
        { now },
      );
  try {
    await recoverTaskMaterializationsWhileLocked(
      projectRoot,
      bundle.taskRef.taskId,
    );
    const current = await readLocalTaskOrNull(projectRoot, bundle);
    const currentFence = await readTaskHeadFence(store, bundle.taskRef);
    const recordedBase = await readGitRefTaskRemoteBase(
      projectRoot,
      bundle.taskRef,
    );
    const quarantinedBase =
      recordedBase === null &&
      currentFence !== null &&
      currentFence.remoteRevision !== null
        ? await readQuarantinedGitRefTaskBundle(
            projectRoot,
            currentFence.remoteRevision,
            bundle.taskRef,
            {
              taskRevision: currentFence.taskRevision,
              aggregateDigest: currentFence.aggregateDigest,
              ownershipEpoch: currentFence.ownershipEpoch,
              codeRefHead: currentFence.codeRef.head,
            },
          )
        : null;
    const effectivePredecessor =
      recordedBase?.bundle ?? quarantinedBase ?? predecessor;
    const status = classifyMaterialization(
      current,
      bundle,
      effectivePredecessor,
      pendingMetadata,
    );
    if (status === 'created' && currentFence !== null) {
      throw new Error('MANCODE_SPLIT_BRAIN');
    }
    const materializedPredecessor =
      status === 'created' ? null : effectivePredecessor;
    if (
      status === 'unchanged' &&
      currentFence !== null &&
      taskHeadFenceMatchesTarget({
        currentFence,
        runtime,
        remoteRevision,
        ownershipFence,
        bundle,
      })
    ) {
      await recordGitRefTaskRemoteBase(projectRoot, remoteRevision, bundle);
      return result(status, bundle, null, currentFence);
    }
    const targetFence = buildTargetFence({
      runtime,
      remoteRevision,
      ownershipFence,
      bundle,
      predecessor: materializedPredecessor,
      currentFence,
      now,
    });
    if (status === 'unchanged') {
      await writeTargetFence(
        store,
        currentFence,
        targetFence,
        materializedPredecessor,
      );
      await recordGitRefTaskRemoteBase(projectRoot, remoteRevision, bundle);
      return result(status, bundle, null, targetFence);
    }
    const timestamp = now.toISOString();
    let journal: GitRefMaterializationJournalV1 = {
      schemaVersion: 1,
      operationId,
      workspaceId: runtime.workspaceId,
      remoteRevision,
      state: 'prepared',
      predecessorBundle: materializedPredecessor,
      pendingMetadata,
      targetBundle: bundle,
      targetFence,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await createJournal(projectRoot, journal);
    journal = { ...journal, state: 'applying', updatedAt: timestamp };
    await replaceJournal(projectRoot, journal);
    await applyJournal(projectRoot, journal);
    await recordGitRefTaskRemoteBase(projectRoot, remoteRevision, bundle);
    journal = {
      ...journal,
      state: 'committed',
      updatedAt: new Date().toISOString(),
    };
    await replaceJournal(projectRoot, journal);
    return result(
      status,
      bundle,
      journalPath(projectRoot, operationId),
      targetFence,
    );
  } finally {
    await Promise.allSettled(
      [...locks].reverse().map((lock) => lock.release()),
    );
  }
}

/** Repairs durable pull intents under each task's canonical local lock. */
export async function recoverGitRefTaskMaterializations(
  projectRoot: string,
): Promise<number> {
  const root = path.resolve(projectRoot);
  const runtime = await readProjectRuntimeContext(root);
  const store = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const journals = await listJournals(root);
  let repaired = 0;
  for (const journal of journals) {
    if (journal.state === 'committed') continue;
    const recoveryOperationId = createUlid();
    const locks = await acquireEntityLocks(store, recoveryOperationId, [
      taskEntityKey(journal.targetBundle.taskRef),
    ]);
    try {
      repaired += await recoverTaskMaterializationsWhileLocked(
        root,
        journal.targetBundle.taskRef.taskId,
      );
    } finally {
      await Promise.allSettled(
        [...locks].reverse().map((lock) => lock.release()),
      );
    }
  }
  return repaired;
}

async function recoverTaskMaterializationsWhileLocked(
  projectRoot: string,
  taskId: string,
): Promise<number> {
  let repaired = 0;
  for (const journal of await listJournals(projectRoot)) {
    if (
      journal.state === 'committed' ||
      journal.targetBundle.taskRef.taskId !== taskId
    ) {
      continue;
    }
    await applyJournal(projectRoot, journal);
    await recordGitRefTaskRemoteBase(
      projectRoot,
      journal.remoteRevision,
      journal.targetBundle,
    );
    await replaceJournal(projectRoot, {
      ...journal,
      state: 'committed',
      updatedAt: new Date().toISOString(),
    });
    repaired += 1;
  }
  return repaired;
}

async function applyJournal(
  projectRoot: string,
  journal: GitRefMaterializationJournalV1,
): Promise<void> {
  const target = bundleFiles(journal.targetBundle);
  const predecessor =
    journal.predecessorBundle === null
      ? new Map<string, string>()
      : bundleFiles(journal.predecessorBundle);
  const pendingMetadataContent =
    journal.pendingMetadata === null
      ? null
      : `${JSON.stringify(journal.pendingMetadata, null, 2)}\n`;
  const taskRoot = taskRootPath(projectRoot, journal.targetBundle.taskRef);
  await ensureSafeDirectory(projectRoot, [
    '.mancode',
    'shared',
    'workflows',
    journal.targetBundle.taskRef.taskId,
  ]);
  for (const [relativePath, content] of target) {
    await replaceVerifiedFile(
      taskRoot,
      relativePath,
      content,
      predecessor.get(relativePath) ?? null,
      relativePath === 'metadata.json' ? pendingMetadataContent : null,
    );
  }
  for (const optional of ['plan.md', 'summary.md']) {
    if (!target.has(optional)) {
      await removeVerifiedFile(
        taskRoot,
        optional,
        predecessor.get(optional) ?? null,
      );
    }
  }
  const runtime = await readProjectRuntimeContext(projectRoot);
  if (runtime.workspaceId !== journal.workspaceId) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
  const store = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const currentFence = await readTaskHeadFence(
    store,
    journal.targetBundle.taskRef,
  );
  await writeTargetFence(
    store,
    currentFence,
    journal.targetFence,
    journal.predecessorBundle,
  );
  const materialized = await new V3ContextStore(projectRoot).readTaskSnapshot(
    journal.targetBundle.taskRef,
  );
  if (
    materialized.aggregate === null ||
    taskAggregateDigest(materialized.aggregate) !==
      journal.targetBundle.aggregateDigest
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
}

function classifyMaterialization(
  current: Awaited<ReturnType<typeof readLocalTaskOrNull>>,
  target: GitRefTaskBundleV1,
  predecessor: GitRefTaskBundleV1 | null,
  pendingMetadata: WorkflowMetadataV3 | null,
): 'created' | 'updated' | 'unchanged' {
  if (current === null) return 'created';
  if (
    current.aggregate !== null &&
    current.metadata.revision === target.taskRevision &&
    taskAggregateDigest(current.aggregate) === target.aggregateDigest
  ) {
    return 'unchanged';
  }
  const matchesPredecessor =
    predecessor !== null &&
    current.aggregate !== null &&
    current.metadata.revision === predecessor.taskRevision &&
    taskAggregateDigest(current.aggregate) === predecessor.aggregateDigest;
  const matchesPending =
    pendingMetadata !== null &&
    digestCanonicalJson(current.metadata) ===
      digestCanonicalJson(pendingMetadata);
  if (
    predecessor === null ||
    !sameTaskRef(predecessor.taskRef, target.taskRef) ||
    predecessor.taskRevision >= target.taskRevision ||
    (!matchesPredecessor && !matchesPending)
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  return 'updated';
}

async function readLocalTaskOrNull(
  projectRoot: string,
  bundle: GitRefTaskBundleV1,
) {
  try {
    return await new V3ContextStore(projectRoot).readTaskSnapshot(
      bundle.taskRef,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'MANCODE_TASK_NOT_FOUND') {
      return null;
    }
    const root = taskRootPath(projectRoot, bundle.taskRef);
    if (!(await pathExists(root))) return null;
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
}

function buildTargetFence(input: {
  runtime: Awaited<ReturnType<typeof readProjectRuntimeContext>>;
  remoteRevision: number;
  ownershipFence: GitRefOwnershipFenceV1;
  bundle: GitRefTaskBundleV1;
  predecessor: GitRefTaskBundleV1 | null;
  currentFence: TaskHeadFenceV1 | null;
  now: Date;
}): TaskHeadFenceV1 {
  if (input.currentFence !== null) {
    const matchesTarget =
      input.currentFence.taskRevision === input.bundle.taskRevision &&
      input.currentFence.aggregateDigest === input.bundle.aggregateDigest;
    const matchesPredecessor =
      input.predecessor !== null &&
      input.currentFence.taskRevision === input.predecessor.taskRevision &&
      input.currentFence.aggregateDigest === input.predecessor.aggregateDigest;
    if (!matchesTarget && !matchesPredecessor) {
      throw new Error('MANCODE_SPLIT_BRAIN');
    }
  }
  return parseTaskHeadFence({
    schemaVersion: 1,
    workspaceId: input.runtime.workspaceId,
    taskRef: input.bundle.taskRef,
    fenceRevision: (input.currentFence?.fenceRevision ?? 0) + 1,
    taskRevision: input.bundle.taskRevision,
    aggregateDigest: input.bundle.aggregateDigest,
    ownershipEpoch: input.bundle.ownershipEpoch,
    codeRef: { head: input.bundle.codeRef.head },
    checkoutId: input.runtime.checkoutId,
    remoteRevision: input.remoteRevision,
    lastOperationId: input.ownershipFence.lastOperationId,
    updatedAt: input.now.toISOString(),
  });
}

function taskHeadFenceMatchesTarget(input: {
  currentFence: TaskHeadFenceV1;
  runtime: Awaited<ReturnType<typeof readProjectRuntimeContext>>;
  remoteRevision: number;
  ownershipFence: GitRefOwnershipFenceV1;
  bundle: GitRefTaskBundleV1;
}): boolean {
  return (
    input.currentFence.workspaceId === input.runtime.workspaceId &&
    sameTaskRef(input.currentFence.taskRef, input.bundle.taskRef) &&
    input.currentFence.taskRevision === input.bundle.taskRevision &&
    input.currentFence.aggregateDigest === input.bundle.aggregateDigest &&
    input.currentFence.ownershipEpoch === input.bundle.ownershipEpoch &&
    input.currentFence.codeRef.head === input.bundle.codeRef.head &&
    input.currentFence.checkoutId === input.runtime.checkoutId &&
    input.currentFence.remoteRevision === input.remoteRevision &&
    input.currentFence.lastOperationId === input.ownershipFence.lastOperationId
  );
}

async function writeTargetFence(
  store: ReturnType<typeof resolveCoordinationEntityHomeStore>,
  current: TaskHeadFenceV1 | null,
  target: TaskHeadFenceV1,
  predecessor: GitRefTaskBundleV1 | null,
): Promise<void> {
  if (
    current !== null &&
    digestCanonicalJson(current) === digestCanonicalJson(target)
  ) {
    return;
  }
  if (current === null) {
    await createTaskHeadFence(store, target);
    return;
  }
  const matchesTarget =
    current.taskRevision === target.taskRevision &&
    current.aggregateDigest === target.aggregateDigest;
  const matchesPredecessor =
    predecessor !== null &&
    current.taskRevision === predecessor.taskRevision &&
    current.aggregateDigest === predecessor.aggregateDigest;
  if (!matchesTarget && !matchesPredecessor) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  await replaceTaskHeadFence(store, target);
}

function bundleFiles(bundle: GitRefTaskBundleV1): Map<string, string> {
  const files = new Map<string, string>();
  for (const artifact of bundle.artifacts) {
    files.set(materializedPath(artifact), serializeArtifact(artifact));
  }
  return files;
}

function materializedPath(artifact: GitRefTaskBundleArtifactV1): string {
  switch (artifact.kind) {
    case 'metadata':
      return 'metadata.json';
    case 'requirements':
      return 'requirements.json';
    case 'review':
      return 'review-ledger.json';
    case 'verification':
      return 'verification-ledger.json';
    case 'plan':
      return 'plan.md';
    case 'summary':
      return 'summary.md';
    case 'checkpoint':
      return artifact.relativePath;
  }
}

function serializeArtifact(artifact: GitRefTaskBundleArtifactV1): string {
  if (artifact.kind === 'plan' || artifact.kind === 'summary') {
    if (typeof artifact.content !== 'string') {
      throw new Error('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_INVALID');
    }
    return artifact.content;
  }
  return `${JSON.stringify(artifact.content, null, 2)}\n`;
}

async function replaceVerifiedFile(
  taskRoot: string,
  relativePath: string,
  targetContent: string,
  predecessorContent: string | null,
  alternatePredecessorContent: string | null,
): Promise<void> {
  const target = safeTaskPath(taskRoot, relativePath);
  await ensureSafeDirectory(
    taskRoot,
    path.dirname(relativePath).split(path.sep),
  );
  const current = await readSafeFileOrNull(target);
  if (contentMatches(relativePath, current, targetContent)) return;
  if (
    current !== null &&
    !contentMatches(relativePath, current, predecessorContent) &&
    !contentMatches(relativePath, current, alternatePredecessorContent)
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  if (
    current === null &&
    (predecessorContent !== null || alternatePredecessorContent !== null) &&
    relativePath !== 'summary.md'
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, targetContent, { encoding: 'utf8', flag: 'wx' });
  await replaceFileAtomically(temporary, target);
}

function contentMatches(
  relativePath: string,
  current: string | null,
  expected: string | null,
): boolean {
  if (current === null || expected === null) return current === expected;
  if (!relativePath.endsWith('.json')) return current === expected;
  try {
    return (
      digestCanonicalJson(JSON.parse(current)) ===
      digestCanonicalJson(JSON.parse(expected))
    );
  } catch {
    return false;
  }
}

function assertPendingMetadata(
  pending: WorkflowMetadataV3 | null,
  predecessor: GitRefTaskBundleV1 | null,
  target: GitRefTaskBundleV1,
): void {
  if (pending === null) return;
  if (predecessor === null) {
    throw new Error('MANCODE_MATERIALIZATION_PENDING_PREDECESSOR_INVALID');
  }
  const previousMetadata = bundleMetadata(predecessor);
  const targetMetadata = bundleMetadata(target);
  const normalized = parseWorkflowMetadata({
    ...pending,
    revision: previousMetadata.revision,
    transitionState: previousMetadata.transitionState,
    lastOperationId: previousMetadata.lastOperationId,
    updatedAt: previousMetadata.updatedAt,
  });
  if (
    pending.transitionState !== 'operation_pending' ||
    pending.revision !== previousMetadata.revision + 1 ||
    pending.lastOperationId === null ||
    pending.lastOperationId !== targetMetadata.lastOperationId ||
    targetMetadata.revision !== pending.revision + 1 ||
    digestCanonicalJson(normalized) !== digestCanonicalJson(previousMetadata)
  ) {
    throw new Error('MANCODE_MATERIALIZATION_PENDING_PREDECESSOR_INVALID');
  }
}

function bundleMetadata(bundle: GitRefTaskBundleV1): WorkflowMetadataV3 {
  const artifact = bundle.artifacts.find(
    (candidate) => candidate.kind === 'metadata',
  );
  if (artifact === undefined) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_INVALID');
  }
  return parseWorkflowMetadata(artifact.content);
}

async function removeVerifiedFile(
  taskRoot: string,
  relativePath: string,
  predecessorContent: string | null,
): Promise<void> {
  const target = safeTaskPath(taskRoot, relativePath);
  const current = await readSafeFileOrNull(target);
  if (current === null) return;
  if (predecessorContent === null || current !== predecessorContent) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  await unlink(target);
}

async function readSafeFileOrNull(target: string): Promise<string | null> {
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

async function ensureSafeDirectory(
  root: string,
  segments: string[],
): Promise<void> {
  let current = path.resolve(root);
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..' || segment.includes('/') || segment.includes('\\')) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  }
}

function safeTaskPath(taskRoot: string, relativePath: string): string {
  const target = path.resolve(taskRoot, relativePath);
  const relative = path.relative(taskRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  return target;
}

async function createJournal(
  projectRoot: string,
  journal: GitRefMaterializationJournalV1,
): Promise<void> {
  await ensureSafeDirectory(projectRoot, [
    '.mancode',
    'local',
    'journals',
    'git-ref-materialize',
  ]);
  await writeFile(
    journalPath(projectRoot, journal.operationId),
    serialize(journal),
    {
      encoding: 'utf8',
      flag: 'wx',
    },
  );
}

async function replaceJournal(
  projectRoot: string,
  journal: GitRefMaterializationJournalV1,
): Promise<void> {
  const target = journalPath(projectRoot, journal.operationId);
  const temporary = path.join(
    path.dirname(target),
    `.${journal.operationId}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, serialize(journal), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await replaceFileAtomically(temporary, target);
}

async function readJournal(
  target: string,
): Promise<GitRefMaterializationJournalV1> {
  try {
    const raw = JSON.parse(await readFile(target, 'utf8')) as unknown;
    return parseJournal(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_MATERIALIZATION_JOURNAL_CORRUPT');
    }
    throw error;
  }
}

async function listJournals(
  projectRoot: string,
): Promise<GitRefMaterializationJournalV1[]> {
  const directory = journalDirectory(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const journals: GitRefMaterializationJournalV1[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    journals.push(await readJournal(path.join(directory, entry)));
  }
  return journals;
}

function parseJournal(value: unknown): GitRefMaterializationJournalV1 {
  assertRecord(value, 'git-ref materialization journal');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'workspaceId',
      'remoteRevision',
      'state',
      'predecessorBundle',
      'pendingMetadata',
      'targetBundle',
      'targetFence',
      'createdAt',
      'updatedAt',
    ],
    'git-ref materialization journal',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('MANCODE_MATERIALIZATION_JOURNAL_CORRUPT');
  }
  assertUlid(value.operationId, 'git-ref materialization operationId');
  assertUlid(value.workspaceId, 'git-ref materialization workspaceId');
  if (
    value.state !== 'prepared' &&
    value.state !== 'applying' &&
    value.state !== 'committed'
  ) {
    throw new Error('MANCODE_MATERIALIZATION_JOURNAL_CORRUPT');
  }
  const targetBundle = parseGitRefTaskBundle(value.targetBundle);
  const predecessorBundle =
    value.predecessorBundle === null
      ? null
      : parseGitRefTaskBundle(value.predecessorBundle);
  const pendingMetadata =
    value.pendingMetadata === null
      ? null
      : parseWorkflowMetadata(value.pendingMetadata);
  assertPendingMetadata(pendingMetadata, predecessorBundle, targetBundle);
  const targetFence = parseTaskHeadFence(value.targetFence);
  if (
    !sameTaskRef(targetFence.taskRef, targetBundle.taskRef) ||
    targetFence.taskRevision !== targetBundle.taskRevision ||
    targetFence.aggregateDigest !== targetBundle.aggregateDigest
  ) {
    throw new Error('MANCODE_MATERIALIZATION_JOURNAL_CORRUPT');
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    workspaceId: value.workspaceId,
    remoteRevision: positiveInteger(
      value.remoteRevision,
      'git-ref materialization remoteRevision',
    ),
    state: value.state,
    predecessorBundle,
    pendingMetadata,
    targetBundle,
    targetFence,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

function result(
  status: MaterializedGitRefTaskBundleResult['status'],
  bundle: GitRefTaskBundleV1,
  localJournalPath: string | null,
  taskHeadFence: TaskHeadFenceV1,
): MaterializedGitRefTaskBundleResult {
  return {
    status,
    taskRevision: bundle.taskRevision,
    aggregateDigest: bundle.aggregateDigest,
    journalPath: localJournalPath,
    taskHeadFence,
  };
}

function journalDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'journals',
    'git-ref-materialize',
  );
}

function journalPath(projectRoot: string, operationId: Ulid): string {
  assertUlid(operationId, 'git-ref materialization operationId');
  return path.join(journalDirectory(projectRoot), `${operationId}.json`);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('MANCODE_MATERIALIZATION_JOURNAL_CORRUPT');
  }
  return value;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
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

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
import {
  gitRefWorkflowRepairJournalDirectory as journalDirectory,
  gitRefWorkflowRepairJournalPath as journalPath,
  listUnfinishedGitRefWorkflowRepairs,
} from '../runtime/git-ref-workflow-repair-store.js';
import { acquireEntityLocks } from '../runtime/local-lock.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { readSession } from '../runtime/session.js';
import { taskEntityKey } from '../runtime/task-operation.js';
import {
  type AuthorizationBasisV1,
  assertRepairUsesOriginalAuthorization,
  parseAuthorizationBasis,
} from './authorization.js';
import { writeGitRefTeamCache } from './git-ref-cache.js';
import { createGitRefTeamManifestStore } from './git-ref-client.js';
import {
  type MaterializedGitRefTaskBundleResult,
  materializeGitRefTaskBundle,
} from './git-ref-materialization.js';
import {
  type GitRefOwnershipFenceV1,
  type GitRefRemoteMutationReceiptV1,
  type GitRefTaskBundleV1,
  type GitRefTeamManifestV1,
  parseGitRefOwnershipFence,
  parseGitRefRemoteMutationReceipt,
  parseGitRefTaskBundle,
} from './git-ref-transport.js';

export type GitRefWorkflowRepairKind =
  | 'workflow_update'
  | 'scope_change'
  | 'task_complete';

type RepairState =
  | 'awaiting_remote'
  | 'applying'
  | 'committed'
  | 'aborted'
  | 'repair_required';

/**
 * The immutable target calculated before the external coordination CAS.  It
 * intentionally contains no writable remote state: the receipt remains the
 * proof that this target actually committed.
 */
export interface PreparedGitRefWorkflowMutationV1 {
  schemaVersion: 1;
  kind: GitRefWorkflowRepairKind;
  operationId: Ulid;
  expectedRemoteRevision: number;
  expectedOwnershipEpoch: number;
  targetRemoteRevision: number;
  targetOwnershipEpoch: number;
  predecessorBundle: GitRefTaskBundleV1;
  predecessorFence: GitRefOwnershipFenceV1;
  targetBundle: GitRefTaskBundleV1;
  targetFence: GitRefOwnershipFenceV1;
  targetClaimsDigest: string;
  targetHandoffsDigest: string;
}

interface GitRefWorkflowRepairJournalV1 {
  schemaVersion: 1;
  operationId: Ulid;
  workspaceId: Ulid;
  actorId: Ulid;
  sessionId: Ulid;
  authorizationBasis: AuthorizationBasisV1;
  state: RepairState;
  prepared: PreparedGitRefWorkflowMutationV1;
  pendingMetadata: WorkflowMetadataV3;
  remoteReceipt: GitRefRemoteMutationReceiptV1 | null;
  transportReceipt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrepareGitRefWorkflowRepairInput {
  projectRoot: string;
  prepared: PreparedGitRefWorkflowMutationV1;
  pendingMetadata: WorkflowMetadataV3;
  actorId: Ulid;
  sessionId: Ulid;
  authorizationBasis: AuthorizationBasisV1;
  now?: Date;
}

export interface RecoveredGitRefWorkflowRepair {
  operationId: Ulid;
  kind: GitRefWorkflowRepairKind;
  state: Extract<RepairState, 'committed' | 'aborted' | 'repair_required'>;
  taskRef: GitRefTaskBundleV1['taskRef'];
  remoteRevision: number;
  materialization: MaterializedGitRefTaskBundleResult | null;
}

export interface RecoverGitRefWorkflowRepairOptions {
  /** Recovery is bound to the actor/session that created the durable target. */
  actorId?: Ulid;
  sessionId?: Ulid;
  /** The caller already holds the canonical task operation lock. */
  taskLockHeld?: boolean;
}

/**
 * Persists a local write-ahead record and makes the task visibly pending
 * before a remote CAS.  Call this only while the originating task operation
 * holds its canonical task lock.
 */
export async function prepareGitRefWorkflowRepair(
  input: PrepareGitRefWorkflowRepairInput,
): Promise<void> {
  const root = path.resolve(input.projectRoot);
  const prepared = parsePrepared(input.prepared);
  const pendingMetadata = parseWorkflowMetadata(input.pendingMetadata);
  assertPendingMetadata(prepared, pendingMetadata);
  assertUlid(input.actorId, 'git-ref workflow repair actorId');
  assertUlid(input.sessionId, 'git-ref workflow repair sessionId');
  const authorizationBasis = parseAuthorizationBasis(input.authorizationBasis);
  assertJournalAuthorization(
    prepared,
    input.actorId,
    input.sessionId,
    authorizationBasis,
  );
  const runtime = await readProjectRuntimeContext(root);
  const timestamp = (input.now ?? new Date()).toISOString();
  const journal: GitRefWorkflowRepairJournalV1 = {
    schemaVersion: 1,
    operationId: prepared.operationId,
    workspaceId: runtime.workspaceId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    authorizationBasis,
    state: 'awaiting_remote',
    prepared,
    pendingMetadata,
    remoteReceipt: null,
    transportReceipt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await createJournal(root, journal);
  await writePendingMetadata(root, journal);
}

/** Recovers one external workflow mutation using only its durable target. */
export async function recoverGitRefWorkflowRepair(
  projectRoot: string,
  operationId: Ulid,
  transportReceipt: string | null = null,
  options: RecoverGitRefWorkflowRepairOptions = {},
): Promise<RecoveredGitRefWorkflowRepair> {
  assertUlid(operationId, 'git-ref workflow repair operationId');
  const root = path.resolve(projectRoot);
  let journal = await requireJournal(root, operationId);
  await assertRecoveryAuthorized(root, journal, options);
  if (journal.state === 'committed' || journal.state === 'aborted') {
    return recoveryResult(journal, null);
  }
  const runtime = await readProjectRuntimeContext(root);
  const store = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const locks = options.taskLockHeld
    ? []
    : await acquireEntityLocks(store, createUlid(), [
        taskEntityKey(journal.prepared.targetBundle.taskRef),
      ]);
  try {
    journal = await requireJournal(root, operationId);
    await assertRecoveryAuthorized(root, journal, options);
    if (journal.state === 'committed' || journal.state === 'aborted') {
      return recoveryResult(journal, null);
    }
    const project = await new V3ContextStore(root).readProjectSnapshot();
    if (project.config.transport.mode !== 'git-ref') {
      throw new Error('MANCODE_GIT_REF_SYNC_REQUIRED');
    }
    const transport = createGitRefTeamManifestStore(
      root,
      project.config,
      project.manifest,
    );
    const snapshot = await transport.pull();
    const manifest = snapshot.manifest;
    const receipt = manifest?.receipts.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (receipt === undefined) {
      if (remoteReceiptAbsenceIsProven(journal, manifest)) {
        await restorePredecessorMetadata(root, journal);
        journal = await transitionJournal(root, journal, 'aborted', null, null);
        return recoveryResult(journal, null);
      }
      journal = await transitionJournal(
        root,
        journal,
        'repair_required',
        null,
        transportReceipt,
      );
      return recoveryResult(journal, null);
    }
    const targetFence = requireTargetFence(
      manifest?.ownershipFences ?? [],
      journal,
    );
    const targetBundle = requireTargetBundle(
      manifest?.taskBundles ?? [],
      journal,
    );
    assertRemoteCommitMatches(journal, receipt, targetFence, targetBundle);
    journal = await transitionJournal(
      root,
      journal,
      'applying',
      receipt,
      transportReceipt ?? snapshot.receipt,
    );
    await writeGitRefTeamCache(root, project.config, snapshot);
    const materialization = await materializeGitRefTaskBundle({
      projectRoot: root,
      remoteRevision: receipt.remoteRevision,
      ownershipFence: targetFence,
      bundle: targetBundle,
      predecessorBundle: journal.prepared.predecessorBundle,
      pendingMetadata: journal.pendingMetadata,
      operationId: createUlid(),
    });
    journal = await transitionJournal(
      root,
      journal,
      'committed',
      receipt,
      transportReceipt ?? snapshot.receipt,
    );
    return recoveryResult(journal, materialization);
  } finally {
    await Promise.allSettled(
      [...locks].reverse().map((lock) => lock.release()),
    );
  }
}

/** Replays outstanding workflow external-commit journals in stable order. */
export async function recoverGitRefWorkflowRepairs(
  projectRoot: string,
  options: RecoverGitRefWorkflowRepairOptions = {},
): Promise<RecoveredGitRefWorkflowRepair[]> {
  const root = path.resolve(projectRoot);
  const recovered: RecoveredGitRefWorkflowRepair[] = [];
  for (const journal of await listJournals(root)) {
    if (journal.state === 'committed' || journal.state === 'aborted') continue;
    recovered.push(
      await recoverGitRefWorkflowRepair(
        root,
        journal.operationId,
        journal.transportReceipt,
        options,
      ),
    );
  }
  return recovered;
}

export async function listGitRefWorkflowRepairs(
  projectRoot: string,
): Promise<RecoveredGitRefWorkflowRepair[]> {
  return (await listUnfinishedGitRefWorkflowRepairs(projectRoot)).map(
    (journal) => ({
      operationId: journal.operationId,
      kind: journal.kind,
      state: 'repair_required',
      taskRef: journal.taskRef,
      remoteRevision: journal.remoteRevision,
      materialization: null,
    }),
  );
}

function assertRemoteCommitMatches(
  journal: GitRefWorkflowRepairJournalV1,
  receipt: GitRefRemoteMutationReceiptV1,
  fence: GitRefOwnershipFenceV1,
  bundle: GitRefTaskBundleV1,
): void {
  const prepared = journal.prepared;
  if (
    receipt.kind !== 'coordination' ||
    receipt.remoteRevision !== prepared.targetRemoteRevision ||
    receipt.ownershipEpoch !== prepared.targetOwnershipEpoch ||
    receipt.taskRef === null ||
    !sameTaskRef(receipt.taskRef, prepared.targetBundle.taskRef) ||
    receipt.entityDigests.ownershipFence !==
      digestCanonicalJson(prepared.targetFence) ||
    receipt.entityDigests.claims !== prepared.targetClaimsDigest ||
    receipt.entityDigests.handoffs !== prepared.targetHandoffsDigest ||
    receipt.entityDigests.taskBundle !==
      digestCanonicalJson(prepared.targetBundle) ||
    digestCanonicalJson(fence) !== digestCanonicalJson(prepared.targetFence) ||
    digestCanonicalJson(bundle) !== digestCanonicalJson(prepared.targetBundle)
  ) {
    throw new Error('MANCODE_REMOTE_RECEIPT_MISMATCH');
  }
}

function requireTargetFence(
  fences: readonly GitRefOwnershipFenceV1[],
  journal: GitRefWorkflowRepairJournalV1,
): GitRefOwnershipFenceV1 {
  const fence = fences.find((candidate) =>
    sameTaskRef(candidate.taskRef, journal.prepared.targetBundle.taskRef),
  );
  if (fence === undefined) {
    throw new Error('MANCODE_REMOTE_OWNERSHIP_FENCE_MISSING');
  }
  return fence;
}

function requireTargetBundle(
  bundles: readonly GitRefTaskBundleV1[],
  journal: GitRefWorkflowRepairJournalV1,
): GitRefTaskBundleV1 {
  const bundle = bundles.find((candidate) =>
    sameTaskRef(candidate.taskRef, journal.prepared.targetBundle.taskRef),
  );
  if (bundle === undefined) throw new Error('MANCODE_TASK_UNAVAILABLE');
  return bundle;
}

function remoteReceiptAbsenceIsProven(
  journal: GitRefWorkflowRepairJournalV1,
  manifest: GitRefTeamManifestV1 | null,
): boolean {
  if (
    manifest === null ||
    manifest.revision <= journal.prepared.expectedRemoteRevision
  ) {
    return true;
  }
  const bundle = manifest.taskBundles.find((candidate) =>
    sameTaskRef(candidate.taskRef, journal.prepared.predecessorBundle.taskRef),
  );
  const fence = manifest.ownershipFences.find((candidate) =>
    sameTaskRef(candidate.taskRef, journal.prepared.predecessorFence.taskRef),
  );
  return (
    bundle !== undefined &&
    fence !== undefined &&
    digestCanonicalJson(bundle) ===
      digestCanonicalJson(journal.prepared.predecessorBundle) &&
    digestCanonicalJson(fence) ===
      digestCanonicalJson(journal.prepared.predecessorFence)
  );
}

async function writePendingMetadata(
  projectRoot: string,
  journal: GitRefWorkflowRepairJournalV1,
): Promise<void> {
  const predecessor = metadataFromBundle(journal.prepared.predecessorBundle);
  const target = metadataFromBundle(journal.prepared.targetBundle);
  const current = await new V3ContextStore(projectRoot).readTaskSnapshot(
    journal.prepared.predecessorBundle.taskRef,
  );
  if (
    current.aggregate === null ||
    taskAggregateDigest(current.aggregate) !==
      journal.prepared.predecessorBundle.aggregateDigest
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  if (digestCanonicalJson(current.metadata) === digestCanonicalJson(target)) {
    return;
  }
  if (
    digestCanonicalJson(current.metadata) !==
      digestCanonicalJson(predecessor) &&
    digestCanonicalJson(current.metadata) !==
      digestCanonicalJson(journal.pendingMetadata)
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  if (
    digestCanonicalJson(current.metadata) ===
    digestCanonicalJson(journal.pendingMetadata)
  ) {
    return;
  }
  await atomicWrite(
    metadataPath(projectRoot, predecessor.taskRef),
    `${JSON.stringify(journal.pendingMetadata, null, 2)}\n`,
  );
}

async function restorePredecessorMetadata(
  projectRoot: string,
  journal: GitRefWorkflowRepairJournalV1,
): Promise<void> {
  const predecessor = metadataFromBundle(journal.prepared.predecessorBundle);
  const target = metadataFromBundle(journal.prepared.targetBundle);
  const targetPath = metadataPath(projectRoot, predecessor.taskRef);
  const current = parseWorkflowMetadata(
    JSON.parse(await readSafeFile(targetPath)) as unknown,
  );
  if (digestCanonicalJson(current) === digestCanonicalJson(predecessor)) {
    return;
  }
  if (
    digestCanonicalJson(current) === digestCanonicalJson(target) ||
    digestCanonicalJson(current) !==
      digestCanonicalJson(journal.pendingMetadata)
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  await atomicWrite(targetPath, `${JSON.stringify(predecessor, null, 2)}\n`);
}

function assertPendingMetadata(
  prepared: PreparedGitRefWorkflowMutationV1,
  pending: WorkflowMetadataV3,
): void {
  const predecessor = metadataFromBundle(prepared.predecessorBundle);
  const target = metadataFromBundle(prepared.targetBundle);
  const normalized = parseWorkflowMetadata({
    ...pending,
    revision: predecessor.revision,
    transitionState: predecessor.transitionState,
    lastOperationId: predecessor.lastOperationId,
    updatedAt: predecessor.updatedAt,
  });
  if (
    pending.transitionState !== 'operation_pending' ||
    pending.revision !== predecessor.revision + 1 ||
    pending.lastOperationId !== prepared.operationId ||
    target.transitionState !== 'stable' ||
    target.revision !== pending.revision + 1 ||
    target.lastOperationId !== prepared.operationId ||
    digestCanonicalJson(normalized) !== digestCanonicalJson(predecessor)
  ) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_TARGET_INVALID');
  }
}

function assertJournalAuthorization(
  prepared: PreparedGitRefWorkflowMutationV1,
  actorId: Ulid,
  sessionId: Ulid,
  authorizationBasis: AuthorizationBasisV1,
): void {
  if (
    authorizationBasis.actorId !== actorId ||
    authorizationBasis.sessionId !== sessionId ||
    (prepared.kind === 'workflow_update' &&
      authorizationBasis.action !== 'shared_metadata_plan_mutation') ||
    (prepared.kind !== 'workflow_update' &&
      authorizationBasis.action !== 'task_complete_scope_change_child_merge')
  ) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_AUTHORIZATION_INVALID');
  }
}

async function assertRecoveryAuthorized(
  projectRoot: string,
  journal: GitRefWorkflowRepairJournalV1,
  options: RecoverGitRefWorkflowRepairOptions,
): Promise<void> {
  if (options.actorId === undefined || options.sessionId === undefined) {
    throw new Error('MANCODE_SESSION_REQUIRED');
  }
  assertRepairUsesOriginalAuthorization(
    journal.authorizationBasis,
    options.actorId,
    options.sessionId,
  );
  const session = await readSession(projectRoot, options.sessionId);
  if (
    session === null ||
    session.status !== 'active' ||
    session.actorId !== options.actorId
  ) {
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  }
}

function parsePrepared(value: unknown): PreparedGitRefWorkflowMutationV1 {
  assertRecord(value, 'git-ref workflow prepared mutation');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'operationId',
      'expectedRemoteRevision',
      'expectedOwnershipEpoch',
      'targetRemoteRevision',
      'targetOwnershipEpoch',
      'predecessorBundle',
      'predecessorFence',
      'targetBundle',
      'targetFence',
      'targetClaimsDigest',
      'targetHandoffsDigest',
    ],
    'git-ref workflow prepared mutation',
  );
  if (
    value.schemaVersion !== 1 ||
    (value.kind !== 'workflow_update' &&
      value.kind !== 'scope_change' &&
      value.kind !== 'task_complete')
  ) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CORRUPT');
  }
  assertUlid(value.operationId, 'git-ref workflow prepared operationId');
  const expectedRemoteRevision = positiveInteger(
    value.expectedRemoteRevision,
    'git-ref workflow expectedRemoteRevision',
    true,
  );
  const expectedOwnershipEpoch = positiveInteger(
    value.expectedOwnershipEpoch,
    'git-ref workflow expectedOwnershipEpoch',
    true,
  );
  const targetRemoteRevision = positiveInteger(
    value.targetRemoteRevision,
    'git-ref workflow targetRemoteRevision',
  );
  const targetOwnershipEpoch = positiveInteger(
    value.targetOwnershipEpoch,
    'git-ref workflow targetOwnershipEpoch',
    true,
  );
  const predecessorBundle = parseGitRefTaskBundle(value.predecessorBundle);
  const predecessorFence = parseGitRefOwnershipFence(value.predecessorFence);
  const targetBundle = parseGitRefTaskBundle(value.targetBundle);
  const targetFence = parseGitRefOwnershipFence(value.targetFence);
  if (
    targetRemoteRevision !== expectedRemoteRevision + 1 ||
    targetOwnershipEpoch !== expectedOwnershipEpoch ||
    !sameTaskRef(predecessorBundle.taskRef, targetBundle.taskRef) ||
    !sameTaskRef(predecessorFence.taskRef, predecessorBundle.taskRef) ||
    !sameTaskRef(targetFence.taskRef, targetBundle.taskRef) ||
    predecessorFence.remoteRevision !== expectedRemoteRevision ||
    predecessorFence.ownershipEpoch !== expectedOwnershipEpoch ||
    predecessorFence.taskRevision !== predecessorBundle.taskRevision ||
    predecessorFence.aggregateDigest !== predecessorBundle.aggregateDigest ||
    targetBundle.taskRevision <= predecessorBundle.taskRevision ||
    targetBundle.taskRevision !== targetFence.taskRevision ||
    targetBundle.ownershipEpoch !== targetFence.ownershipEpoch ||
    targetBundle.aggregateDigest !== targetFence.aggregateDigest ||
    targetFence.remoteRevision !== targetRemoteRevision ||
    targetFence.ownershipEpoch !== targetOwnershipEpoch ||
    targetFence.lastOperationId !== value.operationId ||
    !isDigest(value.targetClaimsDigest) ||
    !isDigest(value.targetHandoffsDigest)
  ) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_TARGET_INVALID');
  }
  return {
    schemaVersion: 1,
    kind: value.kind,
    operationId: value.operationId,
    expectedRemoteRevision,
    expectedOwnershipEpoch,
    targetRemoteRevision,
    targetOwnershipEpoch,
    predecessorBundle,
    predecessorFence,
    targetBundle,
    targetFence,
    targetClaimsDigest: value.targetClaimsDigest,
    targetHandoffsDigest: value.targetHandoffsDigest,
  };
}

function parseJournal(value: unknown): GitRefWorkflowRepairJournalV1 {
  assertRecord(value, 'git-ref workflow repair journal');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'workspaceId',
      'actorId',
      'sessionId',
      'authorizationBasis',
      'state',
      'prepared',
      'pendingMetadata',
      'remoteReceipt',
      'transportReceipt',
      'createdAt',
      'updatedAt',
    ],
    'git-ref workflow repair journal',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CORRUPT');
  }
  assertUlid(value.operationId, 'git-ref workflow repair operationId');
  assertUlid(value.workspaceId, 'git-ref workflow repair workspaceId');
  assertUlid(value.actorId, 'git-ref workflow repair actorId');
  assertUlid(value.sessionId, 'git-ref workflow repair sessionId');
  if (
    value.state !== 'awaiting_remote' &&
    value.state !== 'applying' &&
    value.state !== 'committed' &&
    value.state !== 'aborted' &&
    value.state !== 'repair_required'
  ) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CORRUPT');
  }
  const prepared = parsePrepared(value.prepared);
  if (prepared.operationId !== value.operationId) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CORRUPT');
  }
  const authorizationBasis = parseAuthorizationBasis(value.authorizationBasis);
  assertJournalAuthorization(
    prepared,
    value.actorId,
    value.sessionId,
    authorizationBasis,
  );
  const pendingMetadata = parseWorkflowMetadata(value.pendingMetadata);
  assertPendingMetadata(prepared, pendingMetadata);
  const remoteReceipt =
    value.remoteReceipt === null
      ? null
      : parseGitRefRemoteMutationReceipt(value.remoteReceipt);
  if (
    value.transportReceipt !== null &&
    (typeof value.transportReceipt !== 'string' ||
      !value.transportReceipt.trim() ||
      value.transportReceipt.includes('\0'))
  ) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CORRUPT');
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    workspaceId: value.workspaceId,
    actorId: value.actorId,
    sessionId: value.sessionId,
    authorizationBasis,
    state: value.state,
    prepared,
    pendingMetadata,
    remoteReceipt,
    transportReceipt: value.transportReceipt as string | null,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

function recoveryResult(
  journal: GitRefWorkflowRepairJournalV1,
  materialization: MaterializedGitRefTaskBundleResult | null,
): RecoveredGitRefWorkflowRepair {
  if (
    journal.state !== 'committed' &&
    journal.state !== 'aborted' &&
    journal.state !== 'repair_required'
  ) {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
  return {
    operationId: journal.operationId,
    kind: journal.prepared.kind,
    state: journal.state,
    taskRef: journal.prepared.targetBundle.taskRef,
    remoteRevision: journal.prepared.targetRemoteRevision,
    materialization,
  };
}

async function transitionJournal(
  projectRoot: string,
  journal: GitRefWorkflowRepairJournalV1,
  state: RepairState,
  remoteReceipt: GitRefRemoteMutationReceiptV1 | null,
  transportReceipt: string | null,
): Promise<GitRefWorkflowRepairJournalV1> {
  const next = parseJournal({
    ...journal,
    state,
    remoteReceipt,
    transportReceipt,
    updatedAt: new Date().toISOString(),
  });
  await replaceJournal(projectRoot, next);
  return next;
}

async function createJournal(
  projectRoot: string,
  journal: GitRefWorkflowRepairJournalV1,
): Promise<void> {
  await ensureJournalDirectory(projectRoot);
  const target = journalPath(projectRoot, journal.operationId);
  try {
    await writeFile(target, serialize(journal), {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await requireJournal(projectRoot, journal.operationId);
    if (digestCanonicalJson(existing) !== digestCanonicalJson(journal)) {
      throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CONFLICT');
    }
  }
}

async function replaceJournal(
  projectRoot: string,
  journal: GitRefWorkflowRepairJournalV1,
): Promise<void> {
  await atomicWrite(
    journalPath(projectRoot, journal.operationId),
    serialize(journal),
  );
}

async function requireJournal(
  projectRoot: string,
  operationId: Ulid,
): Promise<GitRefWorkflowRepairJournalV1> {
  try {
    return parseJournal(
      JSON.parse(await readFile(journalPath(projectRoot, operationId), 'utf8')),
    );
  } catch (error) {
    if (error instanceof SyntaxError || isNotFound(error)) {
      throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_NOT_FOUND');
    }
    throw error;
  }
}

async function listJournals(
  projectRoot: string,
): Promise<GitRefWorkflowRepairJournalV1[]> {
  let entries: string[];
  try {
    entries = await readdir(journalDirectory(projectRoot));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const journals: GitRefWorkflowRepairJournalV1[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    journals.push(
      parseJournal(
        JSON.parse(
          await readFile(
            path.join(journalDirectory(projectRoot), entry),
            'utf8',
          ),
        ),
      ),
    );
  }
  return journals;
}

function metadataFromBundle(bundle: GitRefTaskBundleV1): WorkflowMetadataV3 {
  const artifact = bundle.artifacts.find(
    (candidate) => candidate.kind === 'metadata',
  );
  if (artifact === undefined) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_INVALID');
  }
  return parseWorkflowMetadata(artifact.content);
}

function metadataPath(
  projectRoot: string,
  taskRef: GitRefTaskBundleV1['taskRef'],
): string {
  return path.join(taskRootPath(projectRoot, taskRef), 'metadata.json');
}

async function readSafeFile(target: string): Promise<string> {
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

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  await replaceFileAtomically(temporary, target);
}

async function ensureJournalDirectory(projectRoot: string): Promise<void> {
  let current = path.resolve(projectRoot);
  for (const segment of ['.mancode', 'local', 'journals', 'git-ref-workflow']) {
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

function positiveInteger(
  value: unknown,
  label: string,
  allowZero = false,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CORRUPT');
  }
  return value;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

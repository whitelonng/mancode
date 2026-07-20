import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
import { taskEntityKey } from '../runtime/task-operation.js';
import { createGitRefTeamManifestStore } from './git-ref-client.js';
import { materializeGitRefTaskBundle } from './git-ref-materialization.js';
import {
  type AcceptGitRefHandoffInput,
  type AcceptedGitRefHandoff,
  type PreparedGitRefHandoffAcceptV1,
  acceptGitRefHandoff,
} from './git-ref-operation.js';
import {
  type GitRefOwnershipFenceV1,
  type GitRefRemoteMutationReceiptV1,
  type GitRefTaskBundleV1,
  parseGitRefRemoteMutationReceipt,
  parseGitRefTaskBundle,
} from './git-ref-transport.js';

type RepairState =
  | 'awaiting_remote'
  | 'applying'
  | 'committed'
  | 'aborted'
  | 'repair_required';

interface GitRefHandoffRepairJournalV1 {
  schemaVersion: 1;
  operationId: Ulid;
  workspaceId: Ulid;
  state: RepairState;
  prepared: PreparedGitRefHandoffAcceptV1;
  pendingMetadata: WorkflowMetadataV3;
  remoteReceipt: GitRefRemoteMutationReceiptV1 | null;
  transportReceipt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecoveredGitRefHandoffRepair {
  operationId: Ulid;
  state: Extract<RepairState, 'committed' | 'aborted' | 'repair_required'>;
  taskRef: GitRefTaskBundleV1['taskRef'];
  remoteRevision: number;
}

/** Runs remote accept with an exact local write-ahead and forward repair. */
export async function acceptGitRefHandoffWithRepair(
  input: AcceptGitRefHandoffInput,
): Promise<AcceptedGitRefHandoff> {
  let preparedOperationId: Ulid | null = null;
  try {
    const accepted = await acceptGitRefHandoff({
      ...input,
      beforeRemoteCommit: async (prepared) => {
        await prepareHandoffRepairWhileTaskLocked(input.projectRoot, prepared);
        preparedOperationId = prepared.operationId;
        await input.beforeRemoteCommit?.(prepared);
      },
    });
    await recoverGitRefHandoffRepair(
      input.projectRoot,
      accepted.operationId,
      accepted.receipt,
    );
    return accepted;
  } catch (error) {
    if (preparedOperationId !== null) {
      try {
        await recoverGitRefHandoffRepair(
          input.projectRoot,
          preparedOperationId,
          null,
        );
      } catch {
        // The durable journal remains repairable; preserve the remote error.
      }
    }
    throw error;
  }
}

/** Recovers every handoff external-commit journal in deterministic order. */
export async function recoverGitRefHandoffRepairs(
  projectRoot: string,
): Promise<RecoveredGitRefHandoffRepair[]> {
  const results: RecoveredGitRefHandoffRepair[] = [];
  for (const journal of await listJournals(projectRoot)) {
    if (journal.state === 'committed' || journal.state === 'aborted') continue;
    results.push(
      await recoverGitRefHandoffRepair(
        projectRoot,
        journal.operationId,
        journal.transportReceipt,
      ),
    );
  }
  return results;
}

export async function recoverGitRefHandoffRepair(
  projectRoot: string,
  operationId: Ulid,
  transportReceipt: string | null,
): Promise<RecoveredGitRefHandoffRepair> {
  assertUlid(operationId, 'git-ref handoff repair operationId');
  const root = path.resolve(projectRoot);
  let journal = await requireJournal(root, operationId);
  if (journal.state === 'committed' || journal.state === 'aborted') {
    return recoveryResult(journal);
  }
  const runtime = await readProjectRuntimeContext(root);
  const store = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const recoveryOperationId = createUlid();
  const locks = await acquireEntityLocks(store, recoveryOperationId, [
    taskEntityKey(journal.prepared.targetBundle.taskRef),
  ]);
  try {
    journal = await requireJournal(root, operationId);
    const project = await new V3ContextStore(root).readProjectSnapshot();
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
      if (
        remoteReceiptAbsenceIsProven(
          journal,
          manifest?.receipts ?? [],
          manifest?.revision ?? 0,
        )
      ) {
        await restorePredecessorMetadata(root, journal);
        journal = await transitionJournal(root, journal, 'aborted', null, null);
        return recoveryResult(journal);
      }
      journal = await transitionJournal(
        root,
        journal,
        'repair_required',
        null,
        transportReceipt,
      );
      return recoveryResult(journal);
    }
    assertRemoteCommitMatches(journal, receipt);
    journal = await transitionJournal(
      root,
      journal,
      'applying',
      receipt,
      transportReceipt ?? snapshot.receipt,
    );
    const ownershipFence = ownershipFenceFromJournal(journal);
    await materializeGitRefTaskBundle({
      projectRoot: root,
      remoteRevision: journal.prepared.targetRemoteRevision,
      ownershipFence,
      bundle: journal.prepared.targetBundle,
      predecessorBundle: journal.prepared.predecessorBundle,
      pendingMetadata: journal.pendingMetadata,
      taskLockHeld: true,
      operationId: createUlid(),
    });
    journal = await transitionJournal(
      root,
      journal,
      'committed',
      journal.remoteReceipt,
      journal.transportReceipt,
    );
    return recoveryResult(journal);
  } finally {
    await Promise.allSettled(
      [...locks].reverse().map((lock) => lock.release()),
    );
  }
}

async function prepareHandoffRepairWhileTaskLocked(
  projectRoot: string,
  rawPrepared: PreparedGitRefHandoffAcceptV1,
): Promise<void> {
  const root = path.resolve(projectRoot);
  const prepared = parsePrepared(rawPrepared);
  const runtime = await readProjectRuntimeContext(root);
  const previousMetadata = bundleMetadata(prepared.predecessorBundle);
  const targetMetadata = bundleMetadata(prepared.targetBundle);
  const pendingMetadata = parseWorkflowMetadata({
    ...previousMetadata,
    revision: previousMetadata.revision + 1,
    transitionState: 'operation_pending',
    lastOperationId: prepared.operationId,
    updatedAt: targetMetadata.updatedAt,
  });
  const current = await new V3ContextStore(root).readTaskSnapshot(
    prepared.predecessorBundle.taskRef,
  );
  if (
    current.aggregate === null ||
    current.metadata.transitionState !== 'stable' ||
    digestCanonicalJson(current.metadata) !==
      digestCanonicalJson(previousMetadata)
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  const timestamp = new Date().toISOString();
  const journal: GitRefHandoffRepairJournalV1 = {
    schemaVersion: 1,
    operationId: prepared.operationId,
    workspaceId: runtime.workspaceId,
    state: 'awaiting_remote',
    prepared,
    pendingMetadata,
    remoteReceipt: null,
    transportReceipt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await createJournal(root, journal);
  await replaceMetadataVerified(
    root,
    previousMetadata,
    pendingMetadata,
    pendingMetadata,
  );
}

function assertRemoteCommitMatches(
  journal: GitRefHandoffRepairJournalV1,
  receipt: GitRefRemoteMutationReceiptV1,
): void {
  const prepared = journal.prepared;
  if (
    receipt.kind !== 'coordination' ||
    receipt.remoteRevision !== prepared.targetRemoteRevision ||
    receipt.ownershipEpoch !== prepared.targetOwnershipEpoch ||
    receipt.taskRef === null ||
    !sameTaskRef(receipt.taskRef, prepared.targetBundle.taskRef) ||
    receipt.entityDigests.taskBundle !==
      digestCanonicalJson(prepared.targetBundle)
  ) {
    throw new Error('MANCODE_REMOTE_RECEIPT_MISMATCH');
  }
}

function remoteReceiptAbsenceIsProven(
  journal: GitRefHandoffRepairJournalV1,
  receipts: GitRefRemoteMutationReceiptV1[],
  remoteRevision: number,
): boolean {
  if (remoteRevision <= journal.prepared.expectedRemoteRevision) return true;
  if (receipts.length === 0) return false;
  const minimumRetainedRevision = Math.min(
    ...receipts.map((receipt) => receipt.remoteRevision),
  );
  return journal.prepared.targetRemoteRevision >= minimumRetainedRevision;
}

async function restorePredecessorMetadata(
  projectRoot: string,
  journal: GitRefHandoffRepairJournalV1,
): Promise<void> {
  const predecessor = bundleMetadata(journal.prepared.predecessorBundle);
  await replaceMetadataVerified(
    projectRoot,
    journal.pendingMetadata,
    predecessor,
    predecessor,
  );
}

async function replaceMetadataVerified(
  projectRoot: string,
  expected: WorkflowMetadataV3,
  targetMetadata: WorkflowMetadataV3,
  alternateExpected: WorkflowMetadataV3,
): Promise<void> {
  const target = path.join(
    taskRootPath(projectRoot, targetMetadata.taskRef),
    'metadata.json',
  );
  const current = parseWorkflowMetadata(
    JSON.parse(await readSafeFile(target)) as unknown,
  );
  if (digestCanonicalJson(current) === digestCanonicalJson(targetMetadata)) {
    return;
  }
  if (
    digestCanonicalJson(current) !== digestCanonicalJson(expected) &&
    digestCanonicalJson(current) !== digestCanonicalJson(alternateExpected)
  ) {
    throw new Error('MANCODE_SPLIT_BRAIN');
  }
  await atomicWrite(target, `${JSON.stringify(targetMetadata, null, 2)}\n`);
}

function ownershipFenceFromJournal(
  journal: GitRefHandoffRepairJournalV1,
): GitRefOwnershipFenceV1 {
  const repair = journal.prepared.forwardRepair;
  const targetMetadata = bundleMetadata(journal.prepared.targetBundle);
  return {
    schemaVersion: 1,
    taskRef: repair.taskRef,
    ownerActorId: repair.ownerActorId,
    ownershipEpoch: repair.ownershipEpoch,
    taskRevision: repair.taskRevision,
    aggregateDigest: repair.aggregateDigest,
    remoteRevision: repair.remoteRevision,
    lastOperationId: repair.operationId,
    updatedAt: targetMetadata.updatedAt,
  };
}

function parsePrepared(
  value: PreparedGitRefHandoffAcceptV1,
): PreparedGitRefHandoffAcceptV1 {
  assertUlid(value.operationId, 'git-ref handoff prepared operationId');
  const predecessorBundle = parseGitRefTaskBundle(value.predecessorBundle);
  const targetBundle = parseGitRefTaskBundle(value.targetBundle);
  if (
    !sameTaskRef(predecessorBundle.taskRef, targetBundle.taskRef) ||
    value.targetRemoteRevision !== value.expectedRemoteRevision + 1 ||
    value.targetOwnershipEpoch !== value.expectedOwnershipEpoch + 1 ||
    value.forwardRepair.operationId !== value.operationId ||
    value.forwardRepair.remoteRevision !== value.targetRemoteRevision ||
    value.forwardRepair.bundleDigest !== targetBundle.bundleDigest ||
    value.forwardRepair.aggregateDigest !== targetBundle.aggregateDigest ||
    value.forwardRepair.taskRevision !== targetBundle.taskRevision ||
    value.forwardRepair.ownershipEpoch !== targetBundle.ownershipEpoch
  ) {
    throw new Error('MANCODE_REMOTE_FORWARD_REPAIR_TARGET_INVALID');
  }
  return { ...value, predecessorBundle, targetBundle };
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

function recoveryResult(
  journal: GitRefHandoffRepairJournalV1,
): RecoveredGitRefHandoffRepair {
  const state = journal.state;
  if (
    state !== 'committed' &&
    state !== 'aborted' &&
    state !== 'repair_required'
  ) {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
  return {
    operationId: journal.operationId,
    state,
    taskRef: journal.prepared.targetBundle.taskRef,
    remoteRevision: journal.prepared.targetRemoteRevision,
  };
}

async function transitionJournal(
  projectRoot: string,
  journal: GitRefHandoffRepairJournalV1,
  state: RepairState,
  remoteReceipt: GitRefRemoteMutationReceiptV1 | null,
  transportReceipt: string | null,
): Promise<GitRefHandoffRepairJournalV1> {
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

function parseJournal(value: unknown): GitRefHandoffRepairJournalV1 {
  assertRecord(value, 'git-ref handoff repair journal');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'workspaceId',
      'state',
      'prepared',
      'pendingMetadata',
      'remoteReceipt',
      'transportReceipt',
      'createdAt',
      'updatedAt',
    ],
    'git-ref handoff repair journal',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('MANCODE_HANDOFF_REPAIR_JOURNAL_CORRUPT');
  }
  assertUlid(value.operationId, 'git-ref handoff repair operationId');
  assertUlid(value.workspaceId, 'git-ref handoff repair workspaceId');
  if (
    value.state !== 'awaiting_remote' &&
    value.state !== 'applying' &&
    value.state !== 'committed' &&
    value.state !== 'aborted' &&
    value.state !== 'repair_required'
  ) {
    throw new Error('MANCODE_HANDOFF_REPAIR_JOURNAL_CORRUPT');
  }
  const prepared = parsePrepared(
    value.prepared as unknown as PreparedGitRefHandoffAcceptV1,
  );
  if (prepared.operationId !== value.operationId) {
    throw new Error('MANCODE_HANDOFF_REPAIR_JOURNAL_CORRUPT');
  }
  const pendingMetadata = parseWorkflowMetadata(value.pendingMetadata);
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
    throw new Error('MANCODE_HANDOFF_REPAIR_JOURNAL_CORRUPT');
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    workspaceId: value.workspaceId,
    state: value.state,
    prepared,
    pendingMetadata,
    remoteReceipt,
    transportReceipt: value.transportReceipt as string | null,
    createdAt: parseTimestamp(value.createdAt),
    updatedAt: parseTimestamp(value.updatedAt),
  };
}

async function createJournal(
  projectRoot: string,
  journal: GitRefHandoffRepairJournalV1,
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
      throw new Error('MANCODE_HANDOFF_REPAIR_JOURNAL_CONFLICT');
    }
  }
}

async function replaceJournal(
  projectRoot: string,
  journal: GitRefHandoffRepairJournalV1,
): Promise<void> {
  const target = journalPath(projectRoot, journal.operationId);
  await atomicWrite(target, serialize(journal));
}

async function requireJournal(
  projectRoot: string,
  operationId: Ulid,
): Promise<GitRefHandoffRepairJournalV1> {
  try {
    return parseJournal(
      JSON.parse(await readFile(journalPath(projectRoot, operationId), 'utf8')),
    );
  } catch (error) {
    if (error instanceof SyntaxError || isNotFound(error)) {
      throw new Error('MANCODE_HANDOFF_REPAIR_JOURNAL_NOT_FOUND');
    }
    throw error;
  }
}

async function listJournals(
  projectRoot: string,
): Promise<GitRefHandoffRepairJournalV1[]> {
  let entries: string[];
  try {
    entries = await readdir(journalDirectory(projectRoot));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const journals: GitRefHandoffRepairJournalV1[] = [];
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
  for (const segment of ['.mancode', 'local', 'journals', 'git-ref-handoff']) {
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

function journalDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'journals',
    'git-ref-handoff',
  );
}

function journalPath(projectRoot: string, operationId: Ulid): string {
  assertUlid(operationId, 'git-ref handoff repair operationId');
  return path.join(journalDirectory(projectRoot), `${operationId}.json`);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseTimestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('MANCODE_HANDOFF_REPAIR_JOURNAL_CORRUPT');
  }
  return value;
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

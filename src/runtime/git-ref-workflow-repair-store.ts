import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { type Ulid, assertUlid } from '../context/ids.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import { assertRecord } from '../context/validation.js';

export type GitRefWorkflowRepairJournalState =
  | 'awaiting_remote'
  | 'applying'
  | 'committed'
  | 'aborted'
  | 'repair_required';

export type GitRefWorkflowRepairJournalKind =
  | 'workflow_update'
  | 'scope_change'
  | 'task_complete';

/**
 * The small, dependency-free index needed by readers, Beta, and retention.
 * Full target validation remains in the repair executor; this view deliberately
 * avoids importing the executor so every normal task read can see an
 * interrupted remote workflow mutation without creating an import cycle.
 */
export interface GitRefWorkflowRepairJournalSummary {
  operationId: Ulid;
  actorId: Ulid;
  sessionId: Ulid;
  state: GitRefWorkflowRepairJournalState;
  kind: GitRefWorkflowRepairJournalKind;
  taskRef: TaskRef;
  remoteRevision: number;
  updatedAt: string;
  journalPath: string;
}

export function gitRefWorkflowRepairJournalDirectory(
  projectRoot: string,
): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'journals',
    'git-ref-workflow',
  );
}

export function gitRefWorkflowRepairJournalPath(
  projectRoot: string,
  operationId: Ulid,
): string {
  assertUlid(operationId, 'git-ref workflow repair operationId');
  return path.join(
    gitRefWorkflowRepairJournalDirectory(projectRoot),
    `${operationId}.json`,
  );
}

export async function listGitRefWorkflowRepairJournalSummaries(
  projectRoot: string,
  options: { includeTerminal?: boolean } = {},
): Promise<GitRefWorkflowRepairJournalSummary[]> {
  const directory = gitRefWorkflowRepairJournalDirectory(projectRoot);
  const entries = await readDirectoryOrEmpty(directory);
  const summaries: GitRefWorkflowRepairJournalSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const journalPath = path.join(directory, entry);
    let summary: GitRefWorkflowRepairJournalSummary;
    try {
      summary = parseSummary(
        JSON.parse(await readRegularFile(journalPath)),
        journalPath,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'MANCODE_ARTIFACT_PATH_UNSAFE'
      ) {
        throw error;
      }
      throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CORRUPT');
    }
    if (entry !== `${summary.operationId}.json`) {
      throw new Error('MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_CORRUPT');
    }
    if (
      options.includeTerminal !== true &&
      (summary.state === 'committed' || summary.state === 'aborted')
    ) {
      continue;
    }
    summaries.push(summary);
  }
  return summaries.sort((left, right) =>
    Buffer.from(left.operationId, 'utf8').compare(
      Buffer.from(right.operationId, 'utf8'),
    ),
  );
}

export function listUnfinishedGitRefWorkflowRepairs(
  projectRoot: string,
): Promise<GitRefWorkflowRepairJournalSummary[]> {
  return listGitRefWorkflowRepairJournalSummaries(projectRoot, {
    includeTerminal: false,
  });
}

function parseSummary(
  value: unknown,
  journalPath: string,
): GitRefWorkflowRepairJournalSummary {
  assertRecord(value, 'git-ref workflow repair journal');
  if (value.schemaVersion !== 1) {
    throw new Error('git-ref workflow repair schemaVersion is invalid');
  }
  assertUlid(value.operationId, 'git-ref workflow repair operationId');
  assertUlid(value.actorId, 'git-ref workflow repair actorId');
  assertUlid(value.sessionId, 'git-ref workflow repair sessionId');
  const state = parseState(value.state);
  assertRecord(value.prepared, 'git-ref workflow repair prepared mutation');
  const kind = parseKind(value.prepared.kind);
  assertRecord(
    value.prepared.targetBundle,
    'git-ref workflow repair target bundle',
  );
  const taskRef = parseTaskRefValue(value.prepared.targetBundle.taskRef);
  const remoteRevision = parsePositiveInteger(
    value.prepared.targetRemoteRevision,
    'git-ref workflow repair target remote revision',
  );
  const updatedAt = parseTimestamp(value.updatedAt);
  return {
    operationId: value.operationId,
    actorId: value.actorId,
    sessionId: value.sessionId,
    state,
    kind,
    taskRef,
    remoteRevision,
    updatedAt,
    journalPath,
  };
}

function parseState(value: unknown): GitRefWorkflowRepairJournalState {
  if (
    value !== 'awaiting_remote' &&
    value !== 'applying' &&
    value !== 'committed' &&
    value !== 'aborted' &&
    value !== 'repair_required'
  ) {
    throw new Error('git-ref workflow repair state is invalid');
  }
  return value;
}

function parseKind(value: unknown): GitRefWorkflowRepairJournalKind {
  if (
    value !== 'workflow_update' &&
    value !== 'scope_change' &&
    value !== 'task_complete'
  ) {
    throw new Error('git-ref workflow repair kind is invalid');
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseTimestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('git-ref workflow repair updatedAt is invalid');
  }
  return value;
}

async function readDirectoryOrEmpty(directory: string): Promise<string[]> {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
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

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

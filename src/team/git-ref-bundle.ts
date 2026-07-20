import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digestCanonicalJson } from '../context/canonical.js';
import type { StoredTaskSnapshot } from '../context/store.js';
import {
  type TaskRef,
  formatTaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import {
  type GitRefJsonValue,
  type GitRefTaskBundleArtifactKind,
  type GitRefTaskBundleArtifactV1,
  type GitRefTaskBundleV1,
  gitRefTaskBundleDigest,
  parseGitRefTaskBundle,
} from './git-ref-transport.js';

const execFile = promisify(execFileCallback);

export interface CreateGitRefTaskBundleInput {
  task: StoredTaskSnapshot;
  codeRef: { branch: string; head: string };
  now?: Date;
}

/** Builds and re-parses the exact transport representation before any push. */
export function createGitRefTaskBundle(
  input: CreateGitRefTaskBundleInput,
): GitRefTaskBundleV1 {
  const { task } = input;
  if (task.metadata.taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_REMOTE_COORDINATION_REQUIRES_SHARED_TASK');
  }
  if (task.aggregate === null) {
    throw new Error('MANCODE_TASK_UNAVAILABLE');
  }
  const artifacts: GitRefTaskBundleArtifactV1[] = [
    artifact('metadata', 'metadata.json', task.metadata),
    artifact('requirements', 'requirements.json', task.requirements),
    artifact('review', 'review-ledger.json', task.review),
    artifact('verification', 'verification-ledger.json', task.verification),
  ];
  if (task.latestCheckpoint !== null) {
    artifacts.push(
      artifact(
        'checkpoint',
        `checkpoints/${task.latestCheckpoint.checkpointId}.json`,
        task.latestCheckpoint,
      ),
    );
  }
  if (task.plan !== null) {
    artifacts.push(artifact('plan', 'plan.md', task.plan.content));
  } else {
    artifacts.push(
      artifact(
        'summary',
        'summary.md',
        task.latestCheckpoint?.summary ??
          `Task ${formatTaskRef(task.metadata.taskRef)} revision ${task.metadata.revision}.`,
      ),
    );
  }
  artifacts.sort((left, right) =>
    left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
  );
  const body: Omit<GitRefTaskBundleV1, 'bundleDigest'> = {
    schemaVersion: 1,
    taskRef: task.metadata.taskRef,
    taskRevision: task.metadata.revision,
    ownershipEpoch: task.metadata.ownershipEpoch,
    aggregate: task.aggregate,
    aggregateDigest: digestCanonicalJson(task.aggregate),
    codeRef: parseCodeRef(input.codeRef),
    artifacts,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  return parseGitRefTaskBundle({
    ...body,
    bundleDigest: gitRefTaskBundleDigest(body),
  });
}

/** Git reachability is checked before quarantine may become a usable task. */
export async function assertGitRefBundleCodeReachable(
  projectRoot: string,
  bundle: GitRefTaskBundleV1,
): Promise<void> {
  const parsed = parseGitRefTaskBundle(bundle);
  try {
    await execFile(
      'git',
      ['cat-file', '-e', `${parsed.codeRef.head}^{commit}`],
      {
        cwd: path.resolve(projectRoot),
        windowsHide: true,
      },
    );
  } catch {
    throw new Error('MANCODE_TASK_BUNDLE_CODE_UNREACHABLE');
  }
}

/** Writes an immutable local-only candidate; this is never task authority. */
export async function quarantineGitRefTaskBundle(
  projectRoot: string,
  remoteRevision: number,
  bundle: GitRefTaskBundleV1,
): Promise<string> {
  if (!Number.isSafeInteger(remoteRevision) || remoteRevision < 1) {
    throw new Error('MANCODE_TRANSPORT_REVISION_INVALID');
  }
  const parsed = parseGitRefTaskBundle(bundle);
  const directory = path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'quarantine',
    'git-ref',
    parsed.taskRef.taskId,
    String(remoteRevision),
  );
  await ensureFixedDirectory(projectRoot, [
    '.mancode',
    'local',
    'quarantine',
    'git-ref',
    parsed.taskRef.taskId,
    String(remoteRevision),
  ]);
  const target = path.join(directory, `${parsed.bundleDigest.slice(7)}.json`);
  try {
    await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  return target;
}

export async function readQuarantinedGitRefTaskBundle(
  projectRoot: string,
  remoteRevision: number,
  taskRef: TaskRef,
  expected: {
    taskRevision: number;
    aggregateDigest: string;
    ownershipEpoch: number;
    codeRefHead: string;
  },
): Promise<GitRefTaskBundleV1 | null> {
  if (!Number.isSafeInteger(remoteRevision) || remoteRevision < 1) {
    throw new Error('MANCODE_TRANSPORT_REVISION_INVALID');
  }
  const parsedTaskRef = parseTaskRefValue(taskRef);
  const directory = path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'quarantine',
    'git-ref',
    parsedTaskRef.taskId,
    String(remoteRevision),
  );
  let entries: string[];
  try {
    await assertFixedDirectory(projectRoot, [
      '.mancode',
      'local',
      'quarantine',
      'git-ref',
      parsedTaskRef.taskId,
      String(remoteRevision),
    ]);
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const matches: GitRefTaskBundleV1[] = [];
  for (const entry of entries.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    const target = path.join(directory, entry);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    const bundle = parseGitRefTaskBundle(
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
    if (
      sameTaskRef(bundle.taskRef, parsedTaskRef) &&
      bundle.taskRevision === expected.taskRevision &&
      bundle.aggregateDigest === expected.aggregateDigest &&
      bundle.ownershipEpoch === expected.ownershipEpoch &&
      bundle.codeRef.head === expected.codeRefHead
    ) {
      matches.push(bundle);
    }
  }
  if (matches.length > 1) {
    throw new Error('MANCODE_TRANSPORT_CACHE_CORRUPT');
  }
  return matches[0] ?? null;
}

function artifact(
  kind: GitRefTaskBundleArtifactKind,
  relativePath: string,
  value: unknown,
): GitRefTaskBundleArtifactV1 {
  const content = JSON.parse(JSON.stringify(value)) as GitRefJsonValue;
  return {
    kind,
    relativePath,
    content,
    contentDigest: digestCanonicalJson(content),
  };
}

function parseCodeRef(value: { branch: string; head: string }) {
  if (
    typeof value.branch !== 'string' ||
    !value.branch.trim() ||
    value.branch.includes('\0') ||
    typeof value.head !== 'string' ||
    !/^[0-9a-f]{40,64}$/.test(value.head)
  ) {
    throw new Error('MANCODE_TASK_BUNDLE_CODE_REF_INVALID');
  }
  return { branch: value.branch, head: value.head };
}

async function ensureFixedDirectory(
  projectRoot: string,
  segments: string[],
): Promise<void> {
  let current = path.resolve(projectRoot);
  for (const segment of segments) {
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

async function assertFixedDirectory(
  projectRoot: string,
  segments: string[],
): Promise<void> {
  let current = path.resolve(projectRoot);
  for (const segment of segments) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
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

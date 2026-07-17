import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digestCanonicalJson } from '../context/canonical.js';
import type { StoredTaskSnapshot } from '../context/store.js';
import { formatTaskRef } from '../context/task-ref.js';
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

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

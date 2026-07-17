import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type ArtifactRef, parseArtifactRef } from './artifact-ref.js';
import { assertUlid } from './ids.js';
import { type TaskRef, parseTaskRef, parseTaskRefValue } from './task-ref.js';

export interface TaskLocation {
  taskRef: TaskRef;
  taskRoot: string;
}

export interface ArtifactLocation {
  artifactRef: ArtifactRef;
  artifactRoot: string;
  path: string;
}

export type TaskLocatorErrorCode =
  | 'MANCODE_TASK_NOT_FOUND'
  | 'MANCODE_TASK_AMBIGUOUS'
  | 'MANCODE_ARTIFACT_NOT_FOUND'
  | 'MANCODE_ARTIFACT_PATH_UNSAFE';

/**
 * Resolves only canonical TaskRefs or bare ULIDs. A bare ID is deliberately
 * rejected when it exists in both namespaces; callers must choose explicitly.
 */
export async function locateTask(
  projectRoot: string,
  requested: TaskRef | string,
): Promise<TaskLocation> {
  const root = path.resolve(projectRoot);
  if (typeof requested !== 'string') {
    const taskRef = parseTaskRefValue(requested);
    return locateExplicitTask(root, taskRef);
  }
  if (requested.includes(':')) {
    return locateExplicitTask(root, parseTaskRef(requested));
  }
  assertUlid(requested, 'task locator bare taskId');
  const matches = await Promise.all(
    (['local', 'shared'] as const).map(async (namespace) => {
      const taskRef: TaskRef = { namespace, taskId: requested };
      const taskRoot = taskRootPath(root, taskRef);
      return (await isDirectoryWithoutSymlink(taskRoot))
        ? { taskRef, taskRoot }
        : null;
    }),
  );
  const existing = matches.filter(
    (location): location is TaskLocation => location !== null,
  );
  if (existing.length === 0) throw locatorError('MANCODE_TASK_NOT_FOUND');
  if (existing.length > 1) throw locatorError('MANCODE_TASK_AMBIGUOUS');
  const location = existing[0];
  if (location === undefined) throw locatorError('MANCODE_TASK_NOT_FOUND');
  return location;
}

export function taskRootPath(projectRoot: string, taskRef: TaskRef): string {
  const parsed = parseTaskRefValue(taskRef);
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    parsed.namespace,
    'workflows',
    parsed.taskId,
  );
}

export function resolveArtifactLocation(
  projectRoot: string,
  artifact: ArtifactRef,
): ArtifactLocation {
  const artifactRef = parseArtifactRef(artifact);
  const root = path.resolve(projectRoot);
  const artifactRoot = artifactRootPath(root, artifactRef);
  const relativePath = artifactRelativePath(artifactRef);
  const artifactPath = path.resolve(artifactRoot, relativePath);
  assertPathWithinRoot(artifactRoot, artifactPath);
  return { artifactRef, artifactRoot, path: artifactPath };
}

export async function readTaskArtifact(
  projectRoot: string,
  artifact: ArtifactRef,
): Promise<string> {
  const location = resolveArtifactLocation(projectRoot, artifact);
  try {
    await assertResolvedArtifactPathSafe(location);
    const before = await lstat(location.path);
    const content = await readFile(location.path, 'utf8');
    const after = await lstat(location.path);
    if (!sameFileIdentity(before, after) || after.isSymbolicLink()) {
      throw locatorError('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    return content;
  } catch (error) {
    if (isLocatorError(error)) throw error;
    if (isNotFound(error)) throw locatorError('MANCODE_ARTIFACT_NOT_FOUND');
    throw error;
  }
}

export async function assertResolvedArtifactPathSafe(
  location: ArtifactLocation,
): Promise<void> {
  assertPathWithinRoot(location.artifactRoot, location.path);
  const rootStat = await safeLstat(location.artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw locatorError('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const relative = path.relative(location.artifactRoot, location.path);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw locatorError('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  let current = location.artifactRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const entry = await safeLstat(current);
    if (entry.isSymbolicLink()) {
      throw locatorError('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  }
  const [resolvedRoot, resolvedArtifact] = await Promise.all([
    realpath(location.artifactRoot),
    realpath(location.path),
  ]);
  assertPathWithinRoot(resolvedRoot, resolvedArtifact);
}

async function locateExplicitTask(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<TaskLocation> {
  const taskRoot = taskRootPath(projectRoot, taskRef);
  if (!(await isDirectoryWithoutSymlink(taskRoot))) {
    throw locatorError('MANCODE_TASK_NOT_FOUND');
  }
  return { taskRef, taskRoot };
}

function artifactRootPath(projectRoot: string, artifact: ArtifactRef): string {
  if (artifact.kind === 'handoff') {
    if (artifact.taskRef.namespace !== 'shared') {
      throw locatorError('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    return path.join(projectRoot, '.mancode', 'shared', 'team', 'handoffs');
  }
  return taskRootPath(projectRoot, artifact.taskRef);
}

function artifactRelativePath(artifact: ArtifactRef): string {
  switch (artifact.kind) {
    case 'requirements':
      assertNoArtifactId(artifact);
      return 'requirements.json';
    case 'requirements_markdown':
      assertNoArtifactId(artifact);
      return 'requirements.md';
    case 'plan':
      assertNoArtifactId(artifact);
      return 'plan.md';
    case 'review_ledger':
      assertNoArtifactId(artifact);
      return 'review-ledger.json';
    case 'verification_ledger':
      assertNoArtifactId(artifact);
      return 'verification-ledger.json';
    case 'summary':
      assertNoArtifactId(artifact);
      return 'summary.md';
    case 'checkpoint':
      return path.join('checkpoints', `${requiredArtifactId(artifact)}.json`);
    case 'review_report':
      return path.join('reports', `${requiredArtifactId(artifact)}.md`);
    case 'evidence_summary':
      return path.join(
        'reports',
        `evidence-${requiredArtifactId(artifact)}.md`,
      );
    case 'handoff':
      return `${requiredArtifactId(artifact)}.json`;
  }
}

function requiredArtifactId(artifact: ArtifactRef): string {
  if (artifact.artifactId === undefined) {
    throw locatorError('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  return artifact.artifactId;
}

function assertNoArtifactId(artifact: ArtifactRef): void {
  if (artifact.artifactId !== undefined) {
    throw locatorError('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

function assertPathWithinRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw locatorError('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

async function isDirectoryWithoutSymlink(target: string): Promise<boolean> {
  try {
    const entry = await lstat(target);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

async function safeLstat(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isNotFound(error)) throw locatorError('MANCODE_ARTIFACT_NOT_FOUND');
    throw error;
  }
}

function sameFileIdentity(
  first: Awaited<ReturnType<typeof lstat>>,
  second: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function locatorError(code: TaskLocatorErrorCode): Error {
  return new Error(code);
}

function isLocatorError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === 'MANCODE_TASK_NOT_FOUND' ||
      error.message === 'MANCODE_TASK_AMBIGUOUS' ||
      error.message === 'MANCODE_ARTIFACT_NOT_FOUND' ||
      error.message === 'MANCODE_ARTIFACT_PATH_UNSAFE')
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

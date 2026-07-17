import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  type ProjectConfigV1,
  parseProjectConfig,
  projectConfigIdentityDigest,
} from '../team/policy.js';
import {
  type EntityHomeStoreContext,
  resolveCoordinationEntityHomeStore,
} from './entity-home-store.js';
import {
  type CheckoutBindingV1,
  type WorkspaceBindingV1,
  assertCheckoutBindingMatchesWorkspace,
  assertWorkspaceBindingCompatible,
  assertWorkspaceBindingMatchesConfig,
  parseCheckoutBinding,
  parseWorkspaceBinding,
} from './workspace-binding.js';

const execFile = promisify(execFileCallback);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** A durable, local-only identity for the checkout hosting this .mancode root. */
export interface RuntimeCheckoutRecordV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  checkoutId: Ulid;
  repositoryBindingId: Ulid | null;
  registeredAt: string;
  lastSeenAt: string;
}

/** Shared through Git's common directory, never through task contents. */
export interface RepositoryRuntimeBindingV1 {
  schemaVersion: 1;
  repositoryBindingId: Ulid;
  commonDirHash: string;
  createdAt: string;
}

export interface ProjectRuntimeContext {
  projectRoot: string;
  workspaceId: Ulid;
  checkoutId: Ulid;
  repositoryBindingId: Ulid | null;
  gitCommonDir: string | null;
  entityHomeStoreContext: EntityHomeStoreContext;
}

interface GitCheckoutInfo {
  commonDir: string;
  gitDir: string;
  worktreeRoot: string;
}

/**
 * Registers exactly the runtime identities that V3 needs for local locks and
 * common-dir coordination. It creates only .mancode/local data and common-dir
 * binding records; it does not create a workflow or touch legacy authority.
 */
export async function ensureProjectRuntimeContext(
  projectRoot: string,
  now: Date = new Date(),
): Promise<ProjectRuntimeContext> {
  const root = path.resolve(projectRoot);
  const config = await readProjectConfig(root);
  const git = await inspectGitCheckout(root);
  const timestamp = now.toISOString();
  if (git === null) {
    const checkout = await ensureRuntimeCheckoutRecord(root, {
      workspaceId: config.workspaceId,
      repositoryBindingId: null,
      now: timestamp,
    });
    return runtimeContext(
      root,
      config.workspaceId,
      checkout.checkoutId,
      null,
      null,
    );
  }

  const repository = await ensureRepositoryRuntimeBinding(
    git.commonDir,
    timestamp,
  );
  const workspace = await ensureWorkspaceBinding(
    root,
    git,
    repository.repositoryBindingId,
    config,
    timestamp,
  );
  const checkout = await ensureRuntimeCheckoutRecord(root, {
    workspaceId: config.workspaceId,
    repositoryBindingId: repository.repositoryBindingId,
    now: timestamp,
  });
  await ensureCheckoutBinding(root, git, workspace, checkout, timestamp);
  return runtimeContext(
    root,
    config.workspaceId,
    checkout.checkoutId,
    repository.repositoryBindingId,
    git.commonDir,
  );
}

/**
 * Reads an already-registered runtime binding. Read-only callers must use
 * this rather than silently bootstrapping a checkout identity.
 */
export async function readProjectRuntimeContext(
  projectRoot: string,
): Promise<ProjectRuntimeContext> {
  const root = path.resolve(projectRoot);
  const config = await readProjectConfig(root);
  const checkout = await readRuntimeCheckoutRecord(root);
  if (checkout === null || checkout.workspaceId !== config.workspaceId) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
  const git = await inspectGitCheckout(root);
  if (git === null) {
    if (checkout.repositoryBindingId !== null) {
      throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
    }
    return runtimeContext(
      root,
      config.workspaceId,
      checkout.checkoutId,
      null,
      null,
    );
  }
  if (checkout.repositoryBindingId === null) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
  const repository = await readRepositoryRuntimeBinding(git.commonDir);
  if (
    repository === null ||
    repository.repositoryBindingId !== checkout.repositoryBindingId
  ) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
  const workspace = await readWorkspaceBinding(
    git.commonDir,
    config.workspaceId,
  );
  if (workspace === null) throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  assertWorkspaceBindingMatchesConfig(workspace, config);
  assertCheckoutBindingMatchesWorkspace(
    await requireCheckoutBinding(root),
    workspace,
  );
  return runtimeContext(
    root,
    config.workspaceId,
    checkout.checkoutId,
    checkout.repositoryBindingId,
    git.commonDir,
  );
}

/** Returns a checkout code head only when Git can prove one is available. */
export async function readCheckoutCodeHead(
  projectRoot: string,
): Promise<string | null> {
  const root = path.resolve(projectRoot);
  const output = await runGit(root, ['rev-parse', 'HEAD']);
  return output === null || !output.trim() ? null : output.trim();
}

/** Returns null for non-Git checkouts and detached HEADs. */
export async function readCheckoutBranch(
  projectRoot: string,
): Promise<string | null> {
  const root = path.resolve(projectRoot);
  const output = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return output === null || !output.trim() ? null : output.trim();
}

export function runtimeCheckoutRecordPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'runtime',
    'checkout.json',
  );
}

export function runtimeCheckoutBindingPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'runtime',
    'checkout-binding.json',
  );
}

export function repositoryRuntimeBindingPath(gitCommonDir: string): string {
  return path.join(path.resolve(gitCommonDir), 'mancode', 'repository.json');
}

export function workspaceRuntimeBindingPath(
  gitCommonDir: string,
  workspaceId: Ulid,
): string {
  assertUlid(workspaceId, 'workspace runtime binding workspaceId');
  return path.join(
    path.resolve(gitCommonDir),
    'mancode',
    'workspaces',
    workspaceId,
    'binding.json',
  );
}

export function parseRuntimeCheckoutRecord(
  value: unknown,
): RuntimeCheckoutRecordV1 {
  assertRecord(value, 'runtime checkout record');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'workspaceId',
      'checkoutId',
      'repositoryBindingId',
      'registeredAt',
      'lastSeenAt',
    ],
    'runtime checkout record',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('runtime checkout record schemaVersion must be 1');
  }
  assertUlid(value.workspaceId, 'runtime checkout record workspaceId');
  assertUlid(value.checkoutId, 'runtime checkout record checkoutId');
  if (value.repositoryBindingId !== null) {
    assertUlid(
      value.repositoryBindingId,
      'runtime checkout record repositoryBindingId',
    );
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    checkoutId: value.checkoutId,
    repositoryBindingId: value.repositoryBindingId,
    registeredAt: parseTimestamp(
      value.registeredAt,
      'runtime checkout record registeredAt',
    ),
    lastSeenAt: parseTimestamp(
      value.lastSeenAt,
      'runtime checkout record lastSeenAt',
    ),
  };
}

export function parseRepositoryRuntimeBinding(
  value: unknown,
): RepositoryRuntimeBindingV1 {
  assertRecord(value, 'repository runtime binding');
  assertKnownKeys(
    value,
    ['schemaVersion', 'repositoryBindingId', 'commonDirHash', 'createdAt'],
    'repository runtime binding',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('repository runtime binding schemaVersion must be 1');
  }
  assertUlid(value.repositoryBindingId, 'repository runtime binding ID');
  return {
    schemaVersion: 1,
    repositoryBindingId: value.repositoryBindingId,
    commonDirHash: parseDigest(
      value.commonDirHash,
      'repository runtime binding commonDirHash',
    ),
    createdAt: parseTimestamp(
      value.createdAt,
      'repository runtime binding createdAt',
    ),
  };
}

async function readProjectConfig(
  projectRoot: string,
): Promise<ProjectConfigV1> {
  try {
    return parseProjectConfig(
      JSON.parse(
        await readFile(
          path.join(projectRoot, '.mancode', 'shared', 'config.json'),
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if (isNotFound(error))
      throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_CONTEXT_ENTITY_CORRUPT: shared/config.json');
    }
    throw error;
  }
}

async function inspectGitCheckout(
  projectRoot: string,
): Promise<GitCheckoutInfo | null> {
  const [commonDirRaw, gitDirRaw, worktreeRootRaw] = await Promise.all([
    runGit(projectRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]),
    runGit(projectRoot, ['rev-parse', '--path-format=absolute', '--git-dir']),
    runGit(projectRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
    ]),
  ]);
  if (commonDirRaw === null || gitDirRaw === null || worktreeRootRaw === null) {
    return null;
  }
  const [commonDir, gitDir, worktreeRoot] = await Promise.all([
    realpath(resolveGitPath(projectRoot, commonDirRaw.trim())),
    realpath(resolveGitPath(projectRoot, gitDirRaw.trim())),
    realpath(resolveGitPath(projectRoot, worktreeRootRaw.trim())),
  ]);
  return { commonDir, gitDir, worktreeRoot };
}

async function ensureRepositoryRuntimeBinding(
  gitCommonDir: string,
  now: string,
): Promise<RepositoryRuntimeBindingV1> {
  const target = repositoryRuntimeBindingPath(gitCommonDir);
  const existing = await readRepositoryRuntimeBinding(gitCommonDir);
  const commonDirHash = digestPath(gitCommonDir);
  if (existing !== null) {
    if (existing.commonDirHash !== commonDirHash) {
      throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
    }
    return existing;
  }
  const candidate = parseRepositoryRuntimeBinding({
    schemaVersion: 1,
    repositoryBindingId: createUlid(),
    commonDirHash,
    createdAt: now,
  });
  return writeExclusiveOrRead(
    target,
    candidate,
    parseRepositoryRuntimeBinding,
    (stored, intended) => stored.commonDirHash === intended.commonDirHash,
    'MANCODE_WORKSPACE_BINDING_MISMATCH',
  );
}

async function ensureWorkspaceBinding(
  projectRoot: string,
  git: GitCheckoutInfo,
  repositoryBindingId: Ulid,
  config: ProjectConfigV1,
  now: string,
): Promise<WorkspaceBindingV1> {
  const projectPathFromWorktreeRoot = relativeProjectPath(
    await realpath(git.worktreeRoot),
    await realpath(projectRoot),
  );
  const candidate = parseWorkspaceBinding({
    schemaVersion: 1,
    workspaceId: config.workspaceId,
    repositoryBindingId,
    projectPathFromWorktreeRoot,
    configSchemaVersion: config.schemaVersion,
    configIdentityDigest: projectConfigIdentityDigest(config),
    registeredAt: now,
  });
  const target = workspaceRuntimeBindingPath(git.commonDir, config.workspaceId);
  const existing = await readWorkspaceBinding(
    git.commonDir,
    config.workspaceId,
  );
  if (existing !== null) {
    assertWorkspaceBindingCompatible(existing, candidate);
    assertWorkspaceBindingMatchesConfig(existing, config);
    return existing;
  }
  return writeExclusiveOrRead(
    target,
    candidate,
    parseWorkspaceBinding,
    (stored, intended) => {
      try {
        assertWorkspaceBindingCompatible(stored, intended);
        return true;
      } catch {
        return false;
      }
    },
    'MANCODE_WORKSPACE_BINDING_MISMATCH',
  );
}

async function ensureRuntimeCheckoutRecord(
  projectRoot: string,
  input: {
    workspaceId: Ulid;
    repositoryBindingId: Ulid | null;
    now: string;
  },
): Promise<RuntimeCheckoutRecordV1> {
  const target = runtimeCheckoutRecordPath(projectRoot);
  const existing = await readRuntimeCheckoutRecord(projectRoot);
  if (existing !== null) {
    if (
      existing.workspaceId !== input.workspaceId ||
      existing.repositoryBindingId !== input.repositoryBindingId
    ) {
      throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
    }
    const updated = { ...existing, lastSeenAt: input.now };
    await writeAtomic(target, updated);
    return updated;
  }
  const candidate = parseRuntimeCheckoutRecord({
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    checkoutId: createUlid(),
    repositoryBindingId: input.repositoryBindingId,
    registeredAt: input.now,
    lastSeenAt: input.now,
  });
  return writeExclusiveOrRead(
    target,
    candidate,
    parseRuntimeCheckoutRecord,
    (stored, intended) =>
      stored.workspaceId === intended.workspaceId &&
      stored.repositoryBindingId === intended.repositoryBindingId,
    'MANCODE_WORKSPACE_BINDING_MISMATCH',
  );
}

async function ensureCheckoutBinding(
  projectRoot: string,
  git: GitCheckoutInfo,
  workspace: WorkspaceBindingV1,
  checkout: RuntimeCheckoutRecordV1,
  now: string,
): Promise<CheckoutBindingV1> {
  if (checkout.repositoryBindingId === null) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
  const candidate = parseCheckoutBinding({
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    repositoryBindingId: workspace.repositoryBindingId,
    checkoutId: checkout.checkoutId,
    worktreeGitDirHash: digestPath(git.gitDir),
    projectRealpathHash: digestPath(await realpath(projectRoot)),
    registeredAt: checkout.registeredAt,
    lastSeenAt: now,
  });
  const target = runtimeCheckoutBindingPath(projectRoot);
  const existing = await readCheckoutBinding(projectRoot);
  if (existing !== null) {
    assertCheckoutBindingMatchesWorkspace(existing, workspace);
    if (
      existing.checkoutId !== candidate.checkoutId ||
      existing.worktreeGitDirHash !== candidate.worktreeGitDirHash ||
      existing.projectRealpathHash !== candidate.projectRealpathHash
    ) {
      throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
    }
    const updated = { ...existing, lastSeenAt: now };
    await writeAtomic(target, updated);
    return updated;
  }
  return writeExclusiveOrRead(
    target,
    candidate,
    parseCheckoutBinding,
    (stored, intended) =>
      stored.checkoutId === intended.checkoutId &&
      stored.worktreeGitDirHash === intended.worktreeGitDirHash &&
      stored.projectRealpathHash === intended.projectRealpathHash,
    'MANCODE_WORKSPACE_BINDING_MISMATCH',
  );
}

async function readRuntimeCheckoutRecord(
  projectRoot: string,
): Promise<RuntimeCheckoutRecordV1 | null> {
  return readJsonOrNull(
    runtimeCheckoutRecordPath(projectRoot),
    parseRuntimeCheckoutRecord,
  );
}

async function requireCheckoutBinding(
  projectRoot: string,
): Promise<CheckoutBindingV1> {
  const binding = await readCheckoutBinding(projectRoot);
  if (binding === null) throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  return binding;
}

async function readCheckoutBinding(
  projectRoot: string,
): Promise<CheckoutBindingV1 | null> {
  return readJsonOrNull(
    runtimeCheckoutBindingPath(projectRoot),
    parseCheckoutBinding,
  );
}

async function readRepositoryRuntimeBinding(
  gitCommonDir: string,
): Promise<RepositoryRuntimeBindingV1 | null> {
  return readJsonOrNull(
    repositoryRuntimeBindingPath(gitCommonDir),
    parseRepositoryRuntimeBinding,
  );
}

async function readWorkspaceBinding(
  gitCommonDir: string,
  workspaceId: Ulid,
): Promise<WorkspaceBindingV1 | null> {
  return readJsonOrNull(
    workspaceRuntimeBindingPath(gitCommonDir, workspaceId),
    parseWorkspaceBinding,
  );
}

function runtimeContext(
  projectRoot: string,
  workspaceId: Ulid,
  checkoutId: Ulid,
  repositoryBindingId: Ulid | null,
  gitCommonDir: string | null,
): ProjectRuntimeContext {
  const entityHomeStoreContext: EntityHomeStoreContext = {
    projectRoot,
    workspaceId,
    checkoutId,
    repositoryBindingId,
    gitCommonDir,
  };
  // Construct once here so incompatible bindings fail before callers resolve
  // any task or prepare a journal.
  resolveCoordinationEntityHomeStore(entityHomeStoreContext);
  return {
    projectRoot,
    workspaceId,
    checkoutId,
    repositoryBindingId,
    gitCommonDir,
    entityHomeStoreContext,
  };
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

function resolveGitPath(projectRoot: string, value: string): string {
  if (!value || value.includes('\0')) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(projectRoot, value);
}

function relativeProjectPath(
  worktreeRoot: string,
  projectRoot: string,
): string {
  const relative = path.relative(worktreeRoot, projectRoot);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
  return relative === '.' || relative === ''
    ? '.'
    : relative.split(path.sep).join('/');
}

function digestPath(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

async function writeExclusiveOrRead<T>(
  target: string,
  value: T,
  parser: (raw: unknown) => T,
  compatible: (stored: T, intended: T) => boolean,
  conflictCode: string,
): Promise<T> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, serialize(value), { encoding: 'utf8', flag: 'wx' });
    return value;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readJsonOrNull(target, parser);
    if (existing !== null && compatible(existing, value)) return existing;
    throw new Error(conflictCode);
  }
}

async function writeAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${createUlid()}.tmp`,
  );
  await writeFile(temporary, serialize(value), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporary, target);
}

async function readJsonOrNull<T>(
  target: string,
  parser: (raw: unknown) => T,
): Promise<T | null> {
  try {
    return parser(JSON.parse(await readFile(target, 'utf8')));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_WORKSPACE_BINDING_CORRUPT');
    }
    throw error;
  }
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

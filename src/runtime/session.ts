import {
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { type WorkflowMode, parseWorkflowMode } from '../context/schema.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { replaceFileAtomically } from './atomic-file.js';
import type {
  SessionIdentityCandidate,
  SessionIdentitySource,
} from './session-identity.js';

export interface SessionStateV1 {
  schemaVersion: 1;
  sessionId: Ulid;
  identitySource: SessionIdentitySource;
  identityLookupKeyHash: string | null;
  actorId: Ulid;
  client: string;
  status: 'active' | 'closed';
  activeTaskRef: TaskRef | null;
  activeMode: WorkflowMode | null;
  lastSeenRevision: number | null;
  executionIds: Ulid[];
  startedAt: string;
  closedAt: string | null;
  updatedAt: string;
}

export interface CreateSessionInput {
  actorId: Ulid;
  client: string;
  identitySource: SessionIdentitySource;
  identityLookupKeyHash?: string | null;
  sessionId?: Ulid;
  now?: Date;
}

export interface BootstrapSessionResult {
  session: SessionStateV1;
  environment: { MANCODE_SESSION_ID: Ulid };
  hint: string;
}

export interface ResumeSessionInput {
  taskRef: TaskRef;
  workflowMode: WorkflowMode;
  taskRevision: number;
  now?: Date;
}

export interface ClearSessionTaskPointerInput {
  /** Refuse to clear a pointer that another command has already replaced. */
  expectedTaskRef?: TaskRef;
  now?: Date;
}

const SESSION_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SESSION_SOURCES = new Set<SessionIdentitySource>([
  'explicit',
  'env',
  'host',
]);

export async function createSession(
  projectRoot: string,
  input: CreateSessionInput,
): Promise<SessionStateV1> {
  assertUlid(input.actorId, 'session actorId');
  if (!SESSION_SOURCES.has(input.identitySource)) {
    throw new Error('session identitySource is invalid');
  }
  const client = parseClient(input.client);
  const identityLookupKeyHash = parseIdentityLookupKeyHash(
    input.identitySource,
    input.identityLookupKeyHash ?? null,
  );
  const now = (input.now ?? new Date()).toISOString();
  const directory = sessionDirectory(projectRoot);
  await mkdir(directory, { recursive: true });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sessionId = input.sessionId ?? createUlid();
    if (input.sessionId) assertUlid(input.sessionId, 'sessionId');
    const session: SessionStateV1 = {
      schemaVersion: 1,
      sessionId,
      identitySource: input.identitySource,
      identityLookupKeyHash,
      actorId: input.actorId,
      client,
      status: 'active',
      activeTaskRef: null,
      activeMode: null,
      lastSeenRevision: null,
      executionIds: [],
      startedAt: now,
      closedAt: null,
      updatedAt: now,
    };
    try {
      await writeFile(
        sessionPath(projectRoot, sessionId),
        `${JSON.stringify(session, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      return session;
    } catch (error) {
      if (!isAlreadyExists(error) || input.sessionId) throw error;
    }
  }
  throw new Error('unable to allocate a unique sessionId');
}

export async function readSession(
  projectRoot: string,
  sessionId: string,
): Promise<SessionStateV1 | null> {
  assertUlid(sessionId, 'sessionId');
  try {
    assertUlid(sessionId, 'sessionId');
    const raw = await readFile(sessionPath(projectRoot, sessionId), 'utf8');
    return parseSessionState(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError)
      throw new Error('MANCODE_SESSION_CORRUPT');
    throw error;
  }
}

/**
 * The only bootstrap path when no host, environment, or explicit session ID
 * can be resolved. Callers surface the hint instead of installing a hidden
 * client-global session pointer.
 */
export async function createBootstrapSession(
  projectRoot: string,
  input: Pick<CreateSessionInput, 'actorId' | 'client'> & { now?: Date },
): Promise<BootstrapSessionResult> {
  const session = await createSession(projectRoot, {
    actorId: input.actorId,
    client: input.client,
    identitySource: 'explicit',
    now: input.now,
  });
  return {
    session,
    environment: { MANCODE_SESSION_ID: session.sessionId },
    hint: `export MANCODE_SESSION_ID=${session.sessionId}`,
  };
}

/**
 * Binds only this active session's convenience pointer after the resolver has
 * already validated TaskRef, workflow dimensions, repair state, and
 * freshness. Workflow state remains authoritative and is never changed here.
 */
export async function resumeSession(
  projectRoot: string,
  sessionId: Ulid,
  input: ResumeSessionInput,
): Promise<SessionStateV1> {
  assertUlid(sessionId, 'sessionId');
  const taskRef = parseTaskRefValue(input.taskRef);
  const workflowMode = parseWorkflowMode(input.workflowMode);
  const taskRevision = parseRevision(
    input.taskRevision,
    'session taskRevision',
  );
  return withSessionMutationLock(projectRoot, sessionId, async () => {
    const session = await readSession(projectRoot, sessionId);
    if (session === null || session.status !== 'active') {
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    }
    const updated: SessionStateV1 = {
      ...session,
      activeTaskRef: taskRef,
      activeMode: workflowMode,
      lastSeenRevision: taskRevision,
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    await writeSession(projectRoot, updated);
    return updated;
  });
}

/**
 * Clears only this session's convenience pointer. Workflow authority must
 * already be terminal or otherwise durable; a mismatched current pointer is
 * deliberately left untouched so a later session switch cannot be erased.
 */
export async function clearSessionTaskPointer(
  projectRoot: string,
  sessionId: Ulid,
  input: ClearSessionTaskPointerInput = {},
): Promise<SessionStateV1> {
  assertUlid(sessionId, 'sessionId');
  const expected =
    input.expectedTaskRef === undefined
      ? undefined
      : parseTaskRefValue(input.expectedTaskRef);
  return withSessionMutationLock(projectRoot, sessionId, async () => {
    const session = await readSession(projectRoot, sessionId);
    if (session === null || session.status !== 'active') {
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    }
    if (
      expected !== undefined &&
      (session.activeTaskRef === null ||
        session.activeTaskRef.namespace !== expected.namespace ||
        session.activeTaskRef.taskId !== expected.taskId)
    ) {
      return session;
    }
    const updated: SessionStateV1 = {
      ...session,
      activeTaskRef: null,
      activeMode: null,
      lastSeenRevision: null,
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    await writeSession(projectRoot, updated);
    return updated;
  });
}

/** Subagents share a session but must use distinct execution identities. */
export async function attachSessionExecution(
  projectRoot: string,
  sessionId: Ulid,
  executionId: Ulid,
  now: Date = new Date(),
): Promise<SessionStateV1> {
  assertUlid(sessionId, 'sessionId');
  assertUlid(executionId, 'executionId');
  return withSessionMutationLock(projectRoot, sessionId, async () => {
    const session = await readSession(projectRoot, sessionId);
    if (session === null || session.status !== 'active') {
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    }
    if (session.executionIds.includes(executionId)) return session;
    const updated: SessionStateV1 = {
      ...session,
      executionIds: [...session.executionIds, executionId],
      updatedAt: now.toISOString(),
    };
    await writeSession(projectRoot, updated);
    return updated;
  });
}

export async function closeSession(
  projectRoot: string,
  sessionId: Ulid,
  now: Date = new Date(),
): Promise<SessionStateV1> {
  assertUlid(sessionId, 'sessionId');
  return withSessionMutationLock(projectRoot, sessionId, async () => {
    const session = await readSession(projectRoot, sessionId);
    if (!session) throw new Error('MANCODE_SESSION_NOT_FOUND');
    if (session.status === 'closed') return session;
    const closedAt = now.toISOString();
    const closed: SessionStateV1 = {
      ...session,
      status: 'closed',
      activeTaskRef: null,
      activeMode: null,
      closedAt,
      updatedAt: closedAt,
    };
    await writeSession(projectRoot, closed);
    return closed;
  });
}

/**
 * Explicit and environment IDs must already exist. A verified host identity
 * may create its own session record, never a client-global fallback pointer.
 */
export async function resolveSessionCandidate(
  projectRoot: string,
  candidate: SessionIdentityCandidate | null,
  actorId?: Ulid,
): Promise<SessionStateV1 | null> {
  if (candidate === null) return null;
  if (candidate.internalSessionId) {
    const existing = await readSession(
      projectRoot,
      candidate.internalSessionId,
    );
    return assertUsableSession(existing, candidate.client);
  }
  if (!candidate.externalKeyHash) {
    throw new Error('MANCODE_SESSION_REQUIRED');
  }
  const existing = await findHostSession(
    projectRoot,
    candidate.client,
    candidate.externalKeyHash,
  );
  if (existing) return existing;
  if (!actorId) throw new Error('MANCODE_SESSION_REQUIRED');
  return createSession(projectRoot, {
    actorId,
    client: candidate.client,
    identitySource: 'host',
    identityLookupKeyHash: candidate.externalKeyHash,
  });
}

export function parseSessionState(value: unknown): SessionStateV1 {
  assertRecord(value, 'session state');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'sessionId',
      'identitySource',
      'identityLookupKeyHash',
      'actorId',
      'client',
      'status',
      'activeTaskRef',
      'activeMode',
      'lastSeenRevision',
      'executionIds',
      'startedAt',
      'closedAt',
      'updatedAt',
    ],
    'session state',
  );
  if (value.schemaVersion !== 1)
    throw new Error('session schemaVersion must be 1');
  assertUlid(value.sessionId, 'sessionId');
  assertUlid(value.actorId, 'session actorId');
  if (
    typeof value.identitySource !== 'string' ||
    !SESSION_SOURCES.has(value.identitySource as SessionIdentitySource)
  ) {
    throw new Error('session identitySource is invalid');
  }
  if (value.status !== 'active' && value.status !== 'closed') {
    throw new Error('session status is invalid');
  }
  const identityLookupKeyHash = parseIdentityLookupKeyHash(
    value.identitySource as SessionIdentitySource,
    value.identityLookupKeyHash,
  );
  const activeTaskRef =
    value.activeTaskRef === null
      ? null
      : parseTaskRefValue(value.activeTaskRef);
  const activeMode =
    value.activeMode === null ? null : parseWorkflowMode(value.activeMode);
  if ((activeTaskRef === null) !== (activeMode === null)) {
    throw new Error(
      'session activeTaskRef and activeMode must be set together',
    );
  }
  const closedAt = parseTimestampOrNull(value.closedAt, 'session closedAt');
  if ((value.status === 'closed') !== (closedAt !== null)) {
    throw new Error(
      'closed sessions require closedAt and active sessions must not have one',
    );
  }
  return {
    schemaVersion: 1,
    sessionId: value.sessionId,
    identitySource: value.identitySource as SessionIdentitySource,
    identityLookupKeyHash,
    actorId: value.actorId,
    client: parseClient(value.client),
    status: value.status,
    activeTaskRef,
    activeMode,
    lastSeenRevision: parseRevisionOrNull(value.lastSeenRevision),
    executionIds: parseExecutionIds(value.executionIds),
    startedAt: parseTimestamp(value.startedAt, 'session startedAt'),
    closedAt,
    updatedAt: parseTimestamp(value.updatedAt, 'session updatedAt'),
  };
}

function sessionDirectory(projectRoot: string): string {
  return path.join(projectRoot, '.mancode', 'local', 'sessions');
}

function sessionPath(projectRoot: string, sessionId: string): string {
  assertUlid(sessionId, 'sessionId');
  return path.join(sessionDirectory(projectRoot), `${sessionId}.json`);
}

function parseClient(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('session client is required');
  }
  return value.trim();
}

function parseIdentityLookupKeyHash(
  source: SessionIdentitySource,
  value: unknown,
): string | null {
  if (source === 'host') {
    if (typeof value !== 'string' || !SESSION_HASH_PATTERN.test(value)) {
      throw new Error('host sessions require identityLookupKeyHash');
    }
    return value;
  }
  if (value !== null) {
    throw new Error(
      'explicit/env sessions must not persist identityLookupKeyHash',
    );
  }
  return null;
}

function parseRevisionOrNull(value: unknown): number | null {
  if (value === null) return null;
  return parseRevision(value, 'session lastSeenRevision');
}

function parseExecutionIds(value: unknown): Ulid[] {
  if (!Array.isArray(value))
    throw new Error('session executionIds must be an array');
  const seen = new Set<string>();
  for (const executionId of value) {
    assertUlid(executionId, 'session executionId');
    if (seen.has(executionId)) {
      throw new Error('session executionIds must not contain duplicates');
    }
    seen.add(executionId);
  }
  return [...value] as Ulid[];
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseTimestampOrNull(value: unknown, label: string): string | null {
  return value === null ? null : parseTimestamp(value, label);
}

async function findHostSession(
  projectRoot: string,
  client: string,
  identityLookupKeyHash: string,
): Promise<SessionStateV1 | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionDirectory(projectRoot));
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const session = await readSession(
      projectRoot,
      entry.slice(0, -'.json'.length),
    );
    if (
      session?.status === 'active' &&
      session.client === client &&
      session.identitySource === 'host' &&
      session.identityLookupKeyHash === identityLookupKeyHash
    ) {
      return session;
    }
  }
  return null;
}

async function writeSession(
  projectRoot: string,
  session: SessionStateV1,
): Promise<void> {
  const target = sessionPath(projectRoot, session.sessionId);
  const temporary = path.join(
    sessionDirectory(projectRoot),
    `.${session.sessionId}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await replaceFileAtomically(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * A same-session update is serialized across processes. A lock is never
 * broken automatically: after a crash it is a repair signal, not authority to
 * overwrite a possibly live session update.
 */
async function withSessionMutationLock<T>(
  projectRoot: string,
  sessionId: Ulid,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = sessionLockPath(projectRoot, sessionId);
  try {
    await mkdir(lock);
  } catch (error) {
    if (isAlreadyExists(error)) throw new Error('MANCODE_SESSION_LOCK_HELD');
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
}

function sessionLockPath(projectRoot: string, sessionId: Ulid): string {
  assertUlid(sessionId, 'sessionId');
  return path.join(sessionDirectory(projectRoot), `.${sessionId}.lock`);
}

function parseRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertUsableSession(
  session: SessionStateV1 | null,
  client: string,
): SessionStateV1 {
  if (!session || session.status !== 'active' || session.client !== client) {
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  }
  return session;
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

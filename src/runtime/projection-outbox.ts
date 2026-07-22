import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from '../context/canonical.js';
import { readConfirmedDecision } from '../context/confirmed-decision.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { type WorkflowMode, parseWorkflowMode } from '../context/schema.js';
import { V3ContextStore } from '../context/store.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { readSharedActorProfile } from '../team/actor.js';
import {
  type TeamEventV1,
  assertTeamEventDedupeCompatible,
  findTeamEventByDedupeKey,
  parseTeamEvent,
  writeTeamEvent,
} from '../team/events.js';
import { replaceFileAtomically } from './atomic-file.js';
import type { OperationProjectionState } from './reconciler.js';
import {
  clearSessionTaskPointer,
  readSession,
  resumeSession,
} from './session.js';

export type ProjectionIntentState = 'pending' | 'completed' | 'superseded';
export type ProjectionAvailability =
  | 'present'
  | 'missing'
  | 'not_applicable'
  | 'conflict';
export type ProjectionCacheKind = 'context_pack' | 'status_index';

export interface AuditEventProjectionTargetV1 {
  kind: 'audit_event';
  event: TeamEventV1;
}

export interface SessionPointerProjectionTargetV1 {
  kind: 'session_pointer';
  action: 'resume' | 'clear';
  sessionId: Ulid;
  expectedPreviousTaskRef: TaskRef | null;
  taskRef: TaskRef;
  workflowMode: WorkflowMode;
  taskRevision: number;
}

export interface CacheInvalidationProjectionTargetV1 {
  kind: 'cache_invalidation';
  cacheKind: ProjectionCacheKind;
  taskRef: TaskRef;
}

export type ProjectionTargetV1 =
  | AuditEventProjectionTargetV1
  | SessionPointerProjectionTargetV1
  | CacheInvalidationProjectionTargetV1;

export interface ProjectionIntentV1 {
  schemaVersion: 1;
  projectionId: string;
  operationId: Ulid;
  state: ProjectionIntentState;
  target: ProjectionTargetV1;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueSessionPointerProjectionInput {
  operationId: Ulid;
  action: SessionPointerProjectionTargetV1['action'];
  sessionId: Ulid;
  expectedPreviousTaskRef: TaskRef | null;
  taskRef: TaskRef;
  workflowMode: WorkflowMode;
  taskRevision: number;
  now?: Date;
}

export interface EnqueueCacheInvalidationProjectionInput {
  operationId: Ulid;
  cacheKind: ProjectionCacheKind;
  taskRef: TaskRef;
  now?: Date;
}

export interface ProjectionReconcileItem {
  projectionId: string;
  kind: ProjectionTargetV1['kind'];
  availability: ProjectionAvailability;
  state: ProjectionIntentState;
}

export interface ProjectionReconcileResult {
  operationId: Ulid;
  state: 'converged' | 'repair_required';
  projections: ProjectionReconcileItem[];
}

const PROJECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INTENT_FILE_SUFFIX = '.json';

/**
 * Stores the complete audit target before its authority commit. Doctor repairs
 * only this validated event; it never reconstructs event content from a
 * journal or from mutable current state.
 */
export function enqueueAuditEventProjection(
  projectRoot: string,
  event: TeamEventV1,
  now: Date = new Date(),
): Promise<ProjectionIntentV1> {
  const parsed = parseTeamEvent(event);
  return enqueueProjection(projectRoot, {
    operationId: parsed.operationId,
    projectionId: `audit_${parsed.eventType}`,
    target: { kind: 'audit_event', event: parsed },
    now,
  });
}

export function enqueueSessionPointerProjection(
  projectRoot: string,
  input: EnqueueSessionPointerProjectionInput,
): Promise<ProjectionIntentV1> {
  assertUlid(input.operationId, 'projection operationId');
  assertUlid(input.sessionId, 'projection sessionId');
  const taskRef = parseTaskRefValue(input.taskRef);
  const expectedPreviousTaskRef =
    input.expectedPreviousTaskRef === null
      ? null
      : parseTaskRefValue(input.expectedPreviousTaskRef);
  const workflowMode = parseWorkflowMode(input.workflowMode);
  const taskRevision = parsePositiveRevision(input.taskRevision);
  return enqueueProjection(projectRoot, {
    operationId: input.operationId,
    projectionId: `session_${input.sessionId}`,
    target: {
      kind: 'session_pointer',
      action: parseSessionAction(input.action),
      sessionId: input.sessionId,
      expectedPreviousTaskRef,
      taskRef,
      workflowMode,
      taskRevision,
    },
    now: input.now ?? new Date(),
  });
}

export function enqueueCacheInvalidationProjection(
  projectRoot: string,
  input: EnqueueCacheInvalidationProjectionInput,
): Promise<ProjectionIntentV1> {
  assertUlid(input.operationId, 'projection operationId');
  const taskRef = parseTaskRefValue(input.taskRef);
  const cacheKind = parseCacheKind(input.cacheKind);
  return enqueueProjection(projectRoot, {
    operationId: input.operationId,
    projectionId: `cache_${cacheKind}_${taskRef.namespace}_${taskRef.taskId}`,
    target: { kind: 'cache_invalidation', cacheKind, taskRef },
    now: input.now ?? new Date(),
  });
}

export async function completeProjectionIntent(
  projectRoot: string,
  operationId: Ulid,
  projectionId: string,
  now: Date = new Date(),
): Promise<ProjectionIntentV1> {
  return transitionProjectionIntent(
    projectRoot,
    operationId,
    projectionId,
    'completed',
    now,
  );
}

export async function readProjectionIntent(
  projectRoot: string,
  operationId: Ulid,
  projectionId: string,
): Promise<ProjectionIntentV1 | null> {
  assertUlid(operationId, 'projection operationId');
  const parsedProjectionId = parseProjectionId(projectionId);
  try {
    return parseProjectionIntent(
      JSON.parse(
        await readFile(
          projectionIntentPath(projectRoot, operationId, parsedProjectionId),
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_PROJECTION_INTENT_CORRUPT');
    }
    throw error;
  }
}

export async function listProjectionIntents(
  projectRoot: string,
  options: { operationId?: Ulid; includeTerminal?: boolean } = {},
): Promise<ProjectionIntentV1[]> {
  if (options.operationId !== undefined) {
    assertUlid(options.operationId, 'projection operationId');
  }
  let operationIds: string[];
  try {
    operationIds =
      options.operationId === undefined
        ? await readdir(projectionOutboxDirectory(projectRoot))
        : [options.operationId];
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const intents: ProjectionIntentV1[] = [];
  for (const operationId of operationIds.sort(compareUtf8)) {
    try {
      assertUlid(operationId, 'projection outbox operationId');
    } catch {
      throw new Error('MANCODE_PROJECTION_INTENT_CORRUPT');
    }
    const directory = projectionOperationDirectory(projectRoot, operationId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries.sort(compareUtf8)) {
      if (!entry.endsWith(INTENT_FILE_SUFFIX)) continue;
      const projectionId = entry.slice(0, -INTENT_FILE_SUFFIX.length);
      const intent = await readProjectionIntent(
        projectRoot,
        operationId,
        projectionId,
      );
      if (intent === null) continue;
      if (options.includeTerminal === true || intent.state === 'pending') {
        intents.push(intent);
      }
    }
  }
  return intents.sort(
    (left, right) =>
      compareUtf8(left.operationId, right.operationId) ||
      compareUtf8(left.projectionId, right.projectionId),
  );
}

/**
 * Inspects the projections actually declared for one operation. An operation
 * with no projection intents has no projection repair work.
 */
export async function inspectOperationProjectionState(
  projectRoot: string,
  operationId: Ulid,
): Promise<OperationProjectionState> {
  assertUlid(operationId, 'projection operationId');
  const state: OperationProjectionState = {
    auditEvent: 'not_applicable',
    sessionPointer: 'not_applicable',
    cache: 'not_applicable',
  };
  const intents = await listProjectionIntents(projectRoot, {
    operationId,
    includeTerminal: true,
  });
  for (const intent of intents) {
    const key = projectionStateKey(intent.target.kind);
    const availability =
      intent.state === 'superseded'
        ? 'not_applicable'
        : await inspectProjection(projectRoot, intent.target);
    state[key] = mergeProjectionAvailability(state[key], availability);
  }
  return state;
}

/** Applies only durable, fully specified targets and leaves conflicts pending. */
export async function reconcileProjectionIntents(
  projectRoot: string,
  operationId: Ulid,
  now: Date = new Date(),
): Promise<ProjectionReconcileResult> {
  assertUlid(operationId, 'projection operationId');
  const intents = await listProjectionIntents(projectRoot, {
    operationId,
    includeTerminal: true,
  });
  const projections: ProjectionReconcileItem[] = [];
  let repairRequired = false;
  for (const intent of intents) {
    if (intent.state !== 'pending') {
      projections.push({
        projectionId: intent.projectionId,
        kind: intent.target.kind,
        availability:
          intent.state === 'completed' ? 'present' : 'not_applicable',
        state: intent.state,
      });
      continue;
    }
    let availability = await inspectProjection(projectRoot, intent.target);
    if (availability === 'missing') {
      await applyProjection(projectRoot, intent.target, now);
      availability = await inspectProjection(projectRoot, intent.target);
    }
    if (availability === 'present' || availability === 'not_applicable') {
      const state = availability === 'present' ? 'completed' : 'superseded';
      const updated = await transitionProjectionIntent(
        projectRoot,
        operationId,
        intent.projectionId,
        state,
        now,
      );
      projections.push({
        projectionId: updated.projectionId,
        kind: updated.target.kind,
        availability,
        state: updated.state,
      });
      continue;
    }
    repairRequired = true;
    projections.push({
      projectionId: intent.projectionId,
      kind: intent.target.kind,
      availability,
      state: intent.state,
    });
  }
  return {
    operationId,
    state: repairRequired ? 'repair_required' : 'converged',
    projections,
  };
}

/** An explicitly aborted authority operation makes all of its projections moot. */
export async function supersedeProjectionIntents(
  projectRoot: string,
  operationId: Ulid,
  now: Date = new Date(),
): Promise<ProjectionReconcileResult> {
  assertUlid(operationId, 'projection operationId');
  const intents = await listProjectionIntents(projectRoot, {
    operationId,
    includeTerminal: true,
  });
  const projections: ProjectionReconcileItem[] = [];
  for (const intent of intents) {
    const updated =
      intent.state === 'pending'
        ? await transitionProjectionIntent(
            projectRoot,
            operationId,
            intent.projectionId,
            'superseded',
            now,
          )
        : intent;
    projections.push({
      projectionId: updated.projectionId,
      kind: updated.target.kind,
      availability:
        updated.state === 'completed' ? 'present' : 'not_applicable',
      state: updated.state,
    });
  }
  return { operationId, state: 'converged', projections };
}

export function projectionOutboxDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'runtime',
    'projections',
  );
}

export function projectionCachePath(
  projectRoot: string,
  target: CacheInvalidationProjectionTargetV1,
): string {
  const taskRef = parseTaskRefValue(target.taskRef);
  const cacheKind = parseCacheKind(target.cacheKind);
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'cache',
    cacheKind === 'context_pack' ? 'context-packs' : 'status-index',
    taskRef.namespace,
    `${taskRef.taskId}.json`,
  );
}

export function parseProjectionIntent(value: unknown): ProjectionIntentV1 {
  assertRecord(value, 'projection intent');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'projectionId',
      'operationId',
      'state',
      'target',
      'createdAt',
      'updatedAt',
    ],
    'projection intent',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('projection intent schemaVersion must be 1');
  }
  const projectionId = parseProjectionId(value.projectionId);
  assertUlid(value.operationId, 'projection operationId');
  const state = parseProjectionState(value.state);
  const target = parseProjectionTarget(value.target);
  const createdAt = parseTimestamp(value.createdAt, 'projection createdAt');
  const updatedAt = parseTimestamp(value.updatedAt, 'projection updatedAt');
  return {
    schemaVersion: 1,
    projectionId,
    operationId: value.operationId,
    state,
    target,
    createdAt,
    updatedAt,
  };
}

async function enqueueProjection(
  projectRoot: string,
  input: {
    operationId: Ulid;
    projectionId: string;
    target: ProjectionTargetV1;
    now: Date;
  },
): Promise<ProjectionIntentV1> {
  const timestamp = input.now.toISOString();
  const intent = parseProjectionIntent({
    schemaVersion: 1,
    projectionId: input.projectionId,
    operationId: input.operationId,
    state: 'pending',
    target: input.target,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const target = projectionIntentPath(
    projectRoot,
    intent.operationId,
    intent.projectionId,
  );
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, serialize(intent), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return intent;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readProjectionIntent(
      projectRoot,
      intent.operationId,
      intent.projectionId,
    );
    if (
      existing !== null &&
      projectionIdentityDigest(existing) === projectionIdentityDigest(intent)
    ) {
      return existing;
    }
    throw new Error('MANCODE_PROJECTION_INTENT_CONFLICT');
  }
}

async function transitionProjectionIntent(
  projectRoot: string,
  operationId: Ulid,
  projectionId: string,
  state: Exclude<ProjectionIntentState, 'pending'>,
  now: Date,
): Promise<ProjectionIntentV1> {
  const existing = await readProjectionIntent(
    projectRoot,
    operationId,
    projectionId,
  );
  if (existing === null) throw new Error('MANCODE_PROJECTION_INTENT_NOT_FOUND');
  if (existing.state !== 'pending') return existing;
  const updated = parseProjectionIntent({
    ...existing,
    state,
    updatedAt: now.toISOString(),
  });
  const target = projectionIntentPath(projectRoot, operationId, projectionId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, serialize(updated), {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await replaceFileAtomically(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return updated;
}

async function inspectProjection(
  projectRoot: string,
  target: ProjectionTargetV1,
): Promise<ProjectionAvailability> {
  switch (target.kind) {
    case 'audit_event':
      return inspectAuditEventProjection(projectRoot, target.event);
    case 'session_pointer':
      return inspectSessionProjection(projectRoot, target);
    case 'cache_invalidation':
      return (await pathExists(projectionCachePath(projectRoot, target)))
        ? 'missing'
        : 'present';
  }
}

function projectionStateKey(
  kind: ProjectionTargetV1['kind'],
): keyof OperationProjectionState {
  switch (kind) {
    case 'audit_event':
      return 'auditEvent';
    case 'session_pointer':
      return 'sessionPointer';
    case 'cache_invalidation':
      return 'cache';
  }
}

function mergeProjectionAvailability(
  left: ProjectionAvailability,
  right: ProjectionAvailability,
): ProjectionAvailability {
  const priority: Record<ProjectionAvailability, number> = {
    not_applicable: 0,
    present: 1,
    missing: 2,
    conflict: 3,
  };
  return priority[right] > priority[left] ? right : left;
}

async function applyProjection(
  projectRoot: string,
  target: ProjectionTargetV1,
  now: Date,
): Promise<void> {
  switch (target.kind) {
    case 'audit_event':
      await assertAuditEventAuthority(projectRoot, target.event);
      await writeTeamEvent(projectRoot, target.event);
      return;
    case 'session_pointer':
      await applySessionProjection(projectRoot, target, now);
      return;
    case 'cache_invalidation':
      await rm(projectionCachePath(projectRoot, target), { force: true });
  }
}

async function inspectAuditEventProjection(
  projectRoot: string,
  event: TeamEventV1,
): Promise<ProjectionAvailability> {
  const authority = await auditEventAuthority(projectRoot, event);
  const existing = await findTeamEventByDedupeKey(
    projectRoot,
    event.operationId,
    event.eventType,
  );
  if (authority === 'not_applicable') return 'conflict';
  if (authority === 'conflict') return 'conflict';
  if (existing === null) return 'missing';
  try {
    assertTeamEventDedupeCompatible(existing, event);
    return 'present';
  } catch {
    return 'conflict';
  }
}

async function auditEventAuthority(
  projectRoot: string,
  event: TeamEventV1,
): Promise<'present' | 'not_applicable' | 'conflict'> {
  if (event.entityRef.kind === 'actor') {
    const actor = await readSharedActorProfile(projectRoot, event.entityRef.id);
    if (actor === null) return 'not_applicable';
    return actor.actorId === event.actorId ? 'present' : 'conflict';
  }
  if (event.entityRef.kind === 'decision') {
    const decision = await readConfirmedDecision(
      projectRoot,
      event.entityRef.id,
    );
    if (decision === null) return 'not_applicable';
    return decision.operationId === event.operationId &&
      decision.confirmedByActorId === event.actorId
      ? 'present'
      : 'conflict';
  }
  if (
    event.entityRef.kind === 'team_policy' ||
    event.entityRef.kind === 'project_config' ||
    event.entityRef.kind === 'transport'
  ) {
    const project = await new V3ContextStore(projectRoot).readProjectSnapshot();
    const authority =
      event.entityRef.kind === 'team_policy' ? project.policy : project.config;
    return authority.workspaceId === event.entityRef.id &&
      authority.lastOperationId === event.operationId
      ? 'present'
      : 'conflict';
  }
  return 'conflict';
}

async function assertAuditEventAuthority(
  projectRoot: string,
  event: TeamEventV1,
): Promise<void> {
  const authority = await auditEventAuthority(projectRoot, event);
  if (authority !== 'present') {
    throw new Error('MANCODE_PROJECTION_AUTHORITY_UNVERIFIABLE');
  }
}

async function inspectSessionProjection(
  projectRoot: string,
  target: SessionPointerProjectionTargetV1,
): Promise<ProjectionAvailability> {
  const session = await readSession(projectRoot, target.sessionId);
  if (session === null || session.status === 'closed') return 'not_applicable';
  const task = await readProjectionTask(projectRoot, target.taskRef);
  if (task === null) return 'conflict';
  if (
    task.metadata.transitionState !== 'stable' ||
    task.metadata.workflowMode !== target.workflowMode
  ) {
    return 'conflict';
  }
  if (task.metadata.revision < target.taskRevision) return 'conflict';
  const clearsPointer = workflowRequiresClearedSession(task.metadata);
  if (target.action === 'clear') {
    if (!clearsPointer) return 'conflict';
    if (session.activeTaskRef === null) return 'present';
    return sameTaskRef(session.activeTaskRef, target.taskRef)
      ? 'missing'
      : 'not_applicable';
  }
  if (clearsPointer) {
    if (session.activeTaskRef === null) return 'not_applicable';
    return sameTaskRef(session.activeTaskRef, target.taskRef)
      ? 'missing'
      : 'not_applicable';
  }
  if (
    session.activeTaskRef !== null &&
    sameTaskRef(session.activeTaskRef, target.taskRef)
  ) {
    return session.activeMode === target.workflowMode &&
      session.lastSeenRevision === task.metadata.revision
      ? 'present'
      : 'missing';
  }
  return sameNullableTaskRef(
    session.activeTaskRef,
    target.expectedPreviousTaskRef,
  )
    ? 'missing'
    : 'not_applicable';
}

async function applySessionProjection(
  projectRoot: string,
  target: SessionPointerProjectionTargetV1,
  now: Date,
): Promise<void> {
  const task = await readProjectionTask(projectRoot, target.taskRef);
  if (task === null) return;
  if (
    task.metadata.transitionState !== 'stable' ||
    task.metadata.workflowMode !== target.workflowMode
  ) {
    throw new Error('MANCODE_PROJECTION_AUTHORITY_UNVERIFIABLE');
  }
  if (task.metadata.revision < target.taskRevision) return;
  if (
    target.action === 'clear' ||
    workflowRequiresClearedSession(task.metadata)
  ) {
    await clearSessionTaskPointer(projectRoot, target.sessionId, {
      expectedTaskRef: target.taskRef,
      now,
    });
    return;
  }
  const session = await readSession(projectRoot, target.sessionId);
  if (
    session === null ||
    session.status !== 'active' ||
    (!sameNullableTaskRef(
      session.activeTaskRef,
      target.expectedPreviousTaskRef,
    ) &&
      (session.activeTaskRef === null ||
        !sameTaskRef(session.activeTaskRef, target.taskRef)))
  ) {
    return;
  }
  await resumeSession(projectRoot, target.sessionId, {
    taskRef: target.taskRef,
    workflowMode: task.metadata.workflowMode,
    taskRevision: task.metadata.revision,
    now,
  });
}

async function readProjectionTask(projectRoot: string, taskRef: TaskRef) {
  try {
    return await new V3ContextStore(projectRoot).readTaskSnapshot(taskRef);
  } catch (error) {
    if (error instanceof Error && error.message === 'MANCODE_TASK_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

function parseProjectionTarget(value: unknown): ProjectionTargetV1 {
  assertRecord(value, 'projection target');
  if (value.kind === 'audit_event') {
    assertKnownKeys(value, ['kind', 'event'], 'audit event projection target');
    return { kind: 'audit_event', event: parseTeamEvent(value.event) };
  }
  if (value.kind === 'session_pointer') {
    assertKnownKeys(
      value,
      [
        'kind',
        'action',
        'sessionId',
        'expectedPreviousTaskRef',
        'taskRef',
        'workflowMode',
        'taskRevision',
      ],
      'session pointer projection target',
    );
    assertUlid(value.sessionId, 'projection sessionId');
    return {
      kind: 'session_pointer',
      action: parseSessionAction(value.action),
      sessionId: value.sessionId,
      expectedPreviousTaskRef:
        value.expectedPreviousTaskRef === null
          ? null
          : parseTaskRefValue(value.expectedPreviousTaskRef),
      taskRef: parseTaskRefValue(value.taskRef),
      workflowMode: parseWorkflowMode(value.workflowMode),
      taskRevision: parsePositiveRevision(value.taskRevision),
    };
  }
  if (value.kind === 'cache_invalidation') {
    assertKnownKeys(
      value,
      ['kind', 'cacheKind', 'taskRef'],
      'cache invalidation projection target',
    );
    return {
      kind: 'cache_invalidation',
      cacheKind: parseCacheKind(value.cacheKind),
      taskRef: parseTaskRefValue(value.taskRef),
    };
  }
  throw new Error('projection target kind is invalid');
}

function projectionOperationDirectory(
  projectRoot: string,
  operationId: string,
): string {
  assertUlid(operationId, 'projection operationId');
  return path.join(projectionOutboxDirectory(projectRoot), operationId);
}

function projectionIntentPath(
  projectRoot: string,
  operationId: string,
  projectionId: string,
): string {
  return path.join(
    projectionOperationDirectory(projectRoot, operationId),
    `${parseProjectionId(projectionId)}${INTENT_FILE_SUFFIX}`,
  );
}

function projectionIdentityDigest(intent: ProjectionIntentV1): string {
  return digestCanonicalJson({
    projectionId: intent.projectionId,
    operationId: intent.operationId,
    target: intent.target,
  });
}

function parseProjectionId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECTION_ID_PATTERN.test(value)) {
    throw new Error('projectionId is invalid');
  }
  return value;
}

function parseProjectionState(value: unknown): ProjectionIntentState {
  if (value !== 'pending' && value !== 'completed' && value !== 'superseded') {
    throw new Error('projection intent state is invalid');
  }
  return value;
}

function parseSessionAction(
  value: unknown,
): SessionPointerProjectionTargetV1['action'] {
  if (value !== 'resume' && value !== 'clear') {
    throw new Error('session pointer projection action is invalid');
  }
  return value;
}

function parseCacheKind(value: unknown): ProjectionCacheKind {
  if (value !== 'context_pack' && value !== 'status_index') {
    throw new Error('projection cache kind is invalid');
  }
  return value;
}

function parsePositiveRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('projection taskRevision must be a positive integer');
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function sameNullableTaskRef(
  left: TaskRef | null,
  right: TaskRef | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && sameTaskRef(left, right);
}

function isTerminalWorkflowStatus(status: string): boolean {
  return (
    status === 'completed' || status === 'abandoned' || status === 'superseded'
  );
}

function workflowRequiresClearedSession(metadata: {
  status: string;
  governance: { planDecision: string | null };
}): boolean {
  return (
    isTerminalWorkflowStatus(metadata.status) ||
    (metadata.status === 'planned' &&
      metadata.governance.planDecision === 'plan_only')
  );
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

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
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

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';

/**
 * Events are intentionally a narrow audit projection. They do not include a
 * summary, command, prompt, path, or arbitrary metadata field: those values
 * belong in the authoritative entity or a local-only artifact.
 */
export interface TeamEventV1 {
  schemaVersion: 1;
  eventId: Ulid;
  eventType: string;
  operationId: Ulid;
  entityRef: TeamEventEntityRef;
  taskRef: TaskRef | null;
  actorId: Ulid;
  taskRevision: number | null;
  createdAt: string;
}

export interface TeamEventEntityRef {
  kind: TeamEventEntityKind;
  id: Ulid;
}

export type TeamEventEntityKind =
  | 'workflow'
  | 'claim'
  | 'checkpoint'
  | 'handoff'
  | 'actor'
  | 'decision'
  | 'team_policy'
  | 'project_config'
  | 'transport';

const EVENT_ENTITY_KINDS = new Set<TeamEventEntityKind>([
  'workflow',
  'claim',
  'checkpoint',
  'handoff',
  'actor',
  'decision',
  'team_policy',
  'project_config',
  'transport',
]);
const TASK_SCOPED_EVENT_KINDS = new Set<TeamEventEntityKind>([
  'workflow',
  'claim',
  'checkpoint',
  'handoff',
]);
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function parseTeamEvent(value: unknown): TeamEventV1 {
  assertRecord(value, 'team event');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'eventId',
      'eventType',
      'operationId',
      'entityRef',
      'taskRef',
      'actorId',
      'taskRevision',
      'createdAt',
    ],
    'team event',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('team event schemaVersion must be 1');
  }
  assertUlid(value.eventId, 'team event eventId');
  assertUlid(value.operationId, 'team event operationId');
  assertUlid(value.actorId, 'team event actorId');
  const event: TeamEventV1 = {
    schemaVersion: 1,
    eventId: value.eventId,
    eventType: parseEventType(value.eventType),
    operationId: value.operationId,
    entityRef: parseEntityRef(value.entityRef),
    taskRef: value.taskRef === null ? null : parseTaskRefValue(value.taskRef),
    actorId: value.actorId,
    taskRevision: parseTaskRevision(value.taskRevision),
    createdAt: parseTimestamp(value.createdAt, 'team event createdAt'),
  };
  assertTeamEventShape(event);
  return event;
}

/** The only idempotency key for an audit projection. */
export function teamEventDedupeKey(event: TeamEventV1): string {
  return `${event.operationId}:${event.eventType}`;
}

/** Full immutable event digest, suitable for a file integrity manifest. */
export function teamEventDigest(event: TeamEventV1): string {
  return digestCanonicalJson(event);
}

/**
 * Event files are a shared audit projection, outside the runtime journal
 * store. Callers must emit only after the operation commit point; a failed
 * event write never invalidates the authoritative business mutation.
 */
export async function writeTeamEvent(
  projectRoot: string,
  event: TeamEventV1,
): Promise<TeamEventV1> {
  const parsed = parseTeamEvent(event);
  const existingForOperation = await findTeamEventByDedupeKey(
    projectRoot,
    parsed.operationId,
    parsed.eventType,
  );
  if (existingForOperation !== null) {
    assertTeamEventDedupeCompatible(existingForOperation, parsed);
    return existingForOperation;
  }

  const target = teamEventPath(projectRoot, parsed.eventId);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, serialize(parsed), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return parsed;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readTeamEvent(projectRoot, parsed.eventId);
    if (
      existing !== null &&
      teamEventDigest(existing) === teamEventDigest(parsed)
    ) {
      return existing;
    }
    throw new Error('MANCODE_TEAM_EVENT_ID_CONFLICT');
  }
}

export async function readTeamEvent(
  projectRoot: string,
  eventId: string,
): Promise<TeamEventV1 | null> {
  assertUlid(eventId, 'team event eventId');
  try {
    return parseTeamEvent(
      JSON.parse(await readFile(teamEventPath(projectRoot, eventId), 'utf8')),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError)
      throw new Error('MANCODE_TEAM_EVENT_CORRUPT');
    throw error;
  }
}

export async function listTeamEvents(
  projectRoot: string,
): Promise<TeamEventV1[]> {
  let entries: string[];
  try {
    entries = await readdir(teamEventDirectory(projectRoot));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const events: TeamEventV1[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const eventId = entry.slice(0, -'.json'.length);
    try {
      assertUlid(eventId, 'team event filename');
    } catch {
      throw new Error('MANCODE_TEAM_EVENT_CORRUPT');
    }
    const event = await readTeamEvent(projectRoot, eventId);
    if (event === null) throw new Error('MANCODE_TEAM_EVENT_CORRUPT');
    events.push(event);
  }
  return events.sort((left, right) => compareUtf8(left.eventId, right.eventId));
}

export async function findTeamEventByDedupeKey(
  projectRoot: string,
  operationId: string,
  eventType: string,
): Promise<TeamEventV1 | null> {
  assertUlid(operationId, 'team event operationId');
  const parsedEventType = parseEventType(eventType);
  const matches = (await listTeamEvents(projectRoot)).filter(
    (event) =>
      event.operationId === operationId && event.eventType === parsedEventType,
  );
  if (matches.length === 0) return null;
  return dedupeTeamEvents(matches)[0] ?? null;
}

export function teamEventDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'shared',
    'team',
    'events',
  );
}

export function teamEventPath(projectRoot: string, eventId: string): string {
  assertUlid(eventId, 'team event eventId');
  return path.join(teamEventDirectory(projectRoot), `${eventId}.json`);
}

/**
 * Deduplicates a materialized event collection without treating event order as
 * state. Retried emission may have a different eventId or timestamp, but it
 * must describe the exact same operation outcome.
 */
export function dedupeTeamEvents(
  events: readonly TeamEventV1[],
): TeamEventV1[] {
  const byEventId = new Map<Ulid, TeamEventV1>();
  const byOperationAndType = new Map<string, TeamEventV1>();
  for (const rawEvent of events) {
    const event = parseTeamEvent(rawEvent);
    const existingById = byEventId.get(event.eventId);
    if (
      existingById !== undefined &&
      teamEventDigest(existingById) !== teamEventDigest(event)
    ) {
      throw new Error('MANCODE_TEAM_EVENT_ID_CONFLICT');
    }
    byEventId.set(event.eventId, event);

    const key = teamEventDedupeKey(event);
    const existing = byOperationAndType.get(key);
    if (existing === undefined) {
      byOperationAndType.set(key, event);
      continue;
    }
    assertTeamEventDedupeCompatible(existing, event);
    if (compareUtf8(event.eventId, existing.eventId) < 0) {
      byOperationAndType.set(key, event);
    }
  }
  return [...byOperationAndType.values()].sort((left, right) =>
    compareUtf8(left.eventId, right.eventId),
  );
}

export function assertTeamEventDedupeCompatible(
  existing: TeamEventV1,
  candidate: TeamEventV1,
): void {
  if (teamEventDedupeKey(existing) !== teamEventDedupeKey(candidate)) {
    throw new Error('team events do not share an operation/event-type key');
  }
  if (
    digestCanonicalJson(teamEventDedupePayload(existing)) !==
    digestCanonicalJson(teamEventDedupePayload(candidate))
  ) {
    throw new Error('MANCODE_TEAM_EVENT_DEDUPE_CONFLICT');
  }
}

function teamEventDedupePayload(event: TeamEventV1): object {
  return {
    eventType: event.eventType,
    operationId: event.operationId,
    entityRef: event.entityRef,
    taskRef: event.taskRef,
    actorId: event.actorId,
    taskRevision: event.taskRevision,
  };
}

function parseEventType(value: unknown): string {
  if (typeof value !== 'string' || !EVENT_TYPE_PATTERN.test(value)) {
    throw new Error('team event eventType is invalid');
  }
  return value;
}

function parseEntityRef(value: unknown): TeamEventEntityRef {
  assertRecord(value, 'team event entityRef');
  assertKnownKeys(value, ['kind', 'id'], 'team event entityRef');
  if (
    typeof value.kind !== 'string' ||
    !EVENT_ENTITY_KINDS.has(value.kind as TeamEventEntityKind)
  ) {
    throw new Error('team event entityRef kind is invalid');
  }
  assertUlid(value.id, 'team event entityRef id');
  return { kind: value.kind as TeamEventEntityKind, id: value.id };
}

function parseTaskRevision(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      'team event taskRevision must be a positive integer or null',
    );
  }
  return value;
}

function assertTeamEventShape(event: TeamEventV1): void {
  const taskScoped = TASK_SCOPED_EVENT_KINDS.has(event.entityRef.kind);
  if (taskScoped) {
    if (event.taskRef === null || event.taskRevision === null) {
      throw new Error(
        'task-scoped team events require taskRef and taskRevision',
      );
    }
    if (event.taskRef.namespace !== 'shared') {
      throw new Error('team events may only reference shared TaskRefs');
    }
    return;
  }
  if (event.taskRef !== null || event.taskRevision !== null) {
    throw new Error(
      'non-task team events cannot carry taskRef or taskRevision',
    );
  }
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
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

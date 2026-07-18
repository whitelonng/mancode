import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { V3ContextStore } from '../context/store.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { listClaims } from '../runtime/claim-store.js';
import {
  resolveCoordinationEntityHomeStore,
  taskHeadDirectory,
} from '../runtime/entity-home-store.js';
import { listHandoffs } from '../runtime/handoff-store.js';
import { acquireEntityLocks } from '../runtime/local-lock.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import {
  type ProjectionIntentV1,
  completeProjectionIntent,
  enqueueAuditEventProjection,
  supersedeProjectionIntents,
} from '../runtime/projection-outbox.js';
import { readSession } from '../runtime/session.js';
import { readSharedActorProfile } from './actor.js';
import { createAuthorizationBasis } from './authorization.js';
import { type TeamEventV1, writeTeamEvent } from './events.js';
import { gitRefCachePath } from './git-ref-cache.js';
import {
  type CoordinationTransport,
  type ProjectConfigV1,
  type TeamPolicyV1,
  type TeamRecommendationPolicy,
  assertConfigPolicyConsistency,
  assertProjectConfigTransition,
  assertTeamPolicyTransition,
  parseProjectConfig,
  parseTeamPolicy,
} from './policy.js';
import { capabilitiesFromProjectConfig } from './transport.js';

export interface UpdateTeamPolicyInput {
  projectRoot: string;
  sessionId: Ulid;
  expectedPolicyRevision: number;
  policy: TeamRecommendationPolicy;
  operationId?: Ulid;
  now?: Date;
}

export interface UpdatedTeamPolicy {
  policy: TeamPolicyV1;
  operationId: Ulid;
  eventId: Ulid;
  auditProjection: AuditProjectionState;
}

export interface SetTeamTransportInput {
  projectRoot: string;
  sessionId: Ulid;
  expectedConfigRevision: number;
  mode: CoordinationTransport;
  remote?: string;
  operationId?: Ulid;
  now?: Date;
}

export interface SetTeamTransportPreview {
  config: ProjectConfigV1;
  operationId: Ulid;
  eventId: Ulid;
  auditProjection: AuditProjectionState | 'not_applicable';
}

type AuditProjectionState = 'completed' | 'pending';

/**
 * CAS-updates only the recommendation policy. Configuration and policy remain
 * separate authorities, so this operation never alters transport state.
 */
export async function updateTeamPolicy(
  input: UpdateTeamPolicyInput,
): Promise<UpdatedTeamPolicy> {
  const operationId = input.operationId ?? createUlid();
  const eventId = createUlid();
  assertUlid(operationId, 'team policy operationId');
  assertUlid(eventId, 'team policy eventId');
  assertPositiveRevision(input.expectedPolicyRevision, 'team policy revision');
  if (!isTeamRecommendationPolicy(input.policy)) {
    throw new Error('MANCODE_TEAM_POLICY_INVALID');
  }
  const now = input.now ?? new Date();
  const root = path.resolve(input.projectRoot);
  const runtime = await readProjectRuntimeContext(root);
  const store = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const locks = await acquireEntityLocks(store, operationId, [
    `policy:${runtime.workspaceId}`,
  ]);
  try {
    const project = await new V3ContextStore(root).readProjectSnapshot();
    const session = await requireJoinedActiveSession(root, input.sessionId);
    if (project.policy.revision !== input.expectedPolicyRevision) {
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    const next = parseTeamPolicy({
      ...project.policy,
      policy: input.policy,
      revision: project.policy.revision + 1,
      lastOperationId: operationId,
      updatedAt: now.toISOString(),
    });
    assertConfigPolicyConsistency(project.config, next);
    assertTeamPolicyTransition(project.policy, next);
    authorizePolicyOrConfigMutation({
      actorId: session.actorId,
      sessionId: session.sessionId,
      config: project.config,
      expectedRevisionMatches: true,
      now,
    });
    const event: TeamEventV1 = {
      schemaVersion: 1,
      eventId,
      eventType: 'team_policy_updated',
      operationId,
      entityRef: { kind: 'team_policy', id: next.workspaceId },
      taskRef: null,
      actorId: session.actorId,
      taskRevision: null,
      createdAt: now.toISOString(),
    };
    const projection = await enqueueAuditEventProjection(root, event, now);
    try {
      await writeJsonAtomic(teamPolicyPath(root), next);
    } catch (error) {
      await supersedeProjectionIntents(root, operationId, now).catch(
        () => undefined,
      );
      throw error;
    }
    const auditProjection = await publishAuditEventProjection(
      root,
      event,
      projection,
      now,
    );
    return { policy: next, operationId, eventId, auditProjection };
  } finally {
    await releaseLocks(locks);
  }
}

/**
 * Performs the empty-authority shortcut allowed by the transport contract.
 * Any task, coordination entity, cache receipt, or migration record forces
 * callers through the journaled migration engine instead.
 */
export async function previewSetTeamTransport(
  input: SetTeamTransportInput,
): Promise<SetTeamTransportPreview> {
  return applyTeamTransportSet(input, false);
}

export async function setTeamTransport(
  input: SetTeamTransportInput,
): Promise<SetTeamTransportPreview> {
  return applyTeamTransportSet(input, true);
}

async function applyTeamTransportSet(
  input: SetTeamTransportInput,
  write: boolean,
): Promise<SetTeamTransportPreview> {
  const operationId = input.operationId ?? createUlid();
  const eventId = createUlid();
  assertUlid(operationId, 'team transport set operationId');
  assertUlid(eventId, 'team transport set eventId');
  assertPositiveRevision(
    input.expectedConfigRevision,
    'team transport config revision',
  );
  if (input.mode !== 'local' && input.mode !== 'git-ref') {
    throw new Error('MANCODE_TRANSPORT_MODE_INVALID');
  }
  const remote = transportRemote(input.mode, input.remote);
  const now = input.now ?? new Date();
  const root = path.resolve(input.projectRoot);
  const runtime = await readProjectRuntimeContext(root);
  const store = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const locks = await acquireEntityLocks(store, operationId, [
    `config:${runtime.workspaceId}`,
    `transport_authority:${runtime.workspaceId}`,
  ]);
  try {
    const project = await new V3ContextStore(root).readProjectSnapshot();
    const session = await requireJoinedActiveSession(root, input.sessionId);
    if (project.config.revision !== input.expectedConfigRevision) {
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    if (project.config.transport.mode === input.mode) {
      throw new Error('MANCODE_TRANSPORT_MODE_UNCHANGED');
    }
    if (project.config.transport.mode === 'git-ref') {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_REQUIRED');
    }
    await assertTransportAuthorityEmpty(root, store);
    const config = parseProjectConfig({
      ...project.config,
      revision: project.config.revision + 1,
      transport: {
        mode: input.mode,
        remote,
        epoch: project.config.transport.epoch + 1,
      },
      lastOperationId: operationId,
      updatedAt: now.toISOString(),
    });
    assertProjectConfigTransition(project.config, config, 'transport_set');
    assertConfigPolicyConsistency(config, project.policy);
    authorizePolicyOrConfigMutation({
      actorId: session.actorId,
      sessionId: session.sessionId,
      config: project.config,
      expectedRevisionMatches: true,
      now,
    });
    let auditProjection: AuditProjectionState | 'not_applicable' =
      'not_applicable';
    if (write) {
      const event: TeamEventV1 = {
        schemaVersion: 1,
        eventId,
        eventType: 'team_transport_set',
        operationId,
        entityRef: { kind: 'transport', id: config.workspaceId },
        taskRef: null,
        actorId: session.actorId,
        taskRevision: null,
        createdAt: now.toISOString(),
      };
      const projection = await enqueueAuditEventProjection(root, event, now);
      try {
        await writeJsonAtomic(projectConfigPath(root), config);
      } catch (error) {
        await supersedeProjectionIntents(root, operationId, now).catch(
          () => undefined,
        );
        throw error;
      }
      auditProjection = await publishAuditEventProjection(
        root,
        event,
        projection,
        now,
      );
    }
    return { config, operationId, eventId, auditProjection };
  } finally {
    await releaseLocks(locks);
  }
}

/**
 * Once the authority CAS has succeeded, the audit event is a replayable
 * projection.  A failed event write must not make callers retry an already
 * committed policy/config revision; doctor can safely finish the durable
 * outbox item later.
 */
async function publishAuditEventProjection(
  projectRoot: string,
  event: TeamEventV1,
  projection: ProjectionIntentV1,
  now: Date,
): Promise<AuditProjectionState> {
  try {
    await writeTeamEvent(projectRoot, event);
  } catch {
    return 'pending';
  }
  try {
    await completeProjectionIntent(
      projectRoot,
      projection.operationId,
      projection.projectionId,
      now,
    );
  } catch {
    return 'pending';
  }
  return 'completed';
}

async function requireJoinedActiveSession(
  projectRoot: string,
  sessionId: Ulid,
): Promise<{ sessionId: Ulid; actorId: Ulid }> {
  const session = await readSession(projectRoot, sessionId);
  if (session === null || session.status !== 'active') {
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  }
  const profile = await readSharedActorProfile(projectRoot, session.actorId);
  if (profile === null) throw new Error('MANCODE_JOIN_REQUIRED');
  return { sessionId: session.sessionId, actorId: session.actorId };
}

function authorizePolicyOrConfigMutation(input: {
  actorId: Ulid;
  sessionId: Ulid;
  config: ProjectConfigV1;
  expectedRevisionMatches: boolean;
  now: Date;
}): void {
  createAuthorizationBasis(
    {
      action: 'team_policy_config_transport',
      actorId: input.actorId,
      session: {
        sessionId: input.sessionId,
        actorId: input.actorId,
        status: 'active',
      },
      joined: true,
      sharedWriteGuard: capabilitiesFromProjectConfig(input.config).writeGuard,
      task: null,
      claim: null,
      handoff: null,
      evidence: null,
      profileActorId: null,
      conditions: {
        expectedRevisionMatches: input.expectedRevisionMatches,
        explicitConfirmation: true,
      },
    },
    input.now,
  );
}

async function assertTransportAuthorityEmpty(
  projectRoot: string,
  store: ReturnType<typeof resolveCoordinationEntityHomeStore>,
): Promise<void> {
  const [claims, handoffs, taskHeads, stagedMigrations, transportViews, cache] =
    await Promise.all([
      listClaims(store),
      listHandoffs(store),
      directoryHasEntries(taskHeadDirectory(store)),
      directoryHasEntries(path.join(store.root, 'transport-migrations')),
      directoryHasEntries(
        path.join(projectRoot, '.mancode', 'shared', 'team', 'transport'),
      ),
      pathExists(gitRefCachePath(projectRoot)),
    ]);
  if (
    claims.length > 0 ||
    handoffs.length > 0 ||
    taskHeads ||
    stagedMigrations ||
    transportViews ||
    cache
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_REQUIRED');
  }
}

function transportRemote(
  mode: CoordinationTransport,
  requested: string | undefined,
): string | null {
  if (mode === 'local') {
    if (requested !== undefined) {
      throw new Error('MANCODE_TRANSPORT_SET_REMOTE_INVALID');
    }
    return null;
  }
  const remote = requested ?? 'origin';
  if (!remote.trim() || remote.includes('\0')) {
    throw new Error('MANCODE_TRANSPORT_REMOTE_REQUIRED');
  }
  return remote;
}

function isTeamRecommendationPolicy(
  value: unknown,
): value is TeamRecommendationPolicy {
  return value === 'on' || value === 'off' || value === 'auto';
}

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`MANCODE_EXPECTED_REVISION_CONFLICT:${label}`);
  }
}

function teamPolicyPath(projectRoot: string): string {
  return path.join(projectRoot, '.mancode', 'shared', 'team', 'policy.json');
}

function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.mancode', 'shared', 'config.json');
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await assertPlainDirectory(path.dirname(target));
  await assertPlainFileOrMissing(target);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${createUlid()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await replaceFileAtomically(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function assertPlainDirectory(target: string): Promise<void> {
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

async function assertPlainFileOrMissing(target: string): Promise<void> {
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function directoryHasEntries(target: string): Promise<boolean> {
  try {
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
    return (await readdir(target)).length > 0;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
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

async function releaseLocks(
  locks: Awaited<ReturnType<typeof acquireEntityLocks>>,
): Promise<void> {
  await Promise.allSettled([...locks].reverse().map((lock) => lock.release()));
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

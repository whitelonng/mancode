import { type Ulid, assertUlid } from '../context/ids.js';
import {
  completeProjectionIntent,
  enqueueAuditEventProjection,
} from '../runtime/projection-outbox.js';
import {
  type LocalActorIdentityV1,
  type SharedActorProfileV1,
  createSharedActorProfile,
  parseLocalActorIdentity,
  publishSharedActorProfile,
} from './actor.js';
import { type TeamEventV1, parseTeamEvent, writeTeamEvent } from './events.js';
import {
  type ProjectConfigV1,
  type TeamPolicyV1,
  assertConfigPolicyConsistency,
  parseProjectConfig,
  parseTeamPolicy,
} from './policy.js';

export interface PrepareTeamJoinInput {
  actor: LocalActorIdentityV1;
  projectConfig: ProjectConfigV1;
  teamPolicy: TeamPolicyV1;
  operationId: Ulid;
  eventId: Ulid;
  confirmed: boolean;
  sync: boolean;
  now?: Date;
}

export interface TeamJoinPlan {
  actor: LocalActorIdentityV1;
  profile: SharedActorProfileV1;
  event: TeamEventV1;
  syncRequested: boolean;
  transport: ProjectConfigV1['transport']['mode'];
  trustBoundary: 'repo-collaborators';
}

export interface TeamJoinSyncPublisher {
  publishActorProfile(input: {
    operationId: Ulid;
    profile: SharedActorProfileV1;
  }): Promise<{ receipt: string }>;
}

export interface JoinTeamInput extends PrepareTeamJoinInput {
  projectRoot: string;
  syncPublisher?: TeamJoinSyncPublisher;
}

export interface TeamJoinResult {
  profile: SharedActorProfileV1;
  event: TeamEventV1;
  syncReceipt: string | null;
  trustBoundary: 'repo-collaborators';
}

/**
 * Freezes the `team join` preflight before any shared file is written. The
 * caller must obtain an explicit confirmation; there is no implicit publish
 * mode or email-derived identity matching.
 */
export function prepareTeamJoin(input: PrepareTeamJoinInput): TeamJoinPlan {
  const actor = parseLocalActorIdentity(input.actor);
  const projectConfig = parseProjectConfig(input.projectConfig);
  const teamPolicy = parseTeamPolicy(input.teamPolicy);
  assertConfigPolicyConsistency(projectConfig, teamPolicy);
  assertUlid(input.operationId, 'team join operationId');
  assertUlid(input.eventId, 'team join eventId');
  if (input.confirmed !== true) {
    throw new Error('MANCODE_JOIN_CONFIRMATION_REQUIRED');
  }
  if (typeof input.sync !== 'boolean') {
    throw new Error('team join sync must be boolean');
  }
  if (input.sync && projectConfig.transport.mode !== 'git-ref') {
    throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  }
  const profile = createSharedActorProfile(actor, input.now);
  const event = parseTeamEvent({
    schemaVersion: 1,
    eventId: input.eventId,
    eventType: 'actor_joined',
    operationId: input.operationId,
    entityRef: { kind: 'actor', id: actor.actorId },
    taskRef: null,
    actorId: actor.actorId,
    taskRevision: null,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
  return {
    actor,
    profile,
    event,
    syncRequested: input.sync,
    transport: projectConfig.transport.mode,
    trustBoundary: 'repo-collaborators',
  };
}

/**
 * Profile publication is authoritative for joining. The audit event is last,
 * so a failure to emit it can be reconciled from this completed join plan and
 * never rolls the profile back. A requested remote publish is explicit.
 */
export async function joinTeam(input: JoinTeamInput): Promise<TeamJoinResult> {
  const plan = prepareTeamJoin(input);
  const projection = await enqueueAuditEventProjection(
    input.projectRoot,
    plan.event,
    input.now,
  );
  const profile = await publishSharedActorProfile(
    input.projectRoot,
    plan.profile,
  );
  let syncReceipt: string | null = null;
  if (plan.syncRequested) {
    if (input.syncPublisher === undefined) {
      throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
    }
    const result = await input.syncPublisher.publishActorProfile({
      operationId: plan.event.operationId,
      profile,
    });
    syncReceipt = parseReceipt(result.receipt);
  }
  const event = await writeTeamEvent(input.projectRoot, plan.event);
  try {
    await completeProjectionIntent(
      input.projectRoot,
      projection.operationId,
      projection.projectionId,
      input.now,
    );
  } catch {
    // The event itself is durable; doctor can close a stale pending intent.
  }
  return { profile, event, syncReceipt, trustBoundary: plan.trustBoundary };
}

function parseReceipt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('MANCODE_TRANSPORT_RECEIPT_INVALID');
  }
  return value;
}

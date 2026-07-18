import { createV3Checkpoint } from '../context/checkpoint-create.js';
import {
  createConfirmedDecision,
  publishConfirmedDecision,
} from '../context/confirmed-decision.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { assertSharedTextSafe } from '../context/privacy.js';
import { V3ContextStore } from '../context/store.js';
import { parseTaskRef } from '../context/task-ref.js';
import { listClaims } from '../runtime/claim-store.js';
import { resolveCoordinationEntityHomeStore } from '../runtime/entity-home-store.js';
import { listHandoffs } from '../runtime/handoff-store.js';
import {
  completeProjectionIntent,
  enqueueAuditEventProjection,
} from '../runtime/projection-outbox.js';
import { detectTeamAssessmentSignals } from '../system/detect-team.js';
import {
  type SharedActorProfileV1,
  createLocalActor,
  readLocalActor,
  readSharedActorProfile,
} from '../team/actor.js';
import { assessTeam } from '../team/assessment.js';
import { createAuthorizationBasis } from '../team/authorization.js';
import { parseCheckpointKind } from '../team/checkpoints.js';
import { acquireV3Claim } from '../team/claim-acquisition.js';
import {
  reclaimV3Claim,
  releaseV3Claim,
  renewV3Claim,
  revalidateV3Claim,
  transferV3Claim,
} from '../team/claim-operation.js';
import { assessClaimConflicts } from '../team/conflicts.js';
import { type TeamEventV1, writeTeamEvent } from '../team/events.js';
import {
  assertGitRefBundleCodeReachable,
  quarantineGitRefTaskBundle,
} from '../team/git-ref-bundle.js';
import {
  capabilitiesFromGitRefCache,
  readGitRefTeamCache,
  writeGitRefTeamCache,
} from '../team/git-ref-cache.js';
import { createGitRefTeamManifestStore } from '../team/git-ref-client.js';
import {
  acceptGitRefHandoffWithRepair,
  recoverGitRefHandoffRepairs,
} from '../team/git-ref-handoff-repair.js';
import { materializeGitRefTaskBundle } from '../team/git-ref-materialization.js';
import {
  acquireGitRefClaim,
  createGitRefHandoffDraft,
  mutateGitRefClaim,
  mutateGitRefHandoff,
  syncGitRefTask,
} from '../team/git-ref-operation.js';
import {
  acceptV3Handoff,
  cancelV3Handoff,
  createV3HandoffDraft,
  offerV3Handoff,
  rejectV3Handoff,
} from '../team/handoff-operation.js';
import { type TeamJoinSyncPublisher, joinTeam } from '../team/join.js';
import {
  previewSetTeamTransport,
  setTeamTransport,
  updateTeamPolicy,
} from '../team/policy-operation.js';
import type { ProjectConfigV1 } from '../team/policy.js';
import { createTransportMigrationFileAdapters } from '../team/transport-migration-adapters.js';
import {
  executeTransportMigration,
  previewTransportMigration,
  recoverTransportMigration,
} from '../team/transport-migration.js';
import { capabilitiesFromProjectConfig } from '../team/transport.js';
import {
  EXIT_V3_INVALID_ARGUMENT,
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  v3ErrorCode,
} from './v3-support.js';

export interface TeamIdentityCreateOptions {
  name?: string;
  json?: boolean;
}

export interface TeamIdentityShowOptions {
  json?: boolean;
}

export interface TeamJoinOptions {
  name?: string;
  session?: string;
  client?: string;
  sync?: boolean;
  json?: boolean;
}

export interface TeamStatusOptions {
  json?: boolean;
}

export interface TeamPolicyOptions {
  policy?: string;
  expectedRevision?: string;
  session?: string;
  client?: string;
  json?: boolean;
}

export interface TeamTransportSetOptions {
  mode?: string;
  remote?: string;
  expectedConfigRevision?: string;
  dryRun?: boolean;
  session?: string;
  client?: string;
  json?: boolean;
}

export interface TeamConflictsOptions {
  task?: string;
  json?: boolean;
}

export interface TeamSyncOptions {
  task?: string;
  expectedTaskRevision?: string;
  session?: string;
  client?: string;
  json?: boolean;
}

export interface TeamTransportMigrateOptions {
  to?: string;
  remote?: string;
  expectedConfigRevision?: string;
  confirm?: boolean;
  dryRun?: boolean;
  session?: string;
  client?: string;
  json?: boolean;
}

export interface TeamTransportRecoverOptions {
  to?: string;
  remote?: string;
  abort?: boolean;
  session?: string;
  client?: string;
  json?: boolean;
}

export interface TeamDecisionPublishOptions {
  title?: string;
  statement?: string;
  task?: string;
  confirm?: boolean;
  session?: string;
  client?: string;
  json?: boolean;
}

export interface TeamCheckpointOptions {
  task?: string;
  expectedTaskRevision?: string;
  kind?: string;
  summary?: string;
  nextAction?: string;
  session?: string;
  client?: string;
  json?: boolean;
}

export interface TeamClaimOptions {
  task?: string;
  expectedTaskRevision?: string;
  paths?: string[];
  modules?: string[];
  apis?: string[];
  schemas?: string[];
  session?: string;
  client?: string;
  sync?: boolean;
  json?: boolean;
}

export interface TeamClaimTransitionOptions {
  claimId?: string;
  expectedRevision?: string;
  ttl?: string;
  to?: string;
  reason?: string;
  session?: string;
  client?: string;
  sync?: boolean;
  json?: boolean;
}

export interface TeamHandoffDraftOptions {
  task?: string;
  expectedTaskRevision?: string;
  to?: string;
  session?: string;
  client?: string;
  sync?: boolean;
  json?: boolean;
}

export interface TeamHandoffTransitionOptions {
  handoffId?: string;
  expectedRevision?: string;
  reason?: string;
  session?: string;
  client?: string;
  sync?: boolean;
  json?: boolean;
}

/** Creates only the local actor identity; it never publishes shared data. */
export async function teamIdentityCreate(
  rootDir: string,
  options: TeamIdentityCreateOptions,
): Promise<number> {
  if (options.name === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_ACTOR_NAME_REQUIRED',
      'team identity create requires --name <displayName>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const actor = await createLocalActor(project.projectRoot, {
      displayName: options.name,
    });
    return printV3Result(options.json, { schemaVersion: 1, actor });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_IDENTITY_CREATE_FAILED'),
      error instanceof Error ? error.message : 'Unable to create identity.',
    );
  }
}

export async function teamClaimRenew(
  rootDir: string,
  options: TeamClaimTransitionOptions,
): Promise<number> {
  const expectedClaimRevision = claimTransitionExpectedRevision(
    options,
    'renew',
  );
  if (expectedClaimRevision === null) return EXIT_V3_INVALID_ARGUMENT;
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    if (requireGitRefSync(project.project.config, options.sync)) {
      const result = await mutateGitRefClaim({
        projectRoot: project.projectRoot,
        claimId: parseClaimId(options.claimId as string),
        sessionId: session.sessionId,
        expectedClaimRevision,
        mutation: {
          kind: 'renew',
          ttlMs: parseClaimTtlDuration(options.ttl),
        },
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        claim: requireClaimResult(result.claims, options.claimId as string),
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
      });
    }
    const result = await renewV3Claim({
      projectRoot: project.projectRoot,
      claimId: parseClaimId(options.claimId as string),
      sessionId: session.sessionId,
      expectedClaimRevision,
      ttlMs: parseClaimTtlDuration(options.ttl),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      claim: result.claim,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_CLAIM_RENEW_FAILED'),
      error instanceof Error ? error.message : 'Unable to renew claim.',
    );
  }
}

export async function teamClaimRelease(
  rootDir: string,
  options: TeamClaimTransitionOptions,
): Promise<number> {
  const expectedClaimRevision = claimTransitionExpectedRevision(
    options,
    'release',
  );
  if (expectedClaimRevision === null) return EXIT_V3_INVALID_ARGUMENT;
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    if (requireGitRefSync(project.project.config, options.sync)) {
      const result = await mutateGitRefClaim({
        projectRoot: project.projectRoot,
        claimId: parseClaimId(options.claimId as string),
        sessionId: session.sessionId,
        expectedClaimRevision,
        mutation: { kind: 'release' },
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        claim: requireClaimResult(result.claims, options.claimId as string),
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
      });
    }
    const result = await releaseV3Claim({
      projectRoot: project.projectRoot,
      claimId: parseClaimId(options.claimId as string),
      sessionId: session.sessionId,
      expectedClaimRevision,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      claim: result.claim,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_CLAIM_RELEASE_FAILED'),
      error instanceof Error ? error.message : 'Unable to release claim.',
    );
  }
}

export async function teamClaimTransfer(
  rootDir: string,
  options: TeamClaimTransitionOptions,
): Promise<number> {
  const expectedClaimRevision = claimTransitionExpectedRevision(
    options,
    'transfer',
  );
  if (expectedClaimRevision === null) return EXIT_V3_INVALID_ARGUMENT;
  if (options.to === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_CLAIM_TRANSFER_TARGET_REQUIRED',
      'team transfer requires --to <actorId>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    if (requireGitRefSync(project.project.config, options.sync)) {
      const claimId = parseClaimId(options.claimId as string);
      const result = await mutateGitRefClaim({
        projectRoot: project.projectRoot,
        claimId,
        sessionId: session.sessionId,
        expectedClaimRevision,
        mutation: {
          kind: 'transfer',
          toActorId: parseActorId(options.to),
        },
      });
      const predecessorClaim = requireClaimResult(result.claims, claimId);
      const successorClaim = result.claims.find(
        (claim) => claim.predecessorClaimId === claimId,
      );
      if (successorClaim === undefined) {
        throw new Error('MANCODE_REMOTE_RECEIPT_MISMATCH');
      }
      return printV3Result(options.json, {
        schemaVersion: 1,
        predecessorClaim,
        successorClaim,
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
      });
    }
    const result = await transferV3Claim({
      projectRoot: project.projectRoot,
      claimId: parseClaimId(options.claimId as string),
      sessionId: session.sessionId,
      expectedClaimRevision,
      toActorId: parseActorId(options.to),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      predecessorClaim: result.predecessorClaim,
      successorClaim: result.successorClaim,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_CLAIM_TRANSFER_FAILED'),
      error instanceof Error ? error.message : 'Unable to transfer claim.',
    );
  }
}

export async function teamClaimReclaim(
  rootDir: string,
  options: TeamClaimTransitionOptions,
): Promise<number> {
  const expectedClaimRevision = claimTransitionExpectedRevision(
    options,
    'reclaim',
  );
  if (expectedClaimRevision === null) return EXIT_V3_INVALID_ARGUMENT;
  if (options.reason === undefined || !options.reason.trim()) {
    return printV3Error(
      options.json,
      'MANCODE_RECLAIM_REASON_REQUIRED',
      'team reclaim requires --reason <text>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    if (requireGitRefSync(project.project.config, options.sync)) {
      const result = await mutateGitRefClaim({
        projectRoot: project.projectRoot,
        claimId: parseClaimId(options.claimId as string),
        sessionId: session.sessionId,
        expectedClaimRevision,
        mutation: { kind: 'reclaim', reason: options.reason },
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        claim: requireClaimResult(result.claims, options.claimId as string),
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
      });
    }
    const result = await reclaimV3Claim({
      projectRoot: project.projectRoot,
      claimId: parseClaimId(options.claimId as string),
      sessionId: session.sessionId,
      expectedClaimRevision,
      reason: options.reason,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      claim: result.claim,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_CLAIM_RECLAIM_FAILED'),
      error instanceof Error ? error.message : 'Unable to reclaim claim.',
    );
  }
}

export async function teamClaimRevalidate(
  rootDir: string,
  options: TeamClaimTransitionOptions,
): Promise<number> {
  const expectedClaimRevision = claimTransitionExpectedRevision(
    options,
    'revalidate',
  );
  if (expectedClaimRevision === null) return EXIT_V3_INVALID_ARGUMENT;
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    if (requireGitRefSync(project.project.config, options.sync)) {
      const result = await mutateGitRefClaim({
        projectRoot: project.projectRoot,
        claimId: parseClaimId(options.claimId as string),
        sessionId: session.sessionId,
        expectedClaimRevision,
        mutation: { kind: 'revalidate' },
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        claim: requireClaimResult(result.claims, options.claimId as string),
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
      });
    }
    const result = await revalidateV3Claim({
      projectRoot: project.projectRoot,
      claimId: parseClaimId(options.claimId as string),
      sessionId: session.sessionId,
      expectedClaimRevision,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      metadata: result.metadata,
      claim: result.claim,
      checkpoint: result.checkpoint,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_CLAIM_REVALIDATE_FAILED'),
      error instanceof Error ? error.message : 'Unable to revalidate claim.',
    );
  }
}

export async function teamIdentityShow(
  rootDir: string,
  options: TeamIdentityShowOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(rootDir);
    const actor = await readLocalActor(project.projectRoot);
    if (actor === null) throw new Error('MANCODE_LOCAL_ACTOR_REQUIRED');
    const sharedProfile = await readSharedActorProfile(
      project.projectRoot,
      actor.actorId,
    );
    return printV3Result(options.json, {
      schemaVersion: 1,
      actor,
      sharedProfile,
      joined: sharedProfile !== null,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_IDENTITY_SHOW_FAILED'),
      error instanceof Error ? error.message : 'Unable to read identity.',
    );
  }
}

/** Publishes one explicit, privacy-safe shared decision as an immutable entity. */
export async function teamDecisionPublish(
  rootDir: string,
  options: TeamDecisionPublishOptions,
): Promise<number> {
  if (options.title === undefined || options.statement === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_CONFIRMED_DECISION_ARGUMENT_INVALID',
      'team decision publish requires --title <text> and --statement <text>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  if (options.confirm !== true) {
    return printV3Error(
      options.json,
      'MANCODE_EXPLICIT_CONFIRMATION_REQUIRED',
      'Publishing shared decisions requires --confirm.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    assertSharedTextSafe(options.title, 'confirmed decision title');
    assertSharedTextSafe(options.statement, 'confirmed decision statement');
    const project = await readV3CommandProject(rootDir);
    const actor = await readLocalActor(project.projectRoot);
    if (actor === null) throw new Error('MANCODE_LOCAL_ACTOR_REQUIRED');
    const session = await resolveV3CommandSession(project, options);
    if (session.actorId !== actor.actorId) {
      throw new Error('MANCODE_SESSION_ACTOR_MISMATCH');
    }
    const joined =
      (await readSharedActorProfile(project.projectRoot, actor.actorId)) !==
      null;
    const capabilities = capabilitiesFromProjectConfig(project.project.config);
    const authorization = createAuthorizationBasis({
      action: 'confirmed_decision_publish',
      actorId: actor.actorId,
      session: {
        sessionId: session.sessionId,
        actorId: session.actorId,
        status: session.status,
      },
      joined,
      sharedWriteGuard: capabilities.writeGuard,
      task: null,
      claim: null,
      handoff: null,
      evidence: null,
      profileActorId: null,
      conditions: {
        confirmedDecisionSharingEnabled:
          project.project.policy.shareConfirmedDecisions,
        privacyConfirmed: true,
        explicitConfirmation: true,
      },
    });
    const operationId = createUlid();
    const decisionTarget = createConfirmedDecision({
      decisionId: createUlid(),
      title: options.title,
      statement: options.statement,
      taskRef: options.task === undefined ? null : parseTaskRef(options.task),
      actorId: actor.actorId,
      operationId,
      authorization,
    });
    const eventTarget: TeamEventV1 = {
      schemaVersion: 1,
      eventId: createUlid(),
      eventType: 'confirmed_decision_published',
      operationId,
      entityRef: { kind: 'decision', id: decisionTarget.decisionId },
      taskRef: null,
      actorId: actor.actorId,
      taskRevision: null,
      createdAt: decisionTarget.confirmedAt,
    };
    const projection = await enqueueAuditEventProjection(
      project.projectRoot,
      eventTarget,
    );
    const decision = await publishConfirmedDecision(
      project.projectRoot,
      decisionTarget,
    );
    const event = await writeTeamEvent(project.projectRoot, eventTarget);
    try {
      await completeProjectionIntent(
        project.projectRoot,
        projection.operationId,
        projection.projectionId,
      );
    } catch {
      // The event is durable; doctor can close a stale pending intent.
    }
    return printV3Result(options.json, {
      schemaVersion: 1,
      decision,
      event,
      trustBoundary: authorization.trustBoundary,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONFIRMED_DECISION_PUBLISH_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to publish the confirmed decision.',
    );
  }
}

/** Publishes the minimal approved actor profile after resolving an active session. */
export async function teamJoin(
  rootDir: string,
  options: TeamJoinOptions,
): Promise<number> {
  if (options.name === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_ACTOR_NAME_REQUIRED',
      'team join requires --name <displayName>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const actor = await readLocalActor(project.projectRoot);
    if (actor === null) throw new Error('MANCODE_LOCAL_ACTOR_REQUIRED');
    if (actor.displayName !== options.name.trim()) {
      throw new Error('MANCODE_LOCAL_ACTOR_NAME_MISMATCH');
    }
    const session = await resolveV3CommandSession(project, options);
    if (session.actorId !== actor.actorId) {
      throw new Error('MANCODE_SESSION_ACTOR_MISMATCH');
    }
    const capabilities = capabilitiesFromProjectConfig(project.project.config);
    createAuthorizationBasis({
      action: 'actor_profile_publish',
      actorId: actor.actorId,
      session: {
        sessionId: session.sessionId,
        actorId: session.actorId,
        status: session.status,
      },
      joined: false,
      sharedWriteGuard: capabilities.writeGuard,
      task: null,
      claim: null,
      handoff: null,
      evidence: null,
      profileActorId: actor.actorId,
      conditions: { explicitConfirmation: true },
    });
    const result = await joinTeam({
      projectRoot: project.projectRoot,
      actor,
      projectConfig: project.project.config,
      teamPolicy: project.project.policy,
      operationId: createUlid(),
      eventId: createUlid(),
      confirmed: true,
      sync: options.sync === true,
      syncPublisher: gitRefProfilePublisher(
        project.projectRoot,
        project.project.config,
        project.project.manifest,
        options.sync === true,
      ),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      ...result,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_JOIN_FAILED'),
      error instanceof Error ? error.message : 'Unable to join team.',
    );
  }
}

function gitRefProfilePublisher(
  projectRoot: string,
  config: ProjectConfigV1,
  manifest: Awaited<
    ReturnType<typeof readV3CommandProject>
  >['project']['manifest'],
  syncRequested: boolean,
): TeamJoinSyncPublisher | undefined {
  const remote = config.transport.remote;
  if (
    !syncRequested ||
    config.transport.mode !== 'git-ref' ||
    remote === null
  ) {
    return undefined;
  }
  const transport = createGitRefTeamManifestStore(
    projectRoot,
    config,
    manifest,
  );
  return {
    async publishActorProfile(input: {
      operationId: Ulid;
      profile: SharedActorProfileV1;
    }) {
      const snapshot = await transport.pull();
      return transport.publishActorProfile({
        ...input,
        expectedRemoteRevision: snapshot.manifest?.revision ?? 0,
      });
    },
  };
}

export async function teamStatus(
  rootDir: string,
  options: TeamStatusOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(rootDir);
    const [actor, assessmentSignals] = await Promise.all([
      readLocalActor(project.projectRoot),
      detectTeamAssessmentSignals(
        project.projectRoot,
        project.project.policy.recentDays,
      ),
    ]);
    const profile =
      actor === null
        ? null
        : await readSharedActorProfile(project.projectRoot, actor.actorId);
    const cache = await readGitRefTeamCache(
      project.projectRoot,
      project.project.config,
    );
    const capabilities =
      project.project.config.transport.mode === 'git-ref'
        ? capabilitiesFromGitRefCache(project.project.config, cache)
        : capabilitiesFromProjectConfig(project.project.config);
    return printV3Result(options.json, {
      schemaVersion: 1,
      workspaceId: project.project.config.workspaceId,
      policy: project.project.policy,
      assessment: assessTeam({
        policy: project.project.policy.policy,
        signals: assessmentSignals,
        evaluatedAt: new Date().toISOString(),
      }),
      transport: project.project.config.transport,
      capabilities,
      remoteSnapshot:
        cache === null
          ? null
          : {
              revision: cache.manifest?.revision ?? 0,
              fetchedAt: cache.fetchedAt,
              receipt: cache.receipt,
            },
      actor,
      joined: profile !== null,
      trustBoundary: 'repo-collaborators',
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_STATUS_FAILED'),
      error instanceof Error ? error.message : 'Unable to read team status.',
    );
  }
}

/** Updates the team recommendation policy through its independent revision CAS. */
export async function teamPolicy(
  rootDir: string,
  options: TeamPolicyOptions,
): Promise<number> {
  const expectedPolicyRevision = parsePositiveInteger(options.expectedRevision);
  if (
    (options.policy !== 'on' &&
      options.policy !== 'off' &&
      options.policy !== 'auto') ||
    expectedPolicyRevision === null
  ) {
    return printV3Error(
      options.json,
      'MANCODE_TEAM_POLICY_ARGUMENT_INVALID',
      'Use: team policy <on|off|auto> --expected-revision <n>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const result = await updateTeamPolicy({
      projectRoot: project.projectRoot,
      sessionId: session.sessionId,
      expectedPolicyRevision,
      policy: options.policy,
    });
    return printV3Result(options.json, { schemaVersion: 1, ...result });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_POLICY_UPDATE_FAILED'),
      error instanceof Error ? error.message : 'Unable to update team policy.',
    );
  }
}

/** Emits only the transport/capability facet of the broader team status. */
export async function teamTransportStatus(
  rootDir: string,
  options: TeamStatusOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(rootDir);
    const cache = await readGitRefTeamCache(
      project.projectRoot,
      project.project.config,
    );
    const capabilities =
      project.project.config.transport.mode === 'git-ref'
        ? capabilitiesFromGitRefCache(project.project.config, cache)
        : capabilitiesFromProjectConfig(project.project.config);
    return printV3Result(options.json, {
      schemaVersion: 1,
      transport: project.project.config.transport,
      capabilities,
      remoteSnapshot:
        cache === null
          ? null
          : {
              revision: cache.manifest?.revision ?? 0,
              fetchedAt: cache.fetchedAt,
              receipt: cache.receipt,
            },
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_TRANSPORT_STATUS_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to read transport status.',
    );
  }
}

/** Uses transport_set solely while no coordination authority has a history. */
export async function teamTransportSet(
  rootDir: string,
  options: TeamTransportSetOptions,
): Promise<number> {
  const expectedConfigRevision = parsePositiveInteger(
    options.expectedConfigRevision,
  );
  if (
    (options.mode !== 'local' && options.mode !== 'git-ref') ||
    expectedConfigRevision === null
  ) {
    return printV3Error(
      options.json,
      'MANCODE_TRANSPORT_SET_ARGUMENT_INVALID',
      'Use: team transport set <local|git-ref> --expected-config-revision <n> [--remote <name>] [--dry-run].',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const input = {
      projectRoot: project.projectRoot,
      sessionId: session.sessionId,
      expectedConfigRevision,
      mode: options.mode,
      ...(options.remote === undefined ? {} : { remote: options.remote }),
    } as const;
    const result =
      options.dryRun === true
        ? await previewSetTeamTransport(input)
        : await setTeamTransport(input);
    return printV3Result(options.json, {
      schemaVersion: 1,
      dryRun: options.dryRun === true,
      ...result,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_TRANSPORT_SET_FAILED'),
      error instanceof Error ? error.message : 'Unable to set transport.',
    );
  }
}

/** Switches coordination authority only through the journaled migration engine. */
export async function teamTransportMigrate(
  rootDir: string,
  options: TeamTransportMigrateOptions,
): Promise<number> {
  const expectedConfigRevision = parsePositiveInteger(
    options.expectedConfigRevision,
  );
  if (options.to === undefined || expectedConfigRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_TRANSPORT_MIGRATION_ARGUMENT_INVALID',
      'Use: team transport migrate --to <local|git-ref> --expected-config-revision <n> --confirm.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  const operationId = createUlid();
  try {
    const targetMode = parseTransportMode(options.to);
    const targetRemote = migrationTargetRemote(targetMode, options.remote);
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const joined =
      (await readSharedActorProfile(project.projectRoot, session.actorId)) !==
      null;
    const adapters = await createTransportMigrationFileAdapters({
      projectRoot: project.projectRoot,
      actorId: session.actorId,
      targetMode,
      targetRemote,
      operationId,
    });
    const input = {
      ...adapters,
      operationId,
      checkoutId: adapters.checkoutId,
      actorId: session.actorId,
      sessionId: session.sessionId,
      expectedConfigRevision,
      joined,
      explicitConfirmation: options.confirm === true,
    };
    if (options.dryRun === true) {
      const preview = await previewTransportMigration(input);
      return printV3Result(options.json, {
        schemaVersion: 1,
        dryRun: true,
        operationId,
        source: preview.manifest.source,
        target: preview.manifest.target,
        manifestDigest: preview.manifestDigest,
        taskCount: preview.manifest.tasks.length,
        activeClaimCount: preview.manifest.sourceClaims.filter(
          (claim) => claim.state === 'active',
        ).length,
      });
    }
    const result = await executeTransportMigration(input);
    return printV3Result(options.json, {
      schemaVersion: 1,
      dryRun: false,
      operationId,
      manifestDigest: result.manifestDigest,
      source: result.manifest.source,
      target: result.manifest.target,
      config: result.activatedConfig,
      authority: result.established,
      operation: result.journal,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to migrate transport.';
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TRANSPORT_MIGRATION_FAILED'),
      `${message} (operationId: ${operationId})`,
    );
  }
}

/** Recovers a durable transport migration using its original actor/session. */
export async function teamTransportRecover(
  rootDir: string,
  operationIdValue: string | undefined,
  options: TeamTransportRecoverOptions,
): Promise<number> {
  if (operationIdValue === undefined || options.to === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_TRANSPORT_MIGRATION_RECOVERY_ARGUMENT_INVALID',
      'Use: team transport recover <operationId> --to <local|git-ref>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    assertUlid(operationIdValue, 'transport migration operationId');
    const targetMode = parseTransportMode(options.to);
    const targetRemote = migrationTargetRemote(targetMode, options.remote);
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const adapters = await createTransportMigrationFileAdapters({
      projectRoot: project.projectRoot,
      actorId: session.actorId,
      targetMode,
      targetRemote,
      operationId: operationIdValue,
    });
    const result = await recoverTransportMigration({
      ...adapters,
      operationId: operationIdValue,
      actorId: session.actorId,
      sessionId: session.sessionId,
      mode: options.abort === true ? 'abort' : 'forward',
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      operationId: operationIdValue,
      result,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TRANSPORT_MIGRATION_RECOVERY_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to recover transport migration.',
    );
  }
}

/** Explicitly refreshes the validated remote snapshot; no other read path fetches. */
export async function teamSyncPull(
  rootDir: string,
  options: TeamSyncOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(rootDir);
    const requestedTask =
      options.task === undefined ? null : parseTaskRef(options.task);
    if (requestedTask?.namespace === 'local') {
      throw new Error('MANCODE_CLAIM_REQUIRES_SHARED_TASK');
    }
    const previousCache = await readGitRefTeamCache(
      project.projectRoot,
      project.project.config,
    );
    const transport = createGitRefTeamManifestStore(
      project.projectRoot,
      project.project.config,
      project.project.manifest,
    );
    const snapshot = await transport.pull();
    const manifest = snapshot.manifest;
    const selectedBundles = filterRemoteTask(
      manifest?.taskBundles ?? [],
      requestedTask,
    );
    const materializedBundles = [];
    for (const bundle of selectedBundles) {
      const ownershipFence = manifest?.ownershipFences.find(
        (candidate) => candidate.taskRef.taskId === bundle.taskRef.taskId,
      );
      if (ownershipFence === undefined || manifest === null) {
        throw new Error('MANCODE_REMOTE_OWNERSHIP_FENCE_MISSING');
      }
      const quarantinePath = await quarantineGitRefTaskBundle(
        project.projectRoot,
        manifest.revision,
        bundle,
      );
      let codeReachable = true;
      try {
        await assertGitRefBundleCodeReachable(project.projectRoot, bundle);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'MANCODE_TASK_BUNDLE_CODE_UNREACHABLE'
        ) {
          throw error;
        }
        codeReachable = false;
      }
      if (!codeReachable) {
        materializedBundles.push({
          taskRef: bundle.taskRef,
          quarantinePath,
          codeReachable: false,
          status: 'quarantined',
          taskRevision: bundle.taskRevision,
          aggregateDigest: bundle.aggregateDigest,
        });
        continue;
      }
      const previousBundle = previousCache?.manifest?.taskBundles.find(
        (candidate) => candidate.taskRef.taskId === bundle.taskRef.taskId,
      );
      const materialized = await materializeGitRefTaskBundle({
        projectRoot: project.projectRoot,
        remoteRevision: manifest.revision,
        ownershipFence,
        bundle,
        predecessorBundle: previousBundle ?? null,
      });
      materializedBundles.push({
        taskRef: bundle.taskRef,
        quarantinePath,
        codeReachable: true,
        ...materialized,
      });
    }
    const cache = await writeGitRefTeamCache(
      project.projectRoot,
      project.project.config,
      snapshot,
    );
    const cachedManifest = cache.manifest;
    return printV3Result(options.json, {
      schemaVersion: 1,
      remoteRevision: cachedManifest?.revision ?? 0,
      receipt: cache.receipt,
      fetchedAt: cache.fetchedAt,
      authorityState: cachedManifest?.authorityState ?? 'active',
      ownershipFences: filterRemoteTask(
        cachedManifest?.ownershipFences ?? [],
        requestedTask,
      ),
      claims: filterRemoteTask(cachedManifest?.claims ?? [], requestedTask),
      handoffs: filterRemoteTask(cachedManifest?.handoffs ?? [], requestedTask),
      taskBundles: filterRemoteTask(
        cachedManifest?.taskBundles ?? [],
        requestedTask,
      ).map((bundle) => ({
        taskRef: bundle.taskRef,
        taskRevision: bundle.aggregate.taskRevision,
        aggregateDigest: bundle.aggregateDigest,
        codeRef: bundle.codeRef,
      })),
      materializedBundles,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_SYNC_PULL_FAILED'),
      error instanceof Error ? error.message : 'Unable to pull team state.',
    );
  }
}

/** Publishes one current task bundle through a fresh remote fence CAS. */
export async function teamSyncPush(
  rootDir: string,
  options: TeamSyncOptions,
): Promise<number> {
  if (
    options.task === undefined ||
    options.expectedTaskRevision === undefined
  ) {
    return printV3Error(
      options.json,
      'MANCODE_TEAM_SYNC_PUSH_ARGUMENT_INVALID',
      'Use: team sync push <shared:ULID> --expected-task-revision <n>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  const expectedTaskRevision = parsePositiveInteger(
    options.expectedTaskRevision,
  );
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Sync push requires --expected-task-revision <positive integer>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const taskRef = parseTaskRef(options.task);
    if (taskRef.namespace !== 'shared') {
      throw new Error('MANCODE_REMOTE_COORDINATION_REQUIRES_SHARED_TASK');
    }
    const session = await resolveV3CommandSession(project, options);
    const result = await syncGitRefTask({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef,
      taskRevision: result.bundle.taskRevision,
      aggregateDigest: result.bundle.aggregateDigest,
      changed: result.changed,
      remoteRevision: result.remoteRevision,
      ownershipEpoch: result.ownershipEpoch,
      receipt: result.receipt,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_SYNC_PUSH_FAILED'),
      error instanceof Error ? error.message : 'Unable to push team state.',
    );
  }
}

function filterRemoteTask<T extends { taskRef: { taskId: string } }>(
  values: readonly T[],
  taskRef: ReturnType<typeof parseTaskRef> | null,
): T[] {
  return taskRef === null
    ? [...values]
    : values.filter((value) => value.taskRef.taskId === taskRef.taskId);
}

/** Reports the current local coordination view without claiming remote freshness. */
export async function teamConflicts(
  rootDir: string,
  options: TeamConflictsOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(rootDir);
    const taskRef =
      options.task === undefined ? undefined : parseTaskRef(options.task);
    if (taskRef?.namespace === 'local') {
      throw new Error('MANCODE_CLAIM_REQUIRES_SHARED_TASK');
    }
    const cache = await readGitRefTeamCache(
      project.projectRoot,
      project.project.config,
    );
    const gitRef = project.project.config.transport.mode === 'git-ref';
    const capabilities = gitRef
      ? capabilitiesFromGitRefCache(project.project.config, cache)
      : capabilitiesFromProjectConfig(project.project.config);
    const [claims, handoffs] = gitRef
      ? ([
          (cache?.manifest?.claims ?? []).filter(
            (claim) =>
              taskRef === undefined || claim.taskRef.taskId === taskRef.taskId,
          ),
          (cache?.manifest?.handoffs ?? []).filter(
            (handoff) =>
              taskRef === undefined ||
              handoff.taskRef.taskId === taskRef.taskId,
          ),
        ] as const)
      : await readLocalCoordination(project, taskRef);
    const transportFreshness =
      capabilities.transport === 'local'
        ? 'fresh'
        : capabilities.transportFreshness;
    return printV3Result(options.json, {
      schemaVersion: 1,
      ...(taskRef === undefined ? {} : { taskRef }),
      capabilities,
      claims: claims.map((claim) => ({
        claim,
        conflict: assessClaimConflicts(
          claim.scope,
          claims.filter((candidate) => candidate.claimId !== claim.claimId),
          {
            transportFreshness,
            claimAcquisition: capabilities.claimAcquisition,
          },
        ),
      })),
      handoffs,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_CONFLICTS_FAILED'),
      error instanceof Error ? error.message : 'Unable to inspect conflicts.',
    );
  }
}

async function readLocalCoordination(
  project: Awaited<ReturnType<typeof readV3CommandProject>>,
  taskRef: ReturnType<typeof parseTaskRef> | undefined,
) {
  const homeStore = resolveCoordinationEntityHomeStore(
    project.runtime.entityHomeStoreContext,
  );
  return Promise.all([
    listClaims(homeStore, taskRef),
    listHandoffs(homeStore, taskRef),
  ]);
}

/** Creates a shared immutable checkpoint through the canonical task journal. */
export async function teamCheckpoint(
  rootDir: string,
  options: TeamCheckpointOptions,
): Promise<number> {
  if (
    options.task === undefined ||
    options.expectedTaskRevision === undefined ||
    options.kind === undefined ||
    options.summary === undefined
  ) {
    return printV3Error(
      options.json,
      'MANCODE_CHECKPOINT_ARGUMENT_INVALID',
      'Use: team checkpoint <shared:ULID> --expected-task-revision <n> --kind <kind> --summary <text>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  const expectedTaskRevision = parsePositiveInteger(
    options.expectedTaskRevision,
  );
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Checkpoint creation requires --expected-task-revision <positive integer>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const taskRef = parseTaskRef(options.task);
    if (taskRef.namespace !== 'shared') {
      throw new Error('MANCODE_TEAM_CHECKPOINT_REQUIRES_SHARED_TASK');
    }
    const session = await resolveV3CommandSession(project, options);
    const result = await createV3Checkpoint({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
      kind: parseCheckpointKind(options.kind),
      summary: options.summary,
      nextAction: options.nextAction,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef,
      checkpoint: result.checkpoint,
      metadata: result.metadata,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_CHECKPOINT_FAILED'),
      error instanceof Error ? error.message : 'Unable to create checkpoint.',
    );
  }
}

/** Acquires a scoped claim through the common-dir task and claim locks. */
export async function teamClaim(
  rootDir: string,
  options: TeamClaimOptions,
): Promise<number> {
  if (
    options.task === undefined ||
    options.expectedTaskRevision === undefined
  ) {
    return printV3Error(
      options.json,
      'MANCODE_CLAIM_ARGUMENT_INVALID',
      'Use: team claim <shared:ULID> --expected-task-revision <n> --path <glob> or --module <name>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  const expectedTaskRevision = parsePositiveInteger(
    options.expectedTaskRevision,
  );
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Claim acquisition requires --expected-task-revision <positive integer>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const taskRef = parseTaskRef(options.task);
    if (taskRef.namespace !== 'shared') {
      throw new Error('MANCODE_CLAIM_REQUIRES_SHARED_TASK');
    }
    const session = await resolveV3CommandSession(project, options);
    const scope = {
      paths: options.paths ?? [],
      modules: options.modules ?? [],
      apis: options.apis ?? [],
      schemas: options.schemas ?? [],
    };
    if (requireGitRefSync(project.project.config, options.sync)) {
      const result = await acquireGitRefClaim({
        projectRoot: project.projectRoot,
        taskRef,
        sessionId: session.sessionId,
        expectedTaskRevision,
        scope,
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        taskRef,
        claim: result.claim,
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
      });
    }
    const result = await acquireV3Claim({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
      scope,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef,
      claim: result.claim,
      conflict: result.conflict,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_CLAIM_FAILED'),
      error instanceof Error ? error.message : 'Unable to acquire claim.',
    );
  }
}

/** Creates a checkpoint-backed, named handoff draft for a shared team task. */
export async function teamHandoffDraft(
  rootDir: string,
  options: TeamHandoffDraftOptions,
): Promise<number> {
  if (
    options.task === undefined ||
    options.expectedTaskRevision === undefined ||
    options.to === undefined
  ) {
    return printV3Error(
      options.json,
      'MANCODE_HANDOFF_DRAFT_ARGUMENT_INVALID',
      'Use: team handoff draft <shared:ULID> --expected-task-revision <n> --to <actorId>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  const expectedTaskRevision = parsePositiveInteger(
    options.expectedTaskRevision,
  );
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Handoff draft requires --expected-task-revision <positive integer>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const taskRef = parseTaskRef(options.task);
    if (taskRef.namespace !== 'shared') {
      throw new Error('MANCODE_HANDOFF_REQUIRES_SHARED_TASK');
    }
    const session = await resolveV3CommandSession(project, options);
    if (requireGitRefSync(project.project.config, options.sync)) {
      let task = await new V3ContextStore(project.projectRoot).readTaskSnapshot(
        taskRef,
      );
      let checkpoint = task.latestCheckpoint;
      if (
        checkpoint === null ||
        checkpoint.kind !== 'handoff_offered' ||
        task.metadata.revision !== expectedTaskRevision
      ) {
        const created = await createV3Checkpoint({
          projectRoot: project.projectRoot,
          taskRef,
          sessionId: session.sessionId,
          expectedTaskRevision,
          kind: 'handoff_offered',
          summary:
            'Created an immutable checkpoint before offering task ownership.',
          nextAction: 'Review the checkpoint and continue the assigned task.',
        });
        checkpoint = created.checkpoint;
        task = await new V3ContextStore(project.projectRoot).readTaskSnapshot(
          taskRef,
        );
      }
      const publication = await syncGitRefTask({
        projectRoot: project.projectRoot,
        taskRef,
        sessionId: session.sessionId,
        expectedTaskRevision: task.metadata.revision,
      });
      const result = await createGitRefHandoffDraft({
        projectRoot: project.projectRoot,
        taskRef,
        sessionId: session.sessionId,
        expectedTaskRevision: task.metadata.revision,
        toActorId: parseActorId(options.to),
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        taskRef,
        checkpoint,
        handoff: result.handoff,
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
        bundleReceipt: publication.receipt,
      });
    }
    const result = await createV3HandoffDraft({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
      toActorId: parseActorId(options.to),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef,
      checkpoint: result.checkpoint,
      checkpointOperation: result.checkpointOperation,
      handoff: result.handoff,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_HANDOFF_DRAFT_FAILED'),
      error instanceof Error ? error.message : 'Unable to draft handoff.',
    );
  }
}

export async function teamHandoffOffer(
  rootDir: string,
  options: TeamHandoffTransitionOptions,
): Promise<number> {
  return runHandoffTransition(rootDir, options, 'offer');
}

export async function teamHandoffAccept(
  rootDir: string,
  options: TeamHandoffTransitionOptions,
): Promise<number> {
  if (!hasHandoffArguments(options)) {
    return handoffArgumentError(options, 'accept');
  }
  const expectedHandoffRevision = parsePositiveInteger(
    options.expectedRevision as string,
  );
  if (expectedHandoffRevision === null) {
    return handoffExpectedRevisionError(options);
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    if (requireGitRefSync(project.project.config, options.sync)) {
      await recoverGitRefHandoffRepairs(project.projectRoot);
      const result = await acceptGitRefHandoffWithRepair({
        projectRoot: project.projectRoot,
        handoffId: parseHandoffId(options.handoffId as string),
        sessionId: session.sessionId,
        expectedHandoffRevision,
      });
      const task = await new V3ContextStore(
        project.projectRoot,
      ).readTaskSnapshot(result.handoff.taskRef);
      const predecessorIds = new Set(result.forwardRepair.predecessorClaimIds);
      const successorIds = new Set(result.forwardRepair.successorClaimIds);
      return printV3Result(options.json, {
        schemaVersion: 1,
        taskRef: result.handoff.taskRef,
        metadata: task.metadata,
        handoff: result.handoff,
        predecessorClaims: result.claims.filter((claim) =>
          predecessorIds.has(claim.claimId),
        ),
        successorClaims: result.claims.filter((claim) =>
          successorIds.has(claim.claimId),
        ),
        aggregate: task.aggregate,
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
        forwardRepair: result.forwardRepair,
      });
    }
    const result = await acceptV3Handoff({
      projectRoot: project.projectRoot,
      handoffId: parseHandoffId(options.handoffId as string),
      sessionId: session.sessionId,
      expectedHandoffRevision,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      handoff: result.handoff,
      predecessorClaims: result.predecessorClaims,
      successorClaims: result.successorClaims,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_TEAM_HANDOFF_ACCEPT_FAILED'),
      error instanceof Error ? error.message : 'Unable to accept handoff.',
    );
  }
}

export async function teamHandoffReject(
  rootDir: string,
  options: TeamHandoffTransitionOptions,
): Promise<number> {
  if (options.reason === undefined || !options.reason.trim()) {
    return printV3Error(
      options.json,
      'MANCODE_HANDOFF_REJECTION_REASON_REQUIRED',
      'team handoff reject requires --reason <text>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  return runHandoffTransition(rootDir, options, 'reject');
}

export async function teamHandoffCancel(
  rootDir: string,
  options: TeamHandoffTransitionOptions,
): Promise<number> {
  return runHandoffTransition(rootDir, options, 'cancel');
}

async function runHandoffTransition(
  rootDir: string,
  options: TeamHandoffTransitionOptions,
  intent: 'offer' | 'reject' | 'cancel',
): Promise<number> {
  if (!hasHandoffArguments(options)) {
    return handoffArgumentError(options, intent);
  }
  const expectedHandoffRevision = parsePositiveInteger(
    options.expectedRevision as string,
  );
  if (expectedHandoffRevision === null) {
    return handoffExpectedRevisionError(options);
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    if (requireGitRefSync(project.project.config, options.sync)) {
      const result = await mutateGitRefHandoff({
        projectRoot: project.projectRoot,
        handoffId: parseHandoffId(options.handoffId as string),
        sessionId: session.sessionId,
        expectedHandoffRevision,
        mutation:
          intent === 'reject'
            ? { kind: 'reject', reason: options.reason as string }
            : { kind: intent, reason: options.reason },
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        taskRef: result.handoff.taskRef,
        handoff: result.handoff,
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
      });
    }
    const input = {
      projectRoot: project.projectRoot,
      handoffId: parseHandoffId(options.handoffId as string),
      sessionId: session.sessionId,
      expectedHandoffRevision,
      reason: options.reason,
    };
    const result =
      intent === 'offer'
        ? await offerV3Handoff(input)
        : intent === 'reject'
          ? await rejectV3Handoff(input)
          : await cancelV3Handoff(input);
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.handoff.taskRef,
      handoff: result.handoff,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, `MANCODE_TEAM_HANDOFF_${intent.toUpperCase()}_FAILED`),
      error instanceof Error ? error.message : `Unable to ${intent} handoff.`,
    );
  }
}

function hasHandoffArguments(
  options: TeamHandoffTransitionOptions,
): options is TeamHandoffTransitionOptions & {
  handoffId: string;
  expectedRevision: string;
} {
  return (
    options.handoffId !== undefined && options.expectedRevision !== undefined
  );
}

function handoffArgumentError(
  options: TeamHandoffTransitionOptions,
  action: 'offer' | 'accept' | 'reject' | 'cancel',
): number {
  return printV3Error(
    options.json,
    'MANCODE_HANDOFF_ARGUMENT_INVALID',
    `Use: team handoff ${action} <handoffId> --expected-revision <n>.`,
    EXIT_V3_INVALID_ARGUMENT,
  );
}

function handoffExpectedRevisionError(
  options: TeamHandoffTransitionOptions,
): number {
  return printV3Error(
    options.json,
    'MANCODE_EXPECTED_REVISION_REQUIRED',
    'Handoff transition requires --expected-revision <positive integer>.',
    EXIT_V3_INVALID_ARGUMENT,
  );
}

function requireGitRefSync(
  config: ProjectConfigV1,
  sync: boolean | undefined,
): boolean {
  if (config.transport.mode === 'git-ref') {
    if (sync !== true) throw new Error('MANCODE_EXPLICIT_SYNC_REQUIRED');
    return true;
  }
  if (sync === true) throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  return false;
}

function requireClaimResult<T extends { claimId: string }>(
  claims: readonly T[],
  claimId: string,
): T {
  const claim = claims.find((candidate) => candidate.claimId === claimId);
  if (claim === undefined) throw new Error('MANCODE_REMOTE_RECEIPT_MISMATCH');
  return claim;
}

function claimTransitionExpectedRevision(
  options: TeamClaimTransitionOptions,
  action: 'renew' | 'release' | 'transfer' | 'reclaim' | 'revalidate',
): number | null {
  if (options.claimId === undefined || options.expectedRevision === undefined) {
    printV3Error(
      options.json,
      'MANCODE_CLAIM_ARGUMENT_INVALID',
      `Use: team ${action} <claimId> --expected-revision <n>.`,
      EXIT_V3_INVALID_ARGUMENT,
    );
    return null;
  }
  const expectedRevision = parsePositiveInteger(options.expectedRevision);
  if (expectedRevision === null) {
    printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Claim mutation requires --expected-revision <positive integer>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  return expectedRevision;
}

function parseClaimId(value: string): Ulid {
  return parseUlidArgument(value, 'MANCODE_CLAIM_ID_INVALID');
}

function parseClaimTtlDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(?<amount>[1-9][0-9]*)(?<unit>ms|s|m|h|d)$/.exec(value);
  if (match?.groups === undefined) {
    throw new Error('MANCODE_CLAIM_TTL_INVALID');
  }
  const rawAmount = match.groups.amount;
  const unit = match.groups.unit;
  if (rawAmount === undefined || unit === undefined) {
    throw new Error('MANCODE_CLAIM_TTL_INVALID');
  }
  const amount = Number(rawAmount);
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const multiplier = multipliers[unit];
  if (
    multiplier === undefined ||
    !Number.isSafeInteger(amount) ||
    amount > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
  ) {
    throw new Error('MANCODE_CLAIM_TTL_INVALID');
  }
  return amount * multiplier;
}

function parseActorId(value: string): Ulid {
  return parseUlidArgument(value, 'MANCODE_ACTOR_ID_INVALID');
}

function parseHandoffId(value: string): Ulid {
  return parseUlidArgument(value, 'MANCODE_HANDOFF_ID_INVALID');
}

function parseUlidArgument(value: string, errorCode: string): Ulid {
  try {
    assertUlid(value, 'value');
    return value;
  } catch {
    throw new Error(errorCode);
  }
}

function parseTransportMode(
  value: string,
): ProjectConfigV1['transport']['mode'] {
  if (value !== 'local' && value !== 'git-ref') {
    throw new Error('MANCODE_TRANSPORT_MODE_INVALID');
  }
  return value;
}

function migrationTargetRemote(
  mode: ProjectConfigV1['transport']['mode'],
  remote: string | undefined,
): string | null {
  if (mode === 'local') {
    if (remote !== undefined) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_REMOTE_INVALID');
    }
    return null;
  }
  return remote ?? 'origin';
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

import {
  digestCanonicalJson,
  sortUtf8StringSet,
} from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertSharedTextSafe } from '../context/privacy.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { type CapabilityLevel, parseCapabilityLevel } from './capabilities.js';

export const TEAM_TRUST_BOUNDARY = 'repo-collaborators' as const;

export type AuthorizationAction =
  | 'local_workflow_mutation'
  | 'shared_create_publish_promote'
  | 'shared_metadata_plan_mutation'
  | 'shared_ledger_evidence'
  | 'task_head_reconcile'
  | 'task_complete_scope_change_child_merge'
  | 'claim_create'
  | 'claim_renew_release_transfer'
  | 'claim_reclaim'
  | 'handoff_offer_cancel'
  | 'handoff_accept_reject'
  | 'review_skip_or_waiver'
  | 'team_policy_config_transport'
  | 'actor_profile_publish'
  | 'confirmed_decision_publish';

export interface AuthorizationSession {
  sessionId: Ulid | null;
  actorId: Ulid | null;
  status: 'active' | 'closed' | 'missing';
}

export interface AuthorizationTaskContext {
  ownerActorId: Ulid | null;
  participantActorIds: Ulid[];
}

export interface AuthorizationClaimContext {
  ownerActorId: Ulid;
  transferTargetActorId: Ulid | null;
}

export interface AuthorizationHandoffContext {
  fromActorId: Ulid;
  toActorId: Ulid;
  intent: 'offer' | 'cancel' | 'accept' | 'reject';
}

export interface AuthorizationEvidenceContext {
  assignedToActor: boolean;
  restrictsWriteToAssignedItem: boolean;
}

/**
 * Action-independent checks are optional in the request but are never
 * defaulted to success. A missing proof is treated as false for the relevant
 * authorization rule.
 */
export interface AuthorizationConditions {
  expectedRevisionMatches?: boolean;
  ownershipEpochFresh?: boolean;
  privacyConfirmed?: boolean;
  explicitConfirmation?: boolean;
  confirmedDecisionSharingEnabled?: boolean;
  taskContextAvailable?: boolean;
  transportFresh?: boolean;
  gitSourceConfirmed?: boolean;
  completionGateSatisfied?: boolean;
  claimHandoffConsistent?: boolean;
  implementationScopeContainsClaim?: boolean;
  coordinationStoreFresh?: boolean;
  requiresParentOwner?: boolean;
  parentOwnerActorId?: Ulid | null;
  reviewAction?: 'skip' | 'waiver';
  reviewSeverity?: 'p0' | 'p1' | 'p2' | 'legacy_unknown';
  reason?: string | null;
}

export interface AuthorizationRequest {
  action: AuthorizationAction;
  actorId: Ulid;
  session: AuthorizationSession;
  joined: boolean;
  sharedWriteGuard: CapabilityLevel;
  task: AuthorizationTaskContext | null;
  claim: AuthorizationClaimContext | null;
  handoff: AuthorizationHandoffContext | null;
  evidence: AuthorizationEvidenceContext | null;
  profileActorId: Ulid | null;
  conditions?: AuthorizationConditions;
}

export type AuthorizationFailureCode =
  | 'MANCODE_SESSION_REQUIRED'
  | 'MANCODE_SESSION_ACTOR_MISMATCH'
  | 'MANCODE_JOIN_REQUIRED'
  | 'MANCODE_SHARED_WRITE_UNAVAILABLE'
  | 'MANCODE_EXPECTED_REVISION_CONFLICT'
  | 'MANCODE_OWNERSHIP_EPOCH_STALE'
  | 'MANCODE_PRIVACY_CONFIRMATION_REQUIRED'
  | 'MANCODE_TASK_OWNER_REQUIRED'
  | 'MANCODE_PARTICIPANT_REQUIRED'
  | 'MANCODE_CLAIM_OWNER_REQUIRED'
  | 'MANCODE_SCOPE_OUTSIDE_IMPLEMENTATION_SCOPE'
  | 'MANCODE_RECLAIM_REASON_REQUIRED'
  | 'MANCODE_STORE_NOT_FRESH'
  | 'MANCODE_HANDOFF_ACTOR_MISMATCH'
  | 'MANCODE_HANDOFF_RECIPIENT_NOT_PARTICIPANT'
  | 'MANCODE_TASK_UNAVAILABLE'
  | 'MANCODE_TRANSPORT_UNAVAILABLE'
  | 'MANCODE_COMPLETION_GATE_BLOCKED'
  | 'MANCODE_PARENT_OWNER_REQUIRED'
  | 'MANCODE_GIT_SOURCE_CONFIRMATION_REQUIRED'
  | 'MANCODE_CLAIM_HANDOFF_INCONSISTENT'
  | 'MANCODE_LEDGER_ASSIGNMENT_REQUIRED'
  | 'MANCODE_LEDGER_SCOPE_MUTATION_DENIED'
  | 'MANCODE_WAIVER_FORBIDDEN'
  | 'MANCODE_EXPLICIT_CONFIRMATION_REQUIRED'
  | 'MANCODE_PROFILE_OWNER_REQUIRED'
  | 'MANCODE_CONFIRMED_DECISIONS_DISABLED';

export interface AuthorizationDecision {
  allowed: boolean;
  failures: AuthorizationFailureCode[];
  trustBoundary: typeof TEAM_TRUST_BOUNDARY;
}

export interface AuthorizationMatrixEntry {
  action: AuthorizationAction;
  actorRule: string;
  requiredGuards: string[];
}

export interface AuthorizationBasisV1 {
  schemaVersion: 1;
  action: AuthorizationAction;
  actorId: Ulid;
  sessionId: Ulid;
  trustBoundary: typeof TEAM_TRUST_BOUNDARY;
  decisionDigest: string;
  authorizedAt: string;
}

const AUTHORIZATION_ACTIONS = new Set<AuthorizationAction>([
  'local_workflow_mutation',
  'shared_create_publish_promote',
  'shared_metadata_plan_mutation',
  'shared_ledger_evidence',
  'task_head_reconcile',
  'task_complete_scope_change_child_merge',
  'claim_create',
  'claim_renew_release_transfer',
  'claim_reclaim',
  'handoff_offer_cancel',
  'handoff_accept_reject',
  'review_skip_or_waiver',
  'team_policy_config_transport',
  'actor_profile_publish',
  'confirmed_decision_publish',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** The executable counterpart of the plan's cooperative authorization table. */
export const AUTHORIZATION_MATRIX: readonly AuthorizationMatrixEntry[] = [
  {
    action: 'local_workflow_mutation',
    actorRule: 'current active session actor',
    requiredGuards: ['expected revision'],
  },
  {
    action: 'shared_create_publish_promote',
    actorRule: 'source owner or new task creator',
    requiredGuards: ['joined', 'privacy confirmation', 'shared write guard'],
  },
  {
    action: 'shared_metadata_plan_mutation',
    actorRule: 'current task owner',
    requiredGuards: ['expected revision', 'fresh ownership epoch'],
  },
  {
    action: 'shared_ledger_evidence',
    actorRule: 'task owner or assigned participant',
    requiredGuards: ['assigned item only', 'fresh ownership epoch'],
  },
  {
    action: 'task_head_reconcile',
    actorRule: 'current task owner',
    requiredGuards: ['expected fence revision', 'Git source confirmation'],
  },
  {
    action: 'task_complete_scope_change_child_merge',
    actorRule: 'current task owner',
    requiredGuards: ['completion gate', 'fresh ownership epoch'],
  },
  {
    action: 'claim_create',
    actorRule: 'task owner or participant',
    requiredGuards: ['implementation scope subset'],
  },
  {
    action: 'claim_renew_release_transfer',
    actorRule: 'current claim owner',
    requiredGuards: ['expected claim revision', 'participant transfer target'],
  },
  {
    action: 'claim_reclaim',
    actorRule: 'current task owner',
    requiredGuards: ['fresh store', 'reason', 'expected revision'],
  },
  {
    action: 'handoff_offer_cancel',
    actorRule: 'from actor; task owner may cancel',
    requiredGuards: ['named participant recipient'],
  },
  {
    action: 'handoff_accept_reject',
    actorRule: 'handoff recipient only',
    requiredGuards: ['available task context', 'fresh transport'],
  },
  {
    action: 'review_skip_or_waiver',
    actorRule: 'current task owner',
    requiredGuards: ['reason', 'P0/legacy_unknown waiver prohibition'],
  },
  {
    action: 'team_policy_config_transport',
    actorRule: 'joined actor',
    requiredGuards: ['expected revision', 'explicit confirmation'],
  },
  {
    action: 'actor_profile_publish',
    actorRule: 'matching local actor',
    requiredGuards: ['explicit confirmation'],
  },
  {
    action: 'confirmed_decision_publish',
    actorRule: 'joined actor',
    requiredGuards: [
      'confirmed-decision sharing enabled',
      'privacy confirmation',
      'explicit confirmation',
    ],
  },
];

export function evaluateAuthorization(
  input: AuthorizationRequest,
): AuthorizationDecision {
  validateRequest(input);
  const failures: AuthorizationFailureCode[] = [];
  requireActiveSession(input, failures);
  if (input.action !== 'local_workflow_mutation') {
    if (input.action !== 'actor_profile_publish' && !input.joined) {
      failures.push('MANCODE_JOIN_REQUIRED');
    }
    if (input.sharedWriteGuard === 'unavailable') {
      failures.push('MANCODE_SHARED_WRITE_UNAVAILABLE');
    }
  }

  switch (input.action) {
    case 'local_workflow_mutation':
      requireExpectedRevision(input, failures);
      break;
    case 'shared_create_publish_promote':
      requireExpectedRevision(input, failures);
      requireCondition(
        input,
        'privacyConfirmed',
        'MANCODE_PRIVACY_CONFIRMATION_REQUIRED',
        failures,
      );
      if (input.task !== null && input.task.ownerActorId !== input.actorId) {
        failures.push('MANCODE_TASK_OWNER_REQUIRED');
      }
      break;
    case 'shared_metadata_plan_mutation':
      requireTaskOwner(input, failures);
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      break;
    case 'shared_ledger_evidence':
      requireTask(input, failures);
      if (
        input.task !== null &&
        input.task.ownerActorId !== input.actorId &&
        input.evidence?.assignedToActor !== true
      ) {
        failures.push('MANCODE_LEDGER_ASSIGNMENT_REQUIRED');
      }
      if (input.evidence?.restrictsWriteToAssignedItem !== true) {
        failures.push('MANCODE_LEDGER_SCOPE_MUTATION_DENIED');
      }
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      break;
    case 'task_head_reconcile':
      requireTaskOwner(input, failures);
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      requireCondition(
        input,
        'gitSourceConfirmed',
        'MANCODE_GIT_SOURCE_CONFIRMATION_REQUIRED',
        failures,
      );
      requireCondition(
        input,
        'claimHandoffConsistent',
        'MANCODE_CLAIM_HANDOFF_INCONSISTENT',
        failures,
      );
      break;
    case 'task_complete_scope_change_child_merge':
      requireTaskOwner(input, failures);
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      requireCondition(
        input,
        'completionGateSatisfied',
        'MANCODE_COMPLETION_GATE_BLOCKED',
        failures,
      );
      if (
        input.conditions?.requiresParentOwner === true &&
        input.conditions.parentOwnerActorId !== input.actorId
      ) {
        failures.push('MANCODE_PARENT_OWNER_REQUIRED');
      }
      break;
    case 'claim_create':
      requireTask(input, failures);
      if (
        input.task !== null &&
        input.task.ownerActorId !== input.actorId &&
        !isTaskParticipant(input.task, input.actorId)
      ) {
        failures.push('MANCODE_PARTICIPANT_REQUIRED');
      }
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      requireCondition(
        input,
        'implementationScopeContainsClaim',
        'MANCODE_SCOPE_OUTSIDE_IMPLEMENTATION_SCOPE',
        failures,
      );
      break;
    case 'claim_renew_release_transfer':
      requireClaimOwner(input, failures);
      requireExpectedRevision(input, failures);
      if (
        input.claim?.transferTargetActorId !== null &&
        input.claim !== null &&
        !isTaskParticipantOrMissing(
          input.task,
          input.claim.transferTargetActorId,
        )
      ) {
        failures.push('MANCODE_PARTICIPANT_REQUIRED');
      }
      break;
    case 'claim_reclaim':
      requireTaskOwner(input, failures);
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      requireCondition(
        input,
        'coordinationStoreFresh',
        'MANCODE_STORE_NOT_FRESH',
        failures,
      );
      requirePrivacySafeReason(input, failures);
      break;
    case 'handoff_offer_cancel':
      requireTask(input, failures);
      requireHandoff(input, failures);
      if (input.handoff !== null) {
        const actorMayAct =
          input.handoff.fromActorId === input.actorId ||
          (input.handoff.intent === 'cancel' &&
            input.task?.ownerActorId === input.actorId);
        if (!actorMayAct) failures.push('MANCODE_HANDOFF_ACTOR_MISMATCH');
        if (!isTaskParticipantOrMissing(input.task, input.handoff.toActorId)) {
          failures.push('MANCODE_HANDOFF_RECIPIENT_NOT_PARTICIPANT');
        }
      }
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      break;
    case 'handoff_accept_reject':
      requireHandoff(input, failures);
      if (input.handoff !== null && input.handoff.toActorId !== input.actorId) {
        failures.push('MANCODE_HANDOFF_ACTOR_MISMATCH');
      }
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      requireCondition(
        input,
        'taskContextAvailable',
        'MANCODE_TASK_UNAVAILABLE',
        failures,
      );
      requireCondition(
        input,
        'transportFresh',
        'MANCODE_TRANSPORT_UNAVAILABLE',
        failures,
      );
      break;
    case 'review_skip_or_waiver':
      requireTaskOwner(input, failures);
      requireExpectedRevision(input, failures);
      requireOwnershipEpoch(input, failures);
      requirePrivacySafeReason(input, failures);
      if (
        input.conditions?.reviewAction === 'waiver' &&
        (input.conditions.reviewSeverity === 'p0' ||
          input.conditions.reviewSeverity === 'legacy_unknown')
      ) {
        failures.push('MANCODE_WAIVER_FORBIDDEN');
      }
      break;
    case 'team_policy_config_transport':
      requireExpectedRevision(input, failures);
      requireCondition(
        input,
        'explicitConfirmation',
        'MANCODE_EXPLICIT_CONFIRMATION_REQUIRED',
        failures,
      );
      break;
    case 'actor_profile_publish':
      if (input.profileActorId !== input.actorId) {
        failures.push('MANCODE_PROFILE_OWNER_REQUIRED');
      }
      requireCondition(
        input,
        'explicitConfirmation',
        'MANCODE_EXPLICIT_CONFIRMATION_REQUIRED',
        failures,
      );
      break;
    case 'confirmed_decision_publish':
      requireCondition(
        input,
        'confirmedDecisionSharingEnabled',
        'MANCODE_CONFIRMED_DECISIONS_DISABLED',
        failures,
      );
      requireCondition(
        input,
        'privacyConfirmed',
        'MANCODE_PRIVACY_CONFIRMATION_REQUIRED',
        failures,
      );
      requireCondition(
        input,
        'explicitConfirmation',
        'MANCODE_EXPLICIT_CONFIRMATION_REQUIRED',
        failures,
      );
      break;
  }
  return {
    allowed: failures.length === 0,
    failures: uniqueFailures(failures),
    trustBoundary: TEAM_TRUST_BOUNDARY,
  };
}

export function assertAuthorized(input: AuthorizationRequest): void {
  const decision = evaluateAuthorization(input);
  if (!decision.allowed) {
    throw new Error(decision.failures[0] ?? 'MANCODE_AUTHORIZATION_DENIED');
  }
}

/**
 * Stores only actor/session IDs and a digest of boolean/ID facts. In
 * particular, a waiver or reclaim reason is never copied into the journal.
 */
export function createAuthorizationBasis(
  input: AuthorizationRequest,
  now: Date = new Date(),
): AuthorizationBasisV1 {
  assertAuthorized(input);
  const sessionId = input.session.sessionId;
  if (sessionId === null) throw new Error('MANCODE_SESSION_REQUIRED');
  return {
    schemaVersion: 1,
    action: input.action,
    actorId: input.actorId,
    sessionId,
    trustBoundary: TEAM_TRUST_BOUNDARY,
    decisionDigest: digestCanonicalJson(authorizationDecisionProjection(input)),
    authorizedAt: now.toISOString(),
  };
}

export function parseAuthorizationBasis(value: unknown): AuthorizationBasisV1 {
  assertRecord(value, 'authorization basis');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'action',
      'actorId',
      'sessionId',
      'trustBoundary',
      'decisionDigest',
      'authorizedAt',
    ],
    'authorization basis',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('authorization basis schemaVersion must be 1');
  }
  if (
    typeof value.action !== 'string' ||
    !AUTHORIZATION_ACTIONS.has(value.action as AuthorizationAction)
  ) {
    throw new Error('authorization basis action is invalid');
  }
  assertUlid(value.actorId, 'authorization basis actorId');
  assertUlid(value.sessionId, 'authorization basis sessionId');
  if (value.trustBoundary !== TEAM_TRUST_BOUNDARY) {
    throw new Error('authorization basis trustBoundary is invalid');
  }
  if (
    typeof value.decisionDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.decisionDigest)
  ) {
    throw new Error('authorization basis decisionDigest is invalid');
  }
  if (
    typeof value.authorizedAt !== 'string' ||
    Number.isNaN(Date.parse(value.authorizedAt))
  ) {
    throw new Error(
      'authorization basis authorizedAt must be an ISO timestamp',
    );
  }
  return {
    schemaVersion: 1,
    action: value.action as AuthorizationAction,
    actorId: value.actorId,
    sessionId: value.sessionId,
    trustBoundary: TEAM_TRUST_BOUNDARY,
    decisionDigest: value.decisionDigest,
    authorizedAt: value.authorizedAt,
  };
}

/** Reconciliation may continue an approved operation but never replace actor/session. */
export function assertRepairUsesOriginalAuthorization(
  basis: AuthorizationBasisV1,
  actorId: Ulid,
  sessionId: Ulid,
): void {
  const parsed = parseAuthorizationBasis(basis);
  assertUlid(actorId, 'repair actorId');
  assertUlid(sessionId, 'repair sessionId');
  if (parsed.actorId !== actorId || parsed.sessionId !== sessionId) {
    throw new Error('MANCODE_REPAIR_AUTHORIZATION_MISMATCH');
  }
}

function validateRequest(input: AuthorizationRequest): void {
  if (!AUTHORIZATION_ACTIONS.has(input.action)) {
    throw new Error('authorization action is invalid');
  }
  assertUlid(input.actorId, 'authorization actorId');
  parseCapabilityLevel(
    input.sharedWriteGuard,
    'authorization sharedWriteGuard',
  );
  validateSession(input.session);
  validateTask(input.task);
  validateClaim(input.claim);
  validateHandoff(input.handoff);
  if (input.profileActorId !== null) {
    assertUlid(input.profileActorId, 'authorization profileActorId');
  }
  if (typeof input.joined !== 'boolean') {
    throw new Error('authorization joined must be boolean');
  }
  if (input.evidence !== null) {
    if (
      typeof input.evidence.assignedToActor !== 'boolean' ||
      typeof input.evidence.restrictsWriteToAssignedItem !== 'boolean'
    ) {
      throw new Error('authorization evidence flags must be boolean');
    }
  }
  if (
    input.conditions?.parentOwnerActorId !== undefined &&
    input.conditions.parentOwnerActorId !== null
  ) {
    assertUlid(
      input.conditions.parentOwnerActorId,
      'authorization parentOwnerActorId',
    );
  }
}

function validateSession(session: AuthorizationSession): void {
  if (
    session.status !== 'active' &&
    session.status !== 'closed' &&
    session.status !== 'missing'
  ) {
    throw new Error('authorization session status is invalid');
  }
  if (session.sessionId !== null)
    assertUlid(session.sessionId, 'authorization sessionId');
  if (session.actorId !== null)
    assertUlid(session.actorId, 'authorization session actorId');
}

function validateTask(task: AuthorizationTaskContext | null): void {
  if (task === null) return;
  if (task.ownerActorId !== null)
    assertUlid(task.ownerActorId, 'authorization task ownerActorId');
  if (!Array.isArray(task.participantActorIds)) {
    throw new Error('authorization task participantActorIds must be an array');
  }
  for (const actorId of task.participantActorIds) {
    assertUlid(actorId, 'authorization task participantActorId');
  }
  if (
    sortUtf8StringSet(task.participantActorIds).length !==
    task.participantActorIds.length
  ) {
    throw new Error('authorization task participantActorIds must not repeat');
  }
}

function validateClaim(claim: AuthorizationClaimContext | null): void {
  if (claim === null) return;
  assertUlid(claim.ownerActorId, 'authorization claim ownerActorId');
  if (claim.transferTargetActorId !== null) {
    assertUlid(
      claim.transferTargetActorId,
      'authorization claim transferTargetActorId',
    );
  }
}

function validateHandoff(handoff: AuthorizationHandoffContext | null): void {
  if (handoff === null) return;
  assertUlid(handoff.fromActorId, 'authorization handoff fromActorId');
  assertUlid(handoff.toActorId, 'authorization handoff toActorId');
  if (
    handoff.intent !== 'offer' &&
    handoff.intent !== 'cancel' &&
    handoff.intent !== 'accept' &&
    handoff.intent !== 'reject'
  ) {
    throw new Error('authorization handoff intent is invalid');
  }
}

function requireActiveSession(
  input: AuthorizationRequest,
  failures: AuthorizationFailureCode[],
): void {
  if (input.session.status !== 'active' || input.session.sessionId === null) {
    failures.push('MANCODE_SESSION_REQUIRED');
  }
  if (input.session.actorId !== input.actorId) {
    failures.push('MANCODE_SESSION_ACTOR_MISMATCH');
  }
}

function requireTask(
  input: AuthorizationRequest,
  failures: AuthorizationFailureCode[],
): void {
  if (input.task === null) failures.push('MANCODE_TASK_OWNER_REQUIRED');
}

function requireTaskOwner(
  input: AuthorizationRequest,
  failures: AuthorizationFailureCode[],
): void {
  requireTask(input, failures);
  if (input.task !== null && input.task.ownerActorId !== input.actorId) {
    failures.push('MANCODE_TASK_OWNER_REQUIRED');
  }
}

function requireClaimOwner(
  input: AuthorizationRequest,
  failures: AuthorizationFailureCode[],
): void {
  if (input.claim === null || input.claim.ownerActorId !== input.actorId) {
    failures.push('MANCODE_CLAIM_OWNER_REQUIRED');
  }
}

function requireHandoff(
  input: AuthorizationRequest,
  failures: AuthorizationFailureCode[],
): void {
  if (input.handoff === null) failures.push('MANCODE_HANDOFF_ACTOR_MISMATCH');
}

function requireExpectedRevision(
  input: AuthorizationRequest,
  failures: AuthorizationFailureCode[],
): void {
  requireCondition(
    input,
    'expectedRevisionMatches',
    'MANCODE_EXPECTED_REVISION_CONFLICT',
    failures,
  );
}

function requireOwnershipEpoch(
  input: AuthorizationRequest,
  failures: AuthorizationFailureCode[],
): void {
  requireCondition(
    input,
    'ownershipEpochFresh',
    'MANCODE_OWNERSHIP_EPOCH_STALE',
    failures,
  );
}

function requireCondition(
  input: AuthorizationRequest,
  condition: Exclude<
    keyof AuthorizationConditions,
    'reason' | 'reviewAction' | 'reviewSeverity' | 'parentOwnerActorId'
  >,
  failure: AuthorizationFailureCode,
  failures: AuthorizationFailureCode[],
): void {
  if (input.conditions?.[condition] !== true) failures.push(failure);
}

function requirePrivacySafeReason(
  input: AuthorizationRequest,
  failures: AuthorizationFailureCode[],
): void {
  const reason = input.conditions?.reason;
  if (typeof reason !== 'string' || !reason.trim()) {
    failures.push('MANCODE_RECLAIM_REASON_REQUIRED');
    return;
  }
  try {
    assertSharedTextSafe(reason, 'authorization reason');
  } catch {
    failures.push('MANCODE_PRIVACY_CONFIRMATION_REQUIRED');
  }
}

function isTaskParticipant(
  task: AuthorizationTaskContext,
  actorId: Ulid,
): boolean {
  return task.participantActorIds.includes(actorId);
}

function isTaskParticipantOrMissing(
  task: AuthorizationTaskContext | null,
  actorId: Ulid,
): boolean {
  return task !== null && isTaskParticipant(task, actorId);
}

function uniqueFailures(
  failures: AuthorizationFailureCode[],
): AuthorizationFailureCode[] {
  return [...new Set(failures)];
}

function authorizationDecisionProjection(input: AuthorizationRequest): object {
  return {
    action: input.action,
    actorId: input.actorId,
    session: input.session,
    joined: input.joined,
    sharedWriteGuard: input.sharedWriteGuard,
    task: input.task,
    claim: input.claim,
    handoff: input.handoff,
    evidence: input.evidence,
    profileActorId: input.profileActorId,
    conditions: {
      expectedRevisionMatches:
        input.conditions?.expectedRevisionMatches === true,
      ownershipEpochFresh: input.conditions?.ownershipEpochFresh === true,
      privacyConfirmed: input.conditions?.privacyConfirmed === true,
      explicitConfirmation: input.conditions?.explicitConfirmation === true,
      taskContextAvailable: input.conditions?.taskContextAvailable === true,
      transportFresh: input.conditions?.transportFresh === true,
      gitSourceConfirmed: input.conditions?.gitSourceConfirmed === true,
      completionGateSatisfied:
        input.conditions?.completionGateSatisfied === true,
      claimHandoffConsistent: input.conditions?.claimHandoffConsistent === true,
      implementationScopeContainsClaim:
        input.conditions?.implementationScopeContainsClaim === true,
      coordinationStoreFresh: input.conditions?.coordinationStoreFresh === true,
      requiresParentOwner: input.conditions?.requiresParentOwner === true,
      parentOwnerActorId: input.conditions?.parentOwnerActorId ?? null,
      reviewAction: input.conditions?.reviewAction ?? null,
      reviewSeverity: input.conditions?.reviewSeverity ?? null,
      hasReason:
        typeof input.conditions?.reason === 'string' &&
        input.conditions.reason.trim() !== '',
    },
  };
}

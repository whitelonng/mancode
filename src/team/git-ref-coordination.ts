import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertManteamPlanContent } from '../context/manteam-plan.js';
import {
  type TaskRef,
  formatTaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
  workflowMetadataDigest,
} from '../context/workflow-metadata.js';
import { type ClaimV1, assertClaimTransition, parseClaim } from './claims.js';
import {
  assertClaimScopeSubset,
  assessClaimConflicts,
  deriveClaimValidity,
} from './conflicts.js';
import type {
  GitRefOwnershipFenceV1,
  GitRefRemoteMutationReceiptV1,
  GitRefTaskBundleV1,
  GitRefTeamManifestV1,
  MutateGitRefCoordinationInput,
} from './git-ref-transport.js';
import {
  parseGitRefOwnershipFence,
  parseGitRefRemoteMutationReceipt,
  parseGitRefTaskBundle,
} from './git-ref-transport.js';
import {
  type HandoffV1,
  assertHandoffTransition,
  parseHandoff,
} from './handoff.js';

export interface MaterializedGitRefCoordinationV1 {
  remoteRevision: number;
  lastOperationId: Ulid;
  ownershipFences: GitRefOwnershipFenceV1[];
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  taskBundles: GitRefTaskBundleV1[];
  receipts: GitRefRemoteMutationReceiptV1[];
  fetchedAt: string;
}

interface BaseGitRefMutation {
  operationId: Ulid;
  actorId: Ulid;
  taskRef: TaskRef;
  expectedRemoteRevision: number;
  expectedOwnershipEpoch: number;
  now?: Date;
}

export type PrepareGitRefCoordinationMutationInput = BaseGitRefMutation &
  (
    | {
        kind: 'ownership_fence';
        expectedPredecessorBundleDigest: string | null;
        taskBundle: GitRefTaskBundleV1;
      }
    | {
        kind: 'claim_acquire';
        claim: ClaimV1;
        confirmScopeWarning?: boolean;
      }
    | {
        kind: 'claim_renew';
        claimId: Ulid;
        expectedClaimRevision: number;
        expiresAt: string;
      }
    | {
        kind: 'claim_release';
        claimId: Ulid;
        expectedClaimRevision: number;
      }
    | {
        kind: 'claim_reclaim';
        claimId: Ulid;
        expectedClaimRevision: number;
        reason: string;
      }
    | {
        kind: 'claim_revalidate';
        claimId: Ulid;
        expectedClaimRevision: number;
      }
    | {
        kind: 'claim_transfer';
        claimId: Ulid;
        expectedClaimRevision: number;
        toActorId: Ulid;
        successorClaimId: Ulid;
      }
    | {
        kind: 'handoff_draft';
        handoff: HandoffV1;
      }
    | {
        kind: 'handoff_offer' | 'handoff_reject' | 'handoff_cancel';
        handoffId: Ulid;
        expectedHandoffRevision: number;
        reason?: string;
      }
    | {
        kind: 'handoff_accept';
        handoffId: Ulid;
        expectedHandoffRevision: number;
        successorClaimIds: Ulid[];
        taskBundle: GitRefTaskBundleV1;
        codeReachable: boolean;
      }
  );

export interface GitRefOwnershipForwardRepairV1 {
  taskRef: TaskRef;
  ownerActorId: Ulid;
  ownershipEpoch: number;
  taskRevision: number;
  aggregateDigest: string;
  operationId: Ulid;
}

export interface PreparedGitRefCoordinationMutation
  extends MutateGitRefCoordinationInput {
  forwardRepair: GitRefOwnershipForwardRepairV1 | null;
}

/**
 * Converts a parsed remote manifest into a read-only local cache view. The
 * fetched transport marker is a projection only and is never pushed back as
 * authoritative remote state.
 */
export function materializeGitRefCoordination(
  manifest: GitRefTeamManifestV1,
  fetchedAt: string,
): MaterializedGitRefCoordinationV1 {
  assertTimestamp(fetchedAt, 'git-ref materialization fetchedAt');
  return {
    remoteRevision: manifest.revision,
    lastOperationId: manifest.lastOperationId,
    ownershipFences: manifest.ownershipFences
      .map(parseGitRefOwnershipFence)
      .sort(compareFences),
    claims: manifest.claims.map(parseClaim).sort(compareClaims),
    handoffs: manifest.handoffs
      .map((handoff) => materializeHandoff(handoff, fetchedAt))
      .sort(compareHandoffs),
    taskBundles: manifest.taskBundles
      .map(parseGitRefTaskBundle)
      .sort(compareTaskBundles),
    receipts: manifest.receipts
      .map(parseGitRefRemoteMutationReceipt)
      .sort(compareReceipts),
    fetchedAt,
  };
}

/**
 * Prepares one task-scoped replacement for GitRefTeamManifestStore. It does
 * no I/O: all actor, remote revision, ownership epoch, state transition, and
 * cross-entity checks complete before the caller attempts the remote CAS.
 */
export function prepareGitRefCoordinationMutation(
  manifest: GitRefTeamManifestV1,
  input: PrepareGitRefCoordinationMutationInput,
): PreparedGitRefCoordinationMutation {
  const context = openMutationContext(manifest, input);
  switch (input.kind) {
    case 'ownership_fence':
      return prepareOwnershipFence(
        context,
        input.taskBundle,
        input.expectedPredecessorBundleDigest,
      );
    case 'claim_acquire':
      return prepareClaimAcquire(
        context,
        input.claim,
        input.confirmScopeWarning === true,
      );
    case 'claim_renew':
      return prepareClaimRenew(
        context,
        input.claimId,
        input.expectedClaimRevision,
        input.expiresAt,
      );
    case 'claim_release':
      return prepareClaimRelease(
        context,
        input.claimId,
        input.expectedClaimRevision,
      );
    case 'claim_reclaim':
      return prepareClaimReclaim(
        context,
        input.claimId,
        input.expectedClaimRevision,
        input.reason,
      );
    case 'claim_revalidate':
      return prepareClaimRevalidate(
        context,
        input.claimId,
        input.expectedClaimRevision,
      );
    case 'claim_transfer':
      return prepareClaimTransfer(
        context,
        input.claimId,
        input.expectedClaimRevision,
        input.toActorId,
        input.successorClaimId,
      );
    case 'handoff_draft':
      return prepareHandoffDraft(context, input.handoff);
    case 'handoff_offer':
    case 'handoff_reject':
    case 'handoff_cancel':
      return prepareHandoffTransition(
        context,
        input.kind,
        input.handoffId,
        input.expectedHandoffRevision,
        input.reason,
      );
    case 'handoff_accept':
      return prepareHandoffAccept(context, input);
  }
}

interface MutationContext {
  manifest: GitRefTeamManifestV1;
  input: PrepareGitRefCoordinationMutationInput;
  taskRef: TaskRef;
  now: Date;
  timestamp: string;
  nextRemoteRevision: number;
  fence: GitRefOwnershipFenceV1 | null;
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  taskBundle: GitRefTaskBundleV1 | null;
  metadata: WorkflowMetadataV3 | null;
}

function openMutationContext(
  manifest: GitRefTeamManifestV1,
  input: PrepareGitRefCoordinationMutationInput,
): MutationContext {
  assertUlid(input.operationId, 'git-ref coordination operationId');
  assertUlid(input.actorId, 'git-ref coordination actorId');
  const taskRef = parseTaskRefValue(input.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_REMOTE_COORDINATION_REQUIRES_SHARED_TASK');
  }
  assertNonNegativeInteger(
    input.expectedRemoteRevision,
    'git-ref expectedRemoteRevision',
  );
  assertNonNegativeInteger(
    input.expectedOwnershipEpoch,
    'git-ref expectedOwnershipEpoch',
  );
  if (manifest.revision !== input.expectedRemoteRevision) {
    throw new Error('MANCODE_TRANSPORT_REVISION_CONFLICT');
  }
  if (
    !manifest.actorProfiles.some((profile) => profile.actorId === input.actorId)
  ) {
    throw new Error('MANCODE_JOIN_REQUIRED');
  }
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error('git-ref coordination now is invalid');
  }
  const fences = manifest.ownershipFences.filter((candidate) =>
    sameTaskRef(candidate.taskRef, taskRef),
  );
  if (fences.length > 1) throw new Error('MANCODE_REMOTE_FENCE_DUPLICATE');
  const bundles = manifest.taskBundles.filter((candidate) =>
    sameTaskRef(candidate.taskRef, taskRef),
  );
  if (bundles.length > 1) throw new Error('MANCODE_TASK_BUNDLE_DUPLICATE');
  const fence = fences[0] ?? null;
  if (fence !== null && fence.ownershipEpoch !== input.expectedOwnershipEpoch) {
    throw new Error('MANCODE_OWNERSHIP_EPOCH_STALE');
  }
  if (
    fence === null &&
    (input.kind !== 'ownership_fence' || input.expectedOwnershipEpoch !== 0)
  ) {
    throw new Error('MANCODE_REMOTE_OWNERSHIP_FENCE_MISSING');
  }
  const taskBundle = bundles[0] ?? null;
  const metadata = taskBundle === null ? null : metadataFromBundle(taskBundle);
  if (fence !== null) {
    if (taskBundle === null || metadata === null) {
      throw new Error('MANCODE_TASK_UNAVAILABLE');
    }
    assertFenceBundleConsistent(fence, taskBundle, metadata);
  }
  return {
    manifest,
    input,
    taskRef,
    now,
    timestamp: now.toISOString(),
    nextRemoteRevision: manifest.revision + 1,
    fence,
    claims: manifest.claims
      .filter((claim) => sameTaskRef(claim.taskRef, taskRef))
      .map(parseClaim)
      .sort(compareClaims),
    handoffs: manifest.handoffs
      .filter((handoff) => sameTaskRef(handoff.taskRef, taskRef))
      .map(parseHandoff)
      .sort(compareHandoffs),
    taskBundle,
    metadata,
  };
}

function prepareOwnershipFence(
  context: MutationContext,
  taskBundle: GitRefTaskBundleV1,
  expectedPredecessorBundleDigest: string | null,
): PreparedGitRefCoordinationMutation {
  const metadata = metadataFromBundle(taskBundle);
  assertRemoteTaskEligible(metadata);
  assertTaskBundleIdentity(taskBundle, context.taskRef);
  if (metadata.ownerActorId === null) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
  if (
    (context.taskBundle?.bundleDigest ?? null) !==
    expectedPredecessorBundleDigest
  ) {
    throw new Error('MANCODE_TASK_BUNDLE_DIVERGED');
  }
  if (context.fence === null) {
    if (
      metadata.ownerActorId !== context.input.actorId ||
      metadata.ownershipEpoch !== 0 ||
      taskBundle.ownershipEpoch !== 0
    ) {
      throw new Error('MANCODE_TASK_OWNER_REQUIRED');
    }
  } else {
    assertCurrentTaskOwner(context);
    if (
      metadata.ownerActorId !== context.fence.ownerActorId ||
      metadata.ownershipEpoch !== context.fence.ownershipEpoch
    ) {
      throw new Error('MANCODE_OWNERSHIP_EPOCH_STALE');
    }
    if (taskBundle.taskRevision < context.fence.taskRevision) {
      throw new Error('MANCODE_TASK_REVISION_CONFLICT');
    }
    if (taskBundle.taskRevision === context.fence.taskRevision) {
      if (taskBundle.aggregateDigest !== context.fence.aggregateDigest) {
        throw new Error('MANCODE_SPLIT_BRAIN');
      }
      if (
        taskBundle.codeRef.branch !== context.taskBundle?.codeRef.branch ||
        taskBundle.codeRef.head === context.taskBundle?.codeRef.head
      ) {
        throw new Error('MANCODE_REMOTE_FENCE_NO_CHANGE');
      }
      return prepared(
        context,
        buildFence(context, taskBundle, metadata.ownerActorId),
        refreshOwnerClaimsForCodeRef(context, taskBundle, metadata),
        context.handoffs,
        taskBundle,
      );
    }
  }
  const codeHeadChanged =
    context.taskBundle !== null &&
    (taskBundle.codeRef.branch !== context.taskBundle.codeRef.branch ||
      taskBundle.codeRef.head !== context.taskBundle.codeRef.head);
  const fence = buildFence(context, taskBundle, metadata.ownerActorId);
  return prepared(
    context,
    fence,
    codeHeadChanged
      ? refreshOwnerClaimsForCodeRef(context, taskBundle, metadata)
      : context.claims,
    context.handoffs,
    taskBundle,
  );
}

function refreshOwnerClaimsForCodeRef(
  context: MutationContext,
  taskBundle: GitRefTaskBundleV1,
  metadata: WorkflowMetadataV3,
): ClaimV1[] {
  return context.claims.map((claim) => {
    if (
      claim.state !== 'active' ||
      claim.ownerActorId !== context.input.actorId ||
      Date.parse(claim.expiresAt) <= context.now.getTime() ||
      claim.ownershipEpochAtAcquire !== taskBundle.ownershipEpoch ||
      claim.implementationScopeDigest !== metadata.implementationScope.digest
    ) {
      return claim;
    }
    const next = bindClaim(context, {
      ...claim,
      revision: claim.revision + 1,
      lastValidatedTaskRevision: taskBundle.taskRevision,
      lastValidatedCodeRef: taskBundle.codeRef,
    });
    assertClaimTransition(claim, next);
    return next;
  });
}

function prepareClaimAcquire(
  context: MutationContext,
  proposal: ClaimV1,
  confirmScopeWarning: boolean,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle, metadata } = requireTaskContext(context);
  assertRemoteTaskEligible(metadata);
  assertRemoteManteamPlanReady(metadata, taskBundle);
  assertOwnerOrParticipant(context, metadata);
  const source = parseClaim(proposal);
  if (context.claims.some((claim) => claim.claimId === source.claimId)) {
    throw new Error('MANCODE_CLAIM_ID_CONFLICT');
  }
  if (
    !sameTaskRef(source.taskRef, context.taskRef) ||
    source.workspaceId !== context.manifest.workspaceId ||
    source.ownerActorId !== context.input.actorId ||
    source.revision !== 1 ||
    (source.state !== 'pending' && source.state !== 'active') ||
    source.predecessorClaimId !== null ||
    source.successorClaimId !== null
  ) {
    throw new Error('MANCODE_REMOTE_CLAIM_PROPOSAL_INVALID');
  }
  if (!source.coordinationDomainId.startsWith('git-ref:')) {
    throw new Error('MANCODE_COORDINATION_DOMAIN_MISMATCH');
  }
  assertClaimSnapshotCurrent(source, fence, taskBundle, metadata, context.now);
  assertClaimScopeSubset(source.scope, {
    source: metadata.implementationScope.source,
    include: metadata.implementationScope.include,
    exclude: metadata.implementationScope.exclude,
    modules: metadata.implementationScope.modules,
  });
  assertAllActiveClaimsFresh(context, fence, taskBundle, metadata);
  const conflict = assessClaimConflicts(source.scope, context.claims, {
    transportFreshness: 'fresh',
    claimAcquisition: 'enforced',
  });
  if (
    conflict.acquisition === 'reject' ||
    (conflict.acquisition === 'confirm_or_narrow' && !confirmScopeWarning) ||
    conflict.acquisition === 'sync_or_confirm' ||
    conflict.acquisition === 'unavailable'
  ) {
    throw new Error('MANCODE_SCOPE_CONFLICT');
  }
  const claim = bindClaim(context, {
    ...source,
    state: 'active',
    acquisitionEnforcement: 'enforced',
    revision: 1,
  });
  return prepared(
    context,
    advanceFence(context, fence),
    [...context.claims, claim],
    context.handoffs,
    taskBundle,
  );
}

function prepareClaimRenew(
  context: MutationContext,
  claimId: Ulid,
  expectedRevision: number,
  expiresAt: string,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle, metadata } = requireTaskContext(context);
  assertRemoteTaskEligible(metadata);
  const claim = requireClaim(context, claimId, expectedRevision);
  assertClaimOwner(context, claim);
  if (claim.state !== 'active') throw new Error('MANCODE_CLAIM_NOT_ACTIVE');
  if (
    deriveClaimValidity(
      claim,
      claimValidation(fence, taskBundle, metadata, context.now),
    ) !== 'fresh'
  ) {
    throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
  }
  assertTimestamp(expiresAt, 'git-ref claim expiresAt');
  if (
    Date.parse(expiresAt) <= Date.parse(claim.expiresAt) ||
    Date.parse(expiresAt) <= context.now.getTime()
  ) {
    throw new Error('MANCODE_CLAIM_TTL_INVALID');
  }
  const next = bindClaim(context, {
    ...claim,
    revision: claim.revision + 1,
    expiresAt,
  });
  assertClaimTransition(claim, next);
  return replaceClaim(context, fence, taskBundle, next);
}

function prepareClaimRelease(
  context: MutationContext,
  claimId: Ulid,
  expectedRevision: number,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle } = requireTaskContext(context);
  const claim = requireClaim(context, claimId, expectedRevision);
  assertClaimOwner(context, claim);
  if (claim.state !== 'active') throw new Error('MANCODE_CLAIM_NOT_ACTIVE');
  const next = bindClaim(context, {
    ...claim,
    state: 'released',
    revision: claim.revision + 1,
  });
  assertClaimTransition(claim, next);
  return replaceClaim(context, fence, taskBundle, next);
}

function prepareClaimReclaim(
  context: MutationContext,
  claimId: Ulid,
  expectedRevision: number,
  reason: string,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle } = requireTaskContext(context);
  assertCurrentTaskOwner(context);
  if (!reason.trim()) throw new Error('MANCODE_RECLAIM_REASON_REQUIRED');
  const claim = requireClaim(context, claimId, expectedRevision);
  if (claim.state !== 'active') throw new Error('MANCODE_CLAIM_NOT_ACTIVE');
  if (Date.parse(claim.expiresAt) > context.now.getTime()) {
    throw new Error('MANCODE_CLAIM_NOT_EXPIRED');
  }
  const next = bindClaim(context, {
    ...claim,
    state: 'expired',
    revision: claim.revision + 1,
  });
  assertClaimTransition(claim, next);
  return replaceClaim(context, fence, taskBundle, next);
}

function prepareClaimRevalidate(
  context: MutationContext,
  claimId: Ulid,
  expectedRevision: number,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle, metadata } = requireTaskContext(context);
  const claim = requireClaim(context, claimId, expectedRevision);
  assertClaimOwner(context, claim);
  if (
    claim.state !== 'active' ||
    claim.ownershipEpochAtAcquire !== fence.ownershipEpoch ||
    claim.implementationScopeDigest !== metadata.implementationScope.digest ||
    Date.parse(claim.expiresAt) <= context.now.getTime()
  ) {
    throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
  }
  const validity = deriveClaimValidity(
    claim,
    claimValidation(fence, taskBundle, metadata, context.now),
  );
  if (validity !== 'needs_revalidation' && validity !== 'code_ref_stale') {
    throw new Error('MANCODE_CLAIM_REVALIDATION_NOT_REQUIRED');
  }
  const next = bindClaim(context, {
    ...claim,
    revision: claim.revision + 1,
    lastValidatedTaskRevision: taskBundle.taskRevision,
    lastValidatedCodeRef: taskBundle.codeRef,
  });
  assertClaimTransition(claim, next);
  return replaceClaim(context, fence, taskBundle, next);
}

function prepareClaimTransfer(
  context: MutationContext,
  claimId: Ulid,
  expectedRevision: number,
  toActorId: Ulid,
  successorClaimId: Ulid,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle, metadata } = requireTaskContext(context);
  assertUlid(toActorId, 'git-ref claim transfer actorId');
  assertUlid(successorClaimId, 'git-ref successor claimId');
  const claim = requireClaim(context, claimId, expectedRevision);
  assertClaimOwner(context, claim);
  if (
    claim.state !== 'active' ||
    deriveClaimValidity(
      claim,
      claimValidation(fence, taskBundle, metadata, context.now),
    ) !== 'fresh'
  ) {
    throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
  }
  if (toActorId === context.input.actorId) {
    throw new Error('MANCODE_CLAIM_TRANSFER_TARGET_INVALID');
  }
  if (!metadata.participants.includes(toActorId)) {
    throw new Error('MANCODE_PARTICIPANT_REQUIRED');
  }
  assertJoinedActor(context, toActorId);
  if (
    successorClaimId === claim.claimId ||
    context.claims.some((candidate) => candidate.claimId === successorClaimId)
  ) {
    throw new Error('MANCODE_CLAIM_ID_CONFLICT');
  }
  const predecessor = bindClaim(context, {
    ...claim,
    state: 'transferred',
    revision: claim.revision + 1,
    successorClaimId,
  });
  assertClaimTransition(claim, predecessor);
  const successor = bindClaim(context, {
    ...claim,
    claimId: successorClaimId,
    taskRevisionAtAcquire: taskBundle.taskRevision,
    lastValidatedTaskRevision: taskBundle.taskRevision,
    ownershipEpochAtAcquire: fence.ownershipEpoch,
    ownerActorId: toActorId,
    state: 'active',
    revision: 1,
    codeRefAtAcquire: taskBundle.codeRef,
    lastValidatedCodeRef: taskBundle.codeRef,
    predecessorClaimId: claim.claimId,
    successorClaimId: null,
    createdAt: context.timestamp,
  });
  return prepared(
    context,
    advanceFence(context, fence),
    [
      ...context.claims.filter((candidate) => candidate.claimId !== claimId),
      predecessor,
      successor,
    ],
    context.handoffs,
    taskBundle,
  );
}

function prepareHandoffDraft(
  context: MutationContext,
  proposal: HandoffV1,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle, metadata } = requireTaskContext(context);
  assertRemoteTaskEligible(metadata);
  assertCurrentTaskOwner(context);
  const source = parseHandoff(proposal);
  if (
    context.handoffs.some((handoff) => handoff.handoffId === source.handoffId)
  ) {
    throw new Error('MANCODE_HANDOFF_ID_CONFLICT');
  }
  if (
    !sameTaskRef(source.taskRef, context.taskRef) ||
    source.fromActorId !== context.input.actorId ||
    source.state !== 'draft' ||
    source.revision !== 1 ||
    source.taskRevision !== fence.taskRevision ||
    source.ownershipEpochAtOffer !== fence.ownershipEpoch ||
    !metadata.participants.includes(source.toActorId)
  ) {
    throw new Error('MANCODE_REMOTE_HANDOFF_PROPOSAL_INVALID');
  }
  assertJoinedActor(context, source.toActorId);
  assertHandoffClaims(source, context.claims, fence, context.now);
  assertHandoffBundleCurrent(source, taskBundle, false);
  const handoff = bindHandoff(context, source, taskBundle);
  return prepared(
    context,
    advanceFence(context, fence),
    context.claims,
    [...context.handoffs, handoff],
    taskBundle,
  );
}

function prepareHandoffTransition(
  context: MutationContext,
  kind: 'handoff_offer' | 'handoff_reject' | 'handoff_cancel',
  handoffId: Ulid,
  expectedRevision: number,
  reason: string | undefined,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle, metadata } = requireTaskContext(context);
  assertRemoteTaskEligible(metadata);
  const handoff = requireHandoff(context, handoffId, expectedRevision);
  assertHandoffBundleCurrent(handoff, taskBundle);
  if (!metadata.participants.includes(handoff.toActorId)) {
    throw new Error('MANCODE_HANDOFF_RECIPIENT_NOT_PARTICIPANT');
  }
  let next: HandoffV1;
  if (kind === 'handoff_offer') {
    if (
      handoff.state !== 'draft' ||
      context.input.actorId !== handoff.fromActorId ||
      context.input.actorId !== fence.ownerActorId
    ) {
      throw new Error('MANCODE_HANDOFF_NOT_DRAFT');
    }
    next = parseHandoff({
      ...handoff,
      state: 'offered',
      revision: handoff.revision + 1,
      offeredAt: context.timestamp,
      updatedAt: context.timestamp,
    });
  } else if (kind === 'handoff_reject') {
    if (handoff.state !== 'offered') {
      throw new Error('MANCODE_HANDOFF_NOT_OFFERED');
    }
    if (context.input.actorId !== handoff.toActorId) {
      throw new Error('MANCODE_HANDOFF_ACTOR_MISMATCH');
    }
    if (reason === undefined || !reason.trim()) {
      throw new Error('MANCODE_HANDOFF_REJECTION_REASON_REQUIRED');
    }
    next = terminalHandoff(context, handoff, 'rejected', reason);
  } else {
    if (handoff.state !== 'draft' && handoff.state !== 'offered') {
      throw new Error('MANCODE_HANDOFF_NOT_CANCELLABLE');
    }
    if (
      context.input.actorId !== handoff.fromActorId &&
      context.input.actorId !== fence.ownerActorId
    ) {
      throw new Error('MANCODE_HANDOFF_ACTOR_MISMATCH');
    }
    next = terminalHandoff(context, handoff, 'cancelled', reason ?? null);
  }
  next = bindHandoff(context, next, taskBundle);
  assertHandoffTransition(handoff, next, context.input.actorId);
  return prepared(
    context,
    advanceFence(context, fence),
    context.claims,
    context.handoffs.map((candidate) =>
      candidate.handoffId === handoffId ? next : candidate,
    ),
    taskBundle,
  );
}

function prepareHandoffAccept(
  context: MutationContext,
  input: Extract<
    PrepareGitRefCoordinationMutationInput,
    { kind: 'handoff_accept' }
  >,
): PreparedGitRefCoordinationMutation {
  const { fence, taskBundle: currentBundle } = requireTaskContext(context);
  const handoff = requireHandoff(
    context,
    input.handoffId,
    input.expectedHandoffRevision,
  );
  if (handoff.state !== 'offered') {
    throw new Error('MANCODE_HANDOFF_NOT_OFFERED');
  }
  if (context.input.actorId !== handoff.toActorId) {
    throw new Error('MANCODE_HANDOFF_ACTOR_MISMATCH');
  }
  if (
    fence.ownerActorId !== handoff.fromActorId ||
    fence.ownershipEpoch !== handoff.ownershipEpochAtOffer
  ) {
    throw new Error('MANCODE_OWNERSHIP_EPOCH_STALE');
  }
  assertHandoffBundleCurrent(handoff, currentBundle);
  if (!input.codeReachable) throw new Error('MANCODE_TASK_UNAVAILABLE');

  const nextMetadata = metadataFromBundle(input.taskBundle);
  const currentMetadata = metadataFromBundle(currentBundle);
  assertRemoteTaskEligible(currentMetadata);
  assertRemoteTaskEligible(nextMetadata);
  assertTaskBundleIdentity(input.taskBundle, context.taskRef);
  if (
    nextMetadata.ownerActorId !== handoff.toActorId ||
    nextMetadata.ownershipEpoch !== fence.ownershipEpoch + 1 ||
    input.taskBundle.ownershipEpoch !== fence.ownershipEpoch + 1 ||
    input.taskBundle.taskRevision !== fence.taskRevision + 2 ||
    nextMetadata.lastOperationId !== context.input.operationId ||
    nextMetadata.transitionState !== 'stable' ||
    input.taskBundle.codeRef.branch !== currentBundle.codeRef.branch ||
    input.taskBundle.codeRef.head !== currentBundle.codeRef.head ||
    !handoffMetadataOnlyTransfersOwner(currentMetadata, nextMetadata)
  ) {
    throw new Error('MANCODE_OWNERSHIP_EPOCH_STALE');
  }
  const predecessors = handoff.claimIds.map((claimId) => {
    const claim = context.claims.find(
      (candidate) => candidate.claimId === claimId,
    );
    if (
      claim === undefined ||
      claim.state !== 'active' ||
      claim.ownerActorId !== handoff.fromActorId ||
      claim.ownershipEpochAtAcquire !== fence.ownershipEpoch ||
      Date.parse(claim.expiresAt) <= context.now.getTime()
    ) {
      throw new Error('MANCODE_HANDOFF_CLAIM_UNAVAILABLE');
    }
    return claim;
  });
  assertHandoffClaims(handoff, context.claims, fence, context.now);
  if (input.successorClaimIds.length !== predecessors.length) {
    throw new Error('MANCODE_HANDOFF_SUCCESSOR_CLAIM_COUNT_INVALID');
  }
  const successorIds = new Set<Ulid>();
  for (const claimId of input.successorClaimIds) {
    assertUlid(claimId, 'git-ref handoff successor claimId');
    if (
      successorIds.has(claimId) ||
      context.claims.some((claim) => claim.claimId === claimId)
    ) {
      throw new Error('MANCODE_HANDOFF_SUCCESSOR_CLAIM_INVALID');
    }
    successorIds.add(claimId);
  }

  const transferred = predecessors.map((claim, index) => {
    const successorClaimId = input.successorClaimIds[index] as Ulid;
    const next = bindClaim(context, {
      ...claim,
      state: 'transferred',
      revision: claim.revision + 1,
      successorClaimId,
    });
    assertClaimTransition(claim, next);
    return next;
  });
  const successors = predecessors.map((claim, index) =>
    bindClaim(context, {
      ...claim,
      claimId: input.successorClaimIds[index] as Ulid,
      taskRevisionAtAcquire: input.taskBundle.taskRevision,
      lastValidatedTaskRevision: input.taskBundle.taskRevision,
      implementationScopeDigest: nextMetadata.implementationScope.digest,
      ownershipEpochAtAcquire: input.taskBundle.ownershipEpoch,
      ownerActorId: handoff.toActorId,
      state: 'active',
      revision: 1,
      codeRefAtAcquire: input.taskBundle.codeRef,
      lastValidatedCodeRef: input.taskBundle.codeRef,
      predecessorClaimId: claim.claimId,
      successorClaimId: null,
      createdAt: context.timestamp,
    }),
  );
  let accepted = terminalHandoff(context, handoff, 'accepted', null);
  accepted = bindHandoff(context, accepted, input.taskBundle);
  assertHandoffTransition(handoff, accepted, context.input.actorId);
  const nextFence = buildFence(context, input.taskBundle, handoff.toActorId);
  const predecessorIds = new Set(predecessors.map((claim) => claim.claimId));
  const claims = [
    ...context.claims.filter((claim) => !predecessorIds.has(claim.claimId)),
    ...transferred,
    ...successors,
  ];
  return {
    ...prepared(
      context,
      nextFence,
      claims,
      context.handoffs.map((candidate) =>
        candidate.handoffId === handoff.handoffId ? accepted : candidate,
      ),
      input.taskBundle,
    ),
    forwardRepair: {
      taskRef: context.taskRef,
      ownerActorId: handoff.toActorId,
      ownershipEpoch: nextFence.ownershipEpoch,
      taskRevision: nextFence.taskRevision,
      aggregateDigest: nextFence.aggregateDigest,
      operationId: context.input.operationId,
    },
  };
}

function requireTaskContext(context: MutationContext): {
  fence: GitRefOwnershipFenceV1;
  taskBundle: GitRefTaskBundleV1;
  metadata: WorkflowMetadataV3;
} {
  if (
    context.fence === null ||
    context.taskBundle === null ||
    context.metadata === null
  ) {
    throw new Error('MANCODE_TASK_UNAVAILABLE');
  }
  return {
    fence: context.fence,
    taskBundle: context.taskBundle,
    metadata: context.metadata,
  };
}

function prepared(
  context: MutationContext,
  ownershipFence: GitRefOwnershipFenceV1,
  claims: ClaimV1[],
  handoffs: HandoffV1[],
  taskBundle: GitRefTaskBundleV1 | null,
): PreparedGitRefCoordinationMutation {
  if (
    taskBundle !== null &&
    handoffs.some(
      (handoff) =>
        handoff.state === 'offered' &&
        handoff.transport.taskBundleDigest !== taskBundle.bundleDigest,
    )
  ) {
    throw new Error('MANCODE_TRANSPORT_HANDOFF_BUNDLE_MISMATCH');
  }
  return {
    operationId: context.input.operationId,
    actorId: context.input.actorId,
    taskRef: context.taskRef,
    expectedRemoteRevision: context.input.expectedRemoteRevision,
    expectedOwnershipEpoch: context.input.expectedOwnershipEpoch,
    ownershipFence,
    claims: claims.map(parseClaim).sort(compareClaims),
    handoffs: handoffs.map(parseHandoff).sort(compareHandoffs),
    taskBundle,
    expectedTaskBundleDigest: context.taskBundle?.bundleDigest ?? null,
    forwardRepair: null,
  };
}

function replaceClaim(
  context: MutationContext,
  fence: GitRefOwnershipFenceV1,
  taskBundle: GitRefTaskBundleV1,
  next: ClaimV1,
): PreparedGitRefCoordinationMutation {
  return prepared(
    context,
    advanceFence(context, fence),
    context.claims.map((claim) =>
      claim.claimId === next.claimId ? next : claim,
    ),
    context.handoffs,
    taskBundle,
  );
}

function requireClaim(
  context: MutationContext,
  claimId: Ulid,
  expectedRevision: number,
): ClaimV1 {
  assertUlid(claimId, 'git-ref claimId');
  assertPositiveInteger(expectedRevision, 'git-ref expectedClaimRevision');
  const claim = context.claims.find(
    (candidate) => candidate.claimId === claimId,
  );
  if (claim === undefined) throw new Error('MANCODE_CLAIM_NOT_FOUND');
  if (claim.revision !== expectedRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  return claim;
}

function requireHandoff(
  context: MutationContext,
  handoffId: Ulid,
  expectedRevision: number,
): HandoffV1 {
  assertUlid(handoffId, 'git-ref handoffId');
  assertPositiveInteger(expectedRevision, 'git-ref expectedHandoffRevision');
  const handoff = context.handoffs.find(
    (candidate) => candidate.handoffId === handoffId,
  );
  if (handoff === undefined) throw new Error('MANCODE_HANDOFF_NOT_FOUND');
  if (handoff.revision !== expectedRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  return handoff;
}

function bindClaim(context: MutationContext, value: ClaimV1): ClaimV1 {
  return parseClaim({
    ...value,
    authority: {
      mode: 'git-ref',
      remoteRevision: String(context.nextRemoteRevision),
    },
    lastOperationId: context.input.operationId,
    updatedAt: context.timestamp,
  });
}

function bindHandoff(
  context: MutationContext,
  value: HandoffV1,
  taskBundle: GitRefTaskBundleV1,
): HandoffV1 {
  return parseHandoff({
    ...value,
    transport: {
      ...value.transport,
      mode: 'git-ref',
      state: 'published',
      transportRevision: context.nextRemoteRevision,
      publishedAt: context.timestamp,
      fetchedAt: null,
      taskBundleDigest: taskBundle.bundleDigest,
      codeRef: taskBundle.codeRef,
      codeReachable: true,
      receipt: `git-ref-revision:${context.nextRemoteRevision}:${context.input.operationId}`,
    },
    lastOperationId: context.input.operationId,
    updatedAt: context.timestamp,
  });
}

function advanceFence(
  context: MutationContext,
  fence: GitRefOwnershipFenceV1,
): GitRefOwnershipFenceV1 {
  return {
    ...fence,
    remoteRevision: context.nextRemoteRevision,
    lastOperationId: context.input.operationId,
    updatedAt: context.timestamp,
  };
}

function buildFence(
  context: MutationContext,
  taskBundle: GitRefTaskBundleV1,
  ownerActorId: Ulid,
): GitRefOwnershipFenceV1 {
  assertUlid(ownerActorId, 'git-ref ownership fence ownerActorId');
  return {
    schemaVersion: 1,
    taskRef: context.taskRef,
    ownerActorId,
    ownershipEpoch: taskBundle.ownershipEpoch,
    taskRevision: taskBundle.taskRevision,
    aggregateDigest: taskBundle.aggregateDigest,
    remoteRevision: context.nextRemoteRevision,
    lastOperationId: context.input.operationId,
    updatedAt: context.timestamp,
  };
}

function assertCurrentTaskOwner(context: MutationContext): void {
  if (
    context.fence === null ||
    context.fence.ownerActorId !== context.input.actorId
  ) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
}

function assertOwnerOrParticipant(
  context: MutationContext,
  metadata: WorkflowMetadataV3,
): void {
  if (
    context.fence?.ownerActorId !== context.input.actorId &&
    !metadata.participants.includes(context.input.actorId)
  ) {
    throw new Error('MANCODE_PARTICIPANT_REQUIRED');
  }
}

function assertClaimOwner(context: MutationContext, claim: ClaimV1): void {
  if (claim.ownerActorId !== context.input.actorId) {
    throw new Error('MANCODE_CLAIM_OWNER_REQUIRED');
  }
}

function assertJoinedActor(context: MutationContext, actorId: Ulid): void {
  if (
    !context.manifest.actorProfiles.some(
      (profile) => profile.actorId === actorId,
    )
  ) {
    throw new Error('MANCODE_PARTICIPANT_JOIN_REQUIRED');
  }
}

function assertClaimSnapshotCurrent(
  claim: ClaimV1,
  fence: GitRefOwnershipFenceV1,
  taskBundle: GitRefTaskBundleV1,
  metadata: WorkflowMetadataV3,
  now: Date,
): void {
  if (
    claim.taskRevisionAtAcquire !== taskBundle.taskRevision ||
    claim.lastValidatedTaskRevision !== taskBundle.taskRevision ||
    claim.implementationScopeDigest !== metadata.implementationScope.digest ||
    claim.ownershipEpochAtAcquire !== fence.ownershipEpoch ||
    claim.codeRefAtAcquire.head !== taskBundle.codeRef.head ||
    claim.lastValidatedCodeRef.head !== taskBundle.codeRef.head ||
    Date.parse(claim.expiresAt) <= now.getTime()
  ) {
    throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
  }
}

function assertAllActiveClaimsFresh(
  context: MutationContext,
  fence: GitRefOwnershipFenceV1,
  taskBundle: GitRefTaskBundleV1,
  metadata: WorkflowMetadataV3,
): void {
  if (
    context.claims.some(
      (claim) =>
        claim.state === 'active' &&
        deriveClaimValidity(
          claim,
          claimValidation(fence, taskBundle, metadata, context.now),
        ) !== 'fresh',
    )
  ) {
    throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
  }
}

function claimValidation(
  fence: GitRefOwnershipFenceV1,
  taskBundle: GitRefTaskBundleV1,
  metadata: WorkflowMetadataV3,
  now: Date,
) {
  return {
    taskRef: fence.taskRef,
    taskRevision: taskBundle.taskRevision,
    implementationScopeDigest: metadata.implementationScope.digest,
    ownershipEpoch: fence.ownershipEpoch,
    codeRefHead: taskBundle.codeRef.head,
    now,
    transportFreshness: 'fresh' as const,
  };
}

function assertHandoffClaims(
  handoff: HandoffV1,
  claims: ClaimV1[],
  fence: GitRefOwnershipFenceV1,
  now: Date,
): void {
  const owned = claims.filter(
    (claim) =>
      claim.state === 'active' &&
      claim.ownerActorId === handoff.fromActorId &&
      sameTaskRef(claim.taskRef, handoff.taskRef),
  );
  const expected = owned.map((claim) => claim.claimId).sort(compareUtf8);
  const actual = [...handoff.claimIds].sort(compareUtf8);
  if (
    expected.length !== actual.length ||
    expected.some((claimId, index) => claimId !== actual[index])
  ) {
    throw new Error('MANCODE_HANDOFF_CLAIM_SET_INVALID');
  }
  if (
    owned.some(
      (claim) =>
        claim.ownershipEpochAtAcquire !== fence.ownershipEpoch ||
        Date.parse(claim.expiresAt) <= now.getTime(),
    )
  ) {
    throw new Error('MANCODE_HANDOFF_CLAIM_UNAVAILABLE');
  }
}

function assertHandoffBundleCurrent(
  handoff: HandoffV1,
  taskBundle: GitRefTaskBundleV1,
  requirePublished = true,
): void {
  if (
    handoff.taskRevision !== taskBundle.taskRevision ||
    handoff.ownershipEpochAtOffer !== taskBundle.ownershipEpoch ||
    handoff.transport.taskBundleDigest !== taskBundle.bundleDigest ||
    handoff.transport.codeRef.head !== taskBundle.codeRef.head ||
    handoff.transport.codeReachable !== true ||
    (requirePublished &&
      (handoff.transport.mode !== 'git-ref' ||
        handoff.transport.state !== 'published'))
  ) {
    throw new Error('MANCODE_HANDOFF_TASK_UNAVAILABLE');
  }
}

function terminalHandoff(
  context: MutationContext,
  handoff: HandoffV1,
  state: 'accepted' | 'rejected' | 'cancelled',
  reason: string | null,
): HandoffV1 {
  return parseHandoff({
    ...handoff,
    state,
    revision: handoff.revision + 1,
    resolution: {
      state,
      actorId: context.input.actorId,
      at: context.timestamp,
      reason,
    },
    updatedAt: context.timestamp,
  });
}

function metadataFromBundle(
  taskBundle: GitRefTaskBundleV1,
): WorkflowMetadataV3 {
  const artifacts = taskBundle.artifacts.filter(
    (artifact) => artifact.kind === 'metadata',
  );
  if (artifacts.length !== 1) throw new Error('MANCODE_TASK_UNAVAILABLE');
  const metadata = parseWorkflowMetadata(artifacts[0]?.content);
  if (
    !sameTaskRef(metadata.taskRef, taskBundle.taskRef) ||
    metadata.revision !== taskBundle.taskRevision ||
    metadata.ownershipEpoch !== taskBundle.ownershipEpoch ||
    taskBundle.aggregate.metadataDigest !== workflowMetadataDigest(metadata)
  ) {
    throw new Error('MANCODE_TASK_BUNDLE_DIGEST_MISMATCH');
  }
  if (metadata.transitionState !== 'stable') {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
  return metadata;
}

function assertRemoteTaskEligible(metadata: WorkflowMetadataV3): void {
  if (
    metadata.workflowMode !== 'manteam' ||
    metadata.coordination !== 'team' ||
    metadata.status !== 'in_progress'
  ) {
    throw new Error('MANCODE_REMOTE_COORDINATION_TASK_INVALID');
  }
}

function assertRemoteManteamPlanReady(
  metadata: WorkflowMetadataV3,
  taskBundle: GitRefTaskBundleV1,
): void {
  if (
    metadata.governance.planDecision !== 'governed_execution' ||
    metadata.currentStep < 5
  ) {
    throw new Error('MANCODE_MANTEAM_PLAN_CONFIRMATION_REQUIRED');
  }
  const plan = taskBundle.artifacts.find(
    (artifact) => artifact.kind === 'plan',
  );
  if (plan === undefined || typeof plan.content !== 'string') {
    throw new Error('MANCODE_MANTEAM_PLAN_CONFIRMATION_REQUIRED');
  }
  assertManteamPlanContent(plan.content);
}

function handoffMetadataOnlyTransfersOwner(
  previous: WorkflowMetadataV3,
  next: WorkflowMetadataV3,
): boolean {
  if (
    next.revision !== previous.revision + 2 ||
    !sameTaskRef(previous.taskRef, next.taskRef) ||
    digestCanonicalJson(previous.latestCheckpointRef) !==
      digestCanonicalJson(next.latestCheckpointRef)
  ) {
    return false;
  }
  return (
    workflowMetadataDigest({
      ...next,
      ownerActorId: previous.ownerActorId,
      ownershipEpoch: previous.ownershipEpoch,
    }) === workflowMetadataDigest(previous)
  );
}

function assertFenceBundleConsistent(
  fence: GitRefOwnershipFenceV1,
  taskBundle: GitRefTaskBundleV1,
  metadata: WorkflowMetadataV3,
): void {
  if (
    !sameTaskRef(fence.taskRef, taskBundle.taskRef) ||
    fence.taskRevision !== taskBundle.taskRevision ||
    fence.ownershipEpoch !== taskBundle.ownershipEpoch ||
    fence.aggregateDigest !== taskBundle.aggregateDigest ||
    fence.ownerActorId !== metadata.ownerActorId
  ) {
    throw new Error('MANCODE_REMOTE_OWNERSHIP_DIVERGED');
  }
}

function assertTaskBundleIdentity(
  taskBundle: GitRefTaskBundleV1,
  taskRef: TaskRef,
): void {
  if (
    !sameTaskRef(taskBundle.taskRef, taskRef) ||
    taskBundle.aggregate.taskRevision !== taskBundle.taskRevision ||
    taskBundle.aggregate.ownershipEpoch !== taskBundle.ownershipEpoch ||
    taskBundle.aggregateDigest !== digestCanonicalJson(taskBundle.aggregate)
  ) {
    throw new Error('MANCODE_TASK_BUNDLE_DIGEST_MISMATCH');
  }
}

function materializeHandoff(raw: HandoffV1, fetchedAt: string): HandoffV1 {
  const handoff = parseHandoff(raw);
  if (handoff.transport.mode !== 'git-ref') {
    throw new Error('MANCODE_COORDINATION_DOMAIN_MISMATCH');
  }
  return parseHandoff({
    ...handoff,
    transport: {
      ...handoff.transport,
      state: 'fetched',
      fetchedAt,
    },
  });
}

function assertTimestamp(value: string, label: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function compareFences(
  left: GitRefOwnershipFenceV1,
  right: GitRefOwnershipFenceV1,
): number {
  return compareUtf8(formatTaskRef(left.taskRef), formatTaskRef(right.taskRef));
}

function compareClaims(left: ClaimV1, right: ClaimV1): number {
  return compareUtf8(left.claimId, right.claimId);
}

function compareHandoffs(left: HandoffV1, right: HandoffV1): number {
  return compareUtf8(left.handoffId, right.handoffId);
}

function compareTaskBundles(
  left: GitRefTaskBundleV1,
  right: GitRefTaskBundleV1,
): number {
  return compareUtf8(formatTaskRef(left.taskRef), formatTaskRef(right.taskRef));
}

function compareReceipts(
  left: GitRefRemoteMutationReceiptV1,
  right: GitRefRemoteMutationReceiptV1,
): number {
  return left.remoteRevision - right.remoteRevision;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

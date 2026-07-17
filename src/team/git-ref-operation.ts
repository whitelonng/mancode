import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildTaskAggregateManifest,
  taskAggregateDigest,
} from '../context/aggregate.js';
import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { V3ContextStore } from '../context/store.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { parseWorkflowMetadata } from '../context/workflow-metadata.js';
import { readCheckoutBranch } from '../runtime/project-runtime.js';
import {
  type OpenedV3TaskOperation,
  openV3TaskOperation,
} from '../runtime/task-operation.js';
import { gitRefCoordinationDomainId } from '../runtime/workspace-binding.js';
import type { CheckpointV1 } from './checkpoints.js';
import { parseClaimTtl } from './claim-acquisition.js';
import {
  type ClaimScope,
  type ClaimV1,
  normalizeClaimScope,
  parseClaim,
} from './claims.js';
import {
  assertGitRefBundleCodeReachable,
  createGitRefTaskBundle,
} from './git-ref-bundle.js';
import { writeGitRefTeamCache } from './git-ref-cache.js';
import { createGitRefTeamManifestStore } from './git-ref-client.js';
import {
  type GitRefOwnershipForwardRepairV1,
  prepareGitRefCoordinationMutation,
} from './git-ref-coordination.js';
import {
  type GitRefTaskBundleV1,
  type GitRefTeamManifestSnapshot,
  type GitRefTeamManifestStore,
  type GitRefTeamManifestV1,
  resolveGitRefRemoteIdentityHash,
} from './git-ref-transport.js';
import { handoffSuccessorClaimId } from './handoff-operation.js';
import {
  type HandoffSummary,
  type HandoffV1,
  parseHandoff,
} from './handoff.js';

const execFile = promisify(execFileCallback);

export interface SyncGitRefTaskInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  operationId?: Ulid;
  now?: Date;
}

export interface SyncGitRefTaskResult {
  bundle: GitRefTaskBundleV1;
  remoteRevision: number;
  ownershipEpoch: number;
  receipt: string | null;
  changed: boolean;
}

export interface AcquireGitRefClaimInput extends SyncGitRefTaskInput {
  scope: unknown;
  ttlMs?: number;
  claimId?: Ulid;
  confirmScopeWarning?: boolean;
}

export interface AcquiredGitRefClaim {
  claim: ClaimV1;
  remoteRevision: number;
  ownershipEpoch: number;
  receipt: string;
}

export type GitRefClaimMutation =
  | { kind: 'renew'; ttlMs?: number }
  | { kind: 'release' }
  | { kind: 'reclaim'; reason: string }
  | { kind: 'revalidate' }
  | { kind: 'transfer'; toActorId: Ulid; successorClaimId?: Ulid };

export interface MutateGitRefClaimInput {
  projectRoot: string;
  claimId: Ulid;
  sessionId: Ulid;
  expectedClaimRevision: number;
  mutation: GitRefClaimMutation;
  operationId?: Ulid;
  now?: Date;
}

export interface MutatedGitRefClaim {
  claims: ClaimV1[];
  remoteRevision: number;
  ownershipEpoch: number;
  receipt: string;
}

export interface CreateGitRefHandoffDraftInput extends SyncGitRefTaskInput {
  toActorId: Ulid;
  claimIds?: Ulid[];
  summary?: HandoffSummary;
  handoffId?: Ulid;
}

export interface MutateGitRefHandoffInput {
  projectRoot: string;
  handoffId: Ulid;
  sessionId: Ulid;
  expectedHandoffRevision: number;
  mutation:
    | { kind: 'offer' | 'cancel'; reason?: string }
    | {
        kind: 'reject';
        reason: string;
      };
  operationId?: Ulid;
  now?: Date;
}

export interface AcceptGitRefHandoffInput {
  projectRoot: string;
  handoffId: Ulid;
  sessionId: Ulid;
  expectedHandoffRevision: number;
  successorClaimIds?: Ulid[];
  operationId?: Ulid;
  now?: Date;
  /** Persists the exact deterministic recovery target before the remote CAS. */
  beforeRemoteCommit?: (
    prepared: PreparedGitRefHandoffAcceptV1,
  ) => void | Promise<void>;
}

export interface MutatedGitRefHandoff {
  operationId: Ulid;
  handoff: HandoffV1;
  claims: ClaimV1[];
  remoteRevision: number;
  ownershipEpoch: number;
  receipt: string;
}

export interface GitRefHandoffForwardRepairPlanV1
  extends GitRefOwnershipForwardRepairV1 {
  schemaVersion: 1;
  handoffId: Ulid;
  predecessorClaimIds: Ulid[];
  successorClaimIds: Ulid[];
  bundleDigest: string;
  remoteRevision: number;
}

export interface GitRefHandoffForwardRepairTargetV1
  extends GitRefHandoffForwardRepairPlanV1 {
  receipt: string;
}

/** Immutable write-ahead payload produced from the fresh locked snapshot. */
export interface PreparedGitRefHandoffAcceptV1 {
  schemaVersion: 1;
  operationId: Ulid;
  expectedRemoteRevision: number;
  expectedOwnershipEpoch: number;
  targetRemoteRevision: number;
  targetOwnershipEpoch: number;
  predecessorBundle: GitRefTaskBundleV1;
  targetBundle: GitRefTaskBundleV1;
  forwardRepair: GitRefHandoffForwardRepairPlanV1;
}

export interface AcceptedGitRefHandoff extends MutatedGitRefHandoff {
  taskBundle: GitRefTaskBundleV1;
  forwardRepair: GitRefHandoffForwardRepairTargetV1;
}

/** Publishes only after a fresh pull and a task/owner/epoch CAS. */
export async function syncGitRefTask(
  input: SyncGitRefTaskInput,
): Promise<SyncGitRefTaskResult> {
  const taskRef = requireSharedTask(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    extraEntityLocks: [`remote:${contextLockKey(taskRef)}`],
    now,
  });
  try {
    await assertCleanGitWorktree(context.projectRoot);
    const transport = createGitRefTeamManifestStore(
      context.projectRoot,
      context.project.config,
      context.project.manifest,
    );
    const snapshot = await transport.pull();
    const bundle = await bundleFromContext(context, now);
    const result = await synchronizeBundle(
      context,
      transport,
      snapshot,
      bundle,
      operationId,
      now,
    );
    const refreshed = await transport.pull();
    await writeGitRefTeamCache(
      context.projectRoot,
      context.project.config,
      refreshed,
    );
    return { bundle, ...result };
  } finally {
    await context.release();
  }
}

/** Creates an active remote claim only after the remote CAS succeeds. */
export async function acquireGitRefClaim(
  input: AcquireGitRefClaimInput,
): Promise<AcquiredGitRefClaim> {
  const taskRef = requireSharedTask(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const claimId = input.claimId ?? createUlid(now.getTime());
  assertUlid(operationId, 'git-ref claim operationId');
  assertUlid(claimId, 'git-ref claimId');
  const scope = normalizeClaimScope(input.scope);
  const ttlMs = parseClaimTtl(input.ttlMs);
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    extraEntityLocks: [`claim:${claimId}`, `remote:${contextLockKey(taskRef)}`],
    now,
  });
  try {
    const transport = createGitRefTeamManifestStore(
      context.projectRoot,
      context.project.config,
      context.project.manifest,
    );
    let snapshot = await transport.pull();
    const bundle = await bundleFromContext(context, now);
    if (!remoteBundleMatches(snapshot, bundle)) {
      await assertCleanGitWorktree(context.projectRoot);
      const bootstrapOperationId = createUlid(now.getTime());
      await synchronizeBundle(
        context,
        transport,
        snapshot,
        bundle,
        bootstrapOperationId,
        now,
      );
      snapshot = await transport.pull();
    }
    const manifest = requireRemoteManifest(snapshot);
    const fence = requireRemoteFence(manifest, taskRef);
    const remote = context.project.config.transport.remote;
    if (remote === null) throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
    const remoteIdentityHash = await resolveGitRefRemoteIdentityHash(
      context.projectRoot,
      remote,
    );
    const timestamp = now.toISOString();
    const proposal = pendingRemoteClaim({
      context,
      taskRef,
      bundle,
      scope,
      claimId,
      operationId,
      remoteIdentityHash,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      timestamp,
    });
    const mutation = prepareGitRefCoordinationMutation(manifest, {
      kind: 'claim_acquire',
      operationId,
      actorId: context.session.actorId,
      taskRef,
      expectedRemoteRevision: manifest.revision,
      expectedOwnershipEpoch: fence.ownershipEpoch,
      claim: proposal,
      confirmScopeWarning: input.confirmScopeWarning,
      now,
    });
    const result = await transport.mutateCoordination(mutation);
    const refreshed = await transport.pull();
    await writeGitRefTeamCache(
      context.projectRoot,
      context.project.config,
      refreshed,
    );
    const claim = requireRemoteManifest(refreshed).claims.find(
      (candidate) => candidate.claimId === claimId,
    );
    if (claim === undefined || claim.state !== 'active') {
      throw new Error('MANCODE_REMOTE_RECEIPT_MISMATCH');
    }
    return {
      claim,
      remoteRevision: result.remoteRevision,
      ownershipEpoch: result.ownershipEpoch,
      receipt: result.receipt,
    };
  } finally {
    await context.release();
  }
}

/** Applies one lifecycle transition against the remote claim authority. */
export async function mutateGitRefClaim(
  input: MutateGitRefClaimInput,
): Promise<MutatedGitRefClaim> {
  assertUlid(input.claimId, 'git-ref claimId');
  assertUlid(input.sessionId, 'git-ref claim sessionId');
  if (
    !Number.isSafeInteger(input.expectedClaimRevision) ||
    input.expectedClaimRevision < 1
  ) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const projectStore = new V3ContextStore(input.projectRoot);
  const project = await projectStore.readProjectSnapshot();
  const transport = createGitRefTeamManifestStore(
    input.projectRoot,
    project.config,
    project.manifest,
  );
  const snapshot = await transport.pull();
  const manifest = requireRemoteManifest(snapshot);
  const claim = manifest.claims.find(
    (candidate) => candidate.claimId === input.claimId,
  );
  if (claim === undefined) throw new Error('MANCODE_CLAIM_NOT_FOUND');
  const taskRef = claim.taskRef;
  const bundle = requireRemoteBundle(manifest, taskRef);
  const fence = requireRemoteFence(manifest, taskRef);
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: bundle.taskRevision,
    operationId,
    extraEntityLocks: [
      `claim:${input.claimId}`,
      `remote:${contextLockKey(taskRef)}`,
    ],
    now,
  });
  try {
    assertContextMatchesRemoteBundle(context, bundle);
    const base = {
      operationId,
      actorId: context.session.actorId,
      taskRef,
      expectedRemoteRevision: manifest.revision,
      expectedOwnershipEpoch: fence.ownershipEpoch,
      claimId: input.claimId,
      expectedClaimRevision: input.expectedClaimRevision,
      now,
    };
    const mutation =
      input.mutation.kind === 'renew'
        ? prepareGitRefCoordinationMutation(manifest, {
            ...base,
            kind: 'claim_renew',
            expiresAt: new Date(
              now.getTime() + parseClaimTtl(input.mutation.ttlMs),
            ).toISOString(),
          })
        : input.mutation.kind === 'release'
          ? prepareGitRefCoordinationMutation(manifest, {
              ...base,
              kind: 'claim_release',
            })
          : input.mutation.kind === 'reclaim'
            ? prepareGitRefCoordinationMutation(manifest, {
                ...base,
                kind: 'claim_reclaim',
                reason: input.mutation.reason,
              })
            : input.mutation.kind === 'revalidate'
              ? prepareGitRefCoordinationMutation(manifest, {
                  ...base,
                  kind: 'claim_revalidate',
                })
              : prepareGitRefCoordinationMutation(manifest, {
                  ...base,
                  kind: 'claim_transfer',
                  toActorId: input.mutation.toActorId,
                  successorClaimId:
                    input.mutation.successorClaimId ??
                    createUlid(now.getTime()),
                });
    const result = await transport.mutateCoordination(mutation);
    const refreshed = await transport.pull();
    await writeGitRefTeamCache(
      context.projectRoot,
      context.project.config,
      refreshed,
    );
    return {
      claims: requireRemoteManifest(refreshed).claims.filter((candidate) =>
        sameTaskRef(candidate.taskRef, taskRef),
      ),
      remoteRevision: result.remoteRevision,
      ownershipEpoch: result.ownershipEpoch,
      receipt: result.receipt,
    };
  } finally {
    await context.release();
  }
}

/** Publishes a named remote draft from an already-synced checkpoint bundle. */
export async function createGitRefHandoffDraft(
  input: CreateGitRefHandoffDraftInput,
): Promise<MutatedGitRefHandoff> {
  const taskRef = requireSharedTask(input.taskRef);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const handoffId = input.handoffId ?? createUlid(now.getTime());
  assertUlid(operationId, 'git-ref handoff draft operationId');
  assertUlid(handoffId, 'git-ref handoffId');
  assertUlid(input.toActorId, 'git-ref handoff recipient actorId');
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    extraEntityLocks: [
      `handoff:${handoffId}`,
      `remote:${contextLockKey(taskRef)}`,
    ],
    now,
  });
  try {
    const transport = createGitRefTeamManifestStore(
      context.projectRoot,
      context.project.config,
      context.project.manifest,
    );
    const snapshot = await transport.pull();
    const manifest = requireRemoteManifest(snapshot);
    const bundle = requireRemoteBundle(manifest, taskRef);
    const fence = requireRemoteFence(manifest, taskRef);
    assertContextMatchesRemoteBundle(context, bundle);
    await Promise.all([
      assertGitRefBundleCodeReachable(context.projectRoot, bundle),
      assertCleanGitWorktree(context.projectRoot),
    ]);
    const checkpoint = context.task.latestCheckpoint;
    if (
      checkpoint === null ||
      bundle.aggregate.latestCheckpointId !== checkpoint.checkpointId
    ) {
      throw new Error('MANCODE_HANDOFF_CHECKPOINT_REQUIRED');
    }
    const claimIds =
      input.claimIds ??
      manifest.claims
        .filter(
          (claim) =>
            sameTaskRef(claim.taskRef, taskRef) &&
            claim.state === 'active' &&
            claim.ownerActorId === context.session.actorId,
        )
        .map((claim) => claim.claimId);
    const timestamp = now.toISOString();
    const proposal = parseHandoff({
      schemaVersion: 1,
      handoffId,
      taskRef,
      taskRevision: bundle.taskRevision,
      ownershipEpochAtOffer: fence.ownershipEpoch,
      state: 'draft',
      revision: 1,
      fromActorId: context.session.actorId,
      toActorId: input.toActorId,
      claimIds,
      checkpointRef: {
        taskRef,
        kind: 'checkpoint',
        artifactId: checkpoint.checkpointId,
      },
      summary: input.summary ?? defaultRemoteHandoffSummary(checkpoint),
      transport: {
        mode: 'git-ref',
        state: 'stale',
        transportRevision: null,
        publishedAt: null,
        fetchedAt: null,
        taskBundleDigest: bundle.bundleDigest,
        codeRef: bundle.codeRef,
        codeReachable: true,
        receipt: null,
      },
      lastOperationId: null,
      offeredAt: null,
      resolution: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const mutation = prepareGitRefCoordinationMutation(manifest, {
      kind: 'handoff_draft',
      operationId,
      actorId: context.session.actorId,
      taskRef,
      expectedRemoteRevision: manifest.revision,
      expectedOwnershipEpoch: fence.ownershipEpoch,
      handoff: proposal,
      now,
    });
    const result = await transport.mutateCoordination(mutation);
    return finishHandoffMutation(
      context,
      transport,
      handoffId,
      operationId,
      result,
      'draft',
    );
  } finally {
    await context.release();
  }
}

/** Applies offer/reject/cancel after a fresh pull and one remote CAS. */
export async function mutateGitRefHandoff(
  input: MutateGitRefHandoffInput,
): Promise<MutatedGitRefHandoff> {
  assertUlid(input.handoffId, 'git-ref handoffId');
  assertUlid(input.sessionId, 'git-ref handoff sessionId');
  assertPositiveRevision(
    input.expectedHandoffRevision,
    'git-ref expectedHandoffRevision',
  );
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const opened = await openRemoteHandoffOperation({
    projectRoot: input.projectRoot,
    handoffId: input.handoffId,
    sessionId: input.sessionId,
    operationId,
    expectedHandoffRevision: input.expectedHandoffRevision,
    now,
  });
  try {
    if (input.mutation.kind === 'offer') {
      await assertCleanGitWorktree(opened.context.projectRoot);
    }
    const kind =
      input.mutation.kind === 'offer'
        ? 'handoff_offer'
        : input.mutation.kind === 'reject'
          ? 'handoff_reject'
          : 'handoff_cancel';
    const mutation = prepareGitRefCoordinationMutation(opened.manifest, {
      kind,
      operationId,
      actorId: opened.context.session.actorId,
      taskRef: opened.handoff.taskRef,
      expectedRemoteRevision: opened.manifest.revision,
      expectedOwnershipEpoch: opened.fence.ownershipEpoch,
      handoffId: opened.handoff.handoffId,
      expectedHandoffRevision: input.expectedHandoffRevision,
      reason: input.mutation.reason,
      now,
    });
    const result = await opened.transport.mutateCoordination(mutation);
    return finishHandoffMutation(
      opened.context,
      opened.transport,
      opened.handoff.handoffId,
      operationId,
      result,
      input.mutation.kind === 'offer'
        ? 'offered'
        : input.mutation.kind === 'reject'
          ? 'rejected'
          : 'cancelled',
    );
  } finally {
    await opened.context.release();
  }
}

/**
 * Commits the remote ownership transfer and returns the exact durable target
 * a local journal must converge to. This function does not edit local task
 * metadata after the external commit point.
 */
export async function acceptGitRefHandoff(
  input: AcceptGitRefHandoffInput,
): Promise<AcceptedGitRefHandoff> {
  assertUlid(input.handoffId, 'git-ref handoffId');
  assertUlid(input.sessionId, 'git-ref handoff sessionId');
  assertPositiveRevision(
    input.expectedHandoffRevision,
    'git-ref expectedHandoffRevision',
  );
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const opened = await openRemoteHandoffOperation({
    projectRoot: input.projectRoot,
    handoffId: input.handoffId,
    sessionId: input.sessionId,
    operationId,
    expectedHandoffRevision: input.expectedHandoffRevision,
    now,
  });
  try {
    const successorClaimIds =
      input.successorClaimIds ??
      opened.handoff.claimIds.map((claimId) =>
        handoffSuccessorClaimId(operationId, claimId, opened.handoff.createdAt),
      );
    const taskBundle = buildAcceptedHandoffBundle(
      opened.context,
      opened.bundle,
      opened.handoff,
      operationId,
      now,
    );
    const mutation = prepareGitRefCoordinationMutation(opened.manifest, {
      kind: 'handoff_accept',
      operationId,
      actorId: opened.context.session.actorId,
      taskRef: opened.handoff.taskRef,
      expectedRemoteRevision: opened.manifest.revision,
      expectedOwnershipEpoch: opened.fence.ownershipEpoch,
      handoffId: opened.handoff.handoffId,
      expectedHandoffRevision: input.expectedHandoffRevision,
      successorClaimIds,
      taskBundle,
      codeReachable: true,
      now,
    });
    if (mutation.forwardRepair === null) {
      throw new Error('MANCODE_REMOTE_FORWARD_REPAIR_TARGET_MISSING');
    }
    const forwardRepair: GitRefHandoffForwardRepairPlanV1 = {
      schemaVersion: 1,
      ...mutation.forwardRepair,
      handoffId: opened.handoff.handoffId,
      predecessorClaimIds: [...opened.handoff.claimIds],
      successorClaimIds: [...successorClaimIds],
      bundleDigest: taskBundle.bundleDigest,
      remoteRevision: opened.manifest.revision + 1,
    };
    const prepared = freezeDeep({
      schemaVersion: 1 as const,
      operationId,
      expectedRemoteRevision: opened.manifest.revision,
      expectedOwnershipEpoch: opened.fence.ownershipEpoch,
      targetRemoteRevision: opened.manifest.revision + 1,
      targetOwnershipEpoch: mutation.forwardRepair.ownershipEpoch,
      predecessorBundle: opened.bundle,
      targetBundle: taskBundle,
      forwardRepair,
    });
    await input.beforeRemoteCommit?.(prepared);
    const result = await opened.transport.mutateCoordination(mutation);
    const completed = await finishHandoffMutation(
      opened.context,
      opened.transport,
      opened.handoff.handoffId,
      operationId,
      result,
      'accepted',
    );
    return {
      ...completed,
      taskBundle,
      forwardRepair: {
        ...forwardRepair,
        receipt: result.receipt,
      },
    };
  } finally {
    await opened.context.release();
  }
}

interface OpenedRemoteHandoffOperation {
  context: OpenedV3TaskOperation;
  transport: GitRefTeamManifestStore;
  manifest: GitRefTeamManifestV1;
  fence: GitRefTeamManifestV1['ownershipFences'][number];
  bundle: GitRefTaskBundleV1;
  handoff: HandoffV1;
}

async function openRemoteHandoffOperation(input: {
  projectRoot: string;
  handoffId: Ulid;
  sessionId: Ulid;
  expectedHandoffRevision: number;
  operationId: Ulid;
  now: Date;
}): Promise<OpenedRemoteHandoffOperation> {
  const project = await new V3ContextStore(
    input.projectRoot,
  ).readProjectSnapshot();
  const transport = createGitRefTeamManifestStore(
    input.projectRoot,
    project.config,
    project.manifest,
  );
  const manifest = requireRemoteManifest(await transport.pull());
  const handoff = manifest.handoffs.find(
    (candidate) => candidate.handoffId === input.handoffId,
  );
  if (handoff === undefined) throw new Error('MANCODE_HANDOFF_NOT_FOUND');
  if (handoff.revision !== input.expectedHandoffRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  const bundle = requireRemoteBundle(manifest, handoff.taskRef);
  const fence = requireRemoteFence(manifest, handoff.taskRef);
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef: handoff.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: bundle.taskRevision,
    operationId: input.operationId,
    extraEntityLocks: [
      `handoff:${handoff.handoffId}`,
      ...handoff.claimIds.map((claimId) => `claim:${claimId}`),
      `remote:${contextLockKey(handoff.taskRef)}`,
    ],
    now: input.now,
  });
  try {
    assertContextMatchesRemoteBundle(context, bundle);
    await assertGitRefBundleCodeReachable(context.projectRoot, bundle);
    return { context, transport, manifest, fence, bundle, handoff };
  } catch (error) {
    await context.release();
    throw error;
  }
}

async function finishHandoffMutation(
  context: OpenedV3TaskOperation,
  transport: GitRefTeamManifestStore,
  handoffId: Ulid,
  operationId: Ulid,
  result: { receipt: string; remoteRevision: number; ownershipEpoch: number },
  expectedState: HandoffV1['state'],
): Promise<MutatedGitRefHandoff> {
  const refreshed = await transport.pull();
  await writeGitRefTeamCache(
    context.projectRoot,
    context.project.config,
    refreshed,
  );
  const manifest = requireRemoteManifest(refreshed);
  const handoff = manifest.handoffs.find(
    (candidate) => candidate.handoffId === handoffId,
  );
  if (
    handoff === undefined ||
    handoff.state !== expectedState ||
    handoff.lastOperationId !== operationId ||
    manifest.lastMutation?.operationId !== operationId ||
    manifest.revision !== result.remoteRevision ||
    refreshed.receipt !== result.receipt
  ) {
    throw new Error('MANCODE_REMOTE_RECEIPT_MISMATCH');
  }
  return {
    operationId,
    handoff,
    claims: manifest.claims.filter((claim) =>
      sameTaskRef(claim.taskRef, handoff.taskRef),
    ),
    remoteRevision: result.remoteRevision,
    ownershipEpoch: result.ownershipEpoch,
    receipt: result.receipt,
  };
}

function buildAcceptedHandoffBundle(
  context: OpenedV3TaskOperation,
  currentBundle: GitRefTaskBundleV1,
  handoff: HandoffV1,
  operationId: Ulid,
  now: Date,
): GitRefTaskBundleV1 {
  const metadata = parseWorkflowMetadata({
    ...context.task.metadata,
    revision: context.task.metadata.revision + 2,
    transitionState: 'stable',
    lastOperationId: operationId,
    ownerActorId: handoff.toActorId,
    ownershipEpoch: context.task.metadata.ownershipEpoch + 1,
    updatedAt: now.toISOString(),
  });
  const aggregate = buildTaskAggregateManifest({
    metadata,
    requirements: context.task.requirements,
    review: context.task.review,
    verification: context.task.verification,
    planDigest: context.task.plan?.digest ?? null,
    latestCheckpoint: context.task.latestCheckpoint,
  });
  return createGitRefTaskBundle({
    task: { ...context.task, metadata, aggregate },
    codeRef: currentBundle.codeRef,
    now,
  });
}

function defaultRemoteHandoffSummary(checkpoint: CheckpointV1): HandoffSummary {
  return {
    completed: [],
    inProgress: [],
    notStarted: [],
    changedFiles: [],
    verification: [],
    blockers: [],
    risks: [],
    nextAction: checkpoint.nextAction,
  };
}

async function assertCleanGitWorktree(projectRoot: string): Promise<void> {
  const { stdout } = await execFile(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: projectRoot, windowsHide: true },
  );
  if (stdout.trim()) throw new Error('MANCODE_HANDOFF_DIRTY_WORKTREE');
}

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

async function synchronizeBundle(
  context: OpenedV3TaskOperation,
  transport: GitRefTeamManifestStore,
  snapshot: GitRefTeamManifestSnapshot,
  bundle: GitRefTaskBundleV1,
  operationId: Ulid,
  now: Date,
): Promise<Omit<SyncGitRefTaskResult, 'bundle'>> {
  const manifest = requireRemoteManifest(snapshot);
  const fence = manifest.ownershipFences.find((candidate) =>
    sameTaskRef(candidate.taskRef, context.taskRef),
  );
  if (fence === undefined) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_REQUIRED');
  }
  if (remoteBundleMatches(snapshot, bundle)) {
    return {
      remoteRevision: manifest.revision,
      ownershipEpoch: fence.ownershipEpoch,
      receipt: snapshot.receipt,
      changed: false,
    };
  }
  const mutation = prepareGitRefCoordinationMutation(manifest, {
    kind: 'ownership_fence',
    operationId,
    actorId: context.session.actorId,
    taskRef: context.taskRef,
    expectedRemoteRevision: manifest.revision,
    expectedOwnershipEpoch: fence.ownershipEpoch,
    taskBundle: bundle,
    now,
  });
  const result = await transport.mutateCoordination(mutation);
  return { ...result, changed: true };
}

async function bundleFromContext(
  context: OpenedV3TaskOperation,
  now: Date,
): Promise<GitRefTaskBundleV1> {
  if (context.codeHead === null) {
    throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
  }
  return createGitRefTaskBundle({
    task: context.task,
    codeRef: {
      branch: (await readCheckoutBranch(context.projectRoot)) ?? 'HEAD',
      head: context.codeHead,
    },
    now,
  });
}

function pendingRemoteClaim(input: {
  context: OpenedV3TaskOperation;
  taskRef: TaskRef;
  bundle: GitRefTaskBundleV1;
  scope: ClaimScope;
  claimId: Ulid;
  operationId: Ulid;
  remoteIdentityHash: string;
  expiresAt: string;
  timestamp: string;
}): ClaimV1 {
  return parseClaim({
    schemaVersion: 1,
    claimId: input.claimId,
    workspaceId: input.context.runtime.workspaceId,
    coordinationDomainId: gitRefCoordinationDomainId(
      input.remoteIdentityHash,
      input.context.runtime.workspaceId,
      input.context.project.config.transport.epoch,
    ),
    authority: { mode: 'git-ref', remoteRevision: null },
    taskRef: input.taskRef,
    taskRevisionAtAcquire: input.bundle.taskRevision,
    lastValidatedTaskRevision: input.bundle.taskRevision,
    implementationScopeDigest:
      input.context.task.metadata.implementationScope.digest,
    ownershipEpochAtAcquire: input.bundle.ownershipEpoch,
    ownerActorId: input.context.session.actorId,
    state: 'pending',
    revision: 1,
    scope: input.scope,
    scopeDigest: digestScope(input.scope),
    codeRefAtAcquire: input.bundle.codeRef,
    lastValidatedCodeRef: input.bundle.codeRef,
    acquisitionEnforcement: 'enforced',
    writeGuard: 'advisory',
    expiresAt: input.expiresAt,
    predecessorClaimId: null,
    successorClaimId: null,
    lastOperationId: input.operationId,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  });
}

function remoteBundleMatches(
  snapshot: GitRefTeamManifestSnapshot,
  bundle: GitRefTaskBundleV1,
): boolean {
  const remote = snapshot.manifest?.taskBundles.find((candidate) =>
    sameTaskRef(candidate.taskRef, bundle.taskRef),
  );
  return (
    remote !== undefined &&
    remote.aggregateDigest === bundle.aggregateDigest &&
    remote.taskRevision === bundle.taskRevision &&
    remote.ownershipEpoch === bundle.ownershipEpoch &&
    remote.codeRef.branch === bundle.codeRef.branch &&
    remote.codeRef.head === bundle.codeRef.head
  );
}

function requireRemoteManifest(snapshot: GitRefTeamManifestSnapshot) {
  if (snapshot.manifest === null) {
    throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_JOINED');
  }
  return snapshot.manifest;
}

function requireRemoteFence(
  manifest: NonNullable<GitRefTeamManifestSnapshot['manifest']>,
  taskRef: TaskRef,
) {
  const fence = manifest.ownershipFences.find((candidate) =>
    sameTaskRef(candidate.taskRef, taskRef),
  );
  if (fence === undefined) {
    throw new Error('MANCODE_REMOTE_OWNERSHIP_FENCE_MISSING');
  }
  return fence;
}

function requireRemoteBundle(
  manifest: NonNullable<GitRefTeamManifestSnapshot['manifest']>,
  taskRef: TaskRef,
): GitRefTaskBundleV1 {
  const bundle = manifest.taskBundles.find((candidate) =>
    sameTaskRef(candidate.taskRef, taskRef),
  );
  if (bundle === undefined) throw new Error('MANCODE_TASK_UNAVAILABLE');
  return bundle;
}

function assertContextMatchesRemoteBundle(
  context: OpenedV3TaskOperation,
  bundle: GitRefTaskBundleV1,
): void {
  if (
    context.task.aggregate === null ||
    taskAggregateDigest(context.task.aggregate) !== bundle.aggregateDigest ||
    context.codeHead !== bundle.codeRef.head
  ) {
    throw new Error('MANCODE_TASK_BUNDLE_DIVERGED');
  }
}

function requireSharedTask(value: TaskRef): TaskRef {
  const taskRef = parseTaskRefValue(value);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_REMOTE_COORDINATION_REQUIRES_SHARED_TASK');
  }
  return taskRef;
}

function contextLockKey(taskRef: TaskRef): string {
  return `git-ref-${taskRef.taskId}`;
}

function digestScope(scope: ClaimScope): string {
  return digestCanonicalJson(scope);
}

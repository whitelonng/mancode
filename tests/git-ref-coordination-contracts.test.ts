import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
  taskAggregateDigest,
} from '../src/context/aggregate.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { V3ContextStore } from '../src/context/store.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
  workflowMetadataDigest,
} from '../src/context/workflow-metadata.js';
import { createSession } from '../src/runtime/session.js';
import { gitRefCoordinationDomainId } from '../src/runtime/workspace-binding.js';
import {
  type SharedActorProfileV1,
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import type { ClaimV1 } from '../src/team/claims.js';
import { createGitRefTaskBundle } from '../src/team/git-ref-bundle.js';
import {
  type PreparedGitRefCoordinationMutation,
  materializeGitRefCoordination,
  prepareGitRefCoordinationMutation,
} from '../src/team/git-ref-coordination.js';
import type {
  GitRefOwnershipFenceV1,
  GitRefTaskBundleV1,
  GitRefTeamManifestV1,
} from '../src/team/git-ref-transport.js';
import { GitRefTeamManifestStore } from '../src/team/git-ref-transport.js';
import { resolveGitRefRemoteIdentityHash } from '../src/team/git-ref-transport.js';
import type { HandoffV1 } from '../src/team/handoff.js';
import {
  CONFIRMED_MANTEAM_PLAN,
  confirmManteamPlan,
} from './helpers/manteam-plan.js';

const execFile = promisify(execFileCallback);
const TASK_REF: TaskRef = { namespace: 'shared', taskId: id(1) };
const WORKSPACE_ID = id(2);
const OWNER_ID = id(3);
const RECEIVER_ID = id(4);
const CLAIM_ID = id(5);
const HANDOFF_ID = id(6);
const CHECKPOINT_ID = id(7);
const NOW = new Date('2026-07-18T10:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('git-ref coordination domain contracts', () => {
  it('bootstraps a revision-zero ownership fence without copying workflow authority', () => {
    const empty = {
      ...baseManifest(),
      ownershipFences: [],
      taskBundles: [],
    };
    const initialBundle = bundle(metadata({ ownershipEpoch: 0, revision: 1 }));

    const prepared = prepareGitRefCoordinationMutation(empty, {
      kind: 'ownership_fence',
      operationId: id(19),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 1,
      expectedOwnershipEpoch: 0,
      expectedPredecessorBundleDigest: null,
      taskBundle: initialBundle,
      now: NOW,
    });

    expect(prepared.ownershipFence).toEqual({
      schemaVersion: 1,
      taskRef: TASK_REF,
      ownerActorId: OWNER_ID,
      ownershipEpoch: 0,
      taskRevision: 1,
      aggregateDigest: initialBundle.aggregateDigest,
      remoteRevision: 2,
      lastOperationId: id(19),
      updatedAt: NOW.toISOString(),
    });
  });

  it('advances an owner code ref and refreshes only the owner claim in one CAS', () => {
    const current = baseManifest({ claims: [activeClaim()] });
    const previous = current.taskBundles[0];
    if (previous === undefined) throw new Error('missing current task bundle');
    const nextBundle = bundleWithCodeHead(previous, 'def5678');

    const prepared = prepareGitRefCoordinationMutation(current, {
      kind: 'ownership_fence',
      operationId: id(24),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 1,
      expectedOwnershipEpoch: 1,
      expectedPredecessorBundleDigest: previous.bundleDigest,
      taskBundle: nextBundle,
      now: NOW,
    });

    expect(prepared.ownershipFence).toMatchObject({
      taskRevision: previous.taskRevision,
      aggregateDigest: previous.aggregateDigest,
      ownerActorId: OWNER_ID,
    });
    expect(prepared.claims[0]).toMatchObject({
      claimId: CLAIM_ID,
      revision: 2,
      lastValidatedTaskRevision: nextBundle.taskRevision,
      lastValidatedCodeRef: nextBundle.codeRef,
      authority: { remoteRevision: '2' },
    });

    expect(() =>
      prepareGitRefCoordinationMutation(current, {
        kind: 'ownership_fence',
        operationId: id(25),
        actorId: OWNER_ID,
        taskRef: TASK_REF,
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 1,
        expectedPredecessorBundleDigest: bundleWithCodeHead(previous, 'fedcba9')
          .bundleDigest,
        taskBundle: nextBundle,
        now: NOW,
      }),
    ).toThrow('MANCODE_TASK_BUNDLE_DIVERGED');

    const participantClaim = baseManifest({
      claims: [activeClaim({ ownerActorId: RECEIVER_ID })],
    });
    const participantPrepared = prepareGitRefCoordinationMutation(
      participantClaim,
      {
        kind: 'ownership_fence',
        operationId: id(26),
        actorId: OWNER_ID,
        taskRef: TASK_REF,
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 1,
        expectedPredecessorBundleDigest: previous.bundleDigest,
        taskBundle: nextBundle,
        now: NOW,
      },
    );
    expect(participantPrepared.claims[0]).toEqual(participantClaim.claims[0]);
    const participantRevalidated = prepareGitRefCoordinationMutation(
      commitPrepared(participantClaim, participantPrepared),
      {
        kind: 'claim_revalidate',
        operationId: id(27),
        actorId: RECEIVER_ID,
        taskRef: TASK_REF,
        expectedRemoteRevision: 2,
        expectedOwnershipEpoch: 1,
        claimId: CLAIM_ID,
        expectedClaimRevision: 1,
        now: NOW,
      },
    );
    expect(participantRevalidated.claims[0]).toMatchObject({
      revision: 2,
      lastValidatedCodeRef: nextBundle.codeRef,
    });

    const completedBundle = bundle(metadata({ status: 'completed' }));
    const completed = {
      ...baseManifest(),
      ownershipFences: [fence(completedBundle)],
      taskBundles: [completedBundle],
    };
    expect(() =>
      prepareGitRefCoordinationMutation(completed, {
        kind: 'ownership_fence',
        operationId: id(28),
        actorId: OWNER_ID,
        taskRef: TASK_REF,
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 1,
        expectedPredecessorBundleDigest: completedBundle.bundleDigest,
        taskBundle: bundleWithCodeHead(completedBundle, 'def5678'),
        now: NOW,
      }),
    ).toThrow('MANCODE_REMOTE_COORDINATION_TASK_INVALID');
  });

  it('materializes remote handoffs as fetched without changing business state', () => {
    const current = {
      ...baseManifest({
        claims: [activeClaim()],
        handoffs: [cancelledHandoff()],
      }),
      taskBundles: [],
    };

    const result = materializeGitRefCoordination(
      current,
      '2026-07-18T10:01:00.000Z',
    );

    expect(result).toMatchObject({
      remoteRevision: 1,
      claims: [{ claimId: CLAIM_ID, state: 'active' }],
      handoffs: [
        {
          handoffId: HANDOFF_ID,
          state: 'cancelled',
          transport: {
            state: 'fetched',
            fetchedAt: '2026-07-18T10:01:00.000Z',
          },
        },
      ],
    });
    expect(current.handoffs[0]?.transport.state).toBe('published');
  });

  it('rejects stale ownership epochs and fresh blocking scope conflicts', () => {
    const current = baseManifest({ claims: [activeClaim()] });
    expect(() =>
      prepareGitRefCoordinationMutation(current, {
        kind: 'claim_release',
        operationId: id(20),
        actorId: OWNER_ID,
        taskRef: TASK_REF,
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 0,
        claimId: CLAIM_ID,
        expectedClaimRevision: 1,
        now: NOW,
      }),
    ).toThrow('MANCODE_OWNERSHIP_EPOCH_STALE');

    expect(() =>
      prepareGitRefCoordinationMutation(current, {
        kind: 'claim_acquire',
        operationId: id(21),
        actorId: RECEIVER_ID,
        taskRef: TASK_REF,
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 1,
        claim: pendingClaim({
          claimId: id(22),
          ownerActorId: RECEIVER_ID,
        }),
        now: NOW,
      }),
    ).toThrow('MANCODE_SCOPE_CONFLICT');

    expect(() =>
      prepareGitRefCoordinationMutation(current, {
        kind: 'ownership_fence',
        operationId: id(23),
        actorId: OWNER_ID,
        taskRef: TASK_REF,
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 1,
        expectedPredecessorBundleDigest:
          current.taskBundles[0]?.bundleDigest ?? null,
        taskBundle: bundle(
          metadata({ task: 'A divergent task at the same remote revision.' }),
        ),
        now: NOW,
      }),
    ).toThrow('MANCODE_SPLIT_BRAIN');
  });

  it('prepares the complete remote claim lifecycle', () => {
    let current = baseManifest();
    const acquired = prepareGitRefCoordinationMutation(current, {
      kind: 'claim_acquire',
      operationId: id(30),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 1,
      expectedOwnershipEpoch: 1,
      claim: pendingClaim(),
      now: NOW,
    });
    expect(acquired.claims).toMatchObject([
      {
        claimId: CLAIM_ID,
        state: 'active',
        revision: 1,
        authority: { mode: 'git-ref', remoteRevision: '2' },
      },
    ]);

    current = commitPrepared(current, acquired);
    const renewed = prepareGitRefCoordinationMutation(current, {
      kind: 'claim_renew',
      operationId: id(31),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 2,
      expectedOwnershipEpoch: 1,
      claimId: CLAIM_ID,
      expectedClaimRevision: 1,
      expiresAt: '2026-08-20T10:00:00.000Z',
      now: NOW,
    });
    expect(renewed.claims[0]).toMatchObject({ revision: 2 });

    current = commitPrepared(current, renewed);
    const advancedFence = prepareGitRefCoordinationMutation(current, {
      kind: 'ownership_fence',
      operationId: id(32),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 3,
      expectedOwnershipEpoch: 1,
      expectedPredecessorBundleDigest:
        current.taskBundles[0]?.bundleDigest ?? null,
      taskBundle: bundle(metadata({ revision: 8 })),
      now: NOW,
    });
    current = commitPrepared(current, advancedFence);
    const revalidated = prepareGitRefCoordinationMutation(current, {
      kind: 'claim_revalidate',
      operationId: id(33),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 4,
      expectedOwnershipEpoch: 1,
      claimId: CLAIM_ID,
      expectedClaimRevision: 2,
      now: NOW,
    });
    expect(revalidated.claims[0]).toMatchObject({
      revision: 3,
      lastValidatedTaskRevision: 8,
    });

    current = commitPrepared(current, revalidated);
    const transferred = prepareGitRefCoordinationMutation(current, {
      kind: 'claim_transfer',
      operationId: id(34),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 5,
      expectedOwnershipEpoch: 1,
      claimId: CLAIM_ID,
      expectedClaimRevision: 3,
      toActorId: RECEIVER_ID,
      successorClaimId: id(35),
      now: NOW,
    });
    expect(transferred.claims).toMatchObject([
      { claimId: CLAIM_ID, state: 'transferred', successorClaimId: id(35) },
      {
        claimId: id(35),
        state: 'active',
        ownerActorId: RECEIVER_ID,
        predecessorClaimId: CLAIM_ID,
      },
    ]);

    current = commitPrepared(current, transferred);
    const released = prepareGitRefCoordinationMutation(current, {
      kind: 'claim_release',
      operationId: id(36),
      actorId: RECEIVER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 6,
      expectedOwnershipEpoch: 1,
      claimId: id(35),
      expectedClaimRevision: 1,
      now: NOW,
    });
    expect(released.claims[1]).toMatchObject({
      state: 'released',
      revision: 2,
    });

    const expired = baseManifest({
      claims: [
        activeClaim({
          expiresAt: '2026-07-18T09:00:00.000Z',
        }),
      ],
    });
    const reclaimed = prepareGitRefCoordinationMutation(expired, {
      kind: 'claim_reclaim',
      operationId: id(37),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 1,
      expectedOwnershipEpoch: 1,
      claimId: CLAIM_ID,
      expectedClaimRevision: 1,
      reason: 'The remote claim expired and was confirmed from a fresh pull.',
      now: NOW,
    });
    expect(reclaimed.claims[0]).toMatchObject({
      state: 'expired',
      revision: 2,
    });
  });

  it('prepares draft, offer, reject, and cancel through the remote state machine', () => {
    let current = baseManifest({ claims: [activeClaim()] });
    const drafted = prepareGitRefCoordinationMutation(current, {
      kind: 'handoff_draft',
      operationId: id(40),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 1,
      expectedOwnershipEpoch: 1,
      handoff: draftHandoff(),
      now: NOW,
    });
    expect(drafted.handoffs[0]).toMatchObject({
      state: 'draft',
      transport: { state: 'published', transportRevision: 2 },
    });

    current = commitPrepared(current, drafted);
    const offered = prepareGitRefCoordinationMutation(current, {
      kind: 'handoff_offer',
      operationId: id(41),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 2,
      expectedOwnershipEpoch: 1,
      handoffId: HANDOFF_ID,
      expectedHandoffRevision: 1,
      now: NOW,
    });
    expect(offered.handoffs[0]).toMatchObject({
      state: 'offered',
      revision: 2,
    });

    current = commitPrepared(current, offered);
    const rejected = prepareGitRefCoordinationMutation(current, {
      kind: 'handoff_reject',
      operationId: id(42),
      actorId: RECEIVER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 3,
      expectedOwnershipEpoch: 1,
      handoffId: HANDOFF_ID,
      expectedHandoffRevision: 2,
      reason: 'The receiver needs a narrower implementation scope.',
      now: NOW,
    });
    expect(rejected.handoffs[0]).toMatchObject({
      state: 'rejected',
      revision: 3,
      resolution: { actorId: RECEIVER_ID },
    });

    const cancellable = commitPrepared(
      baseManifest({ claims: [activeClaim()] }),
      prepareGitRefCoordinationMutation(
        baseManifest({ claims: [activeClaim()] }),
        {
          kind: 'handoff_draft',
          operationId: id(43),
          actorId: OWNER_ID,
          taskRef: TASK_REF,
          expectedRemoteRevision: 1,
          expectedOwnershipEpoch: 1,
          handoff: draftHandoff({ handoffId: id(44) }),
          now: NOW,
        },
      ),
    );
    const cancelled = prepareGitRefCoordinationMutation(cancellable, {
      kind: 'handoff_cancel',
      operationId: id(45),
      actorId: OWNER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 2,
      expectedOwnershipEpoch: 1,
      handoffId: id(44),
      expectedHandoffRevision: 1,
      now: NOW,
    });
    expect(cancelled.handoffs[0]).toMatchObject({ state: 'cancelled' });
  });

  it('atomically accepts a handoff by advancing owner, epoch, claims, and repair target', () => {
    const current = baseManifest({
      claims: [activeClaim()],
      handoffs: [offeredHandoff()],
    });
    const nextBundle = bundle(
      metadata({
        ownerActorId: RECEIVER_ID,
        ownershipEpoch: 2,
        revision: 9,
        lastOperationId: id(50),
      }),
    );

    const accepted = prepareGitRefCoordinationMutation(current, {
      kind: 'handoff_accept',
      operationId: id(50),
      actorId: RECEIVER_ID,
      taskRef: TASK_REF,
      expectedRemoteRevision: 1,
      expectedOwnershipEpoch: 1,
      handoffId: HANDOFF_ID,
      expectedHandoffRevision: 2,
      successorClaimIds: [id(51)],
      taskBundle: nextBundle,
      codeReachable: true,
      now: NOW,
    });

    expect(accepted.ownershipFence).toMatchObject({
      ownerActorId: RECEIVER_ID,
      ownershipEpoch: 2,
      taskRevision: 9,
      remoteRevision: 2,
      lastOperationId: id(50),
    });
    expect(accepted.handoffs).toMatchObject([
      {
        handoffId: HANDOFF_ID,
        state: 'accepted',
        revision: 3,
        transport: { taskBundleDigest: nextBundle.bundleDigest },
      },
    ]);
    expect(accepted.claims).toMatchObject([
      { claimId: CLAIM_ID, state: 'transferred', successorClaimId: id(51) },
      {
        claimId: id(51),
        state: 'active',
        ownerActorId: RECEIVER_ID,
        ownershipEpochAtAcquire: 2,
        taskRevisionAtAcquire: 9,
      },
    ]);
    expect(accepted.forwardRepair).toMatchObject({
      ownerActorId: RECEIVER_ID,
      ownershipEpoch: 2,
      operationId: id(50),
    });
  });

  it('feeds participant claim and recipient reject mutations directly into the git-ref store', async () => {
    const fixture = await createRemoteFixture();
    await initializeV3Project({
      projectRoot: fixture.clone,
      operationId: id(80),
      workspaceId: WORKSPACE_ID,
      schemaEpoch: id(81),
      now: NOW,
    });
    const localOwner = await createLocalActor(fixture.clone, {
      actorId: OWNER_ID,
      displayName: 'Owner',
      now: NOW,
    });
    await publishSharedActorProfile(
      fixture.clone,
      createSharedActorProfile(localOwner, NOW),
    );
    const sessionId = id(82);
    await createSession(fixture.clone, {
      actorId: OWNER_ID,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now: NOW,
    });
    const workflow = await createV3Workflow({
      projectRoot: fixture.clone,
      task: 'Exercise a prepared remote coordination mutation.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: { include: ['src/auth/**'], modules: ['auth'] },
      taskId: TASK_REF.taskId,
      operationId: id(83),
      now: NOW,
    });
    await confirmManteamPlan({
      projectRoot: fixture.clone,
      taskRef: workflow.taskRef,
      sessionId,
      requirements: workflow.requirements,
      now: NOW,
    });
    const stored = await new V3ContextStore(fixture.clone).readTaskSnapshot(
      workflow.taskRef,
    );
    const sharedMetadata = parseWorkflowMetadata({
      ...stored.metadata,
      participants: [OWNER_ID, RECEIVER_ID],
    });
    const aggregate = buildTaskAggregateManifest({
      metadata: sharedMetadata,
      requirements: stored.requirements,
      review: stored.review,
      verification: stored.verification,
      planDigest: stored.plan?.digest ?? null,
      latestCheckpoint: stored.latestCheckpoint,
    });
    const taskBundle = createGitRefTaskBundle({
      task: { ...stored, metadata: sharedMetadata, aggregate },
      codeRef: { branch: 'main', head: fixture.head },
      now: NOW,
    });
    const store = new GitRefTeamManifestStore({
      projectRoot: fixture.clone,
      remote: 'origin',
      workspaceId: WORKSPACE_ID,
      schemaEpoch: id(81),
      now: () => NOW,
    });
    const establishOperationId = id(84);
    await store.establishCoordinationAuthority({
      operationId: establishOperationId,
      actorId: OWNER_ID,
      expectedRemoteRevision: 0,
      expectedPriorTransportEpoch: null,
      targetTransportEpoch: 1,
      actorProfiles: [
        actorProfile(OWNER_ID, 'Owner'),
        actorProfile(RECEIVER_ID, 'Receiver'),
      ],
      ownershipFences: [
        {
          schemaVersion: 1,
          taskRef: workflow.taskRef,
          ownerActorId: OWNER_ID,
          ownershipEpoch: sharedMetadata.ownershipEpoch,
          taskRevision: sharedMetadata.revision,
          aggregateDigest: taskBundle.aggregateDigest,
          remoteRevision: 1,
          lastOperationId: establishOperationId,
          updatedAt: NOW.toISOString(),
        },
      ],
      claims: [],
      handoffs: [],
      taskBundles: [taskBundle],
    });

    let manifest = await requirePulledManifest(store);
    const remoteClaimId = id(85);
    const coordinationDomainId = gitRefCoordinationDomainId(
      await resolveGitRefRemoteIdentityHash(fixture.clone, 'origin'),
      WORKSPACE_ID,
      1,
    );
    const acquired = prepareGitRefCoordinationMutation(manifest, {
      kind: 'claim_acquire',
      operationId: id(86),
      actorId: RECEIVER_ID,
      taskRef: workflow.taskRef,
      expectedRemoteRevision: 1,
      expectedOwnershipEpoch: sharedMetadata.ownershipEpoch,
      claim: pendingClaim({
        claimId: remoteClaimId,
        ownerActorId: RECEIVER_ID,
        coordinationDomainId,
        taskRevisionAtAcquire: taskBundle.taskRevision,
        lastValidatedTaskRevision: taskBundle.taskRevision,
        implementationScopeDigest: sharedMetadata.implementationScope.digest,
        ownershipEpochAtAcquire: taskBundle.ownershipEpoch,
        codeRefAtAcquire: taskBundle.codeRef,
        lastValidatedCodeRef: taskBundle.codeRef,
      }),
      now: NOW,
    });
    await store.mutateCoordination(acquired);
    manifest = await requirePulledManifest(store);
    expect(manifest.claims).toMatchObject([
      { claimId: remoteClaimId, ownerActorId: RECEIVER_ID, state: 'active' },
    ]);

    const released = prepareGitRefCoordinationMutation(manifest, {
      kind: 'claim_release',
      operationId: id(87),
      actorId: RECEIVER_ID,
      taskRef: workflow.taskRef,
      expectedRemoteRevision: 2,
      expectedOwnershipEpoch: sharedMetadata.ownershipEpoch,
      claimId: remoteClaimId,
      expectedClaimRevision: 1,
      now: NOW,
    });
    await store.mutateCoordination(released);
    manifest = await requirePulledManifest(store);

    const handoffId = id(88);
    const proposal = draftHandoff({
      handoffId,
      taskRef: workflow.taskRef,
      taskRevision: taskBundle.taskRevision,
      ownershipEpochAtOffer: taskBundle.ownershipEpoch,
      claimIds: [],
      transport: {
        mode: 'git-ref',
        state: 'stale',
        transportRevision: null,
        publishedAt: null,
        fetchedAt: null,
        taskBundleDigest: taskBundle.bundleDigest,
        codeRef: taskBundle.codeRef,
        codeReachable: true,
        receipt: null,
      },
    });
    const drafted = prepareGitRefCoordinationMutation(manifest, {
      kind: 'handoff_draft',
      operationId: id(89),
      actorId: OWNER_ID,
      taskRef: workflow.taskRef,
      expectedRemoteRevision: 3,
      expectedOwnershipEpoch: sharedMetadata.ownershipEpoch,
      handoff: proposal,
      now: NOW,
    });
    await store.mutateCoordination(drafted);
    manifest = await requirePulledManifest(store);
    const offered = prepareGitRefCoordinationMutation(manifest, {
      kind: 'handoff_offer',
      operationId: id(90),
      actorId: OWNER_ID,
      taskRef: workflow.taskRef,
      expectedRemoteRevision: 4,
      expectedOwnershipEpoch: sharedMetadata.ownershipEpoch,
      handoffId,
      expectedHandoffRevision: 1,
      now: NOW,
    });
    await store.mutateCoordination(offered);
    manifest = await requirePulledManifest(store);
    const rejected = prepareGitRefCoordinationMutation(manifest, {
      kind: 'handoff_reject',
      operationId: id(91),
      actorId: RECEIVER_ID,
      taskRef: workflow.taskRef,
      expectedRemoteRevision: 5,
      expectedOwnershipEpoch: sharedMetadata.ownershipEpoch,
      handoffId,
      expectedHandoffRevision: 2,
      reason: 'The receiver needs a narrower implementation scope.',
      now: NOW,
    });
    await store.mutateCoordination(rejected);
    manifest = await requirePulledManifest(store);
    expect(manifest.handoffs).toMatchObject([
      { handoffId, state: 'rejected', resolution: { actorId: RECEIVER_ID } },
    ]);
  });
});

function baseManifest(
  options: { claims?: ClaimV1[]; handoffs?: HandoffV1[] } = {},
): GitRefTeamManifestV1 {
  const currentBundle = bundle(metadata());
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    schemaEpoch: id(70),
    minReaderVersion: '0.3.9',
    minWriterVersion: '0.3.9',
    transportEpoch: 1,
    configRevision: 1,
    configDigest: DIGEST,
    authorityState: 'active',
    authorityTombstone: null,
    revision: 1,
    lastOperationId: id(10),
    actorProfiles: [
      actorProfile(OWNER_ID, 'Owner'),
      actorProfile(RECEIVER_ID, 'Receiver'),
    ],
    ownershipFences: [fence(currentBundle)],
    claims: options.claims ?? [],
    handoffs: options.handoffs ?? [],
    taskBundles: [currentBundle],
    receipts: [],
    lastMutation: null,
    updatedAt: '2026-07-18T09:00:00.000Z',
  };
}

function commitPrepared(
  previous: GitRefTeamManifestV1,
  prepared: PreparedGitRefCoordinationMutation,
): GitRefTeamManifestV1 {
  return {
    ...previous,
    revision: previous.revision + 1,
    lastOperationId: prepared.operationId,
    ownershipFences: [prepared.ownershipFence],
    claims: prepared.claims,
    handoffs: prepared.handoffs,
    taskBundles: prepared.taskBundle === null ? [] : [prepared.taskBundle],
  };
}

function fence(taskBundle: GitRefTaskBundleV1): GitRefOwnershipFenceV1 {
  return {
    schemaVersion: 1,
    taskRef: TASK_REF,
    ownerActorId: OWNER_ID,
    ownershipEpoch: 1,
    taskRevision: 7,
    aggregateDigest: taskBundle.aggregateDigest,
    remoteRevision: 1,
    lastOperationId: id(10),
    updatedAt: '2026-07-18T09:00:00.000Z',
  };
}

function metadata(
  overrides: Partial<WorkflowMetadataV3> = {},
): WorkflowMetadataV3 {
  const scope = {
    source: 'explicit' as const,
    include: ['src/auth/**'],
    exclude: [],
    modules: ['auth'],
  };
  return {
    schemaVersion: 3,
    taskRef: TASK_REF,
    displaySlug: 'remote-auth-change',
    task: 'Coordinate the remote authentication change.',
    workflowMode: 'manteam',
    visibility: 'shared',
    coordination: 'team',
    status: 'in_progress',
    currentStep: 5,
    skippedSteps: [],
    blockingReason: null,
    outcome: null,
    revision: 7,
    transitionState: 'stable',
    lastOperationId: null,
    ownerActorId: OWNER_ID,
    ownershipEpoch: 1,
    participants: [OWNER_ID, RECEIVER_ID],
    createdBy: { actorId: OWNER_ID, client: 'vitest', source: 'actor' },
    base: { branch: 'feature/auth', head: 'abc1234', upstream: null },
    implementationScope: { ...scope, digest: digestCanonicalJson(scope) },
    governance: {
      requirementsStatus: 'ready',
      requirementsDigest: DIGEST,
      planVersion: 1,
      planDecision: 'governed_execution',
      policyVersions: { planning: 1, review: 1, verification: 1 },
      reviewStatus: 'pending',
      reviewLedgerDigest: DIGEST,
      verificationStatus: 'pending',
      verificationLedgerDigest: DIGEST,
    },
    soloExecution: null,
    latestCheckpointRef: null,
    parent: null,
    successorTaskRef: null,
    legacyCompatibility: null,
    startedAt: '2026-07-18T08:00:00.000Z',
    updatedAt: '2026-07-18T09:00:00.000Z',
    ...overrides,
  };
}

function bundle(value: WorkflowMetadataV3): GitRefTaskBundleV1 {
  const aggregate: TaskAggregateManifestV1 = {
    taskRef: TASK_REF,
    taskRevision: value.revision,
    ownershipEpoch: value.ownershipEpoch,
    metadataDigest: workflowMetadataDigest(value),
    requirementsDigest: DIGEST,
    reviewDigest: DIGEST,
    verificationDigest: DIGEST,
    planVersion: 1,
    planDigest: DIGEST,
    latestCheckpointId: null,
    latestCheckpointDigest: null,
    parentSnapshotDigest: null,
  };
  const body = {
    schemaVersion: 1 as const,
    taskRef: TASK_REF,
    taskRevision: value.revision,
    ownershipEpoch: value.ownershipEpoch,
    aggregate,
    aggregateDigest: taskAggregateDigest(aggregate),
    codeRef: { branch: 'feature/auth', head: 'abc1234' },
    artifacts: [
      {
        kind: 'metadata' as const,
        relativePath: 'metadata.json',
        content: value,
        contentDigest: digestCanonicalJson(value),
      },
      {
        kind: 'plan' as const,
        relativePath: 'plan.md',
        content: CONFIRMED_MANTEAM_PLAN,
        contentDigest: digestCanonicalJson(CONFIRMED_MANTEAM_PLAN),
      },
    ],
    createdAt: '2026-07-18T09:00:00.000Z',
  };
  return { ...body, bundleDigest: digestCanonicalJson(body) };
}

function bundleWithCodeHead(
  previous: GitRefTaskBundleV1,
  head: string,
): GitRefTaskBundleV1 {
  const body = { ...previous, codeRef: { ...previous.codeRef, head } };
  const { bundleDigest: _bundleDigest, ...withoutDigest } = body;
  return {
    ...withoutDigest,
    bundleDigest: digestCanonicalJson(withoutDigest),
  };
}

function pendingClaim(overrides: Partial<ClaimV1> = {}): ClaimV1 {
  const scope = {
    paths: ['src/auth/token.ts'],
    modules: ['auth'],
    apis: [],
    schemas: [],
  };
  return {
    schemaVersion: 1,
    claimId: CLAIM_ID,
    workspaceId: WORKSPACE_ID,
    coordinationDomainId: `git-ref:${id(60)}:${WORKSPACE_ID}:${id(61)}`,
    authority: { mode: 'git-ref', remoteRevision: null },
    taskRef: TASK_REF,
    taskRevisionAtAcquire: 7,
    lastValidatedTaskRevision: 7,
    implementationScopeDigest: metadata().implementationScope.digest,
    ownershipEpochAtAcquire: 1,
    ownerActorId: OWNER_ID,
    state: 'pending',
    revision: 1,
    scope,
    scopeDigest: digestCanonicalJson(scope),
    codeRefAtAcquire: { branch: 'feature/auth', head: 'abc1234' },
    lastValidatedCodeRef: { branch: 'feature/auth', head: 'abc1234' },
    acquisitionEnforcement: 'enforced',
    writeGuard: 'advisory',
    expiresAt: '2026-08-18T10:00:00.000Z',
    predecessorClaimId: null,
    successorClaimId: null,
    lastOperationId: null,
    createdAt: '2026-07-18T09:00:00.000Z',
    updatedAt: '2026-07-18T09:00:00.000Z',
    ...overrides,
  };
}

function activeClaim(overrides: Partial<ClaimV1> = {}): ClaimV1 {
  return {
    ...pendingClaim(),
    authority: { mode: 'git-ref', remoteRevision: '1' },
    state: 'active',
    lastOperationId: id(10),
    ...overrides,
  };
}

function draftHandoff(overrides: Partial<HandoffV1> = {}): HandoffV1 {
  const currentBundle = bundle(metadata());
  return {
    schemaVersion: 1,
    handoffId: HANDOFF_ID,
    taskRef: TASK_REF,
    taskRevision: 7,
    ownershipEpochAtOffer: 1,
    state: 'draft',
    revision: 1,
    fromActorId: OWNER_ID,
    toActorId: RECEIVER_ID,
    claimIds: [CLAIM_ID],
    checkpointRef: {
      taskRef: TASK_REF,
      kind: 'checkpoint',
      artifactId: CHECKPOINT_ID,
    },
    summary: {
      completed: [],
      inProgress: ['Remote coordination domain layer'],
      notStarted: [],
      changedFiles: ['src/team/git-ref-coordination.ts'],
      verification: [],
      blockers: [],
      risks: [],
      nextAction: 'Accept the remote handoff from a fresh clone.',
    },
    transport: {
      mode: 'git-ref',
      state: 'stale',
      transportRevision: null,
      publishedAt: null,
      fetchedAt: null,
      taskBundleDigest: currentBundle.bundleDigest,
      codeRef: currentBundle.codeRef,
      codeReachable: true,
      receipt: null,
    },
    lastOperationId: null,
    offeredAt: null,
    resolution: null,
    createdAt: '2026-07-18T09:00:00.000Z',
    updatedAt: '2026-07-18T09:00:00.000Z',
    ...overrides,
  };
}

function offeredHandoff(): HandoffV1 {
  const currentBundle = bundle(metadata());
  return {
    ...draftHandoff(),
    state: 'offered',
    revision: 2,
    transport: {
      mode: 'git-ref',
      state: 'published',
      transportRevision: 1,
      publishedAt: '2026-07-18T09:00:00.000Z',
      fetchedAt: null,
      taskBundleDigest: currentBundle.bundleDigest,
      codeRef: currentBundle.codeRef,
      codeReachable: true,
      receipt: `git-ref-revision:1:${id(10)}`,
    },
    lastOperationId: id(10),
    offeredAt: '2026-07-18T09:00:00.000Z',
  };
}

function cancelledHandoff(): HandoffV1 {
  return {
    ...offeredHandoff(),
    state: 'cancelled',
    revision: 3,
    resolution: {
      state: 'cancelled',
      actorId: OWNER_ID,
      at: '2026-07-18T09:30:00.000Z',
      reason: null,
    },
  };
}

function id(value: number): string {
  return `01JZ4B6W5Z0A1B2C3D4E5F${value.toString().padStart(4, '0')}`;
}

function actorProfile(
  actorId: string,
  displayName: string,
): SharedActorProfileV1 {
  return {
    schemaVersion: 1 as const,
    actorId,
    displayName,
    joinedAt: '2026-07-18T08:00:00.000Z',
    updatedAt: '2026-07-18T08:00:00.000Z',
  };
}

async function requirePulledManifest(
  store: GitRefTeamManifestStore,
): Promise<GitRefTeamManifestV1> {
  const manifest = (await store.pull()).manifest;
  if (manifest === null) throw new Error('missing git-ref manifest');
  return manifest;
}

async function createRemoteFixture(): Promise<{
  clone: string;
  head: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-git-ref-domain-'));
  temporaryRoots.push(root);
  const remote = path.join(root, 'remote.git');
  const clone = path.join(root, 'clone');
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['clone', remote, clone]);
  await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
    cwd: clone,
  });
  await execFile('git', ['config', 'user.name', 'Vitest'], { cwd: clone });
  await writeFile(path.join(clone, 'README.md'), '# git-ref domain fixture\n');
  await execFile('git', ['add', 'README.md'], { cwd: clone });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: clone });
  await execFile('git', ['branch', '-M', 'main'], { cwd: clone });
  await execFile('git', ['push', '-u', 'origin', 'main'], { cwd: clone });
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
    cwd: clone,
  });
  return { clone, head: stdout.trim() };
}

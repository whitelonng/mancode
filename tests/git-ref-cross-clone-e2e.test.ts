import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contextReconcileTaskHead,
  contextResume,
} from '../src/commands/context.js';
import { teamClaim, teamSyncPull, teamSyncPush } from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { workflow } from '../src/commands/workflow.js';
import { createV3Checkpoint } from '../src/context/checkpoint-create.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import {
  type ReviewLedgerV1,
  parseReviewLedger,
  reviewLedgerDigest,
} from '../src/context/review-ledger.js';
import { applyV3ReviewLedger } from '../src/context/review-remediation.js';
import { V3ContextStore } from '../src/context/store.js';
import { formatTaskRef } from '../src/context/task-ref.js';
import {
  type VerificationLedgerV1,
  parseVerificationLedger,
  verificationLedgerDigest,
} from '../src/context/verification-ledger.js';
import { recordV3Verification } from '../src/context/verification-record.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import {
  ensureProjectRuntimeContext,
  readCheckoutBranch,
} from '../src/runtime/project-runtime.js';
import { createSession, readSession } from '../src/runtime/session.js';
import {
  type SharedActorProfileV1,
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import { createGitRefTaskBundle } from '../src/team/git-ref-bundle.js';
import { createGitRefTeamManifestStore } from '../src/team/git-ref-client.js';
import { prepareGitRefCoordinationMutation } from '../src/team/git-ref-coordination.js';
import {
  acceptGitRefHandoffWithRepair,
  recoverGitRefHandoffRepairs,
} from '../src/team/git-ref-handoff-repair.js';
import {
  acquireGitRefClaim,
  createGitRefHandoffDraft,
  mutateGitRefHandoff,
  syncGitRefTask,
} from '../src/team/git-ref-operation.js';
import { readGitRefTaskRemoteBase } from '../src/team/git-ref-task-base.js';
import type {
  GitRefOwnershipFenceV1,
  GitRefTaskBundleV1,
  GitRefTeamManifestStore,
} from '../src/team/git-ref-transport.js';
import {
  changeGitRefWorkflowScope,
  updateGitRefWorkflow,
} from '../src/team/git-ref-workflow-operation.js';
import { recoverGitRefWorkflowRepair } from '../src/team/git-ref-workflow-repair.js';
import { confirmManteamPlan } from './helpers/manteam-plan.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-18T10:00:00.000Z');
const WORKSPACE_ID = id(1);
const SCHEMA_EPOCH = id(2);
const ACTOR_A = id(3);
const ACTOR_B = id(4);
const SESSION_A = id(5);
const SESSION_B = id(6);
const TASK_ID = id(7);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('git-ref coordination across independent clones', () => {
  it('publishes a newly created git-ref task after its Git commit', async () => {
    const fixture = await createFixture();
    const storeA = await strictStore(fixture.cloneA);
    const [profileA, profileB] = fixture.profiles;
    if (profileA === undefined || profileB === undefined) {
      throw new Error('missing fixture actor profiles');
    }
    await storeA.publishActorProfile({
      operationId: id(15),
      expectedRemoteRevision: 0,
      profile: profileA,
    });
    await storeA.publishActorProfile({
      operationId: id(16),
      expectedRemoteRevision: 1,
      profile: profileB,
    });
    await expect(
      captureJson(() => teamSyncPull(fixture.cloneA, { json: true })),
    ).resolves.toMatchObject({
      exitCode: 0,
      value: { remoteRevision: 2 },
    });
    await rm(
      path.join(
        fixture.cloneA,
        '.mancode',
        'shared',
        'team',
        'actors',
        `${ACTOR_B}.json`,
      ),
    );

    const created = await captureJson<WorkflowCreateJson>(() =>
      workflow(
        fixture.cloneA,
        'create',
        [
          'manteam',
          'Publish a new shared task through the public sync sequence.',
        ],
        {
          session: SESSION_A,
          client: 'vitest-a',
          participants: [ACTOR_B],
          confirmShared: true,
          json: true,
        },
      ),
    );
    expect(created).toMatchObject({
      exitCode: 0,
      value: { metadata: { revision: 1, ownershipEpoch: 0 } },
    });
    await publishSharedActorProfile(fixture.cloneA, profileB);
    const taskRef = created.value.taskRef;
    const formattedTaskRef = formatTaskRef(taskRef);

    await writeFile(
      path.join(fixture.cloneA, 'README.md'),
      '# git-ref cross-clone fixture\n\ncode head\n\nteam task\n',
    );
    const dirtyPush = await captureJson<CommandJson>(() =>
      teamSyncPush(fixture.cloneA, {
        task: formattedTaskRef,
        expectedTaskRevision: '1',
        session: SESSION_A,
        client: 'vitest-a',
        json: true,
      }),
    );
    expect(dirtyPush).toMatchObject({
      exitCode: 3,
      value: { error: { code: 'MANCODE_GIT_REF_DIRTY_WORKTREE' } },
    });

    const taskRoot = path.join(
      '.mancode',
      'shared',
      'workflows',
      taskRef.taskId,
    );
    await git(fixture.cloneA, ['add', '--force', 'README.md', taskRoot]);
    await git(fixture.cloneA, ['commit', '-m', 'publish shared task']);
    const reconciled = await captureJson<CommandJson>(() =>
      contextReconcileTaskHead(fixture.cloneA, formattedTaskRef, {
        expectedFenceRevision: '1',
        fromGit: true,
        session: SESSION_A,
        client: 'vitest-a',
        json: true,
      }),
    );
    expect(reconciled.exitCode).toBe(0);

    const synced = await captureJson<CommandJson>(() =>
      teamSyncPush(fixture.cloneA, {
        task: formattedTaskRef,
        expectedTaskRevision: '1',
        session: SESSION_A,
        client: 'vitest-a',
        json: true,
      }),
    );
    expect(synced).toMatchObject({
      exitCode: 0,
      value: {
        changed: true,
        remoteRevision: 3,
        ownershipEpoch: 0,
        taskRevision: 1,
      },
    });
    const publishedReconcile = await captureJson<CommandJson>(() =>
      contextReconcileTaskHead(fixture.cloneA, formattedTaskRef, {
        expectedFenceRevision: '2',
        fromGit: true,
        session: SESSION_A,
        client: 'vitest-a',
        json: true,
      }),
    );
    expect(publishedReconcile).toMatchObject({
      exitCode: 3,
      value: { error: { code: 'MANCODE_GIT_REF_TASK_ALREADY_PUBLISHED' } },
    });

    await git(fixture.cloneA, ['push', 'origin', 'main']);
    await git(fixture.cloneB, ['fetch', 'origin']);
    await git(fixture.cloneB, ['merge', '--ff-only', 'origin/main']);
    const pulled = await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formattedTaskRef,
        json: true,
      }),
    );
    expect(pulled).toMatchObject({
      exitCode: 0,
      value: {
        remoteRevision: 3,
        materializedBundles: [{ status: 'unchanged' }],
      },
    });
    const resumed = await captureJson<CommandJson>(() =>
      contextResume(fixture.cloneB, formattedTaskRef, {
        session: SESSION_B,
        client: 'vitest-b',
        json: true,
      }),
    );
    expect(resumed).toMatchObject({
      exitCode: 0,
      value: { taskRef, taskRevision: 1 },
    });

    const unconfirmedClaim = await captureJson<CommandJson>(() =>
      teamClaim(fixture.cloneB, {
        task: formattedTaskRef,
        expectedTaskRevision: '1',
        paths: ['src/**'],
        session: SESSION_B,
        client: 'vitest-b',
        sync: true,
        json: true,
      }),
    );
    expect(unconfirmedClaim).toMatchObject({
      exitCode: 3,
      value: {
        error: { code: 'MANCODE_MANTEAM_PLAN_CONFIRMATION_REQUIRED' },
      },
    });
    await expect(
      new V3ContextStore(fixture.cloneB).readTaskSnapshot(taskRef),
    ).resolves.toMatchObject({
      metadata: { revision: 1, ownershipEpoch: 0 },
    });

    const checkpoint = await createV3Checkpoint({
      projectRoot: fixture.cloneA,
      taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: 1,
      kind: 'handoff_offered',
      summary: 'Publish a journaled handoff checkpoint after initial sync.',
      nextAction: 'Pull the successor bundle in the second clone.',
      checkpointId: id(17),
      operationId: id(18),
      now: at(3),
    });
    expect(
      await gitOutput(fixture.cloneA, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]),
    ).toContain(taskRoot);
    const updatedSync = await captureJson<CommandJson>(() =>
      teamSyncPush(fixture.cloneA, {
        task: formattedTaskRef,
        expectedTaskRevision: String(checkpoint.metadata.revision),
        session: SESSION_A,
        client: 'vitest-a',
        json: true,
      }),
    );
    expect(updatedSync).toMatchObject({
      exitCode: 0,
      value: {
        remoteRevision: 4,
        taskRevision: checkpoint.metadata.revision,
        ownershipEpoch: 0,
      },
    });
    const updatedPull = await captureJson(() =>
      teamSyncPull(fixture.cloneB, { task: formattedTaskRef, json: true }),
    );
    expect(updatedPull).toMatchObject({
      exitCode: 0,
      value: {
        remoteRevision: 4,
        materializedBundles: [
          {
            status: 'updated',
            taskRevision: checkpoint.metadata.revision,
          },
        ],
      },
    });
  }, 20_000);

  it('lets the owner checkpoint and sync after a claimed code commit', async () => {
    const fixture = await createFixture();
    const created = await createRemoteTask(fixture.cloneA, fixture.codeHead);
    const storeA = await strictStore(fixture.cloneA);
    const initialBundle = await taskBundle(fixture.cloneA);
    const establishOperationId = id(80);
    await storeA.establishCoordinationAuthority({
      operationId: establishOperationId,
      actorId: ACTOR_A,
      expectedRemoteRevision: 0,
      expectedPriorTransportEpoch: null,
      targetTransportEpoch: 2,
      actorProfiles: fixture.profiles,
      ownershipFences: [
        ownershipFence(initialBundle, ACTOR_A, 1, establishOperationId),
      ],
      claims: [],
      handoffs: [],
      taskBundles: [initialBundle],
    });
    const acquired = await acquireGitRefClaim({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      scope: scope('src/auth/**'),
      claimId: id(81),
      operationId: id(82),
      now: at(2),
    });

    await git(fixture.cloneA, ['push', 'origin', 'main']);
    await git(fixture.cloneB, ['fetch', 'origin']);
    await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    await git(fixture.cloneB, ['merge', '--ff-only', 'origin/main']);
    await rm(
      path.join(
        fixture.cloneB,
        '.mancode',
        'local',
        'cache',
        'git-ref',
        'remote-bases',
        `${created.taskRef.taskId}.json`,
      ),
    );
    await expect(
      acquireGitRefClaim({
        projectRoot: fixture.cloneB,
        taskRef: created.taskRef,
        sessionId: SESSION_B,
        expectedTaskRevision: created.metadata.revision,
        scope: scope('src/auth/**'),
        claimId: id(86),
        operationId: id(87),
        now: at(2),
      }),
    ).rejects.toThrow('MANCODE_SCOPE_CONFLICT');

    await mkdir(path.join(fixture.cloneA, 'src', 'auth'), { recursive: true });
    await writeFile(
      path.join(fixture.cloneA, 'src', 'auth', 'token.ts'),
      "export const token = 'ready';\n",
    );
    await git(fixture.cloneA, ['add', 'src/auth/token.ts']);
    await git(fixture.cloneA, ['commit', '-m', 'implement claimed code']);
    const codeHead = await gitOutput(fixture.cloneA, ['rev-parse', 'HEAD']);

    const checkpoint = await createV3Checkpoint({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      kind: 'handoff_offered',
      summary: 'The claimed implementation is committed and ready to hand off.',
      nextAction: 'Pull the commit and accept the handoff.',
      checkpointId: id(83),
      operationId: id(84),
      now: at(3),
    });
    expect(checkpoint.taskHeadFence?.codeRef.head).toBe(codeHead);

    const synced = await syncGitRefTask({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: checkpoint.metadata.revision,
      operationId: id(85),
      now: at(4),
    });
    expect(synced).toMatchObject({
      changed: true,
      remoteRevision: 3,
      bundle: { codeRef: { head: codeHead } },
    });
    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: {
        claims: [
          {
            claimId: acquired.claim.claimId,
            revision: acquired.claim.revision + 1,
            lastValidatedTaskRevision: checkpoint.metadata.revision,
            lastValidatedCodeRef: { head: codeHead },
          },
        ],
      },
    });

    const unchanged = await syncGitRefTask({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: checkpoint.metadata.revision,
      operationId: id(115),
      now: at(5),
    });
    expect(unchanged.changed).toBe(false);
    const exactRemoteBase = await readGitRefTaskRemoteBase(
      fixture.cloneA,
      created.taskRef,
    );
    const remoteAfterUnchangedSync = await storeA.pull();
    expect(exactRemoteBase?.bundle.bundleDigest).toBe(
      remoteAfterUnchangedSync.manifest?.taskBundles[0]?.bundleDigest,
    );

    await git(fixture.cloneA, ['push', 'origin', 'main']);
    const drafted = await createGitRefHandoffDraft({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: checkpoint.metadata.revision,
      toActorId: ACTOR_B,
      handoffId: id(88),
      operationId: id(89),
      now: at(5),
    });
    const offered = await mutateGitRefHandoff({
      projectRoot: fixture.cloneA,
      handoffId: drafted.handoff.handoffId,
      sessionId: SESSION_A,
      expectedHandoffRevision: drafted.handoff.revision,
      mutation: { kind: 'offer' },
      operationId: id(90),
      now: at(6),
    });

    const stalePull = await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    expect(stalePull.value).toMatchObject({
      materializedBundles: [{ status: 'quarantined', codeReachable: false }],
    });
    await expect(
      acceptGitRefHandoffWithRepair({
        projectRoot: fixture.cloneB,
        handoffId: drafted.handoff.handoffId,
        sessionId: SESSION_B,
        expectedHandoffRevision: offered.handoff.revision,
        operationId: id(91),
        now: at(7),
      }),
    ).rejects.toThrow('MANCODE_EXPECTED_REVISION_CONFLICT');

    await git(fixture.cloneB, ['pull', '--ff-only']);
    const currentPull = await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    expect(currentPull.value).toMatchObject({
      materializedBundles: [
        {
          status: 'updated',
          codeReachable: true,
          taskRevision: checkpoint.metadata.revision,
        },
      ],
    });
    const accepted = await acceptGitRefHandoffWithRepair({
      projectRoot: fixture.cloneB,
      handoffId: drafted.handoff.handoffId,
      sessionId: SESSION_B,
      expectedHandoffRevision: offered.handoff.revision,
      operationId: id(92),
      now: at(8),
    });
    expect(accepted).toMatchObject({
      ownershipEpoch: 1,
      handoff: { state: 'accepted' },
      taskBundle: { ownershipEpoch: 1 },
      forwardRepair: { ownerActorId: ACTOR_B },
    });
  }, 20_000);

  it('rejects a stale owner clone instead of overwriting a newer code ref', async () => {
    const fixture = await createFixture();
    const created = await createRemoteTask(fixture.cloneA, fixture.codeHead);
    const storeA = await strictStore(fixture.cloneA);
    const initialBundle = await taskBundle(fixture.cloneA);
    const establishOperationId = id(100);
    await storeA.establishCoordinationAuthority({
      operationId: establishOperationId,
      actorId: ACTOR_A,
      expectedRemoteRevision: 0,
      expectedPriorTransportEpoch: null,
      targetTransportEpoch: 2,
      actorProfiles: fixture.profiles,
      ownershipFences: [
        ownershipFence(initialBundle, ACTOR_A, 1, establishOperationId),
      ],
      claims: [],
      handoffs: [],
      taskBundles: [initialBundle],
    });
    await captureJson(() =>
      teamSyncPull(fixture.cloneA, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    await git(fixture.cloneA, ['push', 'origin', 'main']);
    await git(fixture.cloneB, ['fetch', 'origin']);
    await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    await git(fixture.cloneB, ['merge', '--ff-only', 'origin/main']);
    await createSession(fixture.cloneB, {
      actorId: ACTOR_A,
      sessionId: id(101),
      client: 'vitest-a-stale',
      identitySource: 'explicit',
      now: NOW,
    });

    await writeFile(
      path.join(fixture.cloneA, 'src-a.ts'),
      'export const a = 1;\n',
    );
    await git(fixture.cloneA, ['add', 'src-a.ts']);
    await git(fixture.cloneA, ['commit', '-m', 'advance owner code ref']);
    await syncGitRefTask({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      operationId: id(102),
      now: at(2),
    });

    await writeFile(
      path.join(fixture.cloneB, 'src-b.ts'),
      'export const b = 1;\n',
    );
    await git(fixture.cloneB, ['add', 'src-b.ts']);
    await git(fixture.cloneB, ['commit', '-m', 'diverge stale owner code']);
    await expect(
      syncGitRefTask({
        projectRoot: fixture.cloneB,
        taskRef: created.taskRef,
        sessionId: id(101),
        expectedTaskRevision: created.metadata.revision,
        operationId: id(103),
        now: at(3),
      }),
    ).rejects.toThrow('MANCODE_TASK_BUNDLE_DIVERGED');
    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: {
        taskBundles: [
          {
            codeRef: {
              head: await gitOutput(fixture.cloneA, ['rev-parse', 'HEAD']),
            },
          },
        ],
      },
    });
  }, 20_000);

  it('fences claims, materializes a quarantined bundle, and transfers ownership once', async () => {
    const fixture = await createFixture();
    const created = await createRemoteTask(fixture.cloneA, fixture.codeHead);
    const storeA = await strictStore(fixture.cloneA);
    const storeB = await strictStore(fixture.cloneB);
    const initialBundle = await taskBundle(fixture.cloneA);
    const establishOperationId = id(20);
    const initialFence = ownershipFence(
      initialBundle,
      ACTOR_A,
      1,
      establishOperationId,
    );

    await expect(
      storeA.establishCoordinationAuthority({
        operationId: establishOperationId,
        actorId: ACTOR_A,
        expectedRemoteRevision: 0,
        expectedPriorTransportEpoch: null,
        targetTransportEpoch: 2,
        actorProfiles: fixture.profiles,
        ownershipFences: [initialFence],
        claims: [],
        handoffs: [],
        taskBundles: [initialBundle],
      }),
    ).resolves.toMatchObject({ remoteRevision: 1, transportEpoch: 2 });

    const claim = await acquireGitRefClaim({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      scope: scope('src/auth/**'),
      claimId: id(21),
      operationId: id(22),
      now: at(1),
    });
    expect(claim).toMatchObject({
      remoteRevision: 2,
      ownershipEpoch: 0,
      claim: { state: 'active', ownerActorId: ACTOR_A },
    });

    const unreachablePull = await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    expect(unreachablePull.exitCode).toBe(0);
    expect(unreachablePull.value).toMatchObject({
      remoteRevision: 2,
      materializedBundles: [
        {
          taskRef: created.taskRef,
          codeReachable: false,
          status: 'quarantined',
          quarantinePath: expect.stringContaining(
            initialBundle.bundleDigest.slice(7),
          ),
        },
      ],
    });
    await expect(
      readFile(
        String(unreachablePull.value.materializedBundles[0].quarantinePath),
        'utf8',
      ),
    ).resolves.toContain(initialBundle.bundleDigest);
    await expect(
      new V3ContextStore(fixture.cloneB).readTaskSnapshot(created.taskRef),
    ).rejects.toThrow('MANCODE_TASK_NOT_FOUND');

    await git(fixture.cloneA, ['push', 'origin', 'main']);
    await git(fixture.cloneB, ['fetch', 'origin']);
    const reachablePull = await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    expect(reachablePull.exitCode).toBe(0);
    expect(reachablePull.value).toMatchObject({
      materializedBundles: [
        {
          taskRef: created.taskRef,
          codeReachable: true,
          status: 'created',
          aggregateDigest: initialBundle.aggregateDigest,
        },
      ],
    });
    await expect(
      new V3ContextStore(fixture.cloneB).readTaskSnapshot(created.taskRef),
    ).resolves.toMatchObject({
      metadata: { revision: initialBundle.taskRevision },
      aggregate: initialBundle.aggregate,
    });
    await git(fixture.cloneB, ['merge', '--ff-only', 'origin/main']);

    await expect(
      acquireGitRefClaim({
        projectRoot: fixture.cloneB,
        taskRef: created.taskRef,
        sessionId: SESSION_B,
        expectedTaskRevision: created.metadata.revision,
        scope: scope('src/auth/**'),
        claimId: id(23),
        operationId: id(24),
        now: at(2),
      }),
    ).rejects.toThrow('MANCODE_SCOPE_CONFLICT');

    await writeFile(path.join(fixture.cloneA, 'README.md'), '# dirty\n');
    await expect(
      createGitRefHandoffDraft({
        projectRoot: fixture.cloneA,
        taskRef: created.taskRef,
        sessionId: SESSION_A,
        expectedTaskRevision: created.metadata.revision,
        toActorId: ACTOR_B,
        handoffId: id(25),
        operationId: id(26),
        now: at(3),
      }),
    ).rejects.toThrow('MANCODE_GIT_REF_DIRTY_WORKTREE');
    await expect(storeB.pull()).resolves.toMatchObject({
      manifest: { revision: 2, handoffs: [] },
    });
    await writeFile(
      path.join(fixture.cloneA, 'README.md'),
      '# git-ref cross-clone fixture\n\ncode head\n',
    );

    const drafted = await createGitRefHandoffDraft({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      toActorId: ACTOR_B,
      handoffId: id(27),
      operationId: id(28),
      now: at(4),
    });
    expect(drafted).toMatchObject({
      remoteRevision: 3,
      handoff: { state: 'draft', revision: 1 },
    });
    const offered = await mutateGitRefHandoff({
      projectRoot: fixture.cloneA,
      handoffId: drafted.handoff.handoffId,
      sessionId: SESSION_A,
      expectedHandoffRevision: 1,
      mutation: { kind: 'offer' },
      operationId: id(29),
      now: at(5),
    });
    expect(offered).toMatchObject({
      remoteRevision: 4,
      handoff: { state: 'offered', revision: 2 },
    });

    const offeredPull = await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    expect(offeredPull.exitCode).toBe(0);
    expect(offeredPull.value).toMatchObject({
      remoteRevision: 4,
      handoffs: [{ handoffId: drafted.handoff.handoffId, state: 'offered' }],
      materializedBundles: [{ status: 'unchanged' }],
    });

    const beforeAccept = await storeA.pull();
    const beforeAcceptManifest = beforeAccept.manifest;
    if (beforeAcceptManifest === null)
      throw new Error('missing remote manifest');
    const staleOwnerMutation = prepareGitRefCoordinationMutation(
      beforeAcceptManifest,
      {
        kind: 'claim_renew',
        operationId: id(30),
        actorId: ACTOR_A,
        taskRef: created.taskRef,
        expectedRemoteRevision: beforeAcceptManifest.revision,
        expectedOwnershipEpoch: 0,
        claimId: claim.claim.claimId,
        expectedClaimRevision: 1,
        expiresAt: at(2 * 24 * 60).toISOString(),
        now: at(6),
      },
    );
    let preparedRemoteRevision: number | null = null;
    const accepted = await acceptGitRefHandoffWithRepair({
      projectRoot: fixture.cloneB,
      handoffId: drafted.handoff.handoffId,
      sessionId: SESSION_B,
      expectedHandoffRevision: 2,
      operationId: id(31),
      now: at(7),
      beforeRemoteCommit: (prepared) => {
        preparedRemoteRevision = prepared.targetRemoteRevision;
      },
    });
    expect(preparedRemoteRevision).toBe(5);
    expect(accepted).toMatchObject({
      remoteRevision: 5,
      ownershipEpoch: 1,
      handoff: { state: 'accepted', revision: 3 },
      taskBundle: {
        taskRevision: initialBundle.taskRevision + 2,
        ownershipEpoch: 1,
      },
      forwardRepair: { remoteRevision: 5, ownerActorId: ACTOR_B },
    });

    const committed = await storeB.pull();
    expect(committed).toMatchObject({
      manifest: {
        revision: 5,
        ownershipFences: [
          { ownerActorId: ACTOR_B, ownershipEpoch: 1, remoteRevision: 5 },
        ],
        receipts: expect.arrayContaining([
          expect.objectContaining({
            operationId: id(31),
            remoteRevision: 5,
            ownershipEpoch: 1,
          }),
        ]),
      },
    });
    await expect(
      new V3ContextStore(fixture.cloneB).readTaskSnapshot(created.taskRef),
    ).resolves.toMatchObject({
      metadata: {
        ownerActorId: ACTOR_B,
        ownershipEpoch: 1,
        revision: initialBundle.taskRevision + 2,
        transitionState: 'stable',
      },
    });
    await expect(recoverGitRefHandoffRepairs(fixture.cloneB)).resolves.toEqual(
      [],
    );

    await expect(storeA.mutateCoordination(staleOwnerMutation)).rejects.toThrow(
      'MANCODE_TRANSPORT_REVISION_CONFLICT',
    );
    await expect(
      syncGitRefTask({
        projectRoot: fixture.cloneA,
        taskRef: created.taskRef,
        sessionId: SESSION_A,
        expectedTaskRevision: initialBundle.taskRevision,
        operationId: id(32),
        now: at(8),
      }),
    ).rejects.toThrow('MANCODE_TASK_OWNER_REQUIRED');
    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: { revision: 5, ownershipFences: [{ ownerActorId: ACTOR_B }] },
    });

    const concurrent = await Promise.allSettled([
      storeA.publishActorProfile({
        operationId: id(33),
        expectedRemoteRevision: 5,
        profile: profile(id(34), 'Concurrent A'),
      }),
      storeB.publishActorProfile({
        operationId: id(35),
        expectedRemoteRevision: 5,
        profile: profile(id(36), 'Concurrent B'),
      }),
    ]);
    expect(
      concurrent.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = concurrent.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toMatch(
      /MANCODE_TRANSPORT_(CAS|REVISION)_CONFLICT/,
    );
    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: { revision: 6 },
    });
  }, 20_000);

  it('commits scope and lifecycle updates through one remote CAS before local materialization', async () => {
    const fixture = await createFixture();
    const created = await createRemoteTask(fixture.cloneA, fixture.codeHead);
    const storeA = await strictStore(fixture.cloneA);
    const initialBundle = await taskBundle(fixture.cloneA);
    const establishOperationId = id(40);
    await storeA.establishCoordinationAuthority({
      operationId: establishOperationId,
      actorId: ACTOR_A,
      expectedRemoteRevision: 0,
      expectedPriorTransportEpoch: null,
      targetTransportEpoch: 2,
      actorProfiles: fixture.profiles,
      ownershipFences: [
        ownershipFence(initialBundle, ACTOR_A, 1, establishOperationId),
      ],
      claims: [],
      handoffs: [],
      taskBundles: [initialBundle],
    });
    await acquireGitRefClaim({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      scope: scope('src/auth/**'),
      claimId: id(41),
      operationId: id(42),
      now: at(1),
    });

    const scoped = await changeGitRefWorkflowScope({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      scope: {
        include: ['src/**', 'tests/**', 'docs/**'],
        exclude: [],
        modules: [],
      },
      operationId: id(43),
      checkpointId: id(44),
      now: at(2),
    });
    expect(scoped).toMatchObject({
      metadata: {
        revision: created.metadata.revision + 2,
        transitionState: 'stable',
      },
      remoteRevision: 3,
      materialization: { status: 'updated' },
    });
    await expect(
      new V3ContextStore(fixture.cloneA).readTaskSnapshot(created.taskRef),
    ).resolves.toMatchObject({
      metadata: {
        revision: created.metadata.revision + 2,
        implementationScope: { include: ['docs/**', 'src/**', 'tests/**'] },
      },
    });

    const blocked = await updateGitRefWorkflow({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: scoped.metadata.revision,
      status: 'blocked',
      blockingReason: 'Awaiting the coordinated integration window.',
      operationId: id(45),
      now: at(3),
    });
    expect(blocked).toMatchObject({
      metadata: {
        revision: scoped.metadata.revision + 2,
        status: 'blocked',
        transitionState: 'stable',
      },
      remoteRevision: 4,
      materialization: { status: 'updated' },
    });
    await expect(readSession(fixture.cloneA, SESSION_A)).resolves.toMatchObject(
      {
        activeTaskRef: created.taskRef,
        activeMode: 'manteam',
        lastSeenRevision: blocked.metadata.revision,
      },
    );
    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: {
        revision: 4,
        ownershipFences: [
          { taskRevision: blocked.metadata.revision, lastOperationId: id(45) },
        ],
        taskBundles: [
          { taskRevision: blocked.metadata.revision, ownershipEpoch: 0 },
        ],
      },
    });

    const journalPath = path.join(
      fixture.cloneA,
      '.mancode',
      'local',
      'journals',
      'git-ref-workflow',
      `${id(45)}.json`,
    );
    const committedJournal = JSON.parse(await readFile(journalPath, 'utf8'));
    await writeFile(
      journalPath,
      `${JSON.stringify(
        {
          ...committedJournal,
          state: 'awaiting_remote',
          updatedAt: at(4).toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    await expect(
      updateGitRefWorkflow({
        projectRoot: fixture.cloneA,
        taskRef: created.taskRef,
        sessionId: SESSION_A,
        expectedTaskRevision: blocked.metadata.revision,
        status: 'in_progress',
        operationId: id(46),
        now: at(4),
      }),
    ).rejects.toThrow('MANCODE_OPERATION_REPAIR_REQUIRED');
    await expect(
      recoverGitRefWorkflowRepair(fixture.cloneA, id(45), null, {
        actorId: ACTOR_B,
        sessionId: SESSION_B,
      }),
    ).rejects.toThrow('MANCODE_REPAIR_AUTHORIZATION_MISMATCH');
  }, 20_000);

  it('rebinds an atomically blocked task to a committed projection before another clone resumes it', async () => {
    const fixture = await createFixture();
    const created = await createRemoteTask(fixture.cloneA, fixture.codeHead);
    const storeA = await strictStore(fixture.cloneA);
    const initialBundle = await taskBundle(fixture.cloneA);
    const establishOperationId = id(110);
    await storeA.establishCoordinationAuthority({
      operationId: establishOperationId,
      actorId: ACTOR_A,
      expectedRemoteRevision: 0,
      expectedPriorTransportEpoch: null,
      targetTransportEpoch: 2,
      actorProfiles: fixture.profiles,
      ownershipFences: [
        ownershipFence(initialBundle, ACTOR_A, 1, establishOperationId),
      ],
      claims: [],
      handoffs: [],
      taskBundles: [initialBundle],
    });

    const blocked = await updateGitRefWorkflow({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      status: 'blocked',
      blockingReason: 'Awaiting an external dependency.',
      operationId: id(111),
      now: at(4),
    });
    expect(blocked).toMatchObject({
      metadata: { status: 'blocked' },
      remoteRevision: 2,
    });

    const taskRoot = path.join(
      '.mancode',
      'shared',
      'workflows',
      created.taskRef.taskId,
    );
    await git(fixture.cloneA, ['add', '--force', taskRoot]);
    await git(fixture.cloneA, [
      'commit',
      '-m',
      'commit atomically materialized blocked task',
    ]);
    const committedHead = await gitOutput(fixture.cloneA, [
      'rev-parse',
      'HEAD',
    ]);

    const rebound = await captureJson<CommandJson>(() =>
      teamSyncPush(fixture.cloneA, {
        task: formatTaskRef(created.taskRef),
        expectedTaskRevision: String(blocked.metadata.revision),
        session: SESSION_A,
        client: 'vitest-a',
        json: true,
      }),
    );
    expect(rebound).toMatchObject({
      exitCode: 0,
      value: {
        changed: true,
        taskRevision: blocked.metadata.revision,
        remoteRevision: 3,
      },
    });
    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: {
        ownershipFences: [
          {
            taskRevision: blocked.metadata.revision,
          },
        ],
        taskBundles: [
          {
            taskRevision: blocked.metadata.revision,
            codeRef: { head: committedHead },
          },
        ],
      },
    });

    await git(fixture.cloneA, ['push', 'origin', 'main']);
    await git(fixture.cloneB, ['fetch', 'origin']);
    await git(fixture.cloneB, ['merge', '--ff-only', 'origin/main']);
    const pulled = await captureJson<CommandJson>(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    expect(pulled).toMatchObject({
      exitCode: 0,
      value: {
        remoteRevision: 3,
        materializedBundles: [{ status: 'unchanged', codeReachable: true }],
      },
    });
    const resumed = await captureJson<CommandJson>(() =>
      contextResume(fixture.cloneB, formatTaskRef(created.taskRef), {
        session: SESSION_B,
        client: 'vitest-b',
        json: true,
      }),
    );
    expect(resumed).toMatchObject({
      exitCode: 0,
      value: {
        taskRef: created.taskRef,
        taskRevision: blocked.metadata.revision,
      },
    });
  }, 20_000);

  it('completes a ready shared task and releases its remote claim in one CAS', async () => {
    const fixture = await createFixture();
    const created = await createRemoteTask(fixture.cloneA, fixture.codeHead, {
      completionReady: true,
    });
    const storeA = await strictStore(fixture.cloneA);
    const initialBundle = await taskBundle(fixture.cloneA);
    const establishOperationId = id(50);
    await storeA.establishCoordinationAuthority({
      operationId: establishOperationId,
      actorId: ACTOR_A,
      expectedRemoteRevision: 0,
      expectedPriorTransportEpoch: null,
      targetTransportEpoch: 2,
      actorProfiles: fixture.profiles,
      ownershipFences: [
        ownershipFence(initialBundle, ACTOR_A, 1, establishOperationId),
      ],
      claims: [],
      handoffs: [],
      taskBundles: [initialBundle],
    });
    const acquired = await acquireGitRefClaim({
      projectRoot: fixture.cloneA,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: created.metadata.revision,
      scope: scope('src/auth/**'),
      claimId: id(51),
      operationId: id(52),
      now: at(4),
    });

    const completion = await captureWorkflowCompletion(() =>
      workflow(fixture.cloneA, 'complete', [formatTaskRef(created.taskRef)], {
        session: SESSION_A,
        client: 'vitest-a',
        expectedRevision: String(created.metadata.revision),
        sync: true,
        json: true,
      }),
    );
    expect(completion.exitCode, JSON.stringify(completion.value)).toBe(0);
    const completed = completion.value;
    expect(completed).toMatchObject({
      metadata: {
        status: 'completed',
        revision: created.metadata.revision + 2,
        transitionState: 'stable',
      },
      releasedClaims: [
        {
          claimId: acquired.claim.claimId,
          state: 'released',
          revision: 2,
          lastOperationId: completed.metadata.lastOperationId,
        },
      ],
      remoteRevision: 3,
      materialization: { status: 'updated' },
    });
    await expect(readSession(fixture.cloneA, SESSION_A)).resolves.toMatchObject(
      {
        activeTaskRef: null,
        activeMode: null,
        lastSeenRevision: null,
      },
    );
    await expect(storeA.pull()).resolves.toMatchObject({
      manifest: {
        revision: 3,
        claims: [
          {
            claimId: acquired.claim.claimId,
            state: 'released',
            revision: 2,
          },
        ],
        taskBundles: [
          {
            taskRevision: completed.metadata.revision,
            aggregateDigest: expect.any(String),
          },
        ],
        receipts: expect.arrayContaining([
          expect.objectContaining({
            operationId: completed.metadata.lastOperationId,
            remoteRevision: 3,
          }),
        ]),
      },
    });

    await git(fixture.cloneA, ['push', 'origin', 'main']);
    await git(fixture.cloneB, ['fetch', 'origin']);
    const pulled = await captureJson(() =>
      teamSyncPull(fixture.cloneB, {
        task: formatTaskRef(created.taskRef),
        json: true,
      }),
    );
    expect(pulled).toMatchObject({
      exitCode: 0,
      value: {
        remoteRevision: 3,
        materializedBundles: [{ status: 'created' }],
      },
    });
    await expect(
      new V3ContextStore(fixture.cloneB).readTaskSnapshot(created.taskRef),
    ).resolves.toMatchObject({
      metadata: {
        status: 'completed',
        revision: completed.metadata.revision,
      },
    });
  }, 20_000);
});

interface Fixture {
  cloneA: string;
  cloneB: string;
  codeHead: string;
  profiles: SharedActorProfileV1[];
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'mancode-git-ref-cross-clone-'),
  );
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const cloneA = path.join(root, 'clone-a');
  const cloneB = path.join(root, 'clone-b');
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['clone', remote, cloneA]);
  await configureGit(cloneA);
  await writeFile(
    path.join(cloneA, 'README.md'),
    '# git-ref cross-clone fixture\n',
  );
  await writeFile(path.join(cloneA, '.gitignore'), '.mancode/\n');
  await git(cloneA, ['add', 'README.md', '.gitignore']);
  await git(cloneA, ['commit', '-m', 'fixture baseline']);
  await git(cloneA, ['branch', '-M', 'main']);

  await initializeV3Project({
    projectRoot: cloneA,
    operationId: id(10),
    workspaceId: WORKSPACE_ID,
    schemaEpoch: SCHEMA_EPOCH,
    now: NOW,
  });
  const localA = await createLocalActor(cloneA, {
    actorId: ACTOR_A,
    displayName: 'Actor A',
    now: NOW,
  });
  const profileA = createSharedActorProfile(localA, NOW);
  const profileB = profile(ACTOR_B, 'Actor B');
  await Promise.all([
    publishSharedActorProfile(cloneA, profileA),
    publishSharedActorProfile(cloneA, profileB),
  ]);
  await createSession(cloneA, {
    actorId: ACTOR_A,
    sessionId: SESSION_A,
    client: 'vitest-a',
    identitySource: 'explicit',
    now: NOW,
  });
  await setGitRefConfig(cloneA);
  await git(cloneA, [
    'add',
    '--force',
    '.mancode/schema.json',
    '.mancode/shared',
  ]);
  await git(cloneA, ['commit', '-m', 'configure shared git-ref authority']);
  await git(cloneA, ['push', '-u', 'origin', 'main']);

  await execFile('git', ['clone', '--branch', 'main', remote, cloneB]);
  await configureGit(cloneB);
  await ensureProjectRuntimeContext(cloneB, NOW);
  await createLocalActor(cloneB, {
    actorId: ACTOR_B,
    displayName: 'Actor B',
    now: NOW,
  });
  await createSession(cloneB, {
    actorId: ACTOR_B,
    sessionId: SESSION_B,
    client: 'vitest-b',
    identitySource: 'explicit',
    now: NOW,
  });

  await writeFile(
    path.join(cloneA, 'README.md'),
    '# git-ref cross-clone fixture\n\ncode head\n',
  );
  await git(cloneA, ['add', 'README.md']);
  await git(cloneA, ['commit', '-m', 'unpublished task code']);
  const codeHead = await gitOutput(cloneA, ['rev-parse', 'HEAD']);
  return { cloneA, cloneB, codeHead, profiles: [profileA, profileB] };
}

async function createRemoteTask(
  projectRoot: string,
  codeHead: string,
  options: { completionReady?: boolean } = {},
) {
  const created = await createV3Workflow({
    projectRoot,
    task: 'Coordinate authentication boundary changes across clones.',
    workflowMode: 'manteam',
    sessionId: SESSION_A,
    client: 'vitest-a',
    sharedPrivacyConfirmed: true,
    participantActorIds: [ACTOR_B],
    implementationScope: { include: ['src/**', 'tests/**'] },
    taskId: TASK_ID,
    operationId: id(11),
    now: NOW,
  });
  const confirmed = await confirmManteamPlan({
    projectRoot,
    taskRef: created.taskRef,
    sessionId: SESSION_A,
    requirements: created.requirements,
    now: NOW,
  });
  const checkpoint = await createV3Checkpoint({
    projectRoot,
    taskRef: created.taskRef,
    sessionId: SESSION_A,
    expectedTaskRevision: confirmed.taskRevision,
    kind: 'diagnostic_started',
    summary: 'Remote handoff checkpoint.',
    nextAction: 'Transfer the task to Actor B.',
    checkpointId: id(12),
    operationId: id(13),
    now: at(1),
  });
  let metadata = checkpoint.metadata;
  if (options.completionReady === true) {
    const snapshot = await new V3ContextStore(projectRoot).readTaskSnapshot(
      created.taskRef,
    );
    const reviewed = await applyV3ReviewLedger({
      projectRoot,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: snapshot.metadata.revision,
      review: passedReview(
        snapshot.review,
        snapshot.requirements.contentDigest,
        snapshot.metadata.governance.planVersion,
      ),
      operationId: id(70),
      now: at(2),
    });
    const verified = await recordV3Verification({
      projectRoot,
      taskRef: created.taskRef,
      sessionId: SESSION_A,
      expectedTaskRevision: reviewed.metadata.revision,
      verification: passedVerification(
        reviewed.verification,
        snapshot.requirements,
        reviewed.metadata.governance.planVersion,
        reviewed.review.remediationRound,
      ),
      operationId: id(71),
      now: at(3),
    });
    metadata = verified.metadata;
  }
  expect(await gitOutput(projectRoot, ['rev-parse', 'HEAD'])).toBe(codeHead);
  return { ...created, metadata };
}

function passedReview(
  previous: ReviewLedgerV1,
  requirementsDigest: string,
  planVersion: number,
): ReviewLedgerV1 {
  const draft: ReviewLedgerV1 = {
    ...previous,
    revision: 99,
    status: 'passed',
    requirementsDigest,
    planVersion,
    requiredDomains: ['quality'],
    domains: [{ domain: 'quality', status: 'passed', reportRef: null }],
    blockers: [],
    remediationRound: 0,
    skip: null,
    contentDigest: '',
    lastOperationId: id(72),
    updatedAt: at(2).toISOString(),
  };
  return parseReviewLedger({
    ...draft,
    contentDigest: reviewLedgerDigest(draft),
  });
}

function passedVerification(
  previous: VerificationLedgerV1,
  requirements: Parameters<typeof parseVerificationLedger>[1],
  planVersion: number,
  remediationRound: number,
): VerificationLedgerV1 {
  const criterion = requirements.acceptanceCriteria[0];
  if (criterion === undefined) throw new Error('missing fixture criterion');
  const draft: VerificationLedgerV1 = {
    ...previous,
    revision: 99,
    status: 'passed',
    requirementsDigest: requirements.contentDigest,
    planVersion,
    remediationRound,
    checks: [
      {
        displayId: criterion.displayId,
        legacyId: criterion.legacyId,
        checkId: id(73),
        criterionId: criterion.criterionId,
        required: criterion.required,
        verificationRequirement: criterion.verificationRequirement,
        automated: {
          evidenceId: id(74),
          status: 'passed',
          summary: 'The shared completion fixture verification passed.',
          command: 'npm test',
          exitCode: 0,
          artifactRef: null,
          confirmedByActorId: null,
          confirmationSource: null,
          updatedAt: at(3).toISOString(),
        },
        manual: null,
      },
    ],
    contentDigest: '',
    lastOperationId: id(75),
    updatedAt: at(3).toISOString(),
  };
  return parseVerificationLedger(
    { ...draft, contentDigest: verificationLedgerDigest(draft) },
    requirements,
  );
}

async function strictStore(
  projectRoot: string,
): Promise<GitRefTeamManifestStore> {
  const project = await new V3ContextStore(projectRoot).readProjectSnapshot();
  return createGitRefTeamManifestStore(
    projectRoot,
    project.config,
    project.manifest,
  );
}

async function taskBundle(projectRoot: string): Promise<GitRefTaskBundleV1> {
  const task = await new V3ContextStore(projectRoot).readTaskSnapshot({
    namespace: 'shared',
    taskId: TASK_ID,
  });
  return createGitRefTaskBundle({
    task,
    codeRef: {
      branch: (await readCheckoutBranch(projectRoot)) ?? 'HEAD',
      head: await gitOutput(projectRoot, ['rev-parse', 'HEAD']),
    },
    now: NOW,
  });
}

function ownershipFence(
  bundle: GitRefTaskBundleV1,
  ownerActorId: Ulid,
  remoteRevision: number,
  operationId: Ulid,
): GitRefOwnershipFenceV1 {
  return {
    schemaVersion: 1,
    taskRef: bundle.taskRef,
    ownerActorId,
    ownershipEpoch: bundle.ownershipEpoch,
    taskRevision: bundle.taskRevision,
    aggregateDigest: bundle.aggregateDigest,
    remoteRevision,
    lastOperationId: operationId,
    updatedAt: NOW.toISOString(),
  };
}

async function setGitRefConfig(projectRoot: string): Promise<void> {
  const target = path.join(projectRoot, '.mancode', 'shared', 'config.json');
  const config = JSON.parse(await readFile(target, 'utf8')) as {
    revision: number;
    transport: { mode: string; remote: string | null; epoch: number };
    lastOperationId: string | null;
    updatedAt: string;
  };
  await writeFile(
    target,
    `${JSON.stringify(
      {
        ...config,
        revision: config.revision + 1,
        transport: { mode: 'git-ref', remote: 'origin', epoch: 2 },
        lastOperationId: id(14),
        updatedAt: NOW.toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function captureJson<T extends Record<string, unknown> = SyncPullJson>(
  action: () => Promise<number>,
): Promise<{ exitCode: number; value: T }> {
  const writes: string[] = [];
  const previous = console.log;
  console.log = (value: unknown) => writes.push(String(value));
  try {
    const exitCode = await action();
    return {
      exitCode,
      value: JSON.parse(writes.at(-1) ?? '{}') as T,
    };
  } finally {
    console.log = previous;
  }
}

interface SyncPullJson extends Record<string, unknown> {
  materializedBundles: Array<
    Record<string, unknown> & { quarantinePath?: string }
  >;
}

interface CommandJson extends Record<string, unknown> {
  error?: { code: string };
}

interface WorkflowCreateJson extends CommandJson {
  taskRef: { namespace: 'shared'; taskId: Ulid };
  metadata: { revision: number; ownershipEpoch: number };
}

interface WorkflowCompletionJson extends Record<string, unknown> {
  metadata: {
    revision: number;
    status: string;
    transitionState: string;
    lastOperationId: string;
  };
  releasedClaims: Array<Record<string, unknown>>;
  remoteRevision: number;
  materialization: Record<string, unknown>;
}

async function captureWorkflowCompletion(
  action: () => Promise<number>,
): Promise<{ exitCode: number; value: WorkflowCompletionJson }> {
  const writes: string[] = [];
  const previous = console.log;
  console.log = (value: unknown) => writes.push(String(value));
  try {
    return {
      exitCode: await action(),
      value: JSON.parse(writes.at(-1) ?? '{}') as WorkflowCompletionJson,
    };
  } finally {
    console.log = previous;
  }
}

function scope(pathPattern: string) {
  return { paths: [pathPattern], modules: [], apis: [], schemas: [] };
}

function profile(actorId: Ulid, displayName: string): SharedActorProfileV1 {
  return {
    schemaVersion: 1,
    actorId,
    displayName,
    joinedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

async function configureGit(projectRoot: string): Promise<void> {
  await git(projectRoot, ['config', 'user.email', 'vitest@example.test']);
  await git(projectRoot, ['config', 'user.name', 'Vitest']);
}

async function git(projectRoot: string, args: string[]): Promise<void> {
  await execFile('git', args, { cwd: projectRoot });
}

async function gitOutput(projectRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: projectRoot });
  return stdout.trim();
}

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

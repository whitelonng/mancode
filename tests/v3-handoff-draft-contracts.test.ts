import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamHandoffDraft } from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { readHandoff } from '../src/runtime/handoff-store.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
} from '../src/team/actor.js';
import { acquireV3Claim } from '../src/team/claim-acquisition.js';
import {
  acceptV3Handoff,
  createV3HandoffDraft,
  offerV3Handoff,
  rejectV3Handoff,
} from '../src/team/handoff-operation.js';
import { confirmManteamPlan } from './helpers/manteam-plan.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-17T14:00:00.000Z');

describe('V3 local-coordination handoff draft and transition', () => {
  let root: string;
  let crashRoots: string[];

  beforeEach(async () => {
    crashRoots = [];
    root = path.join(
      tmpdir(),
      `mancode-v3-handoff-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await execFile('git', ['init'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
      cwd: root,
    });
    await execFile('git', ['config', 'user.name', 'Vitest'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), '# fixture\n');
    await execFile('git', ['add', 'README.md'], { cwd: root });
    await execFile('git', ['commit', '-m', 'fixture'], { cwd: root });
  });

  afterEach(async () => {
    await Promise.all(
      [root, ...crashRoots].map((target) =>
        rm(target, { recursive: true, force: true }),
      ),
    );
  });

  it('checkpoints, drafts, offers, and rejects a named shared handoff through journals', async () => {
    const actors = await bootstrap(root);
    const workflow = await createV3Workflow({
      projectRoot: root,
      task: 'Transfer a narrow shared implementation lane.',
      workflowMode: 'manteam',
      sessionId: actors.ownerSessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: { include: ['src/**'], modules: ['auth'] },
      participantActorIds: [actors.receiverActorId],
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });
    const confirmed = await confirmManteamPlan({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      requirements: workflow.requirements,
      now: NOW,
    });
    const claim = await acquireV3Claim({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      expectedTaskRevision: confirmed.taskRevision,
      scope: {
        paths: ['src/auth/**'],
        modules: ['auth'],
        apis: [],
        schemas: [],
      },
      claimId: id(12),
      operationId: id(13),
      now: NOW,
    });

    const drafted = await createV3HandoffDraft({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      expectedTaskRevision: confirmed.taskRevision,
      toActorId: actors.receiverActorId,
      handoffId: id(14),
      checkpointId: id(15),
      checkpointOperationId: id(16),
      operationId: id(17),
      now: NOW,
    });
    expect(drafted).toMatchObject({
      checkpoint: { kind: 'handoff_offered', checkpointId: id(15) },
      checkpointOperation: { type: 'checkpoint_create', state: 'committed' },
      handoff: {
        handoffId: id(14),
        state: 'draft',
        revision: 1,
        taskRevision: 5,
        ownershipEpochAtOffer: 1,
        claimIds: [claim.claim.claimId],
        checkpointRef: { artifactId: id(15) },
      },
      operation: { type: 'handoff_transition', state: 'committed' },
    });

    const offered = await offerV3Handoff({
      projectRoot: root,
      handoffId: drafted.handoff.handoffId,
      sessionId: actors.ownerSessionId,
      expectedHandoffRevision: 1,
      operationId: id(18),
      now: NOW,
    });
    expect(offered).toMatchObject({
      handoff: {
        state: 'offered',
        revision: 2,
        offeredAt: NOW.toISOString(),
        lastOperationId: id(18),
      },
      operation: { type: 'handoff_transition', state: 'committed' },
    });

    const rejected = await rejectV3Handoff({
      projectRoot: root,
      handoffId: drafted.handoff.handoffId,
      sessionId: actors.receiverSessionId,
      expectedHandoffRevision: 2,
      reason: 'The receiving actor needs a narrower implementation scope.',
      operationId: id(19),
      now: NOW,
    });
    expect(rejected.handoff).toMatchObject({
      state: 'rejected',
      revision: 3,
      resolution: {
        state: 'rejected',
        actorId: actors.receiverActorId,
      },
    });

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      workflow.taskRef,
    );
    expect(await readHandoff(home, drafted.handoff.handoffId)).toEqual(
      rejected.handoff,
    );
    await expect(readOperationJournal(home, id(17))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${workflow.taskRef.taskId}`]: 5,
        [`handoff:${id(14)}`]: 0,
      },
    });
    await expect(readOperationJournal(home, id(18))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${workflow.taskRef.taskId}`]: 5,
        [`handoff:${id(14)}`]: 1,
      },
    });
    expect(
      (await new V3ContextStore(root).readTaskSnapshot(workflow.taskRef))
        .metadata,
    ).toMatchObject({ revision: 5, ownerActorId: actors.ownerActorId });
  });

  it('transfers owner and claims only after the offered handoff is accepted', async () => {
    const actors = await bootstrap(root);
    const workflow = await createV3Workflow({
      projectRoot: root,
      task: 'Accept a narrow shared implementation lane.',
      workflowMode: 'manteam',
      sessionId: actors.ownerSessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: { include: ['src/**'], modules: ['auth'] },
      participantActorIds: [actors.receiverActorId],
      taskId: id(30),
      operationId: id(31),
      now: NOW,
    });
    const confirmed = await confirmManteamPlan({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      requirements: workflow.requirements,
      now: NOW,
    });
    const claim = await acquireV3Claim({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      expectedTaskRevision: confirmed.taskRevision,
      scope: {
        paths: ['src/auth/**'],
        modules: ['auth'],
        apis: [],
        schemas: [],
      },
      claimId: id(32),
      operationId: id(33),
      now: NOW,
    });
    const drafted = await createV3HandoffDraft({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      expectedTaskRevision: confirmed.taskRevision,
      toActorId: actors.receiverActorId,
      handoffId: id(34),
      checkpointId: id(35),
      checkpointOperationId: id(36),
      operationId: id(37),
      now: NOW,
    });
    const offered = await offerV3Handoff({
      projectRoot: root,
      handoffId: drafted.handoff.handoffId,
      sessionId: actors.ownerSessionId,
      expectedHandoffRevision: 1,
      operationId: id(38),
      now: NOW,
    });

    const accepted = await acceptV3Handoff({
      projectRoot: root,
      handoffId: offered.handoff.handoffId,
      sessionId: actors.receiverSessionId,
      expectedHandoffRevision: 2,
      successorClaimIds: [id(39)],
      operationId: id(40),
      now: NOW,
    });
    expect(accepted).toMatchObject({
      metadata: {
        revision: 7,
        transitionState: 'stable',
        ownerActorId: actors.receiverActorId,
        ownershipEpoch: 2,
        lastOperationId: id(40),
      },
      handoff: {
        state: 'accepted',
        revision: 3,
        lastOperationId: id(40),
        resolution: { state: 'accepted', actorId: actors.receiverActorId },
      },
      predecessorClaims: [
        {
          claimId: claim.claim.claimId,
          state: 'transferred',
          revision: 2,
          successorClaimId: id(39),
        },
      ],
      successorClaims: [
        {
          claimId: id(39),
          state: 'active',
          revision: 2,
          ownerActorId: actors.receiverActorId,
          taskRevisionAtAcquire: 7,
          ownershipEpochAtAcquire: 2,
          predecessorClaimId: claim.claim.claimId,
        },
      ],
      taskHeadFence: {
        fenceRevision: 5,
        taskRevision: 7,
        ownershipEpoch: 2,
        lastOperationId: id(40),
      },
      operation: { type: 'handoff_accept', state: 'committed' },
    });

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      workflow.taskRef,
    );
    await expect(readOperationJournal(home, id(40))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${workflow.taskRef.taskId}`]: 5,
        [`handoff:${id(34)}`]: 2,
        [`claim:${claim.claim.claimId}`]: 1,
        [`claim:${id(39)}`]: 0,
        [`checkpoint:${id(35)}`]: 4,
        [`task_head:${workflow.taskRef.taskId}`]: 4,
      },
      entityLocks: expect.arrayContaining([
        `handoff:${id(34)}`,
        `claim:${claim.claim.claimId}`,
        `claim:${id(39)}`,
        `checkpoint:${id(35)}`,
        `task_head:${workflow.taskRef.taskId}`,
      ]),
    });
    const coordination = await new V3ContextStore(
      root,
    ).readCoordinationSnapshot(workflow.taskRef, home);
    expect(coordination.claims).toMatchObject([
      { claimId: claim.claim.claimId, state: 'transferred', revision: 2 },
      {
        claimId: id(39),
        state: 'active',
        ownerActorId: actors.receiverActorId,
      },
    ]);
  });

  it('routes a handoff draft through the team command contract', async () => {
    const actors = await bootstrap(root);
    const workflow = await createV3Workflow({
      projectRoot: root,
      task: 'Create a handoff through the team command.',
      workflowMode: 'manteam',
      sessionId: actors.ownerSessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: { include: ['src/**'], modules: ['auth'] },
      participantActorIds: [actors.receiverActorId],
      taskId: id(50),
      operationId: id(51),
      now: NOW,
    });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await teamHandoffDraft(root, {
          task: `shared:${workflow.taskRef.taskId}`,
          expectedTaskRevision: '1',
          to: actors.receiverActorId,
          session: actors.ownerSessionId,
          client: 'owner-client',
          json: true,
        }),
      ).toBe(0);
      const payload = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        checkpoint: { kind: string };
        handoff: {
          state: string;
          taskRef: { namespace: string; taskId: string };
          toActorId: string;
        };
        operation: { type: string; state: string };
      };
      expect(payload).toMatchObject({
        checkpoint: { kind: 'handoff_offered' },
        handoff: {
          state: 'draft',
          taskRef: { namespace: 'shared', taskId: workflow.taskRef.taskId },
          toActorId: actors.receiverActorId,
        },
        operation: { type: 'handoff_transition', state: 'committed' },
      });

      expect(
        await teamHandoffDraft(root, {
          task: `shared:${workflow.taskRef.taskId}`,
          to: actors.receiverActorId,
          json: true,
        }),
      ).toBe(2);
      expect(String(logs.mock.calls.at(-1)?.[0])).toContain(
        'MANCODE_HANDOFF_DRAFT_ARGUMENT_INVALID',
      );
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('repairs or aborts handoff acceptance at every durable crash point', async () => {
    for (const [
      index,
      fixture,
    ] of OPERATION_CRASH_FIXTURES.handoff_accept.entries()) {
      const caseRoot = await mkdtemp(
        path.join(tmpdir(), `mancode-v3-handoff-crash-${index}-`),
      );
      crashRoots.push(caseRoot);
      await initializeGitFixture(caseRoot);
      const actors = await bootstrap(caseRoot);
      const prepared = await createOfferedHandoff(caseRoot, actors);
      const operationId = id(100 + index);

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          acceptV3Handoff({
            projectRoot: caseRoot,
            handoffId: prepared.handoffId,
            sessionId: actors.receiverSessionId,
            expectedHandoffRevision: 2,
            successorClaimIds: [id(120 + index)],
            operationId,
            now: NOW,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      const recovered = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId,
        actorId: actors.receiverActorId,
        sessionId: actors.receiverSessionId,
        now: NOW,
      });
      if (fixture.expectedRecovery === 'safe_abort') {
        expect(recovered.journal.state).toBe('aborted');
        expect(['aborted', 'already_terminal']).toContain(recovered.state);
      } else if (fixture.crashAfter === 'commit') {
        expect(recovered).toMatchObject({
          state: 'already_terminal',
          journal: { state: 'committed' },
        });
      } else {
        expect(recovered).toMatchObject({
          state: 'repaired',
          journal: { state: 'committed' },
        });
      }
    }
  }, 20_000);
});

async function createOfferedHandoff(
  projectRoot: string,
  actors: Awaited<ReturnType<typeof bootstrap>>,
): Promise<{ handoffId: Ulid }> {
  const workflow = await createV3Workflow({
    projectRoot,
    task: 'Recover a shared handoff acceptance after an interrupted write.',
    workflowMode: 'manteam',
    sessionId: actors.ownerSessionId,
    client: 'vitest',
    sharedPrivacyConfirmed: true,
    implementationScope: { include: ['src/**'], modules: ['auth'] },
    participantActorIds: [actors.receiverActorId],
    taskId: id(50),
    operationId: id(51),
    now: NOW,
  });
  const confirmed = await confirmManteamPlan({
    projectRoot,
    taskRef: workflow.taskRef,
    sessionId: actors.ownerSessionId,
    requirements: workflow.requirements,
    now: NOW,
  });
  const claim = await acquireV3Claim({
    projectRoot,
    taskRef: workflow.taskRef,
    sessionId: actors.ownerSessionId,
    expectedTaskRevision: confirmed.taskRevision,
    scope: { paths: ['src/auth/**'], modules: ['auth'], apis: [], schemas: [] },
    claimId: id(52),
    operationId: id(53),
    now: NOW,
  });
  const drafted = await createV3HandoffDraft({
    projectRoot,
    taskRef: workflow.taskRef,
    sessionId: actors.ownerSessionId,
    expectedTaskRevision: confirmed.taskRevision,
    toActorId: actors.receiverActorId,
    claimIds: [claim.claim.claimId],
    handoffId: id(54),
    checkpointId: id(55),
    checkpointOperationId: id(56),
    operationId: id(57),
    now: NOW,
  });
  await offerV3Handoff({
    projectRoot,
    handoffId: drafted.handoff.handoffId,
    sessionId: actors.ownerSessionId,
    expectedHandoffRevision: 1,
    operationId: id(58),
    now: NOW,
  });
  return { handoffId: drafted.handoff.handoffId };
}

async function bootstrap(projectRoot: string): Promise<{
  ownerActorId: Ulid;
  ownerSessionId: Ulid;
  receiverActorId: Ulid;
  receiverSessionId: Ulid;
}> {
  await initializeV3Project({
    projectRoot,
    operationId: id(1),
    workspaceId: id(2),
    schemaEpoch: id(3),
    now: NOW,
  });
  const ownerActorId = id(4);
  const ownerSessionId = id(5);
  const receiverActorId = id(6);
  const receiverSessionId = id(7);
  await createLocalActor(projectRoot, {
    actorId: ownerActorId,
    displayName: 'Offering User',
    now: NOW,
  });
  const owner = await readLocalActor(projectRoot);
  if (owner === null) throw new Error('missing owner actor');
  await publishSharedActorProfile(
    projectRoot,
    createSharedActorProfile(owner, NOW),
  );
  await publishSharedActorProfile(projectRoot, {
    schemaVersion: 1,
    actorId: receiverActorId,
    displayName: 'Receiving User',
    joinedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await createSession(projectRoot, {
    actorId: ownerActorId,
    sessionId: ownerSessionId,
    client: 'owner-client',
    identitySource: 'explicit',
    now: NOW,
  });
  await createSession(projectRoot, {
    actorId: receiverActorId,
    sessionId: receiverSessionId,
    client: 'receiver-client',
    identitySource: 'explicit',
    now: NOW,
  });
  return { ownerActorId, ownerSessionId, receiverActorId, receiverSessionId };
}

async function initializeGitFixture(projectRoot: string): Promise<void> {
  await execFile('git', ['init'], { cwd: projectRoot });
  await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
    cwd: projectRoot,
  });
  await execFile('git', ['config', 'user.name', 'Vitest'], {
    cwd: projectRoot,
  });
  await writeFile(path.join(projectRoot, 'README.md'), '# fixture\n');
  await execFile('git', ['add', 'README.md'], { cwd: projectRoot });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: projectRoot });
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

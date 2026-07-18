import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamClaimRenew } from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createV3Checkpoint } from '../src/context/checkpoint-create.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
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
  reclaimV3Claim,
  releaseV3Claim,
  renewV3Claim,
  revalidateV3Claim,
  transferV3Claim,
} from '../src/team/claim-operation.js';
import { confirmManteamPlan } from './helpers/manteam-plan.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-17T16:00:00.000Z');

describe('V3 local claim lifecycle operations', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-claim-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    await rm(root, { recursive: true, force: true });
  });

  it('renews and then releases an owned fresh claim under revision CAS', async () => {
    const actors = await bootstrap(root);
    const { workflow, claim } = await workflowWithOwnerClaim(root, actors, 10);

    const renewed = await renewV3Claim({
      projectRoot: root,
      claimId: claim.claim.claimId,
      sessionId: actors.ownerSessionId,
      expectedClaimRevision: 1,
      ttlMs: 2 * 24 * 60 * 60 * 1000,
      operationId: id(14),
      now: NOW,
    });
    expect(renewed).toMatchObject({
      claim: {
        claimId: claim.claim.claimId,
        state: 'active',
        revision: 2,
        expiresAt: '2026-07-19T16:00:00.000Z',
      },
      operation: { type: 'claim_renew_release', state: 'committed' },
    });

    const released = await releaseV3Claim({
      projectRoot: root,
      claimId: claim.claim.claimId,
      sessionId: actors.ownerSessionId,
      expectedClaimRevision: 2,
      operationId: id(15),
      now: NOW,
    });
    expect(released).toMatchObject({
      claim: { state: 'released', revision: 3, lastOperationId: id(15) },
      operation: { type: 'claim_renew_release', state: 'committed' },
    });

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      workflow.taskRef,
    );
    await expect(readOperationJournal(home, id(15))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${workflow.taskRef.taskId}`]: 3,
        [`claim:${claim.claim.claimId}`]: 2,
      },
    });
  });

  it('transfers through a pending successor instead of rewriting the old owner', async () => {
    const actors = await bootstrap(root);
    const { workflow, claim } = await workflowWithOwnerClaim(root, actors, 20);

    const transferred = await transferV3Claim({
      projectRoot: root,
      claimId: claim.claim.claimId,
      sessionId: actors.ownerSessionId,
      expectedClaimRevision: 1,
      toActorId: actors.participantActorId,
      successorClaimId: id(24),
      operationId: id(25),
      now: NOW,
    });
    expect(transferred).toMatchObject({
      predecessorClaim: {
        claimId: claim.claim.claimId,
        ownerActorId: actors.ownerActorId,
        state: 'transferred',
        revision: 2,
        successorClaimId: id(24),
      },
      successorClaim: {
        claimId: id(24),
        state: 'active',
        revision: 2,
        ownerActorId: actors.participantActorId,
        predecessorClaimId: claim.claim.claimId,
      },
      operation: { type: 'claim_transfer', state: 'committed' },
    });

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      workflow.taskRef,
    );
    await expect(readOperationJournal(home, id(25))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${workflow.taskRef.taskId}`]: 3,
        [`claim:${claim.claim.claimId}`]: 1,
        [`claim:${id(24)}`]: 0,
      },
      entityLocks: expect.arrayContaining([
        `claim:${claim.claim.claimId}`,
        `claim:${id(24)}`,
      ]),
    });
  });

  it('revalidates a claim against the final task revision without mutating its acquisition snapshot', async () => {
    const actors = await bootstrap(root);
    const { workflow, claim, taskRevision } = await workflowWithOwnerClaim(
      root,
      actors,
      30,
    );
    await createV3Checkpoint({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      expectedTaskRevision: taskRevision,
      kind: 'diagnostic_started',
      summary: 'A normal task mutation made existing claims need validation.',
      checkpointId: id(34),
      operationId: id(35),
      now: NOW,
    });

    const revalidated = await revalidateV3Claim({
      projectRoot: root,
      claimId: claim.claim.claimId,
      sessionId: actors.ownerSessionId,
      expectedClaimRevision: 1,
      checkpointId: id(36),
      operationId: id(37),
      now: NOW,
    });
    expect(revalidated).toMatchObject({
      metadata: { revision: 7, transitionState: 'stable' },
      claim: {
        claimId: claim.claim.claimId,
        state: 'active',
        revision: 2,
        taskRevisionAtAcquire: 3,
        lastValidatedTaskRevision: 7,
        lastOperationId: id(37),
      },
      checkpoint: null,
      taskHeadFence: { fenceRevision: 5, taskRevision: 7 },
      operation: { type: 'claim_revalidation', state: 'committed' },
    });
    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      workflow.taskRef,
    );
    await expect(readOperationJournal(home, id(37))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${workflow.taskRef.taskId}`]: 5,
        [`claim:${claim.claim.claimId}`]: 1,
        [`task_head:${workflow.taskRef.taskId}`]: 4,
      },
      entityLocks: expect.arrayContaining([
        `claim:${claim.claim.claimId}`,
        `task_head:${workflow.taskRef.taskId}`,
      ]),
    });
  });

  it('lets the task owner explicitly reclaim an expired local claim but never revive it', async () => {
    const actors = await bootstrap(root);
    const { claim } = await workflowWithOwnerClaim(root, actors, 40, {
      ttlMs: 60_000,
    });

    const reclaimed = await reclaimV3Claim({
      projectRoot: root,
      claimId: claim.claim.claimId,
      sessionId: actors.ownerSessionId,
      expectedClaimRevision: 1,
      reason: 'The local lease has expired and must be explicitly replaced.',
      operationId: id(45),
      now: new Date(NOW.getTime() + 60_001),
    });
    expect(reclaimed).toMatchObject({
      claim: { state: 'expired', revision: 2, lastOperationId: id(45) },
      operation: { type: 'claim_reclaim', state: 'committed' },
    });
    await expect(
      renewV3Claim({
        projectRoot: root,
        claimId: claim.claim.claimId,
        sessionId: actors.ownerSessionId,
        expectedClaimRevision: 2,
        operationId: id(46),
        now: new Date(NOW.getTime() + 60_001),
      }),
    ).rejects.toThrow('MANCODE_CLAIM_NOT_ACTIVE');
  });

  it('routes a duration-based renew through the team command contract', async () => {
    const actors = await bootstrap(root);
    const { claim } = await workflowWithOwnerClaim(root, actors, 50, {
      now: new Date(),
    });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await teamClaimRenew(root, {
          claimId: claim.claim.claimId,
          expectedRevision: '1',
          ttl: '2d',
          session: actors.ownerSessionId,
          client: 'owner-client',
          json: true,
        }),
      ).toBe(0);
      const payload = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        claim: { revision: number; expiresAt: string };
        operation: { type: string; state: string };
      };
      expect(payload).toMatchObject({
        claim: { revision: 2 },
        operation: { type: 'claim_renew_release', state: 'committed' },
      });
      expect(Date.parse(payload.claim.expiresAt)).toBeGreaterThan(
        Date.parse(claim.claim.expiresAt),
      );

      expect(
        await teamClaimRenew(root, {
          claimId: claim.claim.claimId,
          json: true,
        }),
      ).toBe(2);
      expect(String(logs.mock.calls.at(-1)?.[0])).toContain(
        'MANCODE_CLAIM_ARGUMENT_INVALID',
      );
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });
});

async function workflowWithOwnerClaim(
  projectRoot: string,
  actors: Awaited<ReturnType<typeof bootstrap>>,
  offset: number,
  options: { ttlMs?: number; now?: Date } = {},
) {
  const now = options.now ?? NOW;
  const workflow = await createV3Workflow({
    projectRoot,
    task: `Claim lifecycle task ${offset}.`,
    workflowMode: 'manteam',
    sessionId: actors.ownerSessionId,
    client: 'vitest',
    sharedPrivacyConfirmed: true,
    implementationScope: { include: ['src/**'], modules: ['auth'] },
    participantActorIds: [actors.participantActorId],
    taskId: id(offset),
    operationId: id(offset + 1),
    now,
  });
  const confirmed = await confirmManteamPlan({
    projectRoot,
    taskRef: workflow.taskRef,
    sessionId: actors.ownerSessionId,
    requirements: workflow.requirements,
    now,
  });
  const claim = await acquireV3Claim({
    projectRoot,
    taskRef: workflow.taskRef,
    sessionId: actors.ownerSessionId,
    expectedTaskRevision: confirmed.taskRevision,
    scope: {
      paths: ['src/auth/**'],
      modules: ['auth'],
      apis: [],
      schemas: [],
    },
    ttlMs: options.ttlMs,
    claimId: id(offset + 2),
    operationId: id(offset + 3),
    now,
  });
  return { workflow, claim, taskRevision: confirmed.taskRevision };
}

async function bootstrap(projectRoot: string): Promise<{
  ownerActorId: Ulid;
  ownerSessionId: Ulid;
  participantActorId: Ulid;
  participantSessionId: Ulid;
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
  const participantActorId = id(6);
  const participantSessionId = id(7);
  await createLocalActor(projectRoot, {
    actorId: ownerActorId,
    displayName: 'Lifecycle Owner',
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
    actorId: participantActorId,
    displayName: 'Lifecycle Participant',
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
    actorId: participantActorId,
    sessionId: participantSessionId,
    client: 'participant-client',
    identitySource: 'explicit',
    now: NOW,
  });
  return {
    ownerActorId,
    ownerSessionId,
    participantActorId,
    participantSessionId,
  };
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

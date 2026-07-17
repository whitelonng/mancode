import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { workflow as workflowCommand } from '../src/commands/workflow.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { changeV3WorkflowScope } from '../src/context/scope-change.js';
import { V3ContextStore } from '../src/context/store.js';
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

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-17T15:00:00.000Z');

describe('V3 journaled workflow scope change and re-claim', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-scope-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

  it('checkpoints the change, terminates old claims, and activates only compatible successors', async () => {
    const actors = await bootstrap(root);
    const workflow = await createV3Workflow({
      projectRoot: root,
      task: 'Narrow the shared implementation boundary.',
      workflowMode: 'manteam',
      sessionId: actors.ownerSessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: {
        include: ['src/**'],
        exclude: [],
        modules: ['auth', 'billing'],
      },
      participantActorIds: [actors.participantActorId],
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });
    const authClaim = await acquireV3Claim({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      expectedTaskRevision: 1,
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
    const billingClaim = await acquireV3Claim({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.participantSessionId,
      expectedTaskRevision: 1,
      scope: {
        paths: ['src/billing/**'],
        modules: ['billing'],
        apis: [],
        schemas: [],
      },
      claimId: id(14),
      operationId: id(15),
      now: NOW,
    });

    const changed = await changeV3WorkflowScope({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId: actors.ownerSessionId,
      expectedTaskRevision: 1,
      scope: {
        include: ['src/**'],
        exclude: ['src/billing/**'],
        modules: ['auth'],
      },
      checkpointId: id(16),
      successorClaimIds: [id(17)],
      operationId: id(18),
      now: NOW,
    });

    expect(changed).toMatchObject({
      metadata: {
        revision: 3,
        transitionState: 'stable',
        implementationScope: {
          source: 'explicit',
          include: ['src/**'],
          exclude: ['src/billing/**'],
          modules: ['auth'],
        },
        latestCheckpointRef: { artifactId: id(16) },
        lastOperationId: id(18),
      },
      checkpoint: {
        checkpointId: id(16),
        operationId: id(18),
        kind: 'scope_changed',
        taskRevision: 2,
      },
      terminatedClaims: [
        {
          claimId: authClaim.claim.claimId,
          state: 'transferred',
          revision: 2,
          successorClaimId: id(17),
        },
        {
          claimId: billingClaim.claim.claimId,
          state: 'released',
          revision: 2,
          successorClaimId: null,
        },
      ],
      successorClaims: [
        {
          claimId: id(17),
          state: 'active',
          revision: 2,
          ownerActorId: actors.ownerActorId,
          predecessorClaimId: authClaim.claim.claimId,
          taskRevisionAtAcquire: 3,
          lastValidatedTaskRevision: 3,
        },
      ],
      taskHeadFence: {
        fenceRevision: 2,
        taskRevision: 3,
        lastOperationId: id(18),
      },
      operation: { type: 'scope_change_reclaim', state: 'committed' },
    });
    expect(changed.successorClaims[0]?.implementationScopeDigest).toBe(
      changed.metadata.implementationScope.digest,
    );

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      workflow.taskRef,
    );
    await expect(readOperationJournal(home, id(18))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${workflow.taskRef.taskId}`]: 1,
        [`checkpoint:${id(16)}`]: 0,
        [`claim:${id(12)}`]: 1,
        [`claim:${id(14)}`]: 1,
        [`claim:${id(17)}`]: 0,
        [`task_head:${workflow.taskRef.taskId}`]: 1,
      },
      entityLocks: expect.arrayContaining([
        `checkpoint:${id(16)}`,
        `claim:${id(12)}`,
        `claim:${id(14)}`,
        `claim:${id(17)}`,
        `task_head:${workflow.taskRef.taskId}`,
      ]),
    });
    const coordination = await new V3ContextStore(
      root,
    ).readCoordinationSnapshot(workflow.taskRef, home);
    expect(coordination.claims).toMatchObject([
      {
        claimId: authClaim.claim.claimId,
        state: 'transferred',
        successorClaimId: id(17),
      },
      { claimId: billingClaim.claim.claimId, state: 'released' },
      {
        claimId: id(17),
        state: 'active',
        predecessorClaimId: authClaim.claim.claimId,
      },
    ]);
  });

  it('refuses a no-op replacement scope before it creates a checkpoint', async () => {
    const actors = await bootstrap(root);
    const workflow = await createV3Workflow({
      projectRoot: root,
      task: 'Reject a no-op scope change.',
      workflowMode: 'manteam',
      sessionId: actors.ownerSessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: {
        include: ['src/**'],
        exclude: [],
        modules: ['auth'],
      },
      participantActorIds: [actors.participantActorId],
      taskId: id(30),
      operationId: id(31),
      now: NOW,
    });

    await expect(
      changeV3WorkflowScope({
        projectRoot: root,
        taskRef: workflow.taskRef,
        sessionId: actors.ownerSessionId,
        expectedTaskRevision: 1,
        scope: { include: ['src/**'], exclude: [], modules: ['auth'] },
        checkpointId: id(32),
        operationId: id(33),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_SCOPE_CHANGE_NOOP');
  });

  it('routes a scope-file replacement through the V3 workflow command', async () => {
    const actors = await bootstrap(root);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Change scope through the workflow command.',
      workflowMode: 'manteam',
      sessionId: actors.ownerSessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: {
        include: ['src/**'],
        exclude: [],
        modules: ['auth', 'billing'],
      },
      participantActorIds: [actors.participantActorId],
      taskId: id(40),
      operationId: id(41),
      now: NOW,
    });
    await writeFile(
      path.join(root, 'scope.json'),
      JSON.stringify({
        include: ['src/**'],
        exclude: ['src/billing/**'],
        modules: ['auth'],
      }),
    );
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await workflowCommand(
          root,
          'scope',
          ['change', `shared:${created.taskRef.taskId}`],
          {
            expectedRevision: '1',
            file: 'scope.json',
            session: actors.ownerSessionId,
            client: 'owner-client',
            json: true,
          },
        ),
      ).toBe(0);
      const payload = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        metadata: {
          revision: number;
          implementationScope: { modules: string[] };
        };
        checkpoint: { kind: string };
        operation: { type: string; state: string };
      };
      expect(payload).toMatchObject({
        metadata: {
          revision: 3,
          implementationScope: { modules: ['auth'] },
        },
        checkpoint: { kind: 'scope_changed' },
        operation: { type: 'scope_change_reclaim', state: 'committed' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });
});

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
    displayName: 'Scope Owner',
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
    displayName: 'Scope Participant',
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

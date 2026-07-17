import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { reconcileV3TaskHead } from '../src/context/task-head-reconcile.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
import {
  ensureProjectRuntimeContext,
  readProjectRuntimeContext,
} from '../src/runtime/project-runtime.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import { acquireV3Claim } from '../src/team/claim-acquisition.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-18T10:00:00.000Z');

describe('V3 linked-worktree end to end', () => {
  let root: string;
  let linked: string | null;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-worktree-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    linked = null;
    await mkdir(root, { recursive: true });
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'vitest@example.test']);
    await git(root, ['config', 'user.name', 'Vitest']);
    await writeFile(path.join(root, 'README.md'), '# worktree fixture\n');
    await git(root, ['add', 'README.md']);
    await git(root, ['commit', '-m', 'baseline']);
    await git(root, ['branch', '-M', 'main']);
  });

  afterEach(async () => {
    if (linked !== null) {
      await git(root, ['worktree', 'remove', '--force', linked]).catch(
        () => undefined,
      );
      await rm(linked, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  });

  it('uses Git for shared task delivery and the common dir for immediate claim coordination', async () => {
    const actorA = id(4);
    const actorB = id(5);
    const sessionA = id(6);
    const sessionB = id(7);

    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
    await createActorAndSession(root, actorA, sessionA, 'Actor A');
    await commitSharedAuthority(root, 'initialize shared authority');

    linked = path.join(
      tmpdir(),
      `mancode-v3-worktree-linked-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await git(root, ['worktree', 'add', '-b', 'worktree-b', linked]);
    await ensureProjectRuntimeContext(linked, NOW);
    await createActorAndSession(linked, actorB, sessionB, 'Actor B');
    await commitSharedAuthority(linked, 'join actor B');
    await git(root, ['merge', '--ff-only', 'worktree-b']);

    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Coordinate authentication boundary changes across two worktrees.',
      workflowMode: 'manteam',
      sessionId: sessionA,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      participantActorIds: [actorB],
      implementationScope: { include: ['src/**', 'tests/**'] },
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });

    await expect(
      new V3ContextStore(linked).readTaskSnapshot(created.taskRef),
    ).rejects.toThrow('MANCODE_TASK_NOT_FOUND');

    await commitSharedAuthority(root, 'publish shared task');
    await reconcileV3TaskHead({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId: sessionA,
      expectedFenceRevision: 1,
      fromGit: true,
      operationId: id(12),
      now: NOW,
    });
    await git(linked, ['merge', '--ff-only', 'main']);

    const [runtimeA, runtimeB, taskFromB] = await Promise.all([
      readProjectRuntimeContext(root),
      readProjectRuntimeContext(linked),
      new V3ContextStore(linked).readTaskSnapshot(created.taskRef),
    ]);
    expect(runtimeB.checkoutId).not.toBe(runtimeA.checkoutId);
    expect(runtimeB.gitCommonDir).toBe(runtimeA.gitCommonDir);
    expect(taskFromB.metadata.participants).toEqual([actorA, actorB]);

    const firstClaim = await acquireV3Claim({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId: sessionA,
      expectedTaskRevision: 1,
      scope: claimScope('src/auth/**'),
      claimId: id(20),
      operationId: id(21),
      now: NOW,
    });

    await expect(
      acquireV3Claim({
        projectRoot: linked,
        taskRef: created.taskRef,
        sessionId: sessionB,
        expectedTaskRevision: 1,
        scope: claimScope('src/auth/**'),
        claimId: id(22),
        operationId: id(23),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_SCOPE_CONFLICT');

    const secondClaim = await acquireV3Claim({
      projectRoot: linked,
      taskRef: created.taskRef,
      sessionId: sessionB,
      expectedTaskRevision: 1,
      scope: claimScope('tests/auth/**'),
      claimId: id(24),
      operationId: id(25),
      now: NOW,
    });

    const homeA = resolveTaskEntityHomeStore(
      runtimeA.entityHomeStoreContext,
      created.taskRef,
    );
    const homeB = resolveTaskEntityHomeStore(
      runtimeB.entityHomeStoreContext,
      created.taskRef,
    );
    expect(homeB.root).toBe(homeA.root);
    const coordination = await new V3ContextStore(
      root,
    ).readCoordinationSnapshot(created.taskRef, homeA);
    expect(coordination.claims).toEqual([firstClaim.claim, secondClaim.claim]);
  });
});

async function createActorAndSession(
  projectRoot: string,
  actorId: Ulid,
  sessionId: Ulid,
  displayName: string,
): Promise<void> {
  const actor = await createLocalActor(projectRoot, {
    actorId,
    displayName,
    now: NOW,
  });
  await publishSharedActorProfile(
    projectRoot,
    createSharedActorProfile(actor, NOW),
  );
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
}

async function commitSharedAuthority(
  projectRoot: string,
  message: string,
): Promise<void> {
  await git(projectRoot, [
    'add',
    '--force',
    '.mancode/schema.json',
    '.mancode/shared',
  ]);
  await git(projectRoot, ['commit', '-m', message]);
}

function claimScope(pathPattern: string) {
  return { paths: [pathPattern], modules: [], apis: [], schemas: [] };
}

async function git(projectRoot: string, args: string[]): Promise<void> {
  await execFile('git', args, { cwd: projectRoot });
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

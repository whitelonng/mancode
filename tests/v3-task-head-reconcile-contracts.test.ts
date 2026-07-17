import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { taskAggregateDigest } from '../src/context/aggregate.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import {
  previewV3TaskHeadReconcile,
  reconcileV3TaskHead,
} from '../src/context/task-head-reconcile.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
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

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-17T17:00:00.000Z');

describe('V3 explicit task-head reconcile', () => {
  let root: string;
  let crashRoots: string[];

  beforeEach(async () => {
    crashRoots = [];
    root = path.join(
      tmpdir(),
      `mancode-v3-reconcile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

  it('adopts a Git-sourced aggregate only after an explicit fence CAS', async () => {
    const actors = await bootstrap(root);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Adopt a newer task aggregate from Git.',
      workflowMode: 'manteam',
      sessionId: actors.sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });
    const store = new V3ContextStore(root);
    const original = await store.readTaskSnapshot(created.taskRef);
    await commitTaskAuthority(root, original.location.taskRoot, 'share task');
    await writeFile(
      path.join(original.location.taskRoot, 'metadata.json'),
      `${JSON.stringify(
        {
          ...original.metadata,
          revision: 2,
          updatedAt: new Date(NOW.getTime() + 1_000).toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      reconcileV3TaskHead({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId: actors.sessionId,
        expectedFenceRevision: 1,
        fromGit: false,
        operationId: id(12),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_GIT_SOURCE_CONFIRMATION_REQUIRED');

    await expect(
      reconcileV3TaskHead({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId: actors.sessionId,
        expectedFenceRevision: 1,
        fromGit: true,
        operationId: id(13),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_TASK_UNAVAILABLE');
    await commitTaskAuthority(root, original.location.taskRoot, 'adopt task');

    const preview = await previewV3TaskHeadReconcile({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionActorId: id(4),
      expectedFenceRevision: 1,
      fromGit: true,
      operationId: id(14),
      now: NOW,
    });
    expect(preview).toMatchObject({
      currentTaskHeadFence: { fenceRevision: 1 },
      proposedTaskHeadFence: {
        fenceRevision: 2,
        taskRevision: 2,
        lastOperationId: id(14),
      },
    });

    const reconciled = await reconcileV3TaskHead({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId: actors.sessionId,
      expectedFenceRevision: 1,
      fromGit: true,
      operationId: id(14),
      now: NOW,
    });
    expect(reconciled).toMatchObject({
      aggregate: { taskRevision: 2 },
      taskHeadFence: {
        fenceRevision: 2,
        taskRevision: 2,
        lastOperationId: id(14),
      },
      operation: { type: 'task_head_reconcile', state: 'committed' },
    });
    expect(reconciled.taskHeadFence.aggregateDigest).toBe(
      taskAggregateDigest(reconciled.aggregate),
    );

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    await expect(readOperationJournal(home, id(14))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${created.taskRef.taskId}`]: 2,
        [`task_head:${created.taskRef.taskId}`]: 1,
      },
      entityLocks: expect.arrayContaining([
        `task_head:${created.taskRef.taskId}`,
      ]),
    });
  });

  it('repairs or aborts task-head reconciliation at every durable crash point', async () => {
    for (const [
      index,
      fixture,
    ] of OPERATION_CRASH_FIXTURES.task_head_reconcile.entries()) {
      const caseRoot = await mkdtemp(
        path.join(tmpdir(), `mancode-v3-reconcile-crash-${index}-`),
      );
      crashRoots.push(caseRoot);
      await initializeGitFixture(caseRoot);
      const actors = await bootstrap(caseRoot);
      const workflow = await createV3Workflow({
        projectRoot: caseRoot,
        task: 'Recover an explicit Git-sourced task-head adoption.',
        workflowMode: 'manteam',
        sessionId: actors.sessionId,
        client: 'vitest',
        sharedPrivacyConfirmed: true,
        taskId: id(100 + index),
        operationId: id(120 + index),
        now: NOW,
      });
      const store = new V3ContextStore(caseRoot);
      const original = await store.readTaskSnapshot(workflow.taskRef);
      await commitTaskAuthority(
        caseRoot,
        original.location.taskRoot,
        'share task',
      );
      await writeFile(
        path.join(original.location.taskRoot, 'metadata.json'),
        `${JSON.stringify(
          {
            ...original.metadata,
            revision: 2,
            updatedAt: new Date(NOW.getTime() + 1_000).toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      await commitTaskAuthority(
        caseRoot,
        original.location.taskRoot,
        'adopt task',
      );
      const operationId = id(140 + index);

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          reconcileV3TaskHead({
            projectRoot: caseRoot,
            taskRef: workflow.taskRef,
            sessionId: actors.sessionId,
            expectedFenceRevision: 1,
            fromGit: true,
            operationId,
            now: NOW,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      const recovered = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId,
        actorId: actors.actorId,
        sessionId: actors.sessionId,
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

async function bootstrap(
  projectRoot: string,
): Promise<{ actorId: Ulid; sessionId: Ulid }> {
  await initializeV3Project({
    projectRoot,
    operationId: id(1),
    workspaceId: id(2),
    schemaEpoch: id(3),
    now: NOW,
  });
  const actorId = id(4);
  const sessionId = id(5);
  await createLocalActor(projectRoot, {
    actorId,
    displayName: 'Reconcile Owner',
    now: NOW,
  });
  const actor = await readLocalActor(projectRoot);
  if (actor === null) throw new Error('missing local actor');
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
  return { actorId, sessionId };
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

async function commitTaskAuthority(
  projectRoot: string,
  taskRoot: string,
  message: string,
): Promise<void> {
  const relative = path.relative(projectRoot, taskRoot);
  await execFile('git', ['add', '--', relative], { cwd: projectRoot });
  await execFile('git', ['commit', '-m', message], { cwd: projectRoot });
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

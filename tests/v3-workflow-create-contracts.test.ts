import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { taskRootPath } from '../src/context/task-locator.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { parseWorkflowMetadata } from '../src/context/workflow-metadata.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession, readSession } from '../src/runtime/session.js';
import { readTaskHeadFence } from '../src/runtime/task-head-store.js';
import { openV3TaskOperation } from '../src/runtime/task-operation.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
} from '../src/team/actor.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-17T10:00:00.000Z');

describe('V3 workflow create operation', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-workflow-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes a complete local tuple behind a committed write-ahead journal and resumes only its session', async () => {
    const { actorId, sessionId } = await bootstrap(root, false);
    const taskId = id(6);
    const operationId = id(7);

    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Add a deterministic V3 creation contract.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId,
      operationId,
      implementationScope: { include: ['src/context/**'] },
      now: NOW,
    });

    expect(created.taskRef).toEqual({ namespace: 'local', taskId });
    expect(created.metadata.ownerActorId).toBe(actorId);
    expect(created.metadata.governance.requirementsStatus).toBe(
      'needs_clarification',
    );
    expect(created.operation.state).toBe('committed');
    expect(
      created.operation.steps.every((step) => step.state === 'completed'),
    ).toBe(true);
    await expect(
      readFile(
        path.join(taskRootPath(root, created.taskRef), 'metadata.json'),
        'utf8',
      ),
    ).resolves.toContain('deterministic V3 creation contract');

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    expect(await readOperationJournal(home, operationId)).toMatchObject({
      state: 'committed',
      actorId,
      sessionId,
    });
    expect((await readSession(root, sessionId))?.activeTaskRef).toEqual(
      created.taskRef,
    );
  });

  it('requires a privacy confirmation and joined profile before creating shared authority', async () => {
    const { actorId, sessionId } = await bootstrap(root, true);
    const taskId = id(8);
    const request = {
      projectRoot: root,
      task: 'Coordinate shared review responsibilities.',
      workflowMode: 'manteam' as const,
      sessionId,
      client: 'vitest',
      taskId,
      operationId: id(9),
      now: NOW,
    };

    await expect(createV3Workflow(request)).rejects.toThrow(
      'MANCODE_PRIVACY_CONFIRMATION_REQUIRED',
    );
    await expect(
      readFile(
        path.join(
          root,
          '.mancode',
          'shared',
          'workflows',
          taskId,
          'metadata.json',
        ),
        'utf8',
      ),
    ).rejects.toThrow();

    const localActor = await readLocalActor(root);
    expect(localActor).not.toBeNull();
    if (localActor === null) throw new Error('missing test local actor');
    await publishSharedActorProfile(
      root,
      createSharedActorProfile(localActor, NOW),
    );

    const created = await createV3Workflow({
      ...request,
      sharedPrivacyConfirmed: true,
    });
    expect(created.taskRef.namespace).toBe('shared');
    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    expect(await readTaskHeadFence(home, created.taskRef)).toMatchObject({
      taskRef: created.taskRef,
      taskRevision: 1,
      aggregateDigest: expect.stringMatching(/^sha256:/),
    });
  });

  it("creates a child only from its owner's step-six parent and freezes the inherited snapshot", async () => {
    const { sessionId } = await bootstrap(root, false);
    const parent = await createV3Workflow({
      projectRoot: root,
      task: 'Investigate an intermittent verification failure.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(10),
      operationId: id(11),
      implementationScope: { include: ['src/**'], modules: ['core'] },
      now: NOW,
    });
    const parentPath = path.join(
      taskRootPath(root, parent.taskRef),
      'metadata.json',
    );
    const stepSix = parseWorkflowMetadata({
      ...parent.metadata,
      revision: 2,
      currentStep: 6,
      updatedAt: '2026-07-17T10:05:00.000Z',
    });
    await writeFile(parentPath, `${JSON.stringify(stepSix, null, 2)}\n`);

    const child = await createV3Workflow({
      projectRoot: root,
      task: 'Reproduce the narrow verification failure.',
      workflowMode: 'manba',
      sessionId,
      client: 'vitest',
      parentTaskRef: parent.taskRef,
      taskId: id(12),
      operationId: id(13),
      now: NOW,
    });

    expect(child.taskRef.namespace).toBe('local');
    expect(child.metadata.parent).toMatchObject({
      taskRef: parent.taskRef,
      revisionAtCreate: 2,
      planVersionAtCreate: 1,
    });
    expect(child.metadata.implementationScope).toMatchObject({
      source: 'inherited',
      include: ['src/**'],
      modules: ['core'],
    });
    expect(child.resolution.dimensions.visibility.source).toBe('parent');

    const staleParent = parseWorkflowMetadata({
      ...stepSix,
      revision: 3,
      updatedAt: '2026-07-17T10:06:00.000Z',
    });
    await writeFile(parentPath, `${JSON.stringify(staleParent, null, 2)}\n`);

    await expect(
      openV3TaskOperation({
        projectRoot: root,
        taskRef: child.taskRef,
        sessionId,
        expectedTaskRevision: child.metadata.revision,
        operationId: id(14),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_PARENT_STALE');
  });

  it('repairs or aborts workflow creation at every declared crash point', async () => {
    const fixtures = OPERATION_CRASH_FIXTURES.workflow_create;
    for (const [index, fixture] of fixtures.entries()) {
      const caseRoot = path.join(root, `create-crash-${index}`);
      await mkdir(caseRoot);
      const { actorId, sessionId } = await bootstrap(caseRoot, false);
      const taskId = id(100 + index);
      const operationId = id(120 + index);

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          createV3Workflow({
            projectRoot: caseRoot,
            task: 'Exercise a durable workflow creation boundary.',
            workflowMode: 'man',
            sessionId,
            client: 'vitest',
            taskId,
            operationId,
            now: NOW,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      const recovered = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId,
        actorId,
        sessionId,
        now: NOW,
      });
      if (fixture.expectedRecovery === 'safe_abort') {
        expect(recovered).toMatchObject({
          journal: { state: 'aborted' },
        });
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
  });
});

async function bootstrap(
  projectRoot: string,
  withGit: boolean,
): Promise<{ actorId: Ulid; sessionId: Ulid }> {
  if (withGit) {
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
    displayName: 'Vitest User',
    now: NOW,
  });
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  return { actorId, sessionId };
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

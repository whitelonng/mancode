import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { mergeV3ChildResult } from '../src/context/child-result-merge.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { taskRootPath } from '../src/context/task-locator.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { parseWorkflowMetadata } from '../src/context/workflow-metadata.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';

const NOW = new Date('2026-07-17T21:00:00.000Z');

describe('V3 child result merge', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-child-merge-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records a completed child result as a parent checkpoint under both task revisions', async () => {
    const fixture = await createParentAndCompletedChild(root, 'verified');

    const merged = await mergeV3ChildResult({
      projectRoot: root,
      parentTaskRef: fixture.parent.taskRef,
      childTaskRef: fixture.child.taskRef,
      sessionId: fixture.sessionId,
      expectedParentRevision: fixture.parentRevision,
      expectedChildRevision: fixture.childRevision,
      summary: 'The diagnostic run reproduced and verified the expected fix.',
      nextAction: 'Continue the parent verification plan.',
      checkpointId: id(20),
      operationId: id(21),
      now: NOW,
    });

    expect(merged).toMatchObject({
      metadata: {
        revision: 4,
        status: 'in_progress',
        currentStep: 6,
        transitionState: 'stable',
        latestCheckpointRef: { artifactId: id(20) },
        lastOperationId: id(21),
      },
      checkpoint: {
        checkpointId: id(20),
        operationId: id(21),
        taskRef: fixture.parent.taskRef,
        taskRevision: 3,
        kind: 'verification_completed',
      },
      operation: { type: 'child_result_merge', state: 'committed' },
    });
    expect(merged.checkpoint.summary).toContain(
      `local:${fixture.child.taskRef.taskId}`,
    );

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      fixture.parent.taskRef,
    );
    await expect(readOperationJournal(home, id(21))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:local:${fixture.parent.taskRef.taskId}`]: 2,
        [`task:local:${fixture.child.taskRef.taskId}`]: 2,
        [`checkpoint:${id(20)}`]: 0,
      },
      entityLocks: expect.arrayContaining([
        `task:local:${fixture.child.taskRef.taskId}`,
        `checkpoint:${id(20)}`,
      ]),
    });
  });

  it('blocks a manual-required child on the parent and rejects stale child snapshots', async () => {
    const manual = await createParentAndCompletedChild(
      root,
      'manual_test_required',
    );
    const blocked = await mergeV3ChildResult({
      projectRoot: root,
      parentTaskRef: manual.parent.taskRef,
      childTaskRef: manual.child.taskRef,
      sessionId: manual.sessionId,
      expectedParentRevision: manual.parentRevision,
      expectedChildRevision: manual.childRevision,
      summary: 'An external device is required for the final diagnostic.',
      nextAction: 'Run the device validation.',
      checkpointId: id(30),
      operationId: id(31),
      now: NOW,
    });
    expect(blocked).toMatchObject({
      metadata: {
        status: 'blocked',
        blockingReason: expect.stringContaining('requires manual testing'),
      },
      checkpoint: { kind: 'blocked' },
    });

    const staleRoot = path.join(root, 'stale');
    await mkdir(staleRoot, { recursive: true });
    const stale = await createParentAndCompletedChild(staleRoot, 'fixed', 40);
    await writeMetadata(staleRoot, stale.parent.taskRef, {
      ...stale.parent.metadata,
      revision: 3,
      currentStep: 6,
      updatedAt: new Date(NOW.getTime() + 1_000).toISOString(),
    });
    await expect(
      mergeV3ChildResult({
        projectRoot: staleRoot,
        parentTaskRef: stale.parent.taskRef,
        childTaskRef: stale.child.taskRef,
        sessionId: stale.sessionId,
        expectedParentRevision: 3,
        expectedChildRevision: stale.childRevision,
        summary: 'This stale result must not be applied.',
        nextAction: 'Recreate the diagnostic child.',
        checkpointId: id(50),
        operationId: id(51),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_PARENT_STALE');
  });
});

async function createParentAndCompletedChild(
  projectRoot: string,
  outcome: 'fixed' | 'verified' | 'manual_test_required',
  offset = 10,
): Promise<{
  sessionId: Ulid;
  parent: Awaited<ReturnType<typeof createV3Workflow>>;
  child: Awaited<ReturnType<typeof createV3Workflow>>;
  parentRevision: number;
  childRevision: number;
}> {
  const sessionId = await bootstrap(projectRoot, offset);
  const parent = await createV3Workflow({
    projectRoot,
    task: `Investigate diagnostic result ${offset}.`,
    workflowMode: 'man',
    sessionId,
    client: 'vitest',
    taskId: id(offset),
    operationId: id(offset + 1),
    implementationScope: { include: ['src/**'], modules: ['core'] },
    now: NOW,
  });
  const parentAtVerification = parseWorkflowMetadata({
    ...parent.metadata,
    revision: 2,
    currentStep: 6,
    updatedAt: NOW.toISOString(),
  });
  await writeMetadata(projectRoot, parent.taskRef, parentAtVerification);
  const child = await createV3Workflow({
    projectRoot,
    task: `Diagnose result ${offset}.`,
    workflowMode: 'manba',
    sessionId,
    client: 'vitest',
    parentTaskRef: parent.taskRef,
    taskId: id(offset + 2),
    operationId: id(offset + 3),
    now: NOW,
  });
  const completedChild = parseWorkflowMetadata({
    ...child.metadata,
    status: 'completed',
    currentStep: 5,
    outcome,
    revision: 2,
    updatedAt: NOW.toISOString(),
  });
  await writeMetadata(projectRoot, child.taskRef, completedChild);
  return {
    sessionId,
    parent,
    child,
    parentRevision: parentAtVerification.revision,
    childRevision: completedChild.revision,
  };
}

async function bootstrap(projectRoot: string, offset: number): Promise<Ulid> {
  await initializeV3Project({
    projectRoot,
    operationId: id(offset + 60),
    workspaceId: id(offset + 61),
    schemaEpoch: id(offset + 62),
    now: NOW,
  });
  const actorId = id(offset + 63);
  const sessionId = id(offset + 64);
  await createLocalActor(projectRoot, {
    actorId,
    displayName: `Child Merge Owner ${offset}`,
    now: NOW,
  });
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  return sessionId;
}

async function writeMetadata(
  projectRoot: string,
  taskRef: { namespace: 'local' | 'shared'; taskId: Ulid },
  metadata: unknown,
): Promise<void> {
  await writeFile(
    path.join(taskRootPath(projectRoot, taskRef), 'metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

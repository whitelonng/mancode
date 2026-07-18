import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { updateV3Workflow } from '../src/context/workflow-update.js';
import { resolveLocalEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';

const NOW = new Date('2026-07-18T16:00:00.000Z');

describe('V3 lifecycle-only workflow update', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-workflow-update-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('changes only lifecycle status through a journaled revision and blocks terminal shortcuts', async () => {
    const actorId = id(4);
    const sessionId = id(5);
    const taskId = id(6);
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
    await createLocalActor(root, {
      actorId,
      displayName: 'Update Owner',
      now: NOW,
    });
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now: NOW,
    });
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Pause a local workflow without changing its governance fields.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId,
      operationId: id(7),
      now: NOW,
    });

    const blocked = await updateV3Workflow({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: 1,
      status: 'blocked',
      blockingReason: 'Awaiting an external dependency.',
      operationId: id(8),
      now: NOW,
    });
    expect(blocked).toMatchObject({
      metadata: {
        revision: 2,
        status: 'blocked',
        blockingReason: 'Awaiting an external dependency.',
        transitionState: 'stable',
      },
      taskHeadFence: null,
      operation: { type: 'workflow_update', state: 'committed' },
    });
    await expect(
      new V3ContextStore(root).readTaskSnapshot(created.taskRef),
    ).resolves.toMatchObject({
      metadata: {
        revision: 2,
        status: 'blocked',
        governance: created.metadata.governance,
      },
      aggregate: blocked.aggregate,
    });
    const runtime = await readProjectRuntimeContext(root);
    const home = resolveLocalEntityHomeStore(runtime.entityHomeStoreContext);
    await expect(readOperationJournal(home, id(8))).resolves.toMatchObject({
      type: 'workflow_update',
      expectedRevisions: { [`task:local:${taskId}`]: 1 },
    });

    await expect(
      updateV3Workflow({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: 2,
        status: 'completed',
        operationId: id(9),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_WORKFLOW_COMPLETE_COMMAND_REQUIRED');

    await expect(
      updateV3Workflow({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: 2,
        status: 'in_progress',
        operationId: id(10),
        now: NOW,
      }),
    ).resolves.toMatchObject({
      metadata: {
        revision: 3,
        status: 'in_progress',
        blockingReason: null,
      },
    });
  });
});

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

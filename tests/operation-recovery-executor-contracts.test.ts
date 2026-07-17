import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { taskRootPath } from '../src/context/task-locator.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { readLocalDiagnostics } from '../src/runtime/diagnostics.js';
import { resolveLocalEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { getOperationDefinition } from '../src/runtime/operation-definition.js';
import type { OperationJournalV1 } from '../src/runtime/operation-journal.js';
import {
  executeOperationRecovery,
  inspectOperationRecovery,
} from '../src/runtime/operation-recovery-executor.js';
import {
  createTaskAuthorityFileRecoveryAction,
  createWorkflowTaskDirectoryRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../src/runtime/operation-recovery-payload.js';
import { writeOperationRecoveryPayload } from '../src/runtime/operation-recovery-store.js';
import { createPreparedOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession } from '../src/runtime/session.js';
import {
  advanceTaskOperation,
  createTaskOperationJournal,
  openV3TaskOperation,
  serializeTaskAuthority,
  taskEntityKey,
  writeTaskAuthorityFile,
} from '../src/runtime/task-operation.js';
import { createLocalActor } from '../src/team/actor.js';
import { createAuthorizationBasis } from '../src/team/authorization.js';

const NOW = new Date('2026-07-17T13:00:00.000Z');

describe('operation recovery executor', () => {
  let root: string;
  let actorId: Ulid;
  let sessionId: Ulid;
  let taskId: Ulid;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-operation-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
    actorId = id(4);
    sessionId = id(5);
    taskId = id(6);
    await createLocalActor(root, {
      actorId,
      displayName: 'Recovery User',
      now: NOW,
    });
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now: NOW,
    });
    await createV3Workflow({
      projectRoot: root,
      task: 'Exercise exact operation recovery targets.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId,
      operationId: id(7),
      now: NOW,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('replays only durable targets after a visible write and commits idempotently', async () => {
    const operationId = id(8);
    const plan =
      '# Recovery plan\n\nResume from the durable write-ahead target.\n';
    const journal = await prepareInterruptedPlan(operationId, plan, true);

    await expect(
      executeOperationRecovery({
        projectRoot: root,
        operationId,
        actorId,
        sessionId,
        mode: 'abort',
      }),
    ).rejects.toThrow('MANCODE_OPERATION_ABORT_UNSAFE');

    await expect(
      executeOperationRecovery({
        projectRoot: root,
        operationId,
        actorId,
        sessionId,
      }),
    ).resolves.toMatchObject({
      state: 'repaired',
      journal: { operationId, state: 'committed' },
    });
    await expect(
      readFile(
        path.join(
          taskRootPath(root, { namespace: 'local', taskId }),
          'plan.md',
        ),
        'utf8',
      ),
    ).resolves.toBe(plan);
    await expect(
      inspectOperationRecovery(root, operationId),
    ).resolves.toMatchObject({
      journal: { state: 'committed' },
      payloadBound: true,
    });
    await expect(readLocalDiagnostics(root)).resolves.toMatchObject({
      repairOperationCount: 1,
    });
    expect(journal.recoveryPayloadDigest).toMatch(/^sha256:/);
  });

  it('aborts a durable write intent only when every target remains at its initial state', async () => {
    const operationId = id(9);
    await prepareInterruptedPlan(operationId, '# Unwritten plan\n', false);

    await expect(
      executeOperationRecovery({
        projectRoot: root,
        operationId,
        actorId,
        sessionId,
        mode: 'abort',
      }),
    ).resolves.toMatchObject({
      state: 'aborted',
      journal: { operationId, state: 'aborted' },
    });
  });

  it('removes only the abandoned private workflow staging directory before a safe abort', async () => {
    const operationId = id(10);
    const recoveryTaskId = id(11);
    const taskRef = { namespace: 'local' as const, taskId: recoveryTaskId };
    const runtime = await readProjectRuntimeContext(root);
    const store = resolveLocalEntityHomeStore(runtime.entityHomeStoreContext);
    const sourceRoot = taskRootPath(root, {
      namespace: 'local',
      taskId,
    });
    const files = await Promise.all(
      [
        'metadata.json',
        'requirements.json',
        'review-ledger.json',
        'verification-ledger.json',
      ].map(async (fileName) => ({
        fileName,
        content: await readFile(path.join(sourceRoot, fileName), 'utf8'),
      })),
    );
    const payload = parseOperationRecoveryPayload({
      schemaVersion: 1,
      operationId,
      type: 'workflow_create',
      primaryStoreId: store.storeId,
      actions: [
        createWorkflowTaskDirectoryRecoveryAction({
          stepId: 'publish-task-directory',
          taskRef,
          files: files as Array<{
            fileName:
              | 'metadata.json'
              | 'requirements.json'
              | 'review-ledger.json'
              | 'verification-ledger.json';
            content: string;
          }>,
        }),
      ],
      noOpStepIds: ['publish-locator'],
    });
    await writeOperationRecoveryPayload(store, payload);
    const definition = getOperationDefinition('workflow_create');
    const journal: OperationJournalV1 = {
      schemaVersion: 1,
      operationId,
      type: 'workflow_create',
      state: 'prepared',
      primaryStoreId: store.storeId,
      checkoutId: runtime.checkoutId,
      secondaryReservations: [],
      actorId,
      sessionId,
      authorizationBasis: createAuthorizationBasis(
        {
          action: 'local_workflow_mutation',
          actorId,
          session: { sessionId, actorId, status: 'active' },
          joined: false,
          sharedWriteGuard: 'enforced',
          task: null,
          claim: null,
          handoff: null,
          evidence: null,
          profileActorId: null,
          conditions: { expectedRevisionMatches: true },
        },
        NOW,
      ),
      recoveryPayloadDigest: operationRecoveryPayloadDigest(payload),
      entityLocks: [
        `task:local:${recoveryTaskId}`,
        `locator:local:${recoveryTaskId}`,
      ],
      expectedRevisions: {
        [`task:local:${recoveryTaskId}`]: 0,
        [`locator:local:${recoveryTaskId}`]: 0,
      },
      steps: definition.steps.map((step) => ({
        id: step.id,
        state: 'pending',
      })),
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    await createPreparedOperationJournal(store, journal);
    const staging = path.join(
      path.dirname(taskRootPath(root, taskRef)),
      `.${recoveryTaskId}.${operationId}.staging`,
    );
    await mkdir(staging);
    await writeFile(path.join(staging, '.partial'), 'private staging\n');

    await expect(
      executeOperationRecovery({
        projectRoot: root,
        operationId,
        actorId,
        sessionId,
        mode: 'abort',
      }),
    ).resolves.toMatchObject({
      state: 'aborted',
      journal: { operationId, state: 'aborted' },
    });
    await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(taskRootPath(root, taskRef))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  async function prepareInterruptedPlan(
    operationId: Ulid,
    plan: string,
    writePlan: boolean,
  ) {
    const taskRef = { namespace: 'local' as const, taskId };
    const context = await openV3TaskOperation({
      projectRoot: root,
      taskRef,
      sessionId,
      expectedTaskRevision: 1,
      operationId,
      now: NOW,
    });
    try {
      const journal = await createTaskOperationJournal(context, {
        type: 'plan_revision',
        action: 'local_workflow_mutation',
        expectedRevisions: {
          [taskEntityKey(taskRef)]: context.task.metadata.revision,
          [`plan:local:${taskId}`]: 0,
          [`review:local:${taskId}`]: context.task.review.revision,
          [`verification:local:${taskId}`]: context.task.verification.revision,
        },
        recovery: {
          actions: [
            createTaskAuthorityFileRecoveryAction({
              stepId: 'write-plan',
              taskRef,
              fileName: 'plan.md',
              beforeContent: null,
              targetContent: plan,
            }),
            createTaskAuthorityFileRecoveryAction({
              stepId: 'update-metadata',
              taskRef,
              fileName: 'metadata.json',
              beforeContent: serializeTaskAuthority(context.task.metadata),
              targetContent: serializeTaskAuthority(context.task.metadata),
            }),
            createTaskAuthorityFileRecoveryAction({
              stepId: 'mark-review-verification-stale',
              taskRef,
              fileName: 'review-ledger.json',
              beforeContent: serializeTaskAuthority(context.task.review),
              targetContent: serializeTaskAuthority(context.task.review),
            }),
            createTaskAuthorityFileRecoveryAction({
              stepId: 'mark-review-verification-stale',
              taskRef,
              fileName: 'verification-ledger.json',
              beforeContent: serializeTaskAuthority(context.task.verification),
              targetContent: serializeTaskAuthority(context.task.verification),
            }),
          ],
          noOpStepIds: ['update-task-head-fence'],
        },
      });
      const validated = await advanceTaskOperation(
        context,
        journal,
        'validate',
        true,
      );
      const intended = await advanceTaskOperation(
        context,
        validated,
        'write-plan',
        false,
      );
      if (writePlan) {
        await writeTaskAuthorityFile(context, 'plan.md', plan);
      }
      return intended;
    } finally {
      await context.release();
    }
  }
});

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

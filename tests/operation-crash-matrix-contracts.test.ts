import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { taskRootPath } from '../src/context/task-locator.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import {
  throwIfOperationCrashInjected,
  withOperationCrashInjectionForTesting,
} from '../src/runtime/operation-crash-injection.js';
import {
  OPERATION_CRASH_FIXTURES,
  OPERATION_DEFINITIONS,
  assertOperationJournalMatchesDefinition,
} from '../src/runtime/operation-definition.js';
import type {
  OperationJournalV1,
  OperationType,
} from '../src/runtime/operation-journal.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import {
  assertOperationRecoveryPayloadCoversJournal,
  createTaskAuthorityFileRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../src/runtime/operation-recovery-payload.js';
import { writeOperationRecoveryPayload } from '../src/runtime/operation-recovery-store.js';
import { createPreparedOperationJournal } from '../src/runtime/operation-store.js';
import { createSession } from '../src/runtime/session.js';
import {
  advanceTaskOperation,
  commitTaskOperation,
  openV3TaskOperation,
  taskEntityKey,
  writeTaskAuthorityFile,
} from '../src/runtime/task-operation.js';
import { createLocalActor } from '../src/team/actor.js';

const NOW = new Date('2026-07-18T08:00:00.000Z');

describe('operation crash recovery matrix', () => {
  let root: string;
  let actorId: Ulid;
  let sessionId: Ulid;
  let taskRef: TaskRef;
  let nextIdOffset: number;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-operation-crash-matrix-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,
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
    taskRef = { namespace: 'local', taskId: id(6) };
    nextIdOffset = 20;
    await createLocalActor(root, {
      actorId,
      displayName: 'Crash Matrix User',
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
      task: 'Exercise every durable operation crash boundary.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: taskRef.taskId,
      operationId: id(7),
      now: NOW,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('executes safe abort or forward repair at every declared crash point', async () => {
    let exercised = 0;
    for (const definition of Object.values(OPERATION_DEFINITIONS)) {
      for (const fixture of OPERATION_CRASH_FIXTURES[definition.type]) {
        exercised += 1;
        const operationId = nextId();
        const initialPlan = await readOptionalPlan(root, taskRef);
        const businessSteps = definition.steps.filter(
          (step) => step.visibility === 'business_write',
        );
        let beforeContent = initialPlan;
        const actions = businessSteps.map((step, index) => {
          const targetContent = `# Crash matrix\n\n${definition.type}:${fixture.crashAfter}:${index}\n`;
          const action = createTaskAuthorityFileRecoveryAction({
            stepId: step.id,
            taskRef,
            fileName: 'plan.md',
            beforeContent,
            targetContent,
          });
          beforeContent = targetContent;
          return action;
        });
        const actionByStep = new Map(
          actions.map((action) => [action.stepId, action]),
        );
        const requiredLocks = requiredKeys(definition.type, taskRef, 'locks');
        const expectedRevisions = Object.fromEntries(
          requiredKeys(definition.type, taskRef, 'revisions').map((key) => [
            key,
            key === taskEntityKey(taskRef) ? 1 : 0,
          ]),
        );
        const context = await openV3TaskOperation({
          projectRoot: root,
          taskRef,
          sessionId,
          expectedTaskRevision: 1,
          operationId,
          extraEntityLocks: requiredLocks.filter(
            (key) => key !== taskEntityKey(taskRef),
          ),
          now: new Date(NOW.getTime() + nextIdOffset),
        });
        try {
          const payload = parseOperationRecoveryPayload({
            schemaVersion: 1,
            operationId,
            type: definition.type,
            primaryStoreId: context.homeStore.storeId,
            actions,
            noOpStepIds: [],
          });
          const prepared: OperationJournalV1 = {
            schemaVersion: 1,
            operationId,
            type: definition.type,
            state: 'prepared',
            primaryStoreId: context.homeStore.storeId,
            checkoutId: context.runtime.checkoutId,
            secondaryReservations: [],
            actorId,
            sessionId,
            authorizationBasis: {
              schemaVersion: 1,
              action: definition.authorizationActions[0],
              actorId,
              sessionId,
              trustBoundary: 'repo-collaborators',
              decisionDigest: `sha256:${'a'.repeat(64)}`,
              authorizedAt: NOW.toISOString(),
            },
            recoveryPayloadDigest: operationRecoveryPayloadDigest(payload),
            entityLocks: context.entityLocks,
            expectedRevisions,
            steps: definition.steps.map((step) => ({
              id: step.id,
              state: 'pending',
            })),
            startedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          };
          assertOperationJournalMatchesDefinition(prepared);
          assertOperationRecoveryPayloadCoversJournal(prepared, payload);

          await expect(
            withOperationCrashInjectionForTesting(fixture, async () => {
              await writeOperationRecoveryPayload(context.homeStore, payload);
              let journal = await createPreparedOperationJournal(
                context.homeStore,
                prepared,
              );
              if (fixture.crashAfter === 'prepared') {
                throwIfOperationCrashInjected(definition.type, 'prepared');
              }
              for (const step of definition.steps) {
                if (step.id === 'commit') {
                  journal = await commitTaskOperation(context, journal);
                  continue;
                }
                journal = await advanceTaskOperation(
                  context,
                  journal,
                  step.id,
                  step.visibility === 'preparation',
                );
                if (step.visibility === 'business_write') {
                  const action = actionByStep.get(step.id);
                  if (action === undefined) {
                    throw new Error('missing crash matrix recovery action');
                  }
                  await writeTaskAuthorityFile(
                    context,
                    'plan.md',
                    action.targetContent,
                  );
                }
              }
              return journal;
            }),
          ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
        } finally {
          await context.release();
        }

        const recovered = await executeOperationRecovery({
          projectRoot: root,
          operationId,
          actorId,
          sessionId,
          mode: fixture.expectedRecovery === 'safe_abort' ? 'abort' : 'repair',
        });
        if (fixture.crashAfter === 'commit') {
          expect(recovered).toMatchObject({
            state: 'already_terminal',
            journal: { state: 'committed' },
          });
        } else if (fixture.expectedRecovery === 'safe_abort') {
          expect(recovered).toMatchObject({
            state: 'aborted',
            journal: { state: 'aborted' },
          });
          expect(await readOptionalPlan(root, taskRef)).toBe(initialPlan);
        } else {
          expect(recovered).toMatchObject({
            state: 'repaired',
            journal: { state: 'committed' },
          });
          expect(await readOptionalPlan(root, taskRef)).toBe(
            actions.at(-1)?.targetContent,
          );
        }
      }
    }

    expect(exercised).toBeGreaterThan(
      Object.keys(OPERATION_DEFINITIONS).length,
    );
  }, 45_000);

  function nextId(): Ulid {
    const value = id(nextIdOffset);
    nextIdOffset += 1;
    return value;
  }
});

function requiredKeys(
  type: OperationType,
  taskRef: TaskRef,
  family: 'locks' | 'revisions',
): string[] {
  const definition = OPERATION_DEFINITIONS[type];
  const prefixes = new Set(
    definition.steps.flatMap((step) =>
      family === 'locks'
        ? step.requiredLockPrefixes
        : step.expectedRevisionPrefixes,
    ),
  );
  prefixes.add('task:');
  return [...prefixes].map((prefix) =>
    prefix === 'task:' ? taskEntityKey(taskRef) : `${prefix}${taskRef.taskId}`,
  );
}

async function readOptionalPlan(
  root: string,
  taskRef: TaskRef,
): Promise<string | null> {
  try {
    return await readFile(
      path.join(taskRootPath(root, taskRef), 'plan.md'),
      'utf8',
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

function id(offset: number): Ulid {
  return createUlid(
    NOW.getTime() + offset,
    new Uint8Array(10).fill((offset % 251) + 1),
  );
}

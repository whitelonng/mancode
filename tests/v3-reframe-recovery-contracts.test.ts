import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { reframeV3Workflow } from '../src/context/reframe.js';
import { V3ContextStore } from '../src/context/store.js';
import { taskRootPath } from '../src/context/task-locator.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import {
  type OperationRecoveryActionV1,
  type OperationRecoveryPayloadV1,
  type TaskAuthorityFileName,
  taskArchiveManifest,
} from '../src/runtime/operation-recovery-payload.js';
import { readOperationRecoveryPayload } from '../src/runtime/operation-recovery-store.js';
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
import { confirmManteamPlan } from './helpers/manteam-plan.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-21T14:00:00.000Z');

describe('V3 reframe crash recovery', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-reframe-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('aborts preparation and forward-repairs every durable reframe write boundary exactly once', async () => {
    const fixtures = OPERATION_CRASH_FIXTURES.reframe;
    expect(
      fixtures
        .filter((fixture) => fixture.expectedRecovery === 'safe_abort')
        .map((fixture) => fixture.crashAfter),
    ).toEqual(['prepared', 'validate']);

    for (const [index, fixture] of fixtures.entries()) {
      const caseRoot = path.join(root, `crash-${index}`);
      await mkdir(caseRoot);
      const actors = await bootstrap(caseRoot);
      const created = await createV3Workflow({
        projectRoot: caseRoot,
        task: 'Recover a shared reframe from every declared crash boundary.',
        workflowMode: 'manteam',
        sessionId: actors.sessionId,
        client: 'vitest',
        sharedPrivacyConfirmed: true,
        implementationScope: {
          include: ['src/context/**'],
          modules: ['governance'],
        },
        taskId: id(10),
        operationId: id(11),
        now: NOW,
      });
      const confirmed = await confirmManteamPlan({
        projectRoot: caseRoot,
        taskRef: created.taskRef,
        sessionId: actors.sessionId,
        requirements: created.requirements,
        now: NOW,
      });
      const acquired = await acquireV3Claim({
        projectRoot: caseRoot,
        taskRef: created.taskRef,
        sessionId: actors.sessionId,
        expectedTaskRevision: confirmed.taskRevision,
        scope: {
          paths: ['src/context/**'],
          modules: ['governance'],
          apis: [],
          schemas: [],
        },
        claimId: id(12),
        operationId: id(13),
        now: NOW,
      });
      const store = new V3ContextStore(caseRoot);
      const beforeTask = await store.readTaskSnapshot(created.taskRef);
      const runtime = await readProjectRuntimeContext(caseRoot);
      const home = resolveTaskEntityHomeStore(
        runtime.entityHomeStoreContext,
        created.taskRef,
      );
      const beforeCoordination = await store.readCoordinationSnapshot(
        created.taskRef,
        home,
      );
      const operationId = id(100 + index);
      const checkpointId = id(200 + index);

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          reframeV3Workflow({
            projectRoot: caseRoot,
            taskRef: created.taskRef,
            sessionId: actors.sessionId,
            expectedTaskRevision: beforeTask.metadata.revision,
            checkpointId,
            summary: 'Recover the interrupted requirements reframe.',
            nextAction: 'Clarify the replacement requirements.',
            operationId,
            now: NOW,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      const payload = await readOperationRecoveryPayload(home, operationId);
      if (payload === null) throw new Error('missing reframe recovery payload');

      const recovered = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId,
        actorId: actors.actorId,
        sessionId: actors.sessionId,
        now: NOW,
      });

      if (fixture.expectedRecovery === 'safe_abort') {
        expect(['aborted', 'already_terminal']).toContain(recovered.state);
        expect(recovered.journal.state).toBe('aborted');
        await expectAbortedAuthority({
          projectRoot: caseRoot,
          taskRef: created.taskRef,
          home,
          beforeTask,
          beforeCoordination,
          operationId,
        });
      } else {
        expect(recovered.state).toBe(
          fixture.crashAfter === 'commit' ? 'already_terminal' : 'repaired',
        );
        await expectCommittedTarget({
          projectRoot: caseRoot,
          taskRef: created.taskRef,
          home,
          payload,
          operationId,
          checkpointId,
          beforeTask,
          claimId: acquired.claim.claimId,
          beforeClaimRevision: acquired.claim.revision,
        });
      }

      const terminal = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId,
        actorId: actors.actorId,
        sessionId: actors.sessionId,
        now: NOW,
      });
      expect(terminal).toMatchObject({
        state: 'already_terminal',
        journal: {
          state:
            fixture.expectedRecovery === 'safe_abort' ? 'aborted' : 'committed',
        },
      });
    }
  }, 120_000);
});

async function expectAbortedAuthority(input: {
  projectRoot: string;
  taskRef: TaskRef;
  home: ReturnType<typeof resolveTaskEntityHomeStore>;
  beforeTask: Awaited<ReturnType<V3ContextStore['readTaskSnapshot']>>;
  beforeCoordination: Awaited<
    ReturnType<V3ContextStore['readCoordinationSnapshot']>
  >;
  operationId: Ulid;
}): Promise<void> {
  const store = new V3ContextStore(input.projectRoot);
  const [task, coordination, journal] = await Promise.all([
    store.readTaskSnapshot(input.taskRef),
    store.readCoordinationSnapshot(input.taskRef, input.home),
    readOperationJournal(input.home, input.operationId),
  ]);
  expect(task.metadata).toEqual(input.beforeTask.metadata);
  expect(task.requirements).toEqual(input.beforeTask.requirements);
  expect(task.review).toEqual(input.beforeTask.review);
  expect(task.verification).toEqual(input.beforeTask.verification);
  expect(task.plan).toEqual(input.beforeTask.plan);
  expect(task.latestCheckpoint).toEqual(input.beforeTask.latestCheckpoint);
  expect(coordination.claims).toEqual(input.beforeCoordination.claims);
  expect(coordination.taskHeadFence).toEqual(
    input.beforeCoordination.taskHeadFence,
  );
  expect(journal?.state).toBe('aborted');
  expect(
    await directoryNames(
      path.join(taskRootPath(input.projectRoot, input.taskRef), 'archives'),
    ),
  ).toEqual([]);
}

async function expectCommittedTarget(input: {
  projectRoot: string;
  taskRef: TaskRef;
  home: ReturnType<typeof resolveTaskEntityHomeStore>;
  payload: OperationRecoveryPayloadV1;
  operationId: Ulid;
  checkpointId: Ulid;
  beforeTask: Awaited<ReturnType<V3ContextStore['readTaskSnapshot']>>;
  claimId: Ulid;
  beforeClaimRevision: number;
}): Promise<void> {
  const store = new V3ContextStore(input.projectRoot);
  const [task, coordination, journal] = await Promise.all([
    store.readTaskSnapshot(input.taskRef),
    store.readCoordinationSnapshot(input.taskRef, input.home),
    readOperationJournal(input.home, input.operationId),
  ]);
  expect(task.metadata).toEqual(
    authorityTarget(input.payload, 'metadata.json'),
  );
  expect(task.requirements).toEqual(
    authorityTarget(input.payload, 'requirements.json'),
  );
  expect(task.review).toEqual(
    authorityTarget(input.payload, 'review-ledger.json'),
  );
  expect(task.verification).toEqual(
    authorityTarget(input.payload, 'verification-ledger.json'),
  );
  expect(task.plan).toEqual(input.beforeTask.plan);
  expect(task.aggregateError).toBeNull();
  expect(task.aggregate).not.toBeNull();

  const checkpoint = singleAction(input.payload, 'checkpoint').checkpoint;
  expect(checkpoint.checkpointId).toBe(input.checkpointId);
  expect(task.latestCheckpoint).toEqual(checkpoint);

  const targetClaim = singleAction(input.payload, 'claim').claim;
  const persistedClaim = coordination.claims.find(
    (claim) => claim.claimId === input.claimId,
  );
  expect(targetClaim).toMatchObject({
    claimId: input.claimId,
    state: 'released',
    revision: input.beforeClaimRevision + 1,
    lastOperationId: input.operationId,
  });
  expect(persistedClaim).toEqual(targetClaim);

  const targetFence = singleAction(input.payload, 'task_head_fence').fence;
  expect(coordination.taskHeadFence).toEqual(targetFence);
  expect(targetFence).toMatchObject({
    taskRevision: task.metadata.revision,
    lastOperationId: input.operationId,
  });
  expect(coordination.pendingOperations).toEqual([]);
  expect(journal).toMatchObject({
    operationId: input.operationId,
    type: 'reframe',
    state: 'committed',
  });

  const archive = singleAction(input.payload, 'task_archive');
  const archiveParent = path.join(
    taskRootPath(input.projectRoot, input.taskRef),
    'archives',
  );
  const archiveRoot = path.join(archiveParent, input.operationId);
  expect(await directoryNames(archiveParent)).toEqual([input.operationId]);
  expect(await directoryNames(archiveRoot)).toEqual(
    ['archive.json', 'plan.md', 'requirements.json'].sort(),
  );
  const [manifest, requirements, plan] = await Promise.all([
    readFile(path.join(archiveRoot, 'archive.json'), 'utf8'),
    readFile(path.join(archiveRoot, 'requirements.json'), 'utf8'),
    readFile(path.join(archiveRoot, 'plan.md'), 'utf8'),
  ]);
  expect(JSON.parse(manifest)).toEqual(taskArchiveManifest(archive));
  expect(requirements).toBe(archive.requirementsContent);
  expect(plan).toBe(archive.planContent);
}

function authorityTarget(
  payload: OperationRecoveryPayloadV1,
  fileName: TaskAuthorityFileName,
): unknown {
  const action = payload.actions
    .filter(
      (candidate) =>
        candidate.kind === 'task_authority_file' &&
        candidate.fileName === fileName,
    )
    .at(-1);
  if (action?.kind !== 'task_authority_file') {
    throw new Error(`missing ${fileName} recovery target`);
  }
  return JSON.parse(action.targetContent);
}

function singleAction<K extends OperationRecoveryActionV1['kind']>(
  payload: OperationRecoveryPayloadV1,
  kind: K,
): Extract<OperationRecoveryActionV1, { kind: K }> {
  const matches = payload.actions.filter((action) => action.kind === kind);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`expected one ${kind} recovery action`);
  }
  return matches[0] as Extract<OperationRecoveryActionV1, { kind: K }>;
}

async function directoryNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}

async function bootstrap(
  projectRoot: string,
): Promise<{ actorId: Ulid; sessionId: Ulid }> {
  await initializeGitFixture(projectRoot);
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
    displayName: 'Reframe Recovery Owner',
    now: NOW,
  });
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  const actor = await readLocalActor(projectRoot);
  if (actor === null) throw new Error('missing reframe recovery actor');
  await publishSharedActorProfile(
    projectRoot,
    createSharedActorProfile(actor, NOW),
  );
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

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-21T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

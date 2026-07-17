import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextDoctor } from '../src/commands/context.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createV3Checkpoint } from '../src/context/checkpoint-create.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { ContextResolver } from '../src/context/resolver.js';
import { V3ContextStore } from '../src/context/store.js';
import { taskRootPath } from '../src/context/task-locator.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import {
  type CacheInvalidationProjectionTargetV1,
  listProjectionIntents,
  projectionCachePath,
} from '../src/runtime/projection-outbox.js';
import {
  closeSession,
  createSession,
  readSession,
} from '../src/runtime/session.js';
import { createLocalActor, readSharedActorProfile } from '../src/team/actor.js';
import { listTeamEvents, teamEventDirectory } from '../src/team/events.js';
import { joinTeam } from '../src/team/join.js';

const NOW = new Date('2026-07-18T10:00:00.000Z');
const ACTOR_ID = id(4);
const SESSION_ID = id(5);

describe('eventual projection filesystem E2E', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(os.tmpdir(), 'mancode-projection-eventual-'),
    );
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
    await createLocalActor(root, {
      actorId: ACTOR_ID,
      displayName: 'Projection User',
      now: NOW,
    });
    await createSession(root, {
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      client: 'vitest',
      identitySource: 'explicit',
      now: NOW,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps a joined profile committed and lets doctor emit its failed audit event exactly once', async () => {
    const store = new V3ContextStore(root);
    const project = await store.readProjectSnapshot();
    const operationId = id(10);
    const input = {
      actor: {
        schemaVersion: 1 as const,
        actorId: ACTOR_ID,
        displayName: 'Projection User',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      projectConfig: project.config,
      teamPolicy: project.policy,
      operationId,
      eventId: id(11),
      confirmed: true,
      sync: false,
      now: NOW,
      projectRoot: root,
    };
    await rm(teamEventDirectory(root), { recursive: true });
    await writeFile(teamEventDirectory(root), 'blocks event directory\n');

    await expect(joinTeam(input)).rejects.toThrow();
    await expect(
      readSharedActorProfile(root, ACTOR_ID),
    ).resolves.not.toBeNull();
    await expect(listProjectionIntents(root)).resolves.toMatchObject([
      {
        operationId,
        state: 'pending',
        target: { kind: 'audit_event' },
      },
    ]);

    await rm(teamEventDirectory(root));
    await expect(runDoctorRepair(root, operationId)).resolves.toBe(0);
    await expect(listTeamEvents(root)).resolves.toHaveLength(1);
    await expect(listProjectionIntents(root)).resolves.toEqual([]);

    const retried = await joinTeam(input);
    expect(retried.event.operationId).toBe(operationId);
    await expect(listTeamEvents(root)).resolves.toHaveLength(1);
  });

  it('does not roll back a committed workflow when its session pointer fails and doctor later resumes it', async () => {
    const operationId = id(20);
    const sessionLock = path.join(
      root,
      '.mancode',
      'local',
      'sessions',
      `.${SESSION_ID}.lock`,
    );
    await mkdir(sessionLock);

    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Keep workflow authority independent from its session pointer.',
      workflowMode: 'man',
      sessionId: SESSION_ID,
      client: 'vitest',
      taskId: id(21),
      operationId,
      now: NOW,
    });
    expect(created).toMatchObject({
      sessionResumed: false,
      operation: { state: 'committed' },
      metadata: { transitionState: 'stable' },
    });
    const metadataPath = path.join(
      taskRootPath(root, created.taskRef),
      'metadata.json',
    );
    const committedMetadata = await readFile(metadataPath, 'utf8');
    await expect(readSession(root, SESSION_ID)).resolves.toMatchObject({
      activeTaskRef: null,
    });
    await expect(listProjectionIntents(root)).resolves.toMatchObject([
      {
        operationId,
        state: 'pending',
        target: { kind: 'session_pointer', action: 'resume' },
      },
    ]);

    await rm(sessionLock, { recursive: true });
    await expect(runDoctorRepair(root, operationId)).resolves.toBe(0);
    await expect(readSession(root, SESSION_ID)).resolves.toMatchObject({
      activeTaskRef: created.taskRef,
      activeMode: 'man',
      lastSeenRevision: created.metadata.revision,
    });
    await expect(readFile(metadataPath, 'utf8')).resolves.toBe(
      committedMetadata,
    );
    await expect(listProjectionIntents(root)).resolves.toEqual([]);
  });

  it.each(['closed', 'missing'] as const)(
    'supersedes a session projection when its target session is %s',
    async (targetState) => {
      const operationId = id(24);
      const sessionLock = path.join(
        root,
        '.mancode',
        'local',
        'sessions',
        `.${SESSION_ID}.lock`,
      );
      await mkdir(sessionLock);
      const created = await createV3Workflow({
        projectRoot: root,
        task: 'Keep terminal session state outside workflow authority.',
        workflowMode: 'man',
        sessionId: SESSION_ID,
        client: 'vitest',
        taskId: id(25),
        operationId,
        now: NOW,
      });
      expect(created.sessionResumed).toBe(false);
      const metadataPath = path.join(
        taskRootPath(root, created.taskRef),
        'metadata.json',
      );
      const committedMetadata = await readFile(metadataPath, 'utf8');
      await rm(sessionLock, { recursive: true });
      if (targetState === 'closed') {
        await closeSession(root, SESSION_ID, NOW);
      } else {
        await rm(
          path.join(
            root,
            '.mancode',
            'local',
            'sessions',
            `${SESSION_ID}.json`,
          ),
        );
      }
      const repairSessionId = id(26);
      await createSession(root, {
        actorId: ACTOR_ID,
        sessionId: repairSessionId,
        client: 'vitest',
        identitySource: 'explicit',
        now: NOW,
      });

      await expect(
        runDoctorRepair(root, operationId, repairSessionId),
      ).resolves.toBe(0);
      await expect(readFile(metadataPath, 'utf8')).resolves.toBe(
        committedMetadata,
      );
      await expect(
        listProjectionIntents(root, {
          operationId,
          includeTerminal: true,
        }),
      ).resolves.toMatchObject([{ state: 'superseded' }]);
      await expect(listProjectionIntents(root)).resolves.toEqual([]);
    },
  );

  it('supersedes projection intents after the authority journal safely aborts', async () => {
    const operationId = id(27);
    const fixture = OPERATION_CRASH_FIXTURES.workflow_create.find(
      (candidate) => candidate.crashAfter === 'prepared',
    );
    if (fixture === undefined)
      throw new Error('missing prepared crash fixture');
    const taskRef = { namespace: 'local' as const, taskId: id(28) };

    await expect(
      withOperationCrashInjectionForTesting(fixture, () =>
        createV3Workflow({
          projectRoot: root,
          task: 'Abort before publishing workflow authority.',
          workflowMode: 'man',
          sessionId: SESSION_ID,
          client: 'vitest',
          taskId: taskRef.taskId,
          operationId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    await expect(listProjectionIntents(root)).resolves.toHaveLength(1);

    await expect(runDoctorRepair(root, operationId)).resolves.toBe(0);
    await expect(
      readFile(path.join(taskRootPath(root, taskRef), 'metadata.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      listProjectionIntents(root, {
        operationId,
        includeTerminal: true,
      }),
    ).resolves.toMatchObject([{ state: 'superseded' }]);
    await expect(listProjectionIntents(root)).resolves.toEqual([]);
  });

  it('reads fresh authority despite stale cache files and lets doctor finish failed invalidation', async () => {
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Regenerate derived context after a checkpoint.',
      workflowMode: 'man',
      sessionId: SESSION_ID,
      client: 'vitest',
      taskId: id(30),
      operationId: id(31),
      now: NOW,
    });
    const resolver = await createResolver(root);
    const before = await resolveTask(resolver, root, created.taskRef);
    expect(before.pack.snapshot.taskRevision).toBe(1);
    expect(before.pack.latestCheckpoint).toBeNull();

    const operationId = id(32);
    const contextPackTarget: CacheInvalidationProjectionTargetV1 = {
      kind: 'cache_invalidation',
      cacheKind: 'context_pack',
      taskRef: created.taskRef,
    };
    const statusIndexTarget: CacheInvalidationProjectionTargetV1 = {
      kind: 'cache_invalidation',
      cacheKind: 'status_index',
      taskRef: created.taskRef,
    };
    const contextPackCache = projectionCachePath(root, contextPackTarget);
    const statusIndexCache = projectionCachePath(root, statusIndexTarget);
    await mkdir(contextPackCache, { recursive: true });
    await mkdir(path.dirname(statusIndexCache), { recursive: true });
    await writeFile(statusIndexCache, '{"taskRevision":1}\n');

    const checkpoint = await createV3Checkpoint({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId: SESSION_ID,
      expectedTaskRevision: 1,
      kind: 'diagnostic_started',
      summary: 'Advance task authority while cache invalidation is blocked.',
      checkpointId: id(33),
      operationId,
      now: new Date('2026-07-18T10:01:00.000Z'),
    });
    expect(checkpoint.operation.state).toBe('committed');
    await expect(listProjectionIntents(root)).resolves.toHaveLength(2);

    const after = await resolveTask(resolver, root, created.taskRef);
    expect(after.pack.snapshot.taskRevision).toBe(checkpoint.metadata.revision);
    expect(after.pack.latestCheckpoint).toMatchObject({
      checkpointId: checkpoint.checkpoint.checkpointId,
    });
    expect(after.pack.packDigest).not.toBe(before.pack.packDigest);

    await rm(contextPackCache, { recursive: true });
    await writeFile(contextPackCache, '{"taskRevision":1}\n');
    await expect(runDoctorRepair(root, operationId)).resolves.toBe(0);
    await expect(readFile(contextPackCache, 'utf8')).rejects.toThrow();
    await expect(readFile(statusIndexCache, 'utf8')).rejects.toThrow();
    await expect(listProjectionIntents(root)).resolves.toEqual([]);
  });
});

async function createResolver(projectRoot: string): Promise<ContextResolver> {
  const runtime = await readProjectRuntimeContext(projectRoot);
  return new ContextResolver({
    projectRoot,
    entityHomeStoreContext: runtime.entityHomeStoreContext,
  });
}

async function resolveTask(
  resolver: ContextResolver,
  projectRoot: string,
  taskRef: { namespace: 'local' | 'shared'; taskId: Ulid },
) {
  const [project, session] = await Promise.all([
    new V3ContextStore(projectRoot).readProjectSnapshot(),
    readSession(projectRoot, SESSION_ID),
  ]);
  if (session === null) throw new Error('missing projection test session');
  return resolver.resolve({
    session,
    taskRef,
    level: 'task',
    purpose: 'implement',
    compatibility: {
      expectedSchemaEpoch: project.manifest.epoch,
      readerVersion: project.manifest.minReaderVersion,
      writerVersion: project.manifest.minWriterVersion,
      adapterVersions: project.manifest.managedAdapters,
    },
    generatedAt: NOW,
  });
}

async function runDoctorRepair(
  projectRoot: string,
  operationId: Ulid,
  sessionId: Ulid = SESSION_ID,
): Promise<number> {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await contextDoctor(projectRoot, {
      repair: operationId,
      session: sessionId,
      client: 'vitest',
      json: true,
    });
  } finally {
    logs.mockRestore();
    errors.mockRestore();
  }
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamClaim } from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { readLocalDiagnostics } from '../src/runtime/diagnostics.js';
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
const NOW = new Date('2026-07-17T13:00:00.000Z');

describe('V3 claim acquisition', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-claim-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

  it('creates a shared active claim from the locked task snapshot and rejects overlap', async () => {
    const { sessionId } = await bootstrap(root);
    const workflow = await createV3Workflow({
      projectRoot: root,
      task: 'Acquire a narrow shared implementation claim.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: {
        include: ['src/**'],
        modules: ['auth'],
      },
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });

    const result = await acquireV3Claim({
      projectRoot: root,
      taskRef: workflow.taskRef,
      sessionId,
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

    expect(result.claim).toMatchObject({
      claimId: id(12),
      taskRef: workflow.taskRef,
      state: 'active',
      revision: 1,
      taskRevisionAtAcquire: 1,
      lastOperationId: id(13),
    });
    expect(result.operation).toMatchObject({
      type: 'claim_create',
      state: 'committed',
    });
    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      workflow.taskRef,
    );
    await expect(readOperationJournal(home, id(13))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${workflow.taskRef.taskId}`]: 1,
        [`claim:${id(12)}`]: 0,
      },
    });
    const coordination = await new V3ContextStore(
      root,
    ).readCoordinationSnapshot(workflow.taskRef, home);
    expect(coordination.claims).toEqual([result.claim]);

    await expect(
      acquireV3Claim({
        projectRoot: root,
        taskRef: workflow.taskRef,
        sessionId,
        expectedTaskRevision: 1,
        scope: {
          paths: ['src/auth/**'],
          modules: ['auth'],
          apis: [],
          schemas: [],
        },
        claimId: id(14),
        operationId: id(15),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_SCOPE_CONFLICT');
    await expect(readLocalDiagnostics(root)).resolves.toMatchObject({
      claimConflictCounts: { blocker: 1 },
    });
  });

  it('routes repeated scope fields through the team claim command', async () => {
    const { sessionId } = await bootstrap(root);
    const workflow = await createV3Workflow({
      projectRoot: root,
      task: 'Acquire a command-level shared claim.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: {
        include: ['src/**', 'tests/**'],
        modules: ['auth'],
      },
      taskId: id(20),
      operationId: id(21),
      now: NOW,
    });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await teamClaim(root, {
          task: `shared:${workflow.taskRef.taskId}`,
          expectedTaskRevision: '1',
          paths: ['tests/auth/**', 'src/auth/**'],
          modules: ['auth'],
          session: sessionId,
          client: 'vitest',
          json: true,
        }),
      ).toBe(0);
      const payload = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        claim: { state: string; scope: { paths: string[] } };
        operation: { type: string; state: string };
      };
      expect(payload).toMatchObject({
        claim: {
          state: 'active',
          scope: { paths: ['src/auth/**', 'tests/auth/**'] },
        },
        operation: { type: 'claim_create', state: 'committed' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });
});

async function bootstrap(projectRoot: string): Promise<{ sessionId: Ulid }> {
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
    displayName: 'Claim User',
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
  return { sessionId };
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

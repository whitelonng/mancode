import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  teamClaim,
  teamClaimReclaim,
  teamClaimRelease,
  teamClaimRenew,
  teamClaimRevalidate,
  teamClaimTransfer,
  teamConflicts,
  teamHandoffAccept,
  teamHandoffCancel,
  teamHandoffDraft,
  teamHandoffOffer,
  teamHandoffReject,
  teamStatus,
} from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { workflow } from '../src/commands/workflow.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
} from '../src/team/actor.js';
import {
  gitRefCachePath,
  writeGitRefTeamCache,
} from '../src/team/git-ref-cache.js';
import type { ProjectConfigV1 } from '../src/team/policy.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-18T12:00:00.000Z');

describe('git-ref command explicit-sync contract', () => {
  let root: string;
  let sessionId: Ulid;
  let receiverActorId: Ulid;
  let taskRef: `shared:${string}`;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-git-ref-command-'));
    await initializeGitFixture(root);
    const fixture = await initializeSharedTask(root);
    sessionId = fixture.sessionId;
    receiverActorId = fixture.receiverActorId;
    taskRef = `shared:${fixture.taskId}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps git-ref mutations behind explicit sync and reads status from cache', async () => {
    const config = await setGitRefConfig(root);
    const fetchedAt = new Date().toISOString();
    await writeGitRefTeamCache(root, config, {
      manifest: null,
      commit: null,
      receipt: null,
      fetchedAt,
    });
    const cacheBefore = await readFile(gitRefCachePath(root), 'utf8');
    const tracePath = path.join(root, 'git-trace.jsonl');
    vi.stubEnv('GIT_TRACE2_EVENT', tracePath);

    const claimId = id(20);
    const handoffId = id(21);
    const common = { session: sessionId, client: 'vitest', json: true };
    const mutations: Array<{ name: string; action: () => Promise<number> }> = [
      {
        name: 'claim',
        action: () =>
          teamClaim(root, {
            ...common,
            task: taskRef,
            expectedTaskRevision: '1',
            paths: ['src/**'],
          }),
      },
      {
        name: 'handoff draft',
        action: () =>
          teamHandoffDraft(root, {
            ...common,
            task: taskRef,
            expectedTaskRevision: '1',
            to: receiverActorId,
          }),
      },
    ];
    const claimOptions = {
      ...common,
      claimId,
      expectedRevision: '1',
      to: receiverActorId,
      reason: 'Recover abandoned scope.',
    };
    for (const [name, command] of [
      ['claim renew', teamClaimRenew],
      ['claim release', teamClaimRelease],
      ['claim transfer', teamClaimTransfer],
      ['claim reclaim', teamClaimReclaim],
      ['claim revalidate', teamClaimRevalidate],
    ] as const) {
      mutations.push({
        name,
        action: () => command(root, claimOptions),
      });
    }
    const handoffOptions = {
      ...common,
      handoffId,
      expectedRevision: '1',
      reason: 'Receiver declined the handoff.',
    };
    for (const [name, command] of [
      ['handoff offer', teamHandoffOffer],
      ['handoff accept', teamHandoffAccept],
      ['handoff reject', teamHandoffReject],
      ['handoff cancel', teamHandoffCancel],
    ] as const) {
      mutations.push({
        name,
        action: () => command(root, handoffOptions),
      });
    }

    const results = [];
    for (const { name, action } of mutations) {
      const output = await captureJson(action);
      results.push({
        name,
        exitCode: output.exitCode,
        code: output.value.error?.code,
      });
    }
    expect(results).toEqual(
      results.map(({ name }) => ({
        name,
        exitCode: 3,
        code: 'MANCODE_EXPLICIT_SYNC_REQUIRED',
      })),
    );

    const status = await captureJson(() => teamStatus(root, { json: true }));
    expect(status).toMatchObject({
      exitCode: 0,
      value: {
        capabilities: {
          transport: 'git-ref',
          claimAcquisition: 'unavailable',
        },
        remoteSnapshot: { revision: 0, fetchedAt },
      },
    });
    const conflicts = await captureJson(() =>
      teamConflicts(root, { task: taskRef, json: true }),
    );
    expect(conflicts).toMatchObject({
      exitCode: 0,
      value: {
        capabilities: { transport: 'git-ref' },
        claims: [],
        handoffs: [],
      },
    });

    expect(await readFile(gitRefCachePath(root), 'utf8')).toBe(cacheBefore);
    expect(await remoteGitCommands(tracePath)).toEqual([]);
  });

  it('rejects explicit sync when the configured transport is local', async () => {
    const common = {
      session: sessionId,
      client: 'vitest',
      sync: true,
      json: true,
    };
    const results = [
      await captureJson(() =>
        teamClaim(root, {
          ...common,
          task: taskRef,
          expectedTaskRevision: '1',
          paths: ['src/**'],
        }),
      ),
      await captureJson(() =>
        teamHandoffDraft(root, {
          ...common,
          task: taskRef,
          expectedTaskRevision: '1',
          to: receiverActorId,
        }),
      ),
    ];

    expect(
      results.map((result) => ({
        exitCode: result.exitCode,
        code: result.value.error?.code,
      })),
    ).toEqual([
      { exitCode: 3, code: 'MANCODE_TRANSPORT_UNAVAILABLE' },
      { exitCode: 3, code: 'MANCODE_TRANSPORT_UNAVAILABLE' },
    ]);
  });

  it('never accepts deferred shared workflow sync as if it reached git-ref', async () => {
    await setGitRefConfig(root);
    const common = {
      session: sessionId,
      client: 'vitest',
      sync: true,
      json: true,
    };
    const results = [
      await captureJson(() =>
        workflow(
          root,
          'create',
          ['manteam', 'Do not silently defer remote publication.'],
          {
            ...common,
            visibility: 'shared',
            coordination: 'team',
            confirmShared: true,
          },
        ),
      ),
      await captureJson(() =>
        workflow(root, 'requirements', [taskRef, 'draft'], {
          ...common,
          expectedRevision: '1',
          file: 'must-not-be-read.json',
        }),
      ),
      await captureJson(() =>
        workflow(root, 'plan', [taskRef, 'revise'], {
          ...common,
          expectedRevision: '1',
          file: 'must-not-be-read.md',
        }),
      ),
      await captureJson(() =>
        workflow(root, 'review', [taskRef, 'apply'], {
          ...common,
          expectedRevision: '1',
          file: 'must-not-be-read.json',
        }),
      ),
      await captureJson(() =>
        workflow(root, 'verify', [taskRef, 'apply'], {
          ...common,
          expectedRevision: '1',
          file: 'must-not-be-read.json',
        }),
      ),
    ];

    expect(
      results.map((result) => ({
        exitCode: result.exitCode,
        code: result.value.error?.code,
      })),
    ).toEqual(
      Array.from({ length: results.length }, () => ({
        exitCode: 3,
        code: 'MANCODE_GIT_REF_DEFERRED_SYNC_REQUIRED',
      })),
    );
  });
});

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

async function initializeSharedTask(projectRoot: string): Promise<{
  taskId: Ulid;
  sessionId: Ulid;
  receiverActorId: Ulid;
}> {
  await initializeV3Project({
    projectRoot,
    operationId: id(1),
    workspaceId: id(2),
    schemaEpoch: id(3),
    now: NOW,
  });
  const ownerActorId = id(4);
  const sessionId = id(5);
  const receiverActorId = id(6);
  await createLocalActor(projectRoot, {
    actorId: ownerActorId,
    displayName: 'Command Owner',
    now: NOW,
  });
  const owner = await readLocalActor(projectRoot);
  if (owner === null) throw new Error('missing command owner');
  await publishSharedActorProfile(
    projectRoot,
    createSharedActorProfile(owner, NOW),
  );
  await publishSharedActorProfile(projectRoot, {
    schemaVersion: 1,
    actorId: receiverActorId,
    displayName: 'Command Receiver',
    joinedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await createSession(projectRoot, {
    actorId: ownerActorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  const taskId = id(7);
  await createV3Workflow({
    projectRoot,
    task: 'Prove command-level explicit synchronization.',
    workflowMode: 'manteam',
    sessionId,
    client: 'vitest',
    sharedPrivacyConfirmed: true,
    participantActorIds: [receiverActorId],
    implementationScope: { include: ['src/**'] },
    taskId,
    operationId: id(8),
    now: NOW,
  });
  return { taskId, sessionId, receiverActorId };
}

async function setGitRefConfig(projectRoot: string): Promise<ProjectConfigV1> {
  const target = path.join(projectRoot, '.mancode', 'shared', 'config.json');
  const config = JSON.parse(await readFile(target, 'utf8')) as ProjectConfigV1;
  const next: ProjectConfigV1 = {
    ...config,
    revision: config.revision + 1,
    transport: {
      mode: 'git-ref',
      remote: 'remote-that-must-not-be-contacted',
      epoch: config.transport.epoch + 1,
    },
    lastOperationId: id(9),
    updatedAt: NOW.toISOString(),
  };
  await writeFile(target, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function captureJson(action: () => Promise<number>): Promise<{
  exitCode: number;
  value: Record<string, unknown> & { error?: { code?: string } };
}> {
  const writes: string[] = [];
  const previous = console.log;
  console.log = (value: unknown) => writes.push(String(value));
  try {
    return {
      exitCode: await action(),
      value: JSON.parse(writes.at(-1) ?? '{}'),
    };
  } finally {
    console.log = previous;
  }
}

async function remoteGitCommands(tracePath: string): Promise<string[][]> {
  const trace = await readFile(tracePath, 'utf8');
  return trace
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
    .filter(
      (event): event is { event: string; argv: string[] } =>
        event.event === 'start' && Array.isArray(event.argv),
    )
    .map((event) => event.argv)
    .filter((argv) => ['ls-remote', 'fetch', 'push'].includes(argv[1] ?? ''));
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

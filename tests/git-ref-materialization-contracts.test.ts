import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createV3Checkpoint } from '../src/context/checkpoint-create.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import { createGitRefTaskBundle } from '../src/team/git-ref-bundle.js';
import { materializeGitRefTaskBundle } from '../src/team/git-ref-materialization.js';
import type {
  GitRefOwnershipFenceV1,
  GitRefTaskBundleV1,
} from '../src/team/git-ref-transport.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-18T10:00:00.000Z');
const WORKSPACE_ID = id(1);
const TASK_ID = id(2);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('git-ref task bundle materialization', () => {
  it('creates a missing task and advances it only from an exact predecessor', async () => {
    const source = await bootstrap('source', id(3), id(4));
    const target = await bootstrap('target', id(5), id(6));
    const created = await createSharedWorkflow(source.root, source.sessionId);
    const first = await bundle(source.root);

    await expect(
      materializeGitRefTaskBundle({
        projectRoot: target.root,
        remoteRevision: 1,
        ownershipFence: remoteFence(first, 1, id(7)),
        bundle: first,
        operationId: id(8),
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'created',
      taskRevision: created.metadata.revision,
      taskHeadFence: { remoteRevision: 1 },
    });
    await expect(
      new V3ContextStore(target.root).readTaskSnapshot(created.taskRef),
    ).resolves.toMatchObject({ aggregate: first.aggregate });

    await createV3Checkpoint({
      projectRoot: source.root,
      taskRef: created.taskRef,
      sessionId: source.sessionId,
      expectedTaskRevision: created.metadata.revision,
      kind: 'diagnostic_started',
      summary: 'Checkpoint the remote materialization fixture.',
      operationId: id(9),
      checkpointId: id(10),
      now: new Date('2026-07-18T10:01:00.000Z'),
    });
    const second = await bundle(source.root);
    await expect(
      materializeGitRefTaskBundle({
        projectRoot: target.root,
        remoteRevision: 2,
        ownershipFence: remoteFence(second, 2, id(11)),
        bundle: second,
        predecessorBundle: first,
        operationId: id(12),
        now: new Date('2026-07-18T10:01:00.000Z'),
      }),
    ).resolves.toMatchObject({
      status: 'updated',
      taskRevision: second.taskRevision,
      taskHeadFence: { remoteRevision: 2 },
    });
    await expect(
      new V3ContextStore(target.root).readTaskSnapshot(created.taskRef),
    ).resolves.toMatchObject({
      metadata: { revision: second.taskRevision },
      aggregate: second.aggregate,
    });
  });

  it('rejects a divergent local task instead of overwriting it', async () => {
    const source = await bootstrap('source', id(20), id(21));
    const target = await bootstrap('target', id(22), id(23));
    await createSharedWorkflow(source.root, source.sessionId, 'Remote task');
    await createSharedWorkflow(target.root, target.sessionId, 'Local fork');
    const remote = await bundle(source.root);

    await expect(
      materializeGitRefTaskBundle({
        projectRoot: target.root,
        remoteRevision: 1,
        ownershipFence: remoteFence(remote, 1, id(24)),
        bundle: remote,
        operationId: id(25),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_SPLIT_BRAIN');
  });

  it('advances the fence when Git already supplied the target aggregate', async () => {
    const source = await bootstrap('source-git-update', id(50), id(51));
    const target = await bootstrap('target-git-update', id(52), id(53));
    const created = await createSharedWorkflow(source.root, source.sessionId);
    const first = await bundle(source.root);

    await materializeGitRefTaskBundle({
      projectRoot: target.root,
      remoteRevision: 1,
      ownershipFence: remoteFence(first, 1, id(54)),
      bundle: first,
      operationId: id(55),
      now: NOW,
    });

    await createV3Checkpoint({
      projectRoot: source.root,
      taskRef: created.taskRef,
      sessionId: source.sessionId,
      expectedTaskRevision: created.metadata.revision,
      kind: 'diagnostic_started',
      summary: 'Advance the task before the other clone pulls Git.',
      operationId: id(56),
      checkpointId: id(57),
      now: new Date('2026-07-18T10:01:00.000Z'),
    });
    const second = await bundle(source.root);

    // Simulate a normal Git pull updating tracked task files before team sync.
    await writeBundleArtifacts(target.root, second);
    await expect(
      materializeGitRefTaskBundle({
        projectRoot: target.root,
        remoteRevision: 2,
        ownershipFence: remoteFence(second, 2, id(58)),
        bundle: second,
        operationId: id(59),
        now: new Date('2026-07-18T10:02:00.000Z'),
      }),
    ).resolves.toMatchObject({
      status: 'unchanged',
      taskRevision: second.taskRevision,
      taskHeadFence: {
        taskRevision: second.taskRevision,
        remoteRevision: 2,
      },
    });
  });

  it('does not treat an unsynced local revision as a cached remote predecessor', async () => {
    const source = await bootstrap('source-base', id(30), id(31));
    const target = await bootstrap('target-base', id(30), id(32));
    const created = await createSharedWorkflow(source.root, source.sessionId);
    const first = await bundle(source.root);

    await expect(
      materializeGitRefTaskBundle({
        projectRoot: target.root,
        remoteRevision: 1,
        ownershipFence: remoteFence(first, 1, id(33)),
        bundle: first,
        operationId: id(34),
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'created' });
    await execFile('git', ['fetch', source.root, 'HEAD'], { cwd: target.root });
    await execFile('git', ['checkout', '--detach', 'FETCH_HEAD'], {
      cwd: target.root,
    });
    await createV3Checkpoint({
      projectRoot: target.root,
      taskRef: created.taskRef,
      sessionId: target.sessionId,
      expectedTaskRevision: created.metadata.revision,
      kind: 'diagnostic_started',
      summary: 'Create an unsynced local predecessor.',
      operationId: id(35),
      checkpointId: id(36),
      now: new Date('2026-07-18T10:01:00.000Z'),
    });

    await createV3Checkpoint({
      projectRoot: source.root,
      taskRef: created.taskRef,
      sessionId: source.sessionId,
      expectedTaskRevision: created.metadata.revision,
      kind: 'diagnostic_started',
      summary: 'Advance the remote task independently.',
      operationId: id(37),
      checkpointId: id(38),
      now: new Date('2026-07-18T10:01:00.000Z'),
    });
    const second = await bundle(source.root);

    await expect(
      materializeGitRefTaskBundle({
        projectRoot: target.root,
        remoteRevision: 2,
        ownershipFence: remoteFence(second, 2, id(39)),
        bundle: second,
        // Simulates a quarantine pull that cached the target before code was reachable.
        predecessorBundle: second,
        operationId: id(40),
        now: new Date('2026-07-18T10:02:00.000Z'),
      }),
    ).rejects.toThrow('MANCODE_SPLIT_BRAIN');
  });
});

async function bootstrap(label: string, actorId: Ulid, sessionId: Ulid) {
  const root = path.join(
    tmpdir(),
    `mancode-git-ref-materialize-${label}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  roots.push(root);
  await mkdir(root, { recursive: true });
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
    cwd: root,
  });
  await execFile('git', ['config', 'user.name', 'Vitest'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  await execFile('git', ['add', 'README.md'], { cwd: root });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: root });
  await initializeV3Project({
    projectRoot: root,
    operationId: id(actorId === id(3) ? 30 : 31),
    workspaceId: WORKSPACE_ID,
    schemaEpoch: id(32),
    now: NOW,
  });
  const actor = await createLocalActor(root, {
    actorId,
    displayName: `Actor ${label}`,
    now: NOW,
  });
  await publishSharedActorProfile(root, createSharedActorProfile(actor, NOW));
  await createSession(root, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  return { root, sessionId };
}

async function createSharedWorkflow(
  root: string,
  sessionId: Ulid,
  task = 'Remote materialization task',
) {
  return createV3Workflow({
    projectRoot: root,
    task,
    workflowMode: 'manteam',
    sessionId,
    client: 'vitest',
    sharedPrivacyConfirmed: true,
    implementationScope: { include: ['src/**'] },
    taskId: TASK_ID,
    operationId: id(task === 'Local fork' ? 40 : 41),
    now: NOW,
  });
}

async function bundle(root: string): Promise<GitRefTaskBundleV1> {
  const task = await new V3ContextStore(root).readTaskSnapshot({
    namespace: 'shared',
    taskId: TASK_ID,
  });
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
    cwd: root,
  });
  return createGitRefTaskBundle({
    task,
    codeRef: { branch: 'main', head: stdout.trim() },
    now: NOW,
  });
}

async function writeBundleArtifacts(
  root: string,
  bundle: GitRefTaskBundleV1,
): Promise<void> {
  const taskRoot = path.join(
    root,
    '.mancode',
    'shared',
    'workflows',
    bundle.taskRef.taskId,
  );
  for (const artifact of bundle.artifacts) {
    const target = path.join(taskRoot, artifact.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof artifact.content === 'string'
        ? artifact.content
        : `${JSON.stringify(artifact.content, null, 2)}\n`,
    );
  }
}

function remoteFence(
  bundle: GitRefTaskBundleV1,
  remoteRevision: number,
  operationId: Ulid,
): GitRefOwnershipFenceV1 {
  const metadata = bundle.artifacts.find(
    (artifact) => artifact.kind === 'metadata',
  )?.content as { ownerActorId: Ulid };
  return {
    schemaVersion: 1,
    taskRef: bundle.taskRef,
    ownerActorId: metadata.ownerActorId,
    ownershipEpoch: bundle.ownershipEpoch,
    taskRevision: bundle.taskRevision,
    aggregateDigest: bundle.aggregateDigest,
    remoteRevision,
    lastOperationId: operationId,
    updatedAt: NOW.toISOString(),
  };
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

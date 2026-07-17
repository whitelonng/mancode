import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { buildTaskAggregateManifest } from '../src/context/aggregate.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { parseWorkflowMetadata } from '../src/context/workflow-metadata.js';
import { resolveCoordinationEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession } from '../src/runtime/session.js';
import { readTaskHeadFence } from '../src/runtime/task-head-store.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import { createGitRefTaskBundle } from '../src/team/git-ref-bundle.js';
import {
  acceptGitRefHandoffWithRepair,
  recoverGitRefHandoffRepair,
  recoverGitRefHandoffRepairs,
} from '../src/team/git-ref-handoff-repair.js';
import type {
  AcceptGitRefHandoffInput,
  PreparedGitRefHandoffAcceptV1,
} from '../src/team/git-ref-operation.js';
import type {
  GitRefRemoteMutationReceiptV1,
  GitRefTaskBundleV1,
  GitRefTeamManifestSnapshot,
} from '../src/team/git-ref-transport.js';

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  pull: vi.fn(),
}));

vi.mock('../src/team/git-ref-operation.js', () => ({
  acceptGitRefHandoff: mocks.accept,
}));

vi.mock('../src/team/git-ref-client.js', () => ({
  createGitRefTeamManifestStore: () => ({ pull: mocks.pull }),
}));

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-18T10:00:00.000Z');
const WORKSPACE_ID = id(1);
const OWNER_ID = id(2);
const RECEIVER_ID = id(3);
const OWNER_SESSION_ID = id(4);
const TASK_ID = id(5);
const HANDOFF_ID = id(6);
const OPERATION_ID = id(7);
const PREDECESSOR_CLAIM_ID = id(8);
const SUCCESSOR_CLAIM_ID = id(9);
const roots: string[] = [];

beforeEach(() => {
  mocks.accept.mockReset();
  mocks.pull.mockReset();
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('git-ref handoff external-commit repair', () => {
  it('leaves no journal or metadata change when accept crashes before prepare', async () => {
    const fixture = await bootstrap();
    const before = await readMetadata(fixture.root);
    mocks.accept.mockRejectedValueOnce(new Error('crash before prepare'));

    await expect(
      acceptGitRefHandoffWithRepair(acceptInput(fixture.root)),
    ).rejects.toThrow('crash before prepare');

    expect(await readMetadata(fixture.root)).toEqual(before);
    await expect(
      readFile(journalPath(fixture.root), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it('restores metadata and aborts the journal when remote CAS did not commit', async () => {
    const fixture = await bootstrap();
    mocks.pull.mockResolvedValue(remoteSnapshot(fixture.prepared, null));
    mocks.accept.mockImplementationOnce(
      async (input: AcceptGitRefHandoffInput) => {
        await input.beforeRemoteCommit?.(fixture.prepared);
        expect(await readMetadata(fixture.root)).toMatchObject({
          revision: fixture.predecessor.taskRevision + 1,
          transitionState: 'operation_pending',
          lastOperationId: OPERATION_ID,
        });
        throw new Error('remote CAS rejected');
      },
    );

    await expect(
      acceptGitRefHandoffWithRepair(acceptInput(fixture.root)),
    ).rejects.toThrow('remote CAS rejected');

    expect(await readMetadata(fixture.root)).toEqual(fixture.originalMetadata);
    expect(await readJournal(fixture.root)).toMatchObject({
      operationId: OPERATION_ID,
      state: 'aborted',
      remoteReceipt: null,
      transportReceipt: null,
    });
    await expect(
      recoverGitRefHandoffRepair(fixture.root, OPERATION_ID, null),
    ).resolves.toMatchObject({ state: 'aborted' });
  });

  it('uses the durable receipt to converge after a committed CAS response is lost', async () => {
    const fixture = await bootstrap();
    const receipt = committedReceipt(fixture.prepared);
    mocks.accept.mockImplementationOnce(
      async (input: AcceptGitRefHandoffInput) => {
        await input.beforeRemoteCommit?.(fixture.prepared);
        mocks.pull.mockResolvedValue(remoteSnapshot(fixture.prepared, receipt));
        throw new Error('response lost after remote commit');
      },
    );

    await expect(
      acceptGitRefHandoffWithRepair(acceptInput(fixture.root)),
    ).rejects.toThrow('response lost after remote commit');

    const snapshot = await new V3ContextStore(fixture.root).readTaskSnapshot(
      fixture.target.taskRef,
    );
    expect(snapshot.metadata).toMatchObject({
      revision: fixture.target.taskRevision,
      transitionState: 'stable',
      lastOperationId: OPERATION_ID,
      ownerActorId: RECEIVER_ID,
      ownershipEpoch: fixture.target.ownershipEpoch,
    });
    expect(snapshot.aggregate).toEqual(fixture.target.aggregate);
    expect(await readJournal(fixture.root)).toMatchObject({
      state: 'committed',
      remoteReceipt: receipt,
      transportReceipt: 'git-ref:committed:test',
    });
    const runtime = await readProjectRuntimeContext(fixture.root);
    const fence = await readTaskHeadFence(
      resolveCoordinationEntityHomeStore(runtime.entityHomeStoreContext),
      fixture.target.taskRef,
    );
    expect(fence).toMatchObject({
      taskRevision: fixture.target.taskRevision,
      aggregateDigest: fixture.target.aggregateDigest,
      ownershipEpoch: fixture.target.ownershipEpoch,
      remoteRevision: fixture.prepared.targetRemoteRevision,
      lastOperationId: OPERATION_ID,
    });
  });

  it('treats committed recovery as idempotent', async () => {
    const fixture = await bootstrap();
    const receipt = committedReceipt(fixture.prepared);
    mocks.accept.mockImplementationOnce(
      async (input: AcceptGitRefHandoffInput) => {
        await input.beforeRemoteCommit?.(fixture.prepared);
        mocks.pull.mockResolvedValue(remoteSnapshot(fixture.prepared, receipt));
        throw new Error('response lost after remote commit');
      },
    );
    await expect(
      acceptGitRefHandoffWithRepair(acceptInput(fixture.root)),
    ).rejects.toThrow('response lost after remote commit');
    const metadataBefore = await readFile(metadataPath(fixture.root), 'utf8');
    const journalBefore = await readFile(journalPath(fixture.root), 'utf8');

    await expect(
      recoverGitRefHandoffRepair(
        fixture.root,
        OPERATION_ID,
        'git-ref:ignored:duplicate',
      ),
    ).resolves.toMatchObject({ state: 'committed' });
    await expect(recoverGitRefHandoffRepairs(fixture.root)).resolves.toEqual(
      [],
    );

    expect(await readFile(metadataPath(fixture.root), 'utf8')).toBe(
      metadataBefore,
    );
    expect(await readFile(journalPath(fixture.root), 'utf8')).toBe(
      journalBefore,
    );
  });
});

async function bootstrap(): Promise<{
  root: string;
  originalMetadata: Awaited<ReturnType<typeof readMetadata>>;
  predecessor: GitRefTaskBundleV1;
  target: GitRefTaskBundleV1;
  prepared: PreparedGitRefHandoffAcceptV1;
}> {
  const root = path.join(
    tmpdir(),
    `mancode-git-ref-handoff-repair-${Date.now()}-${Math.random()
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
    operationId: id(20),
    workspaceId: WORKSPACE_ID,
    schemaEpoch: id(21),
    now: NOW,
  });
  const owner = await createLocalActor(root, {
    actorId: OWNER_ID,
    displayName: 'Current owner',
    now: NOW,
  });
  await publishSharedActorProfile(root, createSharedActorProfile(owner, NOW));
  await publishSharedActorProfile(root, {
    schemaVersion: 1,
    actorId: RECEIVER_ID,
    displayName: 'Receiving owner',
    joinedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await createSession(root, {
    actorId: OWNER_ID,
    sessionId: OWNER_SESSION_ID,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  await createV3Workflow({
    projectRoot: root,
    task: 'Recover accepted remote ownership handoff',
    workflowMode: 'manteam',
    sessionId: OWNER_SESSION_ID,
    client: 'vitest',
    participantActorIds: [RECEIVER_ID],
    sharedPrivacyConfirmed: true,
    implementationScope: { include: ['src/**'] },
    taskId: TASK_ID,
    operationId: id(22),
    now: NOW,
  });
  const snapshot = await new V3ContextStore(root).readTaskSnapshot({
    namespace: 'shared',
    taskId: TASK_ID,
  });
  const originalMetadata = snapshot.metadata;
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
    cwd: root,
  });
  const codeRef = { branch: 'main', head: stdout.trim() };
  const predecessor = createGitRefTaskBundle({
    task: snapshot,
    codeRef,
    now: NOW,
  });
  const targetMetadata = parseWorkflowMetadata({
    ...snapshot.metadata,
    revision: snapshot.metadata.revision + 2,
    transitionState: 'stable',
    lastOperationId: OPERATION_ID,
    ownerActorId: RECEIVER_ID,
    ownershipEpoch: snapshot.metadata.ownershipEpoch + 1,
    updatedAt: '2026-07-18T10:01:00.000Z',
  });
  const targetAggregate = buildTaskAggregateManifest({
    metadata: targetMetadata,
    requirements: snapshot.requirements,
    review: snapshot.review,
    verification: snapshot.verification,
    planDigest: snapshot.plan?.digest ?? null,
    latestCheckpoint: snapshot.latestCheckpoint,
  });
  const target = createGitRefTaskBundle({
    task: { ...snapshot, metadata: targetMetadata, aggregate: targetAggregate },
    codeRef,
    now: new Date('2026-07-18T10:01:00.000Z'),
  });
  const prepared: PreparedGitRefHandoffAcceptV1 = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    expectedRemoteRevision: 10,
    expectedOwnershipEpoch: predecessor.ownershipEpoch,
    targetRemoteRevision: 11,
    targetOwnershipEpoch: target.ownershipEpoch,
    predecessorBundle: predecessor,
    targetBundle: target,
    forwardRepair: {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      taskRef: target.taskRef,
      ownerActorId: RECEIVER_ID,
      ownershipEpoch: target.ownershipEpoch,
      taskRevision: target.taskRevision,
      aggregateDigest: target.aggregateDigest,
      handoffId: HANDOFF_ID,
      predecessorClaimIds: [PREDECESSOR_CLAIM_ID],
      successorClaimIds: [SUCCESSOR_CLAIM_ID],
      bundleDigest: target.bundleDigest,
      remoteRevision: 11,
    },
  };
  return { root, originalMetadata, predecessor, target, prepared };
}

function acceptInput(projectRoot: string): AcceptGitRefHandoffInput {
  return {
    projectRoot,
    handoffId: HANDOFF_ID,
    sessionId: OWNER_SESSION_ID,
    expectedHandoffRevision: 2,
    operationId: OPERATION_ID,
    now: NOW,
  };
}

function committedReceipt(
  prepared: PreparedGitRefHandoffAcceptV1,
): GitRefRemoteMutationReceiptV1 {
  const emptyDigest = digestCanonicalJson([]);
  return {
    schemaVersion: 1,
    kind: 'coordination',
    operationId: prepared.operationId,
    actorId: RECEIVER_ID,
    taskRef: prepared.targetBundle.taskRef,
    remoteRevision: prepared.targetRemoteRevision,
    ownershipEpoch: prepared.targetOwnershipEpoch,
    entityDigests: {
      actorProfiles: emptyDigest,
      ownershipFence: emptyDigest,
      claims: emptyDigest,
      handoffs: emptyDigest,
      taskBundle: digestCanonicalJson(prepared.targetBundle),
    },
    committedAt: '2026-07-18T10:01:00.000Z',
  };
}

function remoteSnapshot(
  prepared: PreparedGitRefHandoffAcceptV1,
  receipt: GitRefRemoteMutationReceiptV1 | null,
): GitRefTeamManifestSnapshot {
  return {
    manifest: {
      revision:
        receipt === null
          ? prepared.expectedRemoteRevision
          : prepared.targetRemoteRevision,
      receipts: receipt === null ? [] : [receipt],
    } as GitRefTeamManifestSnapshot['manifest'],
    commit: receipt === null ? null : 'a'.repeat(40),
    receipt: receipt === null ? null : 'git-ref:committed:test',
    fetchedAt: '2026-07-18T10:01:00.000Z',
  };
}

async function readMetadata(projectRoot: string) {
  return (
    await new V3ContextStore(projectRoot).readTaskSnapshot({
      namespace: 'shared',
      taskId: TASK_ID,
    })
  ).metadata;
}

async function readJournal(
  projectRoot: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(journalPath(projectRoot), 'utf8')) as Record<
    string,
    unknown
  >;
}

function metadataPath(projectRoot: string): string {
  return path.join(
    projectRoot,
    '.mancode',
    'shared',
    'workflows',
    TASK_ID,
    'metadata.json',
  );
}

function journalPath(projectRoot: string): string {
  return path.join(
    projectRoot,
    '.mancode',
    'local',
    'journals',
    'git-ref-handoff',
    `${OPERATION_ID}.json`,
  );
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

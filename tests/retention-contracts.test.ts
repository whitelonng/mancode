import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextCompact } from '../src/commands/context.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { taskRootPath } from '../src/context/task-locator.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import {
  operationDirectory,
  resolveLocalEntityHomeStore,
} from '../src/runtime/entity-home-store.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import {
  applyContextCompaction,
  planContextCompaction,
} from '../src/runtime/retention.js';
import { closeSession, createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
} from '../src/team/actor.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-18T12:00:00.000Z');

describe('V3 retention and compaction', () => {
  let root: string;
  let actorId: Ulid;
  let sessionId: Ulid;
  let taskId: Ulid;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-retention-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await initializeGitRepository(root);
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
      displayName: 'Retention User',
      now: NOW,
    });
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now: new Date('2026-05-01T00:00:00.000Z'),
    });
    await createV3Workflow({
      projectRoot: root,
      task: 'Retain only the latest diagnostic checkpoints.',
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

  it('deletes only aged closed sessions and unreferenced excess checkpoints', async () => {
    const taskRoot = taskRootPath(root, { namespace: 'local', taskId });
    const metadataPath = path.join(taskRoot, 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const checkpointIds = Array.from({ length: 12 }, (_, index) =>
      id(20 + index),
    );
    await mkdir(path.join(taskRoot, 'checkpoints'));
    await Promise.all(
      checkpointIds.map(async (checkpointId, index) => {
        const checkpoint = {
          schemaVersion: 1,
          checkpointId,
          operationId: id(40 + index),
          taskRef: { namespace: 'local', taskId },
          taskRevision: 1,
          ownershipEpochAtOffer: 0,
          kind: 'diagnostic_started',
          git: { branch: null, head: null, base: null },
          summary: `Diagnostic checkpoint ${index}.`,
          governance: {
            requirementsDigest: metadata.governance.requirementsDigest,
            planVersion: metadata.governance.planVersion,
            reviewLedgerDigest: metadata.governance.reviewLedgerDigest,
            verificationLedgerDigest:
              metadata.governance.verificationLedgerDigest,
          },
          nextAction: 'Continue the diagnostic workflow.',
          createdBy: { actorId, client: 'vitest' },
          createdAt: new Date(
            Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000,
          ).toISOString(),
        };
        await writeFile(
          path.join(taskRoot, 'checkpoints', `${checkpointId}.json`),
          `${JSON.stringify(checkpoint, null, 2)}\n`,
        );
      }),
    );
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          ...metadata,
          status: 'completed',
          latestCheckpointRef: {
            taskRef: { namespace: 'local', taskId },
            kind: 'checkpoint',
            artifactId: checkpointIds[0],
          },
          updatedAt: NOW.toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    await closeSession(root, sessionId, new Date('2026-05-01T01:00:00.000Z'));

    const plan = await planContextCompaction({ projectRoot: root, now: NOW });
    const checkpointCandidates = plan.candidates.filter(
      (candidate) => candidate.kind === 'checkpoint',
    );
    expect(checkpointCandidates).toHaveLength(1);
    expect(checkpointCandidates[0]?.target).toContain(checkpointIds[1]);
    expect(plan.skippedReferencedCheckpoints).toEqual([
      {
        taskRef: { namespace: 'local', taskId },
        checkpointId: checkpointIds[0],
      },
    ]);
    expect(plan.candidates).toContainEqual(
      expect.objectContaining({ kind: 'completed_session' }),
    );

    const applied = await applyContextCompaction(plan);
    expect(applied.deleted).toContain(checkpointCandidates[0]?.target);
    await expect(
      readFile(checkpointCandidates[0]?.target ?? '', 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(root, '.mancode', 'local', 'sessions', `${sessionId}.json`),
        'utf8',
      ),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(taskRoot, 'checkpoints', `${checkpointIds[0]}.json`),
        'utf8',
      ),
    ).resolves.toContain(checkpointIds[0]);
  });

  it('does not compact checkpoints from an active task', async () => {
    const taskRoot = taskRootPath(root, { namespace: 'local', taskId });
    await mkdir(path.join(taskRoot, 'checkpoints'));
    await writeFile(
      path.join(taskRoot, 'checkpoints', `${id(80)}.json`),
      `${JSON.stringify(await checkpointForCurrentTask(id(80), id(81)))}\n`,
    );

    await expect(
      planContextCompaction({ projectRoot: root, now: NOW }),
    ).resolves.toMatchObject({
      candidates: expect.not.arrayContaining([
        expect.objectContaining({ kind: 'checkpoint' }),
      ]),
    });
  });

  it('keeps a repair-required journal and the session and task artifacts it protects', async () => {
    const taskRef = { namespace: 'local' as const, taskId };
    const checkpointPaths = await completeTaskWithDiagnosticCheckpoints(
      root,
      taskRef,
      actorId,
      90,
    );
    await closeSession(root, sessionId, new Date('2026-05-01T01:00:00.000Z'));

    const runtime = await readProjectRuntimeContext(root);
    const localStore = resolveLocalEntityHomeStore(
      runtime.entityHomeStoreContext,
    );
    const journal = await readOperationJournal(localStore, id(7));
    if (journal === null) throw new Error('missing workflow operation journal');
    const journalTarget = path.join(
      operationDirectory(localStore),
      `${journal.operationId}.json`,
    );
    await writeFile(
      journalTarget,
      `${JSON.stringify(
        {
          ...journal,
          state: 'repair_required',
          startedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T01:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );

    const sessionTarget = path.join(
      root,
      '.mancode',
      'local',
      'sessions',
      `${sessionId}.json`,
    );
    const plan = await planContextCompaction({ projectRoot: root, now: NOW });
    expect(plan.candidates.map((candidate) => candidate.target)).not.toContain(
      journalTarget,
    );
    expect(plan.candidates.map((candidate) => candidate.target)).not.toContain(
      sessionTarget,
    );
    expect(
      plan.candidates.some(
        (candidate) =>
          candidate.taskRef?.namespace === taskRef.namespace &&
          candidate.taskRef.taskId === taskRef.taskId,
      ),
    ).toBe(false);

    await applyContextCompaction(plan);
    await expect(readFile(journalTarget, 'utf8')).resolves.toContain(
      'repair_required',
    );
    await expect(readFile(sessionTarget, 'utf8')).resolves.toContain(sessionId);
    await expect(readFile(checkpointPaths[0] ?? '', 'utf8')).resolves.toContain(
      taskId,
    );
  });

  it('retains active git-ref workflow repairs and compacts only their aged terminal journals', async () => {
    const directory = path.join(
      root,
      '.mancode',
      'local',
      'journals',
      'git-ref-workflow',
    );
    const terminalOperationId = id(120);
    const activeOperationId = id(121);
    const terminalTarget = path.join(directory, `${terminalOperationId}.json`);
    const activeTarget = path.join(directory, `${activeOperationId}.json`);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(
        terminalTarget,
        `${JSON.stringify(
          gitRefWorkflowRepairJournal({
            operationId: terminalOperationId,
            state: 'committed',
            updatedAt: '2026-05-01T00:00:00.000Z',
            actorId,
            sessionId,
          }),
        )}\n`,
      ),
      writeFile(
        activeTarget,
        `${JSON.stringify(
          gitRefWorkflowRepairJournal({
            operationId: activeOperationId,
            state: 'repair_required',
            updatedAt: '2026-05-01T00:00:00.000Z',
            actorId,
            sessionId,
          }),
        )}\n`,
      ),
    ]);
    await closeSession(root, sessionId, new Date('2026-05-01T01:00:00.000Z'));

    const plan = await planContextCompaction({ projectRoot: root, now: NOW });
    expect(plan.candidates.map((candidate) => candidate.target)).toContain(
      terminalTarget,
    );
    expect(plan.candidates.map((candidate) => candidate.target)).not.toContain(
      activeTarget,
    );
    expect(plan.candidates.map((candidate) => candidate.target)).not.toContain(
      path.join(root, '.mancode', 'local', 'sessions', `${sessionId}.json`),
    );

    await applyContextCompaction(plan);
    await expect(readFile(terminalTarget, 'utf8')).rejects.toThrow();
    await expect(readFile(activeTarget, 'utf8')).resolves.toContain(
      'repair_required',
    );
  });

  it('defaults shared CLI compaction to dry-run and deletes only with apply-shared', async () => {
    const localActor = await readLocalActor(root);
    if (localActor === null) throw new Error('missing retention actor');
    await publishSharedActorProfile(
      root,
      createSharedActorProfile(localActor, NOW),
    );
    const sharedTaskId = id(150);
    const shared = await createV3Workflow({
      projectRoot: root,
      task: 'Compact completed shared checkpoints only after confirmation.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      taskId: sharedTaskId,
      operationId: id(151),
      sharedPrivacyConfirmed: true,
      now: NOW,
    });
    const checkpointPaths = await completeTaskWithDiagnosticCheckpoints(
      root,
      shared.taskRef,
      actorId,
      160,
    );

    const task = `shared:${sharedTaskId}`;
    const preview = await captureCompact(() =>
      contextCompact(root, { task, json: true }),
    );
    expect(preview.exitCode).toBe(0);
    expect(preview.value.deleted).toEqual([]);
    const previewTargets = preview.value.candidates
      .filter((candidate) => candidate.taskRef?.namespace === 'shared')
      .map((candidate) => candidate.target);
    expect(previewTargets).toHaveLength(2);
    await Promise.all(
      previewTargets.map((target) =>
        expect(readFile(target, 'utf8')).resolves.toContain(sharedTaskId),
      ),
    );

    const applied = await captureCompact(() =>
      contextCompact(root, { task, applyShared: true, json: true }),
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.value.deleted).toEqual(
      expect.arrayContaining(previewTargets),
    );
    await Promise.all(
      previewTargets.map((target) =>
        expect(readFile(target, 'utf8')).rejects.toThrow(),
      ),
    );
    expect(checkpointPaths).toHaveLength(12);
  });

  async function checkpointForCurrentTask(
    checkpointId: Ulid,
    operationId: Ulid,
  ) {
    const metadata = JSON.parse(
      await readFile(
        path.join(
          taskRootPath(root, { namespace: 'local', taskId }),
          'metadata.json',
        ),
        'utf8',
      ),
    );
    return {
      schemaVersion: 1,
      checkpointId,
      operationId,
      taskRef: { namespace: 'local', taskId },
      taskRevision: 1,
      ownershipEpochAtOffer: 0,
      kind: 'diagnostic_started',
      git: { branch: null, head: null, base: null },
      summary: 'Active task checkpoint.',
      governance: {
        requirementsDigest: metadata.governance.requirementsDigest,
        planVersion: metadata.governance.planVersion,
        reviewLedgerDigest: metadata.governance.reviewLedgerDigest,
        verificationLedgerDigest: metadata.governance.verificationLedgerDigest,
      },
      nextAction: 'Continue the active task.',
      createdBy: { actorId, client: 'vitest' },
      createdAt: NOW.toISOString(),
    };
  }
});

interface CompactJsonValue {
  candidates: Array<{ target: string; taskRef: TaskRef | null }>;
  deleted: string[];
}

function gitRefWorkflowRepairJournal(input: {
  operationId: Ulid;
  state: 'committed' | 'repair_required';
  updatedAt: string;
  actorId: Ulid;
  sessionId: Ulid;
}) {
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    state: input.state,
    prepared: {
      kind: 'workflow_update',
      targetRemoteRevision: 1,
      targetBundle: {
        taskRef: { namespace: 'shared', taskId: id(122) },
      },
    },
    updatedAt: input.updatedAt,
  };
}

async function captureCompact(
  action: () => Promise<number>,
): Promise<{ exitCode: number; value: CompactJsonValue }> {
  const writes: string[] = [];
  const previousLog = console.log;
  console.log = (value: unknown) => writes.push(String(value));
  try {
    const exitCode = await action();
    return {
      exitCode,
      value: JSON.parse(writes.at(-1) ?? '{}') as CompactJsonValue,
    };
  } finally {
    console.log = previousLog;
  }
}

async function completeTaskWithDiagnosticCheckpoints(
  projectRoot: string,
  taskRef: TaskRef,
  actorId: Ulid,
  firstIdOffset: number,
): Promise<string[]> {
  const taskRoot = taskRootPath(projectRoot, taskRef);
  const metadataPath = path.join(taskRoot, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const checkpointIds = Array.from({ length: 12 }, (_, index) =>
    id(firstIdOffset + index),
  );
  const checkpointDirectory = path.join(taskRoot, 'checkpoints');
  await mkdir(checkpointDirectory, { recursive: true });
  const targets = checkpointIds.map((checkpointId) =>
    path.join(checkpointDirectory, `${checkpointId}.json`),
  );
  await Promise.all(
    checkpointIds.map((checkpointId, index) =>
      writeFile(
        targets[index] ?? '',
        `${JSON.stringify(
          {
            schemaVersion: 1,
            checkpointId,
            operationId: id(firstIdOffset + 20 + index),
            taskRef,
            taskRevision: metadata.revision,
            ownershipEpochAtOffer: metadata.ownershipEpoch,
            kind: 'diagnostic_started',
            git: { branch: null, head: null, base: null },
            summary: `Retention checkpoint ${index}.`,
            governance: {
              requirementsDigest: metadata.governance.requirementsDigest,
              planVersion: metadata.governance.planVersion,
              reviewLedgerDigest: metadata.governance.reviewLedgerDigest,
              verificationLedgerDigest:
                metadata.governance.verificationLedgerDigest,
            },
            nextAction: 'Retain or compact this checkpoint.',
            createdBy: { actorId, client: 'vitest' },
            createdAt: new Date(
              Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000,
            ).toISOString(),
          },
          null,
          2,
        )}\n`,
      ),
    ),
  );
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        ...metadata,
        status: 'completed',
        updatedAt: NOW.toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return targets;
}

async function initializeGitRepository(projectRoot: string): Promise<void> {
  await execFile('git', ['init'], { cwd: projectRoot });
  await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
    cwd: projectRoot,
  });
  await execFile('git', ['config', 'user.name', 'Vitest'], {
    cwd: projectRoot,
  });
  await writeFile(path.join(projectRoot, 'README.md'), '# retention fixture\n');
  await execFile('git', ['add', 'README.md'], { cwd: projectRoot });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: projectRoot });
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-01-01T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

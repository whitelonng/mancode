import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import {
  localOverlayArtifactPath,
  readLocalOverlayArtifact,
  writeLocalOverlayArtifact,
} from '../src/context/local-overlay.js';
import {
  previewV3TaskPromotion,
  promoteV3Task,
} from '../src/context/publish-promote.js';
import { publishStagingDirectory } from '../src/context/quarantine.js';
import { V3ContextStore } from '../src/context/store.js';
import { taskRootPath } from '../src/context/task-locator.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { parseWorkflowMetadata } from '../src/context/workflow-metadata.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession } from '../src/runtime/session.js';
import { readTaskHeadFence } from '../src/runtime/task-head-store.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
} from '../src/team/actor.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-17T19:00:00.000Z');

describe('V3 local-to-shared publish/promote', () => {
  let root: string;
  let crashRoots: string[];

  beforeEach(async () => {
    crashRoots = [];
    root = path.join(
      tmpdir(),
      `mancode-v3-promote-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    await Promise.all(
      [root, ...crashRoots].map((target) =>
        rm(target, { recursive: true, force: true }),
      ),
    );
  });

  it('previews a privacy-screened promotion without changing source authority', async () => {
    const { actorId, sessionId } = await bootstrap(root);
    const source = await createV3Workflow({
      projectRoot: root,
      task: 'Preview a privacy-safe shared implementation plan.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(8),
      operationId: id(9),
      now: NOW,
    });

    const preview = await previewV3TaskPromotion({
      projectRoot: root,
      sourceTaskRef: source.taskRef,
      sessionActorId: actorId,
      expectedSourceRevision: source.metadata.revision,
      destinationWorkflowMode: 'manteam',
      client: 'vitest',
      now: NOW,
    });

    expect(preview).toMatchObject({
      sourceMetadata: { revision: source.metadata.revision },
      destination: {
        workflowMode: 'manteam',
        visibility: 'shared',
        coordination: 'team',
      },
      quarantine: { stage: 'previewed', privacy: { status: 'passed' } },
    });
    const snapshot = await new V3ContextStore(root).readTaskSnapshot(
      source.taskRef,
    );
    expect(snapshot.metadata).toMatchObject({
      revision: source.metadata.revision,
      status: source.metadata.status,
      successorTaskRef: null,
    });
  });

  it('publishes a new shared man successor and supersedes the local source', async () => {
    const { sessionId } = await bootstrap(root);
    const source = await createV3Workflow({
      projectRoot: root,
      task: 'Prepare a privacy-safe shared implementation plan.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });

    const promoted = await promoteV3Task({
      projectRoot: root,
      sourceTaskRef: source.taskRef,
      sessionId,
      expectedSourceRevision: source.metadata.revision,
      destinationWorkflowMode: 'man',
      sharedPrivacyConfirmed: true,
      client: 'vitest',
      destinationTaskId: id(12),
      operationId: id(13),
      now: NOW,
    });

    expect(promoted.operation).toMatchObject({
      type: 'publish_promote',
      state: 'committed',
      primaryStoreId: expect.stringMatching(/^workspace:/),
    });
    expect(promoted.destinationMetadata).toMatchObject({
      taskRef: { namespace: 'shared', taskId: id(12) },
      workflowMode: 'man',
      visibility: 'shared',
      coordination: 'single',
      revision: 1,
    });
    expect(promoted.sourceMetadata).toMatchObject({
      status: 'superseded',
      successorTaskRef: { namespace: 'shared', taskId: id(12) },
      revision: 3,
    });
    expect(promoted.quarantine).toMatchObject({
      stage: 'promoted',
      promotionOperationId: id(13),
    });

    const sourceMetadata = JSON.parse(
      await readFile(
        path.join(taskRootPath(root, source.taskRef), 'metadata.json'),
        'utf8',
      ),
    );
    expect(sourceMetadata).toMatchObject({
      status: 'superseded',
      successorTaskRef: { namespace: 'shared', taskId: id(12) },
    });
    await expect(
      readFile(
        path.join(
          taskRootPath(root, promoted.destinationMetadata.taskRef),
          'metadata.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('shared implementation plan');

    const runtime = await readProjectRuntimeContext(root);
    const destinationStore = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      promoted.destinationMetadata.taskRef,
    );
    const sourceStore = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      source.taskRef,
    );
    await expect(
      readOperationJournal(destinationStore, id(13)),
    ).resolves.toMatchObject({
      recoveryPayloadDigest: expect.stringMatching(/^sha256:/),
      secondaryReservations: [
        expect.objectContaining({ storeId: sourceStore.storeId }),
      ],
    });
    await expect(
      readTaskHeadFence(destinationStore, promoted.destinationMetadata.taskRef),
    ).resolves.toMatchObject({
      taskRef: promoted.destinationMetadata.taskRef,
      taskRevision: 1,
      lastOperationId: id(13),
    });
  });

  it('keeps shared-task raw evidence in the local overlay only', async () => {
    const { sessionId } = await bootstrap(root);
    const shared = await createV3Workflow({
      projectRoot: root,
      task: 'Coordinate a shared task while retaining private diagnostics.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      taskId: id(16),
      operationId: id(17),
      now: NOW,
    });
    const store = new V3ContextStore(root);
    const before = await store.readTaskSnapshot(shared.taskRef);
    const sharedFilesBefore = await readdir(taskRootPath(root, shared.taskRef));
    const rawEvidence =
      'Authorization: Bearer overlay-only-secret\ntrace=/Users/alice/private.log';

    const artifact = await writeLocalOverlayArtifact({
      projectRoot: root,
      taskRef: shared.taskRef,
      artifactId: id(18),
      content: rawEvidence,
    });

    expect(artifact).toMatchObject({
      taskRef: shared.taskRef,
      artifactId: id(18),
      byteLength: Buffer.byteLength(rawEvidence),
      contentDigest: expect.stringMatching(/^sha256:/),
      path: localOverlayArtifactPath(root, shared.taskRef, id(18)),
    });
    expect(path.relative(root, artifact.path)).toBe(
      path.join(
        '.mancode',
        'local',
        'overlays',
        shared.taskRef.taskId,
        'artifacts',
        id(18),
      ),
    );
    await expect(
      readLocalOverlayArtifact(root, shared.taskRef, id(18)),
    ).resolves.toEqual(Buffer.from(rawEvidence));
    await expect(
      writeLocalOverlayArtifact({
        projectRoot: root,
        taskRef: shared.taskRef,
        artifactId: id(18),
        content: 'different raw evidence',
      }),
    ).rejects.toThrow('MANCODE_OVERLAY_ARTIFACT_CONFLICT');
    await expect(
      writeLocalOverlayArtifact({
        projectRoot: root,
        taskRef: { namespace: 'local', taskId: shared.taskRef.taskId },
        artifactId: id(19),
        content: rawEvidence,
      }),
    ).rejects.toThrow('MANCODE_OVERLAY_REQUIRES_SHARED_TASK');
    const after = await store.readTaskSnapshot(shared.taskRef);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(await readdir(taskRootPath(root, shared.taskRef))).toEqual(
      sharedFilesBefore,
    );
    expect(JSON.stringify(after)).not.toContain('overlay-only-secret');
  });

  it('does not publish a shared destination when the source contains private text', async () => {
    const { sessionId } = await bootstrap(root);
    const source = await createV3Workflow({
      projectRoot: root,
      task: 'Keep a local task private until it can be safely summarized.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(20),
      operationId: id(21),
      now: NOW,
    });
    const sourceMetadataPath = path.join(
      taskRootPath(root, source.taskRef),
      'metadata.json',
    );
    const sourceMetadata = JSON.parse(
      await readFile(sourceMetadataPath, 'utf8'),
    );
    await writeFile(
      sourceMetadataPath,
      `${JSON.stringify(
        { ...sourceMetadata, task: 'Use token=super-secret-value locally.' },
        null,
        2,
      )}\n`,
    );
    const blockedSource = await readFile(sourceMetadataPath, 'utf8');

    await expect(
      promoteV3Task({
        projectRoot: root,
        sourceTaskRef: source.taskRef,
        sessionId,
        expectedSourceRevision: source.metadata.revision,
        destinationWorkflowMode: 'manteam',
        sharedPrivacyConfirmed: true,
        client: 'vitest',
        destinationTaskId: id(22),
        operationId: id(23),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
    await expect(readFile(sourceMetadataPath, 'utf8')).resolves.toBe(
      blockedSource,
    );
    await expect(
      readFile(
        path.join(publishStagingDirectory(root, id(23)), 'candidate.json'),
        'utf8',
      ),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(
          root,
          '.mancode',
          'shared',
          'workflows',
          id(22),
          'metadata.json',
        ),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('refuses to publish a local parent while an active diagnostic child exists', async () => {
    const { sessionId } = await bootstrap(root);
    const source = await createV3Workflow({
      projectRoot: root,
      task: 'Diagnose a local issue before publishing team work.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(30),
      operationId: id(31),
      now: NOW,
    });
    const sourceMetadataPath = path.join(
      taskRootPath(root, source.taskRef),
      'metadata.json',
    );
    const parentAtVerification = parseWorkflowMetadata({
      ...source.metadata,
      revision: 2,
      currentStep: 6,
      updatedAt: NOW.toISOString(),
    });
    await writeFile(
      sourceMetadataPath,
      `${JSON.stringify(parentAtVerification, null, 2)}\n`,
    );
    await createV3Workflow({
      projectRoot: root,
      task: 'Collect a local diagnostic result.',
      workflowMode: 'manba',
      parentTaskRef: source.taskRef,
      sessionId,
      client: 'vitest',
      taskId: id(32),
      operationId: id(33),
      now: NOW,
    });

    await expect(
      promoteV3Task({
        projectRoot: root,
        sourceTaskRef: source.taskRef,
        sessionId,
        expectedSourceRevision: parentAtVerification.revision,
        destinationWorkflowMode: 'man',
        sharedPrivacyConfirmed: true,
        client: 'vitest',
        destinationTaskId: id(34),
        operationId: id(35),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_PROMOTION_ACTIVE_CHILDREN');
  });

  it('repairs or aborts a real publish/promote operation at every crash point', async () => {
    for (const [
      index,
      fixture,
    ] of OPERATION_CRASH_FIXTURES.publish_promote.entries()) {
      const caseRoot = await mkdtemp(
        path.join(tmpdir(), `mancode-v3-promote-crash-${index}-`),
      );
      crashRoots.push(caseRoot);
      await initializeGitFixture(caseRoot);
      const { actorId, sessionId } = await bootstrap(caseRoot);
      const source = await createV3Workflow({
        projectRoot: caseRoot,
        task: 'Exercise publish/promote recovery across every durable boundary.',
        workflowMode: 'man',
        sessionId,
        client: 'vitest',
        taskId: id(100 + index),
        operationId: id(120 + index),
        now: NOW,
      });
      const operationId = id(140 + index);

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          promoteV3Task({
            projectRoot: caseRoot,
            sourceTaskRef: source.taskRef,
            sessionId,
            expectedSourceRevision: source.metadata.revision,
            destinationWorkflowMode: 'man',
            sharedPrivacyConfirmed: true,
            client: 'vitest',
            destinationTaskId: id(160 + index),
            operationId,
            now: NOW,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      const recovered = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId,
        actorId,
        sessionId,
        now: NOW,
      });
      if (fixture.expectedRecovery === 'safe_abort') {
        expect(recovered.journal.state).toBe('aborted');
        expect(['aborted', 'already_terminal']).toContain(recovered.state);
      } else if (fixture.crashAfter === 'commit') {
        expect(recovered).toMatchObject({
          state: 'already_terminal',
          journal: { state: 'committed' },
        });
      } else {
        expect(recovered).toMatchObject({
          state: 'repaired',
          journal: { state: 'committed' },
        });
      }
    }
  });
});

async function bootstrap(
  projectRoot: string,
): Promise<{ actorId: Ulid; sessionId: Ulid }> {
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
    displayName: 'Publish Owner',
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
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

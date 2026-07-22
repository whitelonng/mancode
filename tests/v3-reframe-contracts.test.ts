import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { reviseV3Plan } from '../src/context/plan-revision.js';
import { reframeV3Workflow } from '../src/context/reframe.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import {
  REQUIREMENT_DIMENSIONS,
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from '../src/context/requirements-ledger.js';
import { startV3SoloHandoff } from '../src/context/solo-handoff.js';
import { V3ContextStore } from '../src/context/store.js';
import { taskRootPath } from '../src/context/task-locator.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
} from '../src/context/workflow-metadata.js';
import { updateV3Workflow } from '../src/context/workflow-update.js';
import { resolveTaskEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { readHandoff } from '../src/runtime/handoff-store.js';
import { createOperationLockPauseForTesting } from '../src/runtime/operation-crash-injection.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createSession, readSession } from '../src/runtime/session.js';
import { readTaskHeadFence } from '../src/runtime/task-head-store.js';
import { readTaskCheckpointAtRoot } from '../src/runtime/task-operation.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
} from '../src/team/actor.js';
import { acquireV3Claim } from '../src/team/claim-acquisition.js';
import { createV3HandoffDraft } from '../src/team/handoff-operation.js';
import { parseProjectConfig } from '../src/team/policy.js';
import { confirmManteamPlan } from './helpers/manteam-plan.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-21T12:00:00.000Z');

describe('V3 local workflow reframe', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-reframe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('archives the confirmed contract, releases claims, and returns a shared workflow to clarification', async () => {
    const actors = await bootstrap(root, { git: true, joined: true });
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Reframe a shared workflow without losing its confirmed evidence.',
      workflowMode: 'manteam',
      sessionId: actors.sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: { include: ['src/**'], modules: ['governance'] },
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });
    const confirmed = await confirmManteamPlan({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId: actors.sessionId,
      requirements: created.requirements,
      now: NOW,
    });
    const acquired = await acquireV3Claim({
      projectRoot: root,
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
    const store = new V3ContextStore(root);
    const before = await store.readTaskSnapshot(created.taskRef);
    const taskRoot = taskRootPath(root, created.taskRef);
    const [requirementsBytes, planBytes] = await Promise.all([
      readFile(path.join(taskRoot, 'requirements.json'), 'utf8'),
      readFile(path.join(taskRoot, 'plan.md'), 'utf8'),
    ]);
    const operationId = id(14);
    const checkpointId = id(15);

    const reframed = await reframeV3Workflow({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId: actors.sessionId,
      expectedTaskRevision: before.metadata.revision,
      checkpointId,
      summary: 'New evidence changes the requirements semantic boundary.',
      nextAction: 'Clarify and confirm the replacement requirements.',
      operationId,
      now: NOW,
    });

    expect(reframed).toMatchObject({
      metadata: {
        status: 'in_progress',
        currentStep: 2,
        transitionState: 'stable',
        blockingReason: null,
        governance: {
          requirementsStatus: 'needs_clarification',
          planDecision: null,
          reviewStatus: 'stale',
          verificationStatus: 'stale',
        },
        soloExecution: null,
        latestCheckpointRef: { artifactId: checkpointId },
        lastOperationId: operationId,
      },
      requirements: {
        revision: before.requirements.revision + 1,
        status: 'draft',
        lastOperationId: operationId,
      },
      review: {
        revision: before.review.revision + 1,
        status: 'stale',
        lastOperationId: operationId,
      },
      verification: {
        revision: before.verification.revision + 1,
        status: 'stale',
        lastOperationId: operationId,
      },
      checkpoint: {
        checkpointId,
        operationId,
        kind: 'requirements_reframed',
        summary: 'New evidence changes the requirements semantic boundary.',
        nextAction: 'Clarify and confirm the replacement requirements.',
      },
      archive: {
        archiveId: operationId,
        taskRef: created.taskRef,
        sourceTaskRevision: before.metadata.revision,
        sourceRequirementsRevision: before.requirements.revision,
        sourceRequirementsDigest: before.requirements.contentDigest,
        sourcePlanVersion: before.metadata.governance.planVersion,
        sourcePlanDigest: before.plan?.digest,
        createdAt: NOW.toISOString(),
      },
      releasedClaims: [
        {
          claimId: acquired.claim.claimId,
          state: 'released',
          revision: acquired.claim.revision + 1,
          lastOperationId: operationId,
        },
      ],
      operation: { type: 'reframe', state: 'committed' },
    });

    const archiveRoot = path.join(taskRoot, 'archives', operationId);
    const [archive, archivedRequirements, archivedPlan] = await Promise.all([
      readFile(path.join(archiveRoot, 'archive.json'), 'utf8'),
      readFile(path.join(archiveRoot, 'requirements.json'), 'utf8'),
      readFile(path.join(archiveRoot, 'plan.md'), 'utf8'),
    ]);
    expect(JSON.parse(archive)).toMatchObject({
      ...reframed.archive,
      schemaVersion: 1,
      operationId,
      requirementsFileDigest: expect.stringMatching(/^sha256:/),
      planFileDigest: expect.stringMatching(/^sha256:/),
      archiveDigest: expect.stringMatching(/^sha256:/),
    });
    expect(archivedRequirements).toBe(requirementsBytes);
    expect(archivedPlan).toBe(planBytes);

    const persisted = await store.readTaskSnapshot(created.taskRef);
    expect(persisted.metadata).toEqual(reframed.metadata);
    expect(persisted.requirements).toEqual(reframed.requirements);
    expect(persisted.review).toEqual(reframed.review);
    expect(persisted.verification).toEqual(reframed.verification);
    expect(persisted.latestCheckpoint).toEqual(reframed.checkpoint);
    expect(persisted.aggregate).toEqual(reframed.aggregate);
    expect(persisted.aggregateError).toBeNull();

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    const coordination = await store.readCoordinationSnapshot(
      created.taskRef,
      home,
    );
    expect(coordination.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimId: acquired.claim.claimId,
          state: 'released',
          lastOperationId: operationId,
        }),
      ]),
    );
    expect(await readTaskHeadFence(home, created.taskRef)).toMatchObject({
      taskRevision: reframed.metadata.revision,
      lastOperationId: operationId,
    });
    await expect(
      readOperationJournal(home, operationId),
    ).resolves.toMatchObject({
      type: 'reframe',
      state: 'committed',
      entityLocks: expect.arrayContaining([
        `task:shared:${created.taskRef.taskId}`,
        `archive:${operationId}`,
        `checkpoint:${checkpointId}`,
        `claim:${acquired.claim.claimId}`,
        `task_head:${created.taskRef.taskId}`,
      ]),
    });
    await expect(readSession(root, actors.sessionId)).resolves.toMatchObject({
      activeTaskRef: created.taskRef,
      activeMode: 'manteam',
      lastSeenRevision: reframed.metadata.revision,
    });
  });

  it('rejects active child, open handoff, and active solo before writing authority', async () => {
    const childRoot = await caseRoot(root, 'active-child');
    const childActors = await bootstrap(childRoot);
    const parent = await createV3Workflow({
      projectRoot: childRoot,
      task: 'Keep the parent stable while its diagnostic child is active.',
      workflowMode: 'man',
      sessionId: childActors.sessionId,
      client: 'vitest',
      taskId: id(20),
      operationId: id(21),
      now: NOW,
    });
    const parentAtVerification = parseWorkflowMetadata({
      ...parent.metadata,
      revision: 2,
      currentStep: 6,
      updatedAt: NOW.toISOString(),
    });
    await writeMetadata(childRoot, parent.taskRef, parentAtVerification);
    await createV3Workflow({
      projectRoot: childRoot,
      task: 'Diagnose the parent verification failure.',
      workflowMode: 'manba',
      sessionId: childActors.sessionId,
      client: 'vitest',
      parentTaskRef: parent.taskRef,
      taskId: id(22),
      operationId: id(23),
      now: NOW,
    });
    await expectRejectedWithoutAuthorityChange({
      projectRoot: childRoot,
      taskRef: parent.taskRef,
      sessionId: childActors.sessionId,
      expectedTaskRevision: parentAtVerification.revision,
      checkpointId: id(24),
      operationId: id(25),
      error: 'MANCODE_REFRAME_ACTIVE_CHILD',
    });

    const handoffRoot = await caseRoot(root, 'open-handoff');
    const handoffActors = await bootstrap(handoffRoot, {
      git: true,
      joined: true,
      receiver: true,
    });
    const shared = await createV3Workflow({
      projectRoot: handoffRoot,
      task: 'Keep a draft handoff intact when reframe is rejected.',
      workflowMode: 'manteam',
      sessionId: handoffActors.sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      participantActorIds: [handoffActors.receiverActorId as Ulid],
      implementationScope: { include: ['src/**'], modules: ['handoff'] },
      taskId: id(30),
      operationId: id(31),
      now: NOW,
    });
    const sharedPlan = await confirmManteamPlan({
      projectRoot: handoffRoot,
      taskRef: shared.taskRef,
      sessionId: handoffActors.sessionId,
      requirements: shared.requirements,
      now: NOW,
    });
    await createV3HandoffDraft({
      projectRoot: handoffRoot,
      taskRef: shared.taskRef,
      sessionId: handoffActors.sessionId,
      expectedTaskRevision: sharedPlan.taskRevision,
      toActorId: handoffActors.receiverActorId as Ulid,
      handoffId: id(32),
      checkpointId: id(33),
      checkpointOperationId: id(34),
      operationId: id(35),
      now: NOW,
    });
    const sharedBefore = await new V3ContextStore(handoffRoot).readTaskSnapshot(
      shared.taskRef,
    );
    await expectRejectedWithoutAuthorityChange({
      projectRoot: handoffRoot,
      taskRef: shared.taskRef,
      sessionId: handoffActors.sessionId,
      expectedTaskRevision: sharedBefore.metadata.revision,
      checkpointId: id(36),
      operationId: id(37),
      error: 'MANCODE_REFRAME_OPEN_HANDOFF',
    });

    const soloRoot = await caseRoot(root, 'active-solo');
    const soloActors = await bootstrap(soloRoot);
    const solo = await createV3Workflow({
      projectRoot: soloRoot,
      task: 'Keep the active solo assignment intact.',
      workflowMode: 'man',
      sessionId: soloActors.sessionId,
      client: 'vitest',
      taskId: id(40),
      operationId: id(41),
      now: NOW,
    });
    const soloRequirements = await finalizeV3Requirements({
      projectRoot: soloRoot,
      taskRef: solo.taskRef,
      sessionId: soloActors.sessionId,
      expectedTaskRevision: solo.metadata.revision,
      requirements: confirmedRequirements(solo.requirements),
      operationId: id(42),
      now: NOW,
    });
    const soloPlan = await reviseV3Plan({
      projectRoot: soloRoot,
      taskRef: solo.taskRef,
      sessionId: soloActors.sessionId,
      expectedTaskRevision: soloRequirements.metadata.revision,
      plan: '# Plan\n\n1. Implement the confirmed local change.\n',
      operationId: id(43),
      now: NOW,
    });
    const assignment = await startV3SoloHandoff({
      projectRoot: soloRoot,
      taskRef: solo.taskRef,
      sessionId: soloActors.sessionId,
      expectedTaskRevision: soloPlan.metadata.revision,
      operationId: id(44),
      now: NOW,
    });
    await expectRejectedWithoutAuthorityChange({
      projectRoot: soloRoot,
      taskRef: solo.taskRef,
      sessionId: soloActors.sessionId,
      expectedTaskRevision: assignment.metadata.revision,
      checkpointId: id(45),
      operationId: id(46),
      error: 'MANCODE_REFRAME_ACTIVE_SOLO',
    });
  });

  it('serializes reframe and child creation in both canonical parent-lock orders', async () => {
    await assertChildReframeRace(
      await caseRoot(root, 'concurrent-child-reframe-wins'),
      'reframe',
    );
    await assertChildReframeRace(
      await caseRoot(root, 'concurrent-child-create-wins'),
      'child',
    );
  });

  it('serializes reframe across both handoff checkpoint and draft lock phases', async () => {
    await assertHandoffReframeRace(
      await caseRoot(root, 'concurrent-handoff-reframe-wins'),
      'reframe',
    );
    await assertHandoffReframeRace(
      await caseRoot(root, 'concurrent-handoff-checkpoint-wins'),
      'handoff_checkpoint',
    );
    await assertHandoffReframeRace(
      await caseRoot(root, 'concurrent-handoff-draft-wins'),
      'handoff_draft',
    );
  });

  it('serializes reframe and solo handoff start in both canonical task-lock orders', async () => {
    await assertSoloReframeRace(
      await caseRoot(root, 'concurrent-solo-reframe-wins'),
      'reframe',
    );
    await assertSoloReframeRace(
      await caseRoot(root, 'concurrent-solo-start-wins'),
      'solo',
    );
  });

  it('rejects terminal, repair-pending, manba, and git-ref workflows without a reframe journal', async () => {
    const terminalRoot = await caseRoot(root, 'terminal');
    const terminalActors = await bootstrap(terminalRoot);
    const terminal = await createV3Workflow({
      projectRoot: terminalRoot,
      task: 'Do not reopen an abandoned workflow through reframe.',
      workflowMode: 'man',
      sessionId: terminalActors.sessionId,
      client: 'vitest',
      taskId: id(50),
      operationId: id(51),
      now: NOW,
    });
    const abandoned = await updateV3Workflow({
      projectRoot: terminalRoot,
      taskRef: terminal.taskRef,
      sessionId: terminalActors.sessionId,
      expectedTaskRevision: terminal.metadata.revision,
      status: 'abandoned',
      operationId: id(52),
      now: NOW,
    });
    await expectRejectedWithoutAuthorityChange({
      projectRoot: terminalRoot,
      taskRef: terminal.taskRef,
      sessionId: terminalActors.sessionId,
      expectedTaskRevision: abandoned.metadata.revision,
      checkpointId: id(53),
      operationId: id(54),
      error: /MANCODE_(?:REFRAME|WORKFLOW)_/,
    });

    const repairRoot = await caseRoot(root, 'pending-repair');
    const repairActors = await bootstrap(repairRoot);
    const repair = await createV3Workflow({
      projectRoot: repairRoot,
      task: 'Do not reframe a workflow that requires operation repair.',
      workflowMode: 'man',
      sessionId: repairActors.sessionId,
      client: 'vitest',
      taskId: id(60),
      operationId: id(61),
      now: NOW,
    });
    const pendingRepair = parseWorkflowMetadata({
      ...repair.metadata,
      revision: repair.metadata.revision + 1,
      transitionState: 'pending_repair',
      lastOperationId: id(62),
      updatedAt: NOW.toISOString(),
    });
    await writeMetadata(repairRoot, repair.taskRef, pendingRepair);
    await expectRejectedWithoutAuthorityChange({
      projectRoot: repairRoot,
      taskRef: repair.taskRef,
      sessionId: repairActors.sessionId,
      expectedTaskRevision: pendingRepair.revision,
      checkpointId: id(63),
      operationId: id(64),
      error: /MANCODE_(?:REFRAME|TASK|OPERATION)_/,
    });

    const manbaRoot = await caseRoot(root, 'manba');
    const manbaActors = await bootstrap(manbaRoot);
    const manba = await createV3Workflow({
      projectRoot: manbaRoot,
      task: 'Do not apply requirements reframe to a diagnostic workflow.',
      workflowMode: 'manba',
      sessionId: manbaActors.sessionId,
      client: 'vitest',
      taskId: id(70),
      operationId: id(71),
      now: NOW,
    });
    await expectRejectedWithoutAuthorityChange({
      projectRoot: manbaRoot,
      taskRef: manba.taskRef,
      sessionId: manbaActors.sessionId,
      expectedTaskRevision: manba.metadata.revision,
      checkpointId: id(72),
      operationId: id(73),
      error: /MANCODE_REFRAME_/,
    });

    const gitRefRoot = await caseRoot(root, 'git-ref');
    const gitRefActors = await bootstrap(gitRefRoot);
    const gitRef = await createV3Workflow({
      projectRoot: gitRefRoot,
      task: 'Reject reframe whenever project transport is git-ref.',
      workflowMode: 'man',
      sessionId: gitRefActors.sessionId,
      client: 'vitest',
      taskId: id(80),
      operationId: id(81),
      now: NOW,
    });
    await forceGitRefTransport(gitRefRoot);
    await expectRejectedWithoutAuthorityChange({
      projectRoot: gitRefRoot,
      taskRef: gitRef.taskRef,
      sessionId: gitRefActors.sessionId,
      expectedTaskRevision: gitRef.metadata.revision,
      checkpointId: id(82),
      operationId: id(83),
      error: 'MANCODE_REFRAME_GIT_REF_UNSUPPORTED',
    });
  });

  it('rejects a workflow that is already clarifying requirements without writing authority', async () => {
    const actors = await bootstrap(root);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Keep an existing clarification draft unchanged.',
      workflowMode: 'man',
      sessionId: actors.sessionId,
      client: 'vitest',
      taskId: id(80),
      operationId: id(81),
      now: NOW,
    });

    await expectRejectedWithoutAuthorityChange({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId: actors.sessionId,
      expectedTaskRevision: created.metadata.revision,
      checkpointId: id(82),
      operationId: id(83),
      error: 'MANCODE_REFRAME_REQUIREMENTS_NOT_CONFIRMED',
    });
  });
});

async function assertChildReframeRace(
  projectRoot: string,
  winner: 'reframe' | 'child',
): Promise<void> {
  const actors = await bootstrap(projectRoot);
  const parent = await createV3Workflow({
    projectRoot,
    task: 'Race requirements reframe against a diagnostic child.',
    workflowMode: 'man',
    sessionId: actors.sessionId,
    client: 'vitest',
    taskId: id(200),
    operationId: id(201),
    now: NOW,
  });
  const finalized = await finalizeV3Requirements({
    projectRoot,
    taskRef: parent.taskRef,
    sessionId: actors.sessionId,
    expectedTaskRevision: parent.metadata.revision,
    requirements: confirmedRequirements(parent.requirements),
    operationId: id(202),
    now: NOW,
  });
  const planned = await reviseV3Plan({
    projectRoot,
    taskRef: parent.taskRef,
    sessionId: actors.sessionId,
    expectedTaskRevision: finalized.metadata.revision,
    plan: '# Plan\n\n1. Implement and verify the confirmed change.\n',
    planDecision: 'governed_execution',
    operationId: id(203),
    now: NOW,
  });
  await writeMetadata(
    projectRoot,
    parent.taskRef,
    parseWorkflowMetadata({ ...planned.metadata, currentStep: 6 }),
  );

  const childTaskRef: TaskRef = { namespace: 'local', taskId: id(204) };
  const childOperationId = id(205);
  const reframeOperationId = id(206);
  const reframeCheckpointId = id(207);
  const parentBefore = await authorityDigest(projectRoot, parent.taskRef);
  const reframe = () =>
    reframeV3Workflow({
      projectRoot,
      taskRef: parent.taskRef,
      sessionId: actors.sessionId,
      expectedTaskRevision: planned.metadata.revision,
      checkpointId: reframeCheckpointId,
      operationId: reframeOperationId,
      now: NOW,
    });
  const createChild = () =>
    createV3Workflow({
      projectRoot,
      task: 'Diagnose the verification failure before parent reframe.',
      workflowMode: 'manba',
      sessionId: actors.sessionId,
      client: 'vitest',
      parentTaskRef: parent.taskRef,
      taskId: childTaskRef.taskId,
      operationId: childOperationId,
      now: NOW,
    });
  const store = new V3ContextStore(projectRoot);
  const home = await taskHomeStore(projectRoot, parent.taskRef);

  if (winner === 'reframe') {
    const result = await runPausedCanonicalLockRace(
      reframeOperationId,
      reframe,
      createChild,
    );
    const persisted = await store.readTaskSnapshot(parent.taskRef);
    expect(persisted.metadata).toEqual(result.metadata);
    expect(persisted.requirements).toEqual(result.requirements);
    expect(persisted.aggregateError).toBeNull();
    await expect(
      store.listActiveChildTaskRefs(parent.taskRef),
    ).resolves.toEqual([]);
    await expectTaskMissing(projectRoot, childTaskRef);
    await expect(
      readOperationJournal(home, childOperationId),
    ).resolves.toBeNull();
    await expect(
      readOperationJournal(home, reframeOperationId),
    ).resolves.toMatchObject({ state: 'committed', type: 'reframe' });
    return;
  }

  const result = await runPausedCanonicalLockRace(
    childOperationId,
    createChild,
    reframe,
  );
  expect(await authorityDigest(projectRoot, parent.taskRef)).toBe(parentBefore);
  const child = await store.readTaskSnapshot(childTaskRef);
  expect(child.metadata).toEqual(result.metadata);
  expect(child.aggregateError).toBeNull();
  await expect(store.listActiveChildTaskRefs(parent.taskRef)).resolves.toEqual([
    childTaskRef,
  ]);
  await expect(
    readOperationJournal(home, childOperationId),
  ).resolves.toMatchObject({ state: 'committed', type: 'workflow_create' });
  await expect(
    readOperationJournal(home, reframeOperationId),
  ).resolves.toBeNull();
  await expectNoReframeArtifacts(
    projectRoot,
    parent.taskRef,
    reframeOperationId,
    reframeCheckpointId,
  );
}

async function assertHandoffReframeRace(
  projectRoot: string,
  winner: 'reframe' | 'handoff_checkpoint' | 'handoff_draft',
): Promise<void> {
  const actors = await bootstrap(projectRoot, {
    git: true,
    joined: true,
    receiver: true,
  });
  const created = await createV3Workflow({
    projectRoot,
    task: 'Race a named handoff against requirements reframe.',
    workflowMode: 'manteam',
    sessionId: actors.sessionId,
    client: 'vitest',
    sharedPrivacyConfirmed: true,
    participantActorIds: [actors.receiverActorId as Ulid],
    implementationScope: { include: ['src/**'], modules: ['handoff'] },
    taskId: id(300),
    operationId: id(301),
    now: NOW,
  });
  const planned = await confirmManteamPlan({
    projectRoot,
    taskRef: created.taskRef,
    sessionId: actors.sessionId,
    requirements: created.requirements,
    now: NOW,
  });
  const handoffId = id(302);
  const handoffCheckpointId = id(303);
  const handoffCheckpointOperationId = id(304);
  const handoffOperationId = id(305);
  const reframeOperationId = id(306);
  const reframeCheckpointId = id(307);
  const createHandoff = () =>
    createV3HandoffDraft({
      projectRoot,
      taskRef: created.taskRef,
      sessionId: actors.sessionId,
      expectedTaskRevision: planned.taskRevision,
      toActorId: actors.receiverActorId as Ulid,
      handoffId,
      checkpointId: handoffCheckpointId,
      checkpointOperationId: handoffCheckpointOperationId,
      operationId: handoffOperationId,
      now: NOW,
    });
  const reframe = () =>
    reframeV3Workflow({
      projectRoot,
      taskRef: created.taskRef,
      sessionId: actors.sessionId,
      expectedTaskRevision: planned.taskRevision,
      checkpointId: reframeCheckpointId,
      operationId: reframeOperationId,
      now: NOW,
    });
  const store = new V3ContextStore(projectRoot);
  const home = await taskHomeStore(projectRoot, created.taskRef);

  if (winner === 'reframe') {
    const result = await runPausedCanonicalLockRace(
      reframeOperationId,
      reframe,
      createHandoff,
    );
    const persisted = await store.readTaskSnapshot(created.taskRef);
    expect(persisted.metadata).toEqual(result.metadata);
    expect(persisted.requirements).toEqual(result.requirements);
    expect(persisted.aggregateError).toBeNull();
    await expect(readHandoff(home, handoffId)).resolves.toBeNull();
    await expect(
      readTaskCheckpointAtRoot(
        taskRootPath(projectRoot, created.taskRef),
        handoffCheckpointId,
      ),
    ).resolves.toBeNull();
    await expect(
      readOperationJournal(home, handoffCheckpointOperationId),
    ).resolves.toBeNull();
    await expect(
      readOperationJournal(home, handoffOperationId),
    ).resolves.toBeNull();
    await expect(
      readOperationJournal(home, reframeOperationId),
    ).resolves.toMatchObject({ state: 'committed', type: 'reframe' });
    await expect(
      readTaskHeadFence(home, created.taskRef),
    ).resolves.toMatchObject({
      taskRevision: persisted.metadata.revision,
      lastOperationId: reframeOperationId,
    });
    return;
  }

  const result = await runPausedCanonicalLockRace(
    winner === 'handoff_checkpoint'
      ? handoffCheckpointOperationId
      : handoffOperationId,
    createHandoff,
    reframe,
  );
  const persisted = await store.readTaskSnapshot(created.taskRef);
  expect(persisted.aggregateError).toBeNull();
  expect(persisted.metadata).toMatchObject({
    lastOperationId: handoffCheckpointOperationId,
    latestCheckpointRef: { artifactId: handoffCheckpointId },
  });
  expect(persisted.requirements.status).toBe('confirmed');
  await expect(readHandoff(home, handoffId)).resolves.toEqual(result.handoff);
  await expect(
    readOperationJournal(home, handoffCheckpointOperationId),
  ).resolves.toMatchObject({ state: 'committed', type: 'checkpoint_create' });
  await expect(
    readOperationJournal(home, handoffOperationId),
  ).resolves.toMatchObject({ state: 'committed', type: 'handoff_transition' });
  await expect(
    readOperationJournal(home, reframeOperationId),
  ).resolves.toBeNull();
  await expect(readTaskHeadFence(home, created.taskRef)).resolves.toMatchObject(
    {
      taskRevision: persisted.metadata.revision,
      lastOperationId: handoffCheckpointOperationId,
    },
  );
  await expectNoReframeArtifacts(
    projectRoot,
    created.taskRef,
    reframeOperationId,
    reframeCheckpointId,
  );
}

async function assertSoloReframeRace(
  projectRoot: string,
  winner: 'reframe' | 'solo',
): Promise<void> {
  const actors = await bootstrap(projectRoot);
  const created = await createV3Workflow({
    projectRoot,
    task: 'Race solo execution assignment against requirements reframe.',
    workflowMode: 'man',
    sessionId: actors.sessionId,
    client: 'vitest',
    taskId: id(400),
    operationId: id(401),
    now: NOW,
  });
  const finalized = await finalizeV3Requirements({
    projectRoot,
    taskRef: created.taskRef,
    sessionId: actors.sessionId,
    expectedTaskRevision: created.metadata.revision,
    requirements: confirmedRequirements(created.requirements),
    operationId: id(402),
    now: NOW,
  });
  const planned = await reviseV3Plan({
    projectRoot,
    taskRef: created.taskRef,
    sessionId: actors.sessionId,
    expectedTaskRevision: finalized.metadata.revision,
    plan: '# Plan\n\n1. Execute the bounded solo change.\n',
    operationId: id(403),
    now: NOW,
  });
  const soloOperationId = id(404);
  const reframeOperationId = id(405);
  const reframeCheckpointId = id(406);
  const startSolo = () =>
    startV3SoloHandoff({
      projectRoot,
      taskRef: created.taskRef,
      sessionId: actors.sessionId,
      expectedTaskRevision: planned.metadata.revision,
      operationId: soloOperationId,
      now: NOW,
    });
  const reframe = () =>
    reframeV3Workflow({
      projectRoot,
      taskRef: created.taskRef,
      sessionId: actors.sessionId,
      expectedTaskRevision: planned.metadata.revision,
      checkpointId: reframeCheckpointId,
      operationId: reframeOperationId,
      now: NOW,
    });
  const store = new V3ContextStore(projectRoot);
  const home = await taskHomeStore(projectRoot, created.taskRef);

  if (winner === 'reframe') {
    const result = await runPausedCanonicalLockRace(
      reframeOperationId,
      reframe,
      startSolo,
    );
    const persisted = await store.readTaskSnapshot(created.taskRef);
    expect(persisted.metadata).toEqual(result.metadata);
    expect(persisted.requirements).toEqual(result.requirements);
    expect(persisted.metadata.soloExecution).toBeNull();
    expect(persisted.aggregateError).toBeNull();
    await expect(
      readOperationJournal(home, soloOperationId),
    ).resolves.toBeNull();
    await expect(
      readOperationJournal(home, reframeOperationId),
    ).resolves.toMatchObject({ state: 'committed', type: 'reframe' });
    return;
  }

  const result = await runPausedCanonicalLockRace(
    soloOperationId,
    startSolo,
    reframe,
  );
  const persisted = await store.readTaskSnapshot(created.taskRef);
  expect(persisted.metadata).toEqual(result.metadata);
  expect(persisted.metadata.soloExecution).toMatchObject({ state: 'active' });
  expect(persisted.requirements.status).toBe('confirmed');
  expect(persisted.aggregateError).toBeNull();
  await expect(
    readOperationJournal(home, soloOperationId),
  ).resolves.toMatchObject({ state: 'committed', type: 'solo_handoff' });
  await expect(
    readOperationJournal(home, reframeOperationId),
  ).resolves.toBeNull();
  await expectNoReframeArtifacts(
    projectRoot,
    created.taskRef,
    reframeOperationId,
    reframeCheckpointId,
  );
}

async function runPausedCanonicalLockRace<Winner>(
  winnerOperationId: Ulid,
  winner: () => Promise<Winner>,
  loser: () => Promise<unknown>,
): Promise<Winner> {
  const pause = createOperationLockPauseForTesting({
    operationId: winnerOperationId,
    pauseAfter: 'entity_locks_held',
  });
  const winnerPromise = pause.run(winner);
  void winnerPromise.catch(() => undefined);
  await pause.reached;
  const loserPromise = loser();
  const [loserWhilePaused] = await Promise.allSettled([loserPromise]);
  pause.release();
  const [winnerResult, loserResult] = await Promise.allSettled([
    winnerPromise,
    loserPromise,
  ]);

  expect(loserWhilePaused).toMatchObject({ status: 'rejected' });
  expect(loserResult).toMatchObject({ status: 'rejected' });
  if (loserResult.status !== 'rejected') {
    throw new Error('expected the lock contender to be rejected');
  }
  expect(
    loserResult.reason instanceof Error
      ? loserResult.reason.message
      : String(loserResult.reason),
  ).toBe('MANCODE_LOCK_HELD');
  if (winnerResult.status === 'rejected') throw winnerResult.reason;
  return winnerResult.value;
}

async function taskHomeStore(projectRoot: string, taskRef: TaskRef) {
  const runtime = await readProjectRuntimeContext(projectRoot);
  return resolveTaskEntityHomeStore(runtime.entityHomeStoreContext, taskRef);
}

async function expectTaskMissing(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<void> {
  await expect(
    readFile(
      path.join(taskRootPath(projectRoot, taskRef), 'metadata.json'),
      'utf8',
    ),
  ).rejects.toMatchObject({ code: 'ENOENT' });
}

async function expectNoReframeArtifacts(
  projectRoot: string,
  taskRef: TaskRef,
  operationId: Ulid,
  checkpointId: Ulid,
): Promise<void> {
  const taskRoot = taskRootPath(projectRoot, taskRef);
  await expect(
    readTaskCheckpointAtRoot(taskRoot, checkpointId),
  ).resolves.toBeNull();
  await expect(
    readFile(
      path.join(taskRoot, 'archives', operationId, 'archive.json'),
      'utf8',
    ),
  ).rejects.toMatchObject({ code: 'ENOENT' });
}

async function expectRejectedWithoutAuthorityChange(input: {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  checkpointId: Ulid;
  operationId: Ulid;
  error: string | RegExp;
}): Promise<void> {
  const before = await authorityDigest(input.projectRoot, input.taskRef);
  const attempt = reframeV3Workflow({
    projectRoot: input.projectRoot,
    taskRef: input.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    checkpointId: input.checkpointId,
    operationId: input.operationId,
    now: NOW,
  });
  if (typeof input.error === 'string') {
    await expect(attempt).rejects.toThrow(input.error);
  } else {
    await expect(attempt).rejects.toThrow(input.error);
  }
  expect(await authorityDigest(input.projectRoot, input.taskRef)).toBe(before);

  const runtime = await readProjectRuntimeContext(input.projectRoot);
  const home = resolveTaskEntityHomeStore(
    runtime.entityHomeStoreContext,
    input.taskRef,
  );
  await expect(
    readOperationJournal(home, input.operationId),
  ).resolves.toBeNull();
}

async function authorityDigest(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<string> {
  const store = new V3ContextStore(projectRoot);
  const runtime = await readProjectRuntimeContext(projectRoot);
  const home = resolveTaskEntityHomeStore(
    runtime.entityHomeStoreContext,
    taskRef,
  );
  const [project, task, coordination] = await Promise.all([
    store.readProjectSnapshot(),
    store.readTaskSnapshot(taskRef),
    store.readCoordinationSnapshot(taskRef, home),
  ]);
  return digestCanonicalJson({
    project: project.fingerprint,
    task: task.fingerprint,
    coordination: coordination.fingerprint,
  });
}

async function bootstrap(
  projectRoot: string,
  options: { git?: boolean; joined?: boolean; receiver?: boolean } = {},
): Promise<{
  actorId: Ulid;
  sessionId: Ulid;
  receiverActorId: Ulid | null;
}> {
  if (options.git === true) await initializeGitFixture(projectRoot);
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
    displayName: 'Reframe Owner',
    now: NOW,
  });
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  if (options.joined === true) {
    const actor = await readLocalActor(projectRoot);
    if (actor === null) throw new Error('missing reframe owner actor');
    await publishSharedActorProfile(
      projectRoot,
      createSharedActorProfile(actor, NOW),
    );
  }
  const receiverActorId = options.receiver === true ? id(6) : null;
  if (receiverActorId !== null) {
    await publishSharedActorProfile(projectRoot, {
      schemaVersion: 1,
      actorId: receiverActorId,
      displayName: 'Reframe Receiver',
      joinedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  }
  return { actorId, sessionId, receiverActorId };
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

async function caseRoot(projectRoot: string, name: string): Promise<string> {
  const target = path.join(projectRoot, name);
  await mkdir(target, { recursive: true });
  return target;
}

async function writeMetadata(
  projectRoot: string,
  taskRef: TaskRef,
  metadata: WorkflowMetadataV3,
): Promise<void> {
  await writeFile(
    path.join(taskRootPath(projectRoot, taskRef), 'metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

async function forceGitRefTransport(projectRoot: string): Promise<void> {
  const project = await new V3ContextStore(projectRoot).readProjectSnapshot();
  const config = parseProjectConfig({
    ...project.config,
    revision: project.config.revision + 1,
    transport: {
      mode: 'git-ref',
      remote: 'origin/mancode-team',
      epoch: project.config.transport.epoch + 1,
    },
    lastOperationId: id(90),
    updatedAt: NOW.toISOString(),
  });
  await writeFile(
    path.join(projectRoot, '.mancode', 'shared', 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function confirmedRequirements(
  previous: RequirementsLedgerV1,
): RequirementsLedgerV1 {
  const requirementId = id(100);
  const draft: RequirementsLedgerV1 = {
    ...previous,
    revision: 99,
    status: 'confirmed',
    goal: 'Implement the confirmed local plan.',
    functionalScope: {
      inScope: ['Local implementation'],
      outOfScope: ['Unconfirmed changes'],
    },
    technicalDecisions: [],
    defaults: [],
    coverage: REQUIREMENT_DIMENSIONS.map((dimension, index) => ({
      coverageId: id(110 + index),
      dimension,
      status: dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
      rationale: `Confirmed ${dimension}.`,
    })),
    requirements: [
      {
        displayId: 'REQ-1',
        legacyId: null,
        requirementId,
        statement: 'The local plan remains explicit and testable.',
        priority: 'must',
      },
    ],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: null,
        criterionId: id(101),
        requirementIds: [requirementId],
        statement: 'The planned change has a reproducible validation.',
        required: true,
        verificationRequirement: 'automated',
      },
    ],
    blockingUnknowns: [],
    contentDigest: '',
    lastOperationId: id(102),
    updatedAt: NOW.toISOString(),
  };
  return parseRequirementsLedger({
    ...draft,
    contentDigest: requirementsLedgerDigest(draft),
  });
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-21T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

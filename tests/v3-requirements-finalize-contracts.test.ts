import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createV3Checkpoint } from '../src/context/checkpoint-create.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { reviseV3Plan } from '../src/context/plan-revision.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import { REQUIREMENT_DIMENSIONS } from '../src/context/requirements-ledger.js';
import {
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from '../src/context/requirements-ledger.js';
import {
  type ReviewLedgerV1,
  parseReviewLedger,
  reviewLedgerDigest,
} from '../src/context/review-ledger.js';
import { applyV3ReviewLedger } from '../src/context/review-remediation.js';
import { V3ContextStore } from '../src/context/store.js';
import { completeV3Task } from '../src/context/task-complete.js';
import {
  type VerificationLedgerV1,
  parseVerificationLedger,
  verificationLedgerDigest,
} from '../src/context/verification-ledger.js';
import { recordV3Verification } from '../src/context/verification-record.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
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
import { acquireV3Claim } from '../src/team/claim-acquisition.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-17T10:00:00.000Z');

describe('V3 requirements finalization operation', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-requirements-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('updates the local ledger tuple atomically through a committed journal', async () => {
    const { sessionId } = await bootstrap(root, false, false);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Define a durable V3 requirements contract.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });

    const result = await finalizeV3Requirements({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: 1,
      requirements: finalizedRequirements(
        created.requirements,
        created.taskRef,
      ),
      operationId: id(12),
      now: NOW,
    });

    expect(result.operation.state).toBe('committed');
    expect(result.metadata).toMatchObject({
      revision: 2,
      currentStep: 2,
      governance: {
        requirementsStatus: 'ready',
        requirementsDigest: result.requirements.contentDigest,
        reviewStatus: 'stale',
        verificationStatus: 'stale',
      },
    });
    expect(result.requirements).toMatchObject({
      revision: 2,
      status: 'confirmed',
      lastOperationId: id(12),
    });
    expect(result.review).toMatchObject({
      revision: 2,
      status: 'stale',
      lastOperationId: id(12),
    });
    expect(result.verification).toMatchObject({
      revision: 2,
      status: 'stale',
      lastOperationId: id(12),
    });
    expect(result.taskHeadFence).toBeNull();

    const store = new V3ContextStore(root);
    const persisted = await store.readTaskSnapshot(created.taskRef);
    expect(persisted.aggregate).toEqual(result.aggregate);
    expect(persisted.aggregateError).toBeNull();

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    await expect(readOperationJournal(home, id(12))).resolves.toMatchObject({
      type: 'requirements_finalize',
      state: 'committed',
      expectedRevisions: {
        [`task:local:${created.taskRef.taskId}`]: 1,
        [`requirements:${created.taskRef.taskId}`]: 1,
        [`review:${created.taskRef.taskId}`]: 1,
        [`verification:${created.taskRef.taskId}`]: 1,
      },
    });

    await expect(
      finalizeV3Requirements({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: 1,
        requirements: finalizedRequirements(
          result.requirements,
          created.taskRef,
        ),
        operationId: id(13),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_EXPECTED_REVISION_CONFLICT');
  });

  it('requires the shared task-head fence and advances it with the aggregate', async () => {
    const { sessionId } = await bootstrap(root, true, true);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Coordinate requirements for a shared V3 workflow.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      taskId: id(20),
      operationId: id(21),
      now: NOW,
    });

    const result = await finalizeV3Requirements({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: 1,
      requirements: finalizedRequirements(
        created.requirements,
        created.taskRef,
      ),
      operationId: id(22),
      now: NOW,
    });

    expect(result.taskHeadFence).toMatchObject({
      fenceRevision: 2,
      taskRevision: 2,
      aggregateDigest: expect.stringMatching(/^sha256:/),
      lastOperationId: id(22),
    });
    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    expect(await readTaskHeadFence(home, created.taskRef)).toEqual(
      result.taskHeadFence,
    );
    await expect(readOperationJournal(home, id(22))).resolves.toMatchObject({
      entityLocks: expect.arrayContaining([
        `task:shared:${created.taskRef.taskId}`,
        `task_head:${created.taskRef.taskId}`,
      ]),
      expectedRevisions: {
        [`task_head:${created.taskRef.taskId}`]: 1,
      },
    });
  });

  it('writes a plan revision before exposing its metadata and stale ledgers', async () => {
    const { sessionId } = await bootstrap(root, false, false);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Prepare a V3 plan revision contract.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(70),
      operationId: id(71),
      now: NOW,
    });
    const finalized = await finalizeV3Requirements({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: 1,
      requirements: finalizedRequirements(
        created.requirements,
        created.taskRef,
      ),
      operationId: id(72),
      now: NOW,
    });

    const result = await reviseV3Plan({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: finalized.metadata.revision,
      plan: '# Plan\n\n1. Implement the V3 operation.\n',
      planDecision: 'governed_execution',
      operationId: id(73),
      now: NOW,
    });

    expect(result.metadata).toMatchObject({
      revision: 3,
      status: 'in_progress',
      currentStep: 5,
      governance: {
        planVersion: 2,
        planDecision: 'governed_execution',
        reviewStatus: 'stale',
        verificationStatus: 'stale',
      },
    });
    expect(result.review).toMatchObject({ revision: 3, status: 'stale' });
    expect(result.verification).toMatchObject({
      revision: 3,
      status: 'stale',
    });
    const persisted = await new V3ContextStore(root).readTaskSnapshot(
      created.taskRef,
    );
    expect(persisted.plan?.content).toBe(
      '# Plan\n\n1. Implement the V3 operation.\n',
    );
    expect(persisted.aggregate).toEqual(result.aggregate);
    expect(persisted.aggregateError).toBeNull();

    const reviewResult = await applyV3ReviewLedger({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: result.metadata.revision,
      review: currentReview(
        result.review,
        finalized.requirements.contentDigest,
        result.metadata.governance.planVersion,
      ),
      operationId: id(74),
      now: NOW,
    });
    expect(reviewResult.metadata).toMatchObject({
      revision: 4,
      governance: { reviewStatus: 'passed', verificationStatus: 'stale' },
    });
    expect(reviewResult.review).toMatchObject({
      revision: 4,
      status: 'passed',
    });
    expect(reviewResult.verification).toMatchObject({
      revision: 4,
      status: 'stale',
    });
    const reviewed = await new V3ContextStore(root).readTaskSnapshot(
      created.taskRef,
    );
    expect(reviewed.aggregate).toEqual(reviewResult.aggregate);
    expect(reviewed.aggregateError).toBeNull();

    const verificationResult = await recordV3Verification({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: reviewResult.metadata.revision,
      verification: currentVerification(
        reviewResult.verification,
        finalized.requirements,
        reviewResult.metadata.governance.planVersion,
        reviewResult.review.remediationRound,
      ),
      operationId: id(76),
      now: NOW,
    });
    expect(verificationResult.metadata).toMatchObject({
      revision: 5,
      governance: { verificationStatus: 'passed' },
    });
    expect(verificationResult.verification).toMatchObject({
      revision: 5,
      status: 'passed',
    });
    const verified = await new V3ContextStore(root).readTaskSnapshot(
      created.taskRef,
    );
    expect(verified.aggregate).toEqual(verificationResult.aggregate);
    expect(verified.aggregateError).toBeNull();

    const completed = await completeV3Task({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: verificationResult.metadata.revision,
      operationId: id(88),
      now: NOW,
    });
    expect(completed).toMatchObject({
      metadata: {
        revision: 7,
        status: 'completed',
        currentStep: 9,
        transitionState: 'stable',
        lastOperationId: id(88),
      },
      releasedClaims: [],
      operation: { type: 'task_complete', state: 'committed' },
    });
    const persistedCompletion = await new V3ContextStore(root).readTaskSnapshot(
      created.taskRef,
    );
    expect(persistedCompletion.aggregate).toEqual(completed.aggregate);
    expect(persistedCompletion.aggregateError).toBeNull();

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    await expect(readOperationJournal(home, id(88))).resolves.toMatchObject({
      type: 'task_complete',
      expectedRevisions: { [`task:local:${created.taskRef.taskId}`]: 5 },
    });
  });

  it('releases every active shared claim before committing a completed task and fence', async () => {
    const { sessionId } = await bootstrap(root, true, true);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Complete a shared task without leaving an active claim behind.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      implementationScope: { include: ['src/**'], modules: ['auth'] },
      taskId: id(90),
      operationId: id(91),
      now: NOW,
    });
    const finalized = await finalizeV3Requirements({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: 1,
      requirements: finalizedRequirements(
        created.requirements,
        created.taskRef,
      ),
      operationId: id(92),
      now: NOW,
    });
    const planned = await reviseV3Plan({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: finalized.metadata.revision,
      plan: '# Shared plan\n\n1. Complete the governed work.\n',
      planDecision: 'governed_execution',
      operationId: id(93),
      now: NOW,
    });
    const reviewed = await applyV3ReviewLedger({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: planned.metadata.revision,
      review: currentReview(
        planned.review,
        finalized.requirements.contentDigest,
        planned.metadata.governance.planVersion,
      ),
      operationId: id(94),
      now: NOW,
    });
    const verified = await recordV3Verification({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: reviewed.metadata.revision,
      verification: currentVerification(
        reviewed.verification,
        finalized.requirements,
        reviewed.metadata.governance.planVersion,
        reviewed.review.remediationRound,
      ),
      operationId: id(95),
      now: NOW,
    });
    const acquired = await acquireV3Claim({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: verified.metadata.revision,
      scope: {
        paths: ['src/auth/**'],
        modules: ['auth'],
        apis: [],
        schemas: [],
      },
      claimId: id(96),
      operationId: id(97),
      now: NOW,
    });

    const completed = await completeV3Task({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: verified.metadata.revision,
      operationId: id(98),
      now: NOW,
    });
    expect(completed).toMatchObject({
      metadata: {
        revision: 7,
        status: 'completed',
        currentStep: 9,
        transitionState: 'stable',
        lastOperationId: id(98),
      },
      releasedClaims: [
        {
          claimId: acquired.claim.claimId,
          state: 'released',
          revision: 2,
          lastOperationId: id(98),
        },
      ],
      taskHeadFence: {
        fenceRevision: 6,
        taskRevision: 7,
        lastOperationId: id(98),
      },
      operation: { type: 'task_complete', state: 'committed' },
    });

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    const coordination = await new V3ContextStore(
      root,
    ).readCoordinationSnapshot(created.taskRef, home);
    expect(coordination.claims).toMatchObject([
      { claimId: acquired.claim.claimId, state: 'released', revision: 2 },
    ]);
    expect(await readTaskHeadFence(home, created.taskRef)).toEqual(
      completed.taskHeadFence,
    );
    await expect(readOperationJournal(home, id(98))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:shared:${created.taskRef.taskId}`]: 5,
        [`claim:${acquired.claim.claimId}`]: 1,
        [`task_head:${created.taskRef.taskId}`]: 5,
      },
      entityLocks: expect.arrayContaining([
        `task:shared:${created.taskRef.taskId}`,
        `claim:${acquired.claim.claimId}`,
        `task_head:${created.taskRef.taskId}`,
      ]),
    });
  });

  it('creates an immutable checkpoint through pending metadata and settles the final aggregate', async () => {
    const { sessionId } = await bootstrap(root, false, false);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Record a local V3 checkpoint.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(80),
      operationId: id(81),
      now: NOW,
    });

    const result = await createV3Checkpoint({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: 1,
      kind: 'diagnostic_started',
      summary: 'Captured the current workflow state before diagnosis.',
      nextAction: 'Inspect the narrow diagnostic surface.',
      checkpointId: id(82),
      operationId: id(83),
      now: NOW,
    });

    expect(result.operation).toMatchObject({
      type: 'checkpoint_create',
      state: 'committed',
    });
    expect(result.metadata).toMatchObject({
      revision: 3,
      transitionState: 'stable',
      lastOperationId: id(83),
      latestCheckpointRef: {
        taskRef: created.taskRef,
        kind: 'checkpoint',
        artifactId: id(82),
      },
    });
    expect(result.checkpoint).toMatchObject({
      checkpointId: id(82),
      operationId: id(83),
      taskRevision: 2,
      taskRef: created.taskRef,
    });

    const persisted = await new V3ContextStore(root).readTaskSnapshot(
      created.taskRef,
    );
    expect(persisted.latestCheckpoint).toEqual(result.checkpoint);
    expect(persisted.aggregate).toEqual(result.aggregate);
    expect(persisted.aggregateError).toBeNull();

    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    await expect(readOperationJournal(home, id(83))).resolves.toMatchObject({
      expectedRevisions: {
        [`task:local:${created.taskRef.taskId}`]: 1,
        [`checkpoint:${id(82)}`]: 0,
      },
      entityLocks: expect.arrayContaining([`checkpoint:${id(82)}`]),
    });
  });

  it('advances the shared task-head fence after a checkpoint settles', async () => {
    const { sessionId } = await bootstrap(root, true, true);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Record a shared V3 checkpoint.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      taskId: id(84),
      operationId: id(85),
      now: NOW,
    });

    const result = await createV3Checkpoint({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: 1,
      kind: 'diagnostic_started',
      summary: 'Captured the shared state before a focused diagnostic.',
      checkpointId: id(86),
      operationId: id(87),
      now: NOW,
    });

    expect(result.taskHeadFence).toMatchObject({
      fenceRevision: 2,
      taskRevision: 3,
      lastOperationId: id(87),
    });
    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      created.taskRef,
    );
    expect(await readTaskHeadFence(home, created.taskRef)).toEqual(
      result.taskHeadFence,
    );
  });

  it('repairs or aborts an actual plan revision at every declared crash point', async () => {
    const fixtures = OPERATION_CRASH_FIXTURES.plan_revision;
    for (const [index, fixture] of fixtures.entries()) {
      const caseRoot = path.join(root, `plan-crash-${index}`);
      await mkdir(caseRoot);
      const { sessionId } = await bootstrap(caseRoot, false, false);
      const created = await createV3Workflow({
        projectRoot: caseRoot,
        task: 'Exercise a real plan revision crash boundary.',
        workflowMode: 'man',
        sessionId,
        client: 'vitest',
        taskId: id(10),
        operationId: id(11),
        now: NOW,
      });
      const finalized = await finalizeV3Requirements({
        projectRoot: caseRoot,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: created.metadata.revision,
        requirements: finalizedRequirements(
          created.requirements,
          created.taskRef,
        ),
        operationId: id(12),
        now: NOW,
      });
      const operationId = id(100 + index);

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          reviseV3Plan({
            projectRoot: caseRoot,
            taskRef: created.taskRef,
            sessionId,
            expectedTaskRevision: finalized.metadata.revision,
            plan: '# Recovered plan\n\n1. Finish the interrupted operation.\n',
            planDecision: 'governed_execution',
            operationId,
            now: NOW,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      const recovered = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId,
        actorId: id(4),
        sessionId,
        now: NOW,
      });
      if (fixture.expectedRecovery === 'safe_abort') {
        expect(recovered).toMatchObject({
          state: 'aborted',
          journal: { state: 'aborted' },
        });
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

function currentVerification(
  previous: VerificationLedgerV1,
  requirements: RequirementsLedgerV1,
  planVersion: number,
  remediationRound: number,
): VerificationLedgerV1 {
  const criterion = requirements.acceptanceCriteria[0];
  if (criterion === undefined) throw new Error('missing test criterion');
  const draft: VerificationLedgerV1 = {
    ...previous,
    revision: 99,
    status: 'passed',
    requirementsDigest: requirements.contentDigest,
    planVersion,
    remediationRound,
    checks: [
      {
        displayId: criterion.displayId,
        legacyId: criterion.legacyId,
        checkId: id(77),
        criterionId: criterion.criterionId,
        required: criterion.required,
        verificationRequirement: criterion.verificationRequirement,
        automated: {
          evidenceId: id(78),
          status: 'passed',
          summary: 'The deterministic verification command passed.',
          command: 'npm test',
          exitCode: 0,
          artifactRef: null,
          confirmedByActorId: null,
          confirmationSource: null,
          updatedAt: NOW.toISOString(),
        },
        manual: null,
      },
    ],
    contentDigest: '',
    lastOperationId: id(79),
    updatedAt: NOW.toISOString(),
  };
  return parseVerificationLedger(
    { ...draft, contentDigest: verificationLedgerDigest(draft) },
    requirements,
  );
}

function currentReview(
  previous: ReviewLedgerV1,
  requirementsDigest: string,
  planVersion: number,
): ReviewLedgerV1 {
  const draft: ReviewLedgerV1 = {
    ...previous,
    revision: 99,
    status: 'passed',
    requirementsDigest,
    planVersion,
    requiredDomains: ['quality'],
    domains: [{ domain: 'quality', status: 'passed', reportRef: null }],
    blockers: [],
    remediationRound: 0,
    skip: null,
    contentDigest: '',
    lastOperationId: id(75),
    updatedAt: NOW.toISOString(),
  };
  return parseReviewLedger({
    ...draft,
    contentDigest: reviewLedgerDigest(draft),
  });
}

function finalizedRequirements(
  previous: RequirementsLedgerV1,
  taskRef: RequirementsLedgerV1['taskRef'],
): RequirementsLedgerV1 {
  const requirementId = id(60);
  const draft: RequirementsLedgerV1 = {
    ...previous,
    taskRef,
    revision: 99,
    status: 'confirmed',
    goal: 'Make V3 requirements finalization durable and reviewable.',
    functionalScope: {
      inScope: ['V3 workflow requirements finalization'],
      outOfScope: ['Legacy workflow mutation'],
    },
    technicalDecisions: [],
    defaults: [],
    coverage: REQUIREMENT_DIMENSIONS.map((dimension, index) => ({
      coverageId: id(30 + index),
      dimension,
      status: dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
      rationale: `Confirmed ${dimension} coverage.`,
    })),
    requirements: [
      {
        displayId: 'REQ-1',
        legacyId: null,
        requirementId,
        statement: 'A finalization operation writes one consistent V3 tuple.',
        priority: 'must',
      },
    ],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: null,
        criterionId: id(61),
        requirementIds: [requirementId],
        statement: 'The committed aggregate references the finalized ledger.',
        required: true,
        verificationRequirement: 'automated',
      },
    ],
    blockingUnknowns: [],
    contentDigest: '',
    lastOperationId: id(62),
    updatedAt: NOW.toISOString(),
  };
  return parseRequirementsLedger({
    ...draft,
    contentDigest: requirementsLedgerDigest(draft),
  });
}

async function bootstrap(
  projectRoot: string,
  withGit: boolean,
  joined: boolean,
): Promise<{ actorId: Ulid; sessionId: Ulid }> {
  if (withGit) {
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
    displayName: 'Vitest User',
    now: NOW,
  });
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  if (joined) {
    const actor = await readLocalActor(projectRoot);
    if (actor === null) throw new Error('missing test actor');
    await publishSharedActorProfile(
      projectRoot,
      createSharedActorProfile(actor, NOW),
    );
  }
  return { actorId, sessionId };
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

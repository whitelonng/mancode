import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { reviseV3Plan } from '../src/context/plan-revision.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import {
  REQUIREMENT_DIMENSIONS,
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
import {
  completeV3SoloHandoff,
  startV3SoloHandoff,
} from '../src/context/solo-handoff.js';
import { V3ContextStore } from '../src/context/store.js';
import { taskRootPath } from '../src/context/task-locator.js';
import {
  type VerificationLedgerV1,
  parseVerificationLedger,
  verificationLedgerDigest,
} from '../src/context/verification-ledger.js';
import { recordV3Verification } from '../src/context/verification-record.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { parseWorkflowMetadata } from '../src/context/workflow-metadata.js';
import { createSession, readSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';

const NOW = new Date('2026-07-17T20:00:00.000Z');

describe('V3 solo handoff', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-solo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records an authoritative solo assignment, then completes through its dedicated completion gate', async () => {
    const { sessionId } = await bootstrap(root);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Execute the verified single-owner implementation plan.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });
    const finalized = await finalizeV3Requirements({
      projectRoot: root,
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
    const planned = await reviseV3Plan({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: finalized.metadata.revision,
      plan: '# Plan\n\n1. Implement and verify the change.\n',
      implementationScope: {
        include: ['src/**', 'tests/**'],
        exclude: [],
        modules: [],
      },
      operationId: id(13),
      now: NOW,
    });
    const started = await startV3SoloHandoff({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: planned.metadata.revision,
      operationId: id(16),
      now: NOW,
    });
    expect(started).toMatchObject({
      metadata: {
        status: 'planned',
        revision: 4,
        governance: { planDecision: 'solo_handoff' },
        soloExecution: {
          state: 'active',
          assignedSessionId: sessionId,
        },
      },
      operation: { type: 'solo_handoff', state: 'committed' },
      sessionPointerUpdated: true,
    });
    expect((await readSession(root, sessionId))?.activeTaskRef).toEqual(
      created.taskRef,
    );

    await expect(
      completeV3SoloHandoff({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: started.metadata.revision,
        now: NOW,
      }),
    ).rejects.toThrow('review');
    const verified = await recordHandoffEvidence(
      root,
      created.taskRef,
      sessionId,
    );

    const completed = await completeV3SoloHandoff({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: verified.metadata.revision,
      operationId: id(17),
      now: NOW,
    });
    expect(completed).toMatchObject({
      metadata: {
        status: 'completed',
        currentStep: 9,
        revision: 7,
        governance: { reviewStatus: 'passed', verificationStatus: 'passed' },
        soloExecution: { state: 'completed' },
      },
      operation: { type: 'solo_handoff', state: 'committed' },
      sessionPointerUpdated: true,
    });
    expect((await readSession(root, sessionId))?.activeTaskRef).toBeNull();
  });

  it('refuses a shared or unplanned task before it can create a solo assignment', async () => {
    const { sessionId } = await bootstrap(root);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Do not permit an unplanned solo assignment.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(20),
      operationId: id(21),
      now: NOW,
    });
    await expect(
      startV3SoloHandoff({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: created.metadata.revision,
        operationId: id(22),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_SOLO_HANDOFF_NOT_ELIGIBLE');
  });

  it('refuses to hand an unbounded plan to solo execution', async () => {
    const { sessionId } = await bootstrap(root);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Do not execute a plan without an implementation boundary.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(30),
      operationId: id(31),
      now: NOW,
    });
    const finalized = await finalizeV3Requirements({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: created.metadata.revision,
      requirements: finalizedRequirements(
        created.requirements,
        created.taskRef,
      ),
      operationId: id(32),
      now: NOW,
    });
    const planned = await reviseV3Plan({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: finalized.metadata.revision,
      plan: '# Plan\n\n1. Implement the requested change.\n',
      operationId: id(33),
      now: NOW,
    });

    await expect(
      startV3SoloHandoff({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: planned.metadata.revision,
        operationId: id(34),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_IMPLEMENTATION_SCOPE_REQUIRED');
  });

  it('rebinds a missing scope for an active legacy solo assignment before completion', async () => {
    const { sessionId } = await bootstrap(root);
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Restore the missing scope of an active solo assignment.',
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
      expectedTaskRevision: created.metadata.revision,
      requirements: finalizedRequirements(
        created.requirements,
        created.taskRef,
      ),
      operationId: id(72),
      now: NOW,
    });
    const plan = '# Plan\n\n1. Implement the confirmed solo change.\n';
    const planned = await reviseV3Plan({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: finalized.metadata.revision,
      plan,
      implementationScope: {
        include: ['src/**', 'tests/**'],
        exclude: [],
        modules: [],
      },
      operationId: id(73),
      now: NOW,
    });
    const started = await startV3SoloHandoff({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: planned.metadata.revision,
      operationId: id(74),
      now: NOW,
    });
    const unspecified = {
      source: 'legacy_unspecified' as const,
      include: [],
      exclude: [],
      modules: [],
    };
    const legacyActive = parseWorkflowMetadata({
      ...started.metadata,
      implementationScope: {
        ...unspecified,
        digest: digestCanonicalJson(unspecified),
      },
    });
    await writeFile(
      path.join(taskRootPath(root, created.taskRef), 'metadata.json'),
      `${JSON.stringify(legacyActive, null, 2)}\n`,
    );

    await expect(
      completeV3SoloHandoff({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: legacyActive.revision,
        operationId: id(75),
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_IMPLEMENTATION_SCOPE_REQUIRED');

    const bound = await reviseV3Plan({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: legacyActive.revision,
      plan,
      implementationScope: {
        include: ['src/**', 'tests/**'],
        exclude: ['src/generated/**'],
        modules: [],
      },
      operationId: id(76),
      now: NOW,
    });
    expect(bound.metadata).toMatchObject({
      status: 'planned',
      currentStep: 4,
      governance: {
        planDecision: 'solo_handoff',
        planVersion: planned.metadata.governance.planVersion + 1,
        reviewStatus: 'stale',
        verificationStatus: 'stale',
      },
      soloExecution: {
        state: 'active',
        planVersion: planned.metadata.governance.planVersion + 1,
        assignedSessionId: sessionId,
      },
    });

    await expect(
      completeV3SoloHandoff({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId,
        expectedTaskRevision: bound.metadata.revision,
        now: NOW,
      }),
    ).rejects.toThrow('review');
    const verified = await recordHandoffEvidence(
      root,
      created.taskRef,
      sessionId,
    );
    const completed = await completeV3SoloHandoff({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: verified.metadata.revision,
      operationId: id(77),
      now: NOW,
    });
    expect(completed.metadata).toMatchObject({
      status: 'completed',
      currentStep: 9,
      soloExecution: {
        state: 'completed',
        planVersion: bound.metadata.governance.planVersion,
      },
    });
  });
});

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
    goal: 'Make the solo assignment testable and reviewable.',
    functionalScope: { inScope: ['V3 solo handoff'], outOfScope: [] },
    technicalDecisions: [],
    defaults: [],
    coverage: REQUIREMENT_DIMENSIONS.map((dimension, index) => ({
      coverageId: id(30 + index),
      dimension,
      status: dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
      rationale: `Confirmed ${dimension}.`,
    })),
    requirements: [
      {
        displayId: 'REQ-1',
        legacyId: null,
        requirementId,
        statement: 'A local solo assignment must remain journaled.',
        priority: 'must',
      },
    ],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: null,
        criterionId: id(61),
        requirementIds: [requirementId],
        statement: 'Completion requires passing recorded verification.',
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
    displayName: 'Solo Owner',
    now: NOW,
  });
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

async function recordHandoffEvidence(
  root: string,
  taskRef: RequirementsLedgerV1['taskRef'],
  sessionId: Ulid,
) {
  const store = new V3ContextStore(root);
  const before = await store.readTaskSnapshot(taskRef);
  if (before.metadata.ownerActorId === null) throw new Error('Missing owner');
  const other = await createSession(root, {
    actorId: before.metadata.ownerActorId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  const submittedReview = currentReview(
    before.review,
    before.requirements.contentDigest,
    before.metadata.governance.planVersion,
  );
  const submittedVerification = currentVerification(
    before.verification,
    before.requirements,
    before.metadata.governance.planVersion,
    before.review.remediationRound,
  );
  await expect(
    applyV3ReviewLedger({
      projectRoot: root,
      taskRef,
      sessionId: other.sessionId,
      expectedTaskRevision: before.metadata.revision,
      review: submittedReview,
      now: NOW,
    }),
  ).rejects.toThrow('SOLO_HANDOFF_NOT_ACTIVE');
  await expect(
    recordV3Verification({
      projectRoot: root,
      taskRef,
      sessionId: other.sessionId,
      expectedTaskRevision: before.metadata.revision,
      verification: submittedVerification,
      now: NOW,
    }),
  ).rejects.toThrow('SOLO_HANDOFF_NOT_ACTIVE');
  expect((await store.readTaskSnapshot(taskRef)).metadata).toEqual(
    before.metadata,
  );
  const review = await applyV3ReviewLedger({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: before.metadata.revision,
    review: currentReview(
      before.review,
      before.requirements.contentDigest,
      before.metadata.governance.planVersion,
    ),
    now: NOW,
  });
  await expect(
    completeV3SoloHandoff({
      projectRoot: root,
      taskRef,
      sessionId,
      expectedTaskRevision: review.metadata.revision,
      now: NOW,
    }),
  ).rejects.toThrow('verification ledger');
  const verified = await recordV3Verification({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: review.metadata.revision,
    verification: currentVerification(
      review.verification,
      before.requirements,
      before.metadata.governance.planVersion,
      review.review.remediationRound,
    ),
    now: NOW,
  });
  expect(verified.metadata.governance.planDecision).toBe('solo_handoff');
  expect(verified.metadata.soloExecution).toEqual(
    before.metadata.soloExecution,
  );
  expect(verified.metadata.implementationScope).toEqual(
    before.metadata.implementationScope,
  );
  expect(verified.metadata.governance.policyVersions).toEqual(
    before.metadata.governance.policyVersions,
  );
  expect((await store.readTaskSnapshot(taskRef)).plan).toEqual(before.plan);
  return verified;
}

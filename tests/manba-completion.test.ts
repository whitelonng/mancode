import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { assertTaskCompletionGate } from '../src/context/aggregate.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import {
  REQUIREMENT_DIMENSIONS,
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from '../src/context/requirements-ledger.js';
import { V3ContextStore } from '../src/context/store.js';
import { completeV3Task } from '../src/context/task-complete.js';
import {
  type VerificationComponentStatus,
  type VerificationLedgerV1,
  deriveVerificationLedgerStatus,
  parseVerificationLedger,
  verificationLedgerDigest,
} from '../src/context/verification-ledger.js';
import { recordV3Verification } from '../src/context/verification-record.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import {
  closeSession,
  createSession,
  readSession,
} from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';
const NOW = new Date('2026-07-17T10:00:00.000Z');

describe('manba diagnostic completion through public operations', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-manba-complete-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['fixed', 'verified', 'no_repro'] as const)(
    'completes %s with current required evidence and no fabricated plan or review',
    async (outcome) => {
      const fixture = await prepare(root);
      const recorded = await record(root, fixture, 'passed');
      const completed = await completeV3Task({
        ...fixture.input,
        expectedTaskRevision: recorded.metadata.revision,
        outcome,
      });
      expect(completed.metadata).toMatchObject({
        status: 'completed',
        currentStep: 5,
        outcome,
        governance: {
          planDecision: null,
          reviewStatus: 'stale',
          verificationStatus: 'passed',
        },
      });
      expect(completed.operation).toMatchObject({
        type: 'task_complete',
        state: 'committed',
        expectedRevisions: {
          [`task:local:${fixture.created.taskRef.taskId}`]:
            recorded.metadata.revision,
        },
      });
      const readback = await new V3ContextStore(root).readTaskSnapshot(
        fixture.created.taskRef,
      );
      expect(readback.plan).toBeNull();
      expect(readback.aggregateError).toBeNull();
      expect(readback.metadata).toEqual(completed.metadata);
      expect(await readSession(root, fixture.input.sessionId)).toMatchObject({
        activeTaskRef: null,
      });
    },
  );

  it('preserves manual-required evidence instead of claiming verified success', async () => {
    const fixture = await prepare(root, 'manual');
    const recorded = await record(root, fixture, 'manual_required');
    await expect(
      completeV3Task({
        ...fixture.input,
        expectedTaskRevision: recorded.metadata.revision,
        outcome: 'verified',
      }),
    ).rejects.toThrow('current required acceptance evidence');
    const completed = await completeV3Task({
      ...fixture.input,
      expectedTaskRevision: recorded.metadata.revision,
      outcome: 'manual_test_required',
    });
    expect(completed.metadata).toMatchObject({
      status: 'completed',
      outcome: 'manual_test_required',
      governance: { verificationStatus: 'manual_required' },
    });
  });

  it.each(['pending', 'failed', 'blocked'] as const)(
    'rejects %s verification for every success outcome',
    async (status) => {
      const fixture = await prepare(root);
      const recorded = await record(root, fixture, status);
      for (const outcome of ['fixed', 'verified', 'no_repro'] as const) {
        await expect(
          completeV3Task({
            ...fixture.input,
            expectedTaskRevision: recorded.metadata.revision,
            outcome,
          }),
        ).rejects.toThrow('current required acceptance evidence');
      }
    },
  );

  it('rejects missing requirements, stale evidence, stale revision, and missing typed outcome', async () => {
    const fixture = await prepare(root);
    await expect(
      completeV3Task({
        ...fixture.input,
        expectedTaskRevision: fixture.finalized.metadata.revision,
        outcome: 'verified',
      }),
    ).rejects.toThrow();
    const recorded = await record(root, fixture, 'passed');
    await expect(
      completeV3Task({
        ...fixture.input,
        expectedTaskRevision: 1,
        outcome: 'verified',
      }),
    ).rejects.toThrow('REVISION');
    await expect(
      completeV3Task({
        ...fixture.input,
        expectedTaskRevision: recorded.metadata.revision,
      }),
    ).rejects.toThrow('MANCODE_MANBA_OUTCOME_REQUIRED');
    await expect(
      completeV3Task({
        ...fixture.input,
        expectedTaskRevision: recorded.metadata.revision,
        outcome: 'manual_test_required',
      }),
    ).rejects.toThrow('manual-required');
    const changed = finalizedRequirements(
      fixture.finalized.requirements,
      fixture.created.taskRef,
    );
    changed.goal = 'Diagnose the revised regression environment.';
    changed.contentDigest = requirementsLedgerDigest(changed);
    const revised = await finalizeV3Requirements({
      ...fixture.input,
      expectedTaskRevision: recorded.metadata.revision,
      requirements: changed,
    });
    await expect(
      completeV3Task({
        ...fixture.input,
        expectedTaskRevision: revised.metadata.revision,
        outcome: 'verified',
      }),
    ).rejects.toThrow();
  });

  it('requires the owner and an active session even after verification passes', async () => {
    const fixture = await prepare(root);
    const recorded = await record(root, fixture, 'passed');
    const other = await createSession(root, {
      actorId: id(151),
      client: 'vitest',
      identitySource: 'explicit',
      now: NOW,
    });
    const completion = {
      ...fixture.input,
      expectedTaskRevision: recorded.metadata.revision,
      outcome: 'verified' as const,
    };
    await expect(
      completeV3Task({ ...completion, sessionId: other.sessionId }),
    ).rejects.toThrow();
    await closeSession(root, fixture.input.sessionId, NOW);
    await expect(completeV3Task(completion)).rejects.toThrow(
      'MANCODE_SESSION_NOT_FOUND',
    );
    const persisted = await new V3ContextStore(root).readTaskSnapshot(
      fixture.created.taskRef,
    );
    expect(persisted.metadata.status).toBe('in_progress');
    expect(persisted.metadata.revision).toBe(recorded.metadata.revision);
  });

  it('does not let a manual-required aggregate mask a failed or pending hybrid component', async () => {
    const fixture = await prepare(root, 'hybrid');
    for (const status of ['failed', 'pending'] as const) {
      const recorded = await record(root, fixture, status, 'manual_required');
      fixture.finalized.metadata = recorded.metadata;
      fixture.finalized.verification = recorded.verification;
      expect(recorded.verification.status).toBe('manual_required');
      await expect(
        completeV3Task({
          ...fixture.input,
          expectedTaskRevision: recorded.metadata.revision,
          outcome: 'manual_test_required',
        }),
      ).rejects.toThrow('unresolved verification');
    }
  });

  it('retains active-child, repair and claim-context validation', async () => {
    const fixture = await prepare(root);
    await record(root, fixture, 'passed');
    const snapshot = await new V3ContextStore(root).readTaskSnapshot(
      fixture.created.taskRef,
    );
    const aggregate = { ...snapshot, planDigest: null };
    const context = {
      activeChildTaskRefs: [],
      hasPendingRepairOperation: false,
      activeClaimCount: 0,
      diagnosticOutcome: 'verified' as const,
    };
    expect(() =>
      assertTaskCompletionGate(aggregate, {
        ...context,
        activeChildTaskRefs: [{ namespace: 'local', taskId: id(150) }],
      }),
    ).toThrow('active child');
    expect(() =>
      assertTaskCompletionGate(aggregate, {
        ...context,
        hasPendingRepairOperation: true,
      }),
    ).toThrow('pending repair');
    expect(() =>
      assertTaskCompletionGate(aggregate, { ...context, activeClaimCount: -1 }),
    ).toThrow('activeClaimCount');
  });
});

async function prepare(
  root: string,
  requirement: 'automated' | 'manual' | 'hybrid' = 'automated',
) {
  await initializeV3Project({ projectRoot: root, now: NOW });
  const actor = await createLocalActor(root, {
    displayName: 'Diagnostic owner',
    now: NOW,
  });
  const session = await createSession(root, {
    actorId: actor.actorId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  const created = await createV3Workflow({
    projectRoot: root,
    workflowMode: 'manba',
    task: 'Diagnose the reported regression.',
    sessionId: session.sessionId,
    client: 'vitest',
    now: NOW,
  });
  const input = {
    projectRoot: root,
    taskRef: created.taskRef,
    sessionId: session.sessionId,
    now: NOW,
  };
  await expect(
    completeV3Task({
      ...input,
      expectedTaskRevision: created.metadata.revision,
      outcome: 'verified',
    }),
  ).rejects.toThrow();
  const requirements = finalizedRequirements(
    created.requirements,
    created.taskRef,
  );
  const criterion = requirements.acceptanceCriteria[0];
  if (!criterion) throw new Error('missing fixture criterion');
  criterion.verificationRequirement = requirement;
  requirements.contentDigest = requirementsLedgerDigest(requirements);
  const finalized = await finalizeV3Requirements({
    ...input,
    expectedTaskRevision: created.metadata.revision,
    requirements,
  });
  return { created, input, finalized };
}

async function record(
  root: string,
  fixture: Awaited<ReturnType<typeof prepare>>,
  status: VerificationComponentStatus,
  manualStatus?: VerificationComponentStatus,
) {
  const previous = fixture.finalized.verification;
  const requirements = fixture.finalized.requirements;
  const criterion = requirements.acceptanceCriteria[0];
  if (!criterion) throw new Error('missing fixture criterion');
  const evidence = (value: VerificationComponentStatus) => ({
    evidenceId: createUlid(),
    status: value,
    summary:
      value === 'manual_required'
        ? 'Device unavailable; run the documented regression on the target device.'
        : 'Diagnostic contract fixture result.',
    command: value === 'passed' ? 'fixture diagnostic assertion' : null,
    exitCode: value === 'passed' ? 0 : null,
    artifactRef: null,
    confirmedByActorId: null,
    confirmationSource: null,
    updatedAt: NOW.toISOString(),
  });
  const draft: VerificationLedgerV1 = {
    ...previous,
    requirementsDigest: requirements.contentDigest,
    planVersion: fixture.finalized.metadata.governance.planVersion,
    remediationRound: fixture.finalized.review.remediationRound,
    checks: [
      {
        checkId: id(100),
        displayId: criterion.displayId,
        legacyId: null,
        criterionId: criterion.criterionId,
        required: true,
        verificationRequirement: criterion.verificationRequirement,
        automated:
          criterion.verificationRequirement === 'manual'
            ? null
            : evidence(status),
        manual:
          criterion.verificationRequirement === 'automated'
            ? null
            : evidence(manualStatus ?? status),
      },
    ],
  };
  draft.status = deriveVerificationLedgerStatus(draft);
  draft.contentDigest = verificationLedgerDigest(draft);
  return recordV3Verification({
    ...fixture.input,
    projectRoot: root,
    expectedTaskRevision: fixture.finalized.metadata.revision,
    verification: parseVerificationLedger(draft, requirements),
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
    goal: 'Diagnose the reported regression in the specified environment.',
    functionalScope: {
      inScope: ['Regression diagnosis'],
      outOfScope: ['Unrelated implementation'],
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
        statement: 'The diagnosis identifies the observed regression outcome.',
        priority: 'must',
      },
    ],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: null,
        criterionId: id(61),
        requirementIds: [requirementId],
        statement:
          'The regression path is exercised and its actual result recorded.',
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

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

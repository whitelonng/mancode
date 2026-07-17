import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
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
  completeV3SoloHandoff,
  startV3SoloHandoff,
} from '../src/context/solo-handoff.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
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

    const completed = await completeV3SoloHandoff({
      projectRoot: root,
      taskRef: created.taskRef,
      sessionId,
      expectedTaskRevision: started.metadata.revision,
      operationId: id(17),
      now: NOW,
    });
    expect(completed).toMatchObject({
      metadata: {
        status: 'completed',
        currentStep: 9,
        revision: 5,
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

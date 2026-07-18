import { type Ulid, createUlid } from '../../src/context/ids.js';
import { reviseV3Plan } from '../../src/context/plan-revision.js';
import { finalizeV3Requirements } from '../../src/context/requirements-finalize.js';
import {
  REQUIREMENT_DIMENSIONS,
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from '../../src/context/requirements-ledger.js';
import type { TaskRef } from '../../src/context/task-ref.js';

/** A complete human-readable plan used by collaboration fixtures. */
export const CONFIRMED_MANTEAM_PLAN = `# Ownership lanes
The task owner coordinates the auth lane; participants only work in their declared lane.

## Scope
Paths, modules, public APIs, and schema boundaries are listed in the task implementation scope.

## Claims
Claim acquisition is required before implementation and overlap is resolved before writing.

## Dependencies and integration
Dependencies are integrated in owner-approved order and integration points are rechecked.

## Compatibility
Compatibility impact is reviewed before a public API or schema changes.

## Verification
The owner assigns verification responsibility and records the result in the ledger.

## Handoff
Handoff requires a checkpoint, a named recipient, and an explicit acceptance.

## Capabilities
Current claim acquisition, write guard, and transport capabilities are checked before work.`;

/**
 * Drives a created manteam task through its required requirements and plan
 * gates. Tests can then exercise claims, scope changes, and handoffs without
 * encoding an invalid shortcut around the product workflow.
 */
export async function confirmManteamPlan(input: {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  requirements: RequirementsLedgerV1;
  now: Date;
}): Promise<{ taskRevision: number }> {
  const finalized = await finalizeV3Requirements({
    projectRoot: input.projectRoot,
    taskRef: input.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: 1,
    requirements: confirmedRequirements(
      input.requirements,
      input.taskRef,
      input.now,
    ),
    operationId: createUlid(),
    now: input.now,
  });
  const planned = await reviseV3Plan({
    projectRoot: input.projectRoot,
    taskRef: input.taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: finalized.metadata.revision,
    plan: CONFIRMED_MANTEAM_PLAN,
    planDecision: 'governed_execution',
    operationId: createUlid(),
    now: input.now,
  });
  return { taskRevision: planned.metadata.revision };
}

function confirmedRequirements(
  previous: RequirementsLedgerV1,
  taskRef: TaskRef,
  now: Date,
): RequirementsLedgerV1 {
  const requirementId = createUlid();
  const draft: RequirementsLedgerV1 = {
    ...previous,
    taskRef,
    revision: 99,
    status: 'confirmed',
    goal: 'Execute the shared manteam workflow through its governed gates.',
    functionalScope: {
      inScope: ['Shared implementation coordination'],
      outOfScope: ['Legacy workflow mutation'],
    },
    technicalDecisions: [],
    defaults: [],
    coverage: REQUIREMENT_DIMENSIONS.map((dimension) => ({
      coverageId: createUlid(),
      dimension,
      status: dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
      rationale: `Confirmed ${dimension} coverage.`,
    })),
    requirements: [
      {
        displayId: 'REQ-1',
        legacyId: null,
        requirementId,
        statement: 'The team records a confirmed scope and coordination plan.',
        priority: 'must',
      },
    ],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: null,
        criterionId: createUlid(),
        requirementIds: [requirementId],
        statement:
          'Claims are made only after the coordinated plan is confirmed.',
        required: true,
        verificationRequirement: 'automated',
      },
    ],
    blockingUnknowns: [],
    contentDigest: '',
    lastOperationId: createUlid(),
    updatedAt: now.toISOString(),
  };
  return parseRequirementsLedger({
    ...draft,
    contentDigest: requirementsLedgerDigest(draft),
  });
}

import { describe, expect, it } from 'vitest';
import {
  type TaskAggregateInput,
  assertTaskAggregateConsistency,
  assertTaskCompletionGate,
  buildTaskAggregateManifest,
  parseTaskAggregateManifest,
  taskAggregateDigest,
} from '../src/context/aggregate.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  type RequirementsLedgerV1,
  requirementsLedgerDigest,
} from '../src/context/requirements-ledger.js';
import {
  type ReviewLedgerV1,
  reviewLedgerDigest,
} from '../src/context/review-ledger.js';
import {
  type VerificationLedgerV1,
  verificationLedgerDigest,
} from '../src/context/verification-ledger.js';
import type { WorkflowMetadataV3 } from '../src/context/workflow-metadata.js';

const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const DECISION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const REQUIREMENT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const CRITERION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const CHECK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7P';
const EVIDENCE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7Q';
const REPORT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7R';
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;

describe('task aggregate V3 contract', () => {
  it('builds a typed aggregate manifest only when metadata caches match ledgers', () => {
    const input = aggregate();
    const manifest = buildTaskAggregateManifest(input);
    expect(parseTaskAggregateManifest(manifest)).toEqual(manifest);
    expect(taskAggregateDigest(manifest)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.requirementsDigest).toBe(input.requirements.contentDigest);

    expect(() =>
      assertTaskAggregateConsistency({
        ...input,
        metadata: {
          ...input.metadata,
          governance: {
            ...input.metadata.governance,
            requirementsDigest: `sha256:${'0'.repeat(64)}`,
          },
        },
      }),
    ).toThrow(/requirementsDigest must match/);
  });

  it('requires the entire aggregate and completion context to be ready', () => {
    const input = aggregate();
    expect(() =>
      assertTaskCompletionGate(input, {
        activeChildTaskRefs: [],
        hasPendingRepairOperation: false,
        activeClaimCount: 1,
        claimsWillReleaseOrTransfer: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertTaskCompletionGate(input, {
        activeChildTaskRefs: [
          { namespace: 'shared', taskId: '01JZ4B6W5Z0A1B2C3D4E5F6G7S' },
        ],
        hasPendingRepairOperation: false,
        activeClaimCount: 0,
      }),
    ).toThrow(/no active child workflows/);
    expect(() =>
      assertTaskCompletionGate(input, {
        activeChildTaskRefs: [],
        hasPendingRepairOperation: false,
        activeClaimCount: 1,
      }),
    ).toThrow(/release or transfer/);
  });
});

function aggregate(): TaskAggregateInput {
  const requirements = requirementsLedger();
  const review = reviewLedger(requirements.contentDigest);
  const verification = verificationLedger(requirements.contentDigest);
  return {
    metadata: metadata(requirements, review, verification),
    requirements,
    review,
    verification,
    planDigest: PLAN_DIGEST,
    latestCheckpoint: null,
  };
}

function requirementsLedger(): RequirementsLedgerV1 {
  const draft: RequirementsLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    revision: 2,
    status: 'confirmed',
    goal: 'Rate-limit repeated login failures.',
    functionalScope: {
      inScope: ['Protect the login endpoint.'],
      outOfScope: ['Change account recovery.'],
    },
    technicalDecisions: [
      {
        displayId: 'TD-1',
        legacyId: null,
        decisionId: DECISION_ID,
        statement: 'Use the existing Redis client.',
      },
    ],
    defaults: [],
    coverage: [
      'platform',
      'core_scope',
      'technical_stack',
      'data_and_persistence',
      'performance',
      'compatibility',
      'security',
    ].map((dimension, index) => ({
      coverageId: coverageId(index),
      dimension:
        dimension as RequirementsLedgerV1['coverage'][number]['dimension'],
      status: 'confirmed' as const,
      rationale: `${dimension} is covered.`,
    })),
    requirements: [
      {
        displayId: 'R-1',
        legacyId: 'REQ-1',
        requirementId: REQUIREMENT_ID,
        statement: 'Throttle repeated failed login attempts.',
        priority: 'must',
      },
    ],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: 'AC-1',
        criterionId: CRITERION_ID,
        requirementIds: [REQUIREMENT_ID],
        statement:
          'Repeated failed login attempts receive a rate-limit response.',
        required: true,
        verificationRequirement: 'automated',
      },
    ],
    blockingUnknowns: [],
    legacySource: null,
    contentDigest: '',
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
  return { ...draft, contentDigest: requirementsLedgerDigest(draft) };
}

function reviewLedger(requirementsDigest: string): ReviewLedgerV1 {
  const draft: ReviewLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    revision: 1,
    status: 'passed',
    depth: 'targeted',
    requirementsDigest,
    planVersion: 2,
    requiredDomains: ['quality'],
    domains: [
      {
        domain: 'quality',
        status: 'passed',
        reportRef: {
          taskRef: { namespace: 'shared', taskId: TASK_ID },
          kind: 'review_report',
          artifactId: REPORT_ID,
        },
      },
    ],
    blockers: [],
    remediationRound: 0,
    skip: null,
    legacySource: null,
    contentDigest: '',
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
  return { ...draft, contentDigest: reviewLedgerDigest(draft) };
}

function verificationLedger(requirementsDigest: string): VerificationLedgerV1 {
  const draft: VerificationLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    revision: 1,
    status: 'passed',
    requirementsDigest,
    planVersion: 2,
    remediationRound: 0,
    checks: [
      {
        displayId: 'AC-1',
        legacyId: 'AC-1',
        checkId: CHECK_ID,
        criterionId: CRITERION_ID,
        required: true,
        verificationRequirement: 'automated',
        automated: {
          evidenceId: EVIDENCE_ID,
          status: 'passed',
          summary: 'The automated login test passed.',
          command: 'npm test',
          exitCode: 0,
          artifactRef: null,
          confirmedByActorId: null,
          confirmationSource: null,
          updatedAt: '2026-07-17T10:00:00.000Z',
        },
        manual: null,
      },
    ],
    legacySource: null,
    contentDigest: '',
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
  return { ...draft, contentDigest: verificationLedgerDigest(draft) };
}

function metadata(
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
  verification: VerificationLedgerV1,
): WorkflowMetadataV3 {
  const scope = {
    source: 'explicit' as const,
    include: ['src/auth/**'],
    exclude: [],
    modules: ['auth-api'],
  };
  return {
    schemaVersion: 3,
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    displaySlug: 'login-rate-limit',
    task: 'Add login rate limits.',
    workflowMode: 'manteam',
    visibility: 'shared',
    coordination: 'team',
    status: 'in_progress',
    currentStep: 9,
    skippedSteps: [],
    blockingReason: null,
    outcome: null,
    revision: 7,
    transitionState: 'stable',
    lastOperationId: null,
    ownerActorId: ACTOR_ID,
    ownershipEpoch: 3,
    participants: [ACTOR_ID],
    createdBy: { actorId: ACTOR_ID, client: 'codex', source: 'actor' },
    base: { branch: 'feature/login', head: 'abc1234', upstream: null },
    implementationScope: {
      ...scope,
      digest: digestCanonicalJson(scope),
    },
    governance: {
      requirementsStatus: 'ready',
      requirementsDigest: requirements.contentDigest,
      planVersion: 2,
      planDecision: 'governed_execution',
      policyVersions: { planning: 2, review: 1, verification: 1 },
      reviewStatus: review.status,
      reviewLedgerDigest: review.contentDigest,
      verificationStatus: verification.status,
      verificationLedgerDigest: verification.contentDigest,
    },
    soloExecution: null,
    latestCheckpointRef: null,
    parent: null,
    successorTaskRef: null,
    legacyCompatibility: null,
    startedAt: '2026-07-17T09:30:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function coverageId(index: number): string {
  const ids = [
    '01JZ4B6W5Z0A1B2C3D4E5F6G7S',
    '01JZ4B6W5Z0A1B2C3D4E5F6G7T',
    '01JZ4B6W5Z0A1B2C3D4E5F6G7V',
    '01JZ4B6W5Z0A1B2C3D4E5F6G7W',
    '01JZ4B6W5Z0A1B2C3D4E5F6G7X',
    '01JZ4B6W5Z0A1B2C3D4E5F6G7Y',
    '01JZ4B6W5Z0A1B2C3D4E5F6G7Z',
  ];
  const id = ids[index];
  if (id === undefined) throw new Error(`missing coverage id at ${index}`);
  return id;
}

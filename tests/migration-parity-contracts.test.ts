import { describe, expect, it } from 'vitest';
import type { MancodeState } from '../src/commands/init.js';
import {
  type LegacyTaskMigrationInput,
  assertMigrationParity,
  createDeterministicMigrationIdAllocator,
  createMigrationParityReport,
  migrateLegacyTaskToV3,
} from '../src/context/migration-parity.js';
import {
  type WorkflowMetadataV3,
  assertParentWorkflowRelation,
} from '../src/context/workflow-metadata.js';

const TASK_ID = '20260717-120000-login-rate-limit';
const PARENT_TASK_ID = '20260717-120001-team-rate-limit';
const CHILD_TASK_ID = '20260717-120002-diagnose-rate-limit';
const TASK_ULID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const PARENT_ULID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const CHILD_ULID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const LEGACY_REQUIREMENTS_DIGEST = 'a'.repeat(64);
const SOURCE_DIGESTS = {
  metadata: `sha256:${'b'.repeat(64)}`,
  requirements: `sha256:${'c'.repeat(64)}`,
  review: `sha256:${'d'.repeat(64)}`,
  verification: `sha256:${'e'.repeat(64)}`,
};

describe('legacy to V3 migration parity contract', () => {
  it('maps all governed legacy fields into a parser-valid V3 candidate', () => {
    const input = migrationInput();
    const candidate = migrateLegacyTaskToV3(input);
    const report = createMigrationParityReport(input, candidate, input.aliases);

    expect(candidate.metadata.workflowMode).toBe('man');
    expect(candidate.verification.checks[0]?.manual?.confirmationSource).toBe(
      'legacy_migration',
    );
    expect(candidate.artifactAliases).toHaveLength(3);
    expect(report.unmappedFields).toEqual([]);
    expect(report.legacyGate).toEqual(report.v3Gate);
    expect(report.contextPackShadow.comparisons).toHaveLength(6);
    expect(report.contextPackShadow.comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'plan', matched: true }),
        expect.objectContaining({ purpose: 'handoff', matched: true }),
      ]),
    );
    expect(() => assertMigrationParity(report)).not.toThrow();
  });

  it('turns any semantic drift into an activation blocker', () => {
    const input = migrationInput();
    const candidate = migrateLegacyTaskToV3(input);
    const changed: WorkflowMetadataV3 = {
      ...candidate.metadata,
      governance: {
        ...candidate.metadata.governance,
        planVersion: candidate.metadata.governance.planVersion + 1,
      },
    };
    const report = createMigrationParityReport(
      input,
      { ...candidate, metadata: changed },
      input.aliases,
    );

    expect(report.unmappedFields).toContain('workflow.planVersion');
    expect(report.activationBlockers).toContain('completionGate');
    expect(report.activationBlockers).toContain('contextPackShadow:plan');
    expect(() => assertMigrationParity(report)).toThrow(
      /MANCODE_MIGRATION_PARITY_FAILED/,
    );
  });

  it('rejects unsafe legacy artifact paths instead of promoting them', () => {
    const input = migrationInput();
    input.review.reports.quality = '/Users/alice/private-review.md';

    expect(() => migrateLegacyTaskToV3(input)).toThrow(
      /MANCODE_MIGRATION_ARTIFACT_PATH_UNSAFE/,
    );
  });

  it('stages a shared manteam parent and manba child with all three governed ledgers', () => {
    const allocator = createDeterministicMigrationIdAllocator(
      'parent-child-migration-fixture',
    );
    const aliases = {
      [PARENT_TASK_ID]: { namespace: 'shared' as const, taskId: PARENT_ULID },
      [CHILD_TASK_ID]: { namespace: 'shared' as const, taskId: CHILD_ULID },
    };
    const parentInput = migrationInput();
    parentInput.workflow = {
      ...parentInput.workflow,
      taskId: PARENT_TASK_ID,
      task: 'Coordinate shared rate-limit implementation.',
      mode: 'manteam',
    };
    parentInput.aliases = aliases;
    parentInput.idAllocator = allocator;
    parentInput.owner = { actorId: ACTOR_ID, participants: [ACTOR_ID] };
    parentInput.state = null;
    const parent = migrateLegacyTaskToV3(parentInput);

    const childInput = migrationInput();
    childInput.workflow = {
      ...childInput.workflow,
      taskId: CHILD_TASK_ID,
      task: 'Diagnose the rate-limit behavior.',
      mode: 'mamba',
      currentStep: 5,
      parentTaskId: PARENT_TASK_ID,
    };
    childInput.aliases = aliases;
    childInput.idAllocator = allocator;
    childInput.owner = { actorId: ACTOR_ID, participants: [ACTOR_ID] };
    childInput.parent = {
      legacyTaskId: PARENT_TASK_ID,
      metadata: parent.metadata,
    };
    childInput.state = null;
    const child = migrateLegacyTaskToV3(childInput);

    expect(child.metadata.taskRef).toEqual({
      namespace: 'shared',
      taskId: CHILD_ULID,
    });
    expect(child.metadata.parent?.taskRef).toEqual(parent.metadata.taskRef);
    expect(child.requirements.taskRef).toEqual(child.metadata.taskRef);
    expect(child.review.taskRef).toEqual(child.metadata.taskRef);
    expect(child.verification.taskRef).toEqual(child.metadata.taskRef);
    expect(() =>
      assertParentWorkflowRelation(child.metadata, parent.metadata),
    ).not.toThrow();
  });
});

function migrationInput(): LegacyTaskMigrationInput {
  return {
    workflow: {
      taskId: TASK_ID,
      task: 'Add login rate limits.',
      mode: 'man',
      currentStep: 9,
      skippedSteps: [],
      startedAt: '2026-07-17T10:00:00.000Z',
      updatedAt: '2026-07-17T11:00:00.000Z',
      status: 'in_progress',
      planVersion: 2,
      planningPolicyVersion: 2,
      reviewPolicyVersion: 2,
      verificationPolicyVersion: 1,
      requirementsStatus: 'ready',
      requirementsDigest: LEGACY_REQUIREMENTS_DIGEST,
      planDecision: 'governed_execution',
      verificationStatus: 'passed',
    },
    requirements: {
      version: 1,
      goal: 'Protect the login endpoint from repeated failed attempts.',
      confirmedScope: ['Protect the login endpoint.'],
      excludedScope: ['Change account recovery.'],
      technicalDecisions: ['Use the existing Redis client.'],
      defaults: ['Use the project test runner.'],
      blockingUnknowns: [],
      coverage: [
        'platform',
        'core_scope',
        'technical_stack',
        'data_and_persistence',
        'performance',
        'compatibility',
        'security',
      ].map((dimension) => ({
        dimension:
          dimension as LegacyTaskMigrationInput['requirements']['coverage'][number]['dimension'],
        status: 'confirmed' as const,
        rationale: `${dimension} is covered.`,
      })),
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: 'Repeated failures receive a rate-limit response.',
          required: true,
          method: 'hybrid',
        },
      ],
    },
    review: {
      version: '1.0',
      depth: 'full',
      requiredDomains: ['quality', 'security'],
      completedDomains: ['quality', 'security'],
      reports: {
        quality: 'reports/quality.md',
        security: 'reports/security.md',
      },
      blockers: [],
      remediationRounds: 0,
    },
    verification: {
      version: 1,
      planVersion: 2,
      requirementsDigest: LEGACY_REQUIREMENTS_DIGEST,
      remediationRound: 0,
      status: 'passed',
      checks: [
        {
          acceptanceId: 'AC-1',
          required: true,
          automated: {
            status: 'passed',
            evidence: 'Automated checks passed.',
            updatedAt: '2026-07-17T11:00:00.000Z',
            command: 'npm test',
            exitCode: 0,
            evidenceFile: 'reports/evidence.md',
          },
          manual: {
            status: 'passed',
            evidence: 'A legacy reviewer confirmed the behavior.',
            updatedAt: '2026-07-17T11:00:00.000Z',
          },
        },
      ],
    },
    state: legacyState(),
    sourceDigests: SOURCE_DIGESTS,
    aliases: { [TASK_ID]: { namespace: 'local', taskId: TASK_ULID } },
    idAllocator: createDeterministicMigrationIdAllocator('migration-fixture'),
    owner: { actorId: ACTOR_ID },
    parent: null,
  };
}

function legacyState(): Partial<MancodeState> {
  return {
    version: '0.3.9',
    currentMode: 'man',
    lastMode: 'solo',
    platform: 'claude-code',
    initializedAt: '2026-07-17T09:00:00.000Z',
    techStack: 'TypeScript',
    uiLibrary: 'none',
    currentTask: TASK_ID,
    currentWorkflowMode: 'man',
    skippedSteps: [],
    activeSoloPlan: null,
    teamModeAutoDetected: false,
    contributors: 1,
    projectMode: 'detected',
  };
}

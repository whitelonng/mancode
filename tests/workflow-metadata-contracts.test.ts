import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
  workflowMetadataDigest,
} from '../src/context/workflow-metadata.js';

const LOCAL_TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const SHARED_TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('workflow metadata V3 contract', () => {
  it('enforces the V3 workflow dimensions without accepting legacy mamba or non-workflow modes', () => {
    const metadata = parseWorkflowMetadata(rawMetadata());
    expect(metadata.workflowMode).toBe('manteam');
    expect(metadata.taskRef.namespace).toBe('shared');
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        workflowMode: 'mamba',
      }),
    ).toThrow(/workflowMode/);
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        coordination: 'single',
      }),
    ).toThrow(/manteam metadata/);
  });

  it('requires lifecycle, owner, scope, and pending-operation invariants', () => {
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        status: 'blocked',
        blockingReason: null,
      }),
    ).toThrow(/blockingReason/);
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        transitionState: 'operation_pending',
        lastOperationId: null,
      }),
    ).toThrow(/requires lastOperationId/);
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        implementationScope: {
          ...rawMetadata().implementationScope,
          digest: DIGEST,
        },
      }),
    ).toThrow(/does not match scope/);
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        taskRef: { namespace: 'local', taskId: LOCAL_TASK_ID },
        workflowMode: 'manba',
        visibility: 'local',
        coordination: 'single',
        status: 'in_progress',
        outcome: 'fixed',
      }),
    ).toThrow(/only valid for completed/);
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        task: 'Investigate /Users/alice/private-project.',
      }),
    ).toThrow(/MANCODE_PRIVACY_BLOCKED/);
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        latestCheckpointRef: {
          taskRef: { namespace: 'local', taskId: LOCAL_TASK_ID },
          kind: 'checkpoint',
        },
      }),
    ).toThrow(/shared entities cannot reference local/);
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        status: 'superseded',
        successorTaskRef: { namespace: 'shared', taskId: SHARED_TASK_ID },
      }),
    ).toThrow(/successor must promote a local task/);
  });

  it('excludes revision and timestamps from metadataDigest but keeps successor transitions explicit', () => {
    const metadata = parseWorkflowMetadata(rawMetadata());
    const revisionOnly = parseWorkflowMetadata({
      ...metadata,
      revision: 8,
      updatedAt: '2026-07-17T10:01:00.000Z',
    });
    expect(workflowMetadataDigest(revisionOnly)).toBe(
      workflowMetadataDigest(metadata),
    );

    const local = parseWorkflowMetadata(localMetadata());
    const published = parseWorkflowMetadata({
      ...local,
      status: 'superseded',
      revision: 8,
      successorTaskRef: { namespace: 'shared', taskId: SHARED_TASK_ID },
    });
    expect(() =>
      assertWorkflowMetadataTransition(local, published, 'publish'),
    ).not.toThrow();
    expect(() =>
      assertWorkflowMetadataTransition(local, published, 'ordinary'),
    ).toThrow(/publish or promote/);
  });

  it('preserves skipped step order for legacy compatibility evidence', () => {
    const metadata = parseWorkflowMetadata({
      ...rawMetadata(),
      skippedSteps: ['review', 'clarification'],
    });
    expect(metadata.skippedSteps).toEqual(['review', 'clarification']);
  });

  it('rejects unknown policy versions with stable component details', () => {
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        governance: {
          ...rawMetadata().governance,
          policyVersions: { planning: 2, review: 2, verification: 1 },
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        governance: {
          ...rawMetadata().governance,
          policyVersions: { planning: 3, review: 1, verification: 1 },
        },
      }),
    ).toThrow(
      /MANCODE_POLICY_VERSION_UNSUPPORTED: component=planning observed=3 supported=1,2 requiredWriter=>0.4.0/,
    );
    expect(() =>
      parseWorkflowMetadata({
        ...rawMetadata(),
        governance: {
          ...rawMetadata().governance,
          policyVersions: { planning: 2, review: 3, verification: 1 },
        },
      }),
    ).toThrow(
      /MANCODE_POLICY_VERSION_UNSUPPORTED: component=review observed=3 supported=1,2 requiredWriter=>0.4.0/,
    );
  });
});

function rawMetadata(): WorkflowMetadataV3 {
  const scope = {
    source: 'explicit' as const,
    include: ['tests/auth/**', 'src/auth/**'],
    exclude: ['src/billing/**'],
    modules: ['auth-api'],
  };
  return {
    schemaVersion: 3,
    taskRef: { namespace: 'shared', taskId: SHARED_TASK_ID },
    displaySlug: 'login-rate-limit',
    task: 'Add login rate limits.',
    workflowMode: 'manteam',
    visibility: 'shared',
    coordination: 'team',
    status: 'in_progress',
    currentStep: 5,
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
    base: {
      branch: 'feature/login',
      head: 'abc1234',
      upstream: 'origin/feature/login',
    },
    implementationScope: {
      ...scope,
      digest: digestCanonicalJson({
        ...scope,
        include: ['src/auth/**', 'tests/auth/**'],
      }),
    },
    governance: {
      requirementsStatus: 'ready',
      requirementsDigest: DIGEST,
      planVersion: 2,
      planDecision: 'governed_execution',
      policyVersions: { planning: 2, review: 1, verification: 1 },
      reviewStatus: 'passed',
      reviewLedgerDigest: DIGEST,
      verificationStatus: 'passed',
      verificationLedgerDigest: DIGEST,
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

function localMetadata(): WorkflowMetadataV3 {
  const metadata = rawMetadata();
  const scope = {
    source: 'explicit' as const,
    include: ['src/auth/**'],
    exclude: [],
    modules: ['auth-api'],
  };
  return {
    ...metadata,
    taskRef: { namespace: 'local', taskId: LOCAL_TASK_ID },
    workflowMode: 'man',
    visibility: 'local',
    coordination: 'single',
    implementationScope: { ...scope, digest: digestCanonicalJson(scope) },
    ownershipEpoch: 1,
    successorTaskRef: null,
  };
}

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTaskAggregateManifest,
  taskAggregateDigest,
} from '../src/context/aggregate.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { CURRENT_WRITER_CAPABILITIES } from '../src/context/compatibility.js';
import {
  type RequirementsLedgerV1,
  requirementsLedgerDigest,
} from '../src/context/requirements-ledger.js';
import { ContextResolver } from '../src/context/resolver.js';
import {
  type ReviewLedgerV1,
  reviewLedgerDigest,
} from '../src/context/review-ledger.js';
import { V3ContextStore } from '../src/context/store.js';
import {
  type VerificationLedgerV1,
  verificationLedgerDigest,
} from '../src/context/verification-ledger.js';
import type { WorkflowMetadataV3 } from '../src/context/workflow-metadata.js';
import {
  resolveTaskEntityHomeStore,
  taskHeadDirectory,
} from '../src/runtime/entity-home-store.js';
import type { OperationJournalV1 } from '../src/runtime/operation-journal.js';

const EPOCH = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const CHECKOUT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7P';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7Q';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('V3 Context Resolver', () => {
  it('reads one stable shared tuple, checks its task head fence, and creates a purpose-filtered pack', async () => {
    const fixture = await createFixture();
    const result = await fixture.resolver.resolve({
      session: fixture.session,
      taskRef: TASK_ID,
      level: 'task',
      purpose: 'plan',
      compatibility: fixture.compatibility,
      codeHead: 'abc1234',
      generatedAt: new Date('2026-07-17T12:00:00.000Z'),
    });

    expect(result.repair).toBeNull();
    expect(result.mutatingAllowed).toBe(true);
    expect(result.aggregate).not.toBeNull();
    expect(result.pack.activeTask).toMatchObject({
      taskRef: { namespace: 'shared', taskId: TASK_ID },
      revision: 1,
    });
    expect(result.pack.governance.requirements).toMatchObject({
      taskRef: { namespace: 'shared', taskId: TASK_ID },
      status: 'draft',
    });
    expect(result.pack.governance.review).toBeNull();
    expect(result.pack.snapshot).toMatchObject({
      schemaEpoch: EPOCH,
      taskRevision: 1,
    });
    expect(result.pack.project).toMatchObject({
      facts: {
        trust: 'detected',
        profile: { projectKind: 'web', frameworks: ['React'] },
      },
    });
    expect(result.pack.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityKey: 'project-facts' }),
      ]),
    );

    await expect(
      fixture.resolver.resolve({
        session: fixture.session,
        taskRef: `shared:${TASK_ID}`,
        level: 'task',
        purpose: 'implement',
        compatibility: fixture.compatibility,
        codeHead: 'abc1234',
        intent: 'mutate',
      }),
    ).resolves.toMatchObject({ mutatingAllowed: true });
  });

  it('returns a minimal repair envelope for a durable unfinished operation and refuses mutation', async () => {
    const fixture = await createFixture();
    await writeJson(
      path.join(fixture.homeStore.root, 'operations', `${OPERATION_ID}.json`),
      pendingJournal(fixture.homeStore.storeId),
    );

    const readResult = await fixture.resolver.resolve({
      session: fixture.session,
      level: 'task',
      purpose: 'implement',
      compatibility: fixture.compatibility,
      codeHead: 'abc1234',
    });
    expect(readResult.repair).toMatchObject({
      state: 'repair_required',
      issues: [
        expect.objectContaining({
          code: 'MANCODE_OPERATION_REPAIR_REQUIRED',
          operationIds: [OPERATION_ID],
        }),
      ],
    });
    expect(readResult.metadata).toBeNull();
    expect(readResult.aggregate).toBeNull();
    expect(readResult.pack.activeTask).toEqual({
      taskRef: { namespace: 'shared', taskId: TASK_ID },
      state: 'repair_required',
    });
    expect(readResult.pack.governance).toEqual({
      requirements: null,
      review: null,
      verification: null,
    });

    await expect(
      fixture.resolver.resolve({
        session: fixture.session,
        level: 'task',
        purpose: 'implement',
        compatibility: fixture.compatibility,
        codeHead: 'abc1234',
        intent: 'mutate',
      }),
    ).rejects.toThrow('MANCODE_OPERATION_REPAIR_REQUIRED');
  });

  it('does not follow a symlink that replaces a task authority file', async () => {
    const fixture = await createFixture();
    const taskRoot = path.join(
      fixture.root,
      '.mancode',
      'shared',
      'workflows',
      TASK_ID,
    );
    const outside = path.join(fixture.root, 'outside.json');
    await writeFile(outside, '{}\n', 'utf8');
    await rm(path.join(taskRoot, 'metadata.json'));
    await symlink(outside, path.join(taskRoot, 'metadata.json'));

    await expect(
      new V3ContextStore(fixture.root).readTaskSnapshot({
        namespace: 'shared',
        taskId: TASK_ID,
      }),
    ).rejects.toThrow('MANCODE_CONTEXT_PATH_UNSAFE');
  });
});

async function createFixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'mancode-context-resolver-'),
  );
  roots.push(root);
  const taskRef = { namespace: 'shared' as const, taskId: TASK_ID };
  const requirements = requirementsLedger();
  const review = reviewLedger(requirements.contentDigest);
  const verification = verificationLedger(requirements.contentDigest);
  const metadata = workflowMetadata(requirements, review, verification);
  const aggregate = buildTaskAggregateManifest({
    metadata,
    requirements,
    review,
    verification,
    planDigest: null,
    latestCheckpoint: null,
  });
  const context = {
    projectRoot: root,
    workspaceId: WORKSPACE_ID,
    checkoutId: CHECKOUT_ID,
    gitCommonDir: null,
    repositoryBindingId: null,
  };
  const homeStore = resolveTaskEntityHomeStore(context, taskRef);
  const taskRoot = path.join(root, '.mancode', 'shared', 'workflows', TASK_ID);
  await Promise.all([
    writeJson(path.join(root, '.mancode', 'schema.json'), {
      manifestVersion: 1,
      layoutVersion: 3,
      epoch: EPOCH,
      activationState: 'v3_active',
      minReaderVersion: '1.0.0',
      minWriterVersion: '1.0.0',
      activatedAt: '2026-07-17T10:00:00.000Z',
      legacyBaseline: null,
      managedAdapters: adapters(),
      lastOperationId: null,
    }),
    writeJson(path.join(root, '.mancode', 'shared', 'config.json'), {
      schemaVersion: 1,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      transport: { mode: 'local', remote: null },
      lastOperationId: null,
      updatedAt: '2026-07-17T10:00:00.000Z',
    }),
    writeJson(
      path.join(root, '.mancode', 'shared', 'context', 'project.json'),
      {
        schemaVersion: 1,
        revision: 1,
        trust: 'detected',
        profile: {
          version: '1.0',
          projectKind: 'web',
          languages: ['JavaScript/TypeScript'],
          frameworks: ['React'],
          sourceRoots: ['src'],
          manifests: ['package.json'],
          availableValidation: ['npm test'],
          uiAssets: 'detected',
          browserAutomation: 'available',
          confidence: 'high',
        },
        uiLibrary: null,
        detectedAt: '2026-07-17T10:00:00.000Z',
        lastOperationId: null,
      },
    ),
    writeJson(path.join(root, '.mancode', 'shared', 'team', 'policy.json'), {
      schemaVersion: 1,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      policy: 'auto',
      recentDays: 30,
      defaultVisibility: 'shared',
      shareConfirmedDecisions: true,
      retention: {
        localRawArtifactDays: 30,
        localCacheDays: 7,
        completedSessionDays: 30,
      },
      lastOperationId: null,
      updatedAt: '2026-07-17T10:00:00.000Z',
    }),
    writeJson(path.join(taskRoot, 'metadata.json'), metadata),
    writeJson(path.join(taskRoot, 'requirements.json'), requirements),
    writeJson(path.join(taskRoot, 'review-ledger.json'), review),
    writeJson(path.join(taskRoot, 'verification-ledger.json'), verification),
    writeJson(path.join(taskHeadDirectory(homeStore), `${TASK_ID}.json`), {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      taskRef,
      fenceRevision: 1,
      taskRevision: metadata.revision,
      aggregateDigest: taskAggregateDigest(aggregate),
      ownershipEpoch: metadata.ownershipEpoch,
      codeRef: { head: 'abc1234' },
      checkoutId: CHECKOUT_ID,
      remoteRevision: null,
      lastOperationId: OPERATION_ID,
      updatedAt: '2026-07-17T10:00:00.000Z',
    }),
  ]);
  const session = {
    schemaVersion: 1 as const,
    sessionId: SESSION_ID,
    identitySource: 'explicit' as const,
    identityLookupKeyHash: null,
    actorId: ACTOR_ID,
    client: 'codex',
    status: 'active' as const,
    activeTaskRef: taskRef,
    activeMode: 'manteam' as const,
    lastSeenRevision: 1,
    executionIds: [],
    startedAt: '2026-07-17T10:00:00.000Z',
    closedAt: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
  return {
    root,
    homeStore,
    session,
    compatibility: {
      expectedSchemaEpoch: EPOCH,
      readerVersion: '1.0.0',
      writerVersion: '1.0.0',
      writerCapabilities: CURRENT_WRITER_CAPABILITIES,
      adapterVersions: adapters(),
    },
    resolver: new ContextResolver({
      projectRoot: root,
      entityHomeStoreContext: context,
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    }),
  };
}

function requirementsLedger(): RequirementsLedgerV1 {
  const draft: RequirementsLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    revision: 1,
    status: 'draft',
    goal: 'Plan a safe rate limit.',
    functionalScope: { inScope: [], outOfScope: [] },
    technicalDecisions: [],
    defaults: [],
    coverage: [],
    requirements: [],
    acceptanceCriteria: [],
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
    status: 'pending',
    depth: 'targeted',
    requirementsDigest,
    planVersion: 1,
    requiredDomains: ['quality'],
    domains: [{ domain: 'quality', status: 'pending', reportRef: null }],
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
    status: 'pending',
    requirementsDigest,
    planVersion: 1,
    remediationRound: 0,
    checks: [],
    legacySource: null,
    contentDigest: '',
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
  return { ...draft, contentDigest: verificationLedgerDigest(draft) };
}

function workflowMetadata(
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
  verification: VerificationLedgerV1,
): WorkflowMetadataV3 {
  const scope = {
    source: 'explicit' as const,
    include: ['src/**'],
    exclude: [],
    modules: [],
  };
  return {
    schemaVersion: 3,
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    displaySlug: 'rate-limit',
    task: 'Plan a safe rate limit.',
    workflowMode: 'manteam',
    visibility: 'shared',
    coordination: 'team',
    status: 'planned',
    currentStep: 1,
    skippedSteps: [],
    blockingReason: null,
    outcome: null,
    revision: 1,
    transitionState: 'stable',
    lastOperationId: null,
    ownerActorId: ACTOR_ID,
    ownershipEpoch: 1,
    participants: [ACTOR_ID],
    createdBy: { actorId: ACTOR_ID, client: 'codex', source: 'actor' },
    base: { branch: 'main', head: 'abc1234', upstream: null },
    implementationScope: {
      ...scope,
      digest: digestCanonicalJson(scope),
    },
    governance: {
      requirementsStatus: 'needs_clarification',
      requirementsDigest: requirements.contentDigest,
      planVersion: 1,
      planDecision: null,
      policyVersions: { planning: null, review: null, verification: null },
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
    startedAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function pendingJournal(primaryStoreId: string): OperationJournalV1 {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    type: 'verification_record',
    state: 'prepared',
    primaryStoreId,
    checkoutId: CHECKOUT_ID,
    secondaryReservations: [],
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    authorizationBasis: {
      schemaVersion: 1,
      action: 'shared_ledger_evidence',
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      trustBoundary: 'repo-collaborators',
      decisionDigest: `sha256:${'a'.repeat(64)}`,
      authorizedAt: '2026-07-17T10:00:00.000Z',
    },
    entityLocks: [`task:shared:${TASK_ID}`],
    expectedRevisions: { [`task:shared:${TASK_ID}`]: 1 },
    steps: [{ id: 'validate', state: 'pending' }],
    startedAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function adapters() {
  return {
    'claude-code': '1.0.0',
    codex: '1.0.0',
    cursor: '1.0.0',
    copilot: '1.0.0',
    zcode: '1.0.0',
  };
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

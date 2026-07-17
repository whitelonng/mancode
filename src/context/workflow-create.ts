import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  type EntityHomeStore,
  resolveTaskEntityHomeStore,
} from '../runtime/entity-home-store.js';
import { acquireEntityLocks } from '../runtime/local-lock.js';
import {
  armOperationCrashAfterVisibleWrite,
  throwIfDeferredOperationCrashInjected,
  throwIfOperationCrashInjected,
} from '../runtime/operation-crash-injection.js';
import {
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from '../runtime/operation-definition.js';
import type {
  OperationJournalV1,
  OperationStep,
} from '../runtime/operation-journal.js';
import {
  assertOperationRecoveryPayloadCoversJournal,
  createTaskHeadFenceRecoveryAction,
  createWorkflowTaskDirectoryRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../runtime/operation-recovery-payload.js';
import { writeOperationRecoveryPayload } from '../runtime/operation-recovery-store.js';
import {
  createPreparedOperationJournal,
  updateOperationJournal,
} from '../runtime/operation-store.js';
import {
  readCheckoutCodeHead,
  readProjectRuntimeContext,
} from '../runtime/project-runtime.js';
import {
  completeProjectionIntent,
  enqueueSessionPointerProjection,
} from '../runtime/projection-outbox.js';
import { readSession, resumeSession } from '../runtime/session.js';
import { parseTaskHeadFence } from '../runtime/task-head-fence.js';
import { createTaskHeadFence } from '../runtime/task-head-store.js';
import { readSharedActorProfile } from '../team/actor.js';
import type { TeamAssessment } from '../team/assessment.js';
import { createAuthorizationBasis } from '../team/authorization.js';
import { assertTransportCoordinationWriteAllowed } from '../team/transport-migration-freeze.js';
import { capabilitiesFromProjectConfig } from '../team/transport.js';
import { VERSION } from '../version.js';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
  taskAggregateDigest,
} from './aggregate.js';
import { digestCanonicalJson, sortUtf8StringSet } from './canonical.js';
import { assertCompatibilityGate } from './compatibility.js';
import {
  type WorkflowCreationResolution,
  resolveWorkflowCreation,
} from './creation-resolution.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { scanLegacyAuthority } from './layout.js';
import type { ParentSnapshot } from './parent-snapshot.js';
import {
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from './requirements-ledger.js';
import {
  type ReviewLedgerV1,
  deriveReviewLedgerStatus,
  parseReviewLedger,
  reviewLedgerDigest,
} from './review-ledger.js';
import { parseWorkflowMode } from './schema.js';
import { V3ContextStore } from './store.js';
import {
  type TaskNamespace,
  type TaskRef,
  parseTaskRefValue,
} from './task-ref.js';
import {
  type VerificationLedgerV1,
  deriveVerificationLedgerStatus,
  parseVerificationLedger,
  verificationLedgerDigest,
} from './verification-ledger.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface WorkflowCreateScope {
  include?: string[];
  exclude?: string[];
  modules?: string[];
}

export interface CreateV3WorkflowInput {
  projectRoot: string;
  task: string;
  workflowMode: 'man' | 'manba' | 'manteam';
  sessionId: Ulid;
  client: string;
  parentTaskRef?: TaskRef | null;
  visibility?: TaskNamespace;
  coordination?: 'single' | 'team';
  displaySlug?: string;
  implementationScope?: WorkflowCreateScope;
  /** Additional joined actors invited into a newly-created team workflow. */
  participantActorIds?: Ulid[];
  /** Explicit confirmation is mandatory whenever metadata enters shared V3. */
  sharedPrivacyConfirmed?: boolean;
  taskId?: Ulid;
  operationId?: Ulid;
  assessment?: TeamAssessment | null;
  now?: Date;
}

export interface CreatedV3Workflow {
  taskRef: TaskRef;
  metadata: WorkflowMetadataV3;
  requirements: RequirementsLedgerV1;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  aggregate: TaskAggregateManifestV1;
  operation: OperationJournalV1;
  resolution: WorkflowCreationResolution;
  /** A failed session-pointer projection never rolls back a committed task. */
  sessionResumed: boolean;
}

interface InitialEntities {
  metadata: WorkflowMetadataV3;
  requirements: RequirementsLedgerV1;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  aggregate: TaskAggregateManifestV1;
}

interface ParentCreationContext {
  metadata: WorkflowMetadataV3;
  snapshot: ParentSnapshot;
}

/**
 * Creates the smallest valid V3 workflow tuple. The write-ahead journal is
 * durable before any task entity becomes visible; an uncertain post-intent
 * failure is deliberately left for forward repair instead of guessing that a
 * task directory was not published.
 */
export async function createV3Workflow(
  input: CreateV3WorkflowInput,
): Promise<CreatedV3Workflow> {
  const projectRoot = path.resolve(requireProjectRoot(input.projectRoot));
  const task = requireText(input.task, 'workflow task');
  const client = requireText(input.client, 'workflow client');
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  assertUlid(input.sessionId, 'workflow sessionId');
  const workflowMode = parseWorkflowMode(input.workflowMode);
  const session = await readSession(projectRoot, input.sessionId);
  if (session === null || session.status !== 'active') {
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  }

  const runtime = await readProjectRuntimeContext(projectRoot);
  const contextStore = new V3ContextStore(projectRoot);
  const [project, legacy] = await Promise.all([
    contextStore.readProjectSnapshot(),
    scanLegacyAuthority(projectRoot),
  ]);
  assertCompatibilityGate({
    manifest: project.manifest,
    expectedSchemaEpoch: project.manifest.epoch,
    readerVersion: VERSION,
    writerVersion: VERSION,
    adapterVersions: project.manifest.managedAdapters,
    currentLegacyBaseline: legacy.baseline,
    legacyAuthorityPresent: legacy.authorityPresent,
    operation: 'v3_business_write',
  });

  const parent = await resolveParentCreationContext(
    contextStore,
    workflowMode,
    input.parentTaskRef ?? null,
    session.actorId,
  );
  const resolution = resolveWorkflowCreation({
    workflowMode,
    parent:
      parent === null
        ? null
        : {
            taskRef: parent.metadata.taskRef,
            workflowMode: parent.metadata.workflowMode,
            visibility: parent.metadata.visibility,
            coordination: parent.metadata.coordination,
          },
    visibility: input.visibility,
    coordination: input.coordination,
    policy: project.policy,
    assessment: input.assessment ?? null,
  });
  const taskRef = parseTaskRefValue({
    namespace: resolution.descriptor.visibility,
    taskId: input.taskId ?? createUlid(now.getTime()),
  });
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'workflow operationId');
  const participants = resolveInitialParticipants(
    parent,
    input.participantActorIds,
    session.actorId,
    resolution.descriptor.coordination,
  );
  if (taskRef.namespace === 'shared') {
    await assertSharedCreationPrerequisites(
      projectRoot,
      session.actorId,
      input.sharedPrivacyConfirmed === true,
      participants,
    );
  }

  const codeHead =
    taskRef.namespace === 'shared'
      ? await requireSharedCodeHead(projectRoot)
      : null;
  const entities = buildInitialEntities({
    taskRef,
    task,
    displaySlug: input.displaySlug,
    workflowMode,
    coordination: resolution.descriptor.coordination,
    actorId: session.actorId,
    client,
    operationId,
    parent,
    participants,
    explicitScope: input.implementationScope,
    timestamp,
  });
  const homeStore = resolveTaskEntityHomeStore(
    runtime.entityHomeStoreContext,
    taskRef,
  );
  if (taskRef.namespace === 'shared' && codeHead === null) {
    throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
  }
  const taskHeadFence =
    taskRef.namespace === 'shared'
      ? parseTaskHeadFence({
          schemaVersion: 1,
          workspaceId: runtime.workspaceId,
          taskRef,
          fenceRevision: 1,
          taskRevision: entities.metadata.revision,
          aggregateDigest: taskAggregateDigest(entities.aggregate),
          ownershipEpoch: entities.metadata.ownershipEpoch,
          codeRef: { head: codeHead as string },
          checkoutId: runtime.checkoutId,
          remoteRevision: null,
          lastOperationId: operationId,
          updatedAt: timestamp,
        })
      : null;
  const recoveryPayload = parseOperationRecoveryPayload({
    schemaVersion: 1,
    operationId,
    type: 'workflow_create',
    primaryStoreId: homeStore.storeId,
    actions: [
      createWorkflowTaskDirectoryRecoveryAction({
        stepId: 'publish-task-directory',
        taskRef,
        files: [
          {
            fileName: 'metadata.json',
            content: `${JSON.stringify(entities.metadata, null, 2)}\n`,
          },
          {
            fileName: 'requirements.json',
            content: `${JSON.stringify(entities.requirements, null, 2)}\n`,
          },
          {
            fileName: 'review-ledger.json',
            content: `${JSON.stringify(entities.review, null, 2)}\n`,
          },
          {
            fileName: 'verification-ledger.json',
            content: `${JSON.stringify(entities.verification, null, 2)}\n`,
          },
        ],
      }),
      ...(taskHeadFence === null
        ? []
        : [
            createTaskHeadFenceRecoveryAction({
              stepId: 'publish-locator',
              before: null,
              fence: taskHeadFence,
            }),
          ]),
    ],
    noOpStepIds: taskHeadFence === null ? ['publish-locator'] : [],
  });
  const operation = buildCreateOperation({
    operationId,
    store: homeStore,
    checkoutId: runtime.checkoutId,
    actorId: session.actorId,
    sessionId: session.sessionId,
    taskRef,
    parentTaskRef: parent?.metadata.taskRef ?? null,
    shared: taskRef.namespace === 'shared',
    sharedPrivacyConfirmed: input.sharedPrivacyConfirmed === true,
    sharedWriteGuard: capabilitiesFromProjectConfig(project.config).writeGuard,
    timestamp,
    recoveryPayloadDigest: operationRecoveryPayloadDigest(recoveryPayload),
  });
  assertOperationRecoveryPayloadCoversJournal(operation, recoveryPayload);
  assertOperationJournalMatchesDefinition(operation);

  const taskParent = await ensureSafeTaskParent(projectRoot, taskRef);
  const targetDirectory = path.join(taskParent, taskRef.taskId);
  const stagingDirectory = path.join(
    taskParent,
    `.${taskRef.taskId}.${operationId}.staging`,
  );
  const locks = await acquireEntityLocks(
    homeStore,
    operationId,
    operation.entityLocks,
    { now },
  );
  let journal = operation;
  let journalCreated = false;
  let sessionProjectionId: string | null = null;
  try {
    if (taskRef.namespace === 'shared') {
      await assertTransportCoordinationWriteAllowed(homeStore, project.config);
    }
    if (parent !== null) {
      const lockedParent = await resolveParentCreationContext(
        contextStore,
        workflowMode,
        parent.metadata.taskRef,
        session.actorId,
      );
      if (!sameParentCreationContext(parent, lockedParent)) {
        throw new Error('MANCODE_PARENT_STALE');
      }
    }
    await assertDirectoryAbsent(
      targetDirectory,
      'MANCODE_WORKFLOW_ALREADY_EXISTS',
    );
    await assertDirectoryAbsent(
      stagingDirectory,
      'MANCODE_WORKFLOW_STAGING_CONFLICT',
    );
    const sessionProjection = await enqueueSessionPointerProjection(
      projectRoot,
      {
        operationId,
        action: 'resume',
        sessionId: session.sessionId,
        expectedPreviousTaskRef: session.activeTaskRef,
        taskRef,
        workflowMode,
        taskRevision: entities.metadata.revision,
        now,
      },
    );
    sessionProjectionId = sessionProjection.projectionId;
    await writeOperationRecoveryPayload(homeStore, recoveryPayload);
    journal = await createPreparedOperationJournal(homeStore, journal);
    journalCreated = true;
    throwIfOperationCrashInjected('workflow_create', 'prepared');

    journal = await advanceJournal(homeStore, journal, 'validate', now, true);
    // Mark write intent before the visible effect. This makes a crash in the
    // narrow rename/write window repair-only rather than accidentally abortable.
    journal = await advanceJournal(
      homeStore,
      journal,
      'write-staging-aggregate',
      now,
      false,
    );
    await writeStagedEntities(stagingDirectory, entities);
    await validateStagedEntities(stagingDirectory);
    journal = await advanceJournal(
      homeStore,
      journal,
      'validate-aggregate',
      now,
      false,
    );
    journal = await advanceJournal(
      homeStore,
      journal,
      'publish-task-directory',
      now,
      false,
    );
    await publishStagedTask(stagingDirectory, targetDirectory);
    journal = await advanceJournal(
      homeStore,
      journal,
      'publish-locator',
      now,
      false,
    );
    if (taskHeadFence !== null) {
      await createTaskHeadFence(homeStore, taskHeadFence);
    }
    journal = await commitJournal(homeStore, journal, now);
  } catch (error) {
    if (journalCreated) {
      try {
        if (hasBusinessWriteIntent(journal)) {
          await markRepairRequired(homeStore, journal, now);
        } else {
          await abortPreparedCreate(homeStore, journal, stagingDirectory, now);
        }
      } catch {
        // The persisted journal is still sufficient for doctor recovery. A
        // compensation failure must not hide the original interrupted write.
      }
    }
    throw error;
  } finally {
    await Promise.allSettled(
      [...locks].reverse().map((lock) => lock.release()),
    );
  }

  let sessionResumed = true;
  try {
    await resumeSession(projectRoot, session.sessionId, {
      taskRef,
      workflowMode,
      taskRevision: entities.metadata.revision,
      now,
    });
  } catch {
    sessionResumed = false;
  }
  if (sessionResumed && sessionProjectionId !== null) {
    try {
      await completeProjectionIntent(
        projectRoot,
        operationId,
        sessionProjectionId,
        now,
      );
    } catch {
      // The pointer is already correct; doctor can close the pending intent.
    }
  }
  return {
    taskRef,
    metadata: entities.metadata,
    requirements: entities.requirements,
    review: entities.review,
    verification: entities.verification,
    aggregate: entities.aggregate,
    operation: journal,
    resolution,
    sessionResumed,
  };
}

async function resolveParentCreationContext(
  store: V3ContextStore,
  workflowMode: CreateV3WorkflowInput['workflowMode'],
  parentTaskRef: TaskRef | null,
  actorId: Ulid,
): Promise<ParentCreationContext | null> {
  if (parentTaskRef === null) return null;
  if (workflowMode !== 'manba') {
    throw new Error('MANCODE_PARENT_MODE_INVALID');
  }
  const snapshot = await store.readTaskSnapshot(
    parseTaskRefValue(parentTaskRef),
  );
  const parent = snapshot.metadata;
  if (
    (parent.workflowMode !== 'man' && parent.workflowMode !== 'manteam') ||
    parent.status !== 'in_progress' ||
    parent.currentStep !== 6 ||
    parent.transitionState !== 'stable' ||
    snapshot.aggregate === null
  ) {
    throw new Error('MANCODE_PARENT_NOT_ELIGIBLE');
  }
  if (parent.ownerActorId !== actorId) {
    throw new Error('MANCODE_PARENT_OWNER_REQUIRED');
  }
  if (!parent.participants.includes(actorId)) {
    throw new Error('MANCODE_PARENT_PARTICIPANT_REQUIRED');
  }
  return {
    metadata: parent,
    snapshot: {
      taskRef: parent.taskRef,
      revisionAtCreate: parent.revision,
      planVersionAtCreate: parent.governance.planVersion,
      requirementsDigestAtCreate: parent.governance.requirementsDigest,
      implementationScopeDigestAtCreate: parent.implementationScope.digest,
      visibility: parent.visibility,
      coordination: parent.coordination,
      participants: [...parent.participants],
    },
  };
}

async function assertSharedCreationPrerequisites(
  projectRoot: string,
  actorId: Ulid,
  privacyConfirmed: boolean,
  participants: readonly Ulid[],
): Promise<void> {
  if (!privacyConfirmed) {
    throw new Error('MANCODE_PRIVACY_CONFIRMATION_REQUIRED');
  }
  if ((await readSharedActorProfile(projectRoot, actorId)) === null) {
    throw new Error('MANCODE_JOIN_REQUIRED');
  }
  for (const participantActorId of participants) {
    if (participantActorId === actorId) continue;
    if (
      (await readSharedActorProfile(projectRoot, participantActorId)) === null
    ) {
      throw new Error('MANCODE_PARTICIPANT_JOIN_REQUIRED');
    }
  }
}

async function requireSharedCodeHead(projectRoot: string): Promise<string> {
  const head = await readCheckoutCodeHead(projectRoot);
  if (head === null) throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
  return head;
}

function resolveInitialParticipants(
  parent: ParentCreationContext | null,
  requested: Ulid[] | undefined,
  ownerActorId: Ulid,
  coordination: 'single' | 'team',
): Ulid[] {
  if (parent !== null) {
    if (requested !== undefined) {
      throw new Error('MANCODE_PARENT_PARTICIPANT_INHERITANCE_REQUIRED');
    }
    return [...parent.metadata.participants];
  }
  const extras = requested ?? [];
  const seen = new Set<Ulid>();
  for (const actorId of extras) {
    assertUlid(actorId, 'workflow participant actorId');
    if (actorId === ownerActorId) {
      throw new Error('MANCODE_OWNER_PARTICIPANT_REDUNDANT');
    }
    if (seen.has(actorId)) {
      throw new Error('MANCODE_WORKFLOW_PARTICIPANT_DUPLICATE');
    }
    seen.add(actorId);
  }
  if (extras.length > 0 && coordination !== 'team') {
    throw new Error('MANCODE_WORKFLOW_PARTICIPANTS_REQUIRE_TEAM');
  }
  return sortUtf8StringSet([ownerActorId, ...extras]) as Ulid[];
}

function buildInitialEntities(input: {
  taskRef: TaskRef;
  task: string;
  displaySlug: string | undefined;
  workflowMode: CreateV3WorkflowInput['workflowMode'];
  coordination: 'single' | 'team';
  actorId: Ulid;
  client: string;
  operationId: Ulid;
  parent: ParentCreationContext | null;
  participants: Ulid[];
  explicitScope: WorkflowCreateScope | undefined;
  timestamp: string;
}): InitialEntities {
  const scope = initialScope(input.parent, input.explicitScope);
  const requirementsDraft: RequirementsLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: input.taskRef,
    revision: 1,
    status: 'draft',
    goal: input.task,
    functionalScope: { inScope: [], outOfScope: [] },
    technicalDecisions: [],
    defaults: [],
    coverage: [],
    requirements: [],
    acceptanceCriteria: [],
    blockingUnknowns: [],
    legacySource: null,
    contentDigest: '',
    lastOperationId: input.operationId,
    updatedAt: input.timestamp,
  };
  const requirements = parseRequirementsLedger({
    ...requirementsDraft,
    contentDigest: requirementsLedgerDigest(requirementsDraft),
  });
  const reviewDraft: ReviewLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: input.taskRef,
    revision: 1,
    status: 'pending',
    depth: 'targeted',
    requirementsDigest: requirements.contentDigest,
    planVersion: 1,
    requiredDomains: ['quality'],
    domains: [{ domain: 'quality', status: 'pending', reportRef: null }],
    blockers: [],
    remediationRound: 0,
    skip: null,
    legacySource: null,
    contentDigest: '',
    lastOperationId: input.operationId,
    updatedAt: input.timestamp,
  };
  const reviewWithStatus = {
    ...reviewDraft,
    status: deriveReviewLedgerStatus(reviewDraft),
  };
  const review = parseReviewLedger({
    ...reviewWithStatus,
    contentDigest: reviewLedgerDigest(reviewWithStatus),
  });
  const verificationDraft: VerificationLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: input.taskRef,
    revision: 1,
    status: 'pending',
    requirementsDigest: requirements.contentDigest,
    planVersion: 1,
    remediationRound: 0,
    checks: [],
    legacySource: null,
    contentDigest: '',
    lastOperationId: input.operationId,
    updatedAt: input.timestamp,
  };
  const verificationWithStatus = {
    ...verificationDraft,
    status: deriveVerificationLedgerStatus(verificationDraft),
  };
  const verification = parseVerificationLedger(
    {
      ...verificationWithStatus,
      contentDigest: verificationLedgerDigest(verificationWithStatus),
    },
    requirements,
  );
  const metadata = parseWorkflowMetadata({
    schemaVersion: 3,
    taskRef: input.taskRef,
    displaySlug: input.displaySlug ?? displaySlug(input.task),
    task: input.task,
    workflowMode: input.workflowMode,
    visibility: input.taskRef.namespace,
    coordination: input.coordination,
    status: 'in_progress',
    currentStep: 1,
    skippedSteps: [],
    blockingReason: null,
    outcome: null,
    revision: 1,
    transitionState: 'stable',
    lastOperationId: input.operationId,
    ownerActorId: input.actorId,
    ownershipEpoch: 1,
    participants: input.participants,
    createdBy: {
      actorId: input.actorId,
      client: input.client,
      source: 'actor',
    },
    base: null,
    implementationScope: scope,
    governance: {
      requirementsStatus: 'needs_clarification',
      requirementsDigest: requirements.contentDigest,
      planVersion: 1,
      planDecision: null,
      policyVersions: { planning: 1, review: 1, verification: 1 },
      reviewStatus: review.status,
      reviewLedgerDigest: review.contentDigest,
      verificationStatus: verification.status,
      verificationLedgerDigest: verification.contentDigest,
    },
    soloExecution: null,
    latestCheckpointRef: null,
    parent: input.parent?.snapshot ?? null,
    successorTaskRef: null,
    legacyCompatibility: null,
    startedAt: input.timestamp,
    updatedAt: input.timestamp,
  });
  const aggregate = buildTaskAggregateManifest({
    metadata,
    requirements,
    review,
    verification,
    planDigest: null,
    latestCheckpoint: null,
  });
  return { metadata, requirements, review, verification, aggregate };
}

function initialScope(
  parent: ParentCreationContext | null,
  explicitScope: WorkflowCreateScope | undefined,
): WorkflowMetadataV3['implementationScope'] {
  if (parent !== null) {
    if (explicitScope !== undefined) {
      throw new Error('MANCODE_PARENT_SCOPE_INHERITANCE_REQUIRED');
    }
    const inherited = {
      source: 'inherited' as const,
      include: [...parent.metadata.implementationScope.include],
      exclude: [...parent.metadata.implementationScope.exclude],
      modules: [...parent.metadata.implementationScope.modules],
    };
    return { ...inherited, digest: digestCanonicalJson(inherited) };
  }
  const explicit = {
    source: 'explicit' as const,
    include: [...(explicitScope?.include ?? [])],
    exclude: [...(explicitScope?.exclude ?? [])],
    modules: [...(explicitScope?.modules ?? [])],
  };
  return { ...explicit, digest: digestCanonicalJson(explicit) };
}

function buildCreateOperation(input: {
  operationId: Ulid;
  store: EntityHomeStore;
  checkoutId: Ulid;
  actorId: Ulid;
  sessionId: Ulid;
  taskRef: TaskRef;
  parentTaskRef: TaskRef | null;
  shared: boolean;
  sharedPrivacyConfirmed: boolean;
  sharedWriteGuard: 'enforced' | 'advisory' | 'unavailable';
  timestamp: string;
  recoveryPayloadDigest: string;
}): OperationJournalV1 {
  const taskKey = `task:${input.taskRef.namespace}:${input.taskRef.taskId}`;
  const locatorKey = `locator:${input.taskRef.namespace}:${input.taskRef.taskId}`;
  const entityLocks = [taskKey, locatorKey];
  if (input.parentTaskRef !== null) {
    entityLocks.push(
      `task:${input.parentTaskRef.namespace}:${input.parentTaskRef.taskId}`,
    );
  }
  if (input.shared) {
    entityLocks.push(`task_head:${input.taskRef.taskId}`);
  }
  const authorizationBasis = createAuthorizationBasis({
    action: input.shared
      ? 'shared_create_publish_promote'
      : 'local_workflow_mutation',
    actorId: input.actorId,
    session: {
      sessionId: input.sessionId,
      actorId: input.actorId,
      status: 'active',
    },
    joined: input.shared,
    sharedWriteGuard: input.sharedWriteGuard,
    task: null,
    claim: null,
    handoff: null,
    evidence: null,
    profileActorId: null,
    conditions: {
      expectedRevisionMatches: true,
      privacyConfirmed: input.shared ? input.sharedPrivacyConfirmed : undefined,
    },
  });
  const definition = getOperationDefinition('workflow_create');
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    type: 'workflow_create',
    state: 'prepared',
    primaryStoreId: input.store.storeId,
    checkoutId: input.checkoutId,
    secondaryReservations: [],
    actorId: input.actorId,
    sessionId: input.sessionId,
    authorizationBasis,
    recoveryPayloadDigest: input.recoveryPayloadDigest,
    entityLocks,
    expectedRevisions: { [taskKey]: 0, [locatorKey]: 0 },
    steps: definition.steps.map((step) => ({ id: step.id, state: 'pending' })),
    startedAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

function sameParentCreationContext(
  expected: ParentCreationContext,
  current: ParentCreationContext | null,
): boolean {
  return (
    current !== null &&
    expected.metadata.revision === current.metadata.revision &&
    JSON.stringify(expected.snapshot) === JSON.stringify(current.snapshot)
  );
}

async function ensureSafeTaskParent(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<string> {
  const segments = ['.mancode', taskRef.namespace, 'workflows'];
  let current = projectRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing === null) {
      await mkdir(current);
      continue;
    }
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  }
  return current;
}

async function assertDirectoryAbsent(
  target: string,
  code: string,
): Promise<void> {
  if ((await lstatOrNull(target)) !== null) throw new Error(code);
}

async function writeStagedEntities(
  stagingDirectory: string,
  entities: InitialEntities,
): Promise<void> {
  await mkdir(stagingDirectory);
  await assertDirectory(stagingDirectory);
  await Promise.all([
    writeStagedJson(stagingDirectory, 'metadata.json', entities.metadata),
    writeStagedJson(
      stagingDirectory,
      'requirements.json',
      entities.requirements,
    ),
    writeStagedJson(stagingDirectory, 'review-ledger.json', entities.review),
    writeStagedJson(
      stagingDirectory,
      'verification-ledger.json',
      entities.verification,
    ),
  ]);
  await assertDirectory(stagingDirectory);
}

async function writeStagedJson(
  stagingDirectory: string,
  fileName: string,
  value: unknown,
): Promise<void> {
  await assertDirectory(stagingDirectory);
  const target = path.join(stagingDirectory, fileName);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

async function validateStagedEntities(stagingDirectory: string): Promise<void> {
  await assertDirectory(stagingDirectory);
  const [metadata, requirements, review, verification] = await Promise.all([
    readStagedJson(stagingDirectory, 'metadata.json', parseWorkflowMetadata),
    readStagedJson(
      stagingDirectory,
      'requirements.json',
      parseRequirementsLedger,
    ),
    readStagedJson(stagingDirectory, 'review-ledger.json', parseReviewLedger),
    readStagedJson(stagingDirectory, 'verification-ledger.json', (value) =>
      parseVerificationLedger(value),
    ),
  ]);
  parseVerificationLedger(verification, requirements);
  buildTaskAggregateManifest({
    metadata,
    requirements,
    review,
    verification,
    planDigest: null,
    latestCheckpoint: null,
  });
}

async function readStagedJson<T>(
  stagingDirectory: string,
  fileName: string,
  parser: (value: unknown) => T,
): Promise<T> {
  const target = path.join(stagingDirectory, fileName);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const parsed = parser(JSON.parse(await readFile(target, 'utf8')));
  const after = await lstat(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  return parsed;
}

async function publishStagedTask(
  stagingDirectory: string,
  targetDirectory: string,
): Promise<void> {
  await assertDirectory(stagingDirectory);
  await validateStagedEntities(stagingDirectory);
  await assertDirectoryAbsent(
    targetDirectory,
    'MANCODE_WORKFLOW_ALREADY_EXISTS',
  );
  await rename(stagingDirectory, targetDirectory);
  await assertDirectory(targetDirectory);
}

async function advanceJournal(
  store: EntityHomeStore,
  previous: OperationJournalV1,
  stepId: string,
  now: Date,
  canAbort: boolean,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(previous.type);
  const next = {
    ...previous,
    state: 'applying' as const,
    steps: completeJournalStep(previous.steps, stepId),
    updatedAt: now.toISOString(),
  };
  const advanced = await updateOperationJournal(store, next, { canAbort });
  injectAfterWorkflowCreateStep(previous.type, stepId);
  return advanced;
}

async function commitJournal(
  store: EntityHomeStore,
  previous: OperationJournalV1,
  now: Date,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(previous.type);
  const committed = await updateOperationJournal(
    store,
    {
      ...previous,
      state: 'committed',
      steps: completeJournalStep(previous.steps, 'commit'),
      updatedAt: now.toISOString(),
    },
    { canAbort: false },
  );
  throwIfOperationCrashInjected(previous.type, 'commit');
  return committed;
}

function injectAfterWorkflowCreateStep(
  operationType: OperationJournalV1['type'],
  stepId: string,
): void {
  const step = getOperationDefinition(operationType).steps.find(
    (candidate) => candidate.id === stepId,
  );
  if (step?.visibility === 'business_write') {
    armOperationCrashAfterVisibleWrite(operationType, stepId);
    return;
  }
  throwIfOperationCrashInjected(operationType, stepId);
}

function completeJournalStep(
  steps: OperationStep[],
  requestedStepId: string,
): OperationStep[] {
  const index = steps.findIndex((step) => step.id === requestedStepId);
  if (index < 0) throw new Error('MANCODE_OPERATION_STEP_INVALID');
  if (steps[index]?.state === 'completed') {
    throw new Error('MANCODE_OPERATION_STEP_ALREADY_COMPLETED');
  }
  if (steps.slice(0, index).some((step) => step.state !== 'completed')) {
    throw new Error('MANCODE_OPERATION_STEP_ORDER_INVALID');
  }
  return steps.map((step, stepIndex) =>
    stepIndex === index ? { ...step, state: 'completed' as const } : step,
  );
}

function hasBusinessWriteIntent(journal: OperationJournalV1): boolean {
  const definition = getOperationDefinition(journal.type);
  return journal.steps.some(
    (step, index) =>
      step.state === 'completed' &&
      definition.steps[index]?.visibility === 'business_write',
  );
}

async function markRepairRequired(
  store: EntityHomeStore,
  journal: OperationJournalV1,
  now: Date,
): Promise<void> {
  if (journal.state === 'committed' || journal.state === 'aborted') return;
  try {
    await updateOperationJournal(
      store,
      { ...journal, state: 'repair_required', updatedAt: now.toISOString() },
      { canAbort: false },
    );
  } catch {
    // Preserve the primary error. The durable completed write-intent is still
    // enough for the resolver/reconciler to refuse ordinary mutations.
  }
}

async function abortPreparedCreate(
  store: EntityHomeStore,
  journal: OperationJournalV1,
  stagingDirectory: string,
  now: Date,
): Promise<void> {
  try {
    await updateOperationJournal(
      store,
      { ...journal, state: 'aborted', updatedAt: now.toISOString() },
      { canAbort: true },
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function assertDirectory(target: string): Promise<void> {
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function displaySlug(task: string): string {
  const normalized = task
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.slice(0, 80) || 'task';
}

function requireProjectRoot(value: string): string {
  if (!value.trim() || value.includes('\0')) {
    throw new Error('workflow projectRoot is required');
  }
  return value;
}

function requireText(value: string, label: string): string {
  if (!value.trim() || value.includes('\0')) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

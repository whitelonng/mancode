import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type EntityHomeStore,
  resolveTaskEntityHomeStore,
} from '../runtime/entity-home-store.js';
import {
  armOperationCrashAfterVisibleWrite,
  throwIfDeferredOperationCrashInjected,
  throwIfOperationCrashInjected,
} from '../runtime/operation-crash-injection.js';
import {
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from '../runtime/operation-definition.js';
import {
  type OperationJournalV1,
  withOperationReservationDigests,
} from '../runtime/operation-journal.js';
import {
  assertOperationRecoveryPayloadCoversJournal,
  createTaskAuthorityFileRecoveryAction,
  createTaskHeadFenceRecoveryAction,
  createWorkflowTaskDirectoryRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../runtime/operation-recovery-payload.js';
import { writeOperationRecoveryPayload } from '../runtime/operation-recovery-store.js';
import { removeOperationReservation } from '../runtime/operation-reservation.js';
import {
  prepareOperationStores,
  updateOperationJournal,
} from '../runtime/operation-store.js';
import {
  readCheckoutCodeHead,
  readProjectRuntimeContext,
} from '../runtime/project-runtime.js';
import {
  type TaskHeadFenceV1,
  parseTaskHeadFence,
} from '../runtime/task-head-fence.js';
import {
  createTaskHeadFence,
  readTaskHeadFence,
} from '../runtime/task-head-store.js';
import {
  type OpenedV3TaskOperation,
  openV3TaskOperation,
  serializeTaskAuthority,
  taskEntityKey,
  taskHeadEntityKey,
  writeTaskAuthorityFile,
} from '../runtime/task-operation.js';
import { readSharedActorProfile } from '../team/actor.js';
import { createAuthorizationBasis } from '../team/authorization.js';
import { capabilitiesFromProjectConfig } from '../team/transport.js';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
  taskAggregateDigest,
} from './aggregate.js';
import { digestCanonicalJson } from './canonical.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { assertSharedTextSafe } from './privacy.js';
import {
  type PromotionFromQuarantinePlanV1,
  type QuarantineArtifact,
  type QuarantineCandidateV1,
  confirmQuarantineCandidate,
  createQuarantineCandidate,
  markQuarantinePromoted,
  preparePromotionFromQuarantine,
  previewQuarantineCandidate,
  publishStagingDirectory,
  scanQuarantineCandidate,
  validateQuarantinePaths,
} from './quarantine.js';
import {
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from './requirements-ledger.js';
import {
  type ReviewLedgerV1,
  parseReviewLedger,
  reviewLedgerDigest,
} from './review-ledger.js';
import { type StoredTaskSnapshot, V3ContextStore } from './store.js';
import { taskRootPath } from './task-locator.js';
import { assertTaskCodeHeadUnchanged } from './task-mutation.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import {
  type VerificationLedgerV1,
  parseVerificationLedger,
  verificationLedgerDigest,
} from './verification-ledger.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export type PromotionDestinationMode = 'man' | 'manteam';

export interface PromoteV3TaskInput {
  projectRoot: string;
  sourceTaskRef: TaskRef;
  sessionId: Ulid;
  expectedSourceRevision: number;
  destinationWorkflowMode: PromotionDestinationMode;
  /** Explicit acknowledgement that the promoted authority becomes shared. */
  sharedPrivacyConfirmed: boolean;
  client: string;
  destinationTaskId?: Ulid;
  operationId?: Ulid;
  now?: Date;
}

export interface PromotedV3Task {
  sourceMetadata: WorkflowMetadataV3;
  destinationMetadata: WorkflowMetadataV3;
  destinationRequirements: RequirementsLedgerV1;
  destinationReview: ReviewLedgerV1;
  destinationVerification: VerificationLedgerV1;
  destinationAggregate: TaskAggregateManifestV1;
  destinationTaskHead: TaskHeadFenceV1;
  quarantine: QuarantineCandidateV1;
  promotion: PromotionFromQuarantinePlanV1;
  operation: OperationJournalV1;
}

export interface PreviewV3TaskPromotionInput {
  projectRoot: string;
  sourceTaskRef: TaskRef;
  sessionActorId: Ulid;
  expectedSourceRevision: number;
  destinationWorkflowMode: PromotionDestinationMode;
  client: string;
  now?: Date;
}

export interface PreviewedV3TaskPromotion {
  sourceMetadata: WorkflowMetadataV3;
  destination: {
    workflowMode: PromotionDestinationMode;
    visibility: 'shared';
    coordination: 'single' | 'team';
  };
  quarantine: QuarantineCandidateV1;
}

interface PromotionEntities {
  sourcePending: WorkflowMetadataV3;
  sourceSuperseded: WorkflowMetadataV3;
  destinationMetadata: WorkflowMetadataV3;
  destinationRequirements: RequirementsLedgerV1;
  destinationReview: ReviewLedgerV1;
  destinationVerification: VerificationLedgerV1;
  destinationPlan: string | null;
  destinationAggregate: TaskAggregateManifestV1;
  destinationTaskHead: TaskHeadFenceV1;
}

const INITIAL_WORKFLOW_FILES = [
  'metadata.json',
  'requirements.json',
  'review-ledger.json',
  'verification-ledger.json',
] as const;

/**
 * Produces a local-only privacy and eligibility preview. Promotion repeats
 * every check under its durable operation lock before writing authority.
 */
export async function previewV3TaskPromotion(
  input: PreviewV3TaskPromotionInput,
): Promise<PreviewedV3TaskPromotion> {
  const sourceTaskRef = parseTaskRefValue(input.sourceTaskRef);
  if (sourceTaskRef.namespace !== 'local') {
    throw new Error('MANCODE_PROMOTION_SOURCE_MUST_BE_LOCAL');
  }
  if (!Number.isSafeInteger(input.expectedSourceRevision)) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  assertUlid(input.sessionActorId, 'promotion preview sessionActorId');
  if (typeof input.client !== 'string' || !input.client.trim()) {
    throw new Error('MANCODE_CLIENT_INVALID');
  }
  if (
    input.destinationWorkflowMode !== 'man' &&
    input.destinationWorkflowMode !== 'manteam'
  ) {
    throw new Error('MANCODE_PROMOTION_DESTINATION_MODE_INVALID');
  }
  const now = input.now ?? new Date();
  const store = new V3ContextStore(input.projectRoot);
  const task = await store.readTaskSnapshot(sourceTaskRef);
  const metadata = task.metadata;
  if (metadata.revision !== input.expectedSourceRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  if (
    metadata.workflowMode !== 'man' ||
    metadata.visibility !== 'local' ||
    metadata.coordination !== 'single'
  ) {
    throw new Error('MANCODE_PROMOTION_SOURCE_COMBINATION_INVALID');
  }
  if (
    metadata.status !== 'in_progress' &&
    metadata.status !== 'planned' &&
    metadata.status !== 'blocked'
  ) {
    throw new Error('MANCODE_PROMOTION_SOURCE_NOT_ACTIVE');
  }
  if (metadata.ownerActorId !== input.sessionActorId) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
  if (
    metadata.governance.planDecision === 'solo_handoff' ||
    metadata.soloExecution !== null
  ) {
    throw new Error('MANCODE_PROMOTION_SOLO_HANDOFF_UNSUPPORTED');
  }
  if ((await store.listActiveChildTaskRefs(sourceTaskRef)).length > 0) {
    throw new Error('MANCODE_PROMOTION_ACTIVE_CHILDREN');
  }
  if (
    (await readSharedActorProfile(input.projectRoot, input.sessionActorId)) ===
    null
  ) {
    throw new Error('MANCODE_JOIN_REQUIRED');
  }
  assertPromotableReferencesForPreview(task);
  const contents = promotionPreviewContents(task);
  let quarantine = createQuarantineCandidate({
    quarantineId: createUlid(now.getTime()),
    purpose: 'publish_promote',
    sourceTaskRef,
    candidateTaskRef: sourceTaskRef,
    artifacts: Object.entries(contents).map(([relativePath, content]) => ({
      relativePath,
      classification: relativePath === 'plan.md' ? 'human_view' : 'authority',
      includeInPromotion: true,
      contentDigest: digestCanonicalJson({ content }),
    })),
    now,
  });
  quarantine = validateQuarantinePaths(quarantine, now);
  quarantine = scanQuarantineCandidate(
    quarantine,
    Object.values(contents),
    now,
  );
  quarantine = previewQuarantineCandidate(quarantine, now);
  return {
    sourceMetadata: metadata,
    destination: {
      workflowMode: input.destinationWorkflowMode,
      visibility: 'shared',
      coordination:
        input.destinationWorkflowMode === 'manteam' ? 'team' : 'single',
    },
    quarantine,
  };
}

/**
 * Creates a new shared successor for an active local `man` workflow. The
 * source is never rewritten in place: a privacy-screened destination is
 * published under a multi-store journal, then the local source becomes an
 * immutable superseded predecessor.
 */
export async function promoteV3Task(
  input: PromoteV3TaskInput,
): Promise<PromotedV3Task> {
  const sourceTaskRef = parseTaskRefValue(input.sourceTaskRef);
  if (sourceTaskRef.namespace !== 'local') {
    throw new Error('MANCODE_PROMOTION_SOURCE_MUST_BE_LOCAL');
  }
  if (!Number.isSafeInteger(input.expectedSourceRevision)) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  if (input.sharedPrivacyConfirmed !== true) {
    throw new Error('MANCODE_PRIVACY_CONFIRMATION_REQUIRED');
  }
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  const destinationTaskId =
    input.destinationTaskId ?? createUlid(now.getTime());
  assertUlid(operationId, 'publish/promote operationId');
  assertUlid(destinationTaskId, 'publish/promote destinationTaskId');
  if (operationId === destinationTaskId) {
    throw new Error('MANCODE_PROMOTION_ID_CONFLICT');
  }
  if (typeof input.client !== 'string' || !input.client.trim()) {
    throw new Error('MANCODE_CLIENT_INVALID');
  }
  const destinationTaskRef: TaskRef = {
    namespace: 'shared',
    taskId: destinationTaskId,
  };
  const preflightRuntime = await readProjectRuntimeContext(input.projectRoot);
  const destinationHomeStore = resolveTaskEntityHomeStore(
    preflightRuntime.entityHomeStoreContext,
    destinationTaskRef,
  );
  const sourceContext = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef: sourceTaskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedSourceRevision,
    operationId,
    additionalEntityLockTargets: [
      {
        store: destinationHomeStore,
        entityLockKeys: destinationEntityLockKeys(destinationTaskRef),
      },
    ],
    now,
  });
  let journal: OperationJournalV1 | null = null;
  let stagingDirectory: string | null = null;
  let quarantine: QuarantineCandidateV1 | null = null;
  try {
    await assertDestinationAbsent(
      sourceContext.projectRoot,
      destinationHomeStore,
      destinationTaskRef,
    );
    const destinationCoordination =
      await sourceContext.store.readCoordinationSnapshot(
        destinationTaskRef,
        destinationHomeStore,
      );
    if (destinationCoordination.pendingOperations.length > 0) {
      throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
    }
    await assertPromotionEligible(sourceContext, input.destinationWorkflowMode);
    if (
      (await readSharedActorProfile(
        sourceContext.projectRoot,
        sourceContext.session.actorId,
      )) === null
    ) {
      throw new Error('MANCODE_JOIN_REQUIRED');
    }
    const codeHead = await readCheckoutCodeHead(sourceContext.projectRoot);
    if (codeHead === null) {
      throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
    }
    const timestamp = sourceContext.now.toISOString();
    const entities = buildPromotionEntities({
      source: sourceContext,
      destinationTaskRef,
      destinationWorkflowMode: input.destinationWorkflowMode,
      operationId,
      client: input.client.trim(),
      codeHead,
      timestamp,
    });
    const stagedQuarantine = prepareQuarantine({
      sourceTaskRef,
      destinationTaskRef,
      operationId,
      actorId: sourceContext.session.actorId,
      entities,
      now: sourceContext.now,
    });
    quarantine = stagedQuarantine.candidate;
    await writePromotionQuarantine(
      sourceContext.projectRoot,
      operationId,
      quarantine,
      destinationAuthorityContents(entities),
    );

    const recoveryPayload = buildPromotionRecoveryPayload({
      operationId,
      primaryStoreId: destinationHomeStore.storeId,
      source: sourceContext,
      destinationTaskRef,
      entities,
    });
    const prepared = buildPromotionJournal({
      source: sourceContext,
      destinationHomeStore,
      destinationTaskRef,
      operationId,
      timestamp,
      recoveryPayloadDigest: operationRecoveryPayloadDigest(recoveryPayload),
    });
    assertOperationRecoveryPayloadCoversJournal(prepared, recoveryPayload);
    await writeOperationRecoveryPayload(destinationHomeStore, recoveryPayload);
    // The shared destination owns the primary journal. Before the local
    // reservation is durable no business authority has changed, so recovery
    // can safely abort this prepared operation.
    journal = prepared;
    await prepareOperationStores({
      primaryStore: destinationHomeStore,
      journal,
      secondaryStores: [sourceContext.homeStore],
      now: sourceContext.now,
    });
    throwIfOperationCrashInjected('publish_promote', 'prepared');

    journal = await advancePromotionOperation(
      sourceContext,
      destinationHomeStore,
      journal,
      'validate-privacy-and-paths',
      true,
    );
    journal = await advancePromotionOperation(
      sourceContext,
      destinationHomeStore,
      journal,
      'stage-destination',
      true,
    );
    stagingDirectory = await stageDestinationAuthority(
      sourceContext.projectRoot,
      destinationTaskRef,
      operationId,
      destinationAuthorityContents(entities),
    );

    journal = await advancePromotionOperation(
      sourceContext,
      destinationHomeStore,
      journal,
      'mark-source-operation-pending',
      false,
    );
    await writeTaskAuthorityFile(
      sourceContext,
      'metadata.json',
      serializeTaskAuthority(entities.sourcePending),
    );

    journal = await advancePromotionOperation(
      sourceContext,
      destinationHomeStore,
      journal,
      'publish-destination',
      false,
    );
    await publishStagedDestination(
      sourceContext.projectRoot,
      destinationTaskRef,
      stagingDirectory,
    );
    stagingDirectory = null;

    journal = await advancePromotionOperation(
      sourceContext,
      destinationHomeStore,
      journal,
      'write-source-successor',
      false,
    );
    await writeTaskAuthorityFile(
      sourceContext,
      'metadata.json',
      serializeTaskAuthority(entities.sourceSuperseded),
    );

    // V3 uses the shared task directory itself as the task locator. There is
    // no second mutable locator entity to publish between the directory and
    // its task-head fence.
    journal = await advancePromotionOperation(
      sourceContext,
      destinationHomeStore,
      journal,
      'publish-destination-locator',
      false,
    );
    journal = await advancePromotionOperation(
      sourceContext,
      destinationHomeStore,
      journal,
      'update-task-head-fence',
      false,
    );
    await assertTaskCodeHeadUnchanged(sourceContext.projectRoot, codeHead);
    await createTaskHeadFence(
      destinationHomeStore,
      entities.destinationTaskHead,
    );
    const operation = await commitPromotionOperation(
      sourceContext,
      destinationHomeStore,
      journal,
    );
    const promotedQuarantine = markQuarantinePromoted(
      quarantine,
      stagedQuarantine.promotion,
      sourceContext.now,
    );
    try {
      await rewritePromotionQuarantine(
        sourceContext.projectRoot,
        operationId,
        promotedQuarantine,
      );
    } catch {
      // The promotion's authority commit is complete. The quarantine manifest
      // is a local audit projection and must not roll the durable operation
      // back to a repair state.
    }
    return {
      sourceMetadata: entities.sourceSuperseded,
      destinationMetadata: entities.destinationMetadata,
      destinationRequirements: entities.destinationRequirements,
      destinationReview: entities.destinationReview,
      destinationVerification: entities.destinationVerification,
      destinationAggregate: entities.destinationAggregate,
      destinationTaskHead: entities.destinationTaskHead,
      quarantine: promotedQuarantine,
      promotion: stagedQuarantine.promotion,
      operation,
    };
  } catch (error) {
    if (journal !== null) {
      await handlePromotionFailure(
        sourceContext,
        destinationHomeStore,
        journal,
        stagingDirectory,
      );
    }
    throw error;
  } finally {
    await sourceContext.release();
  }
}

function buildPromotionEntities(input: {
  source: OpenedV3TaskOperation;
  destinationTaskRef: TaskRef;
  destinationWorkflowMode: PromotionDestinationMode;
  operationId: Ulid;
  client: string;
  codeHead: string;
  timestamp: string;
}): PromotionEntities {
  assertPromotableReferences(input.source);
  const requirementsDraft: RequirementsLedgerV1 = {
    ...input.source.task.requirements,
    taskRef: input.destinationTaskRef,
    revision: 1,
    contentDigest: '',
    lastOperationId: input.operationId,
    updatedAt: input.timestamp,
  };
  const destinationRequirements = parseRequirementsLedger({
    ...requirementsDraft,
    contentDigest: requirementsLedgerDigest(requirementsDraft),
  });
  const reviewDraft: ReviewLedgerV1 = {
    ...input.source.task.review,
    taskRef: input.destinationTaskRef,
    revision: 1,
    requirementsDigest: destinationRequirements.contentDigest,
    contentDigest: '',
    lastOperationId: input.operationId,
    updatedAt: input.timestamp,
  };
  const destinationReview = parseReviewLedger({
    ...reviewDraft,
    contentDigest: reviewLedgerDigest(reviewDraft),
  });
  const verificationDraft: VerificationLedgerV1 = {
    ...input.source.task.verification,
    taskRef: input.destinationTaskRef,
    revision: 1,
    requirementsDigest: destinationRequirements.contentDigest,
    contentDigest: '',
    lastOperationId: input.operationId,
    updatedAt: input.timestamp,
  };
  const destinationVerification = parseVerificationLedger(
    {
      ...verificationDraft,
      contentDigest: verificationLedgerDigest(verificationDraft),
    },
    destinationRequirements,
  );
  const destinationPlan = input.source.task.plan?.content ?? null;
  if (destinationPlan !== null) {
    assertSharedPromotionText(destinationPlan, 'plan');
  }
  const destinationMetadata = parseWorkflowMetadata({
    ...input.source.task.metadata,
    taskRef: input.destinationTaskRef,
    workflowMode: input.destinationWorkflowMode,
    visibility: 'shared',
    coordination:
      input.destinationWorkflowMode === 'manteam' ? 'team' : 'single',
    revision: 1,
    transitionState: 'stable',
    lastOperationId: input.operationId,
    ownerActorId: input.source.session.actorId,
    ownershipEpoch: 1,
    participants: [input.source.session.actorId],
    createdBy: {
      actorId: input.source.session.actorId,
      client: input.client,
      source: 'actor',
    },
    governance: {
      ...input.source.task.metadata.governance,
      requirementsDigest: destinationRequirements.contentDigest,
      reviewStatus: destinationReview.status,
      reviewLedgerDigest: destinationReview.contentDigest,
      verificationStatus: destinationVerification.status,
      verificationLedgerDigest: destinationVerification.contentDigest,
    },
    soloExecution: null,
    latestCheckpointRef: null,
    parent: null,
    successorTaskRef: null,
    legacyCompatibility: null,
    startedAt: input.timestamp,
    updatedAt: input.timestamp,
  });
  const planDigest =
    destinationPlan === null
      ? null
      : digestCanonicalJson({
          artifactRef: { taskRef: input.destinationTaskRef, kind: 'plan' },
          content: destinationPlan,
        });
  const destinationAggregate = buildTaskAggregateManifest({
    metadata: destinationMetadata,
    requirements: destinationRequirements,
    review: destinationReview,
    verification: destinationVerification,
    planDigest,
    latestCheckpoint: null,
  });
  const destinationTaskHead = parseTaskHeadFence({
    schemaVersion: 1,
    workspaceId: input.source.runtime.workspaceId,
    taskRef: input.destinationTaskRef,
    fenceRevision: 1,
    taskRevision: destinationMetadata.revision,
    aggregateDigest: taskAggregateDigest(destinationAggregate),
    ownershipEpoch: destinationMetadata.ownershipEpoch,
    codeRef: { head: input.codeHead },
    checkoutId: input.source.runtime.checkoutId,
    remoteRevision: null,
    lastOperationId: input.operationId,
    updatedAt: input.timestamp,
  });
  const sourcePending = parseWorkflowMetadata({
    ...input.source.task.metadata,
    revision: input.source.task.metadata.revision + 1,
    transitionState: 'operation_pending',
    lastOperationId: input.operationId,
    updatedAt: input.timestamp,
  });
  assertWorkflowMetadataTransition(
    input.source.task.metadata,
    sourcePending,
    'ordinary',
  );
  const sourceSuperseded = parseWorkflowMetadata({
    ...sourcePending,
    status: 'superseded',
    revision: sourcePending.revision + 1,
    transitionState: 'stable',
    lastOperationId: input.operationId,
    successorTaskRef: input.destinationTaskRef,
    updatedAt: input.timestamp,
  });
  assertWorkflowMetadataTransition(
    sourcePending,
    sourceSuperseded,
    input.destinationWorkflowMode === 'man' ? 'publish' : 'promote',
  );
  return {
    sourcePending,
    sourceSuperseded,
    destinationMetadata,
    destinationRequirements,
    destinationReview,
    destinationVerification,
    destinationPlan,
    destinationAggregate,
    destinationTaskHead,
  };
}

function buildPromotionJournal(input: {
  source: OpenedV3TaskOperation;
  destinationHomeStore: EntityHomeStore;
  destinationTaskRef: TaskRef;
  operationId: Ulid;
  timestamp: string;
  recoveryPayloadDigest: string;
}): OperationJournalV1 {
  const destinationLockKeys = destinationEntityLockKeys(
    input.destinationTaskRef,
  );
  const authorizationBasis = createAuthorizationBasis(
    {
      action: 'shared_create_publish_promote',
      actorId: input.source.session.actorId,
      session: {
        sessionId: input.source.session.sessionId,
        actorId: input.source.session.actorId,
        status: input.source.session.status,
      },
      joined: true,
      sharedWriteGuard: capabilitiesFromProjectConfig(
        input.source.project.config,
      ).writeGuard,
      task: {
        ownerActorId: input.source.task.metadata.ownerActorId,
        participantActorIds: input.source.task.metadata.participants,
      },
      claim: null,
      handoff: null,
      evidence: null,
      profileActorId: null,
      conditions: {
        expectedRevisionMatches: true,
        privacyConfirmed: true,
      },
    },
    input.source.now,
  );
  const definition = getOperationDefinition('publish_promote');
  const journal: OperationJournalV1 = {
    schemaVersion: 1,
    operationId: input.operationId,
    type: 'publish_promote',
    state: 'prepared',
    primaryStoreId: input.destinationHomeStore.storeId,
    checkoutId: input.source.runtime.checkoutId,
    secondaryReservations: [
      {
        storeId: input.source.homeStore.storeId,
        entityKeys: input.source.entityLocks,
        journalDigest: '',
      },
    ],
    actorId: input.source.session.actorId,
    sessionId: input.source.session.sessionId,
    authorizationBasis,
    recoveryPayloadDigest: input.recoveryPayloadDigest,
    entityLocks: uniqueLockKeys([
      ...input.source.entityLocks,
      ...destinationLockKeys,
    ]),
    expectedRevisions: {
      [taskEntityKey(input.source.taskRef)]:
        input.source.task.metadata.revision,
      [taskEntityKey(input.destinationTaskRef)]: 0,
      [`locator:shared:${input.destinationTaskRef.taskId}`]: 0,
      [taskHeadEntityKey(input.destinationTaskRef)]: 0,
    },
    steps: definition.steps.map((step) => ({ id: step.id, state: 'pending' })),
    startedAt: input.timestamp,
    updatedAt: input.timestamp,
  };
  const bound = withOperationReservationDigests(journal);
  assertOperationJournalMatchesDefinition(bound);
  return bound;
}

function buildPromotionRecoveryPayload(input: {
  operationId: Ulid;
  primaryStoreId: string;
  source: OpenedV3TaskOperation;
  destinationTaskRef: TaskRef;
  entities: PromotionEntities;
}) {
  const files = destinationAuthorityContents(input.entities);
  return parseOperationRecoveryPayload({
    schemaVersion: 1,
    operationId: input.operationId,
    type: 'publish_promote',
    primaryStoreId: input.primaryStoreId,
    actions: [
      createTaskAuthorityFileRecoveryAction({
        stepId: 'mark-source-operation-pending',
        taskRef: input.source.taskRef,
        fileName: 'metadata.json',
        beforeContent: serializeTaskAuthority(input.source.task.metadata),
        targetContent: serializeTaskAuthority(input.entities.sourcePending),
      }),
      createWorkflowTaskDirectoryRecoveryAction({
        stepId: 'publish-destination',
        taskRef: input.destinationTaskRef,
        files: [
          ...INITIAL_WORKFLOW_FILES.map((fileName) => ({
            fileName,
            content: files[fileName],
          })),
          ...(input.entities.destinationPlan === null
            ? []
            : [
                {
                  fileName: 'plan.md' as const,
                  content: input.entities.destinationPlan,
                },
              ]),
        ],
      }),
      createTaskAuthorityFileRecoveryAction({
        stepId: 'write-source-successor',
        taskRef: input.source.taskRef,
        fileName: 'metadata.json',
        beforeContent: serializeTaskAuthority(input.entities.sourcePending),
        targetContent: serializeTaskAuthority(input.entities.sourceSuperseded),
      }),
      createTaskHeadFenceRecoveryAction({
        stepId: 'update-task-head-fence',
        before: null,
        fence: input.entities.destinationTaskHead,
      }),
    ],
    noOpStepIds: ['publish-destination-locator'],
  });
}

function prepareQuarantine(input: {
  sourceTaskRef: TaskRef;
  destinationTaskRef: TaskRef;
  operationId: Ulid;
  actorId: Ulid;
  entities: PromotionEntities;
  now: Date;
}): {
  candidate: QuarantineCandidateV1;
  promotion: PromotionFromQuarantinePlanV1;
} {
  const contents = destinationAuthorityContents(input.entities);
  const artifacts: QuarantineArtifact[] = Object.entries(contents).map(
    ([relativePath, content]) => ({
      relativePath,
      classification: relativePath === 'plan.md' ? 'human_view' : 'authority',
      includeInPromotion: true,
      contentDigest: digestCanonicalJson({ content }),
    }),
  );
  let candidate = createQuarantineCandidate({
    quarantineId: input.operationId,
    purpose: 'publish_promote',
    sourceTaskRef: input.sourceTaskRef,
    candidateTaskRef: input.sourceTaskRef,
    artifacts,
    now: input.now,
  });
  candidate = validateQuarantinePaths(candidate, input.now);
  candidate = scanQuarantineCandidate(
    candidate,
    Object.values(contents),
    input.now,
  );
  candidate = previewQuarantineCandidate(candidate, input.now);
  candidate = confirmQuarantineCandidate(candidate, input.actorId, input.now);
  const promotion = preparePromotionFromQuarantine(
    candidate,
    input.destinationTaskRef,
    input.operationId,
  );
  return { candidate, promotion };
}

function destinationAuthorityContents(
  entities: PromotionEntities,
): Record<(typeof INITIAL_WORKFLOW_FILES)[number] | 'plan.md', string> {
  const contents: Record<string, string> = {
    'metadata.json': serializeTaskAuthority(entities.destinationMetadata),
    'requirements.json': serializeTaskAuthority(
      entities.destinationRequirements,
    ),
    'review-ledger.json': serializeTaskAuthority(entities.destinationReview),
    'verification-ledger.json': serializeTaskAuthority(
      entities.destinationVerification,
    ),
  };
  if (entities.destinationPlan !== null) {
    contents['plan.md'] = entities.destinationPlan;
  }
  return contents as Record<
    (typeof INITIAL_WORKFLOW_FILES)[number] | 'plan.md',
    string
  >;
}

async function stageDestinationAuthority(
  projectRoot: string,
  destinationTaskRef: TaskRef,
  operationId: Ulid,
  contents: Record<string, string>,
): Promise<string> {
  const target = taskRootPath(projectRoot, destinationTaskRef);
  const parent = await ensureSafeTaskParent(projectRoot, destinationTaskRef);
  await assertPathAbsent(target, 'MANCODE_PROMOTION_DESTINATION_EXISTS');
  const staging = path.join(
    parent,
    `.${destinationTaskRef.taskId}.${operationId}.staging`,
  );
  await assertPathAbsent(staging, 'MANCODE_PROMOTION_STAGING_CONFLICT');
  await mkdir(staging);
  try {
    for (const [fileName, content] of Object.entries(contents)) {
      await writeFile(path.join(staging, fileName), content, {
        encoding: 'utf8',
        flag: 'wx',
      });
    }
    await assertSafeDirectory(staging);
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function ensureSafeTaskParent(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<string> {
  await assertSafeDirectory(projectRoot);
  let current = projectRoot;
  for (const segment of ['.mancode', taskRef.namespace, 'workflows']) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing === null) {
      try {
        await mkdir(current);
        continue;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
    const checked = existing ?? (await lstat(current));
    if (!checked.isDirectory() || checked.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  }
  return current;
}

async function publishStagedDestination(
  projectRoot: string,
  destinationTaskRef: TaskRef,
  staging: string,
): Promise<void> {
  const target = taskRootPath(projectRoot, destinationTaskRef);
  await assertSafeDirectory(staging);
  await assertPathAbsent(target, 'MANCODE_PROMOTION_DESTINATION_EXISTS');
  await rename(staging, target);
  await assertSafeDirectory(target);
}

async function assertDestinationAbsent(
  projectRoot: string,
  destinationHomeStore: EntityHomeStore,
  destinationTaskRef: TaskRef,
): Promise<void> {
  await assertPathAbsent(
    taskRootPath(projectRoot, destinationTaskRef),
    'MANCODE_PROMOTION_DESTINATION_EXISTS',
  );
  if (
    (await readTaskHeadFence(destinationHomeStore, destinationTaskRef)) !== null
  ) {
    throw new Error('MANCODE_PROMOTION_DESTINATION_EXISTS');
  }
}

async function assertPromotionEligible(
  context: OpenedV3TaskOperation,
  destinationWorkflowMode: PromotionDestinationMode,
): Promise<void> {
  const metadata = context.task.metadata;
  if (
    metadata.workflowMode !== 'man' ||
    metadata.visibility !== 'local' ||
    metadata.coordination !== 'single'
  ) {
    throw new Error('MANCODE_PROMOTION_SOURCE_COMBINATION_INVALID');
  }
  if (
    metadata.status !== 'in_progress' &&
    metadata.status !== 'planned' &&
    metadata.status !== 'blocked'
  ) {
    throw new Error('MANCODE_PROMOTION_SOURCE_NOT_ACTIVE');
  }
  if (metadata.ownerActorId !== context.session.actorId) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
  if (
    metadata.governance.planDecision === 'solo_handoff' ||
    metadata.soloExecution !== null
  ) {
    throw new Error('MANCODE_PROMOTION_SOLO_HANDOFF_UNSUPPORTED');
  }
  const activeChildren = await context.store.listActiveChildTaskRefs(
    context.taskRef,
  );
  if (activeChildren.length > 0) {
    throw new Error('MANCODE_PROMOTION_ACTIVE_CHILDREN');
  }
  if (
    destinationWorkflowMode !== 'man' &&
    destinationWorkflowMode !== 'manteam'
  ) {
    throw new Error('MANCODE_PROMOTION_DESTINATION_MODE_INVALID');
  }
}

function assertPromotableReferences(context: OpenedV3TaskOperation): void {
  if (
    context.task.review.domains.some((domain) => domain.reportRef !== null) ||
    context.task.verification.checks.some(
      (check) =>
        check.automated?.artifactRef !== null ||
        check.manual?.artifactRef !== null,
    )
  ) {
    throw new Error('MANCODE_RAW_ARTIFACT_CANNOT_BE_PROMOTED');
  }
}

function assertPromotableReferencesForPreview(task: StoredTaskSnapshot): void {
  if (
    task.review.domains.some((domain) => domain.reportRef !== null) ||
    task.verification.checks.some(
      (check) =>
        check.automated?.artifactRef !== null ||
        check.manual?.artifactRef !== null,
    )
  ) {
    throw new Error('MANCODE_RAW_ARTIFACT_CANNOT_BE_PROMOTED');
  }
}

function promotionPreviewContents(
  task: StoredTaskSnapshot,
): Record<(typeof INITIAL_WORKFLOW_FILES)[number] | 'plan.md', string> {
  const contents: Record<string, string> = {
    'metadata.json': serializeTaskAuthority(task.metadata),
    'requirements.json': serializeTaskAuthority(task.requirements),
    'review-ledger.json': serializeTaskAuthority(task.review),
    'verification-ledger.json': serializeTaskAuthority(task.verification),
  };
  if (task.plan !== null) {
    assertSharedPromotionText(task.plan.content, 'plan');
    contents['plan.md'] = task.plan.content;
  }
  return contents as Record<
    (typeof INITIAL_WORKFLOW_FILES)[number] | 'plan.md',
    string
  >;
}

function assertSharedPromotionText(value: string, label: string): void {
  if (!value.trim() || value.includes('\0')) {
    throw new Error(`MANCODE_PROMOTION_${label.toUpperCase()}_INVALID`);
  }
  assertSharedTextSafe(value, `promotion ${label}`);
}

function destinationEntityLockKeys(taskRef: TaskRef): string[] {
  return [
    taskEntityKey(taskRef),
    `locator:shared:${taskRef.taskId}`,
    taskHeadEntityKey(taskRef),
  ];
}

async function advancePromotionOperation(
  source: OpenedV3TaskOperation,
  primaryStore: EntityHomeStore,
  previous: OperationJournalV1,
  stepId: string,
  canAbort: boolean,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(previous.type);
  await renewPromotionLocks(source);
  const advanced = await updateOperationJournal(
    primaryStore,
    {
      ...previous,
      state: 'applying',
      steps: completeOperationStep(previous.steps, stepId),
      updatedAt: source.now.toISOString(),
    },
    { canAbort },
  );
  injectAfterPromotionStep(previous.type, stepId);
  return advanced;
}

async function commitPromotionOperation(
  source: OpenedV3TaskOperation,
  primaryStore: EntityHomeStore,
  previous: OperationJournalV1,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(previous.type);
  await renewPromotionLocks(source);
  const committed = await updateOperationJournal(
    primaryStore,
    {
      ...previous,
      state: 'committed',
      steps: completeOperationStep(previous.steps, 'commit'),
      updatedAt: source.now.toISOString(),
    },
    { canAbort: false },
  );
  throwIfOperationCrashInjected(previous.type, 'commit');
  return committed;
}

function injectAfterPromotionStep(
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

async function handlePromotionFailure(
  source: OpenedV3TaskOperation,
  primaryStore: EntityHomeStore,
  journal: OperationJournalV1,
  stagingDirectory: string | null,
): Promise<void> {
  if (journal.state === 'committed' || journal.state === 'aborted') return;
  if (hasBusinessWriteIntent(journal)) {
    try {
      await renewPromotionLocks(source);
      await updateOperationJournal(
        primaryStore,
        {
          ...journal,
          state: 'repair_required',
          updatedAt: source.now.toISOString(),
        },
        { canAbort: false },
      );
    } catch {
      // The durable business write intent remains a resolver-visible blocker.
    }
    return;
  }
  try {
    await renewPromotionLocks(source);
    const aborted = await updateOperationJournal(
      primaryStore,
      {
        ...journal,
        state: 'aborted',
        updatedAt: source.now.toISOString(),
      },
      { canAbort: true },
    );
    await removeOperationReservation(
      source.homeStore,
      aborted.operationId,
      aborted.primaryStoreId,
    );
  } catch {
    // Preserve the command's original failure. The prepared journal is still
    // available to the doctor if compensation itself could not finish.
  } finally {
    if (stagingDirectory !== null) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

async function renewPromotionLocks(
  source: OpenedV3TaskOperation,
): Promise<void> {
  await source.renewLocks();
}

async function writePromotionQuarantine(
  projectRoot: string,
  operationId: Ulid,
  candidate: QuarantineCandidateV1,
  contents: Record<string, string>,
): Promise<void> {
  const directory = publishStagingDirectory(projectRoot, operationId);
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true });
  await assertSafeDirectory(parent);
  await assertPathAbsent(directory, 'MANCODE_PROMOTION_QUARANTINE_CONFLICT');
  await mkdir(directory);
  try {
    await writeFile(
      path.join(directory, 'candidate.json'),
      serializeTaskAuthority(candidate),
      { encoding: 'utf8', flag: 'wx' },
    );
    for (const [fileName, content] of Object.entries(contents)) {
      await writeFile(path.join(directory, fileName), content, {
        encoding: 'utf8',
        flag: 'wx',
      });
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function rewritePromotionQuarantine(
  projectRoot: string,
  operationId: Ulid,
  candidate: QuarantineCandidateV1,
): Promise<void> {
  const directory = publishStagingDirectory(projectRoot, operationId);
  await assertSafeDirectory(directory);
  const target = path.join(directory, 'candidate.json');
  const temporary = path.join(
    directory,
    `.candidate.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, serializeTaskAuthority(candidate), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporary, target);
}

function completeOperationStep(
  steps: OperationJournalV1['steps'],
  stepId: string,
): OperationJournalV1['steps'] {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error('MANCODE_OPERATION_STEP_INVALID');
  if (steps[index]?.state === 'completed') {
    throw new Error('MANCODE_OPERATION_STEP_ALREADY_COMPLETED');
  }
  if (steps.slice(0, index).some((step) => step.state !== 'completed')) {
    throw new Error('MANCODE_OPERATION_STEP_ORDER_INVALID');
  }
  return steps.map((step, currentIndex) =>
    currentIndex === index ? { ...step, state: 'completed' as const } : step,
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

function uniqueLockKeys(keys: string[]): string[] {
  return [...new Set(keys)].sort((left, right) =>
    Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
  );
}

async function assertPathAbsent(target: string, code: string): Promise<void> {
  const entry = await lstatOrNull(target);
  if (entry === null) return;
  if (entry.isSymbolicLink()) throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  throw new Error(code);
}

async function assertSafeDirectory(target: string): Promise<void> {
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

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

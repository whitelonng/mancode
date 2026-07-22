import { updateClaim } from '../runtime/claim-store.js';
import { resolveTaskEntityHomeStore } from '../runtime/entity-home-store.js';
import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import {
  type TaskArchiveManifestV1,
  type TaskArchiveRecoveryAction,
  createCheckpointRecoveryAction,
  createClaimRecoveryAction,
  createTaskArchiveRecoveryAction,
  createTaskAuthorityFileRecoveryAction,
  createTaskHeadFenceRecoveryAction,
  taskArchiveManifest,
} from '../runtime/operation-recovery-payload.js';
import {
  readCheckoutBranch,
  readProjectRuntimeContext,
} from '../runtime/project-runtime.js';
import {
  enqueueSessionPointerProjection,
  reconcileProjectionIntents,
} from '../runtime/projection-outbox.js';
import type { TaskHeadFenceV1 } from '../runtime/task-head-fence.js';
import { replaceTaskHeadFence } from '../runtime/task-head-store.js';
import {
  type OpenedV3TaskOperation,
  advanceTaskOperation,
  commitTaskOperation,
  createTaskOperationJournal,
  handleTaskOperationFailure,
  openV3TaskOperation,
  readTaskAuthorityFileAtRoot,
  serializeTaskAuthority,
  taskHeadEntityKey,
  writeTaskArchive,
  writeTaskAuthorityFile,
  writeTaskCheckpoint,
} from '../runtime/task-operation.js';
import { type CheckpointV1, parseCheckpoint } from '../team/checkpoints.js';
import {
  type ClaimV1,
  assertClaimTransition,
  parseClaim,
} from '../team/claims.js';
import { deriveClaimValidity } from '../team/conflicts.js';
import type { HandoffV1 } from '../team/handoff.js';
import {
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
} from './aggregate.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import {
  type RequirementsLedgerV1,
  assertRequirementsLedgerTransition,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from './requirements-ledger.js';
import type { ReviewLedgerV1 } from './review-ledger.js';
import { V3ContextStore } from './store.js';
import {
  assertTaskCodeHeadUnchanged,
  markTaskReviewStale,
  markTaskVerificationStale,
  nextTaskHeadFence,
  taskMutationExpectedRevisions,
} from './task-mutation.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import type { VerificationLedgerV1 } from './verification-ledger.js';
import {
  type WorkflowMetadataV3,
  assertWorkflowMetadataTransition,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface ReframeV3WorkflowInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  checkpointId: Ulid;
  summary?: string;
  nextAction?: string;
  operationId?: Ulid;
  now?: Date;
}

export type ReframeArchiveSummary = Pick<
  TaskArchiveManifestV1,
  | 'archiveId'
  | 'taskRef'
  | 'sourceTaskRevision'
  | 'sourceRequirementsRevision'
  | 'sourceRequirementsDigest'
  | 'sourcePlanVersion'
  | 'sourcePlanDigest'
  | 'createdAt'
>;

export interface ReframedV3Workflow {
  metadata: WorkflowMetadataV3;
  requirements: RequirementsLedgerV1;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  checkpoint: CheckpointV1;
  releasedClaims: ClaimV1[];
  archive: ReframeArchiveSummary;
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1 | null;
  operation: OperationJournalV1;
}

/** Reopens requirements clarification without losing prior authority evidence. */
export async function reframeV3Workflow(
  input: ReframeV3WorkflowInput,
): Promise<ReframedV3Workflow> {
  const taskRef = parseTaskRefValue(input.taskRef);
  assertUlid(input.checkpointId, 'reframe checkpointId');
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'reframe operationId');

  const opened = await openReframeContext({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    checkpointId: input.checkpointId,
    operationId,
    now,
  });
  const { context, activeClaims, openHandoffs, activeChildren } = opened;
  let journal: OperationJournalV1 | null = null;
  try {
    assertReframeEligible(context, activeClaims, openHandoffs, activeChildren);
    assertReframeClaimsFresh(context, activeClaims);

    const timestamp = context.now.toISOString();
    const archivedRequirementsContent = await readTaskAuthorityFileAtRoot(
      context.task.location.taskRoot,
      'requirements.json',
    );
    if (archivedRequirementsContent === null) {
      throw new Error('MANCODE_REFRAME_REQUIREMENTS_MISSING');
    }
    const pendingMetadata = markReframeOperationPending(
      context.task.metadata,
      context.operationId,
      timestamp,
    );
    const requirements = createReframedRequirements(
      context.task.requirements,
      context.operationId,
      timestamp,
    );
    const review = markTaskReviewStale(
      context.task.review,
      context.operationId,
      timestamp,
    );
    const verification = markTaskVerificationStale(
      context.task.verification,
      context.operationId,
      timestamp,
    );
    const releasedClaims = activeClaims.map((claim) =>
      releaseClaimForReframe(claim, context.operationId, timestamp),
    );
    const archiveAction = createTaskArchiveRecoveryAction({
      stepId: 'archive-requirements-plan',
      taskRef,
      archiveId: context.operationId,
      sourceTaskRevision: context.task.metadata.revision,
      sourcePlanVersion: context.task.metadata.governance.planVersion,
      createdAt: timestamp,
      requirementsContent: archivedRequirementsContent,
      planContent: context.task.plan?.content ?? null,
    });
    const branch = await readCheckoutBranch(context.projectRoot);
    const checkpoint = buildReframeCheckpoint({
      context,
      checkpointId: input.checkpointId,
      taskRevision: pendingMetadata.revision + 1,
      requirements,
      review,
      verification,
      summary: input.summary,
      nextAction: input.nextAction,
      branch,
      timestamp,
    });
    const metadata = completeReframeMetadata(
      pendingMetadata,
      requirements,
      review,
      verification,
      checkpoint,
      context.operationId,
      timestamp,
    );
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements,
      review,
      verification,
      planDigest: context.task.plan?.digest ?? null,
      latestCheckpoint: checkpoint,
    });
    const taskHeadFence = nextTaskHeadFence(context, aggregate, timestamp);
    const refreshesSessionPointer =
      context.session.activeTaskRef !== null &&
      sameTaskRef(context.session.activeTaskRef, taskRef);
    if (refreshesSessionPointer) {
      await enqueueSessionPointerProjection(context.projectRoot, {
        operationId: context.operationId,
        action: 'resume',
        sessionId: context.session.sessionId,
        expectedPreviousTaskRef: context.session.activeTaskRef,
        taskRef,
        workflowMode: metadata.workflowMode,
        taskRevision: metadata.revision,
        now: context.now,
      });
    }

    journal = await createTaskOperationJournal(context, {
      type: 'reframe',
      action:
        taskRef.namespace === 'shared'
          ? 'shared_metadata_plan_mutation'
          : 'local_workflow_mutation',
      expectedRevisions: reframeExpectedRevisions(
        context,
        input.checkpointId,
        activeClaims,
      ),
      recovery: {
        actions: [
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-task-operation-pending',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(context.task.metadata),
            targetContent: serializeTaskAuthority(pendingMetadata),
          }),
          archiveAction,
          ...releasedClaims.map((claim, index) =>
            createClaimRecoveryAction({
              stepId: 'release-active-claims',
              before: activeClaims[index] ?? null,
              claim,
            }),
          ),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'write-requirements-draft',
            taskRef,
            fileName: 'requirements.json',
            beforeContent: serializeTaskAuthority(context.task.requirements),
            targetContent: serializeTaskAuthority(requirements),
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-review-verification-stale',
            taskRef,
            fileName: 'review-ledger.json',
            beforeContent: serializeTaskAuthority(context.task.review),
            targetContent: serializeTaskAuthority(review),
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'mark-review-verification-stale',
            taskRef,
            fileName: 'verification-ledger.json',
            beforeContent: serializeTaskAuthority(context.task.verification),
            targetContent: serializeTaskAuthority(verification),
          }),
          createCheckpointRecoveryAction({
            stepId: 'write-reframe-checkpoint',
            before: null,
            checkpoint,
          }),
          createTaskAuthorityFileRecoveryAction({
            stepId: 'commit-reframed-metadata',
            taskRef,
            fileName: 'metadata.json',
            beforeContent: serializeTaskAuthority(pendingMetadata),
            targetContent: serializeTaskAuthority(metadata),
          }),
          ...(taskHeadFence === null
            ? []
            : [
                createTaskHeadFenceRecoveryAction({
                  stepId: 'update-task-head-fence',
                  before: context.coordination.taskHeadFence,
                  fence: taskHeadFence,
                }),
              ]),
        ],
        noOpStepIds: [
          ...(releasedClaims.length === 0 ? ['release-active-claims'] : []),
          ...(taskHeadFence === null ? ['update-task-head-fence'] : []),
        ],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);

    journal = await advanceTaskOperation(
      context,
      journal,
      'mark-task-operation-pending',
      false,
    );
    await assertReframeCodeHeadUnchanged(context);
    await writeTaskAuthorityFile(
      context,
      'metadata.json',
      serializeTaskAuthority(pendingMetadata),
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'archive-requirements-plan',
      false,
    );
    await assertReframeCodeHeadUnchanged(context);
    await writeTaskArchive(context, archiveAction);

    journal = await advanceTaskOperation(
      context,
      journal,
      'release-active-claims',
      false,
    );
    await assertReframeCodeHeadUnchanged(context);
    for (const [index, claim] of releasedClaims.entries()) {
      const previous = activeClaims[index];
      if (previous === undefined) throw new Error('MANCODE_CLAIM_SET_CHANGED');
      await updateClaim(context.homeStore, claim, previous.revision);
    }

    journal = await advanceTaskOperation(
      context,
      journal,
      'write-requirements-draft',
      false,
    );
    await assertReframeCodeHeadUnchanged(context);
    await writeTaskAuthorityFile(
      context,
      'requirements.json',
      serializeTaskAuthority(requirements),
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'mark-review-verification-stale',
      false,
    );
    await assertReframeCodeHeadUnchanged(context);
    await writeTaskAuthorityFile(
      context,
      'review-ledger.json',
      serializeTaskAuthority(review),
    );
    await writeTaskAuthorityFile(
      context,
      'verification-ledger.json',
      serializeTaskAuthority(verification),
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'write-reframe-checkpoint',
      false,
    );
    await assertReframeCodeHeadUnchanged(context);
    await writeTaskCheckpoint(context, checkpoint);

    journal = await advanceTaskOperation(
      context,
      journal,
      'commit-reframed-metadata',
      false,
    );
    await assertReframeCodeHeadUnchanged(context);
    await writeTaskAuthorityFile(
      context,
      'metadata.json',
      serializeTaskAuthority(metadata),
    );

    journal = await advanceTaskOperation(
      context,
      journal,
      'update-task-head-fence',
      false,
    );
    if (taskHeadFence !== null) {
      await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
      await replaceTaskHeadFence(context.homeStore, taskHeadFence);
    }
    const operation = await commitTaskOperation(context, journal);
    if (refreshesSessionPointer) {
      try {
        await reconcileProjectionIntents(
          context.projectRoot,
          context.operationId,
          context.now,
        );
      } catch {
        // Reframed authority is committed; doctor can finish the projection.
      }
    }
    const archive = archiveSummary(archiveAction);
    return {
      metadata,
      requirements,
      review,
      verification,
      checkpoint,
      releasedClaims,
      archive,
      aggregate,
      taskHeadFence,
      operation,
    };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // The journal and recovery payload still block ordinary mutation.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

interface OpenReframeContextInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  checkpointId: Ulid;
  operationId: Ulid;
  now: Date;
}

interface OpenedReframeContext {
  context: OpenedV3TaskOperation;
  activeClaims: ClaimV1[];
  openHandoffs: HandoffV1[];
  activeChildren: TaskRef[];
}

async function openReframeContext(
  input: OpenReframeContextInput,
): Promise<OpenedReframeContext> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const runtime = await readProjectRuntimeContext(input.projectRoot);
    const store = new V3ContextStore(input.projectRoot);
    const project = await store.readProjectSnapshot();
    if (project.config.transport.mode !== 'local') {
      throw new Error('MANCODE_REFRAME_GIT_REF_UNSUPPORTED');
    }
    const homeStore = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      input.taskRef,
    );
    const preflight = await store.readCoordinationSnapshot(
      input.taskRef,
      homeStore,
    );
    const preflightClaims = activeTaskClaims(preflight.claims);
    const preflightHandoffs = openTaskHandoffs(preflight.handoffs);
    const context = await openV3TaskOperation({
      projectRoot: input.projectRoot,
      taskRef: input.taskRef,
      sessionId: input.sessionId,
      expectedTaskRevision: input.expectedTaskRevision,
      operationId: input.operationId,
      compatibilityOperation: 'reframe',
      extraEntityLocks: [
        `archive:${input.operationId}`,
        `checkpoint:${input.checkpointId}`,
        ...(input.taskRef.namespace === 'shared'
          ? [taskHeadEntityKey(input.taskRef)]
          : []),
        ...preflightClaims.map((claim) => `claim:${claim.claimId}`),
        ...preflightHandoffs.map((handoff) => `handoff:${handoff.handoffId}`),
      ],
      now: input.now,
    });
    const lockedClaims = activeTaskClaims(context.coordination.claims);
    const lockedHandoffs = openTaskHandoffs(context.coordination.handoffs);
    if (
      sameIds(
        preflightClaims.map((claim) => claim.claimId),
        lockedClaims.map((claim) => claim.claimId),
      ) &&
      sameIds(
        preflightHandoffs.map((handoff) => handoff.handoffId),
        lockedHandoffs.map((handoff) => handoff.handoffId),
      )
    ) {
      try {
        const activeChildren = await context.store.listActiveChildTaskRefs(
          input.taskRef,
        );
        return {
          context,
          activeClaims: lockedClaims,
          openHandoffs: lockedHandoffs,
          activeChildren,
        };
      } catch (error) {
        await context.release();
        throw error;
      }
    }
    await context.release();
  }
  throw new Error('MANCODE_REFRAME_COORDINATION_SET_CHANGED');
}

function assertReframeEligible(
  context: OpenedV3TaskOperation,
  _claims: ClaimV1[],
  openHandoffs: HandoffV1[],
  activeChildren: TaskRef[],
): void {
  const metadata = context.task.metadata;
  if (context.project.config.transport.mode !== 'local') {
    throw new Error('MANCODE_REFRAME_GIT_REF_UNSUPPORTED');
  }
  if (metadata.workflowMode !== 'man' && metadata.workflowMode !== 'manteam') {
    throw new Error('MANCODE_REFRAME_WORKFLOW_MODE_INVALID');
  }
  if (!['in_progress', 'planned', 'blocked'].includes(metadata.status)) {
    throw new Error('MANCODE_REFRAME_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.ownerActorId !== context.session.actorId) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
  if (activeChildren.length > 0) {
    throw new Error('MANCODE_REFRAME_ACTIVE_CHILD');
  }
  if (openHandoffs.length > 0) {
    throw new Error('MANCODE_REFRAME_OPEN_HANDOFF');
  }
  if (metadata.soloExecution !== null) {
    throw new Error('MANCODE_REFRAME_ACTIVE_SOLO');
  }
  if (context.task.requirements.status !== 'confirmed') {
    throw new Error('MANCODE_REFRAME_REQUIREMENTS_NOT_CONFIRMED');
  }
}

function assertReframeClaimsFresh(
  context: OpenedV3TaskOperation,
  claims: ClaimV1[],
): void {
  if (claims.length === 0) return;
  const codeHead = context.codeHead;
  if (codeHead === null)
    throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
  for (const claim of claims) {
    const validity = deriveClaimValidity(claim, {
      taskRef: context.taskRef,
      taskRevision: context.task.metadata.revision,
      implementationScopeDigest:
        context.task.metadata.implementationScope.digest,
      ownershipEpoch: context.task.metadata.ownershipEpoch,
      codeRefHead: codeHead,
      now: context.now,
      transportFreshness: 'fresh',
    });
    if (validity !== 'fresh') {
      throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
    }
  }
}

function activeTaskClaims(claims: ClaimV1[]): ClaimV1[] {
  return claims
    .filter((claim) => claim.state === 'active')
    .sort((left, right) => left.claimId.localeCompare(right.claimId));
}

function openTaskHandoffs(handoffs: HandoffV1[]): HandoffV1[] {
  return handoffs
    .filter(
      (handoff) => handoff.state === 'draft' || handoff.state === 'offered',
    )
    .sort((left, right) => left.handoffId.localeCompare(right.handoffId));
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function markReframeOperationPending(
  previous: WorkflowMetadataV3,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    revision: previous.revision + 1,
    transitionState: 'operation_pending',
    lastOperationId: operationId,
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function createReframedRequirements(
  previous: RequirementsLedgerV1,
  operationId: Ulid,
  updatedAt: string,
): RequirementsLedgerV1 {
  const draft: RequirementsLedgerV1 = {
    ...previous,
    revision: previous.revision + 1,
    status: 'draft',
    contentDigest: '',
    lastOperationId: operationId,
    updatedAt,
  };
  const next = parseRequirementsLedger({
    ...draft,
    contentDigest: requirementsLedgerDigest(draft),
  });
  assertRequirementsLedgerTransition(previous, next);
  return next;
}

function releaseClaimForReframe(
  previous: ClaimV1,
  operationId: Ulid,
  updatedAt: string,
): ClaimV1 {
  const next = parseClaim({
    ...previous,
    state: 'released',
    revision: previous.revision + 1,
    lastOperationId: operationId,
    updatedAt,
  });
  assertClaimTransition(previous, next);
  return next;
}

function buildReframeCheckpoint(input: {
  context: OpenedV3TaskOperation;
  checkpointId: Ulid;
  taskRevision: number;
  requirements: RequirementsLedgerV1;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  summary?: string;
  nextAction?: string;
  branch: string | null;
  timestamp: string;
}): CheckpointV1 {
  return parseCheckpoint({
    schemaVersion: 1,
    checkpointId: input.checkpointId,
    operationId: input.context.operationId,
    taskRef: input.context.taskRef,
    taskRevision: input.taskRevision,
    ownershipEpochAtOffer: input.context.task.metadata.ownershipEpoch,
    kind: 'requirements_reframed',
    git: {
      branch: input.branch,
      head: input.context.codeHead,
      base: input.context.task.metadata.base?.head ?? null,
    },
    summary:
      input.summary ??
      'Archived the previous requirements and plan before reopening clarification.',
    governance: {
      requirementsDigest: input.requirements.contentDigest,
      planVersion: input.context.task.metadata.governance.planVersion,
      reviewLedgerDigest: input.review.contentDigest,
      verificationLedgerDigest: input.verification.contentDigest,
    },
    nextAction:
      input.nextAction ??
      'Clarify the reframed requirements before revising the plan.',
    createdBy: {
      actorId: input.context.session.actorId,
      client: input.context.session.client,
    },
    createdAt: input.timestamp,
  });
}

function completeReframeMetadata(
  previous: WorkflowMetadataV3,
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
  verification: VerificationLedgerV1,
  checkpoint: CheckpointV1,
  operationId: Ulid,
  updatedAt: string,
): WorkflowMetadataV3 {
  const next = parseWorkflowMetadata({
    ...previous,
    status: 'in_progress',
    currentStep: 2,
    blockingReason: null,
    revision: previous.revision + 1,
    transitionState: 'stable',
    lastOperationId: operationId,
    governance: {
      ...previous.governance,
      requirementsStatus: 'needs_clarification',
      requirementsDigest: requirements.contentDigest,
      planDecision: null,
      reviewStatus: review.status,
      reviewLedgerDigest: review.contentDigest,
      verificationStatus: verification.status,
      verificationLedgerDigest: verification.contentDigest,
    },
    latestCheckpointRef: {
      taskRef: checkpoint.taskRef,
      kind: 'checkpoint',
      artifactId: checkpoint.checkpointId,
    },
    updatedAt,
  });
  assertWorkflowMetadataTransition(previous, next, 'ordinary');
  return next;
}

function reframeExpectedRevisions(
  context: OpenedV3TaskOperation,
  checkpointId: Ulid,
  claims: ClaimV1[],
): Record<string, number> {
  const expected = taskMutationExpectedRevisions(context, [
    'requirements',
    'plan',
    'review',
    'verification',
  ]);
  expected[`archive:${context.operationId}`] = 0;
  expected[`checkpoint:${checkpointId}`] = 0;
  for (const claim of claims) {
    expected[`claim:${claim.claimId}`] = claim.revision;
  }
  return expected;
}

async function assertReframeCodeHeadUnchanged(
  context: OpenedV3TaskOperation,
): Promise<void> {
  if (context.taskRef.namespace === 'shared') {
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
  }
}

function archiveSummary(
  action: TaskArchiveRecoveryAction,
): ReframeArchiveSummary {
  const manifest = taskArchiveManifest(action);
  return {
    archiveId: manifest.archiveId,
    taskRef: manifest.taskRef,
    sourceTaskRevision: manifest.sourceTaskRevision,
    sourceRequirementsRevision: manifest.sourceRequirementsRevision,
    sourceRequirementsDigest: manifest.sourceRequirementsDigest,
    sourcePlanVersion: manifest.sourcePlanVersion,
    sourcePlanDigest: manifest.sourcePlanDigest,
    createdAt: manifest.createdAt,
  };
}

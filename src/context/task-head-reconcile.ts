import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveTaskEntityHomeStore } from '../runtime/entity-home-store.js';
import {
  armOperationCrashAfterVisibleWrite,
  throwIfDeferredOperationCrashInjected,
  throwIfOperationCrashInjected,
} from '../runtime/operation-crash-injection.js';
import { getOperationDefinition } from '../runtime/operation-definition.js';
import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import { createTaskHeadFenceRecoveryAction } from '../runtime/operation-recovery-payload.js';
import {
  readCheckoutCodeHead,
  readProjectRuntimeContext,
} from '../runtime/project-runtime.js';
import type { TaskHeadFenceV1 } from '../runtime/task-head-fence.js';
import {
  assertTaskHeadFenceTransition,
  parseTaskHeadFence,
} from '../runtime/task-head-fence.js';
import { replaceTaskHeadFence } from '../runtime/task-head-store.js';
import {
  advanceTaskOperation,
  commitTaskOperation,
  createTaskOperationJournal,
  handleTaskOperationFailure,
  openV3TaskOperation,
  taskEntityKey,
  taskHeadEntityKey,
} from '../runtime/task-operation.js';
import type { ClaimV1 } from '../team/claims.js';
import { deriveClaimValidity } from '../team/conflicts.js';
import { createGitRefTeamManifestStore } from '../team/git-ref-client.js';
import type { HandoffV1 } from '../team/handoff.js';
import type { ProjectConfigV1 } from '../team/policy.js';
import {
  type TaskAggregateManifestV1,
  taskAggregateDigest,
} from './aggregate.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import type { SchemaManifestV1 } from './manifest.js';
import { type StoredTaskSnapshot, V3ContextStore } from './store.js';
import { assertTaskCodeHeadUnchanged } from './task-mutation.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';

const execFile = promisify(execFileCallback);

export interface ReconcileV3TaskHeadInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedFenceRevision: number;
  /** Explicit confirmation that the checked-out task tuple is Git-sourced. */
  fromGit: boolean;
  operationId?: Ulid;
  now?: Date;
}

export interface ReconciledV3TaskHead {
  aggregate: TaskAggregateManifestV1;
  taskHeadFence: TaskHeadFenceV1;
  operation: OperationJournalV1;
}

export interface PreviewedV3TaskHeadReconcile {
  aggregate: TaskAggregateManifestV1;
  currentTaskHeadFence: TaskHeadFenceV1;
  proposedTaskHeadFence: TaskHeadFenceV1;
}

export interface PreviewV3TaskHeadReconcileInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionActorId: Ulid;
  expectedFenceRevision: number;
  fromGit: boolean;
  operationId?: Ulid;
  now?: Date;
}

/**
 * Performs the complete non-mutating reconcile preflight. The resulting
 * fence is a preview only: the eventual mutation re-reads under its lock.
 */
export async function previewV3TaskHeadReconcile(
  input: PreviewV3TaskHeadReconcileInput,
): Promise<PreviewedV3TaskHeadReconcile> {
  const taskRef = parseTaskRefValue(input.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_TASK_HEAD_RECONCILE_REQUIRES_SHARED_TASK');
  }
  if (input.fromGit !== true) {
    throw new Error('MANCODE_GIT_SOURCE_CONFIRMATION_REQUIRED');
  }
  assertPositiveRevision(input.expectedFenceRevision, 'fence revision');
  assertUlid(input.sessionActorId, 'task-head reconcile sessionActorId');
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'task-head reconcile operationId');
  const store = new V3ContextStore(input.projectRoot);
  const task = await store.readTaskSnapshot(taskRef);
  const runtime = await readProjectRuntimeContext(input.projectRoot);
  const homeStore = resolveTaskEntityHomeStore(
    runtime.entityHomeStoreContext,
    taskRef,
  );
  const coordination = await store.readCoordinationSnapshot(taskRef, homeStore);
  const aggregate = task.aggregate;
  const previousFence = coordination.taskHeadFence;
  const codeHead = await readCheckoutCodeHead(input.projectRoot);
  if (aggregate === null || previousFence === null || codeHead === null) {
    throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
  }
  if (previousFence.fenceRevision !== input.expectedFenceRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  if (coordination.pendingOperations.length > 0) {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
  await assertGitSourcedTaskAggregate(
    input.projectRoot,
    task.location.taskRoot,
  );
  const project = await store.readProjectSnapshot();
  await assertRemoteTaskUnpublished({
    projectRoot: input.projectRoot,
    taskRef,
    config: project.config,
    manifest: project.manifest,
  });
  assertReconcileEligible({
    task,
    aggregate,
    previousFence,
    codeHead,
    actorId: input.sessionActorId,
    claims: coordination.claims,
    handoffs: coordination.handoffs,
    now,
  });
  return {
    aggregate,
    currentTaskHeadFence: previousFence,
    proposedTaskHeadFence: buildReconciledTaskHeadFence({
      previousFence,
      aggregate,
      codeHead,
      checkoutId: runtime.checkoutId,
      operationId,
      now,
    }),
  };
}

/**
 * Explicitly adopts the complete current-worktree aggregate into the common
 * task-head fence. It never merges two aggregates and refuses adoption while
 * an active claim or open handoff would become stale.
 */
export async function reconcileV3TaskHead(
  input: ReconcileV3TaskHeadInput,
): Promise<ReconciledV3TaskHead> {
  const taskRef = parseTaskRefValue(input.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_TASK_HEAD_RECONCILE_REQUIRES_SHARED_TASK');
  }
  if (input.fromGit !== true) {
    throw new Error('MANCODE_GIT_SOURCE_CONFIRMATION_REQUIRED');
  }
  assertPositiveRevision(input.expectedFenceRevision, 'fence revision');
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'task-head reconcile operationId');
  const store = new V3ContextStore(input.projectRoot);
  const preflightTask = await store.readTaskSnapshot(taskRef);
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: preflightTask.metadata.revision,
    operationId,
    extraEntityLocks: [taskHeadEntityKey(taskRef)],
    allowTaskHeadFenceMismatch: true,
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    const aggregate = context.task.aggregate;
    const previousFence = context.coordination.taskHeadFence;
    const codeHead = context.codeHead;
    if (aggregate === null || previousFence === null || codeHead === null) {
      throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
    }
    if (previousFence.fenceRevision !== input.expectedFenceRevision) {
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    await assertGitSourcedTaskAggregate(
      context.projectRoot,
      context.task.location.taskRoot,
    );
    const reread = await context.store.readTaskSnapshot(taskRef);
    if (reread.fingerprint !== context.task.fingerprint) {
      throw new Error('MANCODE_CONTEXT_STALE');
    }
    await assertRemoteTaskUnpublished({
      projectRoot: context.projectRoot,
      taskRef,
      config: context.project.config,
      manifest: context.project.manifest,
    });
    assertReconcileEligible({
      task: context.task,
      aggregate,
      previousFence,
      codeHead,
      actorId: context.session.actorId,
      claims: context.coordination.claims,
      handoffs: context.coordination.handoffs,
      now: context.now,
    });
    const taskHeadFence = buildReconciledTaskHeadFence({
      previousFence,
      aggregate,
      codeHead,
      checkoutId: context.runtime.checkoutId,
      operationId: context.operationId,
      now: context.now,
    });
    assertTaskHeadFenceTransition(previousFence, taskHeadFence, {
      expectedFenceRevision: input.expectedFenceRevision,
      allowSameTaskRevision: true,
    });
    journal = await createTaskOperationJournal(context, {
      type: 'task_head_reconcile',
      action: 'task_head_reconcile',
      expectedRevisions: {
        [taskEntityKey(taskRef)]: context.task.metadata.revision,
        [taskHeadEntityKey(taskRef)]: previousFence.fenceRevision,
      },
      conditions: {
        gitSourceConfirmed: true,
        claimHandoffConsistent: true,
      },
      recovery: {
        actions: [
          createTaskHeadFenceRecoveryAction({
            stepId: 'adopt-task-head-fence',
            before: previousFence,
            fence: taskHeadFence,
          }),
        ],
      },
    });
    throwIfOperationCrashInjected('task_head_reconcile', 'prepared');
    journal = await advanceTaskOperation(
      context,
      journal,
      'validate-clean-store-and-git-reachability',
      true,
    );
    injectAfterReconcileStep('validate-clean-store-and-git-reachability');
    journal = await advanceTaskOperation(
      context,
      journal,
      'confirm-adoption',
      true,
    );
    injectAfterReconcileStep('confirm-adoption');
    journal = await advanceTaskOperation(
      context,
      journal,
      'adopt-task-head-fence',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await replaceTaskHeadFence(context.homeStore, taskHeadFence);
    throwIfDeferredOperationCrashInjected('task_head_reconcile');
    const operation = await commitTaskOperation(context, journal);
    throwIfOperationCrashInjected('task_head_reconcile', 'commit');
    return { aggregate, taskHeadFence, operation };
  } catch (error) {
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A fence write intent can only be reconciled forward.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

function injectAfterReconcileStep(stepId: string): void {
  const step = getOperationDefinition('task_head_reconcile').steps.find(
    (candidate) => candidate.id === stepId,
  );
  if (step?.visibility === 'business_write') {
    armOperationCrashAfterVisibleWrite('task_head_reconcile', stepId);
    return;
  }
  throwIfOperationCrashInjected('task_head_reconcile', stepId);
}

/**
 * `--from-git` is a user confirmation, not evidence by itself. Reconcile may
 * only adopt a tuple that Git can prove is the clean contents of the current
 * reachable HEAD; untracked, staged, or working-tree edits must use a normal
 * workflow mutation instead.
 */
async function assertGitSourcedTaskAggregate(
  projectRoot: string,
  taskRoot: string,
): Promise<void> {
  const relativeTaskRoot = path.relative(projectRoot, taskRoot);
  if (
    !relativeTaskRoot ||
    path.isAbsolute(relativeTaskRoot) ||
    relativeTaskRoot.split(path.sep).some((part) => part === '..')
  ) {
    throw new Error('MANCODE_TASK_UNAVAILABLE');
  }
  const authorityFiles = [
    'metadata.json',
    'requirements.json',
    'review-ledger.json',
    'verification-ledger.json',
  ].map((file) => path.join(relativeTaskRoot, file));
  try {
    await execFile('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    await execFile(
      'git',
      ['ls-files', '--error-unmatch', '--', ...authorityFiles],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      },
    );
    await execFile('git', ['diff', '--quiet', 'HEAD', '--', relativeTaskRoot], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    await execFile(
      'git',
      ['diff', '--cached', '--quiet', '--', relativeTaskRoot],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      },
    );
    const { stdout: status } = await execFile(
      'git',
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--',
        relativeTaskRoot,
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (status.trim()) throw new Error('task aggregate has Git changes');
  } catch {
    throw new Error('MANCODE_TASK_UNAVAILABLE');
  }
}

function buildReconciledTaskHeadFence(input: {
  previousFence: TaskHeadFenceV1;
  aggregate: TaskAggregateManifestV1;
  codeHead: string;
  checkoutId: Ulid;
  operationId: Ulid;
  now: Date;
}): TaskHeadFenceV1 {
  return parseTaskHeadFence({
    ...input.previousFence,
    fenceRevision: input.previousFence.fenceRevision + 1,
    taskRevision: input.aggregate.taskRevision,
    aggregateDigest: taskAggregateDigest(input.aggregate),
    ownershipEpoch: input.aggregate.ownershipEpoch,
    codeRef: { head: input.codeHead },
    checkoutId: input.checkoutId,
    lastOperationId: input.operationId,
    updatedAt: input.now.toISOString(),
  });
}

function assertReconcileEligible(input: {
  task: StoredTaskSnapshot;
  aggregate: TaskAggregateManifestV1;
  previousFence: TaskHeadFenceV1;
  codeHead: string;
  actorId: Ulid;
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  now: Date;
}): void {
  if (input.task.metadata.ownerActorId !== input.actorId) {
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  }
  if (
    input.previousFence.taskRevision === input.aggregate.taskRevision &&
    input.previousFence.aggregateDigest ===
      taskAggregateDigest(input.aggregate) &&
    input.previousFence.ownershipEpoch === input.aggregate.ownershipEpoch &&
    input.previousFence.codeRef.head === input.codeHead
  ) {
    throw new Error('MANCODE_TASK_HEAD_RECONCILE_NOT_REQUIRED');
  }
  assertClaimsConsistent(input.claims, input.task, input.codeHead, input.now);
  assertHandoffsConsistent(input.handoffs);
}

async function assertRemoteTaskUnpublished(input: {
  projectRoot: string;
  taskRef: TaskRef;
  config: ProjectConfigV1;
  manifest: SchemaManifestV1;
}): Promise<void> {
  if (input.config.transport.mode !== 'git-ref') return;
  const snapshot = await createGitRefTeamManifestStore(
    input.projectRoot,
    input.config,
    input.manifest,
  ).pull();
  const remote = snapshot.manifest;
  if (remote === null) return;
  const hasTaskAuthority = [
    ...remote.ownershipFences,
    ...remote.taskBundles,
    ...remote.claims,
    ...remote.handoffs,
  ].some((entity) => sameTaskRef(entity.taskRef, input.taskRef));
  if (hasTaskAuthority) {
    throw new Error('MANCODE_GIT_REF_TASK_ALREADY_PUBLISHED');
  }
}

function assertClaimsConsistent(
  claims: ClaimV1[],
  task: StoredTaskSnapshot,
  codeHead: string,
  now: Date,
): void {
  for (const claim of claims) {
    if (claim.state !== 'active') continue;
    if (
      deriveClaimValidity(claim, {
        taskRef: task.metadata.taskRef,
        taskRevision: task.metadata.revision,
        implementationScopeDigest: task.metadata.implementationScope.digest,
        ownershipEpoch: task.metadata.ownershipEpoch,
        codeRefHead: codeHead,
        now,
        transportFreshness: 'fresh',
      }) !== 'fresh'
    ) {
      throw new Error('MANCODE_CLAIM_HANDOFF_INCONSISTENT');
    }
  }
}

function assertHandoffsConsistent(handoffs: HandoffV1[]): void {
  if (
    handoffs.some(
      (handoff) => handoff.state === 'draft' || handoff.state === 'offered',
    )
  ) {
    throw new Error('MANCODE_CLAIM_HANDOFF_INCONSISTENT');
  }
}

function assertPositiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `MANCODE_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`,
    );
  }
}

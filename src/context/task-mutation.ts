import { readCheckoutCodeHead } from '../runtime/project-runtime.js';
import {
  type TaskHeadFenceV1,
  assertTaskHeadFenceTransition,
} from '../runtime/task-head-fence.js';
import {
  type OpenedV3TaskOperation,
  taskEntityKey,
  taskHeadEntityKey,
} from '../runtime/task-operation.js';
import {
  type TaskAggregateManifestV1,
  taskAggregateDigest,
} from './aggregate.js';
import type { Ulid } from './ids.js';
import {
  type ReviewLedgerV1,
  assertReviewLedgerTransition,
  parseReviewLedger,
  reviewLedgerDigest,
} from './review-ledger.js';
import {
  type VerificationLedgerV1,
  assertVerificationLedgerTransition,
  parseVerificationLedger,
  verificationLedgerDigest,
} from './verification-ledger.js';

export type MutableTaskEntity =
  | 'requirements'
  | 'plan'
  | 'review'
  | 'verification';

export function markTaskReviewStale(
  previous: ReviewLedgerV1,
  operationId: Ulid,
  updatedAt: string,
): ReviewLedgerV1 {
  const draft: ReviewLedgerV1 = {
    ...previous,
    revision: previous.revision + 1,
    status: 'stale',
    contentDigest: '',
    lastOperationId: operationId,
    updatedAt,
  };
  const next = parseReviewLedger({
    ...draft,
    contentDigest: reviewLedgerDigest(draft),
  });
  assertReviewLedgerTransition(previous, next);
  return next;
}

export function markTaskVerificationStale(
  previous: VerificationLedgerV1,
  operationId: Ulid,
  updatedAt: string,
): VerificationLedgerV1 {
  const draft: VerificationLedgerV1 = {
    ...previous,
    revision: previous.revision + 1,
    status: 'stale',
    contentDigest: '',
    lastOperationId: operationId,
    updatedAt,
  };
  const next = parseVerificationLedger({
    ...draft,
    contentDigest: verificationLedgerDigest(draft),
  });
  assertVerificationLedgerTransition(previous, next);
  return next;
}

export function nextTaskHeadFence(
  context: OpenedV3TaskOperation,
  aggregate: TaskAggregateManifestV1,
  updatedAt: string,
): TaskHeadFenceV1 | null {
  if (context.taskRef.namespace === 'local') return null;
  const previous = context.coordination.taskHeadFence;
  const codeHead = context.codeHead;
  if (previous === null || codeHead === null) {
    throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
  }
  const next: TaskHeadFenceV1 = {
    ...previous,
    fenceRevision: previous.fenceRevision + 1,
    taskRevision: aggregate.taskRevision,
    aggregateDigest: taskAggregateDigest(aggregate),
    ownershipEpoch: aggregate.ownershipEpoch,
    codeRef: { head: codeHead },
    checkoutId: context.runtime.checkoutId,
    lastOperationId: context.operationId,
    updatedAt,
  };
  assertTaskHeadFenceTransition(previous, next, {
    expectedFenceRevision: previous.fenceRevision,
  });
  return next;
}

export function taskMutationExpectedRevisions(
  context: Pick<OpenedV3TaskOperation, 'task' | 'coordination'>,
  entities: MutableTaskEntity[],
): Record<string, number> {
  const taskRef = context.task.metadata.taskRef;
  const expected: Record<string, number> = {
    [taskEntityKey(taskRef)]: context.task.metadata.revision,
  };
  for (const entity of new Set(entities)) {
    expected[`${entity}:${taskRef.taskId}`] = entityRevision(
      context.task,
      entity,
    );
  }
  if (taskRef.namespace === 'shared') {
    const fence = context.coordination.taskHeadFence;
    if (fence === null) throw new Error('MANCODE_TASK_HEAD_FENCE_MISSING');
    expected[taskHeadEntityKey(taskRef)] = fence.fenceRevision;
  }
  return expected;
}

export async function assertTaskCodeHeadUnchanged(
  projectRoot: string,
  expectedCodeHead: string | null,
): Promise<void> {
  if (expectedCodeHead === null) {
    throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
  }
  const currentCodeHead = await readCheckoutCodeHead(projectRoot);
  if (currentCodeHead !== expectedCodeHead) {
    throw new Error('MANCODE_TASK_HEAD_CODE_REF_STALE');
  }
}

function entityRevision(
  task: OpenedV3TaskOperation['task'],
  entity: MutableTaskEntity,
): number {
  switch (entity) {
    case 'requirements':
      return task.requirements.revision;
    case 'plan':
      return task.metadata.governance.planVersion;
    case 'review':
      return task.review.revision;
    case 'verification':
      return task.verification.revision;
  }
}

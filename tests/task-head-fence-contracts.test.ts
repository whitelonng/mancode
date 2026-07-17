import { describe, expect, it } from 'vitest';
import {
  type TaskAggregateManifestV1,
  taskAggregateDigest,
} from '../src/context/aggregate.js';
import {
  assertTaskHeadFenceMatchesAggregate,
  assertTaskHeadFenceTransition,
  parseTaskHeadFence,
} from '../src/runtime/task-head-fence.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const CHECKOUT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const NEXT_OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';

describe('shared task-head fence contract', () => {
  it('binds a shared aggregate, code head, revision, and ownership epoch', () => {
    const manifest = aggregateManifest();
    const fence = parseTaskHeadFence(rawFence(manifest));
    expect(() =>
      assertTaskHeadFenceMatchesAggregate(fence, manifest, 'abc1234'),
    ).not.toThrow();
    expect(() =>
      assertTaskHeadFenceMatchesAggregate(fence, manifest, 'different-head'),
    ).toThrow(/does not match/);
    expect(() =>
      parseTaskHeadFence({
        ...rawFence(manifest),
        taskRef: { namespace: 'local', taskId: TASK_ID },
      }),
    ).toThrow(/shared TaskRefs/);
  });

  it('uses fenceRevision as a CAS and reserves same-revision adoption for reconcile', () => {
    const previous = parseTaskHeadFence(rawFence(aggregateManifest()));
    const next = parseTaskHeadFence({
      ...previous,
      fenceRevision: 2,
      taskRevision: 8,
      aggregateDigest: `sha256:${'b'.repeat(64)}`,
      lastOperationId: NEXT_OPERATION_ID,
      updatedAt: '2026-07-17T10:01:00.000Z',
    });
    expect(() =>
      assertTaskHeadFenceTransition(previous, next, {
        expectedFenceRevision: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertTaskHeadFenceTransition(previous, next, {
        expectedFenceRevision: 2,
      }),
    ).toThrow(/FENCE_CONFLICT/);

    const reconcile = parseTaskHeadFence({
      ...previous,
      fenceRevision: 2,
      aggregateDigest: `sha256:${'c'.repeat(64)}`,
      lastOperationId: NEXT_OPERATION_ID,
      updatedAt: '2026-07-17T10:01:00.000Z',
    });
    expect(() =>
      assertTaskHeadFenceTransition(previous, reconcile, {
        expectedFenceRevision: 1,
      }),
    ).toThrow(/explicit reconcile/);
    expect(() =>
      assertTaskHeadFenceTransition(previous, reconcile, {
        expectedFenceRevision: 1,
        allowSameTaskRevision: true,
      }),
    ).not.toThrow();

    const codeHeadReconcile = parseTaskHeadFence({
      ...previous,
      fenceRevision: 2,
      codeRef: { head: 'def5678' },
      lastOperationId: NEXT_OPERATION_ID,
      updatedAt: '2026-07-17T10:01:00.000Z',
    });
    expect(() =>
      assertTaskHeadFenceTransition(previous, codeHeadReconcile, {
        expectedFenceRevision: 1,
        allowSameTaskRevision: true,
      }),
    ).not.toThrow();
  });
});

function aggregateManifest(): TaskAggregateManifestV1 {
  return {
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    taskRevision: 7,
    ownershipEpoch: 3,
    metadataDigest: `sha256:${'a'.repeat(64)}`,
    requirementsDigest: `sha256:${'b'.repeat(64)}`,
    reviewDigest: `sha256:${'c'.repeat(64)}`,
    verificationDigest: `sha256:${'d'.repeat(64)}`,
    planVersion: 2,
    planDigest: null,
    latestCheckpointId: null,
    latestCheckpointDigest: null,
    parentSnapshotDigest: null,
  };
}

function rawFence(manifest: TaskAggregateManifestV1) {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    taskRef: manifest.taskRef,
    fenceRevision: 1,
    taskRevision: manifest.taskRevision,
    aggregateDigest: taskAggregateDigest(manifest),
    ownershipEpoch: manifest.ownershipEpoch,
    codeRef: { head: 'abc1234' },
    checkoutId: CHECKOUT_ID,
    remoteRevision: null,
    lastOperationId: OPERATION_ID,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

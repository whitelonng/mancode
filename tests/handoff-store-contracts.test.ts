import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ulid } from '../src/context/ids.js';
import type { EntityHomeStore } from '../src/runtime/entity-home-store.js';
import {
  createHandoff,
  handoffPath,
  listHandoffs,
  readHandoff,
  updateHandoff,
} from '../src/runtime/handoff-store.js';
import type { HandoffV1 } from '../src/team/handoff.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H' as Ulid;
const HANDOFF_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J' as Ulid;
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K' as Ulid;
const FROM_ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M' as Ulid;
const TO_ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N' as Ulid;
const CHECKPOINT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7P' as Ulid;

describe('handoff authority store', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-handoff-store-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates immutable handoff IDs and applies revision-CAS transitions', async () => {
    const store = homeStore(root);
    const draft = handoff();
    await expect(createHandoff(store, draft)).resolves.toEqual(draft);
    await expect(createHandoff(store, draft)).resolves.toEqual(draft);
    await expect(readHandoff(store, HANDOFF_ID)).resolves.toEqual(draft);
    await expect(listHandoffs(store, draft.taskRef)).resolves.toEqual([draft]);

    const offered: HandoffV1 = {
      ...draft,
      state: 'offered',
      revision: 2,
      offeredAt: '2026-07-17T10:01:00.000Z',
      lastOperationId: HANDOFF_ID,
      updatedAt: '2026-07-17T10:01:00.000Z',
    };
    await expect(
      updateHandoff(store, offered, 1, FROM_ACTOR_ID),
    ).resolves.toEqual(offered);
    await expect(
      updateHandoff(store, offered, 1, FROM_ACTOR_ID),
    ).rejects.toThrow('MANCODE_EXPECTED_REVISION_CONFLICT');
  });

  it('refuses a different snapshot under an existing handoff ID', async () => {
    const store = homeStore(root);
    const draft = handoff();
    await createHandoff(store, draft);
    await expect(
      createHandoff(store, { ...draft, toActorId: WORKSPACE_ID }),
    ).rejects.toThrow('MANCODE_HANDOFF_ID_CONFLICT');
    expect(handoffPath(store, HANDOFF_ID)).toContain(`${HANDOFF_ID}.json`);
  });
});

function homeStore(root: string): EntityHomeStore {
  return {
    kind: 'non_git_shared',
    storeId: `non-git:${WORKSPACE_ID}`,
    root,
    workspaceId: WORKSPACE_ID,
    checkoutId: null,
    repositoryBindingId: null,
  };
}

function handoff(): HandoffV1 {
  const taskRef = { namespace: 'shared' as const, taskId: TASK_ID };
  return {
    schemaVersion: 1,
    handoffId: HANDOFF_ID,
    taskRef,
    taskRevision: 7,
    ownershipEpochAtOffer: 3,
    state: 'draft',
    revision: 1,
    fromActorId: FROM_ACTOR_ID,
    toActorId: TO_ACTOR_ID,
    claimIds: [],
    checkpointRef: { taskRef, kind: 'checkpoint', artifactId: CHECKPOINT_ID },
    summary: {
      completed: [],
      inProgress: [],
      notStarted: [],
      changedFiles: [],
      verification: [],
      blockers: [],
      risks: [],
      nextAction: 'Review the latest checkpoint.',
    },
    transport: {
      mode: 'local',
      state: 'local_only',
      transportRevision: null,
      publishedAt: null,
      fetchedAt: null,
      taskBundleDigest: `sha256:${'a'.repeat(64)}`,
      codeRef: { branch: 'main', head: 'abc123' },
      codeReachable: true,
      receipt: null,
    },
    lastOperationId: null,
    offeredAt: null,
    resolution: null,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

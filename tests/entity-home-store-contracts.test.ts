import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimDirectory,
  resolveCoordinationEntityHomeStore,
  resolveTaskEntityHomeStore,
} from '../src/runtime/entity-home-store.js';
import {
  acquireEntityLocks,
  acquireLocalLock,
  readLocalLock,
} from '../src/runtime/local-lock.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const CHECKOUT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const BINDING_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const NEXT_OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7P';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('entity home stores and canonical local locks', () => {
  it('separates local task storage from the shared coordination store', () => {
    const context = {
      projectRoot: '/checkout/project',
      workspaceId: WORKSPACE_ID,
      checkoutId: CHECKOUT_ID,
      gitCommonDir: '/repo/.git',
      repositoryBindingId: BINDING_ID,
    };
    const local = resolveTaskEntityHomeStore(context, {
      namespace: 'local',
      taskId: TASK_ID,
    });
    const shared = resolveTaskEntityHomeStore(context, {
      namespace: 'shared',
      taskId: TASK_ID,
    });
    expect(local.storeId).toBe(`checkout:${CHECKOUT_ID}:${WORKSPACE_ID}`);
    expect(local.root).toBe('/checkout/project/.mancode/local/runtime');
    expect(shared.storeId).toBe(`workspace:${BINDING_ID}:${WORKSPACE_ID}`);
    expect(shared.root).toBe(`/repo/.git/mancode/workspaces/${WORKSPACE_ID}`);
    expect(claimDirectory(shared)).toBe(
      `/repo/.git/mancode/workspaces/${WORKSPACE_ID}/claims`,
    );
    expect(() => claimDirectory(local)).toThrow(/shared coordination/);

    const nonGit = resolveCoordinationEntityHomeStore({
      ...context,
      gitCommonDir: null,
      repositoryBindingId: null,
    });
    expect(nonGit.storeId).toBe(`non-git:${WORKSPACE_ID}`);
    expect(nonGit.root).toBe(
      `/checkout/project/.mancode/runtime/non-git/${WORKSPACE_ID}`,
    );
  });

  it('acquires and releases store-local entity locks in UTF-8 key order', async () => {
    const projectRoot = await temporaryRoot();
    const store = resolveCoordinationEntityHomeStore({
      projectRoot,
      workspaceId: WORKSPACE_ID,
      checkoutId: CHECKOUT_ID,
      gitCommonDir: null,
      repositoryBindingId: null,
    });
    await mkdir(store.root, { recursive: true });
    const first = await acquireLocalLock(store, {
      operationId: OPERATION_ID,
      entityLockKey: `task:shared:${TASK_ID}`,
      processId: 123,
      now: new Date('2026-07-17T10:00:00.000Z'),
    });
    await expect(
      acquireLocalLock(store, {
        operationId: NEXT_OPERATION_ID,
        entityLockKey: `task:shared:${TASK_ID}`,
        processId: 456,
        now: new Date('2026-07-17T10:00:01.000Z'),
      }),
    ).rejects.toThrow('MANCODE_LOCK_HELD');
    await expect(
      readLocalLock(store, `task:shared:${TASK_ID}`),
    ).resolves.toMatchObject({ operationId: OPERATION_ID, processId: 123 });
    await first.release();
    await expect(
      readLocalLock(store, `task:shared:${TASK_ID}`),
    ).resolves.toBeNull();

    const locks = await acquireEntityLocks(
      store,
      OPERATION_ID,
      [`task:shared:${TASK_ID}`, `handoff:${TASK_ID}`],
      { processId: 123, now: new Date('2026-07-17T10:00:00.000Z') },
    );
    expect(locks.map((lock) => lock.entityLockKey)).toEqual([
      `handoff:${TASK_ID}`,
      `task:shared:${TASK_ID}`,
    ]);
    await Promise.all(locks.map((lock) => lock.release()));
  });

  it('reclaims only an expired lease from a dead process and renews live work', async () => {
    const projectRoot = await temporaryRoot();
    const store = resolveCoordinationEntityHomeStore({
      projectRoot,
      workspaceId: WORKSPACE_ID,
      checkoutId: CHECKOUT_ID,
      gitCommonDir: null,
      repositoryBindingId: null,
    });
    await mkdir(store.root, { recursive: true });
    const abandoned = await acquireLocalLock(store, {
      operationId: OPERATION_ID,
      entityLockKey: `task:shared:${TASK_ID}`,
      processId: 999_999,
      now: new Date('2026-07-17T10:00:00.000Z'),
      leaseMs: 1_000,
    });
    await abandoned.renew(new Date('2026-07-17T10:00:00.500Z'));
    await expect(
      acquireLocalLock(store, {
        operationId: NEXT_OPERATION_ID,
        entityLockKey: `task:shared:${TASK_ID}`,
        processId: 456,
        now: new Date('2026-07-17T10:00:01.200Z'),
      }),
    ).rejects.toThrow('MANCODE_LOCK_HELD');

    const replacement = await acquireLocalLock(store, {
      operationId: NEXT_OPERATION_ID,
      entityLockKey: `task:shared:${TASK_ID}`,
      processId: 456,
      now: new Date('2026-07-17T10:00:01.600Z'),
    });
    await expect(abandoned.release()).rejects.toThrow(
      'MANCODE_LOCK_OWNERSHIP_LOST',
    );
    await replacement.release();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-home-store-'));
  roots.push(root);
  return root;
}

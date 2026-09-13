import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCoordinationEntityHomeStore } from '../src/runtime/entity-home-store.js';
import {
  acquireLocalLock,
  entityLockPath,
  readLocalLock,
} from '../src/runtime/local-lock.js';

const writes = vi.hoisted(() => ({
  afterPartial: null as (() => Promise<void>) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: unknown[]) => {
      const afterPartial = writes.afterPartial;
      if (afterPartial !== null && typeof args[1] === 'string') {
        writes.afterPartial = null;
        // Hold a real file halfway through its write, independent of scheduling.
        await Reflect.apply(actual.writeFile, actual, [
          args[0],
          args[1].slice(0, Math.floor(args[1].length / 2)),
          args[2],
        ]);
        await afterPartial();
        return Reflect.apply(actual.writeFile, actual, [args[0], args[1]]);
      }
      return Reflect.apply(actual.writeFile, actual, args);
    },
  };
});

const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const NEXT_OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const entityLockKey = 'project:write';
let root: string;

beforeEach(async () => {
  writes.afterPartial = null;
  root = await mkdtemp(path.join(os.tmpdir(), 'mancode-lock-publication-'));
});

afterEach(async () => {
  writes.afterPartial = null;
  await rm(root, { recursive: true, force: true });
});

function store() {
  return resolveCoordinationEntityHomeStore({
    projectRoot: root,
    workspaceId: '01JZ4B6W5Z0A1B2C3D4E5F6G7H',
    checkoutId: '01JZ4B6W5Z0A1B2C3D4E5F6G7J',
    gitCommonDir: null,
    repositoryBindingId: null,
  });
}

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('local lock owner publication', () => {
  it('reports contention, not corruption, while the first owner is partially written', async () => {
    const home = store();
    const partial = signal();
    const finish = signal();
    writes.afterPartial = async () => {
      partial.resolve();
      await finish.promise;
    };
    const acquisition = acquireLocalLock(home, {
      operationId: OPERATION_ID,
      entityLockKey,
    });
    try {
      await partial.promise;
      await expect(
        acquireLocalLock(home, {
          operationId: NEXT_OPERATION_ID,
          entityLockKey,
        }),
      ).rejects.toThrow('MANCODE_LOCK_HELD');
      await expect(readLocalLock(home, entityLockKey)).resolves.toBeNull();
    } finally {
      finish.resolve();
      const first = await acquisition;
      await expect(readLocalLock(home, entityLockKey)).resolves.toEqual(
        first.owner,
      );
      await first.release();
    }
    const next = await acquireLocalLock(home, {
      operationId: NEXT_OPERATION_ID,
      entityLockKey,
    });
    await next.release();
  });

  it('cleans up a failed initial write so a later owner can acquire the lock', async () => {
    const home = store();
    const failure = Object.assign(new Error('injected disk write failure'), {
      code: 'EIO',
    });
    writes.afterPartial = async () => {
      throw failure;
    };
    await expect(
      acquireLocalLock(home, { operationId: OPERATION_ID, entityLockKey }),
    ).rejects.toBe(failure);
    await expect(readLocalLock(home, entityLockKey)).resolves.toBeNull();
    const next = await acquireLocalLock(home, {
      operationId: NEXT_OPERATION_ID,
      entityLockKey,
    });
    await next.release();
  });

  it('still rejects a genuinely corrupt published owner without stealing its lock', async () => {
    const home = store();
    const first = await acquireLocalLock(home, {
      operationId: OPERATION_ID,
      entityLockKey,
    });
    const ownerPath = path.join(
      entityLockPath(home, entityLockKey),
      'owner.json',
    );
    await writeFile(ownerPath, '{broken');
    await expect(readLocalLock(home, entityLockKey)).rejects.toThrow(
      'MANCODE_LOCK_CORRUPT',
    );
    await expect(
      acquireLocalLock(home, {
        operationId: NEXT_OPERATION_ID,
        entityLockKey,
      }),
    ).rejects.toThrow('MANCODE_LOCK_CORRUPT');
    expect(await readFile(ownerPath, 'utf8')).toBe('{broken');
    await writeFile(ownerPath, JSON.stringify(first.owner));
    await first.release();
  });
});

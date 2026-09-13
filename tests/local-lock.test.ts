import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  afterStat: null as (() => Promise<void>) | null,
  failCleanup: false,
  linkError: null as Error | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: unknown[]) => {
      const entry = await Reflect.apply(actual.lstat, actual, args);
      const afterStat = writes.afterStat;
      writes.afterStat = null;
      await afterStat?.();
      return entry;
    },
    link: async (...args: unknown[]) => {
      if (writes.linkError !== null) throw writes.linkError;
      return Reflect.apply(actual.link, actual, args);
    },
    rm: async (...args: unknown[]) => {
      if (writes.failCleanup && String(args[0]).includes('.pending.')) {
        writes.failCleanup = false;
        throw Object.assign(new Error('injected cleanup failure'), {
          code: 'EIO',
        });
      }
      return Reflect.apply(actual.rm, actual, args);
    },
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
  writes.afterStat = null;
  writes.failCleanup = false;
  writes.linkError = null;
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
  it('publishes only complete owners and preserves the winner when an earlier writer is paused', async () => {
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
    }).then(
      (lock) => ({ lock }),
      (error: Error) => ({ error }),
    );
    let winner: Awaited<ReturnType<typeof acquireLocalLock>> | undefined;
    try {
      await partial.promise;
      await expect(readLocalLock(home, entityLockKey)).resolves.toBeNull();
      winner = await acquireLocalLock(home, {
        operationId: NEXT_OPERATION_ID,
        entityLockKey,
      });
      finish.resolve();
      const result = await acquisition;
      expect('error' in result && result.error.message).toBe(
        'MANCODE_LOCK_HELD',
      );
      await expect(readLocalLock(home, entityLockKey)).resolves.toEqual(
        winner.owner,
      );
    } finally {
      finish.resolve();
      const result = await acquisition;
      if ('lock' in result) await result.lock.release();
      await winner?.release();
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
    const ownerPath = entityLockPath(home, entityLockKey);
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

  it('reads legacy owners, protects a live owner, and recovers an expired dead owner', async () => {
    const home = store();
    const first = await acquireLocalLock(home, {
      operationId: OPERATION_ID,
      entityLockKey,
    });
    await first.release();
    const target = entityLockPath(home, entityLockKey);
    await mkdir(target);
    const ownerPath = path.join(target, 'owner.json');
    await writeFile(ownerPath, JSON.stringify(first.owner));
    await expect(readLocalLock(home, entityLockKey)).resolves.toEqual(
      first.owner,
    );
    const now = new Date(Date.parse(first.owner.leaseExpiresAt ?? '') + 1000);
    await expect(
      acquireLocalLock(home, {
        operationId: NEXT_OPERATION_ID,
        entityLockKey,
        now,
      }),
    ).rejects.toThrow('MANCODE_LOCK_HELD');
    await writeFile(
      ownerPath,
      JSON.stringify({ ...first.owner, processId: 999_999 }),
    );
    const replacement = await acquireLocalLock(home, {
      operationId: NEXT_OPERATION_ID,
      entityLockKey,
      now,
    });
    expect((await lstat(target)).isFile()).toBe(true);
    await replacement.release();
  });

  it('does not guess ownership or steal an anonymous legacy directory', async () => {
    const home = store();
    const target = entityLockPath(home, entityLockKey);
    await mkdir(target, { recursive: true });
    await expect(
      acquireLocalLock(home, { operationId: OPERATION_ID, entityLockKey }),
    ).rejects.toThrow('MANCODE_LOCK_HELD');
    expect((await lstat(target)).isDirectory()).toBe(true);
  });

  it('keeps a successfully published lock when temporary cleanup fails', async () => {
    const home = store();
    writes.failCleanup = true;
    const first = await acquireLocalLock(home, {
      operationId: OPERATION_ID,
      entityLockKey,
    });
    await expect(readLocalLock(home, entityLockKey)).resolves.toEqual(
      first.owner,
    );
    await expect(
      acquireLocalLock(home, { operationId: NEXT_OPERATION_ID, entityLockKey }),
    ).rejects.toThrow('MANCODE_LOCK_HELD');
    await first.release();
  });

  it('fails closed when exclusive publication is unsupported', async () => {
    const home = store();
    const failure = Object.assign(new Error('hard links unsupported'), {
      code: 'ENOTSUP',
    });
    writes.linkError = failure;
    await expect(
      acquireLocalLock(home, { operationId: OPERATION_ID, entityLockKey }),
    ).rejects.toBe(failure);
    await expect(readLocalLock(home, entityLockKey)).resolves.toBeNull();
    writes.linkError = null;
    const next = await acquireLocalLock(home, {
      operationId: NEXT_OPERATION_ID,
      entityLockKey,
    });
    await next.release();
  });

  it.each([true, false])(
    'rechecks a legacy/file transition after stat (legacy first: %s)',
    async (legacyFirst) => {
      const home = store();
      const first = await acquireLocalLock(home, {
        operationId: OPERATION_ID,
        entityLockKey,
      });
      const target = entityLockPath(home, entityLockKey);
      const replace = async (legacy: boolean) => {
        await rm(target, { recursive: true });
        if (legacy) await mkdir(target);
        await writeFile(
          legacy ? path.join(target, 'owner.json') : target,
          JSON.stringify(first.owner),
        );
      };
      if (legacyFirst) await replace(true);
      writes.afterStat = () => replace(!legacyFirst);
      await expect(readLocalLock(home, entityLockKey)).resolves.toEqual(
        first.owner,
      );
      await first.release();
    },
  );
});

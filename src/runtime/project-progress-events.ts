import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createUlid } from '../context/ids.js';
import {
  saveProgressProjectionCache,
  updateProgressProjectionCache,
} from '../context/project-progress-cache.js';
import {
  readProjectProgressBinding,
  readProjectProgressSnapshotVersion,
  writeProjectProgressSnapshot,
} from '../context/project-progress-storage.js';
import {
  type ProgressInvalidation,
  ProjectProgressController,
} from '../context/project-progress.js';
import { V3ContextStore } from '../context/store.js';
import { replaceFileAtomically } from './atomic-file.js';
import {
  resolveCoordinationEntityHomeStore,
  resolveLocalEntityHomeStore,
} from './entity-home-store.js';
import { type LocalLockHandle, acquireLocalLock } from './local-lock.js';
import { readOperationJournal } from './operation-store.js';
import { readProjectRuntimeContext } from './project-runtime.js';

interface ProgressNotification {
  revision: number;
  change: ProgressInvalidation;
}
const directory = '.mancode/local/project-progress';

async function readLocal(root: string, name: string): Promise<string | null> {
  const target = path.join(root, directory, name);
  try {
    const stat = await lstat(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await realpath(target)) !==
        path.join(await realpath(root), directory, name)
    ) {
      throw new Error('MANCODE_PROGRESS_PATH_UNSAFE');
    }
    return await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeLocal(
  root: string,
  name: string,
  value: unknown,
): Promise<void> {
  const folder = path.join(root, directory);
  await mkdir(folder, { recursive: true });
  if ((await realpath(folder)) !== path.join(await realpath(root), directory)) {
    throw new Error('MANCODE_PROGRESS_PATH_UNSAFE');
  }
  await readLocal(root, name);
  const temporary = path.join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), {
      flag: 'wx',
      mode: 0o600,
    });
    await replaceFileAtomically(temporary, path.join(folder, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function progressLock(root: string): Promise<LocalLockHandle> {
  const runtime = await readProjectRuntimeContext(root);
  const store = resolveLocalEntityHomeStore(runtime.entityHomeStoreContext);
  const operationId = createUlid();
  for (let attempt = 0; ; attempt++) {
    try {
      return await acquireLocalLock(store, {
        operationId,
        entityLockKey: 'projection:progress-events',
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'MANCODE_LOCK_HELD' ||
        attempt === 49
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function pendingOperations(root: string): Promise<Record<string, true>> {
  const raw = await readLocal(root, 'pending.json');
  if (raw === null) return {};
  const value = JSON.parse(raw) as Record<string, true>;
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.entries(value).some(
      ([key, item]) => !/^[0-9A-Z]{26}$/.test(key) || item !== true,
    )
  ) {
    throw new Error('MANCODE_PROGRESS_PENDING_INVALID');
  }
  return value;
}

/** Marks the commit window before the journal becomes terminal; no authority is stored here. */
export async function markProgressCommitPending(
  root: string,
  operationId: string,
): Promise<void> {
  try {
    if ((await readProjectProgressBinding(root)) === null) return;
    const lock = await progressLock(root);
    try {
      await writeLocal(root, 'pending.json', {
        ...(await pendingOperations(root)),
        [operationId]: true,
      });
    } finally {
      await lock.release();
    }
  } catch (error) {
    // A view failure cannot turn already-written business data into a failed mutation.
    // Corrupt/unreadable marker state makes the preview fail closed; successful notify repairs the page.
    console.error(
      'Project progress commit marker unavailable; authority commit continues.',
      error instanceof Error && /^MANCODE_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'MANCODE_PROGRESS_MARKER_FAILED',
    );
  }
}

/** One small pointer read; no task enumeration, model call or cache parsing. */
export async function readProgressNotification(
  root: string,
): Promise<ProgressNotification | null> {
  if (Object.keys(await pendingOperations(root)).length > 0) {
    throw new Error('MANCODE_PROGRESS_COMMIT_PENDING');
  }
  if ((await readLocal(root, 'repair.json')) !== null) {
    throw new Error('MANCODE_PROGRESS_REPAIR_REQUIRED');
  }
  return readPointer(root);
}

async function readPointer(root: string): Promise<ProgressNotification | null> {
  const raw = await readLocal(root, 'revision.json');
  if (raw === null) return null;
  const value = JSON.parse(raw) as ProgressNotification;
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.change !== 'object' ||
    value.change === null
  ) {
    throw new Error('MANCODE_PROGRESS_NOTIFICATION_INVALID');
  }
  return value;
}

/** Optional local projection. A failed projection never changes committed authority. */
export async function notifyCommittedProgress(
  root: string,
  change: ProgressInvalidation,
  preparedController?: ProjectProgressController,
  completedOperationId?: string,
): Promise<{ status: 'updated' | 'unbound' | 'pending'; code?: string }> {
  let bound = false;
  try {
    const binding = await readProjectProgressBinding(root);
    if (binding === null) return { status: 'unbound' };
    bound = true;
    const runtime = await readProjectRuntimeContext(root);
    const lock = await progressLock(root);
    try {
      const repair = await readLocal(root, 'repair.json');
      const effectiveChange =
        repair === null ? change : { ...change, full: true };
      const previous = await readPointer(root);
      const revision = (previous?.revision ?? 0) + 1;
      const expectedVersion = await readProjectProgressSnapshotVersion(root);
      const prepared =
        preparedController &&
        preparedController.data(binding.visibility).version === expectedVersion
          ? preparedController
          : undefined;
      const identity = {
        workspaceId: runtime.workspaceId,
        checkoutId: runtime.checkoutId,
        projectName: path.basename(root),
      };
      const store = new V3ContextStore(root);
      const io = {
        read: (name: string) => readLocal(root, name),
        write: (name: string, value: unknown) => writeLocal(root, name, value),
        prune: async (generation: string) => {
          for (const name of await readdir(path.join(root, directory))) {
            if (
              /^rows-[-a-f0-9]{36}-[a-f0-9]{2}\.json$/.test(name) &&
              !name.startsWith(`rows-${generation}-`)
            ) {
              await readLocal(root, name);
              await rm(path.join(root, directory, name));
            }
          }
        },
      };
      // Publish invalidation before rendering: an interrupted writer cannot leave a fresh-looking preview.
      await writeLocal(root, 'revision.json', {
        revision,
        change: effectiveChange,
      });
      let controller = prepared;
      let incremental = false;
      // The cache never supplies authority: pending markers and the source revision gate all publication.
      if (
        !controller &&
        previous &&
        !effectiveChange.full &&
        !effectiveChange.project
      ) {
        try {
          controller = await updateProgressProjectionCache(
            io,
            await realpath(root),
            identity,
            previous.revision,
            revision,
            store,
            effectiveChange,
          );
          incremental = true;
        } catch {
          controller = undefined;
        }
      }
      controller ??= new ProjectProgressController(store, identity);
      if (!prepared || repair !== null) {
        if (!incremental) {
          controller.invalidate({ ...effectiveChange, full: true });
          await controller.refresh();
        }
        await writeProjectProgressSnapshot(root, controller, expectedVersion);
      }
      if (!incremental)
        await saveProgressProjectionCache(
          io,
          await realpath(root),
          identity,
          revision,
          controller,
        );
      let pending: Record<string, true>;
      try {
        pending = await pendingOperations(root);
      } catch (error) {
        if (!change.full) throw error;
        pending = {};
      }
      if (completedOperationId) delete pending[completedOperationId];
      if (change.full && !completedOperationId) {
        const stores = [
          resolveLocalEntityHomeStore(runtime.entityHomeStoreContext),
          resolveCoordinationEntityHomeStore(runtime.entityHomeStoreContext),
        ];
        for (const operationId of Object.keys(pending)) {
          for (const store of stores) {
            const journal = await readOperationJournal(store, operationId);
            if (
              journal?.state === 'committed' ||
              journal?.state === 'aborted'
            ) {
              delete pending[operationId];
              break;
            }
          }
        }
        await writeLocal(root, 'pending.json', pending);
      } else if (completedOperationId) {
        await writeLocal(root, 'pending.json', pending);
      }
      if (
        repair !== null &&
        (await readLocal(root, 'repair.json')) === repair
      ) {
        await rm(path.join(root, directory, 'repair.json'));
      }
      return { status: 'updated' };
    } finally {
      await lock.release();
    }
  } catch (error) {
    // stderr preserves machine-readable mutation receipts and explains repair without leaking task content.
    const code =
      error instanceof Error && /^MANCODE_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'MANCODE_PROGRESS_UPDATE_FAILED';
    if (bound) {
      try {
        await writeLocal(root, 'repair.json', { nonce: randomUUID(), code });
      } catch (repairError) {
        console.error(
          'Project progress repair marker could not be saved.',
          repairError instanceof Error ? repairError.name : 'Error',
        );
      }
    }
    console.error(
      `Project progress update pending (${code}); run mancode progress refresh.`,
    );
    return { status: 'pending', code };
  }
}

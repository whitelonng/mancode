import type { Ulid } from '../context/ids.js';
import { resolveLocalEntityHomeStore } from './entity-home-store.js';
import { type LocalLockHandle, acquireEntityLocks } from './local-lock.js';
import { listUnfinishedOperationJournals } from './operation-store.js';
import type { ProjectRuntimeContext } from './project-runtime.js';

export const PROJECT_SCHEMA_LOCK = 'schema:project';

/**
 * Serializes the start of ordinary writes with project-authority transitions.
 * The caller keeps this lock until its prepared journal is durable, allowing a
 * project upgrade to observe and reject every in-flight business operation.
 */
export async function acquireProjectWriteBarrier(
  runtime: ProjectRuntimeContext,
  operationId: Ulid,
  now: Date,
): Promise<LocalLockHandle> {
  const localStore = resolveLocalEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const [lock] = await acquireEntityLocks(
    localStore,
    operationId,
    [PROJECT_SCHEMA_LOCK],
    { now },
  );
  if (lock === undefined) {
    throw new Error('MANCODE_LOCK_HELD');
  }
  try {
    const unfinished = await listUnfinishedOperationJournals(localStore);
    if (
      unfinished.some((journal) =>
        journal.entityLocks.includes(PROJECT_SCHEMA_LOCK),
      )
    ) {
      throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
    }
    return lock;
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}

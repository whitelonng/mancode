import { AsyncLocalStorage } from 'node:async_hooks';
import { type Ulid, assertUlid } from '../context/ids.js';
import type { OperationType } from './operation-journal.js';

export interface OperationCrashInjection {
  operationType: OperationType;
  crashAfter: 'prepared' | string;
}

interface ActiveCrashInjection extends OperationCrashInjection {
  triggered: boolean;
  deferredCrashAfter: string | null;
}

const activeInjection = new AsyncLocalStorage<ActiveCrashInjection>();

export type OperationLockPausePoint = 'entity_locks_held';

export interface OperationLockPauseController {
  /** Resolves only after the selected operation holds its canonical locks. */
  readonly reached: Promise<void>;
  release(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

interface ActiveLockPauseInjection {
  operationId: Ulid;
  pauseAfter: OperationLockPausePoint;
  triggered: boolean;
  signalReached(): void;
  readonly resume: Promise<void>;
}

const activeLockPause = new AsyncLocalStorage<ActiveLockPauseInjection>();

/**
 * Test harness only: simulate process loss immediately after a journal state
 * becomes durable. The async-local scope prevents one concurrent test from
 * interrupting another operation.
 */
export async function withOperationCrashInjectionForTesting<T>(
  injection: OperationCrashInjection,
  operation: () => Promise<T>,
): Promise<T> {
  if (!injection.crashAfter) {
    throw new Error('MANCODE_TEST_CRASH_POINT_INVALID');
  }
  return activeInjection.run(
    { ...injection, triggered: false, deferredCrashAfter: null },
    operation,
  );
}

/**
 * Test harness only: pauses one explicitly selected operation after its
 * prepared journal releases the project barrier while canonical entity locks
 * remain held. Async-local scoping keeps unrelated concurrent operations and
 * test workers completely unaffected.
 */
export function createOperationLockPauseForTesting(input: {
  operationId: Ulid;
  pauseAfter: OperationLockPausePoint;
}): OperationLockPauseController {
  assertUlid(input.operationId, 'test lock pause operationId');
  if (input.pauseAfter !== 'entity_locks_held') {
    throw new Error('MANCODE_TEST_LOCK_PAUSE_POINT_INVALID');
  }
  let signalReached!: () => void;
  let rejectReached!: (reason?: unknown) => void;
  const reached = new Promise<void>((resolve, reject) => {
    signalReached = resolve;
    rejectReached = reject;
  });
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let started = false;
  let released = false;
  const state: ActiveLockPauseInjection = {
    ...input,
    triggered: false,
    signalReached,
    resume: resumed,
  };
  return {
    reached,
    release(): void {
      if (released) return;
      released = true;
      resume();
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (started) throw new Error('MANCODE_TEST_LOCK_PAUSE_ALREADY_STARTED');
      started = true;
      return activeLockPause.run(state, async () => {
        try {
          const result = await operation();
          if (!state.triggered) {
            rejectReached(new Error('MANCODE_TEST_LOCK_PAUSE_NOT_REACHED'));
          }
          return result;
        } catch (error) {
          if (!state.triggered) rejectReached(error);
          throw error;
        }
      });
    },
  };
}

/** Called only at the shared post-journal lock-holding boundary. */
export function pauseIfOperationLockInjectedForTesting(
  operationId: Ulid,
  pauseAfter: OperationLockPausePoint,
): Promise<void> | null {
  const injection = activeLockPause.getStore();
  if (
    injection === undefined ||
    injection.triggered ||
    injection.operationId !== operationId ||
    injection.pauseAfter !== pauseAfter
  ) {
    return null;
  }
  injection.triggered = true;
  injection.signalReached();
  return injection.resume;
}

export function throwIfOperationCrashInjected(
  operationType: OperationType,
  crashAfter: 'prepared' | string,
): void {
  const injection = activeInjection.getStore();
  if (
    injection === undefined ||
    injection.triggered ||
    injection.operationType !== operationType ||
    injection.crashAfter !== crashAfter
  ) {
    return;
  }
  injection.triggered = true;
  throw new Error('MANCODE_TEST_OPERATION_CRASH_INJECTED');
}

/** Arms a business-write crash until the caller has made its visible change. */
export function armOperationCrashAfterVisibleWrite(
  operationType: OperationType,
  crashAfter: string,
): void {
  const injection = activeInjection.getStore();
  if (
    injection === undefined ||
    injection.triggered ||
    injection.operationType !== operationType ||
    injection.crashAfter !== crashAfter
  ) {
    return;
  }
  injection.deferredCrashAfter = crashAfter;
}

/** Throws before the next journal transition, after the preceding write. */
export function throwIfDeferredOperationCrashInjected(
  operationType: OperationType,
): void {
  const injection = activeInjection.getStore();
  if (
    injection === undefined ||
    injection.triggered ||
    injection.operationType !== operationType ||
    injection.deferredCrashAfter === null
  ) {
    return;
  }
  injection.triggered = true;
  throw new Error('MANCODE_TEST_OPERATION_CRASH_INJECTED');
}

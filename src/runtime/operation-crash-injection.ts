import { AsyncLocalStorage } from 'node:async_hooks';
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

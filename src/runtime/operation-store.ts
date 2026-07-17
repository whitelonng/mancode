import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUlid } from '../context/ids.js';
import { replaceFileAtomically } from './atomic-file.js';
import {
  type EntityHomeStore,
  operationDirectory,
} from './entity-home-store.js';
import { assertOperationAuthorizationAction } from './operation-definition.js';
import {
  type OperationJournalV1,
  type OperationTransitionOptions,
  assertOperationJournalTransition,
  assertOperationReservationTopology,
  operationJournalDigest,
  parseOperationJournal,
} from './operation-journal.js';
import {
  type OperationReservationV1,
  createOperationReservation,
  writeOperationReservation,
} from './operation-reservation.js';

export interface PrepareOperationStoresInput {
  primaryStore: EntityHomeStore;
  journal: OperationJournalV1;
  secondaryStores: EntityHomeStore[];
  now?: Date;
}

export async function createPreparedOperationJournal(
  store: EntityHomeStore,
  journal: OperationJournalV1,
): Promise<OperationJournalV1> {
  assertOperationAuthorizationAction(journal);
  if (journal.state !== 'prepared') {
    throw new Error('only a prepared operation journal may be created');
  }
  if (journal.primaryStoreId !== store.storeId) {
    throw new Error(
      'operation journal primaryStoreId does not match its home store',
    );
  }
  assertOperationReservationTopology(journal);
  if (journal.type !== 'transport_migrate' && store.kind !== 'checkout_local') {
    const migrationInProgress = (
      await listUnfinishedOperationJournals(store)
    ).some((candidate) => candidate.type === 'transport_migrate');
    if (migrationInProgress) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_FROZEN');
    }
  }
  const directory = operationDirectory(store);
  const target = operationJournalPath(store, journal.operationId);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(target, serialize(journal), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return journal;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readOperationJournal(store, journal.operationId);
    if (
      existing !== null &&
      operationJournalDigest(existing) === operationJournalDigest(journal)
    ) {
      return existing;
    }
    throw new Error('MANCODE_OPERATION_JOURNAL_CONFLICT');
  }
}

/**
 * Durable preparation happens before any business entity write. Once this
 * returns an error after creating the primary journal, callers must repair
 * forward rather than assume no reservation exists.
 */
export async function prepareOperationStores(
  input: PrepareOperationStoresInput,
): Promise<OperationReservationV1[]> {
  const { primaryStore, journal } = input;
  validateSecondaryStores(primaryStore, journal, input.secondaryStores);
  await createPreparedOperationJournal(primaryStore, journal);
  const createdAt = (input.now ?? new Date()).toISOString();
  const reservations: OperationReservationV1[] = [];
  for (const secondaryStore of input.secondaryStores) {
    const reservation = createOperationReservation(
      journal,
      secondaryStore.storeId,
      createdAt,
    );
    reservations.push(
      await writeOperationReservation(secondaryStore, reservation),
    );
  }
  return reservations;
}

export async function readOperationJournal(
  store: EntityHomeStore,
  operationId: string,
): Promise<OperationJournalV1 | null> {
  try {
    assertUlid(operationId, 'operation journal operationId');
    const raw = await readFile(
      operationJournalPath(store, operationId),
      'utf8',
    );
    return parseOperationJournal(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_OPERATION_JOURNAL_CORRUPT');
    }
    throw error;
  }
}

export async function updateOperationJournal(
  store: EntityHomeStore,
  next: OperationJournalV1,
  options: OperationTransitionOptions,
): Promise<OperationJournalV1> {
  const previous = await readOperationJournal(store, next.operationId);
  if (previous === null) throw new Error('MANCODE_OPERATION_JOURNAL_NOT_FOUND');
  if (
    previous.primaryStoreId !== store.storeId ||
    next.primaryStoreId !== store.storeId
  ) {
    throw new Error(
      'operation journal must be updated in its primary home store',
    );
  }
  assertOperationJournalTransition(previous, next, options);
  await atomicWriteOperationJournal(store, next);
  return next;
}

export async function listUnfinishedOperationJournals(
  store: EntityHomeStore,
): Promise<OperationJournalV1[]> {
  let entries: string[];
  try {
    entries = await readdir(operationDirectory(store));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const journals: OperationJournalV1[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const operationId = entry.slice(0, -'.json'.length);
    try {
      assertUlid(operationId, 'operation journal filename');
    } catch {
      throw new Error('MANCODE_OPERATION_JOURNAL_CORRUPT');
    }
    const journal = await readOperationJournal(store, operationId);
    if (
      journal !== null &&
      journal.state !== 'committed' &&
      journal.state !== 'aborted'
    ) {
      journals.push(journal);
    }
  }
  return journals.sort((left, right) =>
    Buffer.from(left.operationId, 'utf8').compare(
      Buffer.from(right.operationId, 'utf8'),
    ),
  );
}

export function operationJournalPath(
  store: EntityHomeStore,
  operationId: string,
): string {
  assertUlid(operationId, 'operation journal operationId');
  return path.join(operationDirectory(store), `${operationId}.json`);
}

async function atomicWriteOperationJournal(
  store: EntityHomeStore,
  journal: OperationJournalV1,
): Promise<void> {
  const target = operationJournalPath(store, journal.operationId);
  const temporary = path.join(
    operationDirectory(store),
    `.${journal.operationId}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, serialize(journal), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await replaceFileAtomically(temporary, target);
}

function validateSecondaryStores(
  primaryStore: EntityHomeStore,
  journal: OperationJournalV1,
  secondaryStores: EntityHomeStore[],
): void {
  if (journal.primaryStoreId !== primaryStore.storeId) {
    throw new Error(
      'operation journal primaryStoreId does not match primaryStore',
    );
  }
  const expectedStoreIds = new Set(
    journal.secondaryReservations.map((reservation) => reservation.storeId),
  );
  const suppliedStoreIds = new Set<string>();
  for (const store of secondaryStores) {
    if (
      store.storeId === primaryStore.storeId ||
      suppliedStoreIds.has(store.storeId)
    ) {
      throw new Error(
        'operation secondary stores must be unique and exclude primaryStore',
      );
    }
    suppliedStoreIds.add(store.storeId);
  }
  if (
    expectedStoreIds.size !== suppliedStoreIds.size ||
    [...expectedStoreIds].some((storeId) => !suppliedStoreIds.has(storeId))
  ) {
    throw new Error(
      'operation secondary stores do not match the journal reservations',
    );
  }
}

function serialize(journal: OperationJournalV1): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

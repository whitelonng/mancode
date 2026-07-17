import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  digestCanonicalJson,
  sortUtf8StringSet,
} from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  type EntityHomeStore,
  reservationDirectory,
} from './entity-home-store.js';
import {
  type OperationJournalV1,
  assertOperationReservationTopology,
  operationReservationJournalDigest,
} from './operation-journal.js';

export interface OperationReservationV1 {
  schemaVersion: 1;
  operationId: Ulid;
  primaryStoreId: string;
  entityKeys: string[];
  journalDigest: string;
  createdAt: string;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ENTITY_KEY_PATTERN = /^[a-z][a-z0-9_-]*:[^\0/\\]+$/;

export function parseOperationReservation(
  value: unknown,
): OperationReservationV1 {
  assertRecord(value, 'operation reservation');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'primaryStoreId',
      'entityKeys',
      'journalDigest',
      'createdAt',
    ],
    'operation reservation',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('operation reservation schemaVersion must be 1');
  }
  assertUlid(value.operationId, 'operation reservation operationId');
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    primaryStoreId: parseStoreId(
      value.primaryStoreId,
      'operation reservation primaryStoreId',
    ),
    entityKeys: parseEntityKeySet(
      value.entityKeys,
      'operation reservation entityKeys',
    ),
    journalDigest: parseDigest(
      value.journalDigest,
      'operation reservation journalDigest',
    ),
    createdAt: parseTimestamp(
      value.createdAt,
      'operation reservation createdAt',
    ),
  };
}

export function createOperationReservation(
  journal: OperationJournalV1,
  secondaryStoreId: string,
  createdAt: string,
): OperationReservationV1 {
  if (journal.state !== 'prepared') {
    throw new Error(
      'secondary reservations can only be created from a prepared journal',
    );
  }
  assertOperationReservationTopology(journal);
  const reservation = journal.secondaryReservations.find(
    (item) => item.storeId === secondaryStoreId,
  );
  if (reservation === undefined) {
    throw new Error('secondary store is not reserved by the primary journal');
  }
  return {
    schemaVersion: 1,
    operationId: journal.operationId,
    primaryStoreId: journal.primaryStoreId,
    entityKeys: reservation.entityKeys,
    journalDigest: operationReservationJournalDigest(journal),
    createdAt: parseTimestamp(createdAt, 'operation reservation createdAt'),
  };
}

export async function writeOperationReservation(
  store: EntityHomeStore,
  reservation: OperationReservationV1,
): Promise<OperationReservationV1> {
  if (reservation.primaryStoreId === store.storeId) {
    throw new Error(
      'primary store must not persist its own secondary reservation',
    );
  }
  const directory = reservationDirectory(store);
  const target = reservationPath(store, reservation.operationId);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(target, serialize(reservation), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return reservation;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readOperationReservation(
      store,
      reservation.operationId,
    );
    if (
      existing !== null &&
      digestCanonicalJson(existing) === digestCanonicalJson(reservation)
    ) {
      return existing;
    }
    throw new Error('MANCODE_OPERATION_RESERVATION_CONFLICT');
  }
}

export async function readOperationReservation(
  store: EntityHomeStore,
  operationId: string,
): Promise<OperationReservationV1 | null> {
  try {
    assertUlid(operationId, 'operation reservation operationId');
    const raw = await readFile(reservationPath(store, operationId), 'utf8');
    return parseOperationReservation(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_OPERATION_RESERVATION_CORRUPT');
    }
    throw error;
  }
}

/**
 * Removes only the exact reservation owned by a terminal primary journal.
 * Callers must already hold the primary operation's canonical entity locks.
 */
export async function removeOperationReservation(
  store: EntityHomeStore,
  operationId: string,
  primaryStoreId: string,
): Promise<void> {
  const existing = await readOperationReservation(store, operationId);
  if (existing === null) return;
  if (existing.primaryStoreId !== primaryStoreId) {
    throw new Error('MANCODE_OPERATION_RESERVATION_PRIMARY_MISMATCH');
  }
  try {
    await unlink(reservationPath(store, operationId));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export function reservationPath(
  store: EntityHomeStore,
  operationId: string,
): string {
  assertUlid(operationId, 'operation reservation operationId');
  return path.join(reservationDirectory(store), `${operationId}.json`);
}

function parseEntityKeySet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const entityKey of value) {
    if (typeof entityKey !== 'string') {
      throw new Error(`${label} must contain strings`);
    }
    assertEntityKey(entityKey, label);
  }
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized;
}

function parseStoreId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]*:[^\0]+$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertEntityKey(value: string, label: string): void {
  if (!ENTITY_KEY_PATTERN.test(value) || value.includes('..')) {
    throw new Error(`${label} is invalid`);
  }
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function serialize(reservation: OperationReservationV1): string {
  return `${JSON.stringify(reservation, null, 2)}\n`;
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

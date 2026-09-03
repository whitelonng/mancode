import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUlid } from '../context/ids.js';
import {
  type EntityHomeStore,
  operationDirectory,
} from './entity-home-store.js';
import {
  type OperationRecoveryPayloadV1,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from './operation-recovery-payload.js';

/** Recovery targets are separate from journal files so journal enumeration remains strict. */
export function operationRecoveryDirectory(store: EntityHomeStore): string {
  return path.join(operationDirectory(store), 'recovery');
}

export function operationRecoveryPayloadPath(
  store: EntityHomeStore,
  operationId: string,
): string {
  assertUlid(operationId, 'operation recovery payload operationId');
  return path.join(operationRecoveryDirectory(store), `${operationId}.json`);
}

export function operationRecoveryPayloadVersionPath(
  store: EntityHomeStore,
  operationId: string,
  payloadDigest: string,
): string {
  assertUlid(operationId, 'operation recovery payload operationId');
  return path.join(
    operationRecoveryDirectory(store),
    `${operationId}.${payloadDigestToken(payloadDigest)}.json`,
  );
}

/**
 * Persists recovery targets before the prepared journal is made durable. A
 * retry may observe the same target bundle, never a substitute for it.
 */
export async function writeOperationRecoveryPayload(
  store: EntityHomeStore,
  value: OperationRecoveryPayloadV1,
): Promise<OperationRecoveryPayloadV1> {
  const payload = parseOperationRecoveryPayload(value);
  if (payload.primaryStoreId !== store.storeId) {
    throw new Error(
      'operation recovery payload primaryStoreId does not match its home store',
    );
  }
  const directory = operationRecoveryDirectory(store);
  const target = operationRecoveryPayloadPath(store, payload.operationId);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(target, serialize(payload), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return payload;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readOperationRecoveryPayload(
      store,
      payload.operationId,
    );
    if (
      existing !== null &&
      operationRecoveryPayloadDigest(existing) ===
        operationRecoveryPayloadDigest(payload)
    ) {
      return existing;
    }
    throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_CONFLICT');
  }
}

/** Writes an immutable content-addressed payload before rebinding a journal. */
export async function writeOperationRecoveryPayloadVersion(
  store: EntityHomeStore,
  value: OperationRecoveryPayloadV1,
): Promise<OperationRecoveryPayloadV1> {
  const payload = parseOperationRecoveryPayload(value);
  if (payload.primaryStoreId !== store.storeId) {
    throw new Error(
      'operation recovery payload primaryStoreId does not match its home store',
    );
  }
  const digest = operationRecoveryPayloadDigest(payload);
  const directory = operationRecoveryDirectory(store);
  const target = operationRecoveryPayloadVersionPath(
    store,
    payload.operationId,
    digest,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(target, serialize(payload), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return payload;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readOperationRecoveryPayloadAtPath(target);
    if (
      existing !== null &&
      operationRecoveryPayloadDigest(existing) === digest
    ) {
      return existing;
    }
    throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_CONFLICT');
  }
}

export async function readOperationRecoveryPayload(
  store: EntityHomeStore,
  operationId: string,
): Promise<OperationRecoveryPayloadV1 | null> {
  return readOperationRecoveryPayloadAtPath(
    operationRecoveryPayloadPath(store, operationId),
  );
}

export async function readOperationRecoveryPayloadForDigest(
  store: EntityHomeStore,
  operationId: string,
  payloadDigest: string,
): Promise<OperationRecoveryPayloadV1 | null> {
  const versioned = await readOperationRecoveryPayloadAtPath(
    operationRecoveryPayloadVersionPath(store, operationId, payloadDigest),
  );
  if (versioned !== null) return versioned;
  return readOperationRecoveryPayload(store, operationId);
}

async function readOperationRecoveryPayloadAtPath(
  target: string,
): Promise<OperationRecoveryPayloadV1 | null> {
  try {
    const raw = await readFile(target, 'utf8');
    return parseOperationRecoveryPayload(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_CORRUPT');
    }
    throw error;
  }
}

function payloadDigestToken(payloadDigest: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(payloadDigest);
  if (match?.[1] === undefined) {
    throw new Error('operation recovery payload digest is invalid');
  }
  return match[1];
}

function serialize(payload: OperationRecoveryPayloadV1): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
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

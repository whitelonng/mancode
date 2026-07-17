import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import type { EntityHomeStore } from '../runtime/entity-home-store.js';
import { listUnfinishedOperationJournals } from '../runtime/operation-store.js';
import type { CoordinationTransport, ProjectConfigV1 } from './policy.js';
import type { TransportAuthorityTombstoneV1 } from './transport-migration.js';

export interface LocalTransportAuthorityStateV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  authorityId: string;
  coordinationDomainId: string;
  transportEpoch: number;
  state: 'active' | 'frozen' | 'tombstoned';
  operationId: Ulid;
  successorMode: CoordinationTransport | null;
  successorEpoch: number | null;
  tombstone: TransportAuthorityTombstoneV1 | null;
  updatedAt: string;
}

export function localTransportAuthorityStatePath(
  store: EntityHomeStore,
): string {
  if (store.kind === 'checkout_local') {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_OPERATION_STORE_INVALID');
  }
  return path.join(store.root, 'transport-authority', 'state.json');
}

export async function readLocalTransportAuthorityState(
  store: EntityHomeStore,
): Promise<LocalTransportAuthorityStateV1 | null> {
  const target = localTransportAuthorityStatePath(store);
  try {
    await assertSafeStateDirectory(path.dirname(target));
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('MANCODE_TRANSPORT_AUTHORITY_STATE_UNSAFE');
    }
    const state = parseLocalTransportAuthorityState(
      JSON.parse(await readFile(target, 'utf8')),
    );
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('MANCODE_TRANSPORT_AUTHORITY_STATE_UNSAFE');
    }
    return state;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_TRANSPORT_AUTHORITY_STATE_CORRUPT');
    }
    throw error;
  }
}

/** Shared mutation entry points call this before preparing a business write. */
export async function assertLocalCoordinationWriteAllowed(
  store: EntityHomeStore,
  expectedTransportEpoch: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(expectedTransportEpoch) ||
    expectedTransportEpoch < 1
  ) {
    throw new Error('MANCODE_TRANSPORT_EPOCH_CONFLICT');
  }
  const state = await readLocalTransportAuthorityState(store);
  // Marker-less authorities remain valid for projects that never migrated.
  if (state === null) return;
  if (state.transportEpoch !== expectedTransportEpoch) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_SPLIT_BRAIN');
  }
  if (state.state === 'frozen') {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_FROZEN');
  }
  if (state.state === 'tombstoned') {
    throw new Error('MANCODE_TRANSPORT_AUTHORITY_TOMBSTONED');
  }
}

/** Blocks ordinary coordination writes while a transport cutover is unfinished. */
export async function assertTransportCoordinationWriteAllowed(
  store: EntityHomeStore,
  config: ProjectConfigV1,
): Promise<void> {
  const migrations = (await listUnfinishedOperationJournals(store)).filter(
    (journal) => journal.type === 'transport_migrate',
  );
  if (migrations.length > 0) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_FROZEN');
  }
  if (config.transport.mode === 'local') {
    await assertLocalCoordinationWriteAllowed(store, config.transport.epoch);
  }
}

export async function writeLocalTransportAuthorityState(
  store: EntityHomeStore,
  value: LocalTransportAuthorityStateV1,
): Promise<void> {
  const target = localTransportAuthorityStatePath(store);
  await mkdir(path.dirname(target), { recursive: true });
  await assertSafeStateDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${createUlid()}.tmp`,
  );
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(parseLocalTransportAuthorityState(value), null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await replaceFileAtomically(temporary, target);
  } catch (error) {
    await unlinkIfExists(temporary);
    throw error;
  }
}

export function parseLocalTransportAuthorityState(
  value: unknown,
): LocalTransportAuthorityStateV1 {
  assertRecord(value, 'local transport authority state');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'workspaceId',
      'authorityId',
      'coordinationDomainId',
      'transportEpoch',
      'state',
      'operationId',
      'successorMode',
      'successorEpoch',
      'tombstone',
      'updatedAt',
    ],
    'local transport authority state',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('local transport authority state schemaVersion is invalid');
  }
  assertUlid(value.workspaceId, 'local transport authority workspaceId');
  assertUlid(value.operationId, 'local transport authority operationId');
  if (
    value.state !== 'active' &&
    value.state !== 'frozen' &&
    value.state !== 'tombstoned'
  ) {
    throw new Error('local transport authority state is invalid');
  }
  const successorMode = parseTransportModeOrNull(value.successorMode);
  const successorEpoch = parsePositiveIntegerOrNull(value.successorEpoch);
  const tombstone =
    value.tombstone === null
      ? null
      : parseTransportAuthorityTombstone(value.tombstone);
  if (
    (value.state === 'active' &&
      (successorMode !== null ||
        successorEpoch !== null ||
        tombstone !== null)) ||
    (value.state === 'frozen' &&
      (successorMode === null ||
        successorEpoch === null ||
        tombstone !== null)) ||
    (value.state === 'tombstoned' &&
      (successorMode === null || successorEpoch === null || tombstone === null))
  ) {
    throw new Error('local transport authority state shape is invalid');
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    authorityId: nonEmptyString(value.authorityId, 'authorityId'),
    coordinationDomainId: localDomainString(value.coordinationDomainId),
    transportEpoch: positiveInteger(value.transportEpoch, 'transportEpoch'),
    state: value.state,
    operationId: value.operationId,
    successorMode,
    successorEpoch,
    tombstone,
    updatedAt: timestamp(value.updatedAt, 'updatedAt'),
  };
}

export function parseTransportAuthorityTombstone(
  value: unknown,
): TransportAuthorityTombstoneV1 {
  assertRecord(value, 'transport authority tombstone');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'workspaceId',
      'sourceAuthorityId',
      'sourceTransportEpoch',
      'sourceCoordinationDomainId',
      'targetAuthorityId',
      'targetTransportEpoch',
      'targetCoordinationDomainId',
      'manifestDigest',
      'authorityReceipt',
      'activatedConfigRevision',
      'createdAt',
    ],
    'transport authority tombstone',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('transport authority tombstone schemaVersion is invalid');
  }
  assertUlid(value.operationId, 'transport authority tombstone operationId');
  assertUlid(value.workspaceId, 'transport authority tombstone workspaceId');
  const manifestDigest = nonEmptyString(value.manifestDigest, 'manifestDigest');
  if (!/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) {
    throw new Error('transport authority tombstone manifestDigest is invalid');
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    workspaceId: value.workspaceId,
    sourceAuthorityId: nonEmptyString(
      value.sourceAuthorityId,
      'sourceAuthorityId',
    ),
    sourceTransportEpoch: positiveInteger(
      value.sourceTransportEpoch,
      'sourceTransportEpoch',
    ),
    sourceCoordinationDomainId: nonEmptyString(
      value.sourceCoordinationDomainId,
      'sourceCoordinationDomainId',
    ),
    targetAuthorityId: nonEmptyString(
      value.targetAuthorityId,
      'targetAuthorityId',
    ),
    targetTransportEpoch: positiveInteger(
      value.targetTransportEpoch,
      'targetTransportEpoch',
    ),
    targetCoordinationDomainId: nonEmptyString(
      value.targetCoordinationDomainId,
      'targetCoordinationDomainId',
    ),
    manifestDigest,
    authorityReceipt: nonEmptyString(
      value.authorityReceipt,
      'authorityReceipt',
    ),
    activatedConfigRevision: positiveInteger(
      value.activatedConfigRevision,
      'activatedConfigRevision',
    ),
    createdAt: timestamp(value.createdAt, 'createdAt'),
  };
}

function parseTransportModeOrNull(
  value: unknown,
): CoordinationTransport | null {
  if (value === null) return null;
  if (value !== 'local' && value !== 'git-ref') {
    throw new Error('local transport authority successorMode is invalid');
  }
  return value;
}

function parsePositiveIntegerOrNull(value: unknown): number | null {
  return value === null ? null : positiveInteger(value, 'successorEpoch');
}

function localDomainString(value: unknown): string {
  const parsed = nonEmptyString(value, 'coordinationDomainId');
  if (!parsed.startsWith('local:') || parsed.includes('..')) {
    throw new Error(
      'local transport authority coordinationDomainId is invalid',
    );
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

async function unlinkIfExists(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function assertSafeStateDirectory(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_TRANSPORT_AUTHORITY_STATE_UNSAFE');
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

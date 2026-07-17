import { sortUtf8StringSet } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  type ProjectConfigV1,
  projectConfigIdentityDigest,
} from '../team/policy.js';

export interface CommonDirRegistryV1 {
  schemaVersion: 1;
  workspaceIds: Ulid[];
  updatedAt: string;
}

export interface WorkspaceBindingV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  repositoryBindingId: Ulid;
  projectPathFromWorktreeRoot: string;
  configSchemaVersion: number;
  configIdentityDigest: string;
  registeredAt: string;
}

export interface CheckoutBindingV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  repositoryBindingId: Ulid;
  checkoutId: Ulid;
  worktreeGitDirHash: string;
  projectRealpathHash: string;
  registeredAt: string;
  lastSeenAt: string;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseCommonDirRegistry(value: unknown): CommonDirRegistryV1 {
  assertRecord(value, 'common-dir registry');
  assertKnownKeys(
    value,
    ['schemaVersion', 'workspaceIds', 'updatedAt'],
    'common-dir registry',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('common-dir registry schemaVersion must be 1');
  }
  return {
    schemaVersion: 1,
    workspaceIds: parseUlidSet(
      value.workspaceIds,
      'common-dir registry workspaceIds',
    ),
    updatedAt: parseTimestamp(value.updatedAt, 'common-dir registry updatedAt'),
  };
}

export function parseWorkspaceBinding(value: unknown): WorkspaceBindingV1 {
  assertRecord(value, 'workspace binding');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'workspaceId',
      'repositoryBindingId',
      'projectPathFromWorktreeRoot',
      'configSchemaVersion',
      'configIdentityDigest',
      'registeredAt',
    ],
    'workspace binding',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('workspace binding schemaVersion must be 1');
  }
  assertUlid(value.workspaceId, 'workspace binding workspaceId');
  assertUlid(
    value.repositoryBindingId,
    'workspace binding repositoryBindingId',
  );
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    repositoryBindingId: value.repositoryBindingId,
    projectPathFromWorktreeRoot: parseProjectRelativePath(
      value.projectPathFromWorktreeRoot,
    ),
    configSchemaVersion: parsePositiveInteger(
      value.configSchemaVersion,
      'workspace binding configSchemaVersion',
    ),
    configIdentityDigest: parseDigest(
      value.configIdentityDigest,
      'workspace binding configIdentityDigest',
    ),
    registeredAt: parseTimestamp(
      value.registeredAt,
      'workspace binding registeredAt',
    ),
  };
}

export function parseCheckoutBinding(value: unknown): CheckoutBindingV1 {
  assertRecord(value, 'checkout binding');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'workspaceId',
      'repositoryBindingId',
      'checkoutId',
      'worktreeGitDirHash',
      'projectRealpathHash',
      'registeredAt',
      'lastSeenAt',
    ],
    'checkout binding',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('checkout binding schemaVersion must be 1');
  }
  assertUlid(value.workspaceId, 'checkout binding workspaceId');
  assertUlid(value.repositoryBindingId, 'checkout binding repositoryBindingId');
  assertUlid(value.checkoutId, 'checkout binding checkoutId');
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    repositoryBindingId: value.repositoryBindingId,
    checkoutId: value.checkoutId,
    worktreeGitDirHash: parseDigest(
      value.worktreeGitDirHash,
      'checkout binding worktreeGitDirHash',
    ),
    projectRealpathHash: parseDigest(
      value.projectRealpathHash,
      'checkout binding projectRealpathHash',
    ),
    registeredAt: parseTimestamp(
      value.registeredAt,
      'checkout binding registeredAt',
    ),
    lastSeenAt: parseTimestamp(value.lastSeenAt, 'checkout binding lastSeenAt'),
  };
}

export function assertWorkspaceBindingMatchesConfig(
  binding: WorkspaceBindingV1,
  config: ProjectConfigV1,
): void {
  if (
    binding.workspaceId !== config.workspaceId ||
    binding.configSchemaVersion !== config.schemaVersion ||
    binding.configIdentityDigest !== projectConfigIdentityDigest(config)
  ) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
}

export function assertWorkspaceBindingCompatible(
  existing: WorkspaceBindingV1,
  candidate: WorkspaceBindingV1,
): void {
  if (
    existing.workspaceId !== candidate.workspaceId ||
    existing.repositoryBindingId !== candidate.repositoryBindingId ||
    existing.projectPathFromWorktreeRoot !==
      candidate.projectPathFromWorktreeRoot ||
    existing.configSchemaVersion !== candidate.configSchemaVersion ||
    existing.configIdentityDigest !== candidate.configIdentityDigest
  ) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
}

export function assertCheckoutBindingMatchesWorkspace(
  checkout: CheckoutBindingV1,
  workspace: WorkspaceBindingV1,
): void {
  if (
    checkout.workspaceId !== workspace.workspaceId ||
    checkout.repositoryBindingId !== workspace.repositoryBindingId
  ) {
    throw new Error('MANCODE_CHECKOUT_BINDING_MISMATCH');
  }
}

export function localCoordinationDomainId(
  repositoryBindingId: Ulid,
  workspaceId: Ulid,
): string {
  assertUlid(repositoryBindingId, 'local coordination repositoryBindingId');
  assertUlid(workspaceId, 'local coordination workspaceId');
  return `local:${repositoryBindingId}:${workspaceId}`;
}

export function gitRefCoordinationDomainId(
  remoteIdentityHash: string,
  workspaceId: Ulid,
  transportEpoch: number | Ulid,
): string {
  parseDigest(remoteIdentityHash, 'git-ref coordination remoteIdentityHash');
  assertUlid(workspaceId, 'git-ref coordination workspaceId');
  if (typeof transportEpoch === 'number') {
    if (!Number.isSafeInteger(transportEpoch) || transportEpoch < 1) {
      throw new Error(
        'git-ref coordination transportEpoch must be a positive integer',
      );
    }
  } else {
    // Read compatibility for early V3 fixtures that used an opaque ULID epoch.
    assertUlid(transportEpoch, 'git-ref coordination transportEpoch');
  }
  return `git-ref:${remoteIdentityHash}:${workspaceId}:${transportEpoch}`;
}

function parseUlidSet(value: unknown, label: string): Ulid[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) assertUlid(item, label);
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized as Ulid[];
}

function parseProjectRelativePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.includes('\\')
  ) {
    throw new Error('workspace binding projectPathFromWorktreeRoot is invalid');
  }
  if (value === '.') return value;
  if (
    !value ||
    value.startsWith('/') ||
    value
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('workspace binding projectPathFromWorktreeRoot is invalid');
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
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

import {
  digestCanonicalJson,
  sortUtf8StringSet,
} from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertSharedTextSafe } from '../context/privacy.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { type CapabilityLevel, parseCapabilityLevel } from './capabilities.js';

export type CoordinationMode = 'local' | 'git-ref';
export type ClaimState =
  | 'pending'
  | 'active'
  | 'released'
  | 'expired'
  | 'transferred'
  | 'cancelled';

export interface CodeRef {
  branch: string;
  head: string;
}

export interface ClaimScope {
  paths: string[];
  modules: string[];
  apis: string[];
  schemas: string[];
}

export interface ClaimV1 {
  schemaVersion: 1;
  claimId: Ulid;
  workspaceId: Ulid;
  coordinationDomainId: string;
  authority: {
    mode: CoordinationMode;
    remoteRevision: string | null;
  };
  taskRef: TaskRef;
  taskRevisionAtAcquire: number;
  lastValidatedTaskRevision: number;
  implementationScopeDigest: string;
  ownershipEpochAtAcquire: number;
  ownerActorId: Ulid;
  state: ClaimState;
  revision: number;
  scope: ClaimScope;
  scopeDigest: string;
  codeRefAtAcquire: CodeRef;
  lastValidatedCodeRef: CodeRef;
  acquisitionEnforcement: CapabilityLevel;
  writeGuard: CapabilityLevel;
  expiresAt: string;
  predecessorClaimId: Ulid | null;
  successorClaimId: Ulid | null;
  lastOperationId: Ulid | null;
  createdAt: string;
  updatedAt: string;
}

const CLAIM_STATES = new Set<ClaimState>([
  'pending',
  'active',
  'released',
  'expired',
  'transferred',
  'cancelled',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseClaim(value: unknown): ClaimV1 {
  assertRecord(value, 'claim');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'claimId',
      'workspaceId',
      'coordinationDomainId',
      'authority',
      'taskRef',
      'taskRevisionAtAcquire',
      'lastValidatedTaskRevision',
      'implementationScopeDigest',
      'ownershipEpochAtAcquire',
      'ownerActorId',
      'state',
      'revision',
      'scope',
      'scopeDigest',
      'codeRefAtAcquire',
      'lastValidatedCodeRef',
      'acquisitionEnforcement',
      'writeGuard',
      'expiresAt',
      'predecessorClaimId',
      'successorClaimId',
      'lastOperationId',
      'createdAt',
      'updatedAt',
    ],
    'claim',
  );
  if (value.schemaVersion !== 1)
    throw new Error('claim schemaVersion must be 1');
  assertUlid(value.claimId, 'claimId');
  assertUlid(value.workspaceId, 'claim workspaceId');
  assertUlid(value.ownerActorId, 'claim ownerActorId');
  const state = parseClaimState(value.state);
  const scope = parseClaimScope(value.scope);
  const scopeDigest = parseDigest(value.scopeDigest, 'claim scopeDigest');
  if (scopeDigest !== digestCanonicalJson(scope)) {
    throw new Error('claim scopeDigest does not match the canonical scope');
  }
  const taskRef = parseTaskRefValue(value.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('claims may only target shared TaskRefs');
  }
  const claim: ClaimV1 = {
    schemaVersion: 1,
    claimId: value.claimId,
    workspaceId: value.workspaceId,
    coordinationDomainId: parseCoordinationDomainId(value.coordinationDomainId),
    authority: parseAuthority(value.authority, state),
    taskRef,
    taskRevisionAtAcquire: parsePositiveInteger(
      value.taskRevisionAtAcquire,
      'claim taskRevisionAtAcquire',
    ),
    lastValidatedTaskRevision: parsePositiveInteger(
      value.lastValidatedTaskRevision,
      'claim lastValidatedTaskRevision',
    ),
    implementationScopeDigest: parseDigest(
      value.implementationScopeDigest,
      'claim implementationScopeDigest',
    ),
    ownershipEpochAtAcquire: parseNonNegativeInteger(
      value.ownershipEpochAtAcquire,
      'claim ownershipEpochAtAcquire',
    ),
    ownerActorId: value.ownerActorId,
    state,
    revision: parsePositiveInteger(value.revision, 'claim revision'),
    scope,
    scopeDigest,
    codeRefAtAcquire: parseCodeRef(
      value.codeRefAtAcquire,
      'claim codeRefAtAcquire',
    ),
    lastValidatedCodeRef: parseCodeRef(
      value.lastValidatedCodeRef,
      'claim lastValidatedCodeRef',
    ),
    acquisitionEnforcement: parseCapabilityLevel(
      value.acquisitionEnforcement,
      'claim acquisitionEnforcement',
    ),
    writeGuard: parseCapabilityLevel(value.writeGuard, 'claim writeGuard'),
    expiresAt: parseTimestamp(value.expiresAt, 'claim expiresAt'),
    predecessorClaimId: parseUlidOrNull(
      value.predecessorClaimId,
      'claim predecessorClaimId',
    ),
    successorClaimId: parseUlidOrNull(
      value.successorClaimId,
      'claim successorClaimId',
    ),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'claim lastOperationId',
    ),
    createdAt: parseTimestamp(value.createdAt, 'claim createdAt'),
    updatedAt: parseTimestamp(value.updatedAt, 'claim updatedAt'),
  };
  assertClaimStateShape(claim);
  return claim;
}

export function assertClaimTransition(previous: ClaimV1, next: ClaimV1): void {
  assertClaimIdentityIsStable(previous, next);
  if (next.revision !== previous.revision + 1) {
    throw new Error('claim revision must increase exactly once per mutation');
  }
  if (next.lastValidatedTaskRevision < previous.lastValidatedTaskRevision) {
    throw new Error('claim lastValidatedTaskRevision cannot regress');
  }
  if (previous.state === next.state) return;
  if (!allowedClaimTransitions(previous.state).has(next.state)) {
    throw new Error(
      `invalid claim state transition: ${previous.state} -> ${next.state}`,
    );
  }
}

function parseClaimState(value: unknown): ClaimState {
  if (typeof value !== 'string' || !CLAIM_STATES.has(value as ClaimState)) {
    throw new Error('claim state is invalid');
  }
  return value as ClaimState;
}

export function parseClaimScope(value: unknown): ClaimScope {
  assertRecord(value, 'claim scope');
  assertKnownKeys(
    value,
    ['paths', 'modules', 'apis', 'schemas'],
    'claim scope',
  );
  const scope: ClaimScope = {
    paths: parseStringSet(value.paths, 'claim scope paths'),
    modules: parseStringSet(value.modules, 'claim scope modules'),
    apis: parseStringSet(value.apis, 'claim scope apis'),
    schemas: parseStringSet(value.schemas, 'claim scope schemas'),
  };
  if (
    scope.paths.length === 0 &&
    scope.modules.length === 0 &&
    scope.apis.length === 0 &&
    scope.schemas.length === 0
  ) {
    throw new Error(
      'claim scope must include at least one path, module, API, or schema',
    );
  }
  for (const [label, values] of [
    ['paths', scope.paths],
    ['modules', scope.modules],
    ['apis', scope.apis],
    ['schemas', scope.schemas],
  ] as const) {
    for (const item of values) {
      assertSharedTextSafe(item, `claim scope ${label}`);
      if (label === 'paths') assertClaimScopePath(item);
    }
  }
  return scope;
}

/** Normalizes interactive input before applying the stricter stored schema. */
export function normalizeClaimScope(value: unknown): ClaimScope {
  assertRecord(value, 'claim scope');
  assertKnownKeys(
    value,
    ['paths', 'modules', 'apis', 'schemas'],
    'claim scope',
  );
  return parseClaimScope({
    paths: normalizeStringSet(value.paths, 'claim scope paths'),
    modules: normalizeStringSet(value.modules, 'claim scope modules'),
    apis: normalizeStringSet(value.apis, 'claim scope apis'),
    schemas: normalizeStringSet(value.schemas, 'claim scope schemas'),
  });
}

/** Claim globs are repository-relative, POSIX-style patterns only. */
function assertClaimScopePath(value: string): void {
  if (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('claim scope paths must be safe repository-relative globs');
  }
}

function parseAuthority(
  value: unknown,
  state: ClaimState,
): ClaimV1['authority'] {
  assertRecord(value, 'claim authority');
  assertKnownKeys(value, ['mode', 'remoteRevision'], 'claim authority');
  if (value.mode !== 'local' && value.mode !== 'git-ref') {
    throw new Error('claim authority mode must be local or git-ref');
  }
  if (value.mode === 'local' && value.remoteRevision !== null) {
    throw new Error('local claim authority must not carry a remote revision');
  }
  if (
    value.mode === 'git-ref' &&
    state === 'active' &&
    (typeof value.remoteRevision !== 'string' || !value.remoteRevision.trim())
  ) {
    throw new Error('active git-ref claims require a remote revision');
  }
  if (
    value.remoteRevision !== null &&
    (typeof value.remoteRevision !== 'string' || !value.remoteRevision.trim())
  ) {
    throw new Error('claim remote revision must be a non-empty string or null');
  }
  return { mode: value.mode, remoteRevision: value.remoteRevision };
}

function parseCodeRef(value: unknown, label: string): CodeRef {
  assertRecord(value, label);
  assertKnownKeys(value, ['branch', 'head'], label);
  if (
    typeof value.branch !== 'string' ||
    !value.branch.trim() ||
    typeof value.head !== 'string' ||
    !value.head.trim()
  ) {
    throw new Error(`${label} branch and head are required`);
  }
  return { branch: value.branch, head: value.head };
}

function parseStringSet(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized;
}

function normalizeStringSet(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return sortUtf8StringSet(value);
}

function parseCoordinationDomainId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(local|git-ref):[^\0]+$/.test(value) ||
    value.includes('..')
  ) {
    throw new Error('claim coordinationDomainId is invalid');
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, label);
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function assertClaimStateShape(claim: ClaimV1): void {
  if (claim.state === 'transferred' && claim.successorClaimId === null) {
    throw new Error('transferred claims require successorClaimId');
  }
  if (claim.state === 'active' && claim.successorClaimId !== null) {
    throw new Error('active claims cannot have successorClaimId');
  }
  if (
    claim.lastValidatedTaskRevision < claim.taskRevisionAtAcquire ||
    claim.lastValidatedCodeRef.head.length === 0
  ) {
    throw new Error('claim validation snapshot is invalid');
  }
}

function assertClaimIdentityIsStable(previous: ClaimV1, next: ClaimV1): void {
  if (
    previous.claimId !== next.claimId ||
    previous.workspaceId !== next.workspaceId ||
    previous.coordinationDomainId !== next.coordinationDomainId ||
    previous.authority.mode !== next.authority.mode ||
    !sameTaskRef(previous.taskRef, next.taskRef) ||
    previous.taskRevisionAtAcquire !== next.taskRevisionAtAcquire ||
    previous.implementationScopeDigest !== next.implementationScopeDigest ||
    previous.ownershipEpochAtAcquire !== next.ownershipEpochAtAcquire ||
    previous.ownerActorId !== next.ownerActorId ||
    previous.scopeDigest !== next.scopeDigest ||
    JSON.stringify(previous.scope) !== JSON.stringify(next.scope) ||
    JSON.stringify(previous.codeRefAtAcquire) !==
      JSON.stringify(next.codeRefAtAcquire) ||
    previous.createdAt !== next.createdAt
  ) {
    throw new Error('claim acquire snapshot and scope are immutable');
  }
}

function allowedClaimTransitions(from: ClaimState): Set<ClaimState> {
  switch (from) {
    case 'pending':
      return new Set(['active', 'cancelled']);
    case 'active':
      return new Set(['released', 'expired', 'transferred']);
    case 'released':
    case 'expired':
    case 'transferred':
    case 'cancelled':
      return new Set();
  }
}

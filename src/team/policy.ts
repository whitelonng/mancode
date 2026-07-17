import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';

export type CoordinationTransport = 'local' | 'git-ref';
export type TeamRecommendationPolicy = 'on' | 'off' | 'auto';

export interface ProjectConfigV1 {
  schemaVersion: 1;
  revision: number;
  workspaceId: Ulid;
  transport: {
    mode: CoordinationTransport;
    remote: string | null;
    /** Monotonic authority generation; every transport switch creates a new domain. */
    epoch: number;
  };
  lastOperationId: Ulid | null;
  updatedAt: string;
}

export interface TeamPolicyV1 {
  schemaVersion: 1;
  revision: number;
  workspaceId: Ulid;
  policy: TeamRecommendationPolicy;
  recentDays: number;
  defaultVisibility: 'local' | 'shared';
  shareConfirmedDecisions: boolean;
  retention: {
    localRawArtifactDays: number;
    localCacheDays: number;
    completedSessionDays: number;
  };
  lastOperationId: Ulid | null;
  updatedAt: string;
}

export type ProjectConfigTransitionKind =
  | 'ordinary'
  | 'transport_set'
  | 'transport_migrate';

export const V3_LAYOUT_VERSION = 3;

export function parseProjectConfig(value: unknown): ProjectConfigV1 {
  assertRecord(value, 'project config');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'revision',
      'workspaceId',
      'transport',
      'lastOperationId',
      'updatedAt',
    ],
    'project config',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('project config schemaVersion must be 1');
  }
  assertUlid(value.workspaceId, 'project config workspaceId');
  return {
    schemaVersion: 1,
    revision: parsePositiveInteger(value.revision, 'project config revision'),
    workspaceId: value.workspaceId,
    transport: parseTransport(value.transport),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'project config lastOperationId',
    ),
    updatedAt: parseTimestamp(value.updatedAt, 'project config updatedAt'),
  };
}

export function parseTeamPolicy(value: unknown): TeamPolicyV1 {
  assertRecord(value, 'team policy');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'revision',
      'workspaceId',
      'policy',
      'recentDays',
      'defaultVisibility',
      'shareConfirmedDecisions',
      'retention',
      'lastOperationId',
      'updatedAt',
    ],
    'team policy',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('team policy schemaVersion must be 1');
  }
  assertUlid(value.workspaceId, 'team policy workspaceId');
  if (
    value.policy !== 'on' &&
    value.policy !== 'off' &&
    value.policy !== 'auto'
  ) {
    throw new Error('team policy policy is invalid');
  }
  if (
    value.defaultVisibility !== 'local' &&
    value.defaultVisibility !== 'shared'
  ) {
    throw new Error('team policy defaultVisibility is invalid');
  }
  if (typeof value.shareConfirmedDecisions !== 'boolean') {
    throw new Error('team policy shareConfirmedDecisions must be boolean');
  }
  return {
    schemaVersion: 1,
    revision: parsePositiveInteger(value.revision, 'team policy revision'),
    workspaceId: value.workspaceId,
    policy: value.policy,
    recentDays: parseNonNegativeInteger(
      value.recentDays,
      'team policy recentDays',
    ),
    defaultVisibility: value.defaultVisibility,
    shareConfirmedDecisions: value.shareConfirmedDecisions,
    retention: parseRetention(value.retention),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'team policy lastOperationId',
    ),
    updatedAt: parseTimestamp(value.updatedAt, 'team policy updatedAt'),
  };
}

export function projectConfigIdentityDigest(config: ProjectConfigV1): string {
  return digestCanonicalJson({
    workspaceId: config.workspaceId,
    configSchemaVersion: config.schemaVersion,
    layoutVersion: V3_LAYOUT_VERSION,
  });
}

/** Binds a remote transport manifest to the exact active configuration CAS. */
export function projectConfigDigest(config: ProjectConfigV1): string {
  return digestCanonicalJson(parseProjectConfig(config));
}

export function assertConfigPolicyConsistency(
  config: ProjectConfigV1,
  policy: TeamPolicyV1,
): void {
  if (config.workspaceId !== policy.workspaceId) {
    throw new Error('project config and team policy workspaceId must match');
  }
}

export function assertProjectConfigTransition(
  previous: ProjectConfigV1,
  next: ProjectConfigV1,
  kind: ProjectConfigTransitionKind,
): void {
  assertConfigIdentityStable(previous, next);
  assertRevisionIncrease(
    previous.revision,
    next.revision,
    'project config revision',
  );
  const transportChanged =
    previous.transport.mode !== next.transport.mode ||
    previous.transport.remote !== next.transport.remote ||
    previous.transport.epoch !== next.transport.epoch;
  if (transportChanged && kind === 'ordinary') {
    throw new Error(
      'project config transport may only change through transport_set or transport_migrate',
    );
  }
  if (!transportChanged && kind !== 'ordinary') {
    throw new Error(
      'transport mutation requires a changed project config transport',
    );
  }
  if (
    kind !== 'ordinary' &&
    next.transport.epoch !== previous.transport.epoch + 1
  ) {
    throw new Error(
      'transport mutation must increase the authority epoch exactly once',
    );
  }
}

export function assertTeamPolicyTransition(
  previous: TeamPolicyV1,
  next: TeamPolicyV1,
): void {
  if (
    previous.schemaVersion !== next.schemaVersion ||
    previous.workspaceId !== next.workspaceId
  ) {
    throw new Error('team policy schemaVersion and workspaceId are immutable');
  }
  assertRevisionIncrease(
    previous.revision,
    next.revision,
    'team policy revision',
  );
}

/** Ordinary mutations use one authority's CAS at a time. */
export function assertIndependentConfigPolicyUpdate(
  previousConfig: ProjectConfigV1,
  nextConfig: ProjectConfigV1,
  previousPolicy: TeamPolicyV1,
  nextPolicy: TeamPolicyV1,
): void {
  assertConfigPolicyConsistency(nextConfig, nextPolicy);
  const configChanged = previousConfig.revision !== nextConfig.revision;
  const policyChanged = previousPolicy.revision !== nextPolicy.revision;
  if (configChanged && policyChanged) {
    throw new Error(
      'project config and team policy cannot be updated by one ordinary patch',
    );
  }
}

function parseTransport(value: unknown): ProjectConfigV1['transport'] {
  assertRecord(value, 'project config transport');
  assertKnownKeys(
    value,
    ['mode', 'remote', 'epoch'],
    'project config transport',
  );
  if (value.mode !== 'local' && value.mode !== 'git-ref') {
    throw new Error('project config transport mode is invalid');
  }
  const remote = parseNonEmptyStringOrNull(
    value.remote,
    'project config transport remote',
  );
  if (value.mode === 'local' && remote !== null) {
    throw new Error('local project config transport must not set a remote');
  }
  if (value.mode === 'git-ref' && remote === null) {
    throw new Error('git-ref project config transport requires a remote');
  }
  // V3 configurations created before remote coordination existed did not
  // persist an epoch. They belong to the initial local authority generation.
  const epoch =
    value.epoch === undefined
      ? 1
      : parsePositiveInteger(value.epoch, 'project config transport epoch');
  return { mode: value.mode, remote, epoch };
}

function parseRetention(value: unknown): TeamPolicyV1['retention'] {
  assertRecord(value, 'team policy retention');
  assertKnownKeys(
    value,
    ['localRawArtifactDays', 'localCacheDays', 'completedSessionDays'],
    'team policy retention',
  );
  return {
    localRawArtifactDays: parseNonNegativeInteger(
      value.localRawArtifactDays,
      'team policy retention localRawArtifactDays',
    ),
    localCacheDays: parseNonNegativeInteger(
      value.localCacheDays,
      'team policy retention localCacheDays',
    ),
    completedSessionDays: parseNonNegativeInteger(
      value.completedSessionDays,
      'team policy retention completedSessionDays',
    ),
  };
}

function assertConfigIdentityStable(
  previous: ProjectConfigV1,
  next: ProjectConfigV1,
): void {
  if (
    previous.schemaVersion !== next.schemaVersion ||
    previous.workspaceId !== next.workspaceId
  ) {
    throw new Error(
      'project config schemaVersion and workspaceId are immutable',
    );
  }
}

function assertRevisionIncrease(
  previous: number,
  next: number,
  label: string,
): void {
  if (next !== previous + 1) {
    throw new Error(`${label} must increase exactly once per mutation`);
  }
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

function parseNonEmptyStringOrNull(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string or null`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

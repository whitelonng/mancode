import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { assertKnownKeys, assertRecord } from '../context/validation.js';

export type ClaimConflictDiagnosticLevel =
  | 'info'
  | 'warning'
  | 'blocker'
  | 'unknown';

export type LocalDiagnosticEvent =
  | { kind: 'context_stale' }
  | { kind: 'revision_conflict' }
  | { kind: 'claim_conflict'; level: ClaimConflictDiagnosticLevel }
  | { kind: 'repair_operation' }
  | { kind: 'migration_split_brain' }
  | { kind: 'adapter_capability_downgrade' };

export interface LocalDiagnosticsConfigV1 {
  schemaVersion: 1;
  enabled: boolean;
  updatedAt: string;
}

/** This file intentionally has no free-form values, paths, identities, or text. */
export interface LocalDiagnosticsV1 {
  schemaVersion: 1;
  contextStaleCount: number;
  revisionConflictCount: number;
  claimConflictCounts: Record<ClaimConflictDiagnosticLevel, number>;
  repairOperationCount: number;
  migrationSplitBrainDetectionCount: number;
  adapterCapabilityDowngradeCount: number;
  updatedAt: string;
}

const CLAIM_CONFLICT_LEVELS: ClaimConflictDiagnosticLevel[] = [
  'info',
  'warning',
  'blocker',
  'unknown',
];

/** Missing configuration means local aggregate diagnostics are enabled. */
export async function readLocalDiagnosticsConfig(
  projectRoot: string,
): Promise<LocalDiagnosticsConfigV1> {
  const stored = await readJsonOrNull(
    localDiagnosticsConfigPath(projectRoot),
    parseLocalDiagnosticsConfig,
  );
  return (
    stored ?? {
      schemaVersion: 1,
      enabled: true,
      updatedAt: new Date(0).toISOString(),
    }
  );
}

export async function readLocalDiagnostics(
  projectRoot: string,
): Promise<LocalDiagnosticsV1 | null> {
  return readJsonOrNull(
    localDiagnosticsPath(projectRoot),
    parseLocalDiagnostics,
  );
}

/** Disabling immediately removes all collected local aggregates. */
export async function setLocalDiagnosticsEnabled(
  projectRoot: string,
  enabled: boolean,
  now: Date = new Date(),
): Promise<LocalDiagnosticsConfigV1> {
  const config: LocalDiagnosticsConfigV1 = {
    schemaVersion: 1,
    enabled,
    updatedAt: now.toISOString(),
  };
  await writeJsonAtomic(localDiagnosticsConfigPath(projectRoot), config);
  if (!enabled) {
    await rm(localDiagnosticsPath(projectRoot), { force: true });
  }
  return config;
}

/**
 * Records one fixed metric. The event type deliberately has no field that can
 * carry project content, a filesystem path, or actor identity.
 */
export async function recordLocalDiagnostic(
  projectRoot: string,
  event: LocalDiagnosticEvent,
  now: Date = new Date(),
): Promise<LocalDiagnosticsV1 | null> {
  const config = await readLocalDiagnosticsConfig(projectRoot);
  if (!config.enabled) return null;
  const current =
    (await readLocalDiagnostics(projectRoot)) ?? emptyLocalDiagnostics(now);
  const next = incrementDiagnostic(current, event, now);
  await writeJsonAtomic(localDiagnosticsPath(projectRoot), next);
  return next;
}

export function localDiagnosticsPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'diagnostics.json',
  );
}

export function localDiagnosticsConfigPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'diagnostics-config.json',
  );
}

export function parseLocalDiagnosticsConfig(
  value: unknown,
): LocalDiagnosticsConfigV1 {
  assertRecord(value, 'local diagnostics config');
  assertKnownKeys(
    value,
    ['schemaVersion', 'enabled', 'updatedAt'],
    'local diagnostics config',
  );
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') {
    throw new Error('local diagnostics config is invalid');
  }
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    updatedAt: parseTimestamp(
      value.updatedAt,
      'local diagnostics config updatedAt',
    ),
  };
}

export function parseLocalDiagnostics(value: unknown): LocalDiagnosticsV1 {
  assertRecord(value, 'local diagnostics');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'contextStaleCount',
      'revisionConflictCount',
      'claimConflictCounts',
      'repairOperationCount',
      'migrationSplitBrainDetectionCount',
      'adapterCapabilityDowngradeCount',
      'updatedAt',
    ],
    'local diagnostics',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('local diagnostics schemaVersion is invalid');
  }
  assertRecord(
    value.claimConflictCounts,
    'local diagnostics claimConflictCounts',
  );
  assertKnownKeys(
    value.claimConflictCounts,
    CLAIM_CONFLICT_LEVELS,
    'local diagnostics claimConflictCounts',
  );
  const claimConflictCounts = {} as Record<
    ClaimConflictDiagnosticLevel,
    number
  >;
  for (const level of CLAIM_CONFLICT_LEVELS) {
    claimConflictCounts[level] = parseCount(
      value.claimConflictCounts[level],
      `local diagnostics claim conflict ${level}`,
    );
  }
  return {
    schemaVersion: 1,
    contextStaleCount: parseCount(
      value.contextStaleCount,
      'local diagnostics contextStaleCount',
    ),
    revisionConflictCount: parseCount(
      value.revisionConflictCount,
      'local diagnostics revisionConflictCount',
    ),
    claimConflictCounts,
    repairOperationCount: parseCount(
      value.repairOperationCount,
      'local diagnostics repairOperationCount',
    ),
    migrationSplitBrainDetectionCount: parseCount(
      value.migrationSplitBrainDetectionCount,
      'local diagnostics migrationSplitBrainDetectionCount',
    ),
    adapterCapabilityDowngradeCount: parseCount(
      value.adapterCapabilityDowngradeCount,
      'local diagnostics adapterCapabilityDowngradeCount',
    ),
    updatedAt: parseTimestamp(value.updatedAt, 'local diagnostics updatedAt'),
  };
}

function emptyLocalDiagnostics(now: Date): LocalDiagnosticsV1 {
  return {
    schemaVersion: 1,
    contextStaleCount: 0,
    revisionConflictCount: 0,
    claimConflictCounts: { info: 0, warning: 0, blocker: 0, unknown: 0 },
    repairOperationCount: 0,
    migrationSplitBrainDetectionCount: 0,
    adapterCapabilityDowngradeCount: 0,
    updatedAt: now.toISOString(),
  };
}

function incrementDiagnostic(
  current: LocalDiagnosticsV1,
  event: LocalDiagnosticEvent,
  now: Date,
): LocalDiagnosticsV1 {
  const next: LocalDiagnosticsV1 = {
    ...current,
    claimConflictCounts: { ...current.claimConflictCounts },
    updatedAt: now.toISOString(),
  };
  switch (event.kind) {
    case 'context_stale':
      next.contextStaleCount += 1;
      return next;
    case 'revision_conflict':
      next.revisionConflictCount += 1;
      return next;
    case 'claim_conflict':
      next.claimConflictCounts[event.level] += 1;
      return next;
    case 'repair_operation':
      next.repairOperationCount += 1;
      return next;
    case 'migration_split_brain':
      next.migrationSplitBrainDetectionCount += 1;
      return next;
    case 'adapter_capability_downgrade':
      next.adapterCapabilityDowngradeCount += 1;
      return next;
  }
}

async function readJsonOrNull<T>(
  target: string,
  parser: (value: unknown) => T,
): Promise<T | null> {
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_DIAGNOSTICS_PATH_UNSAFE');
    }
    return parser(JSON.parse(await readFile(target, 'utf8')));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_DIAGNOSTICS_CORRUPT');
    }
    throw error;
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

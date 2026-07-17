import type {
  LegacyBaseline,
  ManagedAdapter,
  SchemaManifestV1,
} from './manifest.js';

export type CompatibilityOperation =
  | 'read'
  | 'v3_business_write'
  | 'migration_stage'
  | 'activation_repair'
  | 'greenfield_initialize';

export type CompatibilityFailureCode =
  | 'MANCODE_SCHEMA_EPOCH_MISMATCH'
  | 'MANCODE_READER_VERSION_TOO_OLD'
  | 'MANCODE_WRITER_VERSION_TOO_OLD'
  | 'MANCODE_ADAPTER_VERSION_MISMATCH'
  | 'MANCODE_LEGACY_BASELINE_CHANGED'
  | 'MANCODE_LEGACY_AUTHORITY_PRESENT'
  | 'MANCODE_V3_WRITE_REQUIRES_ACTIVATION'
  | 'MANCODE_ACTIVATION_IN_PROGRESS'
  | 'MANCODE_REPAIR_REQUIRED';

export interface CompatibilityGateInput {
  manifest: SchemaManifestV1;
  expectedSchemaEpoch: string;
  readerVersion: string;
  writerVersion: string;
  adapterVersions: Partial<Record<ManagedAdapter, string>>;
  currentLegacyBaseline: LegacyBaseline | null;
  legacyAuthorityPresent: boolean;
  operation: CompatibilityOperation;
}

export interface CompatibilityGateResult {
  readAllowed: boolean;
  writeAllowed: boolean;
  failures: CompatibilityFailureCode[];
}

/**
 * This gate is shared by readers, writers, migration staging, and repair. It
 * does not mutate the manifest: callers choose the journaled repair path after
 * receiving a precise failure code.
 */
export function evaluateCompatibilityGate(
  input: CompatibilityGateInput,
): CompatibilityGateResult {
  const failures: CompatibilityFailureCode[] = [];
  if (input.manifest.epoch !== input.expectedSchemaEpoch) {
    failures.push('MANCODE_SCHEMA_EPOCH_MISMATCH');
  }
  if (compareSemver(input.readerVersion, input.manifest.minReaderVersion) < 0) {
    failures.push('MANCODE_READER_VERSION_TOO_OLD');
  }
  if (
    input.operation !== 'read' &&
    compareSemver(input.writerVersion, input.manifest.minWriterVersion) < 0
  ) {
    failures.push('MANCODE_WRITER_VERSION_TOO_OLD');
  }
  if (!adaptersMatch(input.manifest, input.adapterVersions)) {
    failures.push('MANCODE_ADAPTER_VERSION_MISMATCH');
  }
  const baselineFailure = baselineFailureFor(input);
  if (baselineFailure !== null) failures.push(baselineFailure);
  const stateFailure = stateFailureFor(input);
  if (stateFailure !== null) failures.push(stateFailure);
  const readAllowed =
    !failures.includes('MANCODE_SCHEMA_EPOCH_MISMATCH') &&
    !failures.includes('MANCODE_READER_VERSION_TOO_OLD');
  const writeAllowed = readAllowed && failures.length === 0;
  return { readAllowed, writeAllowed, failures };
}

export function assertCompatibilityGate(input: CompatibilityGateInput): void {
  const result = evaluateCompatibilityGate(input);
  const allowed =
    input.operation === 'read' ? result.readAllowed : result.writeAllowed;
  if (!allowed) {
    throw new Error(result.failures[0] ?? 'MANCODE_COMPATIBILITY_BLOCKED');
  }
}

export function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left, 'left semantic version');
  const parsedRight = parseSemver(right, 'right semantic version');
  for (const index of [0, 1, 2] as const) {
    const delta = parsedLeft.core[index] - parsedRight.core[index];
    if (delta !== 0) return delta;
  }
  if (parsedLeft.prerelease === parsedRight.prerelease) return 0;
  if (parsedLeft.prerelease === null) return 1;
  if (parsedRight.prerelease === null) return -1;
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function baselineFailureFor(
  input: CompatibilityGateInput,
): CompatibilityFailureCode | null {
  const { manifest, currentLegacyBaseline, legacyAuthorityPresent } = input;
  if (manifest.activationState === 'initializing') {
    return legacyAuthorityPresent ? 'MANCODE_LEGACY_AUTHORITY_PRESENT' : null;
  }
  if (
    manifest.activationState === 'dual_read' ||
    manifest.activationState === 'activating'
  ) {
    if (manifest.legacyBaseline === null || currentLegacyBaseline === null) {
      return 'MANCODE_LEGACY_BASELINE_CHANGED';
    }
    return sameBaseline(manifest.legacyBaseline, currentLegacyBaseline)
      ? null
      : 'MANCODE_LEGACY_BASELINE_CHANGED';
  }
  if (manifest.activationState === 'v3_active') {
    if (manifest.legacyBaseline === null) {
      return legacyAuthorityPresent ? 'MANCODE_LEGACY_AUTHORITY_PRESENT' : null;
    }
    if (currentLegacyBaseline === null) {
      return 'MANCODE_LEGACY_BASELINE_CHANGED';
    }
    return sameBaseline(manifest.legacyBaseline, currentLegacyBaseline)
      ? null
      : 'MANCODE_LEGACY_BASELINE_CHANGED';
  }
  return null;
}

function stateFailureFor(
  input: CompatibilityGateInput,
): CompatibilityFailureCode | null {
  const { activationState } = input.manifest;
  switch (activationState) {
    case 'initializing':
      return input.operation === 'greenfield_initialize' ||
        input.operation === 'read'
        ? null
        : 'MANCODE_V3_WRITE_REQUIRES_ACTIVATION';
    case 'dual_read':
      return input.operation === 'read' || input.operation === 'migration_stage'
        ? null
        : 'MANCODE_V3_WRITE_REQUIRES_ACTIVATION';
    case 'activating':
      return input.operation === 'activation_repair' ||
        input.operation === 'read'
        ? null
        : 'MANCODE_ACTIVATION_IN_PROGRESS';
    case 'v3_active':
      return null;
    case 'repair_required':
      return input.operation === 'activation_repair' ||
        input.operation === 'read'
        ? null
        : 'MANCODE_REPAIR_REQUIRED';
  }
}

function adaptersMatch(
  manifest: SchemaManifestV1,
  actual: Partial<Record<ManagedAdapter, string>>,
): boolean {
  return (Object.keys(manifest.managedAdapters) as ManagedAdapter[]).every(
    (adapter) => actual[adapter] === manifest.managedAdapters[adapter],
  );
}

function sameBaseline(left: LegacyBaseline, right: LegacyBaseline): boolean {
  return (
    left.stateDigest === right.stateDigest &&
    left.workflowIndexDigest === right.workflowIndexDigest
  );
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: string | null;
}

function parseSemver(value: string, label: string): ParsedSemver {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw new Error(`${label} is invalid`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`${label} is invalid`);
  }
  return {
    core: [major, minor, patch],
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric)
      return Number(leftPart) - Number(rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart.localeCompare(rightPart, 'en');
  }
  return 0;
}

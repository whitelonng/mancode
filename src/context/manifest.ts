import { type Ulid, assertUlid } from './ids.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type ActivationState =
  | 'initializing'
  | 'dual_read'
  | 'activating'
  | 'v3_active'
  | 'repair_required';

export type ManagedAdapter =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'zcode';

export interface LegacyBaseline {
  stateDigest: string;
  workflowIndexDigest: string;
}

export interface SchemaManifestV1 {
  manifestVersion: 1;
  layoutVersion: 3;
  epoch: Ulid;
  activationState: ActivationState;
  minReaderVersion: string;
  minWriterVersion: string;
  activatedAt: string | null;
  legacyBaseline: LegacyBaseline | null;
  managedAdapters: Record<ManagedAdapter, string>;
  lastOperationId: Ulid | null;
}

const ACTIVATION_STATES = new Set<ActivationState>([
  'initializing',
  'dual_read',
  'activating',
  'v3_active',
  'repair_required',
]);
const MANAGED_ADAPTERS: ManagedAdapter[] = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'zcode',
];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseSchemaManifest(value: unknown): SchemaManifestV1 {
  assertRecord(value, 'schema manifest');
  assertKnownKeys(
    value,
    [
      'manifestVersion',
      'layoutVersion',
      'epoch',
      'activationState',
      'minReaderVersion',
      'minWriterVersion',
      'activatedAt',
      'legacyBaseline',
      'managedAdapters',
      'lastOperationId',
    ],
    'schema manifest',
  );
  if (value.manifestVersion !== 1 || value.layoutVersion !== 3) {
    throw new Error(
      'schema manifest must use manifestVersion 1 and layoutVersion 3',
    );
  }
  assertUlid(value.epoch, 'schema manifest epoch');
  if (
    typeof value.activationState !== 'string' ||
    !ACTIVATION_STATES.has(value.activationState as ActivationState)
  ) {
    throw new Error('schema manifest activationState is invalid');
  }
  const manifest: SchemaManifestV1 = {
    manifestVersion: 1,
    layoutVersion: 3,
    epoch: value.epoch,
    activationState: value.activationState as ActivationState,
    minReaderVersion: parseVersion(value.minReaderVersion, 'minReaderVersion'),
    minWriterVersion: parseVersion(value.minWriterVersion, 'minWriterVersion'),
    activatedAt: parseTimestampOrNull(value.activatedAt, 'activatedAt'),
    legacyBaseline: parseLegacyBaseline(value.legacyBaseline),
    managedAdapters: parseManagedAdapters(value.managedAdapters),
    lastOperationId: parseUlidOrNull(value.lastOperationId, 'lastOperationId'),
  };
  assertManifestStateShape(manifest);
  return manifest;
}

export function assertSchemaManifestTransition(
  previous: SchemaManifestV1,
  next: SchemaManifestV1,
): void {
  if (
    previous.manifestVersion !== next.manifestVersion ||
    previous.layoutVersion !== next.layoutVersion ||
    previous.epoch !== next.epoch ||
    !sameLegacyBaseline(previous.legacyBaseline, next.legacyBaseline)
  ) {
    throw new Error(
      'schema manifest identity and legacy baseline are immutable',
    );
  }
  if (previous.activationState === next.activationState) return;
  if (
    !allowedManifestTransitions(previous.activationState).has(
      next.activationState,
    )
  ) {
    throw new Error(
      `invalid schema manifest transition: ${previous.activationState} -> ${next.activationState}`,
    );
  }
}

/**
 * Activation rollback is intentionally not a general manifest transition.
 * The caller must separately prove that the activation's exact targets have
 * not been followed by a V3 business write.
 */
export function assertActivationRollbackManifestTransition(
  previous: SchemaManifestV1,
  next: SchemaManifestV1,
): void {
  if (
    previous.manifestVersion !== next.manifestVersion ||
    previous.layoutVersion !== next.layoutVersion ||
    previous.epoch !== next.epoch ||
    !sameLegacyBaseline(previous.legacyBaseline, next.legacyBaseline) ||
    previous.activationState !== 'v3_active' ||
    next.activationState !== 'dual_read' ||
    previous.activatedAt === null ||
    next.activatedAt !== null
  ) {
    throw new Error('invalid activation rollback manifest transition');
  }
}

function parseVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error(`schema manifest ${label} must be a semantic version`);
  }
  return value;
}

function parseTimestampOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `schema manifest ${label} must be an ISO timestamp or null`,
    );
  }
  return value;
}

function parseLegacyBaseline(value: unknown): LegacyBaseline | null {
  if (value === null) return null;
  assertRecord(value, 'schema manifest legacyBaseline');
  assertKnownKeys(
    value,
    ['stateDigest', 'workflowIndexDigest'],
    'schema manifest legacyBaseline',
  );
  if (
    typeof value.stateDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.stateDigest) ||
    typeof value.workflowIndexDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.workflowIndexDigest)
  ) {
    throw new Error(
      'schema manifest legacyBaseline must contain sha256 digests',
    );
  }
  return {
    stateDigest: value.stateDigest,
    workflowIndexDigest: value.workflowIndexDigest,
  };
}

function parseManagedAdapters(value: unknown): Record<ManagedAdapter, string> {
  assertRecord(value, 'schema manifest managedAdapters');
  assertKnownKeys(value, MANAGED_ADAPTERS, 'schema manifest managedAdapters');
  const adapters = {} as Record<ManagedAdapter, string>;
  for (const adapter of MANAGED_ADAPTERS) {
    if (typeof value[adapter] !== 'string' || !value[adapter].trim()) {
      throw new Error(`schema manifest managedAdapters.${adapter} is required`);
    }
    adapters[adapter] = value[adapter];
  }
  return adapters;
}

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, `schema manifest ${label}`);
  return value;
}

function assertManifestStateShape(manifest: SchemaManifestV1): void {
  if (
    manifest.activationState === 'initializing' &&
    manifest.legacyBaseline !== null
  ) {
    throw new Error(
      'greenfield initializing manifests must not have a legacy baseline',
    );
  }
  if (
    (manifest.activationState === 'dual_read' ||
      manifest.activationState === 'activating') &&
    manifest.legacyBaseline === null
  ) {
    throw new Error(
      `${manifest.activationState} manifests require a legacy baseline`,
    );
  }
  if (
    manifest.activationState === 'v3_active' &&
    manifest.activatedAt === null
  ) {
    throw new Error('v3_active manifests require activatedAt');
  }
  if (
    (manifest.activationState === 'initializing' ||
      manifest.activationState === 'dual_read' ||
      manifest.activationState === 'activating') &&
    manifest.activatedAt !== null
  ) {
    throw new Error(
      `${manifest.activationState} manifests must not have activatedAt`,
    );
  }
}

function sameLegacyBaseline(
  left: LegacyBaseline | null,
  right: LegacyBaseline | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.stateDigest === right.stateDigest &&
      left.workflowIndexDigest === right.workflowIndexDigest)
  );
}

function allowedManifestTransitions(
  from: ActivationState,
): Set<ActivationState> {
  switch (from) {
    case 'initializing':
      return new Set(['v3_active', 'repair_required']);
    case 'dual_read':
      return new Set(['activating', 'repair_required']);
    case 'activating':
      return new Set(['v3_active', 'repair_required']);
    case 'repair_required':
      return new Set(['v3_active']);
    case 'v3_active':
      return new Set(['repair_required']);
  }
}

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

export type ManagedAdapterInventory = Partial<Record<ManagedAdapter, string>>;

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
  managedAdapters: ManagedAdapterInventory;
  lastOperationId: Ulid | null;
}

export interface SchemaManifestV2 {
  manifestVersion: 2;
  layoutVersion: 3;
  epoch: Ulid;
  activationState: ActivationState;
  minReaderVersion: string;
  minWriterVersion: string;
  activatedAt: string | null;
  legacyBaseline: LegacyBaseline | null;
  managedAdapters: ManagedAdapterInventory;
  lastOperationId: Ulid | null;
  workflowPolicyDefaults: {
    planning: 2;
  };
}

export type SchemaManifest = SchemaManifestV1 | SchemaManifestV2;

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

export function parseSchemaManifest(value: unknown): SchemaManifest {
  assertRecord(value, 'schema manifest');
  if (value.manifestVersion !== 1 && value.manifestVersion !== 2) {
    throw new Error(
      `MANCODE_MANIFEST_VERSION_UNSUPPORTED: observed=${String(value.manifestVersion)} supported=1,2 requiredWriter=0.4.0`,
    );
  }
  const manifestVersion = value.manifestVersion;
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
      ...(manifestVersion === 2 ? ['workflowPolicyDefaults'] : []),
    ],
    'schema manifest',
  );
  if (value.layoutVersion !== 3) {
    throw new Error('schema manifest must use layoutVersion 3');
  }
  assertUlid(value.epoch, 'schema manifest epoch');
  if (
    typeof value.activationState !== 'string' ||
    !ACTIVATION_STATES.has(value.activationState as ActivationState)
  ) {
    throw new Error('schema manifest activationState is invalid');
  }
  const common = {
    layoutVersion: 3 as const,
    epoch: value.epoch,
    activationState: value.activationState as ActivationState,
    minReaderVersion: parseVersion(value.minReaderVersion, 'minReaderVersion'),
    minWriterVersion: parseVersion(value.minWriterVersion, 'minWriterVersion'),
    activatedAt: parseTimestampOrNull(value.activatedAt, 'activatedAt'),
    legacyBaseline: parseLegacyBaseline(value.legacyBaseline),
    managedAdapters: parseManagedAdapters(value.managedAdapters),
    lastOperationId: parseUlidOrNull(value.lastOperationId, 'lastOperationId'),
  };
  const manifest: SchemaManifest =
    manifestVersion === 1
      ? { manifestVersion: 1, ...common }
      : {
          manifestVersion: 2,
          ...common,
          workflowPolicyDefaults: parseWorkflowPolicyDefaults(
            value.workflowPolicyDefaults,
          ),
        };
  assertManifestStateShape(manifest);
  if (
    manifest.manifestVersion === 2 &&
    (compareVersions(manifest.minReaderVersion, '0.4.0') < 0 ||
      compareVersions(manifest.minWriterVersion, '0.4.0') < 0)
  ) {
    throw new Error(
      'schema manifest V2 requires minReaderVersion and minWriterVersion 0.4.0 or newer',
    );
  }
  return manifest;
}

export function serializeSchemaManifest(value: unknown): string {
  return `${JSON.stringify(parseSchemaManifest(value), null, 2)}\n`;
}

export function managedAdapterNames(
  inventory: ManagedAdapterInventory,
): ManagedAdapter[] {
  return MANAGED_ADAPTERS.filter((adapter) => inventory[adapter] !== undefined);
}

export function parseSchemaManifestV1(value: unknown): SchemaManifestV1 {
  const manifest = parseSchemaManifest(value);
  if (manifest.manifestVersion !== 1) {
    throw new Error(
      `MANCODE_MANIFEST_VERSION_UNSUPPORTED: observed=${manifest.manifestVersion} supported=1 requiredWriter=0.3.x`,
    );
  }
  return manifest;
}

export function parseSchemaManifestV2(value: unknown): SchemaManifestV2 {
  const manifest = parseSchemaManifest(value);
  if (manifest.manifestVersion !== 2) {
    throw new Error(
      `MANCODE_MANIFEST_VERSION_UNSUPPORTED: observed=${manifest.manifestVersion} supported=2 requiredWriter=0.4.0`,
    );
  }
  return manifest;
}

export function assertSchemaManifestTransition(
  previous: SchemaManifest,
  next: SchemaManifest,
): void {
  if (
    previous.manifestVersion !== next.manifestVersion ||
    previous.layoutVersion !== next.layoutVersion ||
    previous.epoch !== next.epoch ||
    !sameLegacyBaseline(previous.legacyBaseline, next.legacyBaseline) ||
    compareVersions(next.minReaderVersion, previous.minReaderVersion) < 0 ||
    compareVersions(next.minWriterVersion, previous.minWriterVersion) < 0
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

export function assertSchemaManifestPolicyUpgrade(
  previous: SchemaManifest,
  next: SchemaManifest,
): asserts next is SchemaManifestV2 {
  if (
    previous.manifestVersion !== 1 ||
    next.manifestVersion !== 2 ||
    previous.layoutVersion !== next.layoutVersion ||
    previous.epoch !== next.epoch ||
    previous.activationState !== 'v3_active' ||
    next.activationState !== 'v3_active' ||
    previous.activatedAt !== next.activatedAt ||
    !sameLegacyBaseline(previous.legacyBaseline, next.legacyBaseline) ||
    !managedAdapterInventoriesMatch(
      previous.managedAdapters,
      next.managedAdapters,
    ) ||
    compareVersions(next.minReaderVersion, previous.minReaderVersion) < 0 ||
    compareVersions(next.minWriterVersion, previous.minWriterVersion) < 0 ||
    next.workflowPolicyDefaults.planning !== 2 ||
    next.lastOperationId === null ||
    next.lastOperationId === previous.lastOperationId
  ) {
    throw new Error('invalid schema manifest Policy 2 upgrade');
  }
}

/**
 * Activation rollback is intentionally not a general manifest transition.
 * The caller must separately prove that the activation's exact targets have
 * not been followed by a V3 business write.
 */
export function assertActivationRollbackManifestTransition(
  previous: SchemaManifest,
  next: SchemaManifest,
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

function parseWorkflowPolicyDefaults(
  value: unknown,
): SchemaManifestV2['workflowPolicyDefaults'] {
  assertRecord(value, 'schema manifest workflowPolicyDefaults');
  assertKnownKeys(
    value,
    ['planning'],
    'schema manifest workflowPolicyDefaults',
  );
  if (value.planning !== 2) {
    throw new Error(
      `MANCODE_POLICY_VERSION_UNSUPPORTED: component=planning observed=${String(value.planning)} supported=2 requiredWriter=0.4.0`,
    );
  }
  return { planning: 2 };
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

function parseManagedAdapters(value: unknown): ManagedAdapterInventory {
  assertRecord(value, 'schema manifest managedAdapters');
  assertKnownKeys(value, MANAGED_ADAPTERS, 'schema manifest managedAdapters');
  const adapters: ManagedAdapterInventory = {};
  for (const adapter of MANAGED_ADAPTERS) {
    const version = value[adapter];
    if (version === undefined) continue;
    if (typeof version !== 'string' || !version.trim()) {
      throw new Error(
        `schema manifest managedAdapters.${adapter} must be a non-empty version`,
      );
    }
    adapters[adapter] = version;
  }
  return adapters;
}

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, `schema manifest ${label}`);
  return value;
}

function assertManifestStateShape(manifest: SchemaManifest): void {
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

export function managedAdapterInventoriesMatch(
  left: ManagedAdapterInventory,
  right: ManagedAdapterInventory,
): boolean {
  const leftKeys = managedAdapterNames(left);
  const rightKeys = managedAdapterNames(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (adapter, index) =>
        adapter === rightKeys[index] && left[adapter] === right[adapter],
    )
  );
}

function compareVersions(left: string, right: string): number {
  const [leftCore = '', leftPrerelease] = left.split('-', 2);
  const [rightCore = '', rightPrerelease] = right.split('-', 2);
  const leftParts = leftCore.split('.').map(Number);
  const rightParts = rightCore.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  if (leftPrerelease === rightPrerelease) return 0;
  if (leftPrerelease === undefined) return 1;
  if (rightPrerelease === undefined) return -1;
  return comparePrerelease(leftPrerelease, rightPrerelease);
}

function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
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

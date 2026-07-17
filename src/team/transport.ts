import { type Ulid, assertUlid } from '../context/ids.js';
import {
  type CapabilityLevel,
  type Freshness,
  parseCapabilityLevel,
  parseFreshness,
} from './capabilities.js';
import type { ProjectConfigV1 } from './policy.js';

export type TransportMode = 'local' | 'git-ref' | 'external' | 'unavailable';

export interface CoordinationCapabilitiesV1 {
  claimAcquisition: CapabilityLevel;
  writeGuard: CapabilityLevel;
  transport: TransportMode;
  transportFreshness: Freshness;
  lastSuccessfulSyncAt: string | null;
  remoteRevision: number | null;
}

export interface TransportMutationRequest {
  operationId: Ulid;
  expectedRemoteRevision: number;
  expectedOwnershipEpoch: number;
}

export interface CoordinationTransport {
  readonly mode: Exclude<TransportMode, 'unavailable'>;
  inspect(): Promise<CoordinationCapabilitiesV1>;
  pull(): Promise<CoordinationCapabilitiesV1>;
  push(request: TransportMutationRequest): Promise<CoordinationCapabilitiesV1>;
}

/**
 * The backend owns the real remote read/CAS. Its inspect method must be a
 * cache-only read; only pull and push are explicit network boundaries.
 */
export interface GitRefCoordinationTransportBackend {
  inspect(): Promise<unknown>;
  pull(): Promise<unknown>;
  push(request: TransportMutationRequest): Promise<unknown>;
}

export class LocalCoordinationTransportAdapter
  implements CoordinationTransport
{
  readonly mode = 'local' as const;
  private readonly capabilities: CoordinationCapabilitiesV1;

  constructor(
    claimAcquisition: CapabilityLevel = 'enforced',
    writeGuard: CapabilityLevel = 'advisory',
  ) {
    this.capabilities = localCoordinationCapabilities(
      claimAcquisition,
      writeGuard,
    );
  }

  async inspect(): Promise<CoordinationCapabilitiesV1> {
    return { ...this.capabilities };
  }

  async pull(): Promise<CoordinationCapabilitiesV1> {
    return this.inspect();
  }

  async push(request: TransportMutationRequest): Promise<never> {
    assertTransportMutationRequest(request);
    throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  }
}

export class GitRefCoordinationTransportAdapter
  implements CoordinationTransport
{
  readonly mode = 'git-ref' as const;

  constructor(private readonly backend: GitRefCoordinationTransportBackend) {
    if (
      typeof backend?.inspect !== 'function' ||
      typeof backend.pull !== 'function' ||
      typeof backend.push !== 'function'
    ) {
      throw new Error('MANCODE_TRANSPORT_BACKEND_INVALID');
    }
  }

  /** Cache-only by contract; callers use pull for an explicit remote read. */
  async inspect(): Promise<CoordinationCapabilitiesV1> {
    return gitRefCapabilities(await this.backend.inspect(), false);
  }

  async pull(): Promise<CoordinationCapabilitiesV1> {
    return gitRefCapabilities(await this.backend.pull(), true);
  }

  async push(
    request: TransportMutationRequest,
  ): Promise<CoordinationCapabilitiesV1> {
    assertTransportMutationRequest(request);
    const before = await this.inspect();
    assertRemoteMutationAvailable(before, request);
    const after = gitRefCapabilities(await this.backend.push(request), true);
    if (
      after.remoteRevision === null ||
      after.remoteRevision < request.expectedRemoteRevision
    ) {
      throw new Error('MANCODE_TRANSPORT_BACKEND_CONTRACT');
    }
    return after;
  }
}

export function parseCoordinationCapabilities(
  value: unknown,
): CoordinationCapabilitiesV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('coordination capabilities must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'claimAcquisition',
    'writeGuard',
    'transport',
    'transportFreshness',
    'lastSuccessfulSyncAt',
    'remoteRevision',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`coordination capabilities has unknown field: ${key}`);
    }
  }
  const capabilities: CoordinationCapabilitiesV1 = {
    claimAcquisition: parseCapabilityLevel(
      record.claimAcquisition,
      'claimAcquisition',
    ),
    writeGuard: parseCapabilityLevel(record.writeGuard, 'writeGuard'),
    transport: parseTransportMode(record.transport),
    transportFreshness: parseFreshness(
      record.transportFreshness,
      'transportFreshness',
    ),
    lastSuccessfulSyncAt: parseTimestampOrNull(
      record.lastSuccessfulSyncAt,
      'lastSuccessfulSyncAt',
    ),
    remoteRevision: parseNonNegativeIntegerOrNull(
      record.remoteRevision,
      'remoteRevision',
    ),
  };
  assertCoordinationCapabilitiesShape(capabilities);
  return capabilities;
}

export function localCoordinationCapabilities(
  claimAcquisition: CapabilityLevel = 'enforced',
  writeGuard: CapabilityLevel = 'advisory',
): CoordinationCapabilitiesV1 {
  const capabilities: CoordinationCapabilitiesV1 = {
    claimAcquisition,
    writeGuard,
    transport: 'local',
    transportFreshness: 'unavailable',
    lastSuccessfulSyncAt: null,
    remoteRevision: null,
  };
  assertCoordinationCapabilitiesShape(capabilities);
  return capabilities;
}

export function capabilitiesFromProjectConfig(
  config: ProjectConfigV1,
  localClaimAcquisition: CapabilityLevel = 'enforced',
  writeGuard: CapabilityLevel = 'advisory',
): CoordinationCapabilitiesV1 {
  if (config.transport.mode === 'local') {
    return localCoordinationCapabilities(localClaimAcquisition, writeGuard);
  }
  return {
    claimAcquisition: 'unavailable',
    writeGuard,
    transport: 'git-ref',
    transportFreshness: 'unknown',
    lastSuccessfulSyncAt: null,
    remoteRevision: null,
  };
}

export function assertRemoteMutationAvailable(
  capabilities: CoordinationCapabilitiesV1,
  request: TransportMutationRequest,
): void {
  assertCoordinationCapabilitiesShape(capabilities);
  assertTransportMutationRequest(request);
  if (
    capabilities.transport !== 'git-ref' ||
    capabilities.transportFreshness !== 'fresh' ||
    capabilities.claimAcquisition === 'unavailable'
  ) {
    throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  }
  if (
    capabilities.remoteRevision === null ||
    capabilities.remoteRevision !== request.expectedRemoteRevision
  ) {
    throw new Error('MANCODE_TRANSPORT_REVISION_CONFLICT');
  }
}

export function assertTransportMutationRequest(
  request: TransportMutationRequest,
): void {
  assertUlid(request.operationId, 'transport mutation operationId');
  if (
    !Number.isSafeInteger(request.expectedRemoteRevision) ||
    request.expectedRemoteRevision < 0 ||
    !Number.isSafeInteger(request.expectedOwnershipEpoch) ||
    request.expectedOwnershipEpoch < 0
  ) {
    throw new Error(
      'transport mutation expected revisions must be non-negative integers',
    );
  }
}

export function assertCoordinationCapabilitiesShape(
  capabilities: CoordinationCapabilitiesV1,
): void {
  if (capabilities.transport === 'local') {
    if (
      capabilities.transportFreshness !== 'unavailable' ||
      capabilities.lastSuccessfulSyncAt !== null ||
      capabilities.remoteRevision !== null
    ) {
      throw new Error(
        'local transport must report remote freshness, sync time, and remote revision as unavailable',
      );
    }
  }
  if (capabilities.transport === 'unavailable') {
    if (
      capabilities.transportFreshness !== 'unavailable' ||
      capabilities.remoteRevision !== null
    ) {
      throw new Error(
        'unavailable transport cannot report remote freshness or revision',
      );
    }
  }
  if (
    capabilities.transport === 'git-ref' &&
    capabilities.transportFreshness === 'fresh'
  ) {
    if (
      capabilities.lastSuccessfulSyncAt === null ||
      capabilities.remoteRevision === null
    ) {
      throw new Error(
        'fresh git-ref transport requires sync time and remote revision',
      );
    }
  }
  if (
    capabilities.transport === 'git-ref' &&
    capabilities.transportFreshness === 'stale' &&
    (capabilities.lastSuccessfulSyncAt === null ||
      capabilities.remoteRevision === null)
  ) {
    throw new Error(
      'stale git-ref transport requires its last sync time and remote revision',
    );
  }
  if (
    capabilities.transport === 'git-ref' &&
    capabilities.transportFreshness === 'unknown' &&
    (capabilities.lastSuccessfulSyncAt !== null ||
      capabilities.remoteRevision !== null)
  ) {
    throw new Error(
      'unknown git-ref transport cannot report a sync time or remote revision',
    );
  }
  if (
    capabilities.transport === 'git-ref' &&
    capabilities.transportFreshness !== 'fresh' &&
    capabilities.claimAcquisition === 'enforced'
  ) {
    throw new Error(
      'git-ref claim acquisition may only be enforced from a fresh snapshot',
    );
  }
}

function gitRefCapabilities(
  value: unknown,
  requireFresh: boolean,
): CoordinationCapabilitiesV1 {
  const capabilities = parseCoordinationCapabilities(value);
  if (capabilities.transport !== 'git-ref') {
    throw new Error('MANCODE_TRANSPORT_BACKEND_MODE_MISMATCH');
  }
  if (requireFresh && capabilities.transportFreshness !== 'fresh') {
    throw new Error('MANCODE_TRANSPORT_SYNC_INCOMPLETE');
  }
  return capabilities;
}

function parseTransportMode(value: unknown): TransportMode {
  if (
    value !== 'local' &&
    value !== 'git-ref' &&
    value !== 'external' &&
    value !== 'unavailable'
  ) {
    throw new Error('transport is invalid');
  }
  return value;
}

function parseTimestampOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp or null`);
  }
  return value;
}

function parseNonNegativeIntegerOrNull(
  value: unknown,
  label: string,
): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer or null`);
  }
  return value;
}

import { assertKnownKeys, assertRecord } from '../context/validation.js';
import type { HostIdentityCapability } from './session-identity.js';

export const SESSION_SPIKE_PLATFORMS = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'zcode',
] as const;

export type SessionSpikePlatform = (typeof SESSION_SPIKE_PLATFORMS)[number];
export type HostSessionSource = 'hook_stdin' | 'environment' | 'api' | 'none';
export type SpikeEvidenceStatus =
  | 'proven'
  | 'not_proven'
  | 'not_tested'
  | 'not_applicable';
export type HookApprovalStatus =
  | 'approved'
  | 'unapproved'
  | 'unknown'
  | 'not_applicable';

/**
 * Evidence is operator-attested, but binding it to a release candidate keeps
 * a prior candidate's local result from satisfying a later Beta gate.
 */
export interface PlatformSessionEvidenceBindingV1 {
  releaseCandidate: string;
  mancodeVersion: string;
  hostVersion: string;
  nodeVersion: string;
  runtimePlatform: string;
}

/** Legacy evidence is readable only so the gate can require recapture. */
export interface PlatformSessionSpikeV1 {
  schemaVersion: 1;
  platform: SessionSpikePlatform;
  observedAt: string;
  hostSessionSource: HostSessionSource;
  hostSessionObserved: boolean;
  distinctClientWindows: SpikeEvidenceStatus;
  commandPropagation: SpikeEvidenceStatus;
  subagentInheritance: SpikeEvidenceStatus;
  hookApproval: HookApprovalStatus;
}

/**
 * Persistent evidence intentionally has no raw host session identifier. Raw
 * identifiers are compared only while the spike runs and then discarded.
 */
export interface PlatformSessionSpikeV2 {
  schemaVersion: 2;
  platform: SessionSpikePlatform;
  observedAt: string;
  hostSessionSource: HostSessionSource;
  hostSessionObserved: boolean;
  distinctClientWindows: SpikeEvidenceStatus;
  commandPropagation: SpikeEvidenceStatus;
  subagentInheritance: SpikeEvidenceStatus;
  subagentInheritanceReason: string | null;
  hookApproval: HookApprovalStatus;
  evidence: PlatformSessionEvidenceBindingV1;
}

export type PlatformSessionSpike =
  | PlatformSessionSpikeV1
  | PlatformSessionSpikeV2;

export interface PlatformSessionSpikeInput {
  platform: SessionSpikePlatform;
  observedAt: string;
  hostSessionSource: HostSessionSource;
  /** Ephemeral only; never copied into PlatformSessionSpikeV2. */
  firstWindowHostSessionKey: string | null;
  /** Ephemeral only; proves two same-client windows do not collide. */
  secondWindowHostSessionKey: string | null;
  /** Operator-attested result from a real host child command. */
  commandPropagation: SpikeEvidenceStatus;
  /** Operator-attested result from a real host child agent, if applicable. */
  subagentInheritance: SpikeEvidenceStatus;
  /** Required when subagentInheritance is not_applicable. */
  subagentInheritanceReason?: string | null;
  hookApproval: HookApprovalStatus;
  evidence: PlatformSessionEvidenceBindingV1;
}

export interface PlatformSessionEvidenceRequirement {
  releaseCandidate: string;
  mancodeVersion: string;
}

export type PlatformSessionEvidenceState =
  | 'current'
  | 'legacy'
  | 'release_candidate_mismatch'
  | 'mancode_version_mismatch';

export interface PlatformSessionCapability {
  platform: SessionSpikePlatform;
  hostIdentity: HostIdentityCapability;
  hostSessionSource: HostSessionSource;
  commandPropagation: SpikeEvidenceStatus;
  subagentInheritance: SpikeEvidenceStatus;
  hookApproval: HookApprovalStatus;
  evidenceState: PlatformSessionEvidenceState;
  reason: string;
}

export interface PlatformSpikeFreezeStatus {
  missingPlatforms: SessionSpikePlatform[];
  explicitRequiredPlatforms: SessionSpikePlatform[];
  evidenceMismatchPlatforms: SessionSpikePlatform[];
  ready: boolean;
}

export function createPlatformSessionSpike(
  input: PlatformSessionSpikeInput,
): PlatformSessionSpikeV2 {
  assertSessionSpikePlatform(input.platform);
  assertTimestamp(input.observedAt, 'platform session spike observedAt');
  assertHostSessionSource(input.hostSessionSource);
  assertSpikeStatus(input.commandPropagation, 'commandPropagation');
  assertSpikeStatus(input.subagentInheritance, 'subagentInheritance');
  assertHookApproval(input.hookApproval);
  const evidence = parseEvidenceBinding(input.evidence);
  const first = normalizeEphemeralHostKey(input.firstWindowHostSessionKey);
  const second = normalizeEphemeralHostKey(input.secondWindowHostSessionKey);
  const subagentInheritanceReason = parseSubagentInheritanceReason(
    input.subagentInheritance,
    input.subagentInheritanceReason ?? null,
  );
  if (input.hostSessionSource === 'none' && first !== null) {
    throw new Error(
      'platform session spike source none cannot carry a host key',
    );
  }
  if (input.hostSessionSource !== 'none' && first === null) {
    throw new Error(
      'platform session spike host source requires an observed key',
    );
  }
  if (second !== null && first === null) {
    throw new Error(
      'platform session spike second window requires a first window',
    );
  }
  if (
    input.hostSessionSource === 'none' &&
    input.commandPropagation === 'proven'
  ) {
    throw new Error(
      'platform session spike cannot prove propagation without a host key',
    );
  }
  return {
    schemaVersion: 2,
    platform: input.platform,
    observedAt: input.observedAt,
    hostSessionSource: input.hostSessionSource,
    hostSessionObserved: first !== null,
    distinctClientWindows:
      second === null
        ? 'not_tested'
        : first === second
          ? 'not_proven'
          : 'proven',
    commandPropagation: input.commandPropagation,
    subagentInheritance: input.subagentInheritance,
    subagentInheritanceReason,
    hookApproval: input.hookApproval,
    evidence,
  };
}

export function parsePlatformSessionSpike(
  value: unknown,
): PlatformSessionSpike {
  assertRecord(value, 'platform session spike');
  if (value.schemaVersion === 1) return parsePlatformSessionSpikeV1(value);
  if (value.schemaVersion === 2) return parsePlatformSessionSpikeV2(value);
  throw new Error('platform session spike schemaVersion must be 1 or 2');
}

/** Missing evidence is deliberately indistinguishable from insufficient evidence. */
export function evaluatePlatformSessionCapability(
  spike: PlatformSessionSpike,
  requirement?: PlatformSessionEvidenceRequirement,
): PlatformSessionCapability {
  const parsed = parsePlatformSessionSpike(spike);
  const evidenceState = evidenceStateFor(parsed, requirement);
  const hostSourceApproved =
    parsed.hostSessionSource !== 'hook_stdin' ||
    parsed.hookApproval === 'approved';
  const childInheritanceVerified =
    parsed.schemaVersion === 2 &&
    (parsed.subagentInheritance === 'proven' ||
      (parsed.subagentInheritance === 'not_applicable' &&
        parsed.subagentInheritanceReason !== null));
  const hostVerified =
    evidenceState === 'current' &&
    parsed.hostSessionObserved &&
    parsed.hostSessionSource !== 'none' &&
    parsed.distinctClientWindows === 'proven' &&
    parsed.commandPropagation === 'proven' &&
    childInheritanceVerified &&
    hostSourceApproved;
  return {
    platform: parsed.platform,
    hostIdentity: hostVerified ? 'host_verified' : 'explicit_required',
    hostSessionSource: parsed.hostSessionSource,
    commandPropagation: parsed.commandPropagation,
    subagentInheritance: parsed.subagentInheritance,
    hookApproval: parsed.hookApproval,
    evidenceState,
    reason: hostVerified
      ? 'host identity, distinct windows, command propagation, and child inheritance are proven'
      : capabilityReason(parsed, evidenceState, childInheritanceVerified),
  };
}

export function platformSpikeFreezeStatus(
  spikes: readonly PlatformSessionSpike[],
  requirement?: PlatformSessionEvidenceRequirement,
): PlatformSpikeFreezeStatus {
  const byPlatform = new Map<SessionSpikePlatform, PlatformSessionSpike>();
  for (const spike of spikes) {
    const parsed = parsePlatformSessionSpike(spike);
    if (byPlatform.has(parsed.platform)) {
      throw new Error(
        `platform session spike is duplicated: ${parsed.platform}`,
      );
    }
    byPlatform.set(parsed.platform, parsed);
  }
  const missingPlatforms = SESSION_SPIKE_PLATFORMS.filter(
    (platform) => !byPlatform.has(platform),
  );
  const capabilities = new Map<
    SessionSpikePlatform,
    PlatformSessionCapability
  >();
  for (const platform of SESSION_SPIKE_PLATFORMS) {
    const spike = byPlatform.get(platform);
    if (spike !== undefined) {
      capabilities.set(
        platform,
        evaluatePlatformSessionCapability(spike, requirement),
      );
    }
  }
  const explicitRequiredPlatforms = SESSION_SPIKE_PLATFORMS.filter(
    (platform) =>
      capabilities.get(platform)?.hostIdentity === 'explicit_required',
  );
  const evidenceMismatchPlatforms = SESSION_SPIKE_PLATFORMS.filter(
    (platform) => {
      const capability = capabilities.get(platform);
      return capability !== undefined && capability.evidenceState !== 'current';
    },
  );
  return {
    missingPlatforms,
    explicitRequiredPlatforms,
    evidenceMismatchPlatforms,
    ready:
      missingPlatforms.length === 0 && explicitRequiredPlatforms.length === 0,
  };
}

function parsePlatformSessionSpikeV1(
  value: Record<string, unknown>,
): PlatformSessionSpikeV1 {
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'platform',
      'observedAt',
      'hostSessionSource',
      'hostSessionObserved',
      'distinctClientWindows',
      'commandPropagation',
      'subagentInheritance',
      'hookApproval',
    ],
    'platform session spike',
  );
  return parseCommonSpikeFields(value, 1);
}

function parsePlatformSessionSpikeV2(
  value: Record<string, unknown>,
): PlatformSessionSpikeV2 {
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'platform',
      'observedAt',
      'hostSessionSource',
      'hostSessionObserved',
      'distinctClientWindows',
      'commandPropagation',
      'subagentInheritance',
      'subagentInheritanceReason',
      'hookApproval',
      'evidence',
    ],
    'platform session spike',
  );
  const common = parseCommonSpikeFields(value, 2);
  const subagentInheritanceReason = parseSubagentInheritanceReason(
    common.subagentInheritance,
    value.subagentInheritanceReason,
  );
  return {
    ...common,
    schemaVersion: 2,
    subagentInheritanceReason,
    evidence: parseEvidenceBinding(value.evidence),
  };
}

function parseCommonSpikeFields(
  value: Record<string, unknown>,
  schemaVersion: 1,
): PlatformSessionSpikeV1;
function parseCommonSpikeFields(
  value: Record<string, unknown>,
  schemaVersion: 2,
): Omit<PlatformSessionSpikeV2, 'subagentInheritanceReason' | 'evidence'>;
function parseCommonSpikeFields(
  value: Record<string, unknown>,
  schemaVersion: 1 | 2,
):
  | PlatformSessionSpikeV1
  | Omit<PlatformSessionSpikeV2, 'subagentInheritanceReason' | 'evidence'> {
  if (value.schemaVersion !== schemaVersion) {
    throw new Error(
      `platform session spike schemaVersion must be ${schemaVersion}`,
    );
  }
  assertSessionSpikePlatform(value.platform);
  assertTimestamp(value.observedAt, 'platform session spike observedAt');
  assertHostSessionSource(value.hostSessionSource);
  if (typeof value.hostSessionObserved !== 'boolean') {
    throw new Error('platform session spike hostSessionObserved is invalid');
  }
  assertSpikeStatus(value.distinctClientWindows, 'distinctClientWindows');
  assertSpikeStatus(value.commandPropagation, 'commandPropagation');
  assertSpikeStatus(value.subagentInheritance, 'subagentInheritance');
  assertHookApproval(value.hookApproval);
  if (value.hostSessionSource === 'none' && value.hostSessionObserved) {
    throw new Error(
      'platform session spike source none cannot observe a host key',
    );
  }
  return {
    schemaVersion,
    platform: value.platform,
    observedAt: value.observedAt,
    hostSessionSource: value.hostSessionSource,
    hostSessionObserved: value.hostSessionObserved,
    distinctClientWindows: value.distinctClientWindows,
    commandPropagation: value.commandPropagation,
    subagentInheritance: value.subagentInheritance,
    hookApproval: value.hookApproval,
  } as
    | PlatformSessionSpikeV1
    | Omit<PlatformSessionSpikeV2, 'subagentInheritanceReason' | 'evidence'>;
}

function evidenceStateFor(
  spike: PlatformSessionSpike,
  requirement: PlatformSessionEvidenceRequirement | undefined,
): PlatformSessionEvidenceState {
  if (spike.schemaVersion === 1) return 'legacy';
  if (requirement === undefined) return 'current';
  if (spike.evidence.releaseCandidate !== requirement.releaseCandidate) {
    return 'release_candidate_mismatch';
  }
  if (spike.evidence.mancodeVersion !== requirement.mancodeVersion) {
    return 'mancode_version_mismatch';
  }
  return 'current';
}

function capabilityReason(
  spike: PlatformSessionSpike,
  evidenceState: PlatformSessionEvidenceState,
  childInheritanceVerified: boolean,
): string {
  if (evidenceState === 'legacy') {
    return 'session evidence uses the legacy schema and must be recaptured';
  }
  if (evidenceState === 'release_candidate_mismatch') {
    return 'session evidence belongs to a different release candidate';
  }
  if (evidenceState === 'mancode_version_mismatch') {
    return 'session evidence belongs to a different mancode version';
  }
  if (!childInheritanceVerified) {
    return 'child inheritance is not proven; require --session or MANCODE_SESSION_ID';
  }
  if (spike.commandPropagation !== 'proven') {
    return 'command propagation is not proven; require --session or MANCODE_SESSION_ID';
  }
  return 'host identity is not fully proven; require --session or MANCODE_SESSION_ID';
}

function parseEvidenceBinding(
  value: unknown,
): PlatformSessionEvidenceBindingV1 {
  assertRecord(value, 'platform session spike evidence');
  assertKnownKeys(
    value,
    [
      'releaseCandidate',
      'mancodeVersion',
      'hostVersion',
      'nodeVersion',
      'runtimePlatform',
    ],
    'platform session spike evidence',
  );
  return {
    releaseCandidate: parseReleaseCandidate(value.releaseCandidate),
    mancodeVersion: parseEvidenceText(value.mancodeVersion, 'mancodeVersion'),
    hostVersion: parseEvidenceText(value.hostVersion, 'hostVersion'),
    nodeVersion: parseEvidenceText(value.nodeVersion, 'nodeVersion'),
    runtimePlatform: parseEvidenceText(
      value.runtimePlatform,
      'runtimePlatform',
    ),
  };
}

function parseReleaseCandidate(value: unknown): string {
  const candidate = parseEvidenceText(value, 'releaseCandidate');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+/@-]{5,127}$/.test(candidate)) {
    throw new Error('platform session spike releaseCandidate is invalid');
  }
  return candidate;
}

function parseEvidenceText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.trim().length > 256
  ) {
    throw new Error(`platform session spike evidence ${label} is invalid`);
  }
  return value.trim();
}

function parseSubagentInheritanceReason(
  status: SpikeEvidenceStatus,
  value: unknown,
): string | null {
  if (status !== 'not_applicable') {
    if (value !== null && value !== undefined) {
      throw new Error(
        'platform session spike subagentInheritanceReason is only valid for not_applicable',
      );
    }
    return null;
  }
  return parseEvidenceText(value, 'subagentInheritanceReason');
}

function normalizeEphemeralHostKey(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('platform session spike host key is invalid');
  }
  return value.trim();
}

function assertSessionSpikePlatform(
  value: unknown,
): asserts value is SessionSpikePlatform {
  if (
    typeof value !== 'string' ||
    !SESSION_SPIKE_PLATFORMS.includes(value as SessionSpikePlatform)
  ) {
    throw new Error('platform session spike platform is invalid');
  }
}

function assertHostSessionSource(
  value: unknown,
): asserts value is HostSessionSource {
  if (
    value !== 'hook_stdin' &&
    value !== 'environment' &&
    value !== 'api' &&
    value !== 'none'
  ) {
    throw new Error('platform session spike hostSessionSource is invalid');
  }
}

function assertSpikeStatus(
  value: unknown,
  label: string,
): asserts value is SpikeEvidenceStatus {
  if (
    value !== 'proven' &&
    value !== 'not_proven' &&
    value !== 'not_tested' &&
    value !== 'not_applicable'
  ) {
    throw new Error(`platform session spike ${label} is invalid`);
  }
}

function assertHookApproval(
  value: unknown,
): asserts value is HookApprovalStatus {
  if (
    value !== 'approved' &&
    value !== 'unapproved' &&
    value !== 'unknown' &&
    value !== 'not_applicable'
  ) {
    throw new Error('platform session spike hookApproval is invalid');
  }
}

function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
}

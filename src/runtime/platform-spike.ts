import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import type { HostIdentityCapability } from './session-identity.js';

const execFileAsync = promisify(execFile);

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
 * Persistent evidence intentionally has no raw host session identifier. Raw
 * identifiers are compared only while the spike runs and then discarded.
 */
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

export interface PlatformSessionSpikeInput {
  platform: SessionSpikePlatform;
  observedAt: string;
  hostSessionSource: HostSessionSource;
  /** Ephemeral only; never copied into PlatformSessionSpikeV1. */
  firstWindowHostSessionKey: string | null;
  /** Ephemeral only; proves two same-client windows do not collide. */
  secondWindowHostSessionKey: string | null;
  commandPropagation: SpikeEvidenceStatus;
  subagentInheritance: SpikeEvidenceStatus;
  hookApproval: HookApprovalStatus;
}

export interface PlatformSessionCapability {
  platform: SessionSpikePlatform;
  hostIdentity: HostIdentityCapability;
  hostSessionSource: HostSessionSource;
  commandPropagation: SpikeEvidenceStatus;
  subagentInheritance: SpikeEvidenceStatus;
  hookApproval: HookApprovalStatus;
  reason: string;
}

export interface PlatformSpikeFreezeStatus {
  missingPlatforms: SessionSpikePlatform[];
  explicitRequiredPlatforms: SessionSpikePlatform[];
  ready: boolean;
}

export interface PlatformSessionSpikeProbeInput {
  platform: SessionSpikePlatform;
  hostSessionSource: Exclude<HostSessionSource, 'none'>;
  /** Ephemeral host identity from the first same-client window. */
  firstWindowHostSessionKey: string;
  /** Ephemeral host identity from a separately opened same-client window. */
  secondWindowHostSessionKey: string;
  subagentInheritance: SpikeEvidenceStatus;
  hookApproval: HookApprovalStatus;
  now?: Date;
}

export function createPlatformSessionSpike(
  input: PlatformSessionSpikeInput,
): PlatformSessionSpikeV1 {
  assertSessionSpikePlatform(input.platform);
  assertTimestamp(input.observedAt, 'platform session spike observedAt');
  assertHostSessionSource(input.hostSessionSource);
  assertSpikeStatus(input.commandPropagation, 'commandPropagation');
  assertSpikeStatus(input.subagentInheritance, 'subagentInheritance');
  assertHookApproval(input.hookApproval);
  const first = normalizeEphemeralHostKey(input.firstWindowHostSessionKey);
  const second = normalizeEphemeralHostKey(input.secondWindowHostSessionKey);
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
    schemaVersion: 1,
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
    hookApproval: input.hookApproval,
  };
}

export function parsePlatformSessionSpike(
  value: unknown,
): PlatformSessionSpikeV1 {
  assertRecord(value, 'platform session spike');
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
  if (value.schemaVersion !== 1) {
    throw new Error('platform session spike schemaVersion must be 1');
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
    schemaVersion: 1,
    platform: value.platform,
    observedAt: value.observedAt,
    hostSessionSource: value.hostSessionSource,
    hostSessionObserved: value.hostSessionObserved,
    distinctClientWindows: value.distinctClientWindows,
    commandPropagation: value.commandPropagation,
    subagentInheritance: value.subagentInheritance,
    hookApproval: value.hookApproval,
  };
}

/** Missing evidence is deliberately indistinguishable from insufficient evidence. */
export function evaluatePlatformSessionCapability(
  spike: PlatformSessionSpikeV1,
): PlatformSessionCapability {
  const parsed = parsePlatformSessionSpike(spike);
  const hostSourceApproved =
    parsed.hostSessionSource !== 'hook_stdin' ||
    parsed.hookApproval === 'approved';
  const hostVerified =
    parsed.hostSessionObserved &&
    parsed.hostSessionSource !== 'none' &&
    parsed.distinctClientWindows === 'proven' &&
    parsed.commandPropagation === 'proven' &&
    hostSourceApproved;
  return {
    platform: parsed.platform,
    hostIdentity: hostVerified ? 'host_verified' : 'explicit_required',
    hostSessionSource: parsed.hostSessionSource,
    commandPropagation: parsed.commandPropagation,
    subagentInheritance: parsed.subagentInheritance,
    hookApproval: parsed.hookApproval,
    reason: hostVerified
      ? 'host identity, distinct windows, and command propagation are proven'
      : 'host identity is not fully proven; require --session or MANCODE_SESSION_ID',
  };
}

export function platformSpikeFreezeStatus(
  spikes: readonly PlatformSessionSpikeV1[],
): PlatformSpikeFreezeStatus {
  const byPlatform = new Map<SessionSpikePlatform, PlatformSessionSpikeV1>();
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
  const explicitRequiredPlatforms = SESSION_SPIKE_PLATFORMS.filter(
    (platform) => {
      const spike = byPlatform.get(platform);
      return (
        spike === undefined ||
        evaluatePlatformSessionCapability(spike).hostIdentity ===
          'explicit_required'
      );
    },
  );
  return {
    missingPlatforms,
    explicitRequiredPlatforms,
    ready:
      missingPlatforms.length === 0 && explicitRequiredPlatforms.length === 0,
  };
}

/**
 * Runs the portable part of a real-host spike. Callers must obtain the two
 * host keys from their adapter environment and must never persist either key.
 */
export async function probePlatformSessionSpike(
  input: PlatformSessionSpikeProbeInput,
): Promise<PlatformSessionSpikeV1> {
  const commandPropagation = await probeSessionEnvironmentPropagation(
    input.firstWindowHostSessionKey,
  );
  return createPlatformSessionSpike({
    platform: input.platform,
    observedAt: (input.now ?? new Date()).toISOString(),
    hostSessionSource: input.hostSessionSource,
    firstWindowHostSessionKey: input.firstWindowHostSessionKey,
    secondWindowHostSessionKey: input.secondWindowHostSessionKey,
    commandPropagation,
    subagentInheritance: input.subagentInheritance,
    hookApproval: input.hookApproval,
  });
}

/**
 * Executes the command-propagation leg without a shell. Platform adapters
 * should call this after obtaining a real host ID, and record only the result.
 */
export async function probeSessionEnvironmentPropagation(
  hostSessionKey: string,
): Promise<SpikeEvidenceStatus> {
  const expected = normalizeEphemeralHostKey(hostSessionKey);
  if (expected === null) {
    throw new Error('platform session spike host key is invalid');
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      '-e',
      'process.stdout.write((process.env.MANCODE_SPIKE_HOST_SESSION_KEY ?? "").trim())',
    ]);
    return stdout === expected ? 'proven' : 'not_proven';
  } catch {
    return 'not_proven';
  }
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

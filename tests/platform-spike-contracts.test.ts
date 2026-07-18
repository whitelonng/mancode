import { describe, expect, it } from 'vitest';
import {
  createPlatformSessionSpike,
  evaluatePlatformSessionCapability,
  platformSpikeFreezeStatus,
} from '../src/runtime/platform-spike.js';
import { createSessionIdentityProvider } from '../src/runtime/session-identity.js';
import { VERSION } from '../src/version.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const RELEASE_CANDIDATE = '5c40d6b';

describe('platform session identity spike contract', () => {
  it('never persists raw host keys and requires explicit sessions until child inheritance is proven', () => {
    const spike = createPlatformSessionSpike({
      platform: 'codex',
      observedAt: '2026-07-17T12:00:00.000Z',
      hostSessionSource: 'api',
      firstWindowHostSessionKey: 'desktop-window-a-private-key',
      secondWindowHostSessionKey: 'desktop-window-b-private-key',
      commandPropagation: 'proven',
      subagentInheritance: 'not_tested',
      hookApproval: 'not_applicable',
      evidence: evidence(),
    });
    expect(JSON.stringify(spike)).not.toContain('private-key');
    expect(evaluatePlatformSessionCapability(spike)).toMatchObject({
      hostIdentity: 'explicit_required',
    });
    const provider = createSessionIdentityProvider(WORKSPACE_ID);
    expect(
      provider.resolveCandidate({
        environment: {},
        trustedHostInput: {
          externalSessionKey: 'desktop-window-a-private-key',
          propagatesToCommands: true,
        },
        client: 'codex',
      }),
    ).toBeNull();
  });

  it('requires explicit sessions when same-client windows collide or propagation is unproven', () => {
    const collision = createPlatformSessionSpike({
      platform: 'cursor',
      observedAt: '2026-07-17T12:00:00.000Z',
      hostSessionSource: 'environment',
      firstWindowHostSessionKey: 'same-window-key',
      secondWindowHostSessionKey: 'same-window-key',
      commandPropagation: 'not_proven',
      subagentInheritance: 'proven',
      hookApproval: 'not_applicable',
      evidence: evidence(),
    });
    expect(evaluatePlatformSessionCapability(collision).hostIdentity).toBe(
      'explicit_required',
    );
    expect(platformSpikeFreezeStatus([collision])).toMatchObject({
      ready: false,
      missingPlatforms: expect.arrayContaining(['codex']),
      explicitRequiredPlatforms: expect.arrayContaining(['cursor']),
    });
  });

  it('requires a documented reason when child agents are not applicable', () => {
    expect(() =>
      createPlatformSessionSpike({
        platform: 'claude-code',
        observedAt: '2026-07-17T12:00:00.000Z',
        hostSessionSource: 'api',
        firstWindowHostSessionKey: 'window-a',
        secondWindowHostSessionKey: 'window-b',
        commandPropagation: 'proven',
        subagentInheritance: 'not_applicable',
        hookApproval: 'not_applicable',
        evidence: evidence(),
      }),
    ).toThrow('subagentInheritanceReason');

    const documented = createPlatformSessionSpike({
      platform: 'claude-code',
      observedAt: '2026-07-17T12:00:00.000Z',
      hostSessionSource: 'api',
      firstWindowHostSessionKey: 'window-a',
      secondWindowHostSessionKey: 'window-b',
      commandPropagation: 'proven',
      subagentInheritance: 'not_applicable',
      subagentInheritanceReason: 'This host does not expose child agents.',
      hookApproval: 'not_applicable',
      evidence: evidence(),
    });
    expect(evaluatePlatformSessionCapability(documented).hostIdentity).toBe(
      'host_verified',
    );
  });

  it('requires recapture when evidence belongs to another release candidate', () => {
    const spike = createPlatformSessionSpike({
      platform: 'zcode',
      observedAt: '2026-07-17T12:00:00.000Z',
      hostSessionSource: 'api',
      firstWindowHostSessionKey: 'window-a',
      secondWindowHostSessionKey: 'window-b',
      commandPropagation: 'proven',
      subagentInheritance: 'proven',
      hookApproval: 'not_applicable',
      evidence: evidence('721845d'),
    });
    expect(
      evaluatePlatformSessionCapability(spike, {
        releaseCandidate: RELEASE_CANDIDATE,
        mancodeVersion: VERSION,
      }),
    ).toMatchObject({
      hostIdentity: 'explicit_required',
      evidenceState: 'release_candidate_mismatch',
    });
  });

  it('requires recapture of legacy V1 evidence even when its outcomes look proven', () => {
    const legacy = {
      schemaVersion: 1 as const,
      platform: 'copilot' as const,
      observedAt: '2026-07-17T12:00:00.000Z',
      hostSessionSource: 'api' as const,
      hostSessionObserved: true,
      distinctClientWindows: 'proven' as const,
      commandPropagation: 'proven' as const,
      subagentInheritance: 'proven' as const,
      hookApproval: 'not_applicable' as const,
    };
    expect(evaluatePlatformSessionCapability(legacy)).toMatchObject({
      hostIdentity: 'explicit_required',
      evidenceState: 'legacy',
    });
    expect(platformSpikeFreezeStatus([legacy])).toMatchObject({
      explicitRequiredPlatforms: expect.arrayContaining(['copilot']),
      evidenceMismatchPlatforms: expect.arrayContaining(['copilot']),
      ready: false,
    });
  });
});

function evidence(releaseCandidate = RELEASE_CANDIDATE) {
  return {
    releaseCandidate,
    mancodeVersion: VERSION,
    hostVersion: 'fixture-host-1.0.0',
    nodeVersion: process.version,
    runtimePlatform: `${process.platform}-${process.arch}`,
  };
}

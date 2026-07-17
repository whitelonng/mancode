import { describe, expect, it, vi } from 'vitest';
import {
  createPlatformSessionSpike,
  evaluatePlatformSessionCapability,
  platformSpikeFreezeStatus,
  probeSessionEnvironmentPropagation,
} from '../src/runtime/platform-spike.js';
import { createSessionIdentityProvider } from '../src/runtime/session-identity.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';

describe('platform session identity spike contract', () => {
  it('never persists raw host keys and defaults unverified platforms to explicit sessions', () => {
    const spike = createPlatformSessionSpike({
      platform: 'codex',
      observedAt: '2026-07-17T12:00:00.000Z',
      hostSessionSource: 'api',
      firstWindowHostSessionKey: 'desktop-window-a-private-key',
      secondWindowHostSessionKey: 'desktop-window-b-private-key',
      commandPropagation: 'proven',
      subagentInheritance: 'not_tested',
      hookApproval: 'not_applicable',
    });
    expect(JSON.stringify(spike)).not.toContain('private-key');
    expect(evaluatePlatformSessionCapability(spike)).toMatchObject({
      hostIdentity: 'host_verified',
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
      subagentInheritance: 'not_applicable',
      hookApproval: 'not_applicable',
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

  it('executes the command propagation leg without invoking a shell', async () => {
    vi.stubEnv('MANCODE_SPIKE_HOST_SESSION_KEY', SESSION_ID);
    try {
      await expect(
        probeSessionEnvironmentPropagation(SESSION_ID),
      ).resolves.toBe('proven');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not claim propagation when the parent environment lacks the host key', async () => {
    vi.stubEnv('MANCODE_SPIKE_HOST_SESSION_KEY', 'different-host-session-key');
    try {
      await expect(
        probeSessionEnvironmentPropagation('actual-host-session-key'),
      ).resolves.toBe('not_proven');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

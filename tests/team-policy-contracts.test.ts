import { describe, expect, it } from 'vitest';
import {
  assertConfigPolicyConsistency,
  assertIndependentConfigPolicyUpdate,
  assertProjectConfigTransition,
  assertTeamPolicyTransition,
  parseProjectConfig,
  parseTeamPolicy,
  projectConfigIdentityDigest,
} from '../src/team/policy.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';

describe('project config and team policy V1 contracts', () => {
  it('keeps transport authority exclusively in project config', () => {
    const config = parseProjectConfig(rawConfig());
    const policy = parseTeamPolicy(rawPolicy());
    expect(() => assertConfigPolicyConsistency(config, policy)).not.toThrow();
    expect(projectConfigIdentityDigest(config)).toBe(
      projectConfigIdentityDigest(
        parseProjectConfig({
          ...rawConfig(),
          revision: 2,
          transport: { mode: 'git-ref', remote: 'origin' },
        }),
      ),
    );
    expect(() =>
      parseTeamPolicy({ ...rawPolicy(), transport: { mode: 'local' } }),
    ).toThrow(/unknown field/);
    expect(() =>
      assertConfigPolicyConsistency(
        config,
        parseTeamPolicy({
          ...rawPolicy(),
          workspaceId: '01JZ4B6W5Z0A1B2C3D4E5F6G7J',
        }),
      ),
    ).toThrow(/workspaceId must match/);
  });

  it('uses separate revision CAS paths for config transport and team policy', () => {
    const previousConfig = parseProjectConfig(rawConfig());
    const nextConfig = parseProjectConfig({
      ...rawConfig(),
      revision: 2,
      transport: { mode: 'git-ref', remote: 'origin', epoch: 2 },
    });
    expect(() =>
      assertProjectConfigTransition(previousConfig, nextConfig, 'ordinary'),
    ).toThrow(/transport may only change/);
    expect(() =>
      assertProjectConfigTransition(
        previousConfig,
        nextConfig,
        'transport_set',
      ),
    ).not.toThrow();

    const previousPolicy = parseTeamPolicy(rawPolicy());
    const nextPolicy = parseTeamPolicy({
      ...rawPolicy(),
      revision: 2,
      policy: 'on',
    });
    expect(() =>
      assertTeamPolicyTransition(previousPolicy, nextPolicy),
    ).not.toThrow();
    expect(() =>
      assertIndependentConfigPolicyUpdate(
        previousConfig,
        nextConfig,
        previousPolicy,
        nextPolicy,
      ),
    ).toThrow(/cannot be updated by one ordinary patch/);
  });
});

function rawConfig() {
  return {
    schemaVersion: 1,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    transport: { mode: 'local', remote: null },
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function rawPolicy() {
  return {
    schemaVersion: 1,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    policy: 'auto',
    recentDays: 30,
    defaultVisibility: 'local',
    shareConfirmedDecisions: true,
    retention: {
      localRawArtifactDays: 30,
      localCacheDays: 7,
      completedSessionDays: 30,
    },
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

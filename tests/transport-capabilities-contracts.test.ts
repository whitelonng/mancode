import { describe, expect, it } from 'vitest';
import { parseProjectConfig } from '../src/team/policy.js';
import {
  assertRemoteMutationAvailable,
  capabilitiesFromProjectConfig,
  localCoordinationCapabilities,
  parseCoordinationCapabilities,
} from '../src/team/transport.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';

describe('coordination capability and transport contract', () => {
  it('keeps local coordination distinct from cross-clone transport', () => {
    const local = localCoordinationCapabilities();
    expect(local).toMatchObject({
      claimAcquisition: 'enforced',
      writeGuard: 'advisory',
      transport: 'local',
      transportFreshness: 'unavailable',
    });
    expect(() =>
      assertRemoteMutationAvailable(local, {
        operationId: OPERATION_ID,
        expectedRemoteRevision: 0,
        expectedOwnershipEpoch: 0,
      }),
    ).toThrow('MANCODE_TRANSPORT_UNAVAILABLE');
    expect(() =>
      parseCoordinationCapabilities({
        ...local,
        transportFreshness: 'fresh',
      }),
    ).toThrow(/local transport/);
  });

  it('requires fresh git-ref state and matching remote revision for remote CAS', () => {
    const fresh = parseCoordinationCapabilities({
      claimAcquisition: 'enforced',
      writeGuard: 'advisory',
      transport: 'git-ref',
      transportFreshness: 'fresh',
      lastSuccessfulSyncAt: '2026-07-17T10:00:00.000Z',
      remoteRevision: 7,
    });
    expect(() =>
      assertRemoteMutationAvailable(fresh, {
        operationId: OPERATION_ID,
        expectedRemoteRevision: 7,
        expectedOwnershipEpoch: 3,
      }),
    ).not.toThrow();
    expect(() =>
      assertRemoteMutationAvailable(fresh, {
        operationId: OPERATION_ID,
        expectedRemoteRevision: 6,
        expectedOwnershipEpoch: 3,
      }),
    ).toThrow('MANCODE_TRANSPORT_REVISION_CONFLICT');

    const config = parseProjectConfig({
      schemaVersion: 1,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      transport: { mode: 'git-ref', remote: 'origin' },
      lastOperationId: null,
      updatedAt: '2026-07-17T10:00:00.000Z',
    });
    expect(capabilitiesFromProjectConfig(config)).toMatchObject({
      transport: 'git-ref',
      transportFreshness: 'unknown',
      claimAcquisition: 'unavailable',
    });
  });
});

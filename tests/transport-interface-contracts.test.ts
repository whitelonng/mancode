import { describe, expect, it } from 'vitest';
import {
  type CoordinationCapabilitiesV1,
  type CoordinationTransport,
  GitRefCoordinationTransportAdapter,
  type GitRefCoordinationTransportBackend,
  LocalCoordinationTransportAdapter,
  type TransportMutationRequest,
  parseCoordinationCapabilities,
} from '../src/team/transport.js';

const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const SYNCED_AT = '2026-07-18T10:00:00.000Z';

interface TransportContractFixture {
  transport: CoordinationTransport;
  backend: StatefulGitRefBackend | null;
  supportsRemoteMutation: boolean;
}

interface TransportContractDefinition {
  mode: CoordinationTransport['mode'];
  create(): TransportContractFixture;
}

function defineTransportContract(
  name: string,
  definition: TransportContractDefinition,
): void {
  describe(name, () => {
    it('reports a valid capability tuple and keeps inspect cache-only', async () => {
      const fixture = definition.create();

      expect(fixture.transport.mode).toBe(definition.mode);
      const inspected = parseCoordinationCapabilities(
        await fixture.transport.inspect(),
      );
      expect(inspected.transport).toBe(definition.mode);
      if (fixture.backend !== null) {
        expect(fixture.backend.calls).toMatchObject({
          inspect: 1,
          pull: 0,
          push: 0,
        });
      }

      const pulled = parseCoordinationCapabilities(
        await fixture.transport.pull(),
      );
      expect(pulled.transport).toBe(definition.mode);
      if (fixture.supportsRemoteMutation) {
        expect(pulled).toMatchObject({
          transportFreshness: 'fresh',
          remoteRevision: 4,
        });
        expect(fixture.backend?.calls).toMatchObject({
          inspect: 1,
          pull: 1,
          push: 0,
        });
      } else {
        expect(pulled).toMatchObject({
          transportFreshness: 'unavailable',
          lastSuccessfulSyncAt: null,
          remoteRevision: null,
        });
      }
    });

    it('rejects an invalid mutation envelope before backend mutation', async () => {
      const fixture = definition.create();
      const invalid = {
        operationId: 'not-an-ulid',
        expectedRemoteRevision: 0,
        expectedOwnershipEpoch: 0,
      } as TransportMutationRequest;

      await expect(fixture.transport.push(invalid)).rejects.toThrow(/ULID/);
      expect(fixture.backend?.calls.push ?? 0).toBe(0);
    });

    it('applies the transport-specific remote mutation fence', async () => {
      const fixture = definition.create();
      const request = mutationRequest(4);

      if (!fixture.supportsRemoteMutation) {
        await expect(fixture.transport.push(request)).rejects.toThrow(
          'MANCODE_TRANSPORT_UNAVAILABLE',
        );
        return;
      }

      await expect(fixture.transport.push(request)).rejects.toThrow(
        'MANCODE_TRANSPORT_UNAVAILABLE',
      );
      expect(fixture.backend?.calls.push).toBe(0);

      await fixture.transport.pull();
      await expect(fixture.transport.push(mutationRequest(3))).rejects.toThrow(
        'MANCODE_TRANSPORT_REVISION_CONFLICT',
      );
      expect(fixture.backend?.calls.push).toBe(0);

      const pushed = await fixture.transport.push(request);
      expect(pushed).toMatchObject({
        transport: 'git-ref',
        transportFreshness: 'fresh',
        remoteRevision: 5,
      });
      expect(fixture.backend?.calls.push).toBe(1);
      expect(fixture.backend?.lastMutation).toEqual(request);
      expect(fixture.backend?.remoteRevision).toBe(5);
    });
  });
}

defineTransportContract('local coordination transport adapter contract', {
  mode: 'local',
  create: () => ({
    transport: new LocalCoordinationTransportAdapter(),
    backend: null,
    supportsRemoteMutation: false,
  }),
});

defineTransportContract('git-ref coordination transport adapter contract', {
  mode: 'git-ref',
  create: () => {
    const backend = new StatefulGitRefBackend();
    return {
      transport: new GitRefCoordinationTransportAdapter(backend),
      backend,
      supportsRemoteMutation: true,
    };
  },
});

describe('git-ref coordination transport freshness fence', () => {
  it('degrades stale cache state and does not call the mutation backend', async () => {
    const backend = new StatefulGitRefBackend();
    const transport = new GitRefCoordinationTransportAdapter(backend);
    await transport.pull();
    backend.markStale();

    await expect(transport.inspect()).resolves.toMatchObject({
      claimAcquisition: 'advisory',
      transportFreshness: 'stale',
      remoteRevision: 4,
    });
    await expect(transport.push(mutationRequest(4))).rejects.toThrow(
      'MANCODE_TRANSPORT_UNAVAILABLE',
    );
    expect(backend.calls.push).toBe(0);
  });
});

class StatefulGitRefBackend implements GitRefCoordinationTransportBackend {
  readonly calls = { inspect: 0, pull: 0, push: 0 };
  remoteRevision = 4;
  lastMutation: TransportMutationRequest | null = null;
  private cached: CoordinationCapabilitiesV1 = unknownCapabilities();

  async inspect(): Promise<CoordinationCapabilitiesV1> {
    this.calls.inspect += 1;
    return { ...this.cached };
  }

  async pull(): Promise<CoordinationCapabilitiesV1> {
    this.calls.pull += 1;
    this.cached = freshCapabilities(this.remoteRevision);
    return { ...this.cached };
  }

  async push(
    request: TransportMutationRequest,
  ): Promise<CoordinationCapabilitiesV1> {
    this.calls.push += 1;
    if (request.expectedRemoteRevision !== this.remoteRevision) {
      throw new Error('MANCODE_TRANSPORT_REVISION_CONFLICT');
    }
    this.lastMutation = { ...request };
    this.remoteRevision += 1;
    this.cached = freshCapabilities(this.remoteRevision);
    return { ...this.cached };
  }

  markStale(): void {
    this.cached = {
      ...freshCapabilities(this.remoteRevision),
      claimAcquisition: 'advisory',
      transportFreshness: 'stale',
    };
  }
}

function mutationRequest(remoteRevision: number): TransportMutationRequest {
  return {
    operationId: OPERATION_ID,
    expectedRemoteRevision: remoteRevision,
    expectedOwnershipEpoch: 2,
  };
}

function unknownCapabilities(): CoordinationCapabilitiesV1 {
  return {
    claimAcquisition: 'unavailable',
    writeGuard: 'advisory',
    transport: 'git-ref',
    transportFreshness: 'unknown',
    lastSuccessfulSyncAt: null,
    remoteRevision: null,
  };
}

function freshCapabilities(remoteRevision: number): CoordinationCapabilitiesV1 {
  return {
    claimAcquisition: 'enforced',
    writeGuard: 'advisory',
    transport: 'git-ref',
    transportFreshness: 'fresh',
    lastSuccessfulSyncAt: SYNCED_AT,
    remoteRevision,
  };
}

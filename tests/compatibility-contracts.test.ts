import { describe, expect, it } from 'vitest';
import {
  CURRENT_WRITER_CAPABILITIES,
  type CompatibilityFailureCode,
  type CompatibilityGateInput,
  assertCompatibilityGate,
  compareSemver,
  evaluateCompatibilityGate,
} from '../src/context/compatibility.js';
import type {
  SchemaManifestV1,
  SchemaManifestV2,
} from '../src/context/manifest.js';

const EPOCH = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const BASELINE = {
  stateDigest: `sha256:${'a'.repeat(64)}`,
  workflowIndexDigest: `sha256:${'b'.repeat(64)}`,
};

describe('schema compatibility gate', () => {
  it('allows only migration staging during dual-read', () => {
    const input = baseInput({
      activationState: 'dual_read',
      legacyBaseline: BASELINE,
    });
    expect(
      evaluateCompatibilityGate({ ...input, operation: 'migration_stage' }),
    ).toMatchObject({ readAllowed: true, writeAllowed: true, failures: [] });
    expect(
      evaluateCompatibilityGate({ ...input, operation: 'v3_business_write' }),
    ).toMatchObject({ writeAllowed: false });
    expect(() =>
      assertCompatibilityGate({ ...input, operation: 'v3_business_write' }),
    ).toThrow('MANCODE_V3_WRITE_REQUIRES_ACTIVATION');
  });

  it('blocks reads and writes when the schema epoch differs', () => {
    expectWriteBlocked(
      {
        ...activeInput(),
        expectedSchemaEpoch: '01JZ4B6W5Z0A1B2C3D4E5F6G7J',
        operation: 'v3_business_write',
      },
      ['MANCODE_SCHEMA_EPOCH_MISMATCH'],
      false,
    );
  });

  it('blocks reads and writes when minReaderVersion exceeds the reader', () => {
    expectWriteBlocked(
      {
        ...activeInput({ minReaderVersion: '0.4.1' }),
        operation: 'v3_business_write',
      },
      ['MANCODE_READER_VERSION_TOO_OLD'],
      false,
    );
  });

  it('allows reads but blocks writes when minWriterVersion exceeds the writer', () => {
    expectWriteBlocked(
      {
        ...activeInput({ minWriterVersion: '0.4.1' }),
        operation: 'v3_business_write',
      },
      ['MANCODE_WRITER_VERSION_TOO_OLD'],
      true,
    );
  });

  it('requires the registered adapter inventory to match disk exactly', () => {
    const active = activeInput();
    const codexOnly = activeInput({ managedAdapters: { codex: '3' } });

    expect(
      evaluateCompatibilityGate({
        ...codexOnly,
        operation: 'v3_business_write',
      }),
    ).toMatchObject({ writeAllowed: true, failures: [] });
    expectWriteBlocked(
      {
        ...active,
        adapterVersions: {
          ...active.adapterVersions,
          codex: 'missing',
        },
        operation: 'v3_business_write',
      },
      ['MANCODE_ADAPTER_CONTENT_STALE'],
      true,
    );
    try {
      assertCompatibilityGate({
        ...codexOnly,
        adapterVersions: { codex: 'stale' },
        operation: 'v3_business_write',
      });
      throw new Error('expected stale adapter compatibility failure');
    } catch (error) {
      expect(error).toMatchObject({
        details: {
          repair: [
            {
              platform: 'codex',
              previewCommand:
                'mancode adapter upgrade --platform codex --dry-run',
              confirmCommand: expect.stringContaining(
                '--platform codex --confirm --operation-id <operationId>',
              ),
            },
          ],
        },
      });
      expect(JSON.stringify(error)).not.toContain('--all');
    }
    expectWriteBlocked(
      {
        ...active,
        adapterVersions: withoutCodex(active.adapterVersions),
        operation: 'v3_business_write',
      },
      ['MANCODE_ADAPTER_VERSION_MISMATCH'],
      true,
    );
    expectWriteBlocked(
      {
        ...codexOnly,
        adapterVersions: { ...codexOnly.adapterVersions, cursor: '3' },
        operation: 'v3_business_write',
      },
      ['MANCODE_ADAPTER_VERSION_MISMATCH'],
      true,
    );
    expectWriteBlocked(
      {
        ...active,
        adapterVersions: { ...active.adapterVersions, codex: '2' },
        operation: 'v3_business_write',
      },
      ['MANCODE_ADAPTER_VERSION_MISMATCH'],
      true,
    );
  });

  it('requires explicit writer capabilities before any Policy 2 write', () => {
    const base = activeInput();
    const manifest: SchemaManifestV2 = {
      ...base.manifest,
      manifestVersion: 2,
      workflowPolicyDefaults: { planning: 2 },
    };
    const input = { ...base, manifest };
    expectWriteBlocked(
      {
        ...input,
        writerCapabilities: ['planning-policy:1'],
        operation: 'v3_business_write',
      },
      ['MANCODE_WRITER_CAPABILITY_MISSING'],
      true,
    );
    expect(() =>
      assertCompatibilityGate({
        ...input,
        writerCapabilities: ['planning-policy:1'],
        operation: 'v3_business_write',
      }),
    ).toThrow(/planning-policy:2/);
  });

  it('blocks a 0.3.x CLI at the V2 manifest boundary before policy execution', () => {
    const base = activeInput({
      minReaderVersion: '0.4.0',
      minWriterVersion: '0.4.0',
    });
    const manifest: SchemaManifestV2 = {
      ...base.manifest,
      manifestVersion: 2,
      workflowPolicyDefaults: { planning: 2 },
    };
    const result = evaluateCompatibilityGate({
      ...base,
      manifest,
      readerVersion: '0.3.18',
      writerVersion: '0.3.18',
      writerCapabilities: ['planning-policy:1'],
      operation: 'v3_business_write',
    });

    expect(result).toEqual({
      readAllowed: false,
      writeAllowed: false,
      failures: [
        'MANCODE_READER_VERSION_TOO_OLD',
        'MANCODE_WRITER_VERSION_TOO_OLD',
        'MANCODE_WRITER_CAPABILITY_MISSING',
      ],
    });
    expect(() =>
      assertCompatibilityGate({
        ...base,
        manifest,
        readerVersion: '0.3.18',
        writerVersion: '0.3.18',
        writerCapabilities: ['planning-policy:1'],
        operation: 'v3_business_write',
      }),
    ).toThrow(/^MANCODE_READER_VERSION_TOO_OLD:/);
  });

  it('requires the adapter digest and local reframe capabilities for reframe', () => {
    const input = activeInput();
    expectWriteBlocked(
      {
        ...input,
        writerCapabilities: ['planning-policy:1', 'adapter-digest:1'],
        operation: 'reframe',
      },
      ['MANCODE_WRITER_CAPABILITY_MISSING'],
      true,
    );
    expect(
      evaluateCompatibilityGate({
        ...input,
        writerCapabilities: [
          'planning-policy:1',
          'adapter-digest:1',
          'reframe-local:1',
        ],
        operation: 'reframe',
      }),
    ).toMatchObject({ writeAllowed: true, failures: [] });
  });

  it('blocks writes when the legacy authority drifts from its baseline', () => {
    expectWriteBlocked(
      {
        ...activeInput(),
        currentLegacyBaseline: {
          ...BASELINE,
          stateDigest: `sha256:${'c'.repeat(64)}`,
        },
        operation: 'v3_business_write',
      },
      ['MANCODE_LEGACY_BASELINE_CHANGED'],
      true,
    );
  });

  it('reports the complete deterministic failure set for a mixed-version writer', () => {
    const active = activeInput({
      minReaderVersion: '0.4.1',
      minWriterVersion: '0.4.1',
    });

    expectWriteBlocked(
      {
        ...active,
        expectedSchemaEpoch: '01JZ4B6W5Z0A1B2C3D4E5F6G7J',
        adapterVersions: { ...active.adapterVersions, codex: '2' },
        currentLegacyBaseline: {
          ...BASELINE,
          workflowIndexDigest: `sha256:${'c'.repeat(64)}`,
        },
        operation: 'v3_business_write',
      },
      [
        'MANCODE_SCHEMA_EPOCH_MISMATCH',
        'MANCODE_READER_VERSION_TOO_OLD',
        'MANCODE_WRITER_VERSION_TOO_OLD',
        'MANCODE_ADAPTER_VERSION_MISMATCH',
        'MANCODE_LEGACY_BASELINE_CHANGED',
      ],
      false,
    );
  });

  it('keeps greenfield initialization mutually exclusive with legacy authority', () => {
    const result = evaluateCompatibilityGate({
      ...baseInput({ activationState: 'initializing', legacyBaseline: null }),
      legacyAuthorityPresent: true,
      currentLegacyBaseline: null,
      operation: 'greenfield_initialize',
    });
    expect(result.failures).toContain('MANCODE_LEGACY_AUTHORITY_PRESENT');
  });

  it('orders semantic versions including prereleases', () => {
    expect(compareSemver('0.4.0', '0.4.0-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('0.4.0-beta.2', '0.4.0-beta.10')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });
});

function activeInput(overrides: Partial<SchemaManifestV1> = {}) {
  return baseInput({
    activationState: 'v3_active',
    legacyBaseline: BASELINE,
    activatedAt: '2026-07-17T12:00:00.000Z',
    ...overrides,
  });
}

function expectWriteBlocked(
  input: CompatibilityGateInput,
  failures: CompatibilityFailureCode[],
  readAllowed: boolean,
): void {
  expect(evaluateCompatibilityGate(input)).toEqual({
    readAllowed,
    writeAllowed: false,
    failures,
  });
  expect(() => assertCompatibilityGate(input)).toThrowError(
    new RegExp(`^${failures[0]}:`),
  );
}

function withoutCodex(
  adapters: SchemaManifestV1['managedAdapters'],
): CompatibilityGateInput['adapterVersions'] {
  return Object.fromEntries(
    Object.entries(adapters).filter(([adapter]) => adapter !== 'codex'),
  );
}

function baseInput(overrides: Partial<SchemaManifestV1>) {
  const manifest: SchemaManifestV1 = {
    manifestVersion: 1,
    layoutVersion: 3,
    epoch: EPOCH,
    activationState: 'initializing',
    minReaderVersion: '0.4.0',
    minWriterVersion: '0.4.0',
    activatedAt: null,
    legacyBaseline: null,
    managedAdapters: {
      'claude-code': '3',
      codex: '3',
      cursor: '3',
      copilot: '3',
      zcode: '3',
    },
    lastOperationId: null,
    ...overrides,
  };
  return {
    manifest,
    expectedSchemaEpoch: EPOCH,
    readerVersion: '0.4.0',
    writerVersion: '0.4.0',
    writerCapabilities: CURRENT_WRITER_CAPABILITIES,
    adapterVersions: { ...manifest.managedAdapters },
    currentLegacyBaseline: manifest.legacyBaseline,
    legacyAuthorityPresent: manifest.legacyBaseline !== null,
  };
}

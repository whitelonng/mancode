import { describe, expect, it } from 'vitest';
import {
  type CompatibilityFailureCode,
  type CompatibilityGateInput,
  assertCompatibilityGate,
  compareSemver,
  evaluateCompatibilityGate,
} from '../src/context/compatibility.js';
import type { SchemaManifestV1 } from '../src/context/manifest.js';

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

  it('blocks writes for both missing and mismatched managed adapters', () => {
    const active = activeInput();

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
        ...active,
        adapterVersions: { ...active.adapterVersions, codex: '2' },
        operation: 'v3_business_write',
      },
      ['MANCODE_ADAPTER_VERSION_MISMATCH'],
      true,
    );
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
        adapterVersions: withoutCodex(active.adapterVersions),
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
    new RegExp(`^${failures[0]}$`),
  );
}

function withoutCodex(
  adapters: SchemaManifestV1['managedAdapters'],
): CompatibilityGateInput['adapterVersions'] {
  return {
    'claude-code': adapters['claude-code'],
    cursor: adapters.cursor,
    copilot: adapters.copilot,
    zcode: adapters.zcode,
  };
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
    adapterVersions: { ...manifest.managedAdapters },
    currentLegacyBaseline: manifest.legacyBaseline,
    legacyAuthorityPresent: manifest.legacyBaseline !== null,
  };
}

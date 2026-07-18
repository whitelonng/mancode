import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextDiagnostics } from '../src/commands/context.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createUlid } from '../src/context/ids.js';
import {
  localDiagnosticsPath,
  parseLocalDiagnostics,
  readLocalDiagnostics,
  recordLocalDiagnostic,
  recordV3ErrorDiagnostic,
  setLocalDiagnosticsEnabled,
} from '../src/runtime/diagnostics.js';

const NOW = new Date('2026-07-18T12:00:00.000Z');

describe('local diagnostics contract', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-diagnostics-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores only fixed aggregate counts and drops them immediately when disabled', async () => {
    await recordLocalDiagnostic(root, { kind: 'context_stale' }, NOW);
    await recordLocalDiagnostic(
      root,
      { kind: 'claim_conflict', level: 'blocker' },
      NOW,
    );
    await recordLocalDiagnostic(root, { kind: 'repair_operation' }, NOW);

    await expect(readLocalDiagnostics(root)).resolves.toMatchObject({
      contextStaleCount: 1,
      claimConflictCounts: { blocker: 1 },
      repairOperationCount: 1,
    });
    const persisted = await readFile(localDiagnosticsPath(root), 'utf8');
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain('task');
    expect(persisted).not.toContain('actor');

    await setLocalDiagnosticsEnabled(root, false, NOW);
    await expect(readLocalDiagnostics(root)).resolves.toBeNull();
    await expect(
      recordLocalDiagnostic(root, { kind: 'revision_conflict' }, NOW),
    ).resolves.toBeNull();
    await expect(readLocalDiagnostics(root)).resolves.toBeNull();
  });

  it('exposes explicit show, disable, and enable commands', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await contextDiagnostics(root, 'disable', { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        config: { enabled: false },
        diagnostics: null,
      });
      expect(await contextDiagnostics(root, 'enable', { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        config: { enabled: true },
      });
      expect(await contextDiagnostics(root, 'invalid', { json: true })).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_DIAGNOSTICS_ACTION_INVALID' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('maps only classified V3 error codes to aggregate counters', async () => {
    await recordV3ErrorDiagnostic(
      root,
      new Error('MANCODE_EXPECTED_REVISION_CONFLICT'),
      NOW,
    );
    await recordV3ErrorDiagnostic(
      root,
      new Error('MANCODE_CONTEXT_STALE'),
      NOW,
    );
    await recordV3ErrorDiagnostic(root, new Error('MANCODE_SPLIT_BRAIN'), NOW);
    await recordV3ErrorDiagnostic(root, new Error('unclassified failure'), NOW);

    await expect(readLocalDiagnostics(root)).resolves.toMatchObject({
      revisionConflictCount: 1,
      contextStaleCount: 1,
      migrationSplitBrainDetectionCount: 1,
    });
  });

  it('rejects unrecognized stored fields rather than accepting accidental content', () => {
    expect(() =>
      parseLocalDiagnostics({
        schemaVersion: 1,
        contextStaleCount: 0,
        revisionConflictCount: 0,
        claimConflictCounts: { info: 0, warning: 0, blocker: 0, unknown: 0 },
        repairOperationCount: 0,
        migrationSplitBrainDetectionCount: 0,
        adapterCapabilityDowngradeCount: 0,
        updatedAt: NOW.toISOString(),
        task: 'must not be stored',
      }),
    ).toThrow(/unknown field/);
  });
});

function id(offset: number) {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

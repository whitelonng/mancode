import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertGreenfieldInitializationPreflight,
  assertV3PhysicalIsolation,
  inspectMancodeLayout,
  sameLegacyBaseline,
} from '../src/context/layout.js';

describe('legacy/V3 physical layout contract', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-layout-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps legacy and V3 authority paths physically disjoint', () => {
    expect(() => assertV3PhysicalIsolation()).not.toThrow();
  });

  it('detects every legacy authority category in the baseline without exposing its contents', async () => {
    await mkdir(path.join(root, '.mancode', 'workflows', 'legacy-task'), {
      recursive: true,
    });
    await mkdir(path.join(root, '.mancode', 'memory'), { recursive: true });
    await writeFile(path.join(root, '.mancode', 'state.json'), '{"task":"x"}');
    await writeFile(
      path.join(root, '.mancode', 'config.json'),
      '{"team":true}',
    );
    await writeFile(
      path.join(root, '.mancode', 'workflows', 'legacy-task', 'metadata.json'),
      '{"status":"active"}',
    );
    await writeFile(path.join(root, '.mancode', 'memory', 'note.md'), 'secret');

    const first = await inspectMancodeLayout(root);
    expect(first.legacy.authorityPresent).toBe(true);
    expect(first.legacy.baseline).not.toBeNull();
    expect(JSON.stringify(first.legacy)).not.toContain('secret');
    await writeFile(
      path.join(root, '.mancode', 'config.json'),
      '{"team":false}',
    );
    const second = await inspectMancodeLayout(root);
    expect(
      sameLegacyBaseline(first.legacy.baseline, second.legacy.baseline),
    ).toBe(false);
    await expect(assertGreenfieldInitializationPreflight(root)).rejects.toThrow(
      'MANCODE_LEGACY_AUTHORITY_PRESENT',
    );
  });

  it('does not mistake a V3 root for legacy authority, but never overwrites it', async () => {
    await mkdir(path.join(root, '.mancode', 'shared'), { recursive: true });
    await writeFile(path.join(root, '.mancode', 'schema.json'), '{}');
    const inspection = await inspectMancodeLayout(root);
    expect(inspection.legacy.authorityPresent).toBe(false);
    expect(inspection.v3AuthorityPathsPresent).toEqual([
      'schema.json',
      'shared',
    ]);
    await expect(assertGreenfieldInitializationPreflight(root)).rejects.toThrow(
      'MANCODE_V3_TARGET_EXISTS',
    );
  });

  it('recognizes a .mancode holding only non-Continuity scratch, but keeps the preflight strict', async () => {
    await mkdir(path.join(root, '.mancode', 'local', 'release-evidence'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.mancode', 'local', 'release-evidence', '0.6.2.json'),
      '{}',
    );
    const inspection = await inspectMancodeLayout(root);
    expect(inspection.v3TargetExists).toBe(true);
    expect(inspection.v3ScratchOnly).toBe(true);
    expect(inspection.v3TargetEntries).toEqual(['local']);
    // The journaled initializer never touches a pre-existing directory;
    // the command layer owns the move-aside decision.
    await expect(assertGreenfieldInitializationPreflight(root)).rejects.toThrow(
      'MANCODE_V3_TARGET_EXISTS',
    );
  });

  it('never treats local Continuity content as ignorable scratch', async () => {
    await mkdir(path.join(root, '.mancode', 'local', 'sessions'), {
      recursive: true,
    });
    const inspection = await inspectMancodeLayout(root);
    expect(inspection.v3TargetExists).toBe(true);
    expect(inspection.v3ScratchOnly).toBe(false);
  });

  it('reports an empty .mancode as removable scratch and sorts target entries', async () => {
    await mkdir(path.join(root, '.mancode'), { recursive: true });
    await mkdir(path.join(root, '.mancode', 'local', 'other-tool-backup'), {
      recursive: true,
    });
    await writeFile(path.join(root, '.mancode', 'notes.txt'), 'x');
    const inspection = await inspectMancodeLayout(root);
    expect(inspection.v3ScratchOnly).toBe(true);
    expect(inspection.v3TargetEntries).toEqual(['local', 'notes.txt']);
    await rm(path.join(root, '.mancode', 'notes.txt'));
    await rm(path.join(root, '.mancode', 'local'), { recursive: true });
    const empty = await inspectMancodeLayout(root);
    expect(empty.v3ScratchOnly).toBe(true);
    expect(empty.v3TargetEntries).toEqual([]);
  });

  it('treats a legacy symlink as unsafe authority and never follows it', async () => {
    const external = path.join(root, 'outside.json');
    await writeFile(external, 'outside-secret');
    await mkdir(path.join(root, '.mancode'), { recursive: true });
    await symlink(external, path.join(root, '.mancode', 'state.json'));
    const inspection = await inspectMancodeLayout(root);
    expect(inspection.legacy.authorityPresent).toBe(true);
    expect(inspection.legacy.unsafePaths).toEqual(['state.json']);
    expect(JSON.stringify(inspection.legacy)).not.toContain('outside-secret');
  });
});

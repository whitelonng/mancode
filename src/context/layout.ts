import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from './canonical.js';
import type { LegacyBaseline } from './manifest.js';

/**
 * These are the only paths owned by the legacy implementation.  V3 must not
 * write any of them, even while a project is in dual-read migration.
 */
export const LEGACY_AUTHORITY_PATHS = [
  'state.json',
  'config.json',
  'project-profile.json',
  'workflows',
  'memory',
] as const;

/** V3 paths are deliberately siblings of, never aliases for, legacy paths. */
export const V3_AUTHORITY_PATHS = [
  'schema.json',
  'shared',
  'local',
  'runtime',
] as const;

export type LegacyAuthorityPath = (typeof LEGACY_AUTHORITY_PATHS)[number];
export type LegacyEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface LegacyAuthorityEntry {
  path: LegacyAuthorityPath;
  exists: boolean;
  kind: LegacyEntryKind | null;
  /** A file, symlink, or non-empty directory is legacy business authority. */
  hasBusinessContent: boolean;
  /** Digest of a safe, non-following tree description; never contains content. */
  digest: string | null;
}

export interface LegacyAuthorityScan {
  authorityPresent: boolean;
  entries: LegacyAuthorityEntry[];
  baseline: LegacyBaseline | null;
  /** Symlinks and special nodes are authority, but cannot be trusted as input. */
  unsafePaths: LegacyAuthorityPath[];
}

export interface MancodeLayoutInspection {
  legacy: LegacyAuthorityScan;
  v3TargetExists: boolean;
  v3AuthorityPathsPresent: string[];
}

/**
 * Reads only the fixed legacy roots without following symlinks.  The two
 * baseline digests intentionally cover all legacy authority: stateDigest is
 * an aggregate of state/config/profile/memory, while workflowIndexDigest is
 * the complete legacy workflows tree.  This preserves the V1 manifest shape
 * while detecting edits outside state.json too.
 */
export async function scanLegacyAuthority(
  projectRoot: string,
): Promise<LegacyAuthorityScan> {
  const root = path.resolve(projectRoot, '.mancode');
  const entries = await Promise.all(
    LEGACY_AUTHORITY_PATHS.map((legacyPath) =>
      scanLegacyEntry(root, legacyPath),
    ),
  );
  const authorityPresent = entries.some((entry) => entry.hasBusinessContent);
  const unsafePaths = entries
    .filter((entry) => entry.kind === 'symlink' || entry.kind === 'other')
    .map((entry) => entry.path);
  return {
    authorityPresent,
    entries,
    baseline: authorityPresent ? baselineFor(entries) : null,
    unsafePaths,
  };
}

/**
 * Inspects the physical layout before an initialization or migration.  The
 * inspection never treats an existing V3 root as permission to overwrite it.
 */
export async function inspectMancodeLayout(
  projectRoot: string,
): Promise<MancodeLayoutInspection> {
  const root = path.resolve(projectRoot);
  const mancodeRoot = path.join(root, '.mancode');
  const [legacy, target] = await Promise.all([
    scanLegacyAuthority(root),
    lstatOrNull(mancodeRoot),
  ]);
  const v3AuthorityPathsPresent = (
    await Promise.all(
      V3_AUTHORITY_PATHS.map(async (relativePath) =>
        (await lstatOrNull(path.join(mancodeRoot, relativePath))) === null
          ? null
          : relativePath,
      ),
    )
  ).filter(
    (value): value is (typeof V3_AUTHORITY_PATHS)[number] => value !== null,
  );
  return {
    legacy,
    v3TargetExists: target !== null,
    v3AuthorityPathsPresent,
  };
}

/** Greenfield initialization must not reinterpret an existing legacy project. */
export async function assertGreenfieldInitializationPreflight(
  projectRoot: string,
): Promise<MancodeLayoutInspection> {
  const inspection = await inspectMancodeLayout(projectRoot);
  if (inspection.legacy.authorityPresent) {
    throw new Error('MANCODE_LEGACY_AUTHORITY_PRESENT');
  }
  if (inspection.v3TargetExists) {
    throw new Error('MANCODE_V3_TARGET_EXISTS');
  }
  return inspection;
}

/** A static invariant, kept executable so future path changes cannot collide. */
export function assertV3PhysicalIsolation(): void {
  for (const legacyPath of LEGACY_AUTHORITY_PATHS) {
    for (const v3Path of V3_AUTHORITY_PATHS) {
      if (pathsOverlap(legacyPath, v3Path)) {
        throw new Error(
          `MANCODE_LAYOUT_PATH_COLLISION: ${legacyPath} and ${v3Path}`,
        );
      }
    }
  }
}

export function sameLegacyBaseline(
  left: LegacyBaseline | null,
  right: LegacyBaseline | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.stateDigest === right.stateDigest &&
      left.workflowIndexDigest === right.workflowIndexDigest)
  );
}

async function scanLegacyEntry(
  root: string,
  legacyPath: LegacyAuthorityPath,
): Promise<LegacyAuthorityEntry> {
  const node = await describeNode(path.join(root, legacyPath));
  return {
    path: legacyPath,
    exists: node !== null,
    kind: node?.kind ?? null,
    hasBusinessContent: node?.hasBusinessContent ?? false,
    digest: node?.digest ?? null,
  };
}

interface NodeDescription {
  kind: LegacyEntryKind;
  hasBusinessContent: boolean;
  digest: string;
}

/** Does not call realpath or read a symlink target. */
async function describeNode(target: string): Promise<NodeDescription | null> {
  const stat = await lstatOrNull(target);
  if (stat === null) return null;
  if (stat.isFile()) {
    const contents = await readFile(target);
    return {
      kind: 'file',
      hasBusinessContent: true,
      digest: sha256(contents),
    };
  }
  if (stat.isSymbolicLink()) {
    const link = await readlink(target);
    return {
      kind: 'symlink',
      hasBusinessContent: true,
      digest: sha256(Buffer.from(link, 'utf8')),
    };
  }
  if (!stat.isDirectory()) {
    return {
      kind: 'other',
      hasBusinessContent: true,
      digest: digestCanonicalJson({ kind: 'other' }),
    };
  }
  const names = await readdir(target);
  names.sort(compareUtf8);
  const children = await Promise.all(
    names.map(async (name) => {
      const child = await describeNode(path.join(target, name));
      if (child === null) {
        throw new Error('MANCODE_LEGACY_TREE_CHANGED_DURING_SCAN');
      }
      return { name, ...child };
    }),
  );
  return {
    kind: 'directory',
    hasBusinessContent: children.some((child) => child.hasBusinessContent),
    digest: digestCanonicalJson({
      kind: 'directory',
      children: children.map((child) => ({
        name: child.name,
        kind: child.kind,
        digest: child.digest,
      })),
    }),
  };
}

function baselineFor(entries: LegacyAuthorityEntry[]): LegacyBaseline {
  const workflow = entryFor(entries, 'workflows');
  const stateEntries = entries
    .filter((entry) => entry.path !== 'workflows')
    .map((entry) => ({
      path: entry.path,
      exists: entry.exists,
      kind: entry.kind,
      digest: entry.digest,
    }));
  return {
    stateDigest: digestCanonicalJson({ version: 1, entries: stateEntries }),
    workflowIndexDigest: digestCanonicalJson({
      version: 1,
      exists: workflow.exists,
      kind: workflow.kind,
      digest: workflow.digest,
    }),
  };
}

function entryFor(
  entries: LegacyAuthorityEntry[],
  pathName: LegacyAuthorityPath,
): LegacyAuthorityEntry {
  const entry = entries.find((candidate) => candidate.path === pathName);
  if (entry === undefined) {
    throw new Error(`legacy authority entry is missing: ${pathName}`);
  }
  return entry;
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = left.replaceAll('\\', '/');
  const normalizedRight = right.replaceAll('\\', '/');
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function sha256(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

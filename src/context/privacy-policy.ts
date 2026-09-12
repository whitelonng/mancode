import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RULE_IDS, RULESET_VERSION } from '../privacy/rules.js';
import { parseProjectConfig } from '../team/policy.js';
import { digestCanonicalJson } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import { type SchemaManifest, parseSchemaManifest } from './manifest.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export const PRIVACY_MIN_VERSION = '0.6.5';
export const PRIVACY_POLICY_FILE = 'shared/context/privacy-policy.json';
export const PRIVACY_EXCLUSIONS_FILE = 'shared/context/privacy-exclusions.json';

export interface PrivacyExclusionV1 {
  kind: 'confirmed_decision' | 'checkpoint';
  relativePath: string;
  /** Digest of the existing immutable entity, never a sensitive substring. */
  entityDigest: string;
}

export interface PrivacyExclusionsV1 {
  schemaVersion: 1;
  revision: number;
  workspaceId: Ulid;
  entries: PrivacyExclusionV1[];
  lastOperationId: Ulid;
  updatedAt: string;
}

export interface PrivacyPolicyV1 {
  schemaVersion: 1;
  revision: number;
  workspaceId: Ulid;
  enabled: boolean;
  rulesetVersion: string;
  enabledRuleIds: string[];
  targets: ['shared_write', 'context_output'];
  exclusions: { revision: number; digest: string };
  lastOperationId: Ulid;
  updatedAt: string;
}

export interface PrivacyPolicyCandidate {
  schemaVersion: 1;
  enabled: boolean;
  rulesetVersion: string;
  enabledRuleIds: string[];
}

export interface PrivacyPolicySnapshot {
  policy: PrivacyPolicyV1;
  exclusions: PrivacyExclusionsV1;
  digest: string;
}

export function parsePrivacyPolicyCandidate(
  value: unknown,
): PrivacyPolicyCandidate {
  assertRecord(value, 'privacy policy candidate');
  assertKnownKeys(
    value,
    ['schemaVersion', 'enabled', 'rulesetVersion', 'enabledRuleIds'],
    'privacy policy candidate',
  );
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean')
    throw new Error('MANCODE_PRIVACY_POLICY_INVALID');
  if (value.rulesetVersion !== RULESET_VERSION)
    throw new Error('MANCODE_PRIVACY_RULESET_UNSUPPORTED');
  if (
    !Array.isArray(value.enabledRuleIds) ||
    value.enabledRuleIds.some(
      (id) => typeof id !== 'string' || !DEFAULT_RULE_IDS.includes(id),
    ) ||
    new Set(value.enabledRuleIds).size !== value.enabledRuleIds.length
  )
    throw new Error('MANCODE_PRIVACY_RULE_UNSUPPORTED');
  if (value.enabled && value.enabledRuleIds.length === 0)
    throw new Error('MANCODE_PRIVACY_EMPTY_RULESET');
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    rulesetVersion: value.rulesetVersion,
    enabledRuleIds: [...value.enabledRuleIds].sort(),
  };
}

export function parsePrivacyPolicy(value: unknown): PrivacyPolicyV1 {
  assertRecord(value, 'privacy policy');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'revision',
      'workspaceId',
      'enabled',
      'rulesetVersion',
      'enabledRuleIds',
      'targets',
      'exclusions',
      'lastOperationId',
      'updatedAt',
    ],
    'privacy policy',
  );
  const candidate = parsePrivacyPolicyCandidate({
    schemaVersion: value.schemaVersion,
    enabled: value.enabled,
    rulesetVersion: value.rulesetVersion,
    enabledRuleIds: value.enabledRuleIds,
  });
  assertUlid(value.workspaceId, 'privacy workspaceId');
  assertUlid(value.lastOperationId, 'privacy lastOperationId');
  if (
    !Array.isArray(value.targets) ||
    value.targets.length !== 2 ||
    value.targets[0] !== 'shared_write' ||
    value.targets[1] !== 'context_output'
  )
    throw new Error('MANCODE_PRIVACY_POLICY_INVALID');
  assertRecord(value.exclusions, 'privacy exclusions reference');
  assertKnownKeys(
    value.exclusions,
    ['revision', 'digest'],
    'privacy exclusions reference',
  );
  return {
    ...candidate,
    revision: revision(value.revision),
    workspaceId: value.workspaceId,
    targets: ['shared_write', 'context_output'],
    exclusions: {
      revision: revision(value.exclusions.revision),
      digest: digest(value.exclusions.digest),
    },
    lastOperationId: value.lastOperationId,
    updatedAt: timestamp(value.updatedAt),
  };
}

export function parsePrivacyExclusions(value: unknown): PrivacyExclusionsV1 {
  assertRecord(value, 'privacy exclusions');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'revision',
      'workspaceId',
      'entries',
      'lastOperationId',
      'updatedAt',
    ],
    'privacy exclusions',
  );
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries))
    throw new Error('MANCODE_PRIVACY_EXCLUSIONS_INVALID');
  assertUlid(value.workspaceId, 'privacy exclusions workspaceId');
  assertUlid(value.lastOperationId, 'privacy exclusions operationId');
  const entries: PrivacyExclusionV1[] = value.entries.map((entry) => {
    assertRecord(entry, 'privacy exclusion');
    assertKnownKeys(
      entry,
      ['kind', 'relativePath', 'entityDigest'],
      'privacy exclusion',
    );
    const ulid = '[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}';
    const pattern =
      entry.kind === 'confirmed_decision'
        ? new RegExp(`^shared/memory/decisions/${ulid}\\.json$`)
        : entry.kind === 'checkpoint'
          ? new RegExp(`^shared/workflows/${ulid}/checkpoints/${ulid}\\.json$`)
          : null;
    if (
      pattern === null ||
      typeof entry.relativePath !== 'string' ||
      !pattern.test(entry.relativePath)
    )
      throw new Error('MANCODE_PRIVACY_EXCLUSION_PATH_INVALID');
    return {
      kind: entry.kind as PrivacyExclusionV1['kind'],
      relativePath: entry.relativePath,
      entityDigest: digest(entry.entityDigest),
    };
  });
  if (
    new Set(entries.map((entry) => entry.relativePath)).size !== entries.length
  )
    throw new Error('MANCODE_PRIVACY_EXCLUSIONS_DUPLICATE');
  return {
    schemaVersion: 1,
    revision: revision(value.revision),
    workspaceId: value.workspaceId,
    entries: entries.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath, 'en'),
    ),
    lastOperationId: value.lastOperationId,
    updatedAt: timestamp(value.updatedAt),
  };
}

export function createInitialPrivacyPolicy(input: {
  workspaceId: Ulid;
  operationId: Ulid;
  now: string;
  enabled?: boolean;
}): PrivacyPolicySnapshot {
  const exclusions = parsePrivacyExclusions({
    schemaVersion: 1,
    revision: 1,
    workspaceId: input.workspaceId,
    entries: [],
    lastOperationId: input.operationId,
    updatedAt: input.now,
  });
  const policy = parsePrivacyPolicy({
    schemaVersion: 1,
    revision: 1,
    workspaceId: input.workspaceId,
    enabled: input.enabled ?? true,
    rulesetVersion: RULESET_VERSION,
    enabledRuleIds: [...DEFAULT_RULE_IDS],
    targets: ['shared_write', 'context_output'],
    exclusions: { revision: 1, digest: digestCanonicalJson(exclusions) },
    lastOperationId: input.operationId,
    updatedAt: input.now,
  });
  return { policy, exclusions, digest: digestCanonicalJson(policy) };
}

export function assertPrivacyPolicyTransition(
  previous: PrivacyPolicyV1 | null,
  next: PrivacyPolicyV1,
): void {
  if (
    next.revision !== (previous?.revision ?? 0) + 1 ||
    (previous !== null &&
      (previous.workspaceId !== next.workspaceId ||
        previous.lastOperationId === next.lastOperationId))
  )
    throw new Error('MANCODE_PRIVACY_POLICY_REVISION_CONFLICT');
}

export function assertPrivacyExclusionsTransition(
  previous: PrivacyExclusionsV1 | null,
  next: PrivacyExclusionsV1,
): void {
  if (
    next.revision !== (previous?.revision ?? 0) + 1 ||
    (previous !== null && previous.workspaceId !== next.workspaceId)
  )
    throw new Error('MANCODE_PRIVACY_POLICY_REVISION_CONFLICT');
  // Exclusions remain effective after disabling rules; dropping one must never re-export historical content.
  if (
    previous?.entries.some(
      (entry) =>
        !next.entries.some(
          (nextEntry) =>
            nextEntry.relativePath === entry.relativePath &&
            nextEntry.entityDigest === entry.entityDigest,
        ),
    )
  )
    throw new Error('MANCODE_PRIVACY_EXCLUSION_REMOVAL_FORBIDDEN');
}

/** Read only the manifest-bound pair. Unreferenced files are never effective. */
export async function readPrivacyPolicySnapshot(
  root: string,
  manifest?: SchemaManifest,
): Promise<PrivacyPolicySnapshot | null> {
  await assertNoPendingPrivacyPolicyOperation(root);
  const current =
    manifest ??
    parseSchemaManifest(
      JSON.parse(await readPrivacyAuthorityFile(root, 'schema.json')),
    );
  if (current.manifestVersion !== 3) return null;
  const [policy, exclusions, config] = await Promise.all([
    readPrivacyAuthorityFile(root, PRIVACY_POLICY_FILE).then((content) =>
      parsePrivacyPolicy(JSON.parse(content)),
    ),
    readPrivacyAuthorityFile(root, PRIVACY_EXCLUSIONS_FILE).then((content) =>
      parsePrivacyExclusions(JSON.parse(content)),
    ),
    readPrivacyAuthorityFile(root, 'shared/config.json').then((content) =>
      parseProjectConfig(JSON.parse(content)),
    ),
  ]);
  const policyDigest = digestCanonicalJson(policy);
  if (policy.workspaceId !== config.workspaceId)
    throw new Error('MANCODE_PRIVACY_POLICY_WORKSPACE_MISMATCH');
  if (
    current.privacyPolicy.revision !== policy.revision ||
    current.privacyPolicy.digest !== policyDigest ||
    policy.workspaceId !== exclusions.workspaceId ||
    policy.exclusions.revision !== exclusions.revision ||
    policy.exclusions.digest !== digestCanonicalJson(exclusions)
  )
    throw new Error('MANCODE_PRIVACY_POLICY_DIGEST_MISMATCH');
  return { policy, exclusions, digest: policyDigest };
}

async function assertNoPendingPrivacyPolicyOperation(
  root: string,
): Promise<void> {
  const relative = 'local/runtime/operations';
  let entries: string[];
  try {
    const directory = path.join(root, '.mancode', relative);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    entries = await readdir(directory);
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return;
    throw error;
  }
  for (const entry of entries) {
    if (!/^[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}\.json$/.test(entry)) continue;
    const journal = JSON.parse(
      await readPrivacyAuthorityFile(root, `${relative}/${entry}`),
    );
    if (
      journal.type === 'privacy_policy_update' &&
      journal.state !== 'committed' &&
      journal.state !== 'aborted'
    )
      throw new Error('MANCODE_PRIVACY_POLICY_REPAIR_REQUIRED');
  }
}

export async function readPrivacyPolicyStatus(root: string) {
  try {
    const snapshot = await readPrivacyPolicySnapshot(root);
    return {
      schemaVersion: 1,
      state:
        snapshot === null
          ? ('unconfigured' as const)
          : snapshot.policy.enabled
            ? ('enabled' as const)
            : ('disabled' as const),
      enabled: snapshot?.policy.enabled ?? false,
      revision: snapshot?.policy.revision ?? 0,
      digest: snapshot?.digest ?? null,
      rulesetVersion: snapshot?.policy.rulesetVersion ?? RULESET_VERSION,
      excludedEntities: snapshot?.exclusions.entries.length ?? 0,
      scope: 'project' as const,
      error: null,
    };
  } catch {
    return {
      schemaVersion: 1,
      state: 'error' as const,
      enabled: null,
      revision: null,
      digest: null,
      rulesetVersion: null,
      excludedEntities: null,
      scope: 'project' as const,
      error: 'MANCODE_PRIVACY_POLICY_UNAVAILABLE',
    };
  }
}

export async function readPrivacyAuthorityFile(
  root: string,
  relative: string,
): Promise<string> {
  let current = path.join(path.resolve(root), '.mancode');
  for (const part of relative.split('/')) {
    const parent = await lstat(current);
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    current = path.join(current, part);
  }
  const stat = await lstat(current);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  return readFile(current, 'utf8');
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error('MANCODE_PRIVACY_POLICY_INVALID');
  return value as number;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error('MANCODE_PRIVACY_POLICY_INVALID');
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('MANCODE_PRIVACY_POLICY_INVALID');
  return value;
}

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { scanSensitiveText } from '../privacy/detect.js';
import type { LocalLockHandle } from '../runtime/local-lock.js';
import type { OperationRecoveryActionV1 } from '../runtime/operation-recovery-payload.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { acquireProjectWriteBarrier } from '../runtime/project-write-barrier.js';
import { digestCanonicalJson } from './canonical.js';
import type { Ulid } from './ids.js';
import {
  PRIVACY_EXCLUSIONS_FILE,
  PRIVACY_POLICY_FILE,
  type PrivacyExclusionV1,
  type PrivacyPolicySnapshot,
  readPrivacyAuthorityFile,
  readPrivacyPolicySnapshot,
} from './privacy-policy.js';

export function containsEnhancedSensitiveText(
  value: unknown,
  ruleIds: readonly string[],
): boolean {
  const stack: Array<[unknown, string?]> = [[value]];
  let visited = 0;
  while (stack.length > 0) {
    if (++visited > 100_000) throw new Error('MANCODE_PRIVACY_SCAN_INCOMPLETE');
    const [item, key] = stack.pop() as [unknown, string?];
    if (typeof item === 'string') {
      // Preserve decoded business-key semantics without rewriting the entity.
      const scan = scanSensitiveText(
        key === undefined || item.length === 0 ? item : `${key}: ${item}`,
        ruleIds,
      );
      if (scan.status !== 'complete')
        throw new Error('MANCODE_PRIVACY_SCAN_INCOMPLETE');
      if (scan.findings.length > 0) return true;
    } else if (Array.isArray(item)) {
      stack.push(...item.map((content): [unknown, string?] => [content, key]));
    } else if (item !== null && typeof item === 'object') {
      for (const [key, content] of Object.entries(item))
        stack.push([key], [content, key]);
    }
  }
  return false;
}

export function isPrivacyExcluded(
  snapshot: PrivacyPolicySnapshot | null | undefined,
  value: unknown,
): boolean {
  if (
    snapshot === null ||
    snapshot === undefined ||
    snapshot.exclusions.entries.length === 0
  )
    return false;
  const entityDigest = digestCanonicalJson(value);
  return snapshot.exclusions.entries.some(
    (entry) => entry.entityDigest === entityDigest,
  );
}

export function assertPrivacyValueAllowed(
  snapshot: PrivacyPolicySnapshot | null | undefined,
  value: unknown,
): void {
  if (isPrivacyExcluded(snapshot, value))
    throw new Error('MANCODE_PRIVACY_ENTITY_EXCLUDED');
  if (
    snapshot?.policy.enabled &&
    containsEnhancedSensitiveText(value, snapshot.policy.enabledRuleIds)
  )
    throw new Error('MANCODE_PRIVACY_BLOCKED');
}

export async function assertSharedPrivacyValue(
  root: string,
  value: unknown,
): Promise<void> {
  assertPrivacyValueAllowed(await readSharedPrivacySnapshot(root), value);
}

/** Existing standalone entity helpers remain usable before a V3 project exists. */
async function readSharedPrivacySnapshot(
  root: string,
): Promise<PrivacyPolicySnapshot | null> {
  if (!(await hasProjectAuthority(root))) return null;
  return readPrivacyPolicySnapshot(root);
}

export async function acquireSharedPrivacyWriteBarrier(
  root: string,
  operationId: Ulid,
): Promise<LocalLockHandle | null> {
  if (!(await hasProjectAuthority(root))) return null;
  const runtime = await readProjectRuntimeContext(root);
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      return await acquireProjectWriteBarrier(runtime, operationId, new Date());
    } catch (error) {
      // Independent shared entities may contend on this project-wide barrier.
      // Only wait for acquisition; policy checks and entity CAS are never retried.
      if (
        !(error instanceof Error) ||
        error.message !== 'MANCODE_LOCK_HELD' ||
        performance.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function withSharedPrivacyWrite<T>(
  root: string,
  operationId: Ulid,
  value: unknown,
  write: () => Promise<T>,
): Promise<T> {
  await assertSharedPrivacyValue(root, value);
  const barrier = await acquireSharedPrivacyWriteBarrier(root, operationId);
  try {
    await assertSharedPrivacyValue(root, value);
    return await write();
  } finally {
    await barrier?.release();
  }
}

export async function assertSharedTaskWriteAtRoot(
  taskRoot: string,
  fileName: string,
  content: string,
): Promise<void> {
  const workflows = path.dirname(taskRoot);
  const shared = path.dirname(workflows);
  const authority = path.dirname(shared);
  if (
    path.basename(workflows) !== 'workflows' ||
    path.basename(shared) !== 'shared' ||
    path.basename(authority) !== '.mancode'
  )
    return;
  await assertSharedPrivacyValue(
    path.dirname(authority),
    privacyContentValue(fileName, content),
  );
}

/** All values a journal may publish are checked before that journal becomes durable. */
export function assertPrivacyRecoveryActionsAllowed(
  snapshot: PrivacyPolicySnapshot | null | undefined,
  actions: readonly OperationRecoveryActionV1[],
): void {
  for (const action of actions) {
    switch (action.kind) {
      case 'task_authority_file':
        if (action.taskRef.namespace === 'shared')
          assertPrivacyValueAllowed(
            snapshot,
            privacyContentValue(action.fileName, action.targetContent),
          );
        break;
      case 'workflow_task_directory':
      case 'migration_task_directory':
        if (action.taskRef.namespace === 'shared') {
          for (const file of action.files)
            assertPrivacyValueAllowed(
              snapshot,
              privacyContentValue(file.fileName, file.content),
            );
          if (action.kind === 'migration_task_directory')
            for (const report of action.reports)
              assertPrivacyValueAllowed(snapshot, report.content);
        }
        break;
      case 'task_archive':
        if (action.taskRef.namespace === 'shared') {
          assertPrivacyValueAllowed(
            snapshot,
            privacyContentValue(
              'requirements.json',
              action.requirementsContent,
            ),
          );
          if (action.planContent !== null)
            assertPrivacyValueAllowed(snapshot, action.planContent);
        }
        break;
      case 'checkpoint':
        if (action.checkpoint.taskRef.namespace === 'shared')
          assertPrivacyValueAllowed(snapshot, action.checkpoint);
        break;
      case 'claim':
        if (action.claim.taskRef.namespace === 'shared')
          assertPrivacyValueAllowed(snapshot, action.claim);
        break;
      case 'handoff':
        if (action.handoff.taskRef.namespace === 'shared')
          assertPrivacyValueAllowed(snapshot, action.handoff);
        break;
      default:
        break;
    }
  }
}

async function hasProjectAuthority(root: string): Promise<boolean> {
  try {
    const stat = await lstat(path.join(root, '.mancode', 'schema.json'));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    return true;
  } catch (error) {
    if (
      error === null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    try {
      await lstat(path.join(root, '.mancode', 'shared', 'config.json'));
    } catch (configError) {
      if (
        configError !== null &&
        typeof configError === 'object' &&
        'code' in configError &&
        configError.code === 'ENOENT'
      )
        return false;
      throw configError;
    }
    throw new Error('MANCODE_PRIVACY_POLICY_UNAVAILABLE');
  }
}

export function privacyContentValue(
  fileName: string,
  content: string,
): unknown {
  if (!fileName.endsWith('.json')) return content;
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('MANCODE_PRIVACY_SHARED_JSON_INVALID');
  }
}

export interface PrivacyActivationScan {
  fingerprint: string;
  scannedFiles: number;
  blockers: Array<{
    fileIndex: number;
    reason: 'sensitive_content' | 'invalid_json';
  }>;
  exclusions: PrivacyExclusionV1[];
}

/** Inventory is recomputed under the project write barrier before journaling. */
export async function scanPrivacyActivation(
  root: string,
  ruleIds: readonly string[],
): Promise<PrivacyActivationScan> {
  const files = await collectSharedFiles(root, 'shared');
  const digests: Array<{ path: string; digest: string }> = [];
  const blockers: PrivacyActivationScan['blockers'] = [];
  const exclusions: PrivacyExclusionV1[] = [];
  let scannedFiles = 0;
  for (const relative of files) {
    if (
      relative === PRIVACY_POLICY_FILE ||
      relative === PRIVACY_EXCLUSIONS_FILE
    )
      continue;
    const content = await readPrivacyAuthorityFile(root, relative);
    digests.push({ path: relative, digest: digestCanonicalJson(content) });
    const fileIndex = scannedFiles++;
    let value: unknown;
    try {
      value = privacyContentValue(relative, content);
    } catch {
      blockers.push({ fileIndex, reason: 'invalid_json' });
      continue;
    }
    if (!containsEnhancedSensitiveText(value, ruleIds)) continue;
    const ulid = '[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}';
    const kind = new RegExp(`^shared/memory/decisions/${ulid}\\.json$`).test(
      relative,
    )
      ? ('confirmed_decision' as const)
      : new RegExp(
            `^shared/workflows/${ulid}/checkpoints/${ulid}\\.json$`,
          ).test(relative)
        ? ('checkpoint' as const)
        : null;
    if (kind !== null)
      exclusions.push({
        kind,
        relativePath: relative,
        entityDigest: digestCanonicalJson(value),
      });
    else blockers.push({ fileIndex, reason: 'sensitive_content' });
  }
  return {
    fingerprint: digestCanonicalJson(digests),
    scannedFiles,
    blockers,
    exclusions,
  };
}

async function collectSharedFiles(
  root: string,
  relative: string,
): Promise<string[]> {
  const target = path.join(root, '.mancode', relative);
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  const files: string[] = [];
  for (const entry of (await readdir(target, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, 'en'),
  )) {
    if (entry.isSymbolicLink()) throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory())
      files.push(...(await collectSharedFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    if (files.length > 100_000)
      throw new Error('MANCODE_PRIVACY_SCAN_INCOMPLETE');
  }
  return files;
}

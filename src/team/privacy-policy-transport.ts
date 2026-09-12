import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import {
  containsEnhancedSensitiveText,
  isPrivacyExcluded,
} from '../context/privacy-guard.js';
import {
  type PrivacyPolicyCandidate,
  type PrivacyPolicySnapshot,
  assertPrivacyExclusionsTransition,
  assertPrivacyPolicyTransition,
  parsePrivacyPolicyCandidate,
  readPrivacyAuthorityFile,
} from '../context/privacy-policy.js';
import type { StoredProjectSnapshot } from '../context/store.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  GitRefTeamManifestStore,
  type GitRefTeamManifestV1,
  assertGitRefManifestPrivacyAllowed,
  assertGitRefPrivacyReference,
  parseGitRefPrivacyPolicySnapshot,
  resolveGitRefRemoteIdentityHash,
} from './git-ref-transport.js';
import {
  type ProjectConfigV1,
  parseProjectConfig,
  projectConfigDigest,
} from './policy.js';

/** Durable remote CAS intent. No remote URL, credentials, or input body is saved. */
export interface GitRefPrivacyPolicyUpdateV1 {
  schemaVersion: 1;
  operationId: Ulid;
  actorId: Ulid;
  workspaceId: Ulid;
  schemaEpoch: Ulid;
  transportEpoch: number;
  configRevision: number;
  configDigest: string;
  remoteIdentityHash: string;
  expectedRemoteRevision: number;
  beforePrivacyPolicy: { revision: number; digest: string } | null;
  targetPrivacyPolicy: PrivacyPolicySnapshot;
}

export interface GitRefPrivacyActivationPreview {
  revision: number;
  scannedEntities: number;
  blockers: Array<{
    entityType:
      | 'actor_profile'
      | 'claim'
      | 'handoff'
      | 'checkpoint'
      | 'task_artifact'
      | 'code_ref';
    count: number;
    reason: 'sensitive_content' | 'excluded_history';
    remediation:
      | 'retain_basic_or_new_workspace'
      | 'replace_checkpoint_and_sync'
      | 'replace_safe_content_and_sync';
  }>;
}

/** Read-only remote impact summary. Entity bodies, identifiers and paths stay private. */
export async function previewRemotePrivacyPolicyUpdate(
  root: string,
  project: Pick<StoredProjectSnapshot, 'config' | 'manifest' | 'privacy'>,
  candidate: PrivacyPolicyCandidate,
): Promise<GitRefPrivacyActivationPreview | null> {
  if (project.config.transport.mode !== 'git-ref') return null;
  const remote = project.config.transport.remote;
  if (remote === null) throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  const transport = new GitRefTeamManifestStore({
    projectRoot: root,
    remote,
    workspaceId: project.config.workspaceId,
    schemaEpoch: project.manifest.epoch,
    transportEpoch: project.config.transport.epoch,
    configRevision: project.config.revision,
    configDigest: projectConfigDigest(project.config),
  });
  const manifest = (await transport.inspectPrivacyPolicyAuthority()).manifest;
  if (manifest === null || manifest.authorityState !== 'active')
    throw new Error('MANCODE_TRANSPORT_AUTHORITY_NOT_ACTIVE');
  assertGitRefPrivacyReference(
    manifest.privacyPolicy ?? null,
    project.privacy
      ? {
          revision: project.privacy.policy.revision,
          digest: project.privacy.digest,
        }
      : null,
  );
  return inspectGitRefPrivacyActivation(manifest, candidate);
}

export function inspectGitRefPrivacyActivation(
  manifest: GitRefTeamManifestV1,
  value: PrivacyPolicyCandidate,
): GitRefPrivacyActivationPreview {
  const candidate = parsePrivacyPolicyCandidate(value);
  const blockers = new Map<
    string,
    GitRefPrivacyActivationPreview['blockers'][number]
  >();
  let scannedEntities = 0;
  const scan = (
    entityType: GitRefPrivacyActivationPreview['blockers'][number]['entityType'],
    content: unknown,
  ) => {
    scannedEntities += 1;
    const reason = isPrivacyExcluded(manifest.privacyPolicy, content)
      ? 'excluded_history'
      : candidate.enabled &&
          containsEnhancedSensitiveText(content, candidate.enabledRuleIds)
        ? 'sensitive_content'
        : null;
    if (reason === null) return;
    const key = `${entityType}:${reason}`;
    const existing = blockers.get(key);
    if (existing) existing.count += 1;
    else
      blockers.set(key, {
        entityType,
        count: 1,
        reason,
        remediation: ['actor_profile', 'claim', 'handoff'].includes(entityType)
          ? 'retain_basic_or_new_workspace'
          : entityType === 'checkpoint'
            ? 'replace_checkpoint_and_sync'
            : 'replace_safe_content_and_sync',
      });
  };
  for (const profile of manifest.actorProfiles) scan('actor_profile', profile);
  for (const claim of manifest.claims) scan('claim', claim);
  for (const handoff of manifest.handoffs) scan('handoff', handoff);
  for (const bundle of manifest.taskBundles) {
    scan('code_ref', bundle.codeRef);
    for (const artifact of bundle.artifacts)
      scan(
        artifact.kind === 'checkpoint' ? 'checkpoint' : 'task_artifact',
        artifact.content,
      );
  }
  return {
    revision: manifest.revision,
    scannedEntities,
    blockers: [...blockers.values()],
  };
}

export function parseGitRefPrivacyPolicyUpdate(
  value: unknown,
): GitRefPrivacyPolicyUpdateV1 {
  assertRecord(value, 'remote privacy update');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'actorId',
      'workspaceId',
      'schemaEpoch',
      'transportEpoch',
      'configRevision',
      'configDigest',
      'remoteIdentityHash',
      'expectedRemoteRevision',
      'beforePrivacyPolicy',
      'targetPrivacyPolicy',
    ],
    'remote privacy update',
  );
  if (value.schemaVersion !== 1)
    throw new Error('MANCODE_PRIVACY_REMOTE_INTENT_INVALID');
  assertUlid(value.operationId, 'remote privacy operationId');
  assertUlid(value.actorId, 'remote privacy actorId');
  assertUlid(value.workspaceId, 'remote privacy workspaceId');
  assertUlid(value.schemaEpoch, 'remote privacy schemaEpoch');
  for (const key of [
    'transportEpoch',
    'configRevision',
    'expectedRemoteRevision',
  ] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1)
      throw new Error('MANCODE_PRIVACY_REMOTE_INTENT_INVALID');
  }
  for (const key of ['configDigest', 'remoteIdentityHash'] as const) {
    if (
      typeof value[key] !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(value[key])
    )
      throw new Error('MANCODE_PRIVACY_REMOTE_INTENT_INVALID');
  }
  let beforePrivacyPolicy: GitRefPrivacyPolicyUpdateV1['beforePrivacyPolicy'] =
    null;
  if (value.beforePrivacyPolicy !== null) {
    assertRecord(value.beforePrivacyPolicy, 'remote privacy predecessor');
    assertKnownKeys(
      value.beforePrivacyPolicy,
      ['revision', 'digest'],
      'remote privacy predecessor',
    );
    if (
      !Number.isSafeInteger(value.beforePrivacyPolicy.revision) ||
      Number(value.beforePrivacyPolicy.revision) < 1 ||
      typeof value.beforePrivacyPolicy.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(value.beforePrivacyPolicy.digest)
    )
      throw new Error('MANCODE_PRIVACY_REMOTE_INTENT_INVALID');
    beforePrivacyPolicy = {
      revision: Number(value.beforePrivacyPolicy.revision),
      digest: value.beforePrivacyPolicy.digest,
    };
  }
  const targetPrivacyPolicy = parseGitRefPrivacyPolicySnapshot(
    value.targetPrivacyPolicy,
    value.workspaceId,
  );
  if (
    targetPrivacyPolicy.policy.revision !==
      (beforePrivacyPolicy?.revision ?? 0) + 1 ||
    targetPrivacyPolicy.policy.lastOperationId !== value.operationId ||
    targetPrivacyPolicy.exclusions.lastOperationId !== value.operationId
  )
    throw new Error('MANCODE_PRIVACY_REMOTE_INTENT_INVALID');
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    actorId: value.actorId,
    workspaceId: value.workspaceId,
    schemaEpoch: value.schemaEpoch,
    transportEpoch: Number(value.transportEpoch),
    configRevision: Number(value.configRevision),
    configDigest: String(value.configDigest),
    remoteIdentityHash: String(value.remoteIdentityHash),
    expectedRemoteRevision: Number(value.expectedRemoteRevision),
    beforePrivacyPolicy,
    targetPrivacyPolicy,
  };
}

/** Called while the project schema lock is held, before saving the journal. */
export async function prepareRemotePrivacyPolicyUpdate(
  root: string,
  project: Pick<StoredProjectSnapshot, 'config' | 'manifest' | 'privacy'>,
  target: PrivacyPolicySnapshot,
  operationId: Ulid,
  actorId: Ulid,
): Promise<GitRefPrivacyPolicyUpdateV1 | null> {
  if (project.config.transport.mode !== 'git-ref') return null;
  const remote = project.config.transport.remote;
  if (remote === null) throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  const transport = new GitRefTeamManifestStore({
    projectRoot: root,
    remote,
    workspaceId: project.config.workspaceId,
    schemaEpoch: project.manifest.epoch,
    transportEpoch: project.config.transport.epoch,
    configRevision: project.config.revision,
    configDigest: projectConfigDigest(project.config),
  });
  const snapshot = await transport.inspectPrivacyPolicyAuthority();
  const manifest = snapshot.manifest;
  if (manifest === null || manifest.authorityState !== 'active')
    throw new Error('MANCODE_TRANSPORT_AUTHORITY_NOT_ACTIVE');
  if (!manifest.actorProfiles.some((profile) => profile.actorId === actorId))
    throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_JOINED');
  const beforePrivacyPolicy =
    project.privacy === null || project.privacy === undefined
      ? null
      : {
          revision: project.privacy.policy.revision,
          digest: project.privacy.digest,
        };
  assertGitRefPrivacyReference(
    manifest.privacyPolicy ?? null,
    beforePrivacyPolicy,
  );
  assertPrivacyPolicyTransition(
    manifest.privacyPolicy?.policy ?? null,
    target.policy,
  );
  assertPrivacyExclusionsTransition(
    manifest.privacyPolicy?.exclusions ?? null,
    target.exclusions,
  );
  assertGitRefManifestPrivacyAllowed(manifest, target);
  return parseGitRefPrivacyPolicyUpdate({
    schemaVersion: 1,
    operationId,
    actorId,
    workspaceId: project.config.workspaceId,
    schemaEpoch: project.manifest.epoch,
    transportEpoch: project.config.transport.epoch,
    configRevision: project.config.revision,
    configDigest: projectConfigDigest(project.config),
    remoteIdentityHash: await resolveGitRefRemoteIdentityHash(root, remote),
    expectedRemoteRevision: manifest.revision,
    beforePrivacyPolicy,
    targetPrivacyPolicy: target,
  });
}

export async function inspectRemotePrivacyPolicyUpdate(
  root: string,
  value: GitRefPrivacyPolicyUpdateV1,
): Promise<'before' | 'target' | 'conflict'> {
  const update = parseGitRefPrivacyPolicyUpdate(value);
  const transport = await transportForIntent(root, update);
  const current = (await transport.inspectPrivacyPolicyAuthority()).manifest;
  if (current === null || current.authorityState !== 'active')
    return 'conflict';
  if (
    current.privacyPolicy?.digest === update.targetPrivacyPolicy.digest &&
    current.privacyPolicy.policy.lastOperationId === update.operationId
  )
    return 'target';
  if (
    current.revision !== update.expectedRemoteRevision ||
    digestCanonicalJson(
      current.privacyPolicy === undefined
        ? null
        : {
            revision: current.privacyPolicy.policy.revision,
            digest: current.privacyPolicy.digest,
          },
    ) !== digestCanonicalJson(update.beforePrivacyPolicy)
  )
    return 'conflict';
  return 'before';
}

/** CAS failure can be ambiguous; callers must inspect before deciding to abort. */
export async function applyRemotePrivacyPolicyUpdate(
  root: string,
  value: GitRefPrivacyPolicyUpdateV1,
): Promise<void> {
  const update = parseGitRefPrivacyPolicyUpdate(value);
  const transport = await transportForIntent(root, update);
  await transport.updatePrivacyPolicy(update);
  if ((await inspectRemotePrivacyPolicyUpdate(root, update)) !== 'target')
    throw new Error('MANCODE_PRIVACY_REMOTE_POLICY_CHANGED');
}

async function transportForIntent(
  root: string,
  update: GitRefPrivacyPolicyUpdateV1,
): Promise<GitRefTeamManifestStore> {
  const config: ProjectConfigV1 = parseProjectConfig(
    JSON.parse(await readPrivacyAuthorityFile(root, 'shared/config.json')),
  );
  if (
    config.workspaceId !== update.workspaceId ||
    config.transport.mode !== 'git-ref' ||
    config.transport.remote === null ||
    projectConfigDigest(config) !== update.configDigest ||
    config.revision !== update.configRevision ||
    config.transport.epoch !== update.transportEpoch ||
    (await resolveGitRefRemoteIdentityHash(root, config.transport.remote)) !==
      update.remoteIdentityHash
  )
    throw new Error('MANCODE_PRIVACY_REMOTE_CONFIG_CHANGED');
  return new GitRefTeamManifestStore({
    projectRoot: root,
    remote: config.transport.remote,
    workspaceId: update.workspaceId,
    schemaEpoch: update.schemaEpoch,
    transportEpoch: update.transportEpoch,
    configRevision: update.configRevision,
    configDigest: update.configDigest,
  });
}

import { lstat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectV3AdapterVersions } from '../installers/v3-adapter.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { resolveLocalEntityHomeStore } from '../runtime/entity-home-store.js';
import { acquireOperationEntityLocks } from '../runtime/local-lock.js';
import { throwIfOperationCrashInjected } from '../runtime/operation-crash-injection.js';
import {
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from '../runtime/operation-definition.js';
import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import {
  executeOperationRecovery,
  listUnfinishedOperationRecoveries,
} from '../runtime/operation-recovery-executor.js';
import {
  assertOperationRecoveryPayloadCoversJournal,
  createPrivacyRemotePolicyRecoveryAction,
  createProjectAuthorityFileRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../runtime/operation-recovery-payload.js';
import {
  readOperationRecoveryPayload,
  writeOperationRecoveryPayload,
} from '../runtime/operation-recovery-store.js';
import {
  createPreparedOperationJournal,
  readOperationJournal,
  updateOperationJournal,
} from '../runtime/operation-store.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { PROJECT_SCHEMA_LOCK } from '../runtime/project-write-barrier.js';
import { readSession } from '../runtime/session.js';
import { createAuthorizationBasis } from '../team/authorization.js';
import {
  applyRemotePrivacyPolicyUpdate,
  prepareRemotePrivacyPolicyUpdate,
  previewRemotePrivacyPolicyUpdate,
} from '../team/privacy-policy-transport.js';
import { VERSION } from '../version.js';
import { digestCanonicalJson } from './canonical.js';
import {
  CURRENT_WRITER_CAPABILITIES,
  assertCompatibilityGate,
  compareSemver,
} from './compatibility.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { scanLegacyAuthority } from './layout.js';
import {
  assertSchemaManifestPrivacyTransition,
  managedAdapterNames,
  parseSchemaManifest,
} from './manifest.js';
import { scanPrivacyActivation } from './privacy-guard.js';
import {
  PRIVACY_EXCLUSIONS_FILE,
  PRIVACY_MIN_VERSION,
  PRIVACY_POLICY_FILE,
  type PrivacyPolicyCandidate,
  assertPrivacyExclusionsTransition,
  assertPrivacyPolicyTransition,
  parsePrivacyExclusions,
  parsePrivacyPolicy,
  parsePrivacyPolicyCandidate,
  readPrivacyAuthorityFile,
  readPrivacyPolicySnapshot,
} from './privacy-policy.js';
import { V3ContextStore } from './store.js';

const OPERATION = 'privacy_policy_update' as const;

export async function readPrivacyPolicyOperationTarget(
  root: string,
  operationId: Ulid,
) {
  const runtime = await readProjectRuntimeContext(root);
  const store = resolveLocalEntityHomeStore(runtime.entityHomeStoreContext);
  const journal = await readOperationJournal(store, operationId);
  if (journal === null) return null;
  if (journal.type !== OPERATION)
    throw new Error('MANCODE_OPERATION_JOURNAL_CONFLICT');
  const payload = await readOperationRecoveryPayload(store, operationId);
  const action = payload?.actions.find(
    (item) =>
      item.kind === 'project_authority_file' &&
      item.fileName === PRIVACY_POLICY_FILE,
  );
  if (
    payload === null ||
    operationRecoveryPayloadDigest(payload) !== journal.recoveryPayloadDigest ||
    action?.kind !== 'project_authority_file'
  )
    throw new Error('MANCODE_OPERATION_JOURNAL_CONFLICT');
  const policy = parsePrivacyPolicy(JSON.parse(action.targetContent));
  return {
    candidate: parsePrivacyPolicyCandidate({
      schemaVersion: policy.schemaVersion,
      enabled: policy.enabled,
      rulesetVersion: policy.rulesetVersion,
      enabledRuleIds: policy.enabledRuleIds,
    }),
    expectedRevision: policy.revision - 1,
  };
}

export interface PrivacyPolicyUpdateInput {
  projectRoot: string;
  candidate: PrivacyPolicyCandidate;
  expectedRevision: number;
  sessionId: Ulid;
  operationId?: Ulid;
  now?: Date;
}

export async function previewPrivacyPolicyUpdate(
  input: Pick<
    PrivacyPolicyUpdateInput,
    'projectRoot' | 'candidate' | 'expectedRevision'
  >,
) {
  const candidate = parsePrivacyPolicyCandidate(input.candidate);
  const project = await new V3ContextStore(
    input.projectRoot,
  ).readProjectSnapshot();
  assertExpectedRevision(
    input.expectedRevision,
    project.privacy?.policy.revision ?? 0,
  );
  const scan = candidate.enabled
    ? await scanPrivacyActivation(input.projectRoot, candidate.enabledRuleIds)
    : null;
  const unchanged = project.privacy === null && !candidate.enabled;
  const remote = unchanged
    ? null
    : await previewRemotePrivacyPolicyUpdate(
        input.projectRoot,
        project,
        candidate,
      );
  const blockerCount =
    (scan?.blockers.length ?? 0) +
    (remote?.blockers.reduce((count, blocker) => count + blocker.count, 0) ??
      0);
  return {
    schemaVersion: 1,
    expectedRevision: input.expectedRevision,
    targetRevision: unchanged ? 0 : input.expectedRevision + 1,
    state: unchanged ? 'unchanged' : blockerCount > 0 ? 'blocked' : 'preview',
    enabled: candidate.enabled,
    rulesetVersion: candidate.rulesetVersion,
    rules: candidate.enabledRuleIds,
    scannedFiles: scan?.scannedFiles ?? 0,
    excludedEntities: scan?.exclusions.length ?? 0,
    blockers: scan?.blockers ?? [],
    remote,
    blocked: blockerCount > 0,
    blockerCount,
    minimumVersion: unchanged
      ? project.manifest.minWriterVersion
      : PRIVACY_MIN_VERSION,
    preservesHistoricalContent: true,
    formatDowngradeOnDisable: false,
  };
}

/** Candidate files never become authority until this CAS operation commits. */
export async function updatePrivacyPolicy(input: PrivacyPolicyUpdateInput) {
  const root = path.resolve(input.projectRoot);
  const candidate = parsePrivacyPolicyCandidate(input.candidate);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'privacy operationId');
  assertUlid(input.sessionId, 'privacy sessionId');
  const runtime = await readProjectRuntimeContext(root);
  const localStore = resolveLocalEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const session = await readSession(root, input.sessionId);
  if (session === null || session.status !== 'active')
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  const previousJournal = await readOperationJournal(localStore, operationId);
  if (previousJournal !== null) {
    if (
      previousJournal.type !== OPERATION ||
      previousJournal.actorId !== session.actorId ||
      previousJournal.sessionId !== session.sessionId
    )
      throw new Error('MANCODE_OPERATION_JOURNAL_CONFLICT');
    const payload = await readOperationRecoveryPayload(localStore, operationId);
    const policyAction = payload?.actions.find(
      (action) =>
        action.kind === 'project_authority_file' &&
        action.fileName === PRIVACY_POLICY_FILE,
    );
    if (
      payload === null ||
      operationRecoveryPayloadDigest(payload) !==
        previousJournal.recoveryPayloadDigest ||
      policyAction?.kind !== 'project_authority_file'
    )
      throw new Error('MANCODE_OPERATION_JOURNAL_CONFLICT');
    const originalPolicy = parsePrivacyPolicy(
      JSON.parse(policyAction.targetContent),
    );
    if (
      input.expectedRevision !== originalPolicy.revision - 1 ||
      digestCanonicalJson(candidate) !==
        digestCanonicalJson({
          schemaVersion: originalPolicy.schemaVersion,
          enabled: originalPolicy.enabled,
          rulesetVersion: originalPolicy.rulesetVersion,
          enabledRuleIds: originalPolicy.enabledRuleIds,
        })
    )
      throw new Error('MANCODE_OPERATION_JOURNAL_CONFLICT');
    const recovered = await executeOperationRecovery({
      projectRoot: root,
      operationId,
      actorId: session.actorId,
      sessionId: session.sessionId,
      now,
    });
    if (recovered.journal.state !== 'committed')
      throw new Error(
        recovered.journal.state === 'aborted'
          ? 'MANCODE_PRIVACY_OPERATION_ABORTED'
          : 'MANCODE_OPERATION_REPAIR_REQUIRED',
      );
    return {
      state: 'committed' as const,
      operationId,
      snapshot: await readPrivacyPolicySnapshot(root),
    };
  }
  const store = new V3ContextStore(root);
  const initial = await store.readProjectSnapshot();
  assertExpectedRevision(
    input.expectedRevision,
    initial.privacy?.policy.revision ?? 0,
  );
  if (initial.privacy === null && !candidate.enabled)
    return { state: 'unchanged' as const, operationId: null, snapshot: null };
  await assertPreflight(root, initial);
  const beforeScan = candidate.enabled
    ? await scanPrivacyActivation(root, candidate.enabledRuleIds)
    : null;
  if (beforeScan?.blockers.length)
    throw new Error('MANCODE_PRIVACY_ACTIVATION_BLOCKED');
  const locks = await acquireOperationEntityLocks(
    operationId,
    [{ store: localStore, entityLockKeys: [PROJECT_SCHEMA_LOCK] }],
    { now },
  );
  let journal: OperationJournalV1 | null = null;
  let visible = false;
  let remoteAttempted = false;
  try {
    const project = await store.readProjectSnapshot();
    assertExpectedRevision(
      input.expectedRevision,
      project.privacy?.policy.revision ?? 0,
    );
    await assertPreflight(root, project);
    if (project.fingerprint !== initial.fingerprint)
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    const scan = candidate.enabled
      ? await scanPrivacyActivation(root, candidate.enabledRuleIds)
      : null;
    if (scan?.fingerprint !== beforeScan?.fingerprint)
      throw new Error('MANCODE_PRIVACY_BASELINE_CHANGED');
    if (scan?.blockers.length)
      throw new Error('MANCODE_PRIVACY_ACTIVATION_BLOCKED');
    const old = project.privacy ?? null;
    if (
      old !== null &&
      digestCanonicalJson({
        schemaVersion: old.policy.schemaVersion,
        enabled: old.policy.enabled,
        rulesetVersion: old.policy.rulesetVersion,
        enabledRuleIds: old.policy.enabledRuleIds,
      }) === digestCanonicalJson(candidate) &&
      (scan?.exclusions ?? []).every((entry) =>
        old.exclusions.entries.some(
          (previous) =>
            previous.relativePath === entry.relativePath &&
            previous.entityDigest === entry.entityDigest,
        ),
      )
    )
      return { state: 'unchanged' as const, operationId: null, snapshot: old };
    const merged = new Map(
      (old?.exclusions.entries ?? []).map((entry) => [
        entry.relativePath,
        entry,
      ]),
    );
    for (const entry of scan?.exclusions ?? []) {
      const previous = merged.get(entry.relativePath);
      if (
        previous !== undefined &&
        previous.entityDigest !== entry.entityDigest
      )
        throw new Error('MANCODE_PRIVACY_EXCLUDED_ENTITY_CHANGED');
      merged.set(entry.relativePath, entry);
    }
    const exclusions = parsePrivacyExclusions({
      schemaVersion: 1,
      revision: (old?.exclusions.revision ?? 0) + 1,
      workspaceId: project.config.workspaceId,
      entries: [...merged.values()],
      lastOperationId: operationId,
      updatedAt: now.toISOString(),
    });
    const policy = parsePrivacyPolicy({
      ...candidate,
      revision: input.expectedRevision + 1,
      workspaceId: project.config.workspaceId,
      targets: ['shared_write', 'context_output'],
      exclusions: {
        revision: exclusions.revision,
        digest: digestCanonicalJson(exclusions),
      },
      lastOperationId: operationId,
      updatedAt: now.toISOString(),
    });
    assertPrivacyExclusionsTransition(old?.exclusions ?? null, exclusions);
    assertPrivacyPolicyTransition(old?.policy ?? null, policy);
    const targetManifest = parseSchemaManifest({
      ...project.manifest,
      manifestVersion: 3,
      minReaderVersion: maxVersion(
        project.manifest.minReaderVersion,
        PRIVACY_MIN_VERSION,
      ),
      minWriterVersion: maxVersion(
        project.manifest.minWriterVersion,
        PRIVACY_MIN_VERSION,
      ),
      workflowPolicyDefaults:
        project.manifest.manifestVersion === 1
          ? { planning: 1 }
          : project.manifest.workflowPolicyDefaults,
      privacyPolicy: {
        revision: policy.revision,
        digest: digestCanonicalJson(policy),
      },
      lastOperationId: operationId,
    });
    assertSchemaManifestPrivacyTransition(project.manifest, targetManifest);
    const targets = [
      {
        fileName: PRIVACY_EXCLUSIONS_FILE,
        stepId: 'write-exclusions',
        value: exclusions,
      },
      { fileName: PRIVACY_POLICY_FILE, stepId: 'write-policy', value: policy },
      {
        fileName: 'schema.json' as const,
        stepId: 'write-manifest',
        value: targetManifest,
      },
    ] as const;
    const remoteUpdate = await prepareRemotePrivacyPolicyUpdate(
      root,
      project,
      { policy, exclusions, digest: digestCanonicalJson(policy) },
      operationId,
      session.actorId,
    );
    await Promise.all(locks.map((lock) => lock.renew()));
    const localActions = await Promise.all(
      targets.map(async (target) =>
        createProjectAuthorityFileRecoveryAction({
          stepId: target.stepId,
          fileName: target.fileName,
          beforeContent: await optionalContent(root, target.fileName),
          targetContent: `${JSON.stringify(target.value, null, 2)}\n`,
        }),
      ),
    );
    const actions =
      remoteUpdate === null
        ? localActions
        : [
            createPrivacyRemotePolicyRecoveryAction(remoteUpdate),
            ...localActions,
          ];
    const payload = parseOperationRecoveryPayload({
      schemaVersion: 1,
      operationId,
      type: OPERATION,
      primaryStoreId: localStore.storeId,
      actions,
      noOpStepIds: remoteUpdate === null ? ['write-remote-policy'] : [],
    });
    const authorizationBasis = createAuthorizationBasis(
      {
        action: 'project_maintenance',
        actorId: session.actorId,
        session: {
          sessionId: session.sessionId,
          actorId: session.actorId,
          status: session.status,
        },
        joined: false,
        sharedWriteGuard: 'enforced',
        task: null,
        claim: null,
        handoff: null,
        evidence: null,
        profileActorId: null,
        conditions: {
          expectedRevisionMatches: true,
          explicitConfirmation: true,
        },
      },
      now,
    );
    journal = {
      schemaVersion: 1,
      operationId,
      type: OPERATION,
      state: 'prepared',
      primaryStoreId: localStore.storeId,
      checkoutId: runtime.checkoutId,
      secondaryReservations: [],
      actorId: session.actorId,
      sessionId: session.sessionId,
      authorizationBasis,
      recoveryPayloadDigest: operationRecoveryPayloadDigest(payload),
      entityLocks: [PROJECT_SCHEMA_LOCK],
      expectedRevisions: {
        [PROJECT_SCHEMA_LOCK]: project.manifest.manifestVersion,
      },
      steps: getOperationDefinition(OPERATION).steps.map((step) => ({
        id: step.id,
        state: 'pending',
      })),
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    assertOperationJournalMatchesDefinition(journal);
    assertOperationRecoveryPayloadCoversJournal(journal, payload);
    await writeOperationRecoveryPayload(localStore, payload);
    journal = await createPreparedOperationJournal(localStore, journal);
    throwIfOperationCrashInjected(OPERATION, 'prepared');
    await (
      await import('../runtime/project-progress-events.js')
    ).markProgressCommitPending(root, operationId);
    for (const definition of getOperationDefinition(OPERATION).steps) {
      journal = await updateOperationJournal(
        localStore,
        {
          ...journal,
          state: definition.id === 'commit' ? 'committed' : 'applying',
          steps: journal.steps.map((step) =>
            step.id === definition.id ? { ...step, state: 'completed' } : step,
          ),
          updatedAt: now.toISOString(),
        },
        { canAbort: !visible },
      );
      const action = actions.find((item) => item.stepId === definition.id);
      if (action !== undefined) {
        throwIfOperationCrashInjected(OPERATION, `${definition.id}:intent`);
        if (action.kind === 'privacy_remote_policy') {
          remoteAttempted = true;
          await applyRemotePrivacyPolicyUpdate(root, action.update);
          await Promise.all(locks.map((lock) => lock.renew()));
        } else {
          await writeAuthority(
            root,
            action.fileName,
            action.targetContent,
            operationId,
          );
        }
        visible = true;
      }
      throwIfOperationCrashInjected(OPERATION, definition.id);
    }
    const snapshot = await readPrivacyPolicySnapshot(root);
    if (snapshot === null || snapshot.digest !== digestCanonicalJson(policy))
      throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
    await (
      await import('../runtime/project-progress-events.js')
    ).notifyCommittedProgress(
      root,
      {
        project: true,
        reason: 'privacy_changed',
      },
      undefined,
      operationId,
    );
    return { state: 'committed' as const, operationId, snapshot };
  } catch (error) {
    if (journal !== null && journal.state !== 'committed') {
      await updateOperationJournal(
        localStore,
        {
          ...journal,
          state: visible || remoteAttempted ? 'repair_required' : 'aborted',
          updatedAt: now.toISOString(),
        },
        { canAbort: !visible && !remoteAttempted },
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.all(locks.map((lock) => lock.release()));
  }
}

async function assertPreflight(
  root: string,
  project: Awaited<ReturnType<V3ContextStore['readProjectSnapshot']>>,
) {
  if (project.manifest.activationState !== 'v3_active')
    throw new Error('MANCODE_V3_WRITE_REQUIRES_ACTIVATION');
  if ((await listUnfinishedOperationRecoveries(root)).length > 0)
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  const [legacy, adapters] = await Promise.all([
    scanLegacyAuthority(root),
    inspectV3AdapterVersions(
      root,
      managedAdapterNames(project.manifest.managedAdapters),
    ),
  ]);
  assertCompatibilityGate({
    manifest: project.manifest,
    expectedSchemaEpoch: project.manifest.epoch,
    readerVersion: VERSION,
    writerVersion: VERSION,
    writerCapabilities: CURRENT_WRITER_CAPABILITIES,
    adapterVersions: adapters,
    currentLegacyBaseline: legacy.baseline,
    legacyAuthorityPresent: legacy.authorityPresent,
    operation: 'privacy_policy_update',
  });
}

function assertExpectedRevision(expected: number, current: number) {
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw new Error('MANCODE_PRIVACY_EXPECTED_REVISION_REQUIRED');
  if (expected !== current)
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
}
function maxVersion(left: string, right: string) {
  return compareSemver(left, right) >= 0 ? left : right;
}
async function optionalContent(root: string, file: string) {
  try {
    return await readPrivacyAuthorityFile(root, file);
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw error;
  }
}
async function writeAuthority(
  root: string,
  relative: string,
  content: string,
  operationId: Ulid,
) {
  const directory = path.join(root, '.mancode', path.dirname(relative));
  const target = path.join(root, '.mancode', relative);
  await optionalContent(root, relative);
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  const temporary = path.join(
    directory,
    `.${path.basename(relative)}.${operationId}.tmp`,
  );
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await replaceFileAtomically(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

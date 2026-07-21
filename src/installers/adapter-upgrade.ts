import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from '../context/canonical.js';
import { assertCompatibilityGate } from '../context/compatibility.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { scanLegacyAuthority } from '../context/layout.js';
import {
  type SchemaManifest,
  assertSchemaManifestTransition,
  managedAdapterNames,
  parseSchemaManifest,
  serializeSchemaManifest,
} from '../context/manifest.js';
import { V3ContextStore } from '../context/store.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import { resolveLocalEntityHomeStore } from '../runtime/entity-home-store.js';
import {
  type LocalLockHandle,
  acquireOperationEntityLocks,
} from '../runtime/local-lock.js';
import {
  armOperationCrashAfterVisibleWrite,
  throwIfDeferredOperationCrashInjected,
  throwIfOperationCrashInjected,
} from '../runtime/operation-crash-injection.js';
import { assertOperationJournalMatchesDefinition } from '../runtime/operation-definition.js';
import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import { listUnfinishedOperationRecoveries } from '../runtime/operation-recovery-executor.js';
import {
  assertOperationRecoveryPayloadCoversJournal,
  createProjectAuthorityFileRecoveryAction,
  createV3AdapterFileRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../runtime/operation-recovery-payload.js';
import { writeOperationRecoveryPayload } from '../runtime/operation-recovery-store.js';
import {
  createPreparedOperationJournal,
  updateOperationJournal,
} from '../runtime/operation-store.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { type SessionStateV1, readSession } from '../runtime/session.js';
import { createAuthorizationBasis } from '../team/authorization.js';
import { capabilitiesFromProjectConfig } from '../team/transport.js';
import { VERSION } from '../version.js';
import type { PlatformName } from './registry.js';
import {
  type V3AdapterContentStatus,
  type V3AdapterFilePlan,
  type V3AdapterManagedTargetStatus,
  type V3PlatformAdapterStatus,
  V3_ADAPTER_PLATFORMS,
  V3_ADAPTER_VERSION,
  adapterManagedContentDigest,
  applyV3AdapterFilePlan,
  inspectV3Adapter,
  planV3AdapterUpgradeFiles,
  stageV3AdapterUpgradeFiles,
} from './v3-adapter.js';

export interface AdapterUpgradeInput {
  projectRoot: string;
  platforms: readonly PlatformName[];
  dryRun?: boolean;
  explicitConfirmation?: boolean;
  sessionId?: Ulid;
  operationId?: Ulid;
  now?: Date;
}

export interface AdapterUpgradeChange {
  platform: PlatformName;
  identity: string;
  target: string;
  status: V3AdapterContentStatus;
  actualDigest: string | null;
  expectedDigest: string;
  rendererVersion: string;
  repair: string;
}

export interface AdapterUpgradeResult {
  schemaVersion: 1;
  operation: 'adapter_upgrade';
  operationId: Ulid;
  platforms: PlatformName[];
  dryRun: boolean;
  state: 'preview' | 'already_ready' | 'committed';
  changes: AdapterUpgradeChange[];
  filePlans: Array<{
    target: string;
    beforeDigest: string | null;
    targetDigest: string;
  }>;
  stagedTargets: string[];
  manifest: {
    changed: boolean;
    beforeVersion: 1 | 2;
    targetVersion: 1 | 2;
  };
  status: Record<PlatformName, V3PlatformAdapterStatus>;
  journal: OperationJournalV1 | null;
}

interface AdapterUpgradePreviewV1 {
  schemaVersion: 1;
  operationId: Ulid;
  platforms: PlatformName[];
  projectFingerprint: string;
  plansDigest: string;
  manifestTargetDigest: string;
  stagedTargets: string[];
  createdAt: string;
}

/** Performs a read-only preview or journaled local adapter repair. */
export async function upgradeV3Adapters(
  input: AdapterUpgradeInput,
): Promise<AdapterUpgradeResult> {
  const root = path.resolve(input.projectRoot);
  const platforms = normalizePlatforms(input.platforms);
  const operationIdProvided = input.operationId !== undefined;
  const operationId =
    input.operationId ?? createUlid((input.now ?? new Date()).getTime());
  assertUlid(operationId, 'adapter upgrade operationId');
  const now = input.now ?? new Date();
  const dryRun = input.dryRun === true;
  const projectRuntime = await readProjectRuntimeContext(root);
  const store = new V3ContextStore(root);
  const [project, legacy, unfinished] = await Promise.all([
    store.readProjectSnapshot(),
    scanLegacyAuthority(root),
    listUnfinishedOperationRecoveries(root),
  ]);
  if (unfinished.length > 0) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_OPERATION_PENDING');
  }
  const actualVersions = await import('./v3-adapter.js').then(
    ({ inspectV3AdapterVersions }) =>
      inspectV3AdapterVersions(
        root,
        managedAdapterNames(project.manifest.managedAdapters),
      ),
  );
  assertCompatibilityGate({
    manifest: project.manifest,
    expectedSchemaEpoch: project.manifest.epoch,
    readerVersion: VERSION,
    writerVersion: VERSION,
    writerCapabilities: [
      'planning-policy:1',
      'planning-policy:2',
      'adapter-digest:1',
      'reframe-local:1',
    ],
    adapterVersions: actualVersions,
    currentLegacyBaseline: legacy.baseline,
    legacyAuthorityPresent: legacy.authorityPresent,
    operation: 'adapter_upgrade',
  });
  const statusEntries = await Promise.all(
    platforms.map(
      async (platform) =>
        [platform, await inspectV3Adapter(root, platform)] as const,
    ),
  );
  const status = Object.fromEntries(statusEntries) as Record<
    PlatformName,
    V3PlatformAdapterStatus
  >;
  const changes = statusEntries.flatMap(([platform, adapter]) =>
    adapter.targets
      .filter((target) => target.status !== 'ready')
      .map((target) => changeFor(platform, target)),
  );
  const plans = await planV3AdapterUpgradeFiles(root, platforms);
  const manifestTarget = targetManifest(
    project.manifest,
    platforms,
    operationId,
  );
  const manifestChanged = manifestTarget !== null;
  const previewCandidate = adapterUpgradePreview({
    operationId,
    platforms,
    projectFingerprint: project.fingerprint,
    plans,
    manifestTarget: manifestTarget ?? project.manifest,
    stagedTargets: [],
    now,
  });
  let stagedTargets: string[] = [];
  if (dryRun) {
    const existingPreview = await readAdapterUpgradePreview(root, operationId);
    if (existingPreview === null) {
      const staged = await stageV3AdapterUpgradeFiles(root, operationId, plans);
      stagedTargets = staged.map((item) => item.stagingTarget);
      await writeAdapterUpgradePreview(root, {
        ...previewCandidate,
        stagedTargets,
      });
    } else {
      assertAdapterUpgradePreviewMatches(existingPreview, previewCandidate);
      await assertStagedAdapterFiles(root, existingPreview, plans);
      stagedTargets = existingPreview.stagedTargets;
    }
  }
  const resultBase = {
    schemaVersion: 1 as const,
    operation: 'adapter_upgrade' as const,
    operationId,
    platforms,
    dryRun,
    changes,
    filePlans: plans.map((plan) => ({
      target: plan.target,
      beforeDigest:
        plan.beforeContent === null
          ? null
          : adapterManagedContentDigest(plan.target, plan.beforeContent),
      targetDigest: adapterManagedContentDigest(
        plan.target,
        plan.targetContent,
      ),
    })),
    stagedTargets,
    manifest: {
      changed: manifestChanged,
      beforeVersion: project.manifest.manifestVersion,
      targetVersion:
        manifestTarget?.manifestVersion ?? project.manifest.manifestVersion,
    },
    status,
  };
  if (dryRun) {
    return { ...resultBase, state: 'preview', journal: null };
  }
  if (plans.length === 0 && !manifestChanged) {
    return { ...resultBase, state: 'already_ready', journal: null };
  }
  if (input.explicitConfirmation !== true) {
    throw new Error('MANCODE_EXPLICIT_CONFIRMATION_REQUIRED');
  }
  if (!operationIdProvided) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_REQUIRED');
  }
  if (input.sessionId === undefined) {
    throw new Error('MANCODE_SESSION_REQUIRED');
  }
  assertUlid(input.sessionId, 'adapter upgrade sessionId');
  const session = await readSession(root, input.sessionId);
  if (session === null || session.status !== 'active') {
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  }
  const preview = await readAdapterUpgradePreview(root, operationId);
  if (preview === null) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_REQUIRED');
  }
  assertAdapterUpgradePreviewMatches(preview, previewCandidate);
  await assertStagedAdapterFiles(root, preview, plans);
  resultBase.stagedTargets = preview.stagedTargets;
  const journalResult = await commitAdapterUpgrade({
    root,
    runtime: projectRuntime,
    project,
    platforms,
    plans,
    manifestTarget,
    session,
    operationId,
    now,
  });
  const finalEntries = await Promise.all(
    platforms.map(
      async (platform) =>
        [platform, await inspectV3Adapter(root, platform)] as const,
    ),
  );
  return {
    ...resultBase,
    state: 'committed',
    status: Object.fromEntries(finalEntries) as Record<
      PlatformName,
      V3PlatformAdapterStatus
    >,
    journal: journalResult,
  };
}

async function commitAdapterUpgrade(input: {
  root: string;
  runtime: Awaited<ReturnType<typeof readProjectRuntimeContext>>;
  project: Awaited<ReturnType<V3ContextStore['readProjectSnapshot']>>;
  platforms: PlatformName[];
  plans: V3AdapterFilePlan[];
  manifestTarget: SchemaManifest | null;
  session: SessionStateV1;
  operationId: Ulid;
  now: Date;
}): Promise<OperationJournalV1> {
  const localStore = resolveLocalEntityHomeStore(
    input.runtime.entityHomeStoreContext,
  );
  const adapterTargets = new Set<string>();
  for (const platform of input.platforms) {
    adapterTargets.add(`adapter:${primaryTargetForPlatform(platform)}`);
    for (const mode of ['manba', 'man', 'manteam', 'manps', 'mansolo']) {
      adapterTargets.add(`adapter:${modeTargetForPlatform(platform, mode)}`);
    }
  }
  for (const plan of input.plans) adapterTargets.add(`adapter:${plan.target}`);
  const entityLocks = [...adapterTargets].sort(compareUtf8);
  const expectedRevisions: Record<string, number> = Object.fromEntries(
    entityLocks.map((key) => [key, 0]),
  );
  if (input.manifestTarget !== null) {
    entityLocks.push('schema:project');
    entityLocks.sort(compareUtf8);
    expectedRevisions['schema:project'] =
      input.project.manifest.manifestVersion;
  }
  const authorizationBasis = createAuthorizationBasis(
    {
      action: 'project_maintenance',
      actorId: input.session.actorId,
      session: {
        sessionId: input.session.sessionId,
        actorId: input.session.actorId,
        status: input.session.status,
      },
      joined: false,
      sharedWriteGuard: capabilitiesFromProjectConfig(input.project.config)
        .writeGuard,
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
    input.now,
  );
  const manifestAction =
    input.manifestTarget === null
      ? null
      : createProjectAuthorityFileRecoveryAction({
          stepId: 'update-adapter-inventory',
          fileName: 'schema.json',
          beforeContent: serializeSchemaManifest(input.project.manifest),
          targetContent: serializeSchemaManifest(input.manifestTarget),
        });
  const payload = parseOperationRecoveryPayload({
    schemaVersion: 1,
    operationId: input.operationId,
    type: 'adapter_upgrade',
    primaryStoreId: localStore.storeId,
    actions: [
      ...input.plans.map((plan) =>
        createV3AdapterFileRecoveryAction({
          stepId: 'replace-managed-adapters',
          target: plan.target,
          beforeContent: plan.beforeContent,
          targetContent: plan.targetContent,
        }),
      ),
      ...(manifestAction === null ? [] : [manifestAction]),
    ],
    noOpStepIds: [
      ...(input.plans.length === 0 ? ['replace-managed-adapters'] : []),
      ...(manifestAction === null ? ['update-adapter-inventory'] : []),
    ],
  });
  let journal: OperationJournalV1 = {
    schemaVersion: 1,
    operationId: input.operationId,
    type: 'adapter_upgrade',
    state: 'prepared',
    primaryStoreId: localStore.storeId,
    checkoutId: input.runtime.checkoutId,
    secondaryReservations: [],
    actorId: input.session.actorId,
    sessionId: input.session.sessionId,
    authorizationBasis,
    recoveryPayloadDigest: operationRecoveryPayloadDigest(payload),
    entityLocks,
    expectedRevisions,
    steps: [
      'validate',
      'replace-managed-adapters',
      'update-adapter-inventory',
      'verify',
      'commit',
    ].map((id) => ({ id, state: 'pending' as const })),
    startedAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
  };
  assertOperationJournalMatchesDefinition(journal);
  assertOperationRecoveryPayloadCoversJournal(journal, payload);
  const locks = await acquireOperationEntityLocks(
    input.operationId,
    [{ store: localStore, entityLockKeys: entityLocks }],
    { now: input.now },
  );
  let durable = false;
  try {
    const lockedProject = await new V3ContextStore(
      input.root,
    ).readProjectSnapshot();
    const lockedPlans = await planV3AdapterUpgradeFiles(
      input.root,
      input.platforms,
    );
    if (
      lockedProject.fingerprint !== input.project.fingerprint ||
      JSON.stringify(lockedPlans) !== JSON.stringify(input.plans)
    ) {
      throw new Error('MANCODE_REVISION_CONFLICT');
    }
    await writeOperationRecoveryPayload(localStore, payload);
    await createPreparedOperationJournal(localStore, journal);
    durable = true;
    throwIfOperationCrashInjected('adapter_upgrade', 'prepared');
    journal = await completeAdapterStep(
      localStore,
      journal,
      'validate',
      input.now,
    );
    journal = await completeAdapterStep(
      localStore,
      journal,
      'replace-managed-adapters',
      input.now,
    );
    for (const plan of input.plans) {
      await renewLocks(locks);
      await applyV3AdapterFilePlan(input.root, plan);
      throwIfOperationCrashInjected(
        'adapter_upgrade',
        `replace-managed-adapters:${plan.target}`,
      );
    }
    journal = await completeAdapterStep(
      localStore,
      journal,
      'update-adapter-inventory',
      input.now,
    );
    if (input.manifestTarget !== null) {
      await writeSchemaManifest(input.root, input.manifestTarget);
    }
    journal = await completeAdapterStep(
      localStore,
      journal,
      'verify',
      input.now,
    );
    const verified = await Promise.all(
      input.platforms.map((platform) => inspectV3Adapter(input.root, platform)),
    );
    if (verified.some((status) => !status.ready)) {
      throw new Error('MANCODE_ADAPTER_CONTENT_STALE');
    }
    if (input.manifestTarget !== null) {
      const after = await new V3ContextStore(input.root).readProjectSnapshot();
      if (after.manifest.lastOperationId !== input.operationId) {
        throw new Error('MANCODE_ADAPTER_MANIFEST_VERIFY_FAILED');
      }
    }
    journal = await completeAdapterStep(
      localStore,
      journal,
      'commit',
      input.now,
      true,
    );
    return journal;
  } catch (error) {
    if (
      durable &&
      journal.state !== 'committed' &&
      journal.state !== 'aborted'
    ) {
      const hasWriteIntent = journal.steps.some((step) =>
        step.id === 'replace-managed-adapters' ||
        step.id === 'update-adapter-inventory'
          ? step.state === 'completed'
          : false,
      );
      await updateOperationJournal(
        localStore,
        {
          ...journal,
          state: hasWriteIntent ? 'repair_required' : 'aborted',
          updatedAt: input.now.toISOString(),
        },
        { canAbort: !hasWriteIntent },
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.allSettled(locks.map((lock) => lock.release()));
  }
}

async function completeAdapterStep(
  store: ReturnType<typeof resolveLocalEntityHomeStore>,
  previous: OperationJournalV1,
  stepId: string,
  now: Date,
  commit = false,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(previous.type);
  const index = previous.steps.findIndex((step) => step.id === stepId);
  if (index < 0 || previous.steps[index]?.state === 'completed') {
    throw new Error('MANCODE_OPERATION_STEP_INVALID');
  }
  if (
    previous.steps.slice(0, index).some((step) => step.state !== 'completed')
  ) {
    throw new Error('MANCODE_OPERATION_STEP_ORDER_INVALID');
  }
  const next: OperationJournalV1 = {
    ...previous,
    state: commit ? 'committed' : 'applying',
    steps: previous.steps.map((step, current) =>
      current === index ? { ...step, state: 'completed' as const } : step,
    ),
    updatedAt: now.toISOString(),
  };
  const updated = await updateOperationJournal(store, next, {
    canAbort: !commit && index === 0,
  });
  if (commit) {
    throwIfOperationCrashInjected(previous.type, 'commit');
  } else {
    const definitionWrite =
      stepId === 'replace-managed-adapters' ||
      stepId === 'update-adapter-inventory';
    if (definitionWrite) {
      armOperationCrashAfterVisibleWrite(previous.type, stepId);
    } else {
      throwIfOperationCrashInjected(previous.type, stepId);
    }
  }
  return updated;
}

function targetManifest(
  manifest: SchemaManifest,
  platforms: readonly PlatformName[],
  operationId: Ulid,
): SchemaManifest | null {
  const managedAdapters = { ...manifest.managedAdapters };
  let changed = false;
  for (const platform of platforms) {
    if (managedAdapters[platform] !== V3_ADAPTER_VERSION) {
      managedAdapters[platform] = V3_ADAPTER_VERSION;
      changed = true;
    }
  }
  if (!changed) return null;
  const next = parseSchemaManifest({
    ...manifest,
    managedAdapters,
    lastOperationId: operationId,
  });
  assertSchemaManifestTransition(manifest, next);
  return next;
}

function changeFor(
  platform: PlatformName,
  target: V3AdapterManagedTargetStatus,
): AdapterUpgradeChange {
  return {
    platform,
    identity: target.identity,
    target: target.target,
    status: target.status,
    actualDigest: target.actualDigest,
    expectedDigest: target.expectedDigest,
    rendererVersion: target.rendererVersion,
    repair: target.repair,
  };
}

function normalizePlatforms(
  platforms: readonly PlatformName[],
): PlatformName[] {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PLATFORM_REQUIRED');
  }
  const set = new Set(platforms);
  if (
    [...set].some(
      (platform) => !V3_ADAPTER_PLATFORMS.includes(platform as PlatformName),
    )
  ) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PLATFORM_INVALID');
  }
  return V3_ADAPTER_PLATFORMS.filter((platform) => set.has(platform));
}

function primaryTargetForPlatform(platform: PlatformName): string {
  return platform === 'claude-code'
    ? 'claude-skill'
    : platform === 'cursor'
      ? 'cursor-rule'
      : platform === 'copilot'
        ? 'copilot-instructions'
        : 'agents';
}

function modeTargetForPlatform(platform: PlatformName, mode: string): string {
  const family =
    platform === 'claude-code'
      ? 'claude'
      : platform === 'codex' || platform === 'zcode'
        ? 'agents'
        : platform;
  return `${family}-mode-${mode}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

async function renewLocks(locks: LocalLockHandle[]): Promise<void> {
  await Promise.all(locks.map((lock) => lock.renew()));
}

async function writeSchemaManifest(
  projectRoot: string,
  manifest: SchemaManifest,
): Promise<void> {
  const target = path.join(projectRoot, '.mancode', 'schema.json');
  const temporary = path.join(
    path.dirname(target),
    `.schema.adapter-upgrade.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporary, serializeSchemaManifest(manifest), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function adapterUpgradePreview(input: {
  operationId: Ulid;
  platforms: PlatformName[];
  projectFingerprint: string;
  plans: V3AdapterFilePlan[];
  manifestTarget: SchemaManifest;
  stagedTargets: string[];
  now: Date;
}): AdapterUpgradePreviewV1 {
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    platforms: [...input.platforms],
    projectFingerprint: input.projectFingerprint,
    plansDigest: digestCanonicalJson(input.plans),
    manifestTargetDigest: digestCanonicalJson(input.manifestTarget),
    stagedTargets: [...input.stagedTargets],
    createdAt: input.now.toISOString(),
  };
}

function adapterUpgradePreviewPath(root: string, operationId: Ulid): string {
  return path.join(
    root,
    '.mancode',
    'staging',
    'adapters',
    'upgrade',
    operationId,
    'preview.json',
  );
}

async function readAdapterUpgradePreview(
  root: string,
  operationId: Ulid,
): Promise<AdapterUpgradePreviewV1 | null> {
  const target = adapterUpgradePreviewPath(root, operationId);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_INVALID');
    }
    return parseAdapterUpgradePreview(
      JSON.parse(await readFile(target, 'utf8')),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_INVALID');
    }
    throw error;
  }
}

async function writeAdapterUpgradePreview(
  root: string,
  preview: AdapterUpgradePreviewV1,
): Promise<void> {
  const target = adapterUpgradePreviewPath(root, preview.operationId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(preview, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function parseAdapterUpgradePreview(value: unknown): AdapterUpgradePreviewV1 {
  assertRecord(value, 'adapter upgrade preview');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'platforms',
      'projectFingerprint',
      'plansDigest',
      'manifestTargetDigest',
      'stagedTargets',
      'createdAt',
    ],
    'adapter upgrade preview',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_INVALID');
  }
  assertUlid(value.operationId, 'adapter upgrade preview operationId');
  const platforms = normalizePlatforms(
    Array.isArray(value.platforms) ? (value.platforms as PlatformName[]) : [],
  );
  if (
    !isDigest(value.projectFingerprint) ||
    !isDigest(value.plansDigest) ||
    !isDigest(value.manifestTargetDigest) ||
    !Array.isArray(value.stagedTargets) ||
    value.stagedTargets.some(
      (target) => typeof target !== 'string' || !target.trim(),
    ) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_INVALID');
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    platforms,
    projectFingerprint: value.projectFingerprint,
    plansDigest: value.plansDigest,
    manifestTargetDigest: value.manifestTargetDigest,
    stagedTargets: [...value.stagedTargets] as string[],
    createdAt: value.createdAt,
  };
}

function assertAdapterUpgradePreviewMatches(
  preview: AdapterUpgradePreviewV1,
  candidate: AdapterUpgradePreviewV1,
): void {
  if (
    preview.operationId !== candidate.operationId ||
    JSON.stringify(preview.platforms) !== JSON.stringify(candidate.platforms) ||
    preview.projectFingerprint !== candidate.projectFingerprint ||
    preview.plansDigest !== candidate.plansDigest ||
    preview.manifestTargetDigest !== candidate.manifestTargetDigest
  ) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_STALE');
  }
}

async function assertStagedAdapterFiles(
  root: string,
  preview: AdapterUpgradePreviewV1,
  plans: readonly V3AdapterFilePlan[],
): Promise<void> {
  if (preview.stagedTargets.length !== plans.length) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_INVALID');
  }
  for (const [index, plan] of plans.entries()) {
    const relative = preview.stagedTargets[index];
    if (relative === undefined) {
      throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_INVALID');
    }
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_INVALID');
    }
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_INVALID');
    }
    if ((await readFile(target, 'utf8')) !== plan.targetContent) {
      throw new Error('MANCODE_ADAPTER_UPGRADE_PREVIEW_STALE');
    }
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

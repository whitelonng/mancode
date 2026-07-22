import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectV3AdapterVersions } from '../installers/v3-adapter.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import {
  type EntityHomeStore,
  resolveLocalEntityHomeStore,
} from '../runtime/entity-home-store.js';
import {
  type LocalLockHandle,
  acquireOperationEntityLocks,
} from '../runtime/local-lock.js';
import {
  armOperationCrashAfterVisibleWrite,
  throwIfDeferredOperationCrashInjected,
  throwIfOperationCrashInjected,
} from '../runtime/operation-crash-injection.js';
import {
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from '../runtime/operation-definition.js';
import type {
  OperationJournalV1,
  OperationStep,
} from '../runtime/operation-journal.js';
import {
  executeOperationRecovery,
  listUnfinishedOperationRecoveries,
} from '../runtime/operation-recovery-executor.js';
import {
  assertOperationRecoveryPayloadCoversJournal,
  createProjectAuthorityFileRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../runtime/operation-recovery-payload.js';
import { writeOperationRecoveryPayload } from '../runtime/operation-recovery-store.js';
import {
  createPreparedOperationJournal,
  readOperationJournal,
  updateOperationJournal,
} from '../runtime/operation-store.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { PROJECT_SCHEMA_LOCK } from '../runtime/project-write-barrier.js';
import { type SessionStateV1, readSession } from '../runtime/session.js';
import { createAuthorizationBasis } from '../team/authorization.js';
import { VERSION } from '../version.js';
import { digestCanonicalJson } from './canonical.js';
import {
  CURRENT_WRITER_CAPABILITIES,
  assertCompatibilityGate,
  compareSemver,
} from './compatibility.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { scanLegacyAuthority } from './layout.js';
import { managedAdapterNames } from './manifest.js';
import {
  type SchemaManifestV2,
  assertSchemaManifestPolicyUpgrade,
  parseSchemaManifest,
  serializeSchemaManifest,
} from './manifest.js';
import { V3ContextStore } from './store.js';

export interface ProjectPolicyUpgradeInput {
  projectRoot: string;
  policyVersion?: 2;
  sessionId: Ulid;
  operationId?: Ulid;
  now?: Date;
}

export interface ProjectPolicyUpgradePreviewInput {
  projectRoot: string;
  policyVersion?: 2;
  operationId?: Ulid;
  now?: Date;
}

export interface ProjectPolicyUpgradePreview {
  schemaVersion: 1;
  policy: 2;
  currentManifestVersion: 1 | 2;
  willUpgrade: boolean;
  beforeDigest: string;
  afterDigest: string | null;
  minReaderVersion: string;
  minWriterVersion: string;
  blockers: string[];
  operationId: Ulid;
}

interface ProjectPolicyUpgradePreviewReceiptV1 {
  schemaVersion: 1;
  operationId: Ulid;
  projectFingerprint: string;
  beforeDigest: string;
  afterDigest: string;
  createdAt: string;
}

export interface ProjectPolicyUpgradeResult {
  schemaVersion: 1;
  policy: 2;
  state: 'committed' | 'already_upgraded';
  operation: OperationJournalV1 | null;
  manifest: SchemaManifestV2;
}

const UPGRADE_OPERATION = 'project_policy_upgrade' as const;

export async function dryRunProjectPolicyUpgrade(
  input: ProjectPolicyUpgradePreviewInput,
): Promise<ProjectPolicyUpgradePreview> {
  assertPolicyVersion(input.policyVersion);
  const root = path.resolve(input.projectRoot);
  const project = await new V3ContextStore(root).readProjectSnapshot();
  const beforeDigest = digestManifest(project.manifest);
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'project policy upgrade preview operationId');
  const blockers = await collectUpgradeBlockers(root, project);
  let afterDigest: string | null = null;
  let minReaderVersion = project.manifest.minReaderVersion;
  let minWriterVersion = project.manifest.minWriterVersion;
  if (project.manifest.manifestVersion === 1 && blockers.length === 0) {
    const candidate = buildV2Manifest(project.manifest, operationId);
    afterDigest = digestManifest(candidate);
    minReaderVersion = candidate.minReaderVersion;
    minWriterVersion = candidate.minWriterVersion;
    await stageProjectPolicyUpgrade(
      root,
      {
        schemaVersion: 1,
        operationId,
        projectFingerprint: project.fingerprint,
        beforeDigest,
        afterDigest,
        createdAt: now.toISOString(),
      },
      serializeSchemaManifest(candidate),
    );
  }
  return {
    schemaVersion: 1,
    policy: 2,
    currentManifestVersion: project.manifest.manifestVersion,
    willUpgrade:
      project.manifest.manifestVersion === 1 && blockers.length === 0,
    beforeDigest,
    afterDigest,
    minReaderVersion,
    minWriterVersion,
    blockers,
    operationId,
  };
}

export async function upgradeProjectPolicy(
  input: ProjectPolicyUpgradeInput,
): Promise<ProjectPolicyUpgradeResult> {
  assertPolicyVersion(input.policyVersion);
  assertUlid(input.sessionId, 'project policy upgrade sessionId');
  const root = path.resolve(input.projectRoot);
  const now = input.now ?? new Date();
  const operationId = input.operationId;
  if (operationId === undefined) {
    throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_REQUIRED');
  }
  assertUlid(operationId, 'project policy upgrade operationId');
  const runtime = await readProjectRuntimeContext(root);
  const store = new V3ContextStore(root);
  const localStore = resolveLocalEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const session = await readSession(root, input.sessionId);
  if (session === null || session.status !== 'active') {
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  }
  const initial = await store.readProjectSnapshot();
  if (initial.manifest.manifestVersion === 2) {
    const recovered = await recoverInterruptedProjectPolicyUpgrade({
      root,
      store,
      localStore,
      session,
      operationId,
      now,
    });
    if (recovered !== null) return recovered;
    return {
      schemaVersion: 1,
      policy: 2,
      state: 'already_upgraded',
      operation: null,
      manifest: initial.manifest,
    };
  }
  await assertUpgradePreflight(root, initial);
  await assertProjectPolicyUpgradePreview(root, operationId, initial);
  const locks = await acquireOperationEntityLocks(
    operationId,
    [{ store: localStore, entityLockKeys: [PROJECT_SCHEMA_LOCK] }],
    { now },
  );
  let journal: OperationJournalV1 | null = null;
  try {
    const project = await store.readProjectSnapshot();
    if (project.manifest.manifestVersion !== 1) {
      if (project.manifest.manifestVersion === 2) {
        return {
          schemaVersion: 1,
          policy: 2,
          state: 'already_upgraded',
          operation: null,
          manifest: project.manifest,
        };
      }
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    await assertUpgradePreflight(root, project);
    await assertProjectPolicyUpgradePreview(root, operationId, project);
    const target = buildV2Manifest(project.manifest, operationId);
    const beforeContent = await readSchemaContent(root);
    const targetContent = serializeSchemaManifest(target);
    const payload = parseOperationRecoveryPayload({
      schemaVersion: 1,
      operationId,
      type: UPGRADE_OPERATION,
      primaryStoreId: localStore.storeId,
      actions: [
        createProjectAuthorityFileRecoveryAction({
          stepId: 'write-manifest',
          fileName: 'schema.json',
          beforeContent,
          targetContent,
        }),
      ],
      noOpStepIds: ['verify-manifest'],
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
      type: UPGRADE_OPERATION,
      state: 'prepared',
      primaryStoreId: localStore.storeId,
      checkoutId: runtime.checkoutId,
      secondaryReservations: [],
      actorId: session.actorId,
      sessionId: session.sessionId,
      authorizationBasis,
      recoveryPayloadDigest: operationRecoveryPayloadDigest(payload),
      entityLocks: [PROJECT_SCHEMA_LOCK],
      expectedRevisions: { [PROJECT_SCHEMA_LOCK]: 1 },
      steps: getOperationDefinition(UPGRADE_OPERATION).steps.map((step) => ({
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
    throwIfOperationCrashInjected(UPGRADE_OPERATION, 'prepared');

    journal = await advance(localStore, journal, 'validate', now, true);
    journal = await advance(localStore, journal, 'write-manifest', now, false);
    await writeSchemaContent(root, operationId, targetContent);
    armOperationCrashAfterVisibleWrite(UPGRADE_OPERATION, 'write-manifest');
    journal = await advance(localStore, journal, 'verify-manifest', now, false);
    const verified = parseSchemaManifest(
      JSON.parse(await readSchemaContent(root)),
    );
    assertSchemaManifestPolicyUpgrade(project.manifest, verified);
    if (digestManifest(verified) !== digestManifest(target)) {
      throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
    }
    journal = await commit(localStore, journal, now);
    return {
      schemaVersion: 1,
      policy: 2,
      state: 'committed',
      operation: journal,
      manifest: verified,
    };
  } catch (error) {
    if (journal !== null && journal.state !== 'committed') {
      try {
        const current =
          (await readOperationJournal(localStore, operationId)) ?? journal;
        const hasWrite = current.steps.some(
          (step, index) =>
            step.state === 'completed' &&
            getOperationDefinition(UPGRADE_OPERATION).steps[index]
              ?.visibility === 'business_write',
        );
        await updateOperationJournal(
          localStore,
          {
            ...current,
            state: hasWrite ? 'repair_required' : 'aborted',
            updatedAt: now.toISOString(),
          },
          { canAbort: !hasWrite },
        );
      } catch {
        // The durable journal remains the source of truth for repair.
      }
    }
    throw error;
  } finally {
    await releaseLocks(locks);
  }
}

async function recoverInterruptedProjectPolicyUpgrade(input: {
  root: string;
  store: V3ContextStore;
  localStore: EntityHomeStore;
  session: SessionStateV1;
  operationId: Ulid;
  now: Date;
}): Promise<ProjectPolicyUpgradeResult | null> {
  const journal = await readOperationJournal(
    input.localStore,
    input.operationId,
  );
  if (
    journal === null ||
    journal.state === 'committed' ||
    journal.state === 'aborted'
  ) {
    return null;
  }
  if (journal.type !== UPGRADE_OPERATION) {
    throw new Error('MANCODE_OPERATION_JOURNAL_CONFLICT');
  }
  const recovered = await executeOperationRecovery({
    projectRoot: input.root,
    operationId: input.operationId,
    actorId: input.session.actorId,
    sessionId: input.session.sessionId,
    mode: 'repair',
    now: input.now,
  });
  if (recovered.journal.state !== 'committed') {
    throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
  }
  const project = await input.store.readProjectSnapshot();
  if (project.manifest.manifestVersion !== 2) {
    throw new Error('MANCODE_OPERATION_RECOVERY_CONFLICT');
  }
  return {
    schemaVersion: 1,
    policy: 2,
    state: 'committed',
    operation: recovered.journal,
    manifest: project.manifest,
  };
}

async function collectUpgradeBlockers(
  root: string,
  project: Awaited<ReturnType<V3ContextStore['readProjectSnapshot']>>,
): Promise<string[]> {
  const blockers: string[] = [];
  if (project.manifest.manifestVersion !== 1) return blockers;
  try {
    await assertUpgradePreflight(root, project);
  } catch (error) {
    blockers.push(errorCode(error));
  }
  return [...new Set(blockers)];
}

async function assertUpgradePreflight(
  root: string,
  project: Awaited<ReturnType<V3ContextStore['readProjectSnapshot']>>,
): Promise<void> {
  if (project.manifest.manifestVersion !== 1) {
    throw new Error('MANCODE_PROJECT_POLICY_ALREADY_UPGRADED');
  }
  if (project.manifest.activationState !== 'v3_active') {
    throw new Error('MANCODE_V3_WRITE_REQUIRES_ACTIVATION');
  }
  const unfinished = await listUnfinishedOperationRecoveries(root);
  if (unfinished.length > 0)
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  const legacy = await scanLegacyAuthority(root);
  const adapterVersions = await inspectV3AdapterVersions(
    root,
    managedAdapterNames(project.manifest.managedAdapters),
  );
  assertCompatibilityGate({
    manifest: project.manifest,
    expectedSchemaEpoch: project.manifest.epoch,
    readerVersion: VERSION,
    writerVersion: VERSION,
    writerCapabilities: CURRENT_WRITER_CAPABILITIES,
    adapterVersions,
    currentLegacyBaseline: legacy.baseline,
    legacyAuthorityPresent: legacy.authorityPresent,
    operation: 'project_policy_upgrade',
  });
}

function buildV2Manifest(
  manifest: Extract<
    Awaited<ReturnType<V3ContextStore['readProjectSnapshot']>>['manifest'],
    { manifestVersion: 1 }
  >,
  operationId: Ulid,
): SchemaManifestV2 {
  const candidate = parseSchemaManifest({
    ...manifest,
    manifestVersion: 2,
    minReaderVersion: maxVersion(manifest.minReaderVersion, '0.4.0'),
    minWriterVersion: maxVersion(manifest.minWriterVersion, '0.4.0'),
    workflowPolicyDefaults: { planning: 2 },
    lastOperationId: operationId,
  });
  assertSchemaManifestPolicyUpgrade(manifest, candidate);
  return candidate;
}

async function readSchemaContent(root: string): Promise<string> {
  return readFile(path.join(root, '.mancode', 'schema.json'), 'utf8');
}

async function writeSchemaContent(
  root: string,
  operationId: Ulid,
  content: string,
): Promise<void> {
  const directory = path.join(root, '.mancode');
  const target = path.join(directory, 'schema.json');
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const temporary = path.join(
    directory,
    `.schema.json.${operationId}.${process.pid}.tmp`,
  );
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await replaceFileAtomically(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function advance(
  store: EntityHomeStore,
  previous: OperationJournalV1,
  stepId: string,
  now: Date,
  canAbort: boolean,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(UPGRADE_OPERATION);
  const result = await updateOperationJournal(
    store,
    {
      ...previous,
      state: 'applying',
      steps: completeStep(previous.steps, stepId),
      updatedAt: now.toISOString(),
    },
    { canAbort },
  );
  if (stepId !== 'write-manifest') {
    throwIfOperationCrashInjected(UPGRADE_OPERATION, stepId);
  }
  return result;
}

async function commit(
  store: EntityHomeStore,
  previous: OperationJournalV1,
  now: Date,
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(UPGRADE_OPERATION);
  const result = await updateOperationJournal(
    store,
    {
      ...previous,
      state: 'committed',
      steps: completeStep(previous.steps, 'commit'),
      updatedAt: now.toISOString(),
    },
    { canAbort: false },
  );
  throwIfOperationCrashInjected(UPGRADE_OPERATION, 'commit');
  return result;
}

function completeStep(
  steps: OperationStep[],
  requested: string,
): OperationStep[] {
  const index = steps.findIndex((step) => step.id === requested);
  if (index < 0 || steps[index]?.state === 'completed') {
    throw new Error('MANCODE_OPERATION_STEP_INVALID');
  }
  if (steps.slice(0, index).some((step) => step.state !== 'completed')) {
    throw new Error('MANCODE_OPERATION_STEP_ORDER_INVALID');
  }
  return steps.map((step, stepIndex) =>
    stepIndex === index ? { ...step, state: 'completed' } : step,
  );
}

function digestManifest(manifest: unknown): string {
  return digestCanonicalJson(parseSchemaManifest(manifest));
}

function maxVersion(left: string, right: string): string {
  return compareSemver(left, right) >= 0 ? left : right;
}

function assertPolicyVersion(value: unknown): void {
  if (value !== undefined && value !== 2) {
    throw new Error(
      `MANCODE_POLICY_VERSION_UNSUPPORTED: component=planning observed=${String(value)} supported=2 requiredWriter=0.4.0`,
    );
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message.startsWith('MANCODE_')
    ? (error.message.split(':', 1)[0] ?? 'MANCODE_PROJECT_UPGRADE_BLOCKED')
    : 'MANCODE_PROJECT_UPGRADE_BLOCKED';
}

async function releaseLocks(locks: LocalLockHandle[]): Promise<void> {
  await Promise.allSettled([...locks].reverse().map((lock) => lock.release()));
}

function projectUpgradePreviewRoot(root: string, operationId: Ulid): string {
  return path.join(root, '.mancode', 'staging', 'project-upgrade', operationId);
}

async function stageProjectPolicyUpgrade(
  root: string,
  receipt: ProjectPolicyUpgradePreviewReceiptV1,
  manifestContent: string,
): Promise<void> {
  const directory = projectUpgradePreviewRoot(root, receipt.operationId);
  const receiptPath = path.join(directory, 'preview.json');
  const manifestPath = path.join(directory, 'schema.json');
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_EXISTS');
    }
    throw error;
  }
  try {
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await writeFile(manifestPath, manifestContent, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function assertProjectPolicyUpgradePreview(
  root: string,
  operationId: Ulid,
  project: Awaited<ReturnType<V3ContextStore['readProjectSnapshot']>>,
): Promise<void> {
  const directory = projectUpgradePreviewRoot(root, operationId);
  const [receiptContent, manifestContent] = await Promise.all([
    readSafePreviewFile(path.join(directory, 'preview.json')),
    readSafePreviewFile(path.join(directory, 'schema.json')),
  ]);
  let receipt: ProjectPolicyUpgradePreviewReceiptV1;
  try {
    receipt = parseProjectPolicyUpgradePreviewReceipt(
      JSON.parse(receiptContent),
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_INVALID');
    }
    throw error;
  }
  if (project.manifest.manifestVersion !== 1) {
    throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_STALE');
  }
  const target = buildV2Manifest(project.manifest, operationId);
  if (
    receipt.operationId !== operationId ||
    receipt.projectFingerprint !== project.fingerprint ||
    receipt.beforeDigest !== digestManifest(project.manifest) ||
    receipt.afterDigest !== digestManifest(target) ||
    manifestContent !== serializeSchemaManifest(target)
  ) {
    throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_STALE');
  }
}

async function readSafePreviewFile(target: string): Promise<string> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_INVALID');
    }
    return readFile(target, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_REQUIRED');
    }
    throw error;
  }
}

function parseProjectPolicyUpgradePreviewReceipt(
  value: unknown,
): ProjectPolicyUpgradePreviewReceiptV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_INVALID');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'afterDigest',
    'beforeDigest',
    'createdAt',
    'operationId',
    'projectFingerprint',
    'schemaVersion',
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    record.schemaVersion !== 1 ||
    typeof record.projectFingerprint !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(record.projectFingerprint) ||
    typeof record.beforeDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(record.beforeDigest) ||
    typeof record.afterDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(record.afterDigest) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new Error('MANCODE_PROJECT_UPGRADE_PREVIEW_INVALID');
  }
  assertUlid(record.operationId, 'project upgrade preview operationId');
  return {
    schemaVersion: 1,
    operationId: record.operationId,
    projectFingerprint: record.projectFingerprint,
    beforeDigest: record.beforeDigest,
    afterDigest: record.afterDigest,
    createdAt: record.createdAt,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

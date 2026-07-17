import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import type { EntityHomeStore } from '../runtime/entity-home-store.js';
import { throwIfOperationCrashInjected } from '../runtime/operation-crash-injection.js';
import {
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from '../runtime/operation-definition.js';
import type {
  OperationJournalV1,
  OperationStep,
} from '../runtime/operation-journal.js';
import {
  createPreparedOperationJournal,
  listUnfinishedOperationJournals,
  readOperationJournal,
  updateOperationJournal,
} from '../runtime/operation-store.js';
import {
  type TaskHeadFenceV1,
  parseTaskHeadFence,
} from '../runtime/task-head-fence.js';
import { type SharedActorProfileV1, parseSharedActorProfile } from './actor.js';
import {
  type AuthorizationBasisV1,
  createAuthorizationBasis,
} from './authorization.js';
import { type ClaimV1, parseClaim } from './claims.js';
import {
  type GitRefTaskBundleV1,
  parseGitRefTaskBundle,
} from './git-ref-transport.js';
import { type HandoffV1, parseHandoff } from './handoff.js';
import {
  type CoordinationTransport,
  type ProjectConfigV1,
  assertProjectConfigTransition,
  parseProjectConfig,
} from './policy.js';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface TransportMigrationTaskSnapshotV1 {
  taskRef: TaskRef;
  transitionState: 'stable';
  taskRevision: number;
  ownerActorId: Ulid | null;
  ownershipEpoch: number;
  aggregateDigest: string;
  taskHeadFence: TaskHeadFenceV1;
}

export interface TransportMigrationAuthoritySnapshotV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  authorityId: string;
  transportMode: CoordinationTransport;
  transportEpoch: number;
  coordinationDomainId: string;
  pendingOperationIds: Ulid[];
  actorProfiles: SharedActorProfileV1[];
  tasks: TransportMigrationTaskSnapshotV1[];
  taskBundles: GitRefTaskBundleV1[];
  claims: ClaimV1[];
  handoffs: HandoffV1[];
}

export interface TransportMigrationManifestV1 {
  schemaVersion: 1;
  operationId: Ulid;
  actorId: Ulid;
  workspaceId: Ulid;
  source: {
    config: ProjectConfigV1;
    authorityId: string;
    coordinationDomainId: string;
  };
  target: {
    mode: CoordinationTransport;
    remote: string | null;
    authorityId: string;
    transportEpoch: number;
    coordinationDomainId: string;
  };
  actorProfiles: SharedActorProfileV1[];
  tasks: TransportMigrationTaskSnapshotV1[];
  taskBundles: GitRefTaskBundleV1[];
  sourceClaims: ClaimV1[];
  handoffs: HandoffV1[];
  claimPolicy: 'reissue-active';
  createdAt: string;
}

export interface StagedTransportAuthorityV1 {
  schemaVersion: 1;
  operationId: Ulid;
  manifest: TransportMigrationManifestV1;
  manifestDigest: string;
  transportEpoch: number;
  coordinationDomainId: string;
  stagedAt: string;
}

export interface EstablishedTransportAuthorityV1 {
  schemaVersion: 1;
  operationId: Ulid;
  manifestDigest: string;
  transportEpoch: number;
  coordinationDomainId: string;
  authorityRevision: number;
  activeClaims: ClaimV1[];
  receipt: string;
  establishedAt: string;
}

export interface TransportAuthorityTombstoneV1 {
  schemaVersion: 1;
  operationId: Ulid;
  workspaceId: Ulid;
  sourceAuthorityId: string;
  sourceTransportEpoch: number;
  sourceCoordinationDomainId: string;
  targetAuthorityId: string;
  targetTransportEpoch: number;
  targetCoordinationDomainId: string;
  manifestDigest: string;
  authorityReceipt: string;
  activatedConfigRevision: number;
  createdAt: string;
}

/** Source methods must be durable and idempotent by operationId. */
export interface TransportMigrationSourceAdapter {
  readonly mode: CoordinationTransport;
  readonly remote: string | null;
  readonly authorityId: string;
  freeze(input: {
    operationId: Ulid;
    expectedTransportEpoch: number;
  }): Promise<void>;
  assertFrozen(input: {
    operationId: Ulid;
    expectedTransportEpoch: number;
  }): Promise<void>;
  inspect(): Promise<unknown>;
  unfreeze(input: { operationId: Ulid }): Promise<void>;
  writeTombstone(tombstone: TransportAuthorityTombstoneV1): Promise<void>;
}

/** Target methods must return the same value when the same operation retries. */
export interface TransportMigrationTargetAdapter {
  readonly mode: CoordinationTransport;
  readonly remote: string | null;
  readonly authorityId: string;
  readonly coordinationDomainId: string;
  stage(manifest: TransportMigrationManifestV1): Promise<unknown>;
  readStaged(operationId: Ulid): Promise<unknown | null>;
  establish(manifest: TransportMigrationManifestV1): Promise<unknown>;
  readEstablished(operationId: Ulid): Promise<unknown | null>;
  discard(input: {
    operationId: Ulid;
    manifestDigest: string;
  }): Promise<void>;
}

export interface TransportMigrationConfigAdapter {
  read(): Promise<unknown>;
  compareAndSwap(input: {
    expectedRevision: number;
    expectedTransportEpoch: number;
    next: ProjectConfigV1;
  }): Promise<unknown>;
}

interface TransportMigrationAdapters {
  operationStore: EntityHomeStore;
  config: TransportMigrationConfigAdapter;
  source: TransportMigrationSourceAdapter;
  target: TransportMigrationTargetAdapter;
}

export interface TransportMigrationStartInput
  extends TransportMigrationAdapters {
  operationId: Ulid;
  checkoutId: Ulid;
  actorId: Ulid;
  sessionId: Ulid;
  expectedConfigRevision: number;
  joined: boolean;
  explicitConfirmation: boolean;
  now?: Date;
}

export interface TransportMigrationRecoveryInput
  extends TransportMigrationAdapters {
  operationId: Ulid;
  actorId: Ulid;
  sessionId: Ulid;
  mode?: 'forward' | 'abort';
}

export interface TransportMigrationPreview {
  config: ProjectConfigV1;
  snapshot: TransportMigrationAuthoritySnapshotV1;
  manifest: TransportMigrationManifestV1;
  manifestDigest: string;
}

export interface StagedTransportMigration extends TransportMigrationPreview {
  journal: OperationJournalV1;
  staged: StagedTransportAuthorityV1;
}

export interface CompletedTransportMigration extends StagedTransportMigration {
  journal: OperationJournalV1;
  established: EstablishedTransportAuthorityV1;
  activatedConfig: ProjectConfigV1;
}

export type TransportMigrationRecoveryResult =
  | { state: 'aborted'; journal: OperationJournalV1 }
  | { state: 'already_committed'; journal: OperationJournalV1 }
  | ({ state: 'repaired' } & CompletedTransportMigration);

export async function previewTransportMigration(
  input: TransportMigrationStartInput,
): Promise<TransportMigrationPreview> {
  assertStartInput(input);
  const now = input.now ?? new Date();
  migrationAuthorization(input, now);
  const [config, unfinished] = await Promise.all([
    readConfig(input.config),
    listUnfinishedOperationJournals(input.operationStore),
  ]);
  if (
    input.operationStore.kind === 'checkout_local' ||
    input.operationStore.workspaceId !== config.workspaceId
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_OPERATION_STORE_INVALID');
  }
  assertSourceConfig(config, input);
  if (config.revision !== input.expectedConfigRevision) {
    throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
  }
  if (unfinished.length > 0) {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
  const snapshot = await inspectSource(input.source, config, input.operationId);
  assertNoPendingOperations(snapshot, input.operationId);
  const manifest = createManifest(input, config, snapshot, now);
  return {
    config,
    snapshot,
    manifest,
    manifestDigest: digestCanonicalJson(manifest),
  };
}

export async function stageTransportMigration(
  input: TransportMigrationStartInput,
): Promise<StagedTransportMigration> {
  const preview = await previewTransportMigration(input);
  let journal = await createMigrationJournal(input, preview);
  try {
    throwIfOperationCrashInjected('transport_migrate', 'prepared');
    const result = await advanceToStaged(input, journal, preview.manifest);
    journal = result.journal;
    return { ...preview, journal, staged: result.staged };
  } catch (error) {
    await settleMigrationFailure(input, journal);
    throw error;
  }
}

export async function executeTransportMigration(
  input: TransportMigrationStartInput,
): Promise<CompletedTransportMigration> {
  const staged = await stageTransportMigration(input);
  try {
    const completed = await advanceToCommitted(
      input,
      staged.journal,
      staged.manifest,
    );
    return { ...staged, ...completed };
  } catch (error) {
    await markRepairRequired(input.operationStore, staged.journal);
    throw error;
  }
}

export async function recoverTransportMigration(
  input: TransportMigrationRecoveryInput,
): Promise<TransportMigrationRecoveryResult> {
  assertRecoveryInput(input);
  const journal = await readOperationJournal(
    input.operationStore,
    input.operationId,
  );
  if (journal === null || journal.type !== 'transport_migrate') {
    throw new Error('MANCODE_OPERATION_JOURNAL_NOT_FOUND');
  }
  assertRecoveryIdentity(input, journal);
  if (journal.state === 'aborted') return { state: 'aborted', journal };
  if (journal.state === 'committed') {
    return { state: 'already_committed', journal };
  }
  if (input.mode === 'abort') {
    return abortMigration(input, journal);
  }
  try {
    const manifest = await loadRecoveryManifest(input, journal);
    const stagedResult = await advanceToStaged(input, journal, manifest);
    const completed = await advanceToCommitted(
      input,
      stagedResult.journal,
      manifest,
    );
    const snapshot = snapshotFromManifest(manifest);
    return {
      state: 'repaired',
      config: manifest.source.config,
      snapshot,
      manifest,
      manifestDigest: digestCanonicalJson(manifest),
      staged: stagedResult.staged,
      ...completed,
    };
  } catch (error) {
    await markRepairRequired(input.operationStore, journal);
    throw error;
  }
}

async function advanceToStaged(
  input: TransportMigrationAdapters & { operationId: Ulid },
  initialJournal: OperationJournalV1,
  manifest: TransportMigrationManifestV1,
): Promise<{
  journal: OperationJournalV1;
  staged: StagedTransportAuthorityV1;
}> {
  let journal = await ensureStepIntent(
    input.operationStore,
    initialJournal,
    'freeze-shared-coordination-writes',
  );
  await input.source.freeze({
    operationId: journal.operationId,
    expectedTransportEpoch: manifest.source.config.transport.epoch,
  });
  await assertSourceFrozen(input.source, manifest);
  throwIfOperationCrashInjected(
    'transport_migrate',
    'freeze-shared-coordination-writes',
  );

  journal = await ensureStepIntent(
    input.operationStore,
    journal,
    'validate-old-authority',
  );
  await assertSourceMatchesManifest(input, manifest);
  throwIfOperationCrashInjected('transport_migrate', 'validate-old-authority');

  journal = await ensureStepIntent(
    input.operationStore,
    journal,
    'stage-new-authority',
  );
  const staged = parseStagedTransportAuthority(
    await input.target.stage(manifest),
  );
  assertStagedMatches(input.target, manifest, staged);
  throwIfOperationCrashInjected('transport_migrate', 'stage-new-authority');
  return { journal, staged };
}

async function advanceToCommitted(
  input: TransportMigrationAdapters & { operationId: Ulid },
  initialJournal: OperationJournalV1,
  manifest: TransportMigrationManifestV1,
): Promise<{
  journal: OperationJournalV1;
  established: EstablishedTransportAuthorityV1;
  activatedConfig: ProjectConfigV1;
}> {
  await assertSourceFrozen(input.source, manifest);
  let journal = await ensureStepIntent(
    input.operationStore,
    initialJournal,
    'establish-new-epoch',
  );
  const established = parseEstablishedTransportAuthority(
    await input.target.establish(manifest),
  );
  assertEstablishedMatches(input.target, manifest, established);
  throwIfOperationCrashInjected('transport_migrate', 'establish-new-epoch');

  journal = await ensureStepIntent(
    input.operationStore,
    journal,
    'switch-config-authority',
  );
  const activatedConfig = await activateConfig(input.config, manifest);
  throwIfOperationCrashInjected('transport_migrate', 'switch-config-authority');
  await input.source.writeTombstone(
    createTombstone(manifest, established, activatedConfig),
  );

  journal = await commitJournal(input.operationStore, journal);
  return { journal, established, activatedConfig };
}

async function abortMigration(
  input: TransportMigrationRecoveryInput,
  journal: OperationJournalV1,
): Promise<TransportMigrationRecoveryResult> {
  if (journal.state === 'repair_required') {
    throw new Error('MANCODE_OPERATION_ABORT_UNSAFE');
  }
  const [config, stagedValue, establishedValue] = await Promise.all([
    readConfig(input.config),
    input.target.readStaged(journal.operationId),
    input.target.readEstablished(journal.operationId),
  ]);
  if (stagedValue === null && establishedValue !== null) {
    throw new Error('MANCODE_OPERATION_ABORT_UNSAFE');
  }
  if (stagedValue !== null) {
    const staged = parseStagedTransportAuthority(stagedValue);
    assertJournalManifestBinding(journal, staged.manifest);
    if (
      digestCanonicalJson(config) !==
      digestCanonicalJson(staged.manifest.source.config)
    ) {
      throw new Error('MANCODE_OPERATION_ABORT_UNSAFE');
    }
    await input.target.discard({
      operationId: journal.operationId,
      manifestDigest: staged.manifestDigest,
    });
    if (
      (await input.target.readStaged(journal.operationId)) !== null ||
      (await input.target.readEstablished(journal.operationId)) !== null
    ) {
      throw new Error('MANCODE_OPERATION_ABORT_UNSAFE');
    }
  } else if (!configMatchesUnstagedJournal(config, input, journal)) {
    throw new Error('MANCODE_OPERATION_ABORT_UNSAFE');
  }
  await input.source.unfreeze({ operationId: journal.operationId });
  const aborted = await updateOperationJournal(
    input.operationStore,
    { ...journal, state: 'aborted', updatedAt: new Date().toISOString() },
    { canAbort: true },
  );
  return { state: 'aborted', journal: aborted };
}

async function loadRecoveryManifest(
  input: TransportMigrationRecoveryInput,
  journal: OperationJournalV1,
): Promise<TransportMigrationManifestV1> {
  const stagedValue = await input.target.readStaged(journal.operationId);
  if (stagedValue !== null) {
    const staged = parseStagedTransportAuthority(stagedValue);
    assertStagedMatches(input.target, staged.manifest, staged);
    assertJournalManifestBinding(journal, staged.manifest);
    return staged.manifest;
  }
  const config = await readConfig(input.config);
  if (config.transport.mode !== input.source.mode) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_MISSING');
  }
  const snapshot = await inspectSource(
    input.source,
    config,
    journal.operationId,
  );
  assertNoPendingOperations(snapshot, journal.operationId);
  const manifest = createManifest(
    input,
    config,
    snapshot,
    new Date(journal.startedAt),
  );
  assertJournalManifestBinding(journal, manifest);
  return manifest;
}

async function assertSourceMatchesManifest(
  input: TransportMigrationAdapters & { operationId: Ulid },
  manifest: TransportMigrationManifestV1,
): Promise<void> {
  await assertSourceFrozen(input.source, manifest);
  const [config, unfinished, snapshot] = await Promise.all([
    readConfig(input.config),
    listUnfinishedOperationJournals(input.operationStore),
    inspectSource(input.source, manifest.source.config, input.operationId),
  ]);
  const unrelated = unfinished.filter(
    (candidate) => candidate.operationId !== input.operationId,
  );
  if (unrelated.length > 0) {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
  assertNoPendingOperations(snapshot, input.operationId);
  if (
    !sameSourceConfigOrActivated(config, manifest) ||
    digestCanonicalJson(snapshotFromManifest(manifest)) !==
      digestCanonicalJson(snapshot)
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_SOURCE_CHANGED');
  }
}

async function createMigrationJournal(
  input: TransportMigrationStartInput,
  preview: TransportMigrationPreview,
): Promise<OperationJournalV1> {
  const definition = getOperationDefinition('transport_migrate');
  const now = new Date(preview.manifest.createdAt);
  const authorizationBasis = migrationAuthorization(input, now);
  const { entityLocks, expectedRevisions } = migrationGuards(preview);
  const journal: OperationJournalV1 = {
    schemaVersion: 1,
    operationId: input.operationId,
    type: 'transport_migrate',
    state: 'prepared',
    primaryStoreId: input.operationStore.storeId,
    checkoutId: input.checkoutId,
    secondaryReservations: [],
    actorId: input.actorId,
    sessionId: input.sessionId,
    authorizationBasis,
    entityLocks,
    expectedRevisions,
    steps: definition.steps.map((step) => ({ id: step.id, state: 'pending' })),
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  assertOperationJournalMatchesDefinition(journal);
  return createPreparedOperationJournal(input.operationStore, journal);
}

function migrationAuthorization(
  input: TransportMigrationStartInput,
  now: Date,
): AuthorizationBasisV1 {
  return createAuthorizationBasis(
    {
      action: 'team_policy_config_transport',
      actorId: input.actorId,
      session: {
        sessionId: input.sessionId,
        actorId: input.actorId,
        status: 'active',
      },
      joined: input.joined,
      sharedWriteGuard: 'enforced',
      task: null,
      claim: null,
      handoff: null,
      evidence: null,
      profileActorId: null,
      conditions: {
        expectedRevisionMatches: true,
        explicitConfirmation: input.explicitConfirmation,
      },
    },
    now,
  );
}

function migrationGuards(preview: TransportMigrationPreview): {
  entityLocks: string[];
  expectedRevisions: Record<string, number>;
} {
  const expectedRevisions: Record<string, number> = {
    [`config:${preview.config.workspaceId}`]: preview.config.revision,
    [`migration_manifest:${preview.manifestDigest}`]: 0,
  };
  const entityLocks = new Set<string>(Object.keys(expectedRevisions));
  for (const task of preview.snapshot.tasks) {
    const taskKey = `task:shared:${task.taskRef.taskId}`;
    const headKey = `task_head:${task.taskRef.taskId}`;
    expectedRevisions[taskKey] = task.taskRevision;
    expectedRevisions[headKey] = task.taskHeadFence.fenceRevision;
    entityLocks.add(taskKey);
    entityLocks.add(headKey);
  }
  for (const claim of preview.snapshot.claims) {
    const key = `claim:${claim.claimId}`;
    expectedRevisions[key] = claim.revision;
    entityLocks.add(key);
  }
  for (const handoff of preview.snapshot.handoffs) {
    const key = `handoff:${handoff.handoffId}`;
    expectedRevisions[key] = handoff.revision;
    entityLocks.add(key);
  }
  ensureCollectionGuard(expectedRevisions, entityLocks, 'task_head');
  ensureCollectionGuard(expectedRevisions, entityLocks, 'claim');
  ensureCollectionGuard(expectedRevisions, entityLocks, 'handoff');
  return {
    entityLocks: [...entityLocks].sort(compareUtf8),
    expectedRevisions: Object.fromEntries(
      Object.entries(expectedRevisions).sort(([left], [right]) =>
        compareUtf8(left, right),
      ),
    ),
  };
}

function ensureCollectionGuard(
  expectedRevisions: Record<string, number>,
  entityLocks: Set<string>,
  prefix: 'task_head' | 'claim' | 'handoff',
): void {
  if (
    Object.keys(expectedRevisions).some((key) => key.startsWith(`${prefix}:`))
  ) {
    return;
  }
  const key = `${prefix}:collection`;
  expectedRevisions[key] = 0;
  entityLocks.add(key);
}

async function ensureStepIntent(
  store: EntityHomeStore,
  journal: OperationJournalV1,
  stepId: string,
): Promise<OperationJournalV1> {
  const step = journal.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error('MANCODE_OPERATION_STEP_INVALID');
  if (step.state === 'completed') return journal;
  return updateOperationJournal(
    store,
    {
      ...journal,
      state:
        journal.state === 'repair_required' ? 'repair_required' : 'applying',
      steps: completeStep(journal.steps, stepId),
      updatedAt: new Date().toISOString(),
    },
    { canAbort: stepId !== 'switch-config-authority' },
  );
}

async function commitJournal(
  store: EntityHomeStore,
  journal: OperationJournalV1,
): Promise<OperationJournalV1> {
  if (journal.state === 'committed') return journal;
  const committed = await updateOperationJournal(
    store,
    {
      ...journal,
      state: 'committed',
      steps: completeStep(journal.steps, 'commit'),
      updatedAt: new Date().toISOString(),
    },
    { canAbort: false },
  );
  throwIfOperationCrashInjected('transport_migrate', 'commit');
  return committed;
}

function completeStep(steps: OperationStep[], stepId: string): OperationStep[] {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error('MANCODE_OPERATION_STEP_INVALID');
  if (steps.slice(0, index).some((step) => step.state !== 'completed')) {
    throw new Error('MANCODE_OPERATION_STEP_ORDER_INVALID');
  }
  return steps.map((step, currentIndex) =>
    currentIndex === index ? { ...step, state: 'completed' as const } : step,
  );
}

async function settleMigrationFailure(
  input: TransportMigrationStartInput,
  staleJournal: OperationJournalV1,
): Promise<void> {
  const journal =
    (await readOperationJournal(
      input.operationStore,
      staleJournal.operationId,
    )) ?? staleJournal;
  if (hasBusinessWriteIntent(journal)) {
    await markRepairRequired(input.operationStore, journal);
    return;
  }
  try {
    await input.source.unfreeze({ operationId: journal.operationId });
    await updateOperationJournal(
      input.operationStore,
      { ...journal, state: 'aborted', updatedAt: new Date().toISOString() },
      { canAbort: true },
    );
  } catch {
    await markRepairRequired(input.operationStore, journal);
  }
}

async function markRepairRequired(
  store: EntityHomeStore,
  staleJournal: OperationJournalV1,
): Promise<void> {
  const journal =
    (await readOperationJournal(store, staleJournal.operationId)) ??
    staleJournal;
  if (
    journal.state === 'committed' ||
    journal.state === 'aborted' ||
    journal.state === 'repair_required'
  ) {
    return;
  }
  try {
    await updateOperationJournal(
      store,
      {
        ...journal,
        state: 'repair_required',
        updatedAt: new Date().toISOString(),
      },
      { canAbort: false },
    );
  } catch {
    // The durable non-terminal journal remains a write blocker.
  }
}

function hasBusinessWriteIntent(journal: OperationJournalV1): boolean {
  const definition = getOperationDefinition(journal.type);
  return journal.steps.some(
    (step, index) =>
      step.state === 'completed' &&
      definition.steps[index]?.visibility === 'business_write',
  );
}

async function activateConfig(
  configAdapter: TransportMigrationConfigAdapter,
  manifest: TransportMigrationManifestV1,
): Promise<ProjectConfigV1> {
  const current = await readConfig(configAdapter);
  const next = targetConfig(manifest);
  if (digestCanonicalJson(current) === digestCanonicalJson(next))
    return current;
  if (
    digestCanonicalJson(current) !== digestCanonicalJson(manifest.source.config)
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_SPLIT_BRAIN');
  }
  const written = parseProjectConfig(
    await configAdapter.compareAndSwap({
      expectedRevision: current.revision,
      expectedTransportEpoch: current.transport.epoch,
      next,
    }),
  );
  if (digestCanonicalJson(written) !== digestCanonicalJson(next)) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_CONFIG_CONFLICT');
  }
  return written;
}

function targetConfig(manifest: TransportMigrationManifestV1): ProjectConfigV1 {
  const previous = manifest.source.config;
  const next = parseProjectConfig({
    ...previous,
    revision: previous.revision + 1,
    transport: {
      mode: manifest.target.mode,
      remote: manifest.target.remote,
      epoch: manifest.target.transportEpoch,
    },
    lastOperationId: manifest.operationId,
    updatedAt: manifest.createdAt,
  });
  assertProjectConfigTransition(previous, next, 'transport_migrate');
  return next;
}

function createTombstone(
  manifest: TransportMigrationManifestV1,
  established: EstablishedTransportAuthorityV1,
  activatedConfig: ProjectConfigV1,
): TransportAuthorityTombstoneV1 {
  return {
    schemaVersion: 1,
    operationId: manifest.operationId,
    workspaceId: manifest.workspaceId,
    sourceAuthorityId: manifest.source.authorityId,
    sourceTransportEpoch: manifest.source.config.transport.epoch,
    sourceCoordinationDomainId: manifest.source.coordinationDomainId,
    targetAuthorityId: manifest.target.authorityId,
    targetTransportEpoch: manifest.target.transportEpoch,
    targetCoordinationDomainId: manifest.target.coordinationDomainId,
    manifestDigest: digestCanonicalJson(manifest),
    authorityReceipt: established.receipt,
    activatedConfigRevision: activatedConfig.revision,
    createdAt: manifest.createdAt,
  };
}

function createManifest(
  input: Pick<TransportMigrationAdapters, 'source' | 'target'> & {
    operationId: Ulid;
    actorId: Ulid;
  },
  config: ProjectConfigV1,
  snapshot: TransportMigrationAuthoritySnapshotV1,
  now: Date,
): TransportMigrationManifestV1 {
  return parseTransportMigrationManifest({
    schemaVersion: 1,
    operationId: input.operationId,
    actorId: input.actorId,
    workspaceId: config.workspaceId,
    source: {
      config,
      authorityId: snapshot.authorityId,
      coordinationDomainId: snapshot.coordinationDomainId,
    },
    target: {
      mode: input.target.mode,
      remote: input.target.remote,
      authorityId: input.target.authorityId,
      transportEpoch: config.transport.epoch + 1,
      coordinationDomainId: input.target.coordinationDomainId,
    },
    actorProfiles: snapshot.actorProfiles,
    tasks: snapshot.tasks,
    taskBundles: snapshot.taskBundles,
    sourceClaims: snapshot.claims,
    handoffs: snapshot.handoffs,
    claimPolicy: 'reissue-active',
    createdAt: now.toISOString(),
  });
}

function snapshotFromManifest(
  manifest: TransportMigrationManifestV1,
): TransportMigrationAuthoritySnapshotV1 {
  return {
    schemaVersion: 1,
    workspaceId: manifest.workspaceId,
    authorityId: manifest.source.authorityId,
    transportMode: manifest.source.config.transport.mode,
    transportEpoch: manifest.source.config.transport.epoch,
    coordinationDomainId: manifest.source.coordinationDomainId,
    pendingOperationIds: [],
    actorProfiles: manifest.actorProfiles,
    tasks: manifest.tasks,
    taskBundles: manifest.taskBundles,
    claims: manifest.sourceClaims,
    handoffs: manifest.handoffs,
  };
}

async function inspectSource(
  source: TransportMigrationSourceAdapter,
  config: ProjectConfigV1,
  operationId: Ulid,
): Promise<TransportMigrationAuthoritySnapshotV1> {
  const snapshot = parseTransportMigrationAuthoritySnapshot(
    await source.inspect(),
  );
  if (
    snapshot.workspaceId !== config.workspaceId ||
    snapshot.authorityId !== source.authorityId ||
    snapshot.transportMode !== source.mode ||
    snapshot.transportEpoch !== config.transport.epoch
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_SOURCE_MISMATCH');
  }
  assertAuthoritySnapshotConsistency(snapshot, operationId);
  return {
    ...snapshot,
    pendingOperationIds: snapshot.pendingOperationIds.filter(
      (candidate) => candidate !== operationId,
    ),
  };
}

async function assertSourceFrozen(
  source: TransportMigrationSourceAdapter,
  manifest: TransportMigrationManifestV1,
): Promise<void> {
  await source.assertFrozen({
    operationId: manifest.operationId,
    expectedTransportEpoch: manifest.source.config.transport.epoch,
  });
}

function assertNoPendingOperations(
  snapshot: TransportMigrationAuthoritySnapshotV1,
  operationId: Ulid,
): void {
  if (
    snapshot.pendingOperationIds.some((candidate) => candidate !== operationId)
  ) {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
}

function assertStartInput(input: TransportMigrationStartInput): void {
  assertUlid(input.operationId, 'transport migration operationId');
  assertUlid(input.checkoutId, 'transport migration checkoutId');
  assertUlid(input.actorId, 'transport migration actorId');
  assertUlid(input.sessionId, 'transport migration sessionId');
  if (
    !Number.isSafeInteger(input.expectedConfigRevision) ||
    input.expectedConfigRevision < 1
  ) {
    throw new Error('MANCODE_EXPECTED_REVISION_INVALID');
  }
  if (
    typeof input.joined !== 'boolean' ||
    typeof input.explicitConfirmation !== 'boolean'
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_CONFIRMATION_INVALID');
  }
  assertAdapterPair(input.source, input.target);
}

function assertRecoveryInput(input: TransportMigrationRecoveryInput): void {
  assertUlid(input.operationId, 'transport migration operationId');
  assertUlid(input.actorId, 'transport migration actorId');
  assertUlid(input.sessionId, 'transport migration sessionId');
  assertAdapterPair(input.source, input.target);
}

function assertAdapterPair(
  source: TransportMigrationSourceAdapter,
  target: TransportMigrationTargetAdapter,
): void {
  if (source.mode === target.mode) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_MODE_UNCHANGED');
  }
  assertTransportRemote(source.mode, source.remote);
  assertTransportRemote(target.mode, target.remote);
  assertAuthorityId(source.authorityId, 'source authorityId');
  assertAuthorityId(target.authorityId, 'target authorityId');
  assertCoordinationDomainId(target.coordinationDomainId);
  if (
    source.authorityId === target.authorityId ||
    !target.coordinationDomainId.startsWith(`${target.mode}:`)
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_TARGET_INVALID');
  }
}

function assertSourceConfig(
  config: ProjectConfigV1,
  input: Pick<TransportMigrationStartInput, 'source'>,
): void {
  if (
    config.transport.mode !== input.source.mode ||
    config.transport.remote !== input.source.remote
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_SOURCE_MISMATCH');
  }
}

function assertRecoveryIdentity(
  input: TransportMigrationRecoveryInput,
  journal: OperationJournalV1,
): void {
  if (
    journal.primaryStoreId !== input.operationStore.storeId ||
    journal.actorId !== input.actorId ||
    journal.sessionId !== input.sessionId
  ) {
    throw new Error('MANCODE_OPERATION_RECOVERY_AUTHORIZATION_MISMATCH');
  }
}

function assertJournalManifestBinding(
  journal: OperationJournalV1,
  manifest: TransportMigrationManifestV1,
): void {
  const digest = digestCanonicalJson(manifest);
  const key = `migration_manifest:${digest}`;
  if (
    journal.expectedRevisions[key] !== 0 ||
    !journal.entityLocks.includes(key) ||
    manifest.operationId !== journal.operationId
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_MANIFEST_CONFLICT');
  }
}

function assertStagedMatches(
  target: TransportMigrationTargetAdapter,
  manifest: TransportMigrationManifestV1,
  staged: StagedTransportAuthorityV1,
): void {
  if (
    staged.operationId !== manifest.operationId ||
    staged.manifestDigest !== digestCanonicalJson(manifest) ||
    staged.transportEpoch !== manifest.target.transportEpoch ||
    staged.coordinationDomainId !== manifest.target.coordinationDomainId ||
    digestCanonicalJson(staged.manifest) !== digestCanonicalJson(manifest) ||
    target.authorityId !== manifest.target.authorityId
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_STAGE_CONFLICT');
  }
}

function assertEstablishedMatches(
  target: TransportMigrationTargetAdapter,
  manifest: TransportMigrationManifestV1,
  established: EstablishedTransportAuthorityV1,
): void {
  if (
    established.operationId !== manifest.operationId ||
    established.manifestDigest !== digestCanonicalJson(manifest) ||
    established.transportEpoch !== manifest.target.transportEpoch ||
    established.coordinationDomainId !== manifest.target.coordinationDomainId ||
    target.authorityId !== manifest.target.authorityId
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_ESTABLISH_CONFLICT');
  }
  assertReissuedClaims(manifest, established.activeClaims);
}

function assertReissuedClaims(
  manifest: TransportMigrationManifestV1,
  targetClaims: ClaimV1[],
): void {
  const sourceClaims = manifest.sourceClaims.filter(
    (claim) => claim.state === 'active',
  );
  if (sourceClaims.length !== targetClaims.length) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_CLAIM_REISSUE_INVALID');
  }
  const sourceIds = new Set(sourceClaims.map((claim) => claim.claimId));
  const mapped = new Set<string>();
  for (const target of targetClaims) {
    const source = sourceClaims.find(
      (candidate) => candidate.claimId === target.predecessorClaimId,
    );
    if (
      source === undefined ||
      sourceIds.has(target.claimId) ||
      mapped.has(source.claimId) ||
      target.state !== 'active' ||
      target.workspaceId !== manifest.workspaceId ||
      target.coordinationDomainId !== manifest.target.coordinationDomainId ||
      target.authority.mode !== manifest.target.mode ||
      !sameClaimAssignment(source, target)
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_CLAIM_REISSUE_INVALID');
    }
    mapped.add(source.claimId);
  }
}

function sameClaimAssignment(source: ClaimV1, target: ClaimV1): boolean {
  return (
    sameTaskRef(source.taskRef, target.taskRef) &&
    source.taskRevisionAtAcquire === target.taskRevisionAtAcquire &&
    source.lastValidatedTaskRevision === target.lastValidatedTaskRevision &&
    source.ownerActorId === target.ownerActorId &&
    source.implementationScopeDigest === target.implementationScopeDigest &&
    source.ownershipEpochAtAcquire === target.ownershipEpochAtAcquire &&
    source.scopeDigest === target.scopeDigest &&
    digestCanonicalJson(source.scope) === digestCanonicalJson(target.scope) &&
    digestCanonicalJson(source.codeRefAtAcquire) ===
      digestCanonicalJson(target.codeRefAtAcquire) &&
    digestCanonicalJson(source.lastValidatedCodeRef) ===
      digestCanonicalJson(target.lastValidatedCodeRef)
  );
}

function assertAuthoritySnapshotConsistency(
  snapshot: TransportMigrationAuthoritySnapshotV1,
  operationId: Ulid,
): void {
  const tasks = new Map(
    snapshot.tasks.map((task) => [task.taskRef.taskId, task]),
  );
  const profiles = new Set(
    snapshot.actorProfiles.map((profile) => profile.actorId),
  );
  const bundles = new Map(
    snapshot.taskBundles.map((bundle) => [bundle.taskRef.taskId, bundle]),
  );
  if (
    profiles.size !== snapshot.actorProfiles.length ||
    bundles.size !== snapshot.taskBundles.length ||
    bundles.size !== tasks.size ||
    snapshot.tasks.some((task) => {
      const bundle = bundles.get(task.taskRef.taskId);
      return (
        task.ownerActorId === null ||
        !profiles.has(task.ownerActorId) ||
        task.taskHeadFence.workspaceId !== snapshot.workspaceId ||
        bundle === undefined ||
        bundle.taskRevision !== task.taskRevision ||
        bundle.ownershipEpoch !== task.ownershipEpoch ||
        bundle.aggregateDigest !== task.aggregateDigest ||
        bundle.codeRef.head !== task.taskHeadFence.codeRef.head
      );
    })
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_TASK_SNAPSHOT_INVALID');
  }
  for (const claim of snapshot.claims) {
    const task = tasks.get(claim.taskRef.taskId);
    if (
      claim.workspaceId !== snapshot.workspaceId ||
      claim.coordinationDomainId !== snapshot.coordinationDomainId ||
      claim.authority.mode !== snapshot.transportMode ||
      !profiles.has(claim.ownerActorId) ||
      task === undefined
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_CLAIM_SNAPSHOT_INVALID');
    }
    if (claim.state === 'pending') {
      throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
    }
    if (
      claim.state === 'active' &&
      (claim.ownershipEpochAtAcquire !== task.ownershipEpoch ||
        claim.lastValidatedTaskRevision !== task.taskRevision ||
        claim.lastValidatedCodeRef.head !== task.taskHeadFence.codeRef.head)
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_CLAIM_SNAPSHOT_INVALID');
    }
  }
  for (const handoff of snapshot.handoffs) {
    const task = tasks.get(handoff.taskRef.taskId);
    if (
      task === undefined ||
      handoff.transport.mode !== snapshot.transportMode ||
      !profiles.has(handoff.fromActorId) ||
      !profiles.has(handoff.toActorId) ||
      ((handoff.state === 'draft' || handoff.state === 'offered') &&
        handoff.ownershipEpochAtOffer !== task.ownershipEpoch)
    ) {
      throw new Error('MANCODE_TRANSPORT_MIGRATION_HANDOFF_SNAPSHOT_INVALID');
    }
  }
  if (snapshot.pendingOperationIds.some((id) => id !== operationId)) {
    throw new Error('MANCODE_OPERATION_REPAIR_REQUIRED');
  }
}

function sameSourceConfigOrActivated(
  config: ProjectConfigV1,
  manifest: TransportMigrationManifestV1,
): boolean {
  return (
    digestCanonicalJson(config) ===
      digestCanonicalJson(manifest.source.config) ||
    digestCanonicalJson(config) === digestCanonicalJson(targetConfig(manifest))
  );
}

function configMatchesUnstagedJournal(
  config: ProjectConfigV1,
  input: TransportMigrationRecoveryInput,
  journal: OperationJournalV1,
): boolean {
  const expectedRevision =
    journal.expectedRevisions[`config:${config.workspaceId}`];
  return (
    expectedRevision === config.revision &&
    config.transport.mode === input.source.mode &&
    config.transport.remote === input.source.remote
  );
}

async function readConfig(
  adapter: TransportMigrationConfigAdapter,
): Promise<ProjectConfigV1> {
  return parseProjectConfig(await adapter.read());
}

export function parseTransportMigrationAuthoritySnapshot(
  value: unknown,
): TransportMigrationAuthoritySnapshotV1 {
  assertRecord(value, 'transport migration authority snapshot');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'workspaceId',
      'authorityId',
      'transportMode',
      'transportEpoch',
      'coordinationDomainId',
      'pendingOperationIds',
      'actorProfiles',
      'tasks',
      'taskBundles',
      'claims',
      'handoffs',
    ],
    'transport migration authority snapshot',
  );
  if (value.schemaVersion !== 1) {
    throw new Error(
      'transport migration authority snapshot schemaVersion is invalid',
    );
  }
  assertUlid(value.workspaceId, 'transport migration workspaceId');
  const transportMode = parseTransportMode(value.transportMode);
  const snapshot: TransportMigrationAuthoritySnapshotV1 = {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    authorityId: parseAuthorityId(value.authorityId),
    transportMode,
    transportEpoch: parsePositiveInteger(
      value.transportEpoch,
      'transportEpoch',
    ),
    coordinationDomainId: parseCoordinationDomainId(value.coordinationDomainId),
    pendingOperationIds: parseUlidSet(
      value.pendingOperationIds,
      'pendingOperationIds',
    ),
    actorProfiles: parseCollection(
      value.actorProfiles,
      'actorProfiles',
      parseSharedActorProfile,
    ).sort((left, right) => compareUtf8(left.actorId, right.actorId)),
    tasks: parseTaskSnapshots(value.tasks),
    taskBundles: parseCollection(
      value.taskBundles,
      'taskBundles',
      parseGitRefTaskBundle,
    ).sort((left, right) =>
      compareUtf8(left.taskRef.taskId, right.taskRef.taskId),
    ),
    claims: parseCollection(value.claims, 'claims', parseClaim).sort(
      (left, right) => compareUtf8(left.claimId, right.claimId),
    ),
    handoffs: parseCollection(value.handoffs, 'handoffs', parseHandoff).sort(
      (left, right) => compareUtf8(left.handoffId, right.handoffId),
    ),
  };
  if (!snapshot.coordinationDomainId.startsWith(`${transportMode}:`)) {
    throw new Error('transport migration coordinationDomainId mode is invalid');
  }
  assertUniqueCoordinationEntities(snapshot.claims, snapshot.handoffs);
  return snapshot;
}

export function parseTransportMigrationManifest(
  value: unknown,
): TransportMigrationManifestV1 {
  assertRecord(value, 'transport migration manifest');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'actorId',
      'workspaceId',
      'source',
      'target',
      'actorProfiles',
      'tasks',
      'taskBundles',
      'sourceClaims',
      'handoffs',
      'claimPolicy',
      'createdAt',
    ],
    'transport migration manifest',
  );
  if (value.schemaVersion !== 1 || value.claimPolicy !== 'reissue-active') {
    throw new Error('transport migration manifest schema is invalid');
  }
  assertUlid(value.operationId, 'transport migration manifest operationId');
  assertUlid(value.actorId, 'transport migration manifest actorId');
  assertUlid(value.workspaceId, 'transport migration manifest workspaceId');
  assertRecord(value.source, 'transport migration manifest source');
  assertKnownKeys(
    value.source,
    ['config', 'authorityId', 'coordinationDomainId'],
    'transport migration manifest source',
  );
  assertRecord(value.target, 'transport migration manifest target');
  assertKnownKeys(
    value.target,
    ['mode', 'remote', 'authorityId', 'transportEpoch', 'coordinationDomainId'],
    'transport migration manifest target',
  );
  const config = parseProjectConfig(value.source.config);
  const targetMode = parseTransportMode(value.target.mode);
  const targetRemote = parseTransportRemote(targetMode, value.target.remote);
  const manifest: TransportMigrationManifestV1 = {
    schemaVersion: 1,
    operationId: value.operationId,
    actorId: value.actorId,
    workspaceId: value.workspaceId,
    source: {
      config,
      authorityId: parseAuthorityId(value.source.authorityId),
      coordinationDomainId: parseCoordinationDomainId(
        value.source.coordinationDomainId,
      ),
    },
    target: {
      mode: targetMode,
      remote: targetRemote,
      authorityId: parseAuthorityId(value.target.authorityId),
      transportEpoch: parsePositiveInteger(
        value.target.transportEpoch,
        'target transportEpoch',
      ),
      coordinationDomainId: parseCoordinationDomainId(
        value.target.coordinationDomainId,
      ),
    },
    actorProfiles: parseCollection(
      value.actorProfiles,
      'actorProfiles',
      parseSharedActorProfile,
    ).sort((left, right) => compareUtf8(left.actorId, right.actorId)),
    tasks: parseTaskSnapshots(value.tasks),
    taskBundles: parseCollection(
      value.taskBundles,
      'taskBundles',
      parseGitRefTaskBundle,
    ).sort((left, right) =>
      compareUtf8(left.taskRef.taskId, right.taskRef.taskId),
    ),
    sourceClaims: parseCollection(
      value.sourceClaims,
      'sourceClaims',
      parseClaim,
    ).sort((left, right) => compareUtf8(left.claimId, right.claimId)),
    handoffs: parseCollection(value.handoffs, 'handoffs', parseHandoff).sort(
      (left, right) => compareUtf8(left.handoffId, right.handoffId),
    ),
    claimPolicy: 'reissue-active',
    createdAt: parseTimestamp(value.createdAt, 'createdAt'),
  };
  if (
    manifest.workspaceId !== config.workspaceId ||
    !manifest.actorProfiles.some(
      (profile) => profile.actorId === manifest.actorId,
    ) ||
    manifest.target.mode === config.transport.mode ||
    manifest.target.transportEpoch !== config.transport.epoch + 1 ||
    !manifest.target.coordinationDomainId.endsWith(
      targetMode === 'git-ref'
        ? `:${manifest.workspaceId}:${manifest.target.transportEpoch}`
        : `:${manifest.workspaceId}`,
    ) ||
    manifest.target.coordinationDomainId ===
      manifest.source.coordinationDomainId ||
    !manifest.source.coordinationDomainId.startsWith(
      `${config.transport.mode}:`,
    ) ||
    !manifest.target.coordinationDomainId.startsWith(`${targetMode}:`)
  ) {
    throw new Error(
      'transport migration manifest authority transition is invalid',
    );
  }
  assertUniqueCoordinationEntities(manifest.sourceClaims, manifest.handoffs);
  assertAuthoritySnapshotConsistency(
    snapshotFromManifest(manifest),
    manifest.operationId,
  );
  return manifest;
}

export function parseStagedTransportAuthority(
  value: unknown,
): StagedTransportAuthorityV1 {
  assertRecord(value, 'staged transport authority');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'manifest',
      'manifestDigest',
      'transportEpoch',
      'coordinationDomainId',
      'stagedAt',
    ],
    'staged transport authority',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('staged transport authority schemaVersion is invalid');
  }
  assertUlid(value.operationId, 'staged transport authority operationId');
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    manifest: parseTransportMigrationManifest(value.manifest),
    manifestDigest: parseDigest(value.manifestDigest, 'manifestDigest'),
    transportEpoch: parsePositiveInteger(
      value.transportEpoch,
      'transportEpoch',
    ),
    coordinationDomainId: parseCoordinationDomainId(value.coordinationDomainId),
    stagedAt: parseTimestamp(value.stagedAt, 'stagedAt'),
  };
}

export function parseEstablishedTransportAuthority(
  value: unknown,
): EstablishedTransportAuthorityV1 {
  assertRecord(value, 'established transport authority');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'manifestDigest',
      'transportEpoch',
      'coordinationDomainId',
      'authorityRevision',
      'activeClaims',
      'receipt',
      'establishedAt',
    ],
    'established transport authority',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('established transport authority schemaVersion is invalid');
  }
  assertUlid(value.operationId, 'established transport authority operationId');
  const established: EstablishedTransportAuthorityV1 = {
    schemaVersion: 1,
    operationId: value.operationId,
    manifestDigest: parseDigest(value.manifestDigest, 'manifestDigest'),
    transportEpoch: parsePositiveInteger(
      value.transportEpoch,
      'transportEpoch',
    ),
    coordinationDomainId: parseCoordinationDomainId(value.coordinationDomainId),
    authorityRevision: parsePositiveInteger(
      value.authorityRevision,
      'authorityRevision',
    ),
    activeClaims: parseCollection(
      value.activeClaims,
      'activeClaims',
      parseClaim,
    ).sort((left, right) => compareUtf8(left.claimId, right.claimId)),
    receipt: parseNonEmptyString(value.receipt, 'receipt'),
    establishedAt: parseTimestamp(value.establishedAt, 'establishedAt'),
  };
  assertUniqueCoordinationEntities(established.activeClaims, []);
  return established;
}

function assertUniqueCoordinationEntities(
  claims: ClaimV1[],
  handoffs: HandoffV1[],
): void {
  if (
    new Set(claims.map((claim) => claim.claimId)).size !== claims.length ||
    new Set(handoffs.map((handoff) => handoff.handoffId)).size !==
      handoffs.length
  ) {
    throw new Error('transport migration authority has duplicate entities');
  }
}

function parseTaskSnapshots(
  value: unknown,
): TransportMigrationTaskSnapshotV1[] {
  const tasks = parseCollection(value, 'tasks', parseTaskSnapshot).sort(
    (left, right) => compareUtf8(left.taskRef.taskId, right.taskRef.taskId),
  );
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.taskRef.taskId)) {
      throw new Error('transport migration task snapshots have duplicates');
    }
    ids.add(task.taskRef.taskId);
  }
  return tasks;
}

function parseTaskSnapshot(value: unknown): TransportMigrationTaskSnapshotV1 {
  assertRecord(value, 'transport migration task snapshot');
  assertKnownKeys(
    value,
    [
      'taskRef',
      'transitionState',
      'taskRevision',
      'ownerActorId',
      'ownershipEpoch',
      'aggregateDigest',
      'taskHeadFence',
    ],
    'transport migration task snapshot',
  );
  const taskRef = parseTaskRefValue(value.taskRef);
  if (taskRef.namespace !== 'shared' || value.transitionState !== 'stable') {
    throw new Error('transport migration requires stable shared tasks');
  }
  const ownerActorId = value.ownerActorId;
  if (ownerActorId !== null) {
    assertUlid(ownerActorId, 'transport migration task ownerActorId');
  }
  const taskRevision = parsePositiveInteger(value.taskRevision, 'taskRevision');
  const ownershipEpoch = parseNonNegativeInteger(
    value.ownershipEpoch,
    'ownershipEpoch',
  );
  const aggregateDigest = parseDigest(value.aggregateDigest, 'aggregateDigest');
  const taskHeadFence = parseTaskHeadFence(value.taskHeadFence);
  if (
    !sameTaskRef(taskHeadFence.taskRef, taskRef) ||
    taskHeadFence.taskRevision !== taskRevision ||
    taskHeadFence.ownershipEpoch !== ownershipEpoch ||
    taskHeadFence.aggregateDigest !== aggregateDigest
  ) {
    throw new Error(
      'transport migration task head does not match its stable task',
    );
  }
  return {
    taskRef,
    transitionState: 'stable',
    taskRevision,
    ownerActorId,
    ownershipEpoch,
    aggregateDigest,
    taskHeadFence,
  };
}

function parseCollection<T>(
  value: unknown,
  label: string,
  parser: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map(parser);
}

function parseUlidSet(value: unknown, label: string): Ulid[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const parsed = value.map((item) => {
    assertUlid(item, label);
    return item;
  });
  const unique = new Set(parsed);
  if (unique.size !== parsed.length) throw new Error(`${label} has duplicates`);
  return [...unique].sort(compareUtf8);
}

function parseTransportMode(value: unknown): CoordinationTransport {
  if (value !== 'local' && value !== 'git-ref') {
    throw new Error('transport migration mode is invalid');
  }
  return value;
}

function parseTransportRemote(
  mode: CoordinationTransport,
  value: unknown,
): string | null {
  if (value !== null && (typeof value !== 'string' || !value.trim())) {
    throw new Error('transport migration remote is invalid');
  }
  assertTransportRemote(mode, value);
  return value;
}

function assertTransportRemote(
  mode: CoordinationTransport,
  remote: unknown,
): asserts remote is string | null {
  if (
    (mode === 'local' && remote !== null) ||
    (mode === 'git-ref' &&
      (typeof remote !== 'string' || !remote.trim() || remote.includes('\0')))
  ) {
    throw new Error('MANCODE_TRANSPORT_MIGRATION_REMOTE_INVALID');
  }
}

function parseAuthorityId(value: unknown): string {
  assertAuthorityId(value, 'authorityId');
  return value;
}

function assertAuthorityId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`transport migration ${label} is invalid`);
  }
}

function parseCoordinationDomainId(value: unknown): string {
  assertCoordinationDomainId(value);
  return value;
}

function assertCoordinationDomainId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^(local|git-ref):[^\0]+$/.test(value) ||
    value.includes('..')
  ) {
    throw new Error('transport migration coordinationDomainId is invalid');
  }
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

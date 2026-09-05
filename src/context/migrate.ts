import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { MancodeState } from '../commands/init.js';
import { hasManagedBlock } from '../installers/managed-block.js';
import {
  V3_ADAPTER_VERSION,
  applyV3AdapterFilePlan,
  assertV3AdapterTargetSafe,
  type planV3AdapterFiles,
  planV3AdapterUpgradeFiles,
  readV3AdapterFilePlanContent,
  v3AdapterTargetPath,
} from '../installers/v3-adapter.js';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import {
  operationDirectory,
  resolveCoordinationEntityHomeStore,
  resolveLocalEntityHomeStore,
} from '../runtime/entity-home-store.js';
import { acquireOperationEntityLocks } from '../runtime/local-lock.js';
import {
  armOperationCrashAfterVisibleWrite,
  pauseIfOperationLockInjectedForTesting,
  throwIfDeferredOperationCrashInjected,
  throwIfOperationCrashInjected,
} from '../runtime/operation-crash-injection.js';
import {
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from '../runtime/operation-definition.js';
import {
  type OperationJournalV1,
  withOperationReservationDigests,
} from '../runtime/operation-journal.js';
import {
  assertOperationRecoveryPayloadCoversJournal,
  createMigrationStageFileRecoveryAction,
  createMigrationTaskDirectoryRecoveryAction,
  createProjectAuthorityFileRecoveryAction,
  createTaskHeadFenceRecoveryAction,
  createV3AdapterFileRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../runtime/operation-recovery-payload.js';
import {
  readOperationRecoveryPayload,
  writeOperationRecoveryPayload,
} from '../runtime/operation-recovery-store.js';
import {
  prepareOperationStores,
  readOperationJournal,
  updateOperationJournal,
} from '../runtime/operation-store.js';
import { ensureProjectRuntimeContext } from '../runtime/project-runtime.js';
import { readCheckoutCodeHead } from '../runtime/project-runtime.js';
import { readSession } from '../runtime/session.js';
import type { TaskHeadFenceV1 } from '../runtime/task-head-fence.js';
import {
  createTaskHeadFence,
  readTaskHeadFence,
} from '../runtime/task-head-store.js';
import { taskEntityKey, taskHeadEntityKey } from '../runtime/task-operation.js';
import { readRequirementsLedger } from '../system/requirements-ledger.js';
import { readReviewLedger } from '../system/review-ledger.js';
import { readVerificationLedger } from '../system/verification-ledger.js';
import {
  type WorkflowMeta as LegacyWorkflowMeta,
  isValidWorkflowTaskId,
  readWorkflow,
} from '../system/workflow.js';
import { readSharedActorProfile } from '../team/actor.js';
import { createAuthorizationBasis } from '../team/authorization.js';
import {
  type ProjectConfigV1,
  type TeamPolicyV1,
  assertConfigPolicyConsistency,
  assertProjectConfigTransition,
  parseProjectConfig,
  parseTeamPolicy,
} from '../team/policy.js';
import { capabilitiesFromProjectConfig } from '../team/transport.js';
import { VERSION } from '../version.js';
import {
  buildTaskAggregateManifest,
  taskAggregateDigest,
} from './aggregate.js';
import { digestCanonicalJson, sortUtf8StringSet } from './canonical.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { sameLegacyBaseline, scanLegacyAuthority } from './layout.js';
import {
  type LegacyBaseline,
  type ManagedAdapterInventory,
  type SchemaManifest,
  assertActivationRollbackManifestTransition,
  assertSchemaManifestTransition,
  managedAdapterInventoriesMatch,
  managedAdapterNames,
  parseSchemaManifest,
} from './manifest.js';
import type { ManagedAdapter } from './manifest.js';
import {
  type LegacyMigrationOwner,
  type LegacyTaskAliasMap,
  type LegacyTaskMigrationSource,
  type MigratedLegacyTaskCandidate,
  type MigrationParityReportV1,
  assertLegacyStatePointers,
  assertMigrationParity,
  createDeterministicMigrationIdAllocator,
  createLegacyTaskAliasMap,
  createMigrationParityReport,
  migrateLegacyTaskToV3,
} from './migration-parity.js';
import { assertSafeSharedRelativePath } from './privacy.js';
import {
  type QuarantineArtifact,
  type QuarantineCandidateV1,
  createQuarantineCandidate,
  previewQuarantineCandidate,
  quarantineDirectory,
  scanQuarantineCandidate,
  validateQuarantinePaths,
} from './quarantine.js';
import { parseRequirementsLedger } from './requirements-ledger.js';
import { parseReviewLedger } from './review-ledger.js';
import { normalizeLegacyWorkflowMode } from './schema.js';
import { taskRootPath } from './task-locator.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';
import { parseVerificationLedger } from './verification-ledger.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
  workflowMetadataDigest,
} from './workflow-metadata.js';

/**
 * The migration stage is deliberately local-only.  It is an inspection and
 * quarantine record, not a second workflow authority and not an activation
 * journal.  Legacy files remain untouched until a separate activation
 * operation reaches its commit point.
 */
export const MIGRATION_STAGE_SCHEMA_VERSION = 1;

/** The bootstrap journal uses the common crash injector without becoming a
 * task operation visible to the runtime recovery executor. */
export const DUAL_READ_BOOTSTRAP_OPERATION = 'migration_bootstrap' as const;
export const DUAL_READ_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export type DualReadBootstrapTargetName = 'config' | 'policy' | 'schema';
export type DualReadBootstrapTargetState = 'pending' | 'published';
export type DualReadBootstrapStateName =
  | 'staged'
  | 'publishing'
  | 'committed'
  | 'repair_required';

export interface DualReadBootstrapTargetV1 {
  name: DualReadBootstrapTargetName;
  relativePath: string;
  beforeContent: string | null;
  targetContent: string;
  state: DualReadBootstrapTargetState;
}

/**
 * A small local journal for the three-file compatibility shell.  The target
 * contents are intentionally stored in the journal as well as staging: a
 * process can rebuild a damaged staging directory without guessing what it
 * was supposed to publish.
 */
export interface DualReadBootstrapStateV1 {
  schemaVersion: 1;
  operationId: Ulid;
  state: DualReadBootstrapStateName;
  sourceBaseline: LegacyBaseline;
  managedAdapters: ManagedAdapterInventory;
  managedAdaptersDigest: string;
  adapterEvidenceDigest: string;
  stagingDirectory: string;
  targets: DualReadBootstrapTargetV1[];
  createdAt: string;
  updatedAt: string;
}

export type MigrationStageState = 'staged' | 'activated' | 'rolled_back';
export type MigrationTaskStageState = 'ready' | 'blocked';

export interface MigrationScopeResolutionV1 {
  include: string[];
  exclude: string[];
  modules: string[];
}

export interface MigrationTaskResolutionV1 {
  ownerActorId: Ulid | null;
  implementationScope: MigrationScopeResolutionV1 | null;
}

export interface MigrationTaskStageV1 {
  legacyTaskId: string;
  taskRef: TaskRef;
  quarantineId: Ulid;
  state: MigrationTaskStageState;
  blockers: string[];
  candidateDigest: string | null;
  parityDigest: string | null;
  privacyStatus: 'pending' | 'passed' | 'blocked';
}

export interface MigrationStageV1 {
  schemaVersion: 1;
  stageId: Ulid;
  revision: number;
  state: MigrationStageState;
  sourceBaseline: LegacyBaseline;
  sourceInventoryDigest: string;
  /**
   * Adapter inventory is optional only for stages written by pre-inventory
   * versions. New stages always persist all three fields together.
   */
  managedAdapters?: ManagedAdapterInventory;
  managedAdaptersDigest?: string;
  adapterEvidenceDigest?: string;
  aliases: LegacyTaskAliasMap;
  resolutions: Record<string, MigrationTaskResolutionV1>;
  tasks: MigrationTaskStageV1[];
  createdAt: string;
  updatedAt: string;
}

export interface MigrationDryRunReportV1 {
  schemaVersion: 1;
  sourceBaseline: LegacyBaseline;
  sourceInventoryDigest: string;
  managedAdapters: ManagedAdapterInventory;
  managedAdaptersDigest: string;
  adapterEvidenceDigest: string;
  aliases: LegacyTaskAliasMap;
  tasks: MigrationTaskStageV1[];
}

export interface StageLegacyMigrationInput {
  projectRoot: string;
  /** Supplying an existing ID restages the same immutable legacy baseline. */
  stageId?: Ulid;
  now?: Date;
  minReaderVersion?: string;
  minWriterVersion?: string;
  /** An explicit empty object intentionally selects no adapters. */
  managedAdapters?: ManagedAdapterInventory;
}

export interface ResolveLegacyMigrationInput {
  projectRoot: string;
  stageId: Ulid;
  legacyTaskId: string;
  expectedStageRevision: number;
  ownerActorId?: Ulid;
  implementationScope?: MigrationScopeResolutionV1;
  now?: Date;
}

export interface ActivateLegacyMigrationInput {
  projectRoot: string;
  stageId: Ulid;
  expectedStageRevision: number;
  sessionId: Ulid;
  /** The command-level acknowledgement required for a project-wide cutover. */
  explicitConfirmation: boolean;
  /** Required when the staged set contains a shared task. */
  sharedPrivacyConfirmed: boolean;
  operationId?: Ulid;
  now?: Date;
}

export interface ActivatedLegacyMigration {
  manifest: SchemaManifest;
  stage: MigrationStageV1;
  operation: OperationJournalV1;
}

export interface RollbackLegacyMigrationInput {
  projectRoot: string;
  operationId: Ulid;
  sessionId: Ulid;
  explicitConfirmation: boolean;
  now?: Date;
}

export interface RolledBackLegacyMigration {
  manifest: SchemaManifest;
  stage: MigrationStageV1;
  operation: OperationJournalV1;
}

interface LoadedLegacyTask {
  legacyTaskId: string;
  workflow: LegacyWorkflowMeta;
  source: LegacyTaskMigrationSource | null;
  sourceFiles: Array<{ relativePath: string; content: string }>;
  blockers: string[];
}

interface LegacyMigrationSourceSet {
  baseline: LegacyBaseline;
  inventoryDigest: string;
  adapterEvidence: string[];
  adapterEvidenceDigest: string;
  inferredManagedAdapters: ManagedAdapterInventory;
  state: Partial<MancodeState> | null;
  tasks: LoadedLegacyTask[];
}

type MigrationAdapterInventorySource =
  | 'manifest'
  | 'explicit'
  | 'stage'
  | 'legacy-evidence';

interface ResolvedMigrationAdapterInventory {
  managedAdapters: ManagedAdapterInventory;
  managedAdaptersDigest: string;
  adapterEvidenceDigest: string;
  source: MigrationAdapterInventorySource;
}

interface RenderedTask {
  stage: MigrationTaskStageV1;
  candidate: MigratedLegacyTaskCandidate | null;
  report: MigrationParityReportV1 | null;
  quarantine: QuarantineCandidateV1;
  sourceFiles: Array<{ relativePath: string; content: string }>;
}

const MANAGED_ADAPTERS: ManagedAdapter[] = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'zcode',
  'kimi-code',
  'qoder',
  'dsh',
];
const DUAL_READ_BOOTSTRAP_LOCK_LEASE_MS = 30_000;
const DUAL_READ_BOOTSTRAP_STAGING_PREFIX =
  '.mancode/local/migration/.dual-read-bootstrap-';
const DUAL_READ_BOOTSTRAP_STATE_RELATIVE =
  '.mancode/local/migration/dual-read-bootstrap.json';
const DUAL_READ_BOOTSTRAP_LOCK_RELATIVE =
  '.mancode/local/migration/.bootstrap.lock';
const DUAL_READ_BOOTSTRAP_TARGET_SPECS: ReadonlyArray<{
  name: DualReadBootstrapTargetName;
  relativePath: string;
  stagingRelativePath: string;
}> = [
  {
    name: 'config',
    relativePath: '.mancode/shared/config.json',
    stagingRelativePath: 'shared/config.json',
  },
  {
    name: 'policy',
    relativePath: '.mancode/shared/team/policy.json',
    stagingRelativePath: 'shared/team/policy.json',
  },
  {
    name: 'schema',
    relativePath: '.mancode/schema.json',
    stagingRelativePath: 'schema.json',
  },
];
const LEGACY_ADAPTER_VERSION = 'legacy-unmanaged';
const ADAPTER_EVIDENCE_SCAN_LIMIT = 512;

/** Fixed platform paths are evidence; a generic AGENTS.md is intentionally not. */
const PLATFORM_PATH_EVIDENCE: ReadonlyArray<{
  platform: ManagedAdapter;
  relativePath: string;
  kind: 'file' | 'directory' | 'any';
}> = [
  { platform: 'claude-code', relativePath: 'CLAUDE.md', kind: 'file' },
  { platform: 'claude-code', relativePath: '.claude', kind: 'directory' },
  {
    platform: 'claude-code',
    relativePath: '.claude/settings.json',
    kind: 'file',
  },
  {
    platform: 'claude-code',
    relativePath: '.claude/skills',
    kind: 'directory',
  },
  {
    platform: 'claude-code',
    relativePath: '.claude/agents',
    kind: 'directory',
  },
  { platform: 'cursor', relativePath: '.cursor/rules', kind: 'directory' },
  {
    platform: 'cursor',
    relativePath: '.cursor/commands',
    kind: 'directory',
  },
  {
    platform: 'copilot',
    relativePath: '.github/copilot-instructions.md',
    kind: 'file',
  },
  { platform: 'copilot', relativePath: '.github/prompts', kind: 'directory' },
  { platform: 'qoder', relativePath: '.qoder/commands', kind: 'directory' },
  { platform: 'dsh', relativePath: '.dsh/skills', kind: 'directory' },
  { platform: 'codex', relativePath: '.codex/skills', kind: 'directory' },
  { platform: 'zcode', relativePath: '.zcode/skills', kind: 'directory' },
];

const MARKER_EVIDENCE: ReadonlyArray<{
  platform: ManagedAdapter;
  marker: string;
}> = [
  { platform: 'claude-code', marker: 'mancode:continuity:claude:' },
  { platform: 'claude-code', marker: 'mancode:claude-skill' },
  { platform: 'claude-code', marker: 'mancode:claude-agent' },
  { platform: 'claude-code', marker: 'mancode:v3:claude:' },
  { platform: 'codex', marker: 'mancode:continuity:codex:' },
  { platform: 'codex', marker: 'mancode:v3:codex:' },
  { platform: 'codex', marker: 'mancode:codex-skill' },
  { platform: 'zcode', marker: 'mancode:continuity:zcode:' },
  { platform: 'zcode', marker: 'mancode:v3:zcode:' },
  { platform: 'zcode', marker: 'mancode:zcode-skill' },
  { platform: 'zcode', marker: 'mancode:zcode:' },
  { platform: 'kimi-code', marker: 'mancode:continuity:kimi:' },
  { platform: 'kimi-code', marker: 'mancode:v3:kimi:' },
  { platform: 'kimi-code', marker: 'mancode:kimi-skill' },
  { platform: 'kimi-code', marker: 'mancode:kimi-code:' },
  { platform: 'qoder', marker: 'mancode:continuity:qoder:' },
  { platform: 'qoder', marker: 'mancode:v3:qoder:' },
  { platform: 'qoder', marker: 'mancode:qoder:' },
  { platform: 'dsh', marker: 'mancode:continuity:dsh:' },
  { platform: 'dsh', marker: 'mancode:v3:dsh:' },
  { platform: 'dsh', marker: 'mancode:dsh-skill' },
  { platform: 'dsh', marker: 'mancode:dsh:' },
  { platform: 'copilot', marker: 'mancode:continuity:copilot:' },
  { platform: 'copilot', marker: 'mancode:v3:copilot:' },
  { platform: 'copilot', marker: 'mancode:copilot:' },
  { platform: 'cursor', marker: 'mancode:cursor-rule' },
  { platform: 'cursor', marker: 'mancode:continuity:cursor:' },
  { platform: 'cursor', marker: 'mancode:v3:cursor:' },
];

/** The original generic block was platform-specific by file location. */
const LEGACY_GENERIC_BLOCK_EVIDENCE: ReadonlyArray<{
  platform: ManagedAdapter;
  relativePath: string;
}> = [
  { platform: 'codex', relativePath: 'AGENTS.md' },
  { platform: 'copilot', relativePath: '.github/copilot-instructions.md' },
];
const LEGACY_GENERIC_MANAGED_MARKER =
  '<!-- Managed by mancode. Do not edit this block manually. -->';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STAGE_STATES = new Set<MigrationStageState>([
  'staged',
  'activated',
  'rolled_back',
]);

export function dualReadBootstrapStatePath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    DUAL_READ_BOOTSTRAP_STATE_RELATIVE,
  );
}

export function dualReadBootstrapLockPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    DUAL_READ_BOOTSTRAP_LOCK_RELATIVE,
  );
}

export function dualReadBootstrapStagingPath(
  projectRoot: string,
  operationId: Ulid,
): string {
  assertUlid(operationId, 'dual-read bootstrap operationId');
  return path.join(
    path.resolve(projectRoot),
    `${DUAL_READ_BOOTSTRAP_STAGING_PREFIX}${operationId}`,
  );
}

/**
 * Performs the same source scan and parity rendering as staging, but writes
 * nothing.  This is the only migration entry point safe to run against an
 * unknown checkout without first creating V3 compatibility files.
 */
export async function dryRunLegacyMigration(
  projectRoot: string,
  managedAdapters?: ManagedAdapterInventory,
): Promise<MigrationDryRunReportV1> {
  const sourceSet = await loadLegacyMigrationSources(projectRoot);
  const inventory = await resolveMigrationAdapterInventory(
    path.resolve(projectRoot),
    sourceSet,
    { explicit: managedAdapters },
  );
  await inspectDualReadBootstrapForDryRun(
    path.resolve(projectRoot),
    sourceSet,
    inventory,
  );
  const allocator = createDeterministicMigrationIdAllocator(
    migrationSeed(sourceSet),
  );
  const aliases = createAliases(sourceSet.tasks, allocator);
  const rendered = renderTasks(sourceSet, aliases, {}, allocator, new Date());
  return {
    schemaVersion: 1,
    sourceBaseline: sourceSet.baseline,
    sourceInventoryDigest: sourceSet.inventoryDigest,
    managedAdapters: inventory.managedAdapters,
    managedAdaptersDigest: inventory.managedAdaptersDigest,
    adapterEvidenceDigest: inventory.adapterEvidenceDigest,
    aliases,
    tasks: rendered.map((item) => item.stage),
  };
}

/**
 * Creates (or validates) the dual-read compatibility shell and writes a
 * local-only migration stage.  It never updates legacy state/workflow files,
 * and it leaves the manifest in `dual_read`.
 */
export async function stageLegacyMigration(
  input: StageLegacyMigrationInput,
): Promise<MigrationStageV1> {
  const root = path.resolve(input.projectRoot);
  const sourceSet = await loadLegacyMigrationSources(root);
  const now = (input.now ?? new Date()).toISOString();
  const allocator = createDeterministicMigrationIdAllocator(
    migrationSeed(sourceSet),
  );
  const aliases = createAliases(sourceSet.tasks, allocator);
  const stageId = input.stageId ?? createUlid();
  assertUlid(stageId, 'migration stageId');

  // The stage lock is backed by the V3 runtime store, so the first shell must
  // exist before that lock can be acquired. The callback below repeats the
  // inventory resolution against the locked stage and manifest.
  const existingStageHint = await readMigrationStageOrNull(root, stageId);
  if (existingStageHint === null || existingStageHint.state === 'staged') {
    const initialInventory = await resolveMigrationAdapterInventory(
      root,
      sourceSet,
      { stage: existingStageHint, explicit: input.managedAdapters },
    );
    await ensureDualReadShell({
      projectRoot: root,
      sourceSet,
      allocator,
      now,
      minReaderVersion: input.minReaderVersion ?? VERSION,
      minWriterVersion: input.minWriterVersion ?? VERSION,
      managedAdapters: initialInventory.managedAdapters,
    });
  }

  return withMigrationStageLock(root, stageId, async () => {
    const existing = await readMigrationStageOrNull(root, stageId);
    if (existing !== null) {
      if (existing.state !== 'staged') {
        throw new Error('MANCODE_MIGRATION_STAGE_NOT_MUTABLE');
      }
      if (!sameLegacyBaseline(existing.sourceBaseline, sourceSet.baseline)) {
        throw new Error('MANCODE_LEGACY_BASELINE_CHANGED');
      }
      if (existing.sourceInventoryDigest !== sourceSet.inventoryDigest) {
        throw new Error('MANCODE_LEGACY_SOURCE_CHANGED');
      }
      if (!sameAliases(existing.aliases, aliases)) {
        throw new Error('MANCODE_MIGRATION_ALIAS_MAP_CHANGED');
      }
      const inventory = await resolveMigrationAdapterInventory(
        root,
        sourceSet,
        { explicit: input.managedAdapters, stage: existing },
      );
      assertMigrationInventorySnapshot(existing, inventory, sourceSet);
      const shellManifest = await assertDualReadShellReady({
        projectRoot: root,
        sourceSet,
        managedAdapters: inventory.managedAdapters,
      });
      assertDualReadManifestInventory(shellManifest, inventory);
      const rendered = renderTasks(
        sourceSet,
        aliases,
        existing.resolutions,
        allocator,
        new Date(now),
      );
      await writeRenderedTasks(root, rendered);
      const next = parseMigrationStage({
        ...existing,
        revision: existing.revision + 1,
        ...migrationInventoryFields(inventory),
        tasks: rendered.map((item) => item.stage),
        updatedAt: now,
      });
      await writeMigrationStage(root, next);
      return next;
    }

    const inventory = await resolveMigrationAdapterInventory(root, sourceSet, {
      explicit: input.managedAdapters,
    });
    const shellManifest = await assertDualReadShellReady({
      projectRoot: root,
      sourceSet,
      managedAdapters: inventory.managedAdapters,
    });
    assertDualReadManifestInventory(shellManifest, inventory);

    const rendered = renderTasks(
      sourceSet,
      aliases,
      {},
      allocator,
      new Date(now),
    );
    await writeRenderedTasks(root, rendered);
    const stage = parseMigrationStage({
      schemaVersion: 1,
      stageId,
      revision: 1,
      state: 'staged',
      sourceBaseline: sourceSet.baseline,
      sourceInventoryDigest: sourceSet.inventoryDigest,
      ...migrationInventoryFields(inventory),
      aliases,
      resolutions: {},
      tasks: rendered.map((item) => item.stage),
      createdAt: now,
      updatedAt: now,
    });
    await writeMigrationStage(root, stage);
    return stage;
  });
}

/**
 * Resolves only migration-local missing facts.  The legacy source is scanned
 * again and must still match the stage baseline before a candidate is
 * regenerated.  This prevents a resolution from accidentally applying to a
 * different legacy workflow revision.
 */
export async function resolveLegacyMigration(
  input: ResolveLegacyMigrationInput,
): Promise<MigrationStageV1> {
  const root = path.resolve(input.projectRoot);
  assertUlid(input.stageId, 'migration stageId');
  assertLegacyTaskId(input.legacyTaskId);
  if (
    !Number.isSafeInteger(input.expectedStageRevision) ||
    input.expectedStageRevision < 1
  ) {
    throw new Error('MANCODE_MIGRATION_STAGE_REVISION_INVALID');
  }
  if (input.ownerActorId !== undefined) {
    assertUlid(input.ownerActorId, 'migration resolution ownerActorId');
  }
  const scope =
    input.implementationScope === undefined
      ? undefined
      : parseMigrationScopeResolution(input.implementationScope);

  return withMigrationStageLock(root, input.stageId, async () => {
    const stage = await readMigrationStage(root, input.stageId);
    if (stage.state !== 'staged') {
      throw new Error('MANCODE_MIGRATION_STAGE_NOT_MUTABLE');
    }
    if (stage.revision !== input.expectedStageRevision) {
      throw new Error('MANCODE_REVISION_CONFLICT');
    }
    if (stage.aliases[input.legacyTaskId] === undefined) {
      throw new Error('MANCODE_MIGRATION_LEGACY_TASK_NOT_FOUND');
    }
    const sourceSet = await loadLegacyMigrationSources(root);
    if (!sameLegacyBaseline(stage.sourceBaseline, sourceSet.baseline)) {
      throw new Error('MANCODE_LEGACY_BASELINE_CHANGED');
    }
    if (stage.sourceInventoryDigest !== sourceSet.inventoryDigest) {
      throw new Error('MANCODE_LEGACY_SOURCE_CHANGED');
    }
    const inventory = await resolveMigrationAdapterInventory(root, sourceSet, {
      stage,
    });
    assertMigrationInventorySnapshot(stage, inventory, sourceSet);
    const allocator = createDeterministicMigrationIdAllocator(
      migrationSeed(sourceSet),
    );
    const aliases = createAliases(sourceSet.tasks, allocator);
    if (!sameAliases(stage.aliases, aliases)) {
      throw new Error('MANCODE_MIGRATION_ALIAS_MAP_CHANGED');
    }
    const previous = stage.resolutions[input.legacyTaskId] ?? {
      ownerActorId: null,
      implementationScope: null,
    };
    const resolutions: Record<string, MigrationTaskResolutionV1> = {
      ...stage.resolutions,
      [input.legacyTaskId]: parseMigrationTaskResolution({
        ownerActorId: input.ownerActorId ?? previous.ownerActorId,
        implementationScope: scope ?? previous.implementationScope,
      }),
    };
    const now = (input.now ?? new Date()).toISOString();
    const rendered = renderTasks(
      sourceSet,
      aliases,
      resolutions,
      allocator,
      new Date(now),
    );
    await writeRenderedTasks(root, rendered);
    const next = parseMigrationStage({
      ...stage,
      revision: stage.revision + 1,
      ...migrationInventoryFields(inventory),
      resolutions,
      tasks: rendered.map((item) => item.stage),
      updatedAt: now,
    });
    await writeMigrationStage(root, next);
    return next;
  });
}

/**
 * Promotes a frozen, parity-checked migration stage through a single
 * write-ahead operation. All content is rendered again under the canonical
 * stage lock, so activation never trusts mutable quarantine files alone.
 */
export async function activateLegacyMigration(
  input: ActivateLegacyMigrationInput,
): Promise<ActivatedLegacyMigration> {
  const root = path.resolve(input.projectRoot);
  assertUlid(input.stageId, 'migration stageId');
  assertUlid(input.sessionId, 'migration activation sessionId');
  if (
    !Number.isSafeInteger(input.expectedStageRevision) ||
    input.expectedStageRevision < 1
  ) {
    throw new Error('MANCODE_MIGRATION_STAGE_REVISION_INVALID');
  }
  if (input.explicitConfirmation !== true) {
    throw new Error('MANCODE_EXPLICIT_CONFIRMATION_REQUIRED');
  }
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(operationId, 'migration activation operationId');

  return withMigrationStageLock(root, input.stageId, async () => {
    const runtime = await ensureProjectRuntimeContext(root, now);
    const localStore = resolveLocalEntityHomeStore(
      runtime.entityHomeStoreContext,
    );
    const coordinationStore = resolveCoordinationEntityHomeStore(
      runtime.entityHomeStoreContext,
    );
    const session = await readSession(root, input.sessionId);
    if (session === null || session.status !== 'active') {
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    }
    const store = new (await import('./store.js')).V3ContextStore(root);
    const project = await store.readProjectSnapshot();
    const stage = await readMigrationStage(root, input.stageId);
    if (
      stage.state !== 'staged' ||
      stage.revision !== input.expectedStageRevision
    ) {
      throw new Error(
        stage.state !== 'staged'
          ? 'MANCODE_MIGRATION_STAGE_NOT_MUTABLE'
          : 'MANCODE_REVISION_CONFLICT',
      );
    }
    if (project.manifest.activationState !== 'dual_read') {
      throw new Error('MANCODE_MIGRATION_MANIFEST_STATE_INVALID');
    }
    const sourceSet = await loadLegacyMigrationSources(root);
    if (
      !sameLegacyBaseline(stage.sourceBaseline, sourceSet.baseline) ||
      stage.sourceInventoryDigest !== sourceSet.inventoryDigest ||
      !sameLegacyBaseline(project.manifest.legacyBaseline, sourceSet.baseline)
    ) {
      throw new Error('MANCODE_LEGACY_BASELINE_CHANGED');
    }
    const inventory = await resolveMigrationAdapterInventory(root, sourceSet, {
      stage,
    });
    assertMigrationInventorySnapshot(stage, inventory, sourceSet);
    assertDualReadManifestInventory(project.manifest, inventory);
    const allocator = createDeterministicMigrationIdAllocator(
      migrationSeed(sourceSet),
    );
    const aliases = createAliases(sourceSet.tasks, allocator);
    if (!sameAliases(stage.aliases, aliases)) {
      throw new Error('MANCODE_MIGRATION_ALIAS_MAP_CHANGED');
    }
    const rendered = renderTasks(
      sourceSet,
      aliases,
      stage.resolutions,
      allocator,
      now,
    );
    assertRenderedMatchesStage(rendered, stage);
    for (const item of rendered) {
      if (
        item.candidate === null ||
        item.report === null ||
        item.stage.state !== 'ready' ||
        item.stage.privacyStatus !== 'passed'
      ) {
        throw new Error('MANCODE_MIGRATION_ACTIVATION_BLOCKED');
      }
      assertMigrationParity(item.report);
    }
    const shared = rendered.filter(
      (item) => item.stage.taskRef.namespace === 'shared',
    );
    if (shared.length > 0 && input.sharedPrivacyConfirmed !== true) {
      throw new Error('MANCODE_PRIVACY_CONFIRMATION_REQUIRED');
    }
    const joined =
      (await readSharedActorProfile(root, session.actorId)) !== null;
    const authorizationBasis = createAuthorizationBasis(
      {
        action: 'team_policy_config_transport',
        actorId: session.actorId,
        session: {
          sessionId: session.sessionId,
          actorId: session.actorId,
          status: session.status,
        },
        joined,
        sharedWriteGuard: capabilitiesFromProjectConfig(project.config)
          .writeGuard,
        task: null,
        claim: null,
        handoff: null,
        evidence: null,
        profileActorId: null,
        conditions: {
          expectedRevisionMatches: true,
          explicitConfirmation: true,
          privacyConfirmed: shared.length === 0 || input.sharedPrivacyConfirmed,
        },
      },
      now,
    );
    const codeHead =
      shared.length === 0 ? null : await readCheckoutCodeHead(root);
    if (shared.length > 0 && codeHead === null) {
      throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
    }
    const selectedPlatforms = managedAdapterNames(inventory.managedAdapters);
    const adapterPlans =
      selectedPlatforms.length === 0
        ? []
        : await planV3AdapterUpgradeFiles(root, selectedPlatforms);
    const entities = buildActivationEntities(
      rendered,
      runtime,
      operationId,
      now,
      codeHead,
    );
    await assertActivationTargetsAbsent(root, coordinationStore, entities);

    const locks = activationLockKeys(input.stageId, entities, adapterPlans);
    const primaryStore = shared.length > 0 ? coordinationStore : localStore;
    const secondaryStores =
      primaryStore.storeId === localStore.storeId ? [] : [localStore];
    const expectedRevisions: Record<string, number> = {
      'schema:project': 1,
      'config:project': project.config.revision,
      [`stage:${stage.stageId}`]: stage.revision,
      ...Object.fromEntries(
        adapterPlans.map((plan) => [`adapter:${plan.target}`, 0]),
      ),
      ...Object.fromEntries(
        entities.map((entity) => [taskEntityKey(entity.taskRef), 0]),
      ),
      ...Object.fromEntries(
        entities
          .filter((entity) => entity.taskRef.namespace === 'shared')
          .map((entity) => [taskHeadEntityKey(entity.taskRef), 0]),
      ),
    };
    const manifestActivating = parseSchemaManifest({
      ...project.manifest,
      activationState: 'activating',
      lastOperationId: operationId,
    });
    assertSchemaManifestTransition(project.manifest, manifestActivating);
    const manifestActive = parseSchemaManifest({
      ...manifestActivating,
      activationState: 'v3_active',
      activatedAt: now.toISOString(),
      managedAdapters: Object.fromEntries(
        selectedPlatforms.map((adapter) => [adapter, V3_ADAPTER_VERSION]),
      ) as ManagedAdapterInventory,
    });
    assertSchemaManifestTransition(manifestActivating, manifestActive);
    const activatedConfig = parseProjectConfig({
      ...project.config,
      revision: project.config.revision + 1,
      lastOperationId: operationId,
      updatedAt: now.toISOString(),
    });
    assertProjectConfigTransition(project.config, activatedConfig, 'ordinary');
    const activatedStage = parseMigrationStage({
      ...stage,
      revision: stage.revision + 1,
      state: 'activated',
      ...migrationInventoryFields(inventory),
      updatedAt: now.toISOString(),
    });
    const payload = parseOperationRecoveryPayload({
      schemaVersion: 1,
      operationId,
      type: 'v3_activate',
      primaryStoreId: primaryStore.storeId,
      actions: [
        createProjectAuthorityFileRecoveryAction({
          stepId: 'mark-manifest-activating',
          fileName: 'schema.json',
          beforeContent: serialize(project.manifest),
          targetContent: serialize(manifestActivating),
        }),
        ...(await Promise.all(
          adapterPlans.map(async (plan) =>
            createV3AdapterFileRecoveryAction({
              stepId: 'replace-managed-adapters',
              target: plan.target,
              beforeContent: plan.beforeContent,
              targetContent: plan.targetContent,
              resolvedTarget: plan.resolvedTarget,
              linkIdentities: plan.linkIdentities,
              ...(plan.beforeContent === null
                ? {
                    absentParentDirectories:
                      await absentAdapterParentDirectories(root, plan.target),
                  }
                : {}),
            }),
          ),
        )),
        ...entities.flatMap((entity) => [
          createMigrationTaskDirectoryRecoveryAction({
            stepId: 'promote-staged-tasks',
            taskRef: entity.taskRef,
            files: entity.files,
            reports: entity.reports,
          }),
          ...(entity.taskHead === null
            ? []
            : [
                createTaskHeadFenceRecoveryAction({
                  stepId: 'promote-staged-tasks',
                  before: null,
                  fence: entity.taskHead,
                }),
              ]),
        ]),
        createProjectAuthorityFileRecoveryAction({
          stepId: 'record-adapter-inventory-and-baseline',
          fileName: 'shared/config.json',
          beforeContent: serialize(project.config),
          targetContent: serialize(activatedConfig),
        }),
        createProjectAuthorityFileRecoveryAction({
          stepId: 'activate-manifest',
          fileName: 'schema.json',
          beforeContent: serialize(manifestActivating),
          targetContent: serialize(manifestActive),
        }),
        createMigrationStageFileRecoveryAction({
          stepId: 'activate-manifest',
          stageId: stage.stageId,
          beforeContent: serialize(stage),
          targetContent: serialize(activatedStage),
        }),
      ],
      noOpStepIds: [],
    });
    let journal: OperationJournalV1 = withOperationReservationDigests({
      schemaVersion: 1,
      operationId,
      type: 'v3_activate',
      state: 'prepared',
      primaryStoreId: primaryStore.storeId,
      checkoutId: runtime.checkoutId,
      secondaryReservations: secondaryStores.map((store) => ({
        storeId: store.storeId,
        entityKeys: locks.local,
        journalDigest: '',
      })),
      actorId: session.actorId,
      sessionId: session.sessionId,
      authorizationBasis,
      recoveryPayloadDigest: operationRecoveryPayloadDigest(payload),
      entityLocks: uniqueLockKeys([...locks.local, ...locks.shared]),
      expectedRevisions,
      steps: getOperationDefinition('v3_activate').steps.map((step) => ({
        id: step.id,
        state: 'pending',
      })),
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    assertOperationJournalMatchesDefinition(journal);
    assertOperationRecoveryPayloadCoversJournal(journal, payload);
    const operationLocks = await acquireOperationEntityLocks(
      operationId,
      [
        {
          store: localStore,
          entityLockKeys: locks.local.filter(
            (key) => key !== `stage:${stage.stageId}`,
          ),
        },
        ...(locks.shared.length === 0
          ? []
          : [{ store: coordinationStore, entityLockKeys: locks.shared }]),
      ],
      { now },
    );

    try {
      const lockedProject = await store.readProjectSnapshot();
      const lockedStage = await readMigrationStage(root, stage.stageId);
      if (
        lockedProject.fingerprint !== project.fingerprint ||
        lockedStage.revision !== stage.revision
      ) {
        throw new Error('MANCODE_REVISION_CONFLICT');
      }
      await writeOperationRecoveryPayload(primaryStore, payload);
      await prepareOperationStores({
        primaryStore,
        journal,
        secondaryStores,
        now,
      });
      throwIfOperationCrashInjected('v3_activate', 'prepared');
      journal = await completeActivationStep(
        primaryStore,
        journal,
        'validate-staged-migration',
        now,
      );
      journal = await completeActivationStep(
        primaryStore,
        journal,
        'mark-manifest-activating',
        now,
      );
      await writeTextAtomic(
        path.join(root, '.mancode', 'schema.json'),
        serialize(manifestActivating),
      );
      journal = await completeActivationStep(
        primaryStore,
        journal,
        'replace-managed-adapters',
        now,
      );
      for (const action of payload.actions.filter(
        (action) => action.kind === 'v3_adapter_file',
      )) {
        const { applyV3AdapterFilePlan } = await import(
          '../installers/v3-adapter.js'
        );
        await applyV3AdapterFilePlan(root, action);
      }
      journal = await completeActivationStep(
        primaryStore,
        journal,
        'promote-staged-tasks',
        now,
      );
      await publishActivationTasks(
        root,
        coordinationStore,
        operationId,
        entities,
      );
      journal = await completeActivationStep(
        primaryStore,
        journal,
        'record-adapter-inventory-and-baseline',
        now,
      );
      await writeTextAtomic(
        path.join(root, '.mancode', 'shared', 'config.json'),
        serialize(activatedConfig),
      );
      journal = await completeActivationStep(
        primaryStore,
        journal,
        'activate-manifest',
        now,
      );
      await writeTextAtomic(
        path.join(root, '.mancode', 'schema.json'),
        serialize(manifestActive),
      );
      await writeMigrationStage(root, activatedStage);
      journal = await completeActivationStep(
        primaryStore,
        journal,
        'commit',
        now,
        'committed',
      );
      throwIfOperationCrashInjected('v3_activate', 'commit');
      return {
        manifest: manifestActive,
        stage: activatedStage,
        operation: journal,
      };
    } catch (error) {
      if (journal.state !== 'committed') {
        await updateOperationJournal(
          primaryStore,
          {
            ...journal,
            state: 'repair_required',
            updatedAt: now.toISOString(),
          },
          { canAbort: false },
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      await Promise.allSettled(operationLocks.map((lock) => lock.release()));
    }
  });
}

/**
 * Reverses an activation only when the exact activation snapshot still proves
 * that no later V3 authority write occurred. Any drift is a forward-repair
 * boundary, never an excuse to delete user data.
 */
export async function rollbackLegacyMigration(
  input: RollbackLegacyMigrationInput,
): Promise<RolledBackLegacyMigration> {
  const root = path.resolve(input.projectRoot);
  assertUlid(input.operationId, 'migration rollback operationId');
  assertUlid(input.sessionId, 'migration rollback sessionId');
  if (input.explicitConfirmation !== true) {
    throw new Error('MANCODE_EXPLICIT_CONFIRMATION_REQUIRED');
  }
  const now = input.now ?? new Date();
  const runtime = await ensureProjectRuntimeContext(root, now);
  const localStore = resolveLocalEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const coordinationStore = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const session = await readSession(root, input.sessionId);
  if (session === null || session.status !== 'active') {
    throw new Error('MANCODE_SESSION_NOT_FOUND');
  }
  const activation =
    (await readOperationJournal(localStore, input.operationId)) ??
    (await readOperationJournal(coordinationStore, input.operationId));
  if (
    activation === null ||
    activation.type !== 'v3_activate' ||
    activation.state !== 'committed' ||
    activation.actorId !== session.actorId
  ) {
    throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
  }
  const primaryStore =
    activation.primaryStoreId === localStore.storeId
      ? localStore
      : coordinationStore;
  const payload = await readOperationRecoveryPayload(
    primaryStore,
    input.operationId,
  );
  if (
    payload === null ||
    operationRecoveryPayloadDigest(payload) !== activation.recoveryPayloadDigest
  ) {
    throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
  }
  const parsed = parseOperationRecoveryPayload(payload);
  assertOperationRecoveryPayloadCoversJournal(activation, parsed);
  await assertActivationRollbackProof(
    root,
    localStore,
    coordinationStore,
    activation,
    parsed,
  );
  const activeManifest = parseSchemaManifest(
    JSON.parse(
      await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ),
  );
  const manifestAction = parsed.actions.find(
    (action) =>
      action.kind === 'project_authority_file' &&
      action.stepId === 'mark-manifest-activating' &&
      action.fileName === 'schema.json',
  );
  const stageAction = parsed.actions.find(
    (action) =>
      action.kind === 'migration_stage_file' &&
      action.stepId === 'activate-manifest',
  );
  if (
    manifestAction?.kind !== 'project_authority_file' ||
    manifestAction.beforeContent === null ||
    stageAction?.kind !== 'migration_stage_file' ||
    stageAction.beforeContent === null
  ) {
    throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
  }
  const dualReadManifest = parseSchemaManifest(
    JSON.parse(manifestAction.beforeContent),
  );
  assertActivationRollbackManifestTransition(activeManifest, dualReadManifest);
  const staged = parseMigrationStage(JSON.parse(stageAction.beforeContent));
  const rolledBackStage = parseMigrationStage({
    ...staged,
    revision: staged.revision + 1,
    state: 'rolled_back',
    updatedAt: now.toISOString(),
  });

  for (const action of parsed.actions) {
    if (action.kind === 'migration_task_directory') {
      await rm(taskRootPath(root, action.taskRef), {
        recursive: true,
        force: false,
      });
    } else if (action.kind === 'task_head_fence') {
      const target = path.join(
        coordinationStore.root,
        'task-heads',
        `${action.fence.taskRef.taskId}.json`,
      );
      await rm(target, { force: false });
    } else if (action.kind === 'v3_adapter_file') {
      await assertV3AdapterTargetSafe(root, action.target);
      if (action.beforeContent === null) {
        const target = v3AdapterTargetPath(root, action.target);
        await rm(target, { force: false });
      } else {
        await applyV3AdapterFilePlan(root, {
          target: action.target,
          beforeContent: action.targetContent,
          targetContent: action.beforeContent,
          resolvedTarget: action.resolvedTarget,
          linkIdentities: action.linkIdentities,
        });
      }
    } else if (
      action.kind === 'project_authority_file' &&
      action.fileName === 'shared/config.json' &&
      action.beforeContent !== null
    ) {
      await writeTextAtomic(
        path.join(root, '.mancode', 'shared', 'config.json'),
        action.beforeContent,
      );
    }
  }
  await removeEmptyActivationParents(root, parsed);
  await writeTextAtomic(
    path.join(root, '.mancode', 'schema.json'),
    serialize(dualReadManifest),
  );
  await writeMigrationStage(root, rolledBackStage);
  return {
    manifest: dualReadManifest,
    stage: rolledBackStage,
    operation: activation,
  };
}

async function absentAdapterParentDirectories(
  root: string,
  target: Parameters<typeof v3AdapterTargetPath>[1],
): Promise<string[]> {
  const absent: string[] = [];
  let directory = path.dirname(v3AdapterTargetPath(root, target));
  while (directory !== root && isWithinRoot(root, directory)) {
    const entry = await lstatOrNullMigration(directory);
    if (entry !== null) break;
    absent.push(relativeMigrationPath(root, directory));
    directory = path.dirname(directory);
  }
  return absent;
}

async function removeEmptyActivationParents(
  root: string,
  payload: ReturnType<typeof parseOperationRecoveryPayload>,
): Promise<void> {
  const parents = new Set(
    payload.actions.flatMap((action) =>
      action.kind === 'v3_adapter_file'
        ? (action.absentParentDirectories ?? [])
        : [],
    ),
  );
  for (const parent of [...parents].sort(
    (a, b) => b.split('/').length - a.split('/').length,
  )) {
    let directory = root;
    let safe = true;
    for (const segment of parent.split('/')) {
      directory = path.join(directory, segment);
      const entry = await lstatOrNullMigration(directory);
      if (entry === null || entry.isSymbolicLink() || !entry.isDirectory()) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    try {
      // Never recursively delete: new user content and preexisting directories
      // must survive even when they prevent restoration of the old evidence.
      await rmdir(directory);
    } catch (error) {
      if (
        isNotFound(error) ||
        (error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOTEMPTY' || error.code === 'EEXIST'))
      )
        continue;
      throw error;
    }
  }
}

interface ActivationTaskEntity {
  taskRef: TaskRef;
  files: Array<{
    fileName:
      | 'metadata.json'
      | 'requirements.json'
      | 'review-ledger.json'
      | 'verification-ledger.json'
      | 'plan.md';
    content: string;
  }>;
  reports: Array<{
    kind: 'review_report' | 'evidence_summary';
    artifactId: Ulid;
    content: string;
  }>;
  taskHead: TaskHeadFenceV1 | null;
}

function buildActivationEntities(
  rendered: RenderedTask[],
  runtime: Awaited<ReturnType<typeof ensureProjectRuntimeContext>>,
  operationId: Ulid,
  now: Date,
  codeHead: string | null,
): ActivationTaskEntity[] {
  return rendered.map((item) => {
    if (item.candidate === null) {
      throw new Error('MANCODE_MIGRATION_ACTIVATION_BLOCKED');
    }
    const timestamp = now.toISOString();
    const metadata = parseWorkflowMetadata({
      ...item.candidate.metadata,
      lastOperationId: operationId,
      updatedAt: timestamp,
    });
    const requirements = parseRequirementsLedger({
      ...item.candidate.requirements,
      lastOperationId: operationId,
      updatedAt: timestamp,
    });
    const review = parseReviewLedger({
      ...item.candidate.review,
      lastOperationId: operationId,
      updatedAt: timestamp,
    });
    const verification = parseVerificationLedger({
      ...item.candidate.verification,
      lastOperationId: operationId,
      updatedAt: timestamp,
    });
    const plan = item.sourceFiles.find(
      (file) => file.relativePath === 'artifacts/plan.md',
    );
    const sourceByPath = new Map(
      item.sourceFiles
        .filter((file) => file.relativePath.startsWith('artifacts/'))
        .map((file) => [
          file.relativePath.slice('artifacts/'.length),
          file.content,
        ]),
    );
    const reports = item.candidate.artifactAliases.map((alias) => {
      const content = sourceByPath.get(alias.legacyPath);
      if (content === undefined || alias.artifactRef.artifactId === undefined) {
        throw new Error('MANCODE_MIGRATION_REFERENCED_ARTIFACT_MISSING');
      }
      if (
        alias.artifactRef.kind !== 'review_report' &&
        alias.artifactRef.kind !== 'evidence_summary'
      ) {
        throw new Error('MANCODE_MIGRATION_ARTIFACT_PATH_UNSAFE');
      }
      return {
        kind: alias.artifactRef.kind,
        artifactId: alias.artifactRef.artifactId,
        content,
      };
    });
    const files: ActivationTaskEntity['files'] = [
      { fileName: 'metadata.json', content: serialize(metadata) },
      { fileName: 'requirements.json', content: serialize(requirements) },
      { fileName: 'review-ledger.json', content: serialize(review) },
      {
        fileName: 'verification-ledger.json',
        content: serialize(verification),
      },
      ...(plan === undefined
        ? []
        : [{ fileName: 'plan.md' as const, content: plan.content }]),
    ];
    const aggregate = buildTaskAggregateManifest({
      metadata,
      requirements,
      review,
      verification,
      planDigest:
        plan === undefined
          ? null
          : digestCanonicalJson({
              artifactRef: { taskRef: metadata.taskRef, kind: 'plan' },
              content: plan.content,
            }),
      latestCheckpoint: null,
    });
    const taskHead =
      metadata.taskRef.namespace === 'shared'
        ? (() => {
            if (codeHead === null) {
              throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
            }
            return {
              schemaVersion: 1 as const,
              workspaceId: runtime.workspaceId,
              taskRef: metadata.taskRef,
              fenceRevision: 1,
              taskRevision: metadata.revision,
              aggregateDigest: taskAggregateDigest(aggregate),
              ownershipEpoch: metadata.ownershipEpoch,
              codeRef: { head: codeHead },
              checkoutId: runtime.checkoutId,
              remoteRevision: null,
              lastOperationId: operationId,
              updatedAt: timestamp,
            } satisfies TaskHeadFenceV1;
          })()
        : null;
    return { taskRef: metadata.taskRef, files, reports, taskHead };
  });
}

function assertRenderedMatchesStage(
  rendered: RenderedTask[],
  stage: MigrationStageV1,
): void {
  if (rendered.length !== stage.tasks.length) {
    throw new Error('MANCODE_MIGRATION_STAGE_CANDIDATE_CHANGED');
  }
  const byLegacyId = new Map(
    stage.tasks.map((task) => [task.legacyTaskId, task]),
  );
  for (const item of rendered) {
    const staged = byLegacyId.get(item.stage.legacyTaskId);
    if (
      staged === undefined ||
      staged.state !== item.stage.state ||
      staged.candidateDigest !== item.stage.candidateDigest ||
      staged.parityDigest !== item.stage.parityDigest ||
      staged.privacyStatus !== item.stage.privacyStatus ||
      staged.quarantineId !== item.stage.quarantineId ||
      !sameTaskRefValue(staged.taskRef, item.stage.taskRef) ||
      JSON.stringify(staged.blockers) !== JSON.stringify(item.stage.blockers)
    ) {
      throw new Error('MANCODE_MIGRATION_STAGE_CANDIDATE_CHANGED');
    }
  }
}

function activationLockKeys(
  stageId: Ulid,
  entities: ActivationTaskEntity[],
  adapters: Awaited<ReturnType<typeof planV3AdapterFiles>>,
): { local: string[]; shared: string[] } {
  const local = [
    'schema:project',
    'config:project',
    `stage:${stageId}`,
    ...adapters.map((plan) => `adapter:${plan.target}`),
    ...entities
      .filter((entity) => entity.taskRef.namespace === 'local')
      .map((entity) => taskEntityKey(entity.taskRef)),
  ];
  const shared = entities
    .filter((entity) => entity.taskRef.namespace === 'shared')
    .flatMap((entity) => [
      taskEntityKey(entity.taskRef),
      taskHeadEntityKey(entity.taskRef),
    ]);
  return {
    local: uniqueLockKeys(local),
    shared: uniqueLockKeys(shared),
  };
}

async function assertActivationTargetsAbsent(
  projectRoot: string,
  coordinationStore: ReturnType<typeof resolveCoordinationEntityHomeStore>,
  entities: ActivationTaskEntity[],
): Promise<void> {
  for (const entity of entities) {
    try {
      await lstat(taskRootPath(projectRoot, entity.taskRef));
      throw new Error('MANCODE_MIGRATION_DESTINATION_EXISTS');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (
      entity.taskHead !== null &&
      (await readTaskHeadFence(coordinationStore, entity.taskRef)) !== null
    ) {
      throw new Error('MANCODE_MIGRATION_DESTINATION_EXISTS');
    }
  }
}

async function publishActivationTasks(
  projectRoot: string,
  coordinationStore: ReturnType<typeof resolveCoordinationEntityHomeStore>,
  operationId: Ulid,
  entities: ActivationTaskEntity[],
): Promise<void> {
  for (const entity of entities) {
    const target = taskRootPath(projectRoot, entity.taskRef);
    const parent = await ensureActivationTaskParent(
      projectRoot,
      entity.taskRef,
    );
    const staging = path.join(
      parent,
      `.${entity.taskRef.taskId}.${operationId}.staging`,
    );
    try {
      await mkdir(staging);
      for (const file of entity.files) {
        await writeFile(path.join(staging, file.fileName), file.content, {
          encoding: 'utf8',
          flag: 'wx',
        });
      }
      if (entity.reports.length > 0) {
        const reports = path.join(staging, 'reports');
        await mkdir(reports);
        for (const report of entity.reports) {
          const name =
            report.kind === 'review_report'
              ? `${report.artifactId}.md`
              : `evidence-${report.artifactId}.md`;
          await writeFile(path.join(reports, name), report.content, {
            encoding: 'utf8',
            flag: 'wx',
          });
        }
      }
      await rename(staging, target);
      if (entity.taskHead !== null) {
        await createTaskHeadFence(coordinationStore, entity.taskHead);
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }
}

async function ensureActivationTaskParent(
  projectRoot: string,
  taskRef: TaskRef,
): Promise<string> {
  let current = path.resolve(projectRoot);
  const root = await lstat(current);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  for (const segment of ['.mancode', taskRef.namespace, 'workflows']) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await mkdir(current);
    }
  }
  return current;
}

async function completeActivationStep(
  primaryStore: ReturnType<typeof resolveLocalEntityHomeStore>,
  journal: OperationJournalV1,
  stepId: string,
  now: Date,
  state: OperationJournalV1['state'] = 'applying',
): Promise<OperationJournalV1> {
  throwIfDeferredOperationCrashInjected(journal.type);
  const index = journal.steps.findIndex((step) => step.id === stepId);
  if (
    index < 0 ||
    journal.steps.slice(0, index).some((step) => step.state !== 'completed')
  ) {
    throw new Error('MANCODE_OPERATION_STEP_ORDER_INVALID');
  }
  const completed = await updateOperationJournal(
    primaryStore,
    {
      ...journal,
      state,
      steps: journal.steps.map((step, current) =>
        current === index ? { ...step, state: 'completed' as const } : step,
      ),
      updatedAt: now.toISOString(),
    },
    { canAbort: false },
  );
  const step = getOperationDefinition(journal.type).steps[index];
  if (step?.visibility === 'business_write') {
    armOperationCrashAfterVisibleWrite(journal.type, stepId);
  } else if (step?.visibility === 'preparation') {
    throwIfOperationCrashInjected(journal.type, stepId);
  }
  return completed;
}

function uniqueLockKeys(keys: string[]): string[] {
  return [...new Set(keys)].sort((left, right) =>
    Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
  );
}

async function assertActivationRollbackProof(
  projectRoot: string,
  localStore: ReturnType<typeof resolveLocalEntityHomeStore>,
  coordinationStore: ReturnType<typeof resolveCoordinationEntityHomeStore>,
  activation: OperationJournalV1,
  payload: ReturnType<typeof parseOperationRecoveryPayload>,
): Promise<void> {
  for (const store of [localStore, coordinationStore]) {
    let entries: string[];
    try {
      entries = await readdir(operationDirectory(store));
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if (
      entries.some(
        (entry) =>
          entry.endsWith('.json') && entry !== `${activation.operationId}.json`,
      )
    ) {
      throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
    }
  }
  const projectTargets = new Map<string, string>();
  for (const action of payload.actions) {
    if (action.kind === 'project_authority_file') {
      projectTargets.set(action.fileName, action.targetContent);
    }
  }
  for (const [fileName, targetContent] of projectTargets) {
    const current = await readFile(
      path.join(projectRoot, '.mancode', ...fileName.split('/')),
      'utf8',
    );
    if (current !== targetContent) {
      throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
    }
  }
  for (const action of payload.actions) {
    if (action.kind === 'migration_stage_file') {
      const current = await readFile(
        migrationStagePath(projectRoot, action.stageId),
        'utf8',
      );
      if (current !== action.targetContent) {
        throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
      }
    } else if (action.kind === 'v3_adapter_file') {
      const current = await readV3AdapterFilePlanContent(projectRoot, action);
      if (current !== action.targetContent) {
        throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
      }
    } else if (action.kind === 'migration_task_directory') {
      await assertMigrationDirectoryMatches(projectRoot, action);
    } else if (action.kind === 'task_head_fence') {
      const fence = await readTaskHeadFence(
        coordinationStore,
        action.fence.taskRef,
      );
      if (fence === null || serialize(fence) !== serialize(action.fence)) {
        throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
      }
    }
  }
}

async function assertMigrationDirectoryMatches(
  projectRoot: string,
  action: Extract<
    ReturnType<typeof parseOperationRecoveryPayload>['actions'][number],
    { kind: 'migration_task_directory' }
  >,
): Promise<void> {
  const root = taskRootPath(projectRoot, action.taskRef);
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(root);
  } catch {
    throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
  }
  const expectedRoot = new Set([
    ...action.files.map((file) => file.fileName),
    ...(action.reports.length === 0 ? [] : ['reports']),
  ]);
  const entries = await readdir(root);
  if (
    entries.length !== expectedRoot.size ||
    entries.some((name) => !expectedRoot.has(name))
  ) {
    throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
  }
  for (const file of action.files) {
    if (
      (await readFile(path.join(root, file.fileName), 'utf8')) !== file.content
    ) {
      throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
    }
  }
  if (action.reports.length > 0) {
    const reportsRoot = path.join(root, 'reports');
    const reportDirectory = await lstat(reportsRoot);
    const expectedReports = new Set(
      action.reports.map((report) =>
        report.kind === 'review_report'
          ? `${report.artifactId}.md`
          : `evidence-${report.artifactId}.md`,
      ),
    );
    const reports = await readdir(reportsRoot);
    if (
      !reportDirectory.isDirectory() ||
      reportDirectory.isSymbolicLink() ||
      reports.length !== expectedReports.size ||
      reports.some((name) => !expectedReports.has(name))
    ) {
      throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
    }
    for (const report of action.reports) {
      const name =
        report.kind === 'review_report'
          ? `${report.artifactId}.md`
          : `evidence-${report.artifactId}.md`;
      if (
        (await readFile(path.join(reportsRoot, name), 'utf8')) !==
        report.content
      ) {
        throw new Error('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
      }
    }
  }
}

export async function readMigrationStage(
  projectRoot: string,
  stageId: Ulid,
): Promise<MigrationStageV1> {
  assertUlid(stageId, 'migration stageId');
  const raw = await readFile(migrationStagePath(projectRoot, stageId), 'utf8');
  try {
    return parseMigrationStage(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_MIGRATION_STAGE_CORRUPT');
    }
    throw error;
  }
}

export async function listMigrationStages(
  projectRoot: string,
): Promise<MigrationStageV1[]> {
  const directory = migrationStagesDirectory(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const stages: MigrationStageV1[] = [];
  for (const entry of entries.sort(compareUtf8)) {
    if (!entry.endsWith('.json')) continue;
    const stageId = entry.slice(0, -'.json'.length);
    assertUlid(stageId, 'migration stage filename');
    stages.push(await readMigrationStage(projectRoot, stageId));
  }
  return stages;
}

export function migrationStagesDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'migration',
    'stages',
  );
}

export function migrationStagePath(projectRoot: string, stageId: Ulid): string {
  assertUlid(stageId, 'migration stageId');
  return path.join(migrationStagesDirectory(projectRoot), `${stageId}.json`);
}

export function parseMigrationStage(value: unknown): MigrationStageV1 {
  assertRecord(value, 'migration stage');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'stageId',
      'revision',
      'state',
      'sourceBaseline',
      'sourceInventoryDigest',
      'managedAdapters',
      'managedAdaptersDigest',
      'adapterEvidenceDigest',
      'aliases',
      'resolutions',
      'tasks',
      'createdAt',
      'updatedAt',
    ],
    'migration stage',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('migration stage schemaVersion must be 1');
  }
  assertUlid(value.stageId, 'migration stage stageId');
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw new Error('migration stage revision must be a positive integer');
  }
  if (
    typeof value.state !== 'string' ||
    !STAGE_STATES.has(value.state as MigrationStageState)
  ) {
    throw new Error('migration stage state is invalid');
  }
  const inventoryFieldNames = [
    value.managedAdapters,
    value.managedAdaptersDigest,
    value.adapterEvidenceDigest,
  ];
  const hasInventoryFields = inventoryFieldNames.some(
    (field) => field !== undefined,
  );
  if (
    hasInventoryFields &&
    inventoryFieldNames.some((field) => field === undefined)
  ) {
    throw new Error('migration stage adapter inventory snapshot is incomplete');
  }
  const inventoryFields = hasInventoryFields
    ? (() => {
        const managedAdapters = parseManagedAdapterInventory(
          value.managedAdapters,
          'migration stage managedAdapters',
        );
        const managedAdaptersDigest = parseDigest(
          value.managedAdaptersDigest,
          'migration stage managedAdaptersDigest',
        );
        if (
          managedAdaptersDigest !==
          managedAdapterInventoryDigest(managedAdapters)
        ) {
          throw new Error('migration stage managedAdaptersDigest is invalid');
        }
        return {
          managedAdapters,
          managedAdaptersDigest,
          adapterEvidenceDigest: parseDigest(
            value.adapterEvidenceDigest,
            'migration stage adapterEvidenceDigest',
          ),
        };
      })()
    : {};
  const aliases = parseAliases(value.aliases);
  const resolutions = parseResolutions(value.resolutions, aliases);
  const tasks = parseStageTasks(value.tasks, aliases);
  if (tasks.length !== Object.keys(aliases).length) {
    throw new Error('migration stage must have exactly one record per alias');
  }
  return {
    schemaVersion: 1,
    stageId: value.stageId,
    revision: value.revision,
    state: value.state as MigrationStageState,
    sourceBaseline: parseLegacyBaseline(value.sourceBaseline),
    sourceInventoryDigest: parseDigest(
      value.sourceInventoryDigest,
      'migration stage sourceInventoryDigest',
    ),
    ...inventoryFields,
    aliases,
    resolutions,
    tasks,
    createdAt: parseTimestamp(value.createdAt, 'migration stage createdAt'),
    updatedAt: parseTimestamp(value.updatedAt, 'migration stage updatedAt'),
  };
}

export function parseDualReadBootstrapState(
  value: unknown,
): DualReadBootstrapStateV1 {
  assertRecord(value, 'dual-read bootstrap state');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'state',
      'sourceBaseline',
      'managedAdapters',
      'managedAdaptersDigest',
      'adapterEvidenceDigest',
      'stagingDirectory',
      'targets',
      'createdAt',
      'updatedAt',
    ],
    'dual-read bootstrap state',
  );
  if (value.schemaVersion !== DUAL_READ_BOOTSTRAP_SCHEMA_VERSION) {
    throw new Error('dual-read bootstrap state schemaVersion is invalid');
  }
  assertUlid(value.operationId, 'dual-read bootstrap state operationId');
  if (
    typeof value.state !== 'string' ||
    !new Set<DualReadBootstrapStateName>([
      'staged',
      'publishing',
      'committed',
      'repair_required',
    ]).has(value.state as DualReadBootstrapStateName)
  ) {
    throw new Error('dual-read bootstrap state state is invalid');
  }
  const managedAdapters = parseManagedAdapterInventory(
    value.managedAdapters,
    'dual-read bootstrap state managedAdapters',
  );
  const managedAdaptersDigest = parseDigest(
    value.managedAdaptersDigest,
    'dual-read bootstrap state managedAdaptersDigest',
  );
  if (
    managedAdaptersDigest !== managedAdapterInventoryDigest(managedAdapters)
  ) {
    throw new Error(
      'dual-read bootstrap state managedAdaptersDigest is invalid',
    );
  }
  const operationId = value.operationId;
  if (value.stagingDirectory !== relativeBootstrapStagingPath(operationId)) {
    throw new Error('dual-read bootstrap state stagingDirectory is invalid');
  }
  if (!Array.isArray(value.targets)) {
    throw new Error('dual-read bootstrap state targets must be an array');
  }
  const targets = value.targets.map((raw) => {
    assertRecord(raw, 'dual-read bootstrap target');
    assertKnownKeys(
      raw,
      ['name', 'relativePath', 'beforeContent', 'targetContent', 'state'],
      'dual-read bootstrap target',
    );
    if (
      raw.name !== 'config' &&
      raw.name !== 'policy' &&
      raw.name !== 'schema'
    ) {
      throw new Error('dual-read bootstrap target name is invalid');
    }
    const spec = DUAL_READ_BOOTSTRAP_TARGET_SPECS.find(
      (candidate) => candidate.name === raw.name,
    );
    if (spec === undefined || raw.relativePath !== spec.relativePath) {
      throw new Error('dual-read bootstrap target relativePath is invalid');
    }
    if (raw.beforeContent !== null && typeof raw.beforeContent !== 'string') {
      throw new Error('dual-read bootstrap target beforeContent is invalid');
    }
    if (typeof raw.targetContent !== 'string' || !raw.targetContent) {
      throw new Error('dual-read bootstrap target targetContent is invalid');
    }
    if (raw.state !== 'pending' && raw.state !== 'published') {
      throw new Error('dual-read bootstrap target state is invalid');
    }
    return {
      name: raw.name as DualReadBootstrapTargetName,
      relativePath: raw.relativePath,
      beforeContent: raw.beforeContent,
      targetContent: raw.targetContent,
      state: raw.state as DualReadBootstrapTargetState,
    } satisfies DualReadBootstrapTargetV1;
  });
  if (
    targets.length !== DUAL_READ_BOOTSTRAP_TARGET_SPECS.length ||
    targets.some(
      (target, index) =>
        target.name !== DUAL_READ_BOOTSTRAP_TARGET_SPECS[index]?.name,
    )
  ) {
    throw new Error('dual-read bootstrap state targets are not ordered');
  }
  const publishedCount = targets.filter(
    (target) => target.state === 'published',
  ).length;
  if (
    targets.some(
      (target, index) =>
        target.state !== (index < publishedCount ? 'published' : 'pending'),
    )
  ) {
    throw new Error('dual-read bootstrap state target publication is invalid');
  }
  if (value.state === 'staged' && publishedCount !== 0) {
    throw new Error('staged dual-read bootstrap state has published targets');
  }
  if (
    value.state === 'committed' &&
    publishedCount !== DUAL_READ_BOOTSTRAP_TARGET_SPECS.length
  ) {
    throw new Error('committed dual-read bootstrap state has pending targets');
  }
  return {
    schemaVersion: 1,
    operationId,
    state: value.state as DualReadBootstrapStateName,
    sourceBaseline: parseLegacyBaseline(value.sourceBaseline),
    managedAdapters,
    managedAdaptersDigest,
    adapterEvidenceDigest: parseDigest(
      value.adapterEvidenceDigest,
      'dual-read bootstrap state adapterEvidenceDigest',
    ),
    stagingDirectory: value.stagingDirectory,
    targets,
    createdAt: parseTimestamp(
      value.createdAt,
      'dual-read bootstrap state createdAt',
    ),
    updatedAt: parseTimestamp(
      value.updatedAt,
      'dual-read bootstrap state updatedAt',
    ),
  };
}

async function resolveMigrationAdapterInventory(
  root: string,
  sourceSet: LegacyMigrationSourceSet,
  options: {
    explicit?: ManagedAdapterInventory;
    stage?: MigrationStageV1 | null;
  },
): Promise<ResolvedMigrationAdapterInventory> {
  const explicit =
    options.explicit === undefined
      ? undefined
      : parseManagedAdapterInventory(
          options.explicit,
          'migration managedAdapters selection',
        );
  const stageInventory =
    options.stage?.managedAdapters === undefined
      ? undefined
      : parseManagedAdapterInventory(
          options.stage.managedAdapters,
          'migration stage managedAdapters',
        );
  const manifest = await readSchemaManifestOrNull(root);

  if (manifest !== null) {
    const inventory = parseManagedAdapterInventory(
      manifest.managedAdapters,
      'schema manifest managedAdapters',
    );
    assertOptionalInventoryMatches(explicit, inventory);
    assertOptionalInventoryMatches(stageInventory, inventory);
    return resolvedMigrationInventory(
      inventory,
      sourceSet.adapterEvidenceDigest,
      'manifest',
    );
  }
  if (explicit !== undefined) {
    assertOptionalInventoryMatches(explicit, stageInventory);
    return resolvedMigrationInventory(
      explicit,
      sourceSet.adapterEvidenceDigest,
      'explicit',
    );
  }
  if (stageInventory !== undefined) {
    return resolvedMigrationInventory(
      stageInventory,
      sourceSet.adapterEvidenceDigest,
      'stage',
    );
  }
  if (Object.keys(sourceSet.inferredManagedAdapters).length === 0) {
    throw new Error('MANCODE_MIGRATION_ADAPTER_INVENTORY_REQUIRED');
  }
  return resolvedMigrationInventory(
    sourceSet.inferredManagedAdapters,
    sourceSet.adapterEvidenceDigest,
    'legacy-evidence',
  );
}

function resolvedMigrationInventory(
  managedAdapters: ManagedAdapterInventory,
  adapterEvidenceDigest: string,
  source: MigrationAdapterInventorySource,
): ResolvedMigrationAdapterInventory {
  const normalized = parseManagedAdapterInventory(
    managedAdapters,
    'migration managedAdapters',
  );
  return {
    managedAdapters: normalized,
    managedAdaptersDigest: managedAdapterInventoryDigest(normalized),
    adapterEvidenceDigest,
    source,
  };
}

function assertOptionalInventoryMatches(
  expected: ManagedAdapterInventory | undefined,
  actual: ManagedAdapterInventory | undefined,
): void {
  if (
    expected !== undefined &&
    actual !== undefined &&
    !managedAdapterInventoriesMatch(expected, actual)
  ) {
    throw new Error('MANCODE_MIGRATION_ADAPTER_INVENTORY_CONFLICT');
  }
}

function assertMigrationInventorySnapshot(
  stage: MigrationStageV1,
  inventory: ResolvedMigrationAdapterInventory,
  sourceSet: LegacyMigrationSourceSet,
): void {
  // Stages written before the inventory extension remain readable. Their
  // first resolve/activate adopts the already-authoritative manifest or the
  // current evidence without pretending an old snapshot existed.
  if (stage.managedAdapters === undefined) return;
  if (
    !managedAdapterInventoriesMatch(
      stage.managedAdapters,
      inventory.managedAdapters,
    ) ||
    stage.managedAdaptersDigest !== inventory.managedAdaptersDigest
  ) {
    throw new Error('MANCODE_MIGRATION_ADAPTER_INVENTORY_CHANGED');
  }
  if (stage.adapterEvidenceDigest !== sourceSet.adapterEvidenceDigest) {
    throw new Error('MANCODE_MIGRATION_ADAPTER_EVIDENCE_CHANGED');
  }
}

function assertDualReadManifestInventory(
  manifest: SchemaManifest,
  inventory: ResolvedMigrationAdapterInventory,
): void {
  if (
    !managedAdapterInventoriesMatch(
      manifest.managedAdapters,
      inventory.managedAdapters,
    )
  ) {
    throw new Error('MANCODE_MIGRATION_ADAPTER_INVENTORY_CONFLICT');
  }
}

function migrationInventoryFields(
  inventory: ResolvedMigrationAdapterInventory,
): Pick<
  MigrationStageV1,
  'managedAdapters' | 'managedAdaptersDigest' | 'adapterEvidenceDigest'
> {
  return {
    managedAdapters: inventory.managedAdapters,
    managedAdaptersDigest: inventory.managedAdaptersDigest,
    adapterEvidenceDigest: inventory.adapterEvidenceDigest,
  };
}

async function readSchemaManifestOrNull(
  root: string,
): Promise<SchemaManifest | null> {
  const raw = await readBootstrapRawFile(
    path.join(root, '.mancode', 'schema.json'),
  );
  if (raw === null) return null;
  try {
    return parseSchemaManifest(JSON.parse(raw));
  } catch (error) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED', {
      cause: error,
    });
  }
}

async function loadLegacyMigrationSources(
  projectRoot: string,
): Promise<LegacyMigrationSourceSet> {
  const root = path.resolve(projectRoot);
  const scan = await scanLegacyAuthority(root);
  if (!scan.authorityPresent || scan.baseline === null) {
    throw new Error('MANCODE_MIGRATION_REQUIRED');
  }
  if (scan.unsafePaths.length > 0) {
    throw new Error('MANCODE_MIGRATION_LEGACY_PATH_UNSAFE');
  }
  const state = await loadLegacyState(root);
  const tasks = await loadLegacyTasks(root, state);
  if (tasks.length === 0) {
    throw new Error('MANCODE_MIGRATION_NO_WORKFLOWS');
  }
  const adapterEvidence = await scanLegacyAdapterEvidence(root, state);
  return {
    baseline: scan.baseline,
    inventoryDigest: digestCanonicalJson({
      entries: scan.entries.map((entry) => ({
        path: entry.path,
        exists: entry.exists,
        kind: entry.kind,
        digest: entry.digest,
      })),
      tasks: tasks.map((task) => ({
        legacyTaskId: task.legacyTaskId,
        sourceDigest: task.source === null ? null : task.source.sourceDigests,
        blockers: task.blockers,
      })),
    }),
    adapterEvidence: adapterEvidence.evidence,
    adapterEvidenceDigest: adapterEvidence.digest,
    inferredManagedAdapters: adapterEvidence.managedAdapters,
    state,
    tasks,
  };
}

interface LegacyAdapterEvidenceScan {
  evidence: string[];
  managedAdapters: ManagedAdapterInventory;
  digest: string;
}

/**
 * Legacy migration may only register an adapter when the checkout contains a
 * concrete signal for it.  In particular, AGENTS.md is shared by several
 * hosts and its existence alone is deliberately not a platform signal.
 */
async function scanLegacyAdapterEvidence(
  root: string,
  state: Partial<MancodeState> | null,
): Promise<LegacyAdapterEvidenceScan> {
  const evidence = new Set<string>();
  const platforms = new Set<ManagedAdapter>();
  const add = (platform: ManagedAdapter, reason: string): void => {
    platforms.add(platform);
    evidence.add(`${platform}:${reason}`);
  };

  const stateRecord = state as Record<string, unknown> | null;
  addLegacyPlatformValues(stateRecord, 'state', add);

  const legacyConfig = await readLegacyTextOrNull(root, 'config.json');
  if (legacyConfig !== null) {
    try {
      const parsed = JSON.parse(legacyConfig);
      if (isPlainRecord(parsed)) {
        addLegacyPlatformValues(parsed, 'config', add);
      }
    } catch {
      // The legacy source loader owns config validity. Inventory inference only
      // uses recognized fields and must not turn an unrelated config parse
      // failure into a platform selection.
    }
  }

  for (const candidate of PLATFORM_PATH_EVIDENCE) {
    const absolute = path.join(root, ...candidate.relativePath.split('/'));
    const entry = await lstatOrNullMigration(absolute);
    if (entry === null || !matchesEvidenceKind(entry, candidate.kind)) {
      continue;
    }
    const digest = await evidenceNodeDigest(root, absolute, entry);
    add(
      candidate.platform,
      `path:${candidate.relativePath}:${candidate.kind}:${digest ?? entryKind(entry)}`,
    );
  }

  const markerFiles = await collectLegacyMarkerFiles(root);
  for (const file of markerFiles.files) {
    const content = await readEvidenceFile(root, file);
    if (content === null) continue;
    const genericBlock = LEGACY_GENERIC_BLOCK_EVIDENCE.find(
      (candidate) => candidate.relativePath === file,
    );
    if (
      genericBlock !== undefined &&
      (hasManagedBlock(content.text) ||
        content.text.includes(LEGACY_GENERIC_MANAGED_MARKER))
    ) {
      add(
        genericBlock.platform,
        `legacy-block:${file}:generic:${content.digest}`,
      );
    }
    for (const marker of MARKER_EVIDENCE) {
      if (content.text.includes(marker.marker)) {
        add(
          marker.platform,
          `marker:${file}:${marker.marker}:${digestText(content.text)}`,
        );
      }
    }
  }
  if (markerFiles.truncated) {
    evidence.add('scan:marker-files-truncated');
  }

  const orderedEvidence = [...evidence].sort(compareUtf8);
  const managedAdapters = Object.fromEntries(
    MANAGED_ADAPTERS.filter((platform) => platforms.has(platform)).map(
      (platform) => [platform, LEGACY_ADAPTER_VERSION],
    ),
  ) as ManagedAdapterInventory;
  return {
    evidence: orderedEvidence,
    managedAdapters,
    digest: digestCanonicalJson({
      schemaVersion: 1,
      evidence: orderedEvidence,
    }),
  };
}

function addLegacyPlatformValues(
  record: Record<string, unknown> | null,
  source: string,
  add: (platform: ManagedAdapter, reason: string) => void,
): void {
  if (record === null) return;
  addLegacyPlatformValue(record.platform, `${source}.platform`, add);
  const platforms = record.platforms;
  if (Array.isArray(platforms)) {
    for (const platform of platforms) {
      addLegacyPlatformValue(platform, `${source}.platforms`, add);
    }
  }
  const managedAdapters = record.managedAdapters;
  if (isPlainRecord(managedAdapters)) {
    for (const platform of Object.keys(managedAdapters)) {
      addLegacyPlatformValue(platform, `${source}.managedAdapters`, add);
    }
  }
}

function addLegacyPlatformValue(
  value: unknown,
  reason: string,
  add: (platform: ManagedAdapter, reason: string) => void,
): void {
  if (
    typeof value === 'string' &&
    (MANAGED_ADAPTERS as readonly string[]).includes(value)
  ) {
    add(value as ManagedAdapter, `${reason}:${value}`);
  }
}

async function collectLegacyMarkerFiles(
  root: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  const roots = [
    'AGENTS.md',
    'CLAUDE.md',
    '.agents',
    '.codex',
    '.claude',
    '.cursor',
    '.github',
    '.qoder',
    '.zcode',
    '.dsh',
  ];
  const visit = async (relative: string): Promise<void> => {
    if (visited >= ADAPTER_EVIDENCE_SCAN_LIMIT) {
      truncated = true;
      return;
    }
    visited += 1;
    const absolute = path.join(root, ...relative.split('/'));
    const entry = await lstatOrNullMigration(absolute);
    if (entry === null) return;
    if (entry.isSymbolicLink()) {
      // A root adapter link is still path evidence, but marker reads must not
      // follow an arbitrary external link. readEvidenceFile performs the
      // in-root check for the small set of root files above.
      if (entry.isSymbolicLink() && !relative.startsWith('.')) {
        files.push(relative);
      }
      return;
    }
    if (entry.isFile()) {
      files.push(relative);
      return;
    }
    if (!entry.isDirectory()) return;
    const children = (await readdir(absolute)).sort(compareUtf8);
    for (const child of children) {
      if (visited >= ADAPTER_EVIDENCE_SCAN_LIMIT) {
        truncated = true;
        break;
      }
      await visit(`${relative}/${child}`);
    }
  };
  for (const rootEntry of roots) {
    await visit(rootEntry);
    if (visited >= ADAPTER_EVIDENCE_SCAN_LIMIT) {
      truncated = true;
      break;
    }
  }
  return { files: files.sort(compareUtf8), truncated };
}

async function readEvidenceFile(
  root: string,
  relative: string,
): Promise<{ text: string; digest: string } | null> {
  const absolute = path.join(root, ...relative.split('/'));
  const entry = await lstatOrNullMigration(absolute);
  if (entry === null) return null;
  let target = absolute;
  if (entry.isSymbolicLink()) {
    let resolved: string;
    try {
      resolved = await realpath(absolute);
    } catch {
      return null;
    }
    if (!isWithinRoot(root, resolved)) return null;
    target = resolved;
  } else if (!entry.isFile()) {
    return null;
  }
  const targetEntry = await lstatOrNullMigration(target);
  if (
    targetEntry === null ||
    !targetEntry.isFile() ||
    targetEntry.isSymbolicLink()
  ) {
    return null;
  }
  const text = await readFile(target, 'utf8');
  return { text, digest: digestText(text) };
}

async function evidenceNodeDigest(
  root: string,
  absolute: string,
  entry: Awaited<ReturnType<typeof lstat>>,
): Promise<string | null> {
  if (entry.isFile()) {
    const content = await readEvidenceFile(
      root,
      relativeMigrationPath(root, absolute),
    );
    return content?.digest ?? null;
  }
  if (entry.isSymbolicLink()) {
    try {
      return digestText(await readlink(absolute, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function matchesEvidenceKind(
  entry: Awaited<ReturnType<typeof lstat>>,
  kind: 'file' | 'directory' | 'any',
): boolean {
  return (
    kind === 'any' ||
    (kind === 'file' && (entry.isFile() || entry.isSymbolicLink())) ||
    (kind === 'directory' && entry.isDirectory())
  );
}

function entryKind(entry: Awaited<ReturnType<typeof lstat>>): string {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  return 'other';
}

async function lstatOrNullMigration(
  target: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function relativeMigrationPath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function isWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

async function loadLegacyState(
  root: string,
): Promise<Partial<MancodeState> | null> {
  const raw = await readLegacyTextOrNull(root, 'state.json');
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    assertRecord(parsed, 'legacy state');
    return parsed as Partial<MancodeState>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_MIGRATION_LEGACY_STATE_CORRUPT');
    }
    throw error;
  }
}

async function loadLegacyTasks(
  root: string,
  state: Partial<MancodeState> | null,
): Promise<LoadedLegacyTask[]> {
  const workflowsRoot = path.join(root, '.mancode', 'workflows');
  const entries = await readSafeDirectoryOrEmpty(workflowsRoot);
  const tasks: LoadedLegacyTask[] = [];
  for (const taskId of entries.sort(compareUtf8)) {
    assertLegacyTaskId(taskId);
    const taskRoot = path.join(workflowsRoot, taskId);
    const taskStat = await lstat(taskRoot);
    if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) {
      throw new Error('MANCODE_MIGRATION_LEGACY_PATH_UNSAFE');
    }
    const metadataRaw = await readLegacyText(
      root,
      path.join('workflows', taskId, 'metadata.json'),
    );
    const workflow = await readWorkflow(root, taskId);
    await assertLegacyTextUnchanged(
      root,
      path.join('workflows', taskId, 'metadata.json'),
      metadataRaw,
    );
    if (workflow === null) {
      throw new Error(`MANCODE_MIGRATION_LEGACY_WORKFLOW_INVALID:${taskId}`);
    }
    const [requirementsRaw, reviewRaw, verificationRaw] = await Promise.all([
      readLegacyTextOrNull(
        root,
        path.join('workflows', taskId, 'requirements.json'),
      ),
      readLegacyTextOrNull(
        root,
        path.join('workflows', taskId, 'review-ledger.json'),
      ),
      readLegacyTextOrNull(
        root,
        path.join('workflows', taskId, 'verification-ledger.json'),
      ),
    ]);
    const blockers: string[] = [];
    const [requirements, review, verification] = await Promise.all([
      requirementsRaw === null
        ? Promise.resolve(null)
        : readRequirementsLedger(root, taskId),
      reviewRaw === null
        ? Promise.resolve(null)
        : readReviewLedger(root, taskId),
      verificationRaw === null
        ? Promise.resolve(null)
        : readVerificationLedger(root, taskId),
    ]);
    await Promise.all([
      requirementsRaw === null
        ? Promise.resolve()
        : assertLegacyTextUnchanged(
            root,
            path.join('workflows', taskId, 'requirements.json'),
            requirementsRaw,
          ),
      reviewRaw === null
        ? Promise.resolve()
        : assertLegacyTextUnchanged(
            root,
            path.join('workflows', taskId, 'review-ledger.json'),
            reviewRaw,
          ),
      verificationRaw === null
        ? Promise.resolve()
        : assertLegacyTextUnchanged(
            root,
            path.join('workflows', taskId, 'verification-ledger.json'),
            verificationRaw,
          ),
    ]);
    if (requirementsRaw === null || requirements === null) {
      blockers.push('MANCODE_MIGRATION_REQUIREMENTS_LEDGER_MISSING_OR_INVALID');
    }
    if (reviewRaw === null || review === null) {
      blockers.push('MANCODE_MIGRATION_REVIEW_LEDGER_MISSING_OR_INVALID');
    }
    if (verificationRaw === null || verification === null) {
      blockers.push('MANCODE_MIGRATION_VERIFICATION_LEDGER_MISSING_OR_INVALID');
    }
    const sourceFiles: Array<{ relativePath: string; content: string }> = [
      { relativePath: 'source/metadata.json', content: metadataRaw },
      ...(requirementsRaw === null
        ? []
        : [
            {
              relativePath: 'source/requirements.json',
              content: requirementsRaw,
            },
          ]),
      ...(reviewRaw === null
        ? []
        : [{ relativePath: 'source/review-ledger.json', content: reviewRaw }]),
      ...(verificationRaw === null
        ? []
        : [
            {
              relativePath: 'source/verification-ledger.json',
              content: verificationRaw,
            },
          ]),
    ];
    let source: LegacyTaskMigrationSource | null = null;
    if (requirements !== null && review !== null && verification !== null) {
      source = {
        workflow,
        requirements,
        review,
        verification,
        state,
        sourceDigests: {
          metadata: digestText(metadataRaw),
          requirements: digestText(requirementsRaw as string),
          review: digestText(reviewRaw as string),
          verification: digestText(verificationRaw as string),
        },
      };
      const artifacts = await loadReferencedLegacyArtifacts(
        root,
        taskId,
        source,
      );
      sourceFiles.push(...artifacts.files);
      blockers.push(...artifacts.blockers);
    }
    tasks.push({
      legacyTaskId: taskId,
      workflow,
      source,
      sourceFiles,
      blockers: sortUtf8StringSet(blockers),
    });
  }
  return tasks;
}

async function loadReferencedLegacyArtifacts(
  root: string,
  taskId: string,
  source: LegacyTaskMigrationSource,
): Promise<{
  files: Array<{ relativePath: string; content: string }>;
  blockers: string[];
}> {
  const sourcePaths = new Set<string>();
  sourcePaths.add('plan.md');
  for (const report of Object.values(source.review.reports)) {
    sourcePaths.add(report);
  }
  for (const check of source.verification.checks) {
    if (check.automated?.evidenceFile)
      sourcePaths.add(check.automated.evidenceFile);
    if (check.manual?.evidenceFile) sourcePaths.add(check.manual.evidenceFile);
  }
  const files: Array<{ relativePath: string; content: string }> = [];
  const blockers: string[] = [];
  for (const sourcePath of [...sourcePaths].sort(compareUtf8)) {
    try {
      const safe = assertSafeSharedRelativePath(sourcePath);
      const content = await readLegacyTextOrNull(
        root,
        path.join('workflows', taskId, ...safe.split('/')),
      );
      if (content === null) {
        // plan.md is optional in old, pre-plan workflows. References from a
        // review or evidence record are not optional and must stay explicit.
        if (safe !== 'plan.md') {
          blockers.push('MANCODE_MIGRATION_REFERENCED_ARTIFACT_MISSING');
        }
        continue;
      }
      files.push({ relativePath: `artifacts/${safe}`, content });
    } catch (error) {
      blockers.push(
        error instanceof Error && error.message.startsWith('MANCODE_')
          ? error.message
          : 'MANCODE_MIGRATION_ARTIFACT_PATH_UNSAFE',
      );
    }
  }
  return { files, blockers: sortUtf8StringSet(blockers) };
}

function createAliases(
  tasks: LoadedLegacyTask[],
  allocator: ReturnType<typeof createDeterministicMigrationIdAllocator>,
): LegacyTaskAliasMap {
  const byId = new Map(tasks.map((task) => [task.legacyTaskId, task]));
  const namespaceByTask = new Map<string, TaskRef['namespace']>();
  const visiting = new Set<string>();
  const resolveNamespace = (taskId: string): TaskRef['namespace'] => {
    const known = namespaceByTask.get(taskId);
    if (known !== undefined) return known;
    if (visiting.has(taskId)) {
      throw new Error('MANCODE_MIGRATION_PARENT_CYCLE');
    }
    const task = byId.get(taskId);
    if (task === undefined) {
      throw new Error('MANCODE_MIGRATION_PARENT_ALIAS_MISSING');
    }
    visiting.add(taskId);
    const mode = normalizeLegacyWorkflowMode(task.workflow.mode);
    if (mode === null) {
      throw new Error('MANCODE_MIGRATION_WORKFLOW_MODE_INVALID');
    }
    let namespace: TaskRef['namespace'];
    if (mode === 'manteam') {
      namespace = 'shared';
    } else if (mode === 'man') {
      namespace = 'local';
    } else if (task.workflow.parentTaskId === undefined) {
      namespace = 'local';
    } else {
      namespace = resolveNamespace(task.workflow.parentTaskId);
    }
    visiting.delete(taskId);
    namespaceByTask.set(taskId, namespace);
    return namespace;
  };
  const byNamespace: Record<TaskRef['namespace'], string[]> = {
    local: [],
    shared: [],
  };
  for (const task of tasks) {
    byNamespace[resolveNamespace(task.legacyTaskId)].push(task.legacyTaskId);
  }
  return {
    ...createLegacyTaskAliasMap(byNamespace.local, 'local', allocator),
    ...createLegacyTaskAliasMap(byNamespace.shared, 'shared', allocator),
  };
}

function renderTasks(
  sourceSet: LegacyMigrationSourceSet,
  aliases: LegacyTaskAliasMap,
  resolutions: Record<string, MigrationTaskResolutionV1>,
  allocator: ReturnType<typeof createDeterministicMigrationIdAllocator>,
  now: Date,
): RenderedTask[] {
  try {
    assertLegacyStatePointers(sourceSet.state, aliases);
  } catch (error) {
    const code = errorCode(error, 'MANCODE_MIGRATION_STATE_POINTER_INVALID');
    return sourceSet.tasks
      .slice()
      .sort((left, right) => compareUtf8(left.legacyTaskId, right.legacyTaskId))
      .map((task) => renderBlockedTask(task, aliases, allocator, now, [code]));
  }
  const sources = new Map(
    sourceSet.tasks.map((task) => [task.legacyTaskId, task]),
  );
  const rendered = new Map<string, RenderedTask>();
  const renderOne = (legacyTaskId: string): RenderedTask => {
    const existing = rendered.get(legacyTaskId);
    if (existing !== undefined) return existing;
    const loaded = sources.get(legacyTaskId);
    if (loaded === undefined) {
      throw new Error('MANCODE_MIGRATION_PARENT_ALIAS_MISSING');
    }
    const dependencyBlockers = [...loaded.blockers];
    let parent: { legacyTaskId: string; metadata: WorkflowMetadataV3 } | null =
      null;
    const parentId = loaded.workflow.parentTaskId;
    if (parentId !== undefined) {
      try {
        const parentRendered = renderOne(parentId);
        if (parentRendered.candidate === null) {
          dependencyBlockers.push(
            'MANCODE_MIGRATION_PARENT_CANDIDATE_UNAVAILABLE',
          );
        } else {
          parent = {
            legacyTaskId: parentId,
            metadata: parentRendered.candidate.metadata,
          };
        }
      } catch (error) {
        dependencyBlockers.push(
          errorCode(error, 'MANCODE_MIGRATION_PARENT_ALIAS_MISSING'),
        );
      }
    }
    if (loaded.source === null || dependencyBlockers.length > 0) {
      const result = renderBlockedTask(
        loaded,
        aliases,
        allocator,
        now,
        dependencyBlockers,
      );
      rendered.set(legacyTaskId, result);
      return result;
    }
    const resolution = resolutions[legacyTaskId] ?? {
      ownerActorId: null,
      implementationScope: null,
    };
    try {
      const owner: LegacyMigrationOwner | null =
        resolution.ownerActorId === null
          ? null
          : { actorId: resolution.ownerActorId };
      let candidate = migrateLegacyTaskToV3({
        ...loaded.source,
        aliases,
        idAllocator: allocator,
        owner,
        parent,
      });
      if (resolution.implementationScope !== null) {
        candidate = {
          ...candidate,
          metadata: withResolvedImplementationScope(
            candidate.metadata,
            resolution.implementationScope,
          ),
        };
      }
      const report = createMigrationParityReport(
        loaded.source,
        candidate,
        aliases,
      );
      const quarantine = buildQuarantineCandidate(
        loaded,
        candidate,
        allocator.allocate(`quarantine:${legacyTaskId}`),
        now,
      );
      const blockers = sortUtf8StringSet([
        ...report.activationBlockers,
        ...(quarantine.privacy.status === 'blocked'
          ? ['MANCODE_PRIVACY_BLOCKED']
          : []),
      ]);
      const result: RenderedTask = {
        stage: {
          legacyTaskId,
          taskRef: candidate.metadata.taskRef,
          quarantineId: quarantine.quarantineId,
          state: blockers.length === 0 ? 'ready' : 'blocked',
          blockers,
          candidateDigest: candidateDigest(candidate),
          parityDigest: digestCanonicalJson(report),
          privacyStatus: quarantine.privacy.status,
        },
        candidate,
        report,
        quarantine,
        sourceFiles: loaded.sourceFiles,
      };
      rendered.set(legacyTaskId, result);
      return result;
    } catch (error) {
      const result = renderBlockedTask(loaded, aliases, allocator, now, [
        errorCode(error, 'MANCODE_MIGRATION_CANDIDATE_INVALID'),
      ]);
      rendered.set(legacyTaskId, result);
      return result;
    }
  };
  for (const task of sourceSet.tasks
    .slice()
    .sort((left, right) =>
      compareUtf8(left.legacyTaskId, right.legacyTaskId),
    )) {
    renderOne(task.legacyTaskId);
  }
  return [...rendered.values()].sort((left, right) =>
    compareUtf8(left.stage.legacyTaskId, right.stage.legacyTaskId),
  );
}

function renderBlockedTask(
  loaded: LoadedLegacyTask,
  aliases: LegacyTaskAliasMap,
  allocator: ReturnType<typeof createDeterministicMigrationIdAllocator>,
  now: Date,
  blockers: string[],
): RenderedTask {
  const taskRef = aliases[loaded.legacyTaskId];
  if (taskRef === undefined) {
    throw new Error('MANCODE_MIGRATION_TASK_ALIAS_MISSING');
  }
  const quarantine = buildSourceOnlyQuarantine(
    loaded,
    allocator.allocate(`quarantine:${loaded.legacyTaskId}`),
    now,
  );
  const allBlockers = sortUtf8StringSet([
    ...blockers,
    ...(quarantine.privacy.status === 'blocked'
      ? ['MANCODE_PRIVACY_BLOCKED']
      : []),
  ]);
  return {
    stage: {
      legacyTaskId: loaded.legacyTaskId,
      taskRef,
      quarantineId: quarantine.quarantineId,
      state: 'blocked',
      blockers: allBlockers,
      candidateDigest: null,
      parityDigest: null,
      privacyStatus: quarantine.privacy.status,
    },
    candidate: null,
    report: null,
    quarantine,
    sourceFiles: loaded.sourceFiles,
  };
}

function buildQuarantineCandidate(
  loaded: LoadedLegacyTask,
  candidate: MigratedLegacyTaskCandidate,
  quarantineId: Ulid,
  now: Date,
): QuarantineCandidateV1 {
  const entityFiles = candidateEntityFiles(candidate);
  const artifacts: QuarantineArtifact[] = [
    ...entityFiles.map(({ relativePath, content }) => ({
      relativePath,
      classification: 'authority' as const,
      includeInPromotion: true,
      contentDigest: digestText(content),
    })),
    ...loaded.sourceFiles
      .filter((file) => file.relativePath.startsWith('artifacts/'))
      .map(({ relativePath, content }) => ({
        relativePath,
        classification: 'human_view' as const,
        includeInPromotion: true,
        contentDigest: digestText(content),
      })),
  ];
  let quarantine = createQuarantineCandidate({
    quarantineId,
    purpose: 'legacy_migration',
    sourceTaskRef: null,
    candidateTaskRef: { namespace: 'local', taskId: quarantineId },
    artifacts,
    now,
  });
  quarantine = validateQuarantinePaths(quarantine, now);
  quarantine = scanQuarantineCandidate(
    quarantine,
    [...entityFiles, ...loaded.sourceFiles].map((file) => file.content),
    now,
  );
  return quarantine.privacy.status === 'passed'
    ? previewQuarantineCandidate(quarantine, now)
    : quarantine;
}

function buildSourceOnlyQuarantine(
  loaded: LoadedLegacyTask,
  quarantineId: Ulid,
  now: Date,
): QuarantineCandidateV1 {
  let quarantine = createQuarantineCandidate({
    quarantineId,
    purpose: 'legacy_migration',
    sourceTaskRef: null,
    candidateTaskRef: { namespace: 'local', taskId: quarantineId },
    artifacts: loaded.sourceFiles.map(({ relativePath, content }) => ({
      relativePath,
      classification: 'authority' as const,
      includeInPromotion: false,
      contentDigest: digestText(content),
    })),
    now,
  });
  quarantine = validateQuarantinePaths(quarantine, now);
  quarantine = scanQuarantineCandidate(
    quarantine,
    loaded.sourceFiles.map((file) => file.content),
    now,
  );
  return quarantine.privacy.status === 'passed'
    ? previewQuarantineCandidate(quarantine, now)
    : quarantine;
}

function withResolvedImplementationScope(
  metadata: WorkflowMetadataV3,
  scope: MigrationScopeResolutionV1,
): WorkflowMetadataV3 {
  const normalized = parseMigrationScopeResolution(scope);
  const raw = {
    ...metadata,
    implementationScope: {
      source: 'explicit' as const,
      include: normalized.include,
      exclude: normalized.exclude,
      modules: normalized.modules,
      digest: digestCanonicalJson({
        source: 'explicit',
        include: normalized.include,
        exclude: normalized.exclude,
        modules: normalized.modules,
      }),
    },
  };
  return parseWorkflowMetadata(raw);
}

async function writeRenderedTasks(
  projectRoot: string,
  rendered: RenderedTask[],
): Promise<void> {
  for (const item of rendered) {
    const root = quarantineDirectory(projectRoot, item.quarantine.quarantineId);
    await mkdir(root, { recursive: true });
    await writeJsonAtomic(path.join(root, 'candidate.json'), item.quarantine);
    for (const file of item.sourceFiles) {
      await writeTextAtomic(
        path.join(root, ...file.relativePath.split('/')),
        file.content,
      );
    }
    if (item.candidate !== null) {
      for (const file of candidateEntityFiles(item.candidate)) {
        await writeTextAtomic(
          path.join(root, ...file.relativePath.split('/')),
          file.content,
        );
      }
    }
    if (item.report !== null) {
      await writeJsonAtomic(
        path.join(root, 'migration-parity.json'),
        item.report,
      );
    }
  }
}

function candidateEntityFiles(
  candidate: MigratedLegacyTaskCandidate,
): Array<{ relativePath: string; content: string }> {
  return [
    {
      relativePath: 'entities/metadata.json',
      content: serialize(candidate.metadata),
    },
    {
      relativePath: 'entities/requirements.json',
      content: serialize(candidate.requirements),
    },
    {
      relativePath: 'entities/review-ledger.json',
      content: serialize(candidate.review),
    },
    {
      relativePath: 'entities/verification-ledger.json',
      content: serialize(candidate.verification),
    },
    {
      relativePath: 'entities/auxiliary.json',
      content: serialize(candidate.auxiliary),
    },
  ];
}

interface DualReadBootstrapTargetSnapshot {
  config: string | null;
  policy: string | null;
  schema: string | null;
}

interface DualReadBootstrapBundle {
  manifest: SchemaManifest;
  config: ProjectConfigV1;
  policy: TeamPolicyV1;
  contents: Record<DualReadBootstrapTargetName, string>;
}

interface DualReadBootstrapLockOwnerV1 {
  schemaVersion: 1;
  operationId: Ulid;
  processId: number;
  acquiredAt: string;
  leaseExpiresAt: string;
  statePath: string;
  stagingDirectory: string;
}

interface DualReadBootstrapLockHandle {
  owner: DualReadBootstrapLockOwnerV1;
  release(): Promise<void>;
}

async function ensureDualReadShell(input: {
  projectRoot: string;
  sourceSet: LegacyMigrationSourceSet;
  allocator: ReturnType<typeof createDeterministicMigrationIdAllocator>;
  now: string;
  minReaderVersion: string;
  minWriterVersion: string;
  managedAdapters: ManagedAdapterInventory;
}): Promise<SchemaManifest> {
  const root = path.resolve(input.projectRoot);
  const lockOperationId =
    (await readDualReadBootstrapOperationIdHint(root)) ?? createUlid();
  const lock = await acquireDualReadBootstrapLock(root, lockOperationId);
  try {
    const state = await readDualReadBootstrapStateOrNull(root);
    if (state !== null) {
      try {
        if (state.state === 'repair_required') {
          throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
        }
        await cleanupOrphanedDualReadBootstrapStaging(root, state.operationId);
        assertDualReadBootstrapStateInputs(state, input);
        if (state.state !== 'committed') {
          await ensureDualReadBootstrapStaging(root, state);
        }
        const manifest = await completeDualReadBootstrap(
          root,
          state,
          input.now,
        );
        await cleanupOrphanedDualReadBootstrapStaging(root, null);
        return manifest;
      } catch (error) {
        if (shouldMarkDualReadBootstrapRepairRequired(error)) {
          await markDualReadBootstrapRepairRequired(root, state, input.now);
        }
        throw error;
      }
    }
    const snapshot = await readDualReadBootstrapTargets(root);
    if (snapshot.schema !== null) {
      const existing = validateDualReadBootstrapSnapshot(snapshot, input);
      if (snapshot.config === null || snapshot.policy === null) {
        throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
      }
      const adopted = createCommittedDualReadBootstrapState(
        snapshot,
        input,
        lockOperationId,
      );
      await writeInitialDualReadBootstrapState(root, adopted);
      return existing.manifest;
    }

    await cleanupOrphanedDualReadBootstrapStaging(root, null);
    const prepared = createDualReadBootstrapState(
      snapshot,
      input,
      lockOperationId,
    );
    await ensureDualReadBootstrapStaging(root, prepared.state);
    throwIfOperationCrashInjected(
      DUAL_READ_BOOTSTRAP_OPERATION,
      'write-staging',
    );
    const durable = await writeInitialDualReadBootstrapState(
      root,
      prepared.state,
    );
    throwIfOperationCrashInjected(DUAL_READ_BOOTSTRAP_OPERATION, 'prepared');
    return await completeDualReadBootstrap(root, durable, input.now);
  } finally {
    await lock.release().catch(() => undefined);
  }
}

function shouldMarkDualReadBootstrapRepairRequired(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === 'MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED' ||
    error.message === 'MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT' ||
    error.message === 'MANCODE_MIGRATION_MANIFEST_STATE_INVALID'
  );
}

/**
 * Stage holds the migration lock only after bootstrap has completed.  Once
 * inside that lock it must validate the committed shell without starting a
 * second recovery/publish pass, otherwise two callers can observe different
 * bootstrap generations between the preflight and stage write.
 */
async function assertDualReadShellReady(input: {
  projectRoot: string;
  sourceSet: LegacyMigrationSourceSet;
  managedAdapters: ManagedAdapterInventory;
}): Promise<SchemaManifest> {
  const root = path.resolve(input.projectRoot);
  const state = await readDualReadBootstrapStateOrNull(root);
  if (state === null || state.state === 'repair_required') {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  if (state.state !== 'committed') {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  const snapshot = await readDualReadBootstrapTargets(root);
  const validated = validateDualReadBootstrapSnapshot(snapshot, {
    sourceSet: input.sourceSet,
    managedAdapters: input.managedAdapters,
  });
  for (const spec of DUAL_READ_BOOTSTRAP_TARGET_SPECS) {
    const target = findBootstrapTarget(state, spec.name);
    if (
      target.state !== 'published' ||
      snapshot[spec.name] !== target.targetContent
    ) {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
    }
  }
  return validated.manifest;
}

/** Dry-run remains read-only but must not hide bootstrap recovery work. */
async function inspectDualReadBootstrapForDryRun(
  root: string,
  sourceSet: LegacyMigrationSourceSet,
  inventory: ResolvedMigrationAdapterInventory,
): Promise<void> {
  const state = await readDualReadBootstrapStateOrNull(root);
  const snapshot = await readDualReadBootstrapTargets(root);
  if (state === null) {
    if (snapshot.schema !== null) {
      validateDualReadBootstrapSnapshot(snapshot, {
        sourceSet,
        managedAdapters: inventory.managedAdapters,
      });
      return;
    }
    if (snapshot.config !== null || snapshot.policy !== null) {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_RECOVERY_REQUIRED');
    }
    return;
  }
  if (state.state === 'repair_required') {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  assertDualReadBootstrapStateInputs(state, {
    sourceSet,
    managedAdapters: inventory.managedAdapters,
  });
  for (const spec of DUAL_READ_BOOTSTRAP_TARGET_SPECS) {
    const target = findBootstrapTarget(state, spec.name);
    const current = snapshot[spec.name];
    if (
      (target.state === 'published' && current !== target.targetContent) ||
      (target.state === 'pending' &&
        current !== target.beforeContent &&
        current !== target.targetContent)
    ) {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
    }
  }
  if (state.state !== 'committed') {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_RECOVERY_REQUIRED');
  }
  await assertDualReadBootstrapPublishedTargets(root, state);
}

function createDualReadBootstrapState(
  snapshot: DualReadBootstrapTargetSnapshot,
  input: {
    sourceSet: LegacyMigrationSourceSet;
    allocator: ReturnType<typeof createDeterministicMigrationIdAllocator>;
    now: string;
    minReaderVersion: string;
    minWriterVersion: string;
    managedAdapters: ManagedAdapterInventory;
  },
  operationId: Ulid,
): { state: DualReadBootstrapStateV1; bundle: DualReadBootstrapBundle } {
  const bundle = createDualReadBootstrapBundle(snapshot, input);
  const targets = DUAL_READ_BOOTSTRAP_TARGET_SPECS.map((spec) => {
    const current = snapshot[spec.name];
    const targetContent = bundle.contents[spec.name];
    return {
      name: spec.name,
      relativePath: spec.relativePath,
      beforeContent: current,
      targetContent,
      state:
        current !== null && current === targetContent
          ? ('published' as const)
          : ('pending' as const),
    } satisfies DualReadBootstrapTargetV1;
  });
  const state = parseDualReadBootstrapState({
    schemaVersion: DUAL_READ_BOOTSTRAP_SCHEMA_VERSION,
    operationId,
    state: targets.some((target) => target.state === 'published')
      ? 'publishing'
      : 'staged',
    sourceBaseline: input.sourceSet.baseline,
    managedAdapters: input.managedAdapters,
    managedAdaptersDigest: managedAdapterInventoryDigest(input.managedAdapters),
    adapterEvidenceDigest: input.sourceSet.adapterEvidenceDigest,
    stagingDirectory: relativeBootstrapStagingPath(operationId),
    targets,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return { state, bundle };
}

function createCommittedDualReadBootstrapState(
  snapshot: DualReadBootstrapTargetSnapshot,
  input: {
    sourceSet: LegacyMigrationSourceSet;
    now: string;
    managedAdapters: ManagedAdapterInventory;
  },
  operationId: Ulid,
): DualReadBootstrapStateV1 {
  const targets = DUAL_READ_BOOTSTRAP_TARGET_SPECS.map((spec) => {
    const content = snapshot[spec.name];
    if (content === null) {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    }
    return {
      name: spec.name,
      relativePath: spec.relativePath,
      beforeContent: content,
      targetContent: content,
      state: 'published' as const,
    } satisfies DualReadBootstrapTargetV1;
  });
  return parseDualReadBootstrapState({
    schemaVersion: DUAL_READ_BOOTSTRAP_SCHEMA_VERSION,
    operationId,
    state: 'committed',
    sourceBaseline: input.sourceSet.baseline,
    managedAdapters: input.managedAdapters,
    managedAdaptersDigest: managedAdapterInventoryDigest(input.managedAdapters),
    adapterEvidenceDigest: input.sourceSet.adapterEvidenceDigest,
    stagingDirectory: relativeBootstrapStagingPath(operationId),
    targets,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

function createDualReadBootstrapBundle(
  snapshot: DualReadBootstrapTargetSnapshot,
  input: {
    sourceSet: LegacyMigrationSourceSet;
    allocator: ReturnType<typeof createDeterministicMigrationIdAllocator>;
    now: string;
    minReaderVersion: string;
    minWriterVersion: string;
    managedAdapters: ManagedAdapterInventory;
  },
): DualReadBootstrapBundle {
  const generatedWorkspaceId = input.allocator.allocate('workspace');
  const generatedSchemaEpoch = input.allocator.allocate('schema-epoch');
  const existingConfig =
    snapshot.config === null
      ? null
      : parseBootstrapConfigContent(snapshot.config);
  const existingPolicy =
    snapshot.policy === null
      ? null
      : parseBootstrapPolicyContent(snapshot.policy);
  if (existingConfig !== null) assertBootstrapConfigSeed(existingConfig);
  if (existingPolicy !== null) assertBootstrapPolicySeed(existingPolicy);
  if (existingConfig !== null && existingPolicy !== null) {
    assertConfigPolicyConsistency(existingConfig, existingPolicy);
  }
  const workspaceId =
    existingConfig?.workspaceId ??
    existingPolicy?.workspaceId ??
    generatedWorkspaceId;
  const updatedAt =
    existingConfig?.updatedAt ?? existingPolicy?.updatedAt ?? input.now;
  const config =
    existingConfig ??
    parseProjectConfig({
      schemaVersion: 1,
      revision: 1,
      workspaceId,
      transport: { mode: 'local', remote: null, epoch: 1 },
      lastOperationId: null,
      updatedAt,
    });
  const policy =
    existingPolicy ??
    parseTeamPolicy({
      schemaVersion: 1,
      revision: 1,
      workspaceId,
      policy: 'auto',
      recentDays: 30,
      defaultVisibility: 'local',
      shareConfirmedDecisions: false,
      retention: {
        localRawArtifactDays: 7,
        localCacheDays: 7,
        completedSessionDays: 30,
      },
      lastOperationId: null,
      updatedAt,
    });
  assertConfigPolicyConsistency(config, policy);
  const manifest = parseSchemaManifest({
    manifestVersion: 1,
    layoutVersion: 3,
    epoch: generatedSchemaEpoch,
    activationState: 'dual_read',
    minReaderVersion: input.minReaderVersion,
    minWriterVersion: input.minWriterVersion,
    activatedAt: null,
    legacyBaseline: input.sourceSet.baseline,
    managedAdapters: input.managedAdapters,
    lastOperationId: null,
  });
  return {
    manifest,
    config,
    policy,
    contents: {
      config: snapshot.config === null ? serialize(config) : snapshot.config,
      policy: snapshot.policy === null ? serialize(policy) : snapshot.policy,
      schema: serialize(manifest),
    },
  };
}

function assertBootstrapConfigSeed(config: ProjectConfigV1): void {
  if (
    config.revision !== 1 ||
    config.transport.mode !== 'local' ||
    config.transport.remote !== null ||
    config.transport.epoch !== 1 ||
    config.lastOperationId !== null
  ) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
}

function assertBootstrapPolicySeed(policy: TeamPolicyV1): void {
  if (
    policy.revision !== 1 ||
    policy.policy !== 'auto' ||
    policy.recentDays !== 30 ||
    policy.defaultVisibility !== 'local' ||
    policy.shareConfirmedDecisions !== false ||
    policy.retention.localRawArtifactDays !== 7 ||
    policy.retention.localCacheDays !== 7 ||
    policy.retention.completedSessionDays !== 30 ||
    policy.lastOperationId !== null
  ) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
}

function validateDualReadBootstrapSnapshot(
  snapshot: DualReadBootstrapTargetSnapshot,
  input: {
    sourceSet: LegacyMigrationSourceSet;
    managedAdapters: ManagedAdapterInventory;
  },
): { manifest: SchemaManifest; config: ProjectConfigV1; policy: TeamPolicyV1 } {
  if (
    snapshot.schema === null ||
    snapshot.config === null ||
    snapshot.policy === null
  ) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  const manifest = parseBootstrapManifestContent(snapshot.schema);
  if (manifest.activationState !== 'dual_read') {
    throw new Error('MANCODE_MIGRATION_MANIFEST_STATE_INVALID');
  }
  if (!sameLegacyBaseline(manifest.legacyBaseline, input.sourceSet.baseline)) {
    throw new Error('MANCODE_LEGACY_BASELINE_CHANGED');
  }
  assertDualReadManifestInventory(
    manifest,
    resolvedMigrationInventory(
      input.managedAdapters,
      input.sourceSet.adapterEvidenceDigest,
      'explicit',
    ),
  );
  const config = parseBootstrapConfigContent(snapshot.config);
  const policy = parseBootstrapPolicyContent(snapshot.policy);
  assertConfigPolicyConsistency(config, policy);
  return { manifest, config, policy };
}

function parseBootstrapManifestContent(content: string): SchemaManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  try {
    return parseSchemaManifest(value);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MANCODE_')) {
      throw error;
    }
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED', {
      cause: error,
    });
  }
}

function parseBootstrapConfigContent(content: string): ProjectConfigV1 {
  try {
    return parseProjectConfig(JSON.parse(content));
  } catch (error) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED', {
      cause: error,
    });
  }
}

function parseBootstrapPolicyContent(content: string): TeamPolicyV1 {
  try {
    return parseTeamPolicy(JSON.parse(content));
  } catch (error) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED', {
      cause: error,
    });
  }
}

function assertDualReadBootstrapStateInputs(
  state: DualReadBootstrapStateV1,
  input: {
    sourceSet: LegacyMigrationSourceSet;
    managedAdapters: ManagedAdapterInventory;
  },
): void {
  if (
    !sameLegacyBaseline(state.sourceBaseline, input.sourceSet.baseline) ||
    !managedAdapterInventoriesMatch(
      state.managedAdapters,
      input.managedAdapters,
    )
  ) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  const expectedInventoryDigest = managedAdapterInventoryDigest(
    input.managedAdapters,
  );
  if (state.managedAdaptersDigest !== expectedInventoryDigest) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  if (state.adapterEvidenceDigest !== input.sourceSet.adapterEvidenceDigest) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  validateDualReadBootstrapStateTargets(state);
  const manifest = parseBootstrapManifestContent(
    findBootstrapTarget(state, 'schema').targetContent,
  );
  if (manifest.activationState !== 'dual_read') {
    throw new Error('MANCODE_MIGRATION_MANIFEST_STATE_INVALID');
  }
  if (!sameLegacyBaseline(manifest.legacyBaseline, state.sourceBaseline)) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  assertDualReadManifestInventory(
    manifest,
    resolvedMigrationInventory(
      state.managedAdapters,
      state.adapterEvidenceDigest,
      'explicit',
    ),
  );
}

function validateDualReadBootstrapStateTargets(
  state: DualReadBootstrapStateV1,
): void {
  const targets = new Map(state.targets.map((target) => [target.name, target]));
  const schema = targets.get('schema');
  const config = targets.get('config');
  const policy = targets.get('policy');
  if (schema === undefined || config === undefined || policy === undefined) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  parseBootstrapManifestContent(schema.targetContent);
  const parsedConfig = parseBootstrapConfigContent(config.targetContent);
  const parsedPolicy = parseBootstrapPolicyContent(policy.targetContent);
  assertConfigPolicyConsistency(parsedConfig, parsedPolicy);
}

async function readDualReadBootstrapStateOrNull(
  root: string,
): Promise<DualReadBootstrapStateV1 | null> {
  const raw = await readBootstrapRawFile(dualReadBootstrapStatePath(root));
  if (raw === null) return null;
  try {
    return parseDualReadBootstrapState(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED'
    ) {
      throw error;
    }
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED', {
      cause: error,
    });
  }
}

/**
 * Lock acquisition needs the durable operation ID when it is readable, but a
 * damaged journal must not prevent the lock from serializing the later,
 * authoritative repair-required result.
 */
async function readDualReadBootstrapOperationIdHint(
  root: string,
): Promise<Ulid | null> {
  try {
    const raw = await readBootstrapRawFile(dualReadBootstrapStatePath(root));
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!isPlainRecord(value) || typeof value.operationId !== 'string') {
      return null;
    }
    assertUlid(value.operationId, 'dual-read bootstrap state operationId');
    return value.operationId;
  } catch {
    return null;
  }
}

async function readDualReadBootstrapTargets(
  root: string,
): Promise<DualReadBootstrapTargetSnapshot> {
  const values = await Promise.all(
    DUAL_READ_BOOTSTRAP_TARGET_SPECS.map((spec) =>
      readBootstrapRawFile(path.join(root, spec.relativePath)),
    ),
  );
  return {
    config: values[0] ?? null,
    policy: values[1] ?? null,
    schema: values[2] ?? null,
  };
}

async function cleanupOrphanedDualReadBootstrapStaging(
  root: string,
  keepOperationId: Ulid | null,
): Promise<void> {
  const directory = path.join(root, '.mancode', 'local', 'migration');
  await assertBootstrapParentChain(path.join(directory, 'placeholder'));
  const directoryEntry = await lstatOrNullMigration(directory);
  if (directoryEntry === null) return;
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  const entries = await readdir(directory);
  for (const entry of entries) {
    if (!entry.startsWith('.dual-read-bootstrap-')) continue;
    const operationId = entry.slice('.dual-read-bootstrap-'.length);
    try {
      assertUlid(operationId, 'dual-read bootstrap staging operationId');
    } catch {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    }
    if (operationId === keepOperationId) continue;
    const stagingRoot = path.join(directory, entry);
    if (!(await isSafeBootstrapStagingTree(stagingRoot))) {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    }
    await rm(stagingRoot, { recursive: true, force: false });
  }
}

async function ensureDualReadBootstrapStaging(
  root: string,
  state: DualReadBootstrapStateV1,
): Promise<void> {
  const stagingRoot = dualReadBootstrapStagingPath(root, state.operationId);
  if (
    relativeBootstrapStagingPath(state.operationId) !== state.stagingDirectory
  ) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  await ensureBootstrapDirectory(path.dirname(stagingRoot));
  const existing = await lstatOrNullMigration(stagingRoot);
  if (existing?.isSymbolicLink()) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  if (existing !== null && !existing.isDirectory()) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  let rebuild = existing === null;
  if (!rebuild) {
    await assertSafeBootstrapStagingTree(stagingRoot);
    rebuild = !(await isExpectedBootstrapStagingTree(stagingRoot));
  }
  if (!rebuild) {
    for (const spec of DUAL_READ_BOOTSTRAP_TARGET_SPECS) {
      const staged = await readBootstrapRawFile(
        path.join(stagingRoot, spec.stagingRelativePath),
      );
      const target = findBootstrapTarget(state, spec.name);
      if (staged !== target.targetContent) {
        rebuild = true;
        break;
      }
    }
  }
  if (rebuild && existing !== null) {
    await rm(stagingRoot, { recursive: true, force: false });
  }
  if (rebuild) await mkdir(stagingRoot, { recursive: true });
  for (const spec of DUAL_READ_BOOTSTRAP_TARGET_SPECS) {
    const target = findBootstrapTarget(state, spec.name);
    const stagedPath = path.join(stagingRoot, spec.stagingRelativePath);
    const staged = await readBootstrapRawFile(stagedPath);
    if (staged !== target.targetContent) {
      throwIfOperationCrashInjected(
        DUAL_READ_BOOTSTRAP_OPERATION,
        `staging-${spec.name}-before`,
      );
      armOperationCrashAfterVisibleWrite(
        DUAL_READ_BOOTSTRAP_OPERATION,
        `staging-${spec.name}`,
      );
      await writeBootstrapStagingFile(stagedPath, target.targetContent);
      throwIfDeferredOperationCrashInjected(DUAL_READ_BOOTSTRAP_OPERATION);
      throwIfOperationCrashInjected(
        DUAL_READ_BOOTSTRAP_OPERATION,
        `staging-${spec.name}-after`,
      );
    }
  }
  for (const spec of DUAL_READ_BOOTSTRAP_TARGET_SPECS) {
    const target = findBootstrapTarget(state, spec.name);
    const staged = await readBootstrapRawFile(
      path.join(stagingRoot, spec.stagingRelativePath),
    );
    if (staged !== target.targetContent) {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    }
  }
  if (!(await isExpectedBootstrapStagingTree(stagingRoot))) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  validateDualReadBootstrapStateTargets(state);
}

async function isExpectedBootstrapStagingTree(
  stagingRoot: string,
): Promise<boolean> {
  const expectedDirectories = new Set(['shared', 'shared/team']);
  const expectedFiles = new Set(
    DUAL_READ_BOOTSTRAP_TARGET_SPECS.map((spec) => spec.stagingRelativePath),
  );
  const entries = await collectBootstrapStagingEntries(stagingRoot);
  if (
    entries.size !== expectedDirectories.size + expectedFiles.size ||
    [...entries].some(
      ([relative, kind]) =>
        (kind === 'directory' && !expectedDirectories.has(relative)) ||
        (kind === 'file' && !expectedFiles.has(relative)),
    )
  ) {
    return false;
  }
  return true;
}

async function isSafeBootstrapStagingTree(
  stagingRoot: string,
): Promise<boolean> {
  try {
    await assertSafeBootstrapStagingTree(stagingRoot);
    return true;
  } catch {
    return false;
  }
}

async function assertSafeBootstrapStagingTree(
  stagingRoot: string,
): Promise<void> {
  const rootEntry = await lstatOrNullMigration(stagingRoot);
  if (
    rootEntry === null ||
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory()
  ) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  await collectBootstrapStagingEntries(stagingRoot);
}

async function collectBootstrapStagingEntries(
  stagingRoot: string,
): Promise<Map<string, 'directory' | 'file'>> {
  const entries = new Map<string, 'directory' | 'file'>();
  const visit = async (directory: string, relative: string): Promise<void> => {
    const children = (await readdir(directory)).sort(compareUtf8);
    for (const child of children) {
      const childPath = path.join(directory, child);
      const childRelative = relative ? `${relative}/${child}` : child;
      const entry = await lstat(childPath);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
      }
      entries.set(childRelative, entry.isDirectory() ? 'directory' : 'file');
      if (entry.isDirectory()) await visit(childPath, childRelative);
    }
  };
  await visit(stagingRoot, '');
  return entries;
}

async function completeDualReadBootstrap(
  root: string,
  initial: DualReadBootstrapStateV1,
  now: string,
): Promise<SchemaManifest> {
  let state = initial;
  if (state.state === 'repair_required') {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  if (state.state === 'committed') {
    try {
      await assertDualReadBootstrapPublishedTargets(root, state);
    } catch (error) {
      await markDualReadBootstrapRepairRequired(root, state, now);
      throw error;
    }
    await removeDualReadBootstrapStaging(root, state);
    return parseBootstrapManifestContent(
      findBootstrapTarget(state, 'schema').targetContent,
    );
  }
  for (const name of ['config', 'policy', 'schema'] as const) {
    state = await publishDualReadBootstrapTarget(root, state, name, now);
  }
  await assertDualReadBootstrapPublishedTargets(root, state);
  const committed = parseDualReadBootstrapState({
    ...state,
    state: 'committed',
    updatedAt: now,
  });
  state = await persistDualReadBootstrapState(root, state, committed);
  await removeDualReadBootstrapStaging(root, state);
  throwIfOperationCrashInjected(DUAL_READ_BOOTSTRAP_OPERATION, 'commit');
  return parseBootstrapManifestContent(
    findBootstrapTarget(state, 'schema').targetContent,
  );
}

async function publishDualReadBootstrapTarget(
  root: string,
  state: DualReadBootstrapStateV1,
  name: DualReadBootstrapTargetName,
  now: string,
): Promise<DualReadBootstrapStateV1> {
  const target = findBootstrapTarget(state, name);
  const spec = DUAL_READ_BOOTSTRAP_TARGET_SPECS.find(
    (candidate) => candidate.name === name,
  );
  if (spec === undefined) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  const targetPath = path.join(root, spec.relativePath);
  const current = await readBootstrapRawFile(targetPath);
  if (target.state === 'published') {
    if (current !== target.targetContent) {
      await markDualReadBootstrapRepairRequired(root, state, now);
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
    }
    return state;
  }
  if (current === target.targetContent) {
    const next = updateBootstrapTargetState(state, name, 'published', now);
    return persistDualReadBootstrapState(root, state, next);
  }
  if (current !== target.beforeContent) {
    await markDualReadBootstrapRepairRequired(root, state, now);
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  throwIfOperationCrashInjected(
    DUAL_READ_BOOTSTRAP_OPERATION,
    `${name}-before`,
  );
  armOperationCrashAfterVisibleWrite(DUAL_READ_BOOTSTRAP_OPERATION, name);
  await writeBootstrapTargetAtomically(
    targetPath,
    target.beforeContent,
    target.targetContent,
  );
  throwIfDeferredOperationCrashInjected(DUAL_READ_BOOTSTRAP_OPERATION);
  throwIfOperationCrashInjected(DUAL_READ_BOOTSTRAP_OPERATION, `${name}-after`);
  const verified = await readBootstrapRawFile(targetPath);
  if (verified !== target.targetContent) {
    await markDualReadBootstrapRepairRequired(root, state, now);
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  const next = updateBootstrapTargetState(state, name, 'published', now);
  return persistDualReadBootstrapState(root, state, next);
}

function updateBootstrapTargetState(
  state: DualReadBootstrapStateV1,
  name: DualReadBootstrapTargetName,
  targetState: DualReadBootstrapTargetState,
  now: string,
): DualReadBootstrapStateV1 {
  const targets = state.targets.map((target) =>
    target.name === name ? { ...target, state: targetState } : target,
  );
  return parseDualReadBootstrapState({
    ...state,
    state: 'publishing',
    targets,
    updatedAt: now,
  });
}

async function assertDualReadBootstrapPublishedTargets(
  root: string,
  state: DualReadBootstrapStateV1,
): Promise<void> {
  const snapshot = await readDualReadBootstrapTargets(root);
  for (const spec of DUAL_READ_BOOTSTRAP_TARGET_SPECS) {
    const target = findBootstrapTarget(state, spec.name);
    if (snapshot[spec.name] !== target.targetContent) {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
    }
  }
  validateDualReadBootstrapSnapshot(snapshot, {
    sourceSet: {
      baseline: state.sourceBaseline,
      adapterEvidenceDigest: state.adapterEvidenceDigest,
    } as LegacyMigrationSourceSet,
    managedAdapters: state.managedAdapters,
  });
}

async function markDualReadBootstrapRepairRequired(
  root: string,
  state: DualReadBootstrapStateV1,
  now: string,
): Promise<void> {
  const next = parseDualReadBootstrapState({
    ...state,
    state: 'repair_required',
    updatedAt: now,
  });
  await persistDualReadBootstrapState(root, state, next).catch(() => undefined);
}

function findBootstrapTarget(
  state: DualReadBootstrapStateV1,
  name: DualReadBootstrapTargetName,
): DualReadBootstrapTargetV1 {
  const target = state.targets.find((candidate) => candidate.name === name);
  if (target === undefined) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  return target;
}

async function writeInitialDualReadBootstrapState(
  root: string,
  state: DualReadBootstrapStateV1,
): Promise<DualReadBootstrapStateV1> {
  const target = dualReadBootstrapStatePath(root);
  const existing = await readDualReadBootstrapStateOrNull(root);
  if (existing !== null) {
    if (digestCanonicalJson(existing) === digestCanonicalJson(state)) {
      return existing;
    }
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  await writeJsonAtomic(target, state);
  return state;
}

async function persistDualReadBootstrapState(
  root: string,
  previous: DualReadBootstrapStateV1,
  next: DualReadBootstrapStateV1,
): Promise<DualReadBootstrapStateV1> {
  const current = await readDualReadBootstrapStateOrNull(root);
  if (
    current === null ||
    digestCanonicalJson(current) !== digestCanonicalJson(previous)
  ) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_JOURNAL_CONFLICT');
  }
  await writeJsonAtomic(dualReadBootstrapStatePath(root), next);
  return next;
}

async function removeDualReadBootstrapStaging(
  root: string,
  state: DualReadBootstrapStateV1,
): Promise<void> {
  const stagingRoot = dualReadBootstrapStagingPath(root, state.operationId);
  const existing = await lstatOrNullMigration(stagingRoot);
  if (existing === null) return;
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  await rm(stagingRoot, { recursive: true, force: false });
}

async function writeBootstrapStagingFile(
  target: string,
  content: string,
): Promise<void> {
  await ensureBootstrapDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${createUlid()}.bootstrap.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await replaceFileAtomically(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeBootstrapTargetAtomically(
  target: string,
  beforeContent: string | null,
  targetContent: string,
): Promise<void> {
  await ensureBootstrapDirectory(path.dirname(target));
  const current = await readBootstrapRawFile(target);
  if (current === targetContent) return;
  if (current !== beforeContent) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${createUlid()}.bootstrap.tmp`,
  );
  try {
    await writeFile(temporary, targetContent, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await replaceFileAtomically(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readBootstrapRawFile(target: string): Promise<string | null> {
  await assertBootstrapParentChain(target);
  const before = await lstatOrNullMigration(target);
  if (before === null) return null;
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  const content = await readFile(target, 'utf8');
  const after = await lstatOrNullMigration(target);
  if (
    after === null ||
    after.isSymbolicLink() ||
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
  }
  return content;
}

async function assertBootstrapParentChain(target: string): Promise<void> {
  const root = path.resolve(target);
  const projectRoot = findProjectRootForBootstrapPath(root);
  let current = projectRoot;
  const relative = path.relative(projectRoot, path.dirname(root));
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const entry = await lstatOrNullMigration(current);
    if (entry === null) return;
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    }
  }
}

function findProjectRootForBootstrapPath(target: string): string {
  const marker = `${path.sep}.mancode${path.sep}`;
  const index = target.indexOf(marker);
  if (index >= 0) {
    return target.slice(0, index) || path.parse(target).root;
  }
  const rootMarker = `${path.sep}.mancode`;
  if (target.endsWith(rootMarker)) {
    return target.slice(0, -rootMarker.length) || path.parse(target).root;
  }
  throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
}

async function ensureBootstrapDirectory(target: string): Promise<void> {
  const root = path.resolve(target);
  const projectRoot = findProjectRootForBootstrapPath(root);
  await assertBootstrapParentChain(path.join(root, 'placeholder'));
  await mkdir(root, { recursive: true });
  const entry = await lstatOrNullMigration(root);
  if (entry === null || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
  if (!isWithinRoot(projectRoot, root)) {
    throw new Error('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
  }
}

async function acquireDualReadBootstrapLock(
  root: string,
  operationId: Ulid,
): Promise<DualReadBootstrapLockHandle> {
  const lockPath = dualReadBootstrapLockPath(root);
  await ensureBootstrapDirectory(path.dirname(lockPath));
  const now = new Date();
  const owner: DualReadBootstrapLockOwnerV1 = {
    schemaVersion: 1,
    operationId,
    processId: process.pid,
    acquiredAt: now.toISOString(),
    leaseExpiresAt: new Date(
      now.getTime() + DUAL_READ_BOOTSTRAP_LOCK_LEASE_MS,
    ).toISOString(),
    statePath: relativeBootstrapStatePath(),
    stagingDirectory: relativeBootstrapStagingPath(operationId),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockPath);
      const createdPause = pauseIfOperationLockInjectedForTesting(
        operationId,
        'bootstrap_lock_created',
      );
      if (createdPause !== null) await createdPause;
      // On failure, leave the directory for inspection. Without a complete
      // owner record we cannot prove that cleanup would delete our own lock.
      await writeFile(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify(owner, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      const pause = pauseIfOperationLockInjectedForTesting(
        operationId,
        'bootstrap_lock_held',
      );
      if (pause !== null) await pause;
      return {
        owner,
        async release(): Promise<void> {
          const current = await readDualReadBootstrapLockOwner(lockPath);
          if (current === null || !sameBootstrapLockOwner(current, owner)) {
            return;
          }
          await rm(lockPath, { recursive: true, force: false });
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const status = await inspectDualReadBootstrapLock(root, lockPath);
      if (status === 'reclaimable') {
        if (await reclaimDualReadBootstrapLock(root, lockPath, operationId)) {
          continue;
        }
      }
      throw new Error(
        status === 'stale_unverified'
          ? 'MANCODE_MIGRATION_BOOTSTRAP_LOCK_STALE_UNVERIFIED'
          : 'MANCODE_MIGRATION_BOOTSTRAP_LOCK_HELD',
      );
    }
  }
  throw new Error('MANCODE_MIGRATION_BOOTSTRAP_LOCK_HELD');
}

async function inspectDualReadBootstrapLock(
  root: string,
  lockPath: string,
): Promise<'held' | 'reclaimable' | 'stale_unverified'> {
  const stat = await lstatOrNullMigration(lockPath);
  if (stat === null) return 'reclaimable';
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'held';
  const owner = await readDualReadBootstrapLockOwner(lockPath);
  if (owner !== null) {
    if (processIsAliveForBootstrap(owner.processId)) return 'held';
    if (Date.parse(owner.leaseExpiresAt) >= Date.now()) return 'held';
  } else {
    // A slow but live creator can still be between mkdir and owner publish.
    // Directory age cannot establish that this process has died.
    return 'stale_unverified';
  }
  const state = await readDualReadBootstrapStateOrNull(root);
  if (state === null) return 'stale_unverified';
  if (owner !== null && owner.operationId !== state.operationId) {
    return 'stale_unverified';
  }
  try {
    validateDualReadBootstrapStateTargets(state);
  } catch {
    return 'stale_unverified';
  }
  return 'reclaimable';
}

async function reclaimDualReadBootstrapLock(
  root: string,
  lockPath: string,
  operationId: Ulid,
): Promise<boolean> {
  // Serialize reclaimers, then re-read the owner: an earlier observation can
  // refer to a stale directory that another reclaimer has already replaced.
  // A guard abandoned by a crashed reclaimer requires operator inspection.
  const guardPath = `${lockPath}.reclaim`;
  try {
    await mkdir(guardPath);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error('MANCODE_MIGRATION_BOOTSTRAP_LOCK_STALE_UNVERIFIED');
    }
    throw error;
  }
  try {
    const pause = pauseIfOperationLockInjectedForTesting(
      operationId,
      'bootstrap_reclaim_held',
    );
    if (pause !== null) await pause;
    if ((await lstatOrNullMigration(lockPath)) === null) return true;
    const status = await inspectDualReadBootstrapLock(root, lockPath);
    if (status === 'stale_unverified') {
      throw new Error('MANCODE_MIGRATION_BOOTSTRAP_LOCK_STALE_UNVERIFIED');
    }
    if (status !== 'reclaimable') return false;
    const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
    await rename(lockPath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } finally {
    await rmdir(guardPath);
  }
}

async function readDualReadBootstrapLockOwner(
  lockPath: string,
): Promise<DualReadBootstrapLockOwnerV1 | null> {
  const ownerPath = path.join(lockPath, 'owner.json');
  const entry = await lstatOrNullMigration(ownerPath);
  if (entry === null || entry.isSymbolicLink() || !entry.isFile()) return null;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(ownerPath, 'utf8'));
  } catch {
    return null;
  }
  try {
    return parseDualReadBootstrapLockOwner(value);
  } catch {
    return null;
  }
}

function parseDualReadBootstrapLockOwner(
  value: unknown,
): DualReadBootstrapLockOwnerV1 {
  assertRecord(value, 'dual-read bootstrap lock owner');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'processId',
      'acquiredAt',
      'leaseExpiresAt',
      'statePath',
      'stagingDirectory',
    ],
    'dual-read bootstrap lock owner',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('dual-read bootstrap lock owner schemaVersion is invalid');
  }
  assertUlid(value.operationId, 'dual-read bootstrap lock owner operationId');
  if (
    typeof value.processId !== 'number' ||
    !Number.isSafeInteger(value.processId) ||
    value.processId < 1
  ) {
    throw new Error('dual-read bootstrap lock owner processId is invalid');
  }
  const acquiredAt = parseTimestamp(
    value.acquiredAt,
    'dual-read bootstrap lock owner acquiredAt',
  );
  const leaseExpiresAt = parseTimestamp(
    value.leaseExpiresAt,
    'dual-read bootstrap lock owner leaseExpiresAt',
  );
  if (
    value.statePath !== relativeBootstrapStatePath() ||
    value.stagingDirectory !== relativeBootstrapStagingPath(value.operationId)
  ) {
    throw new Error('dual-read bootstrap lock owner paths are invalid');
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    processId: value.processId,
    acquiredAt,
    leaseExpiresAt,
    statePath: value.statePath,
    stagingDirectory: value.stagingDirectory,
  };
}

function sameBootstrapLockOwner(
  left: DualReadBootstrapLockOwnerV1,
  right: DualReadBootstrapLockOwnerV1,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.processId === right.processId &&
    left.acquiredAt === right.acquiredAt &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    left.statePath === right.statePath &&
    left.stagingDirectory === right.stagingDirectory
  );
}

function processIsAliveForBootstrap(processId: number): boolean {
  if (processId === process.pid) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function relativeBootstrapStatePath(): string {
  return DUAL_READ_BOOTSTRAP_STATE_RELATIVE;
}

function relativeBootstrapStagingPath(operationId: Ulid): string {
  assertUlid(operationId, 'dual-read bootstrap staging operationId');
  return `${DUAL_READ_BOOTSTRAP_STAGING_PREFIX}${operationId}`;
}

async function readMigrationStageOrNull(
  root: string,
  stageId: Ulid,
): Promise<MigrationStageV1 | null> {
  try {
    return await readMigrationStage(root, stageId);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeMigrationStage(
  projectRoot: string,
  stage: MigrationStageV1,
): Promise<void> {
  await writeJsonAtomic(migrationStagePath(projectRoot, stage.stageId), stage);
}

async function withMigrationStageLock<T>(
  projectRoot: string,
  stageId: Ulid,
  action: () => Promise<T>,
): Promise<T> {
  const runtime = await ensureProjectRuntimeContext(projectRoot);
  const locks = await acquireOperationEntityLocks(createUlid(), [
    {
      store: resolveLocalEntityHomeStore(runtime.entityHomeStoreContext),
      entityLockKeys: [`stage:${stageId}`],
    },
  ]);
  try {
    return await action();
  } finally {
    await Promise.allSettled(locks.map((lock) => lock.release()));
  }
}

function parseAliases(value: unknown): LegacyTaskAliasMap {
  assertRecord(value, 'migration stage aliases');
  const aliases: LegacyTaskAliasMap = {};
  for (const [legacyTaskId, taskRef] of Object.entries(value)) {
    assertLegacyTaskId(legacyTaskId);
    aliases[legacyTaskId] = parseTaskRefValue(taskRef);
  }
  return aliases;
}

function parseResolutions(
  value: unknown,
  aliases: LegacyTaskAliasMap,
): Record<string, MigrationTaskResolutionV1> {
  assertRecord(value, 'migration stage resolutions');
  const resolutions: Record<string, MigrationTaskResolutionV1> = {};
  for (const [legacyTaskId, resolution] of Object.entries(value)) {
    if (aliases[legacyTaskId] === undefined) {
      throw new Error('migration stage resolution has no matching alias');
    }
    resolutions[legacyTaskId] = parseMigrationTaskResolution(resolution);
  }
  return resolutions;
}

function parseMigrationTaskResolution(
  value: unknown,
): MigrationTaskResolutionV1 {
  assertRecord(value, 'migration task resolution');
  assertKnownKeys(
    value,
    ['ownerActorId', 'implementationScope'],
    'migration task resolution',
  );
  const ownerActorId =
    value.ownerActorId === null
      ? null
      : (() => {
          assertUlid(
            value.ownerActorId,
            'migration task resolution ownerActorId',
          );
          return value.ownerActorId;
        })();
  return {
    ownerActorId,
    implementationScope:
      value.implementationScope === null
        ? null
        : parseMigrationScopeResolution(value.implementationScope),
  };
}

function parseMigrationScopeResolution(
  value: unknown,
): MigrationScopeResolutionV1 {
  assertRecord(value, 'migration implementation scope resolution');
  assertKnownKeys(
    value,
    ['include', 'exclude', 'modules'],
    'migration implementation scope resolution',
  );
  const scope = {
    include: parseScopeStrings(value.include, 'migration scope include'),
    exclude: parseScopeStrings(value.exclude, 'migration scope exclude'),
    modules: parseScopeStrings(value.modules, 'migration scope modules'),
  };
  if (
    scope.include.length === 0 &&
    scope.exclude.length === 0 &&
    scope.modules.length === 0
  ) {
    throw new Error(
      'migration implementation scope resolution must not be empty',
    );
  }
  return scope;
}

function parseScopeStrings(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => typeof item !== 'string' || !item.trim() || item.includes('\0'),
    )
  ) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  const normalized = sortUtf8StringSet(value.map((item) => item.trim()));
  if (normalized.length !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  for (const item of normalized) {
    if (
      item.startsWith('/') ||
      item.startsWith('~') ||
      /^[A-Za-z]:/.test(item) ||
      item.includes('\\') ||
      item
        .split('/')
        .some(
          (segment) => segment === '' || segment === '.' || segment === '..',
        )
    ) {
      throw new Error('MANCODE_MIGRATION_SCOPE_PATH_UNSAFE');
    }
  }
  return normalized;
}

function parseStageTasks(
  value: unknown,
  aliases: LegacyTaskAliasMap,
): MigrationTaskStageV1[] {
  if (!Array.isArray(value))
    throw new Error('migration stage tasks must be an array');
  const seen = new Set<string>();
  const tasks = value.map((raw) => {
    assertRecord(raw, 'migration stage task');
    assertKnownKeys(
      raw,
      [
        'legacyTaskId',
        'taskRef',
        'quarantineId',
        'state',
        'blockers',
        'candidateDigest',
        'parityDigest',
        'privacyStatus',
      ],
      'migration stage task',
    );
    if (typeof raw.legacyTaskId !== 'string') {
      throw new Error('migration stage task legacyTaskId is invalid');
    }
    assertLegacyTaskId(raw.legacyTaskId);
    if (seen.has(raw.legacyTaskId) || aliases[raw.legacyTaskId] === undefined) {
      throw new Error('migration stage task aliases are invalid');
    }
    seen.add(raw.legacyTaskId);
    const taskRef = parseTaskRefValue(raw.taskRef);
    if (!sameTaskRefValue(taskRef, aliases[raw.legacyTaskId] as TaskRef)) {
      throw new Error('migration stage task TaskRef does not match alias');
    }
    assertUlid(raw.quarantineId, 'migration stage task quarantineId');
    if (raw.state !== 'ready' && raw.state !== 'blocked') {
      throw new Error('migration stage task state is invalid');
    }
    const blockers = parseStringSet(
      raw.blockers,
      'migration stage task blockers',
    );
    const candidateDigest = parseDigestOrNull(
      raw.candidateDigest,
      'migration stage task candidateDigest',
    );
    const parityDigest = parseDigestOrNull(
      raw.parityDigest,
      'migration stage task parityDigest',
    );
    if ((candidateDigest === null) !== (parityDigest === null)) {
      throw new Error(
        'migration stage candidate and parity digest must be paired',
      );
    }
    if (
      raw.state === 'ready' &&
      (blockers.length > 0 || candidateDigest === null)
    ) {
      throw new Error('ready migration task must have a clean candidate');
    }
    if (raw.state === 'blocked' && blockers.length === 0) {
      throw new Error('blocked migration task requires blocker codes');
    }
    if (
      raw.privacyStatus !== 'pending' &&
      raw.privacyStatus !== 'passed' &&
      raw.privacyStatus !== 'blocked'
    ) {
      throw new Error('migration stage task privacyStatus is invalid');
    }
    return {
      legacyTaskId: raw.legacyTaskId,
      taskRef,
      quarantineId: raw.quarantineId,
      state: raw.state as MigrationTaskStageState,
      blockers,
      candidateDigest,
      parityDigest,
      privacyStatus: raw.privacyStatus as MigrationTaskStageV1['privacyStatus'],
    };
  });
  return tasks.sort((left, right) =>
    compareUtf8(left.legacyTaskId, right.legacyTaskId),
  );
}

function parseLegacyBaseline(value: unknown): LegacyBaseline {
  assertRecord(value, 'migration stage sourceBaseline');
  assertKnownKeys(
    value,
    ['stateDigest', 'workflowIndexDigest'],
    'migration stage sourceBaseline',
  );
  return {
    stateDigest: parseDigest(
      value.stateDigest,
      'migration stage baseline stateDigest',
    ),
    workflowIndexDigest: parseDigest(
      value.workflowIndexDigest,
      'migration stage baseline workflowIndexDigest',
    ),
  };
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseManagedAdapterInventory(
  value: unknown,
  label: string,
): ManagedAdapterInventory {
  assertRecord(value, label);
  assertKnownKeys(value, MANAGED_ADAPTERS, label);
  const inventory: ManagedAdapterInventory = {};
  for (const adapter of MANAGED_ADAPTERS) {
    const version = value[adapter];
    if (version === undefined) continue;
    if (typeof version !== 'string' || !version.trim()) {
      throw new Error(`${label}.${adapter} must be a non-empty version`);
    }
    inventory[adapter] = version;
  }
  return inventory;
}

function managedAdapterInventoryDigest(
  inventory: ManagedAdapterInventory,
): string {
  return digestCanonicalJson({
    schemaVersion: 1,
    managedAdapters: parseManagedAdapterInventory(
      inventory,
      'migration managedAdapters',
    ),
  });
}

function parseDigestOrNull(value: unknown, label: string): string | null {
  return value === null ? null : parseDigest(value, label);
}

function parseStringSet(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function migrationSeed(sourceSet: LegacyMigrationSourceSet): string {
  return digestCanonicalJson({
    format: 'mancode-migration-stage-v1',
    baseline: sourceSet.baseline,
    inventoryDigest: sourceSet.inventoryDigest,
  });
}

function candidateDigest(candidate: MigratedLegacyTaskCandidate): string {
  return digestCanonicalJson({
    metadata: workflowMetadataDigest(candidate.metadata),
    requirements: candidate.requirements.contentDigest,
    review: candidate.review.contentDigest,
    verification: candidate.verification.contentDigest,
    auxiliary: candidate.auxiliary,
  });
}

function sameAliases(
  left: LegacyTaskAliasMap,
  right: LegacyTaskAliasMap,
): boolean {
  const leftKeys = Object.keys(left).sort(compareUtf8);
  const rightKeys = Object.keys(right).sort(compareUtf8);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameTaskRefValue(left[key] as TaskRef, right[key] as TaskRef),
    )
  );
}

function sameTaskRefValue(left: TaskRef, right: TaskRef): boolean {
  return left.namespace === right.namespace && left.taskId === right.taskId;
}

function assertLegacyTaskId(value: string): void {
  if (!isValidWorkflowTaskId(value)) {
    throw new Error('MANCODE_MIGRATION_LEGACY_TASK_ID_UNSAFE');
  }
}

async function readLegacyText(
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  const value = await readLegacyTextOrNull(projectRoot, relativePath);
  if (value === null) {
    throw new Error('MANCODE_MIGRATION_LEGACY_ENTITY_MISSING');
  }
  return value;
}

async function readLegacyTextOrNull(
  projectRoot: string,
  relativePath: string,
): Promise<string | null> {
  const root = path.join(path.resolve(projectRoot), '.mancode');
  const segments = safeSegments(relativePath);
  await assertSafeDirectory(root);
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    await assertSafeDirectory(directory);
  }
  const target = path.join(root, ...segments);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(target);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_MIGRATION_LEGACY_PATH_UNSAFE');
  }
  const content = await readFile(target, 'utf8');
  await assertSafeDirectory(directory);
  const after = await lstat(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error('MANCODE_MIGRATION_LEGACY_PATH_UNSAFE');
  }
  return content;
}

async function assertLegacyTextUnchanged(
  projectRoot: string,
  relativePath: string,
  expected: string,
): Promise<void> {
  const actual = await readLegacyText(projectRoot, relativePath);
  if (actual !== expected) {
    throw new Error('MANCODE_LEGACY_TREE_CHANGED_DURING_SCAN');
  }
}

async function readSafeDirectoryOrEmpty(target: string): Promise<string[]> {
  try {
    await assertSafeDirectory(target);
    return await readdir(target);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function assertSafeDirectory(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_MIGRATION_LEGACY_PATH_UNSAFE');
  }
}

function safeSegments(relativePath: string): string[] {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\0')
  ) {
    throw new Error('MANCODE_MIGRATION_LEGACY_PATH_UNSAFE');
  }
  const segments = relativePath.split(path.sep);
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('MANCODE_MIGRATION_LEGACY_PATH_UNSAFE');
  }
  return segments;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeTextAtomic(target, serialize(value));
}

async function writeTextAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${createUlid()}.tmp`,
  );
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, target);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && /^MANCODE_[A-Z0-9_:.-]+$/.test(error.message)) {
    return error.message;
  }
  return fallback;
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

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

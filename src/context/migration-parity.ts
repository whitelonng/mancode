import { createHash } from 'node:crypto';
import type { MancodeState } from '../commands/init.js';
import {
  type RequirementsLedger as LegacyRequirementsLedger,
  requirementsAreReady as legacyRequirementsAreReady,
} from '../system/requirements-ledger.js';
import type { ReviewLedger as LegacyReviewLedger } from '../system/review-ledger.js';
import type {
  VerificationEvidence as LegacyVerificationEvidence,
  VerificationLedger as LegacyVerificationLedger,
} from '../system/verification-ledger.js';
import type {
  WorkflowMeta as LegacyWorkflowMeta,
  WorkflowMode as LegacyWorkflowMode,
} from '../system/workflow.js';
import { type ArtifactRef, parseArtifactRef } from './artifact-ref.js';
import { digestCanonicalJson, sortUtf8StringSet } from './canonical.js';
import {
  type ContextPackSectionInput,
  type ContextPackSectionPointer,
  type ContextPurpose,
  buildContextPack,
} from './context-pack.js';
import { type Ulid, createUlid } from './ids.js';
import {
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsLedgerDigest,
  requirementsAreReady as v3RequirementsAreReady,
} from './requirements-ledger.js';
import {
  type ReviewLedgerV1,
  deriveReviewLedgerStatus,
  parseReviewLedger,
  reviewLedgerDigest,
} from './review-ledger.js';
import { normalizeLegacyWorkflowMode } from './schema.js';
import { type TaskNamespace, type TaskRef, formatTaskRef } from './task-ref.js';
import {
  type VerificationLedgerStatus,
  type VerificationLedgerV1,
  deriveVerificationLedgerStatus,
  parseVerificationLedger,
  verificationLedgerDigest,
} from './verification-ledger.js';
import {
  type RequirementsStatus,
  type ReviewStatus,
  type VerificationStatus,
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
  workflowMetadataDigest,
} from './workflow-metadata.js';

/** Every legacy-to-V3 mapping uses this version, including report readers. */
export const LEGACY_V3_FIELD_MAP_VERSION = 1;

export interface LegacyTaskAliasMap {
  [legacyTaskId: string]: TaskRef;
}

export interface LegacySourceDigests {
  metadata: string;
  requirements: string;
  review: string;
  verification: string;
}

/**
 * The legacy parser produces normalized objects. Migration deliberately takes
 * those objects rather than raw JSON, while raw file digests stay in audit
 * metadata through `sourceDigests`.
 */
export interface LegacyTaskMigrationSource {
  workflow: LegacyWorkflowMeta;
  requirements: LegacyRequirementsLedger;
  review: LegacyReviewLedger;
  verification: LegacyVerificationLedger;
  state: Partial<MancodeState> | null;
  sourceDigests: LegacySourceDigests;
}

export interface LegacyMigrationOwner {
  actorId: Ulid;
  participants?: Ulid[];
}

export interface LegacyMigrationIdAllocator {
  allocate(scope: string): Ulid;
}

export interface MigratedParentContext {
  legacyTaskId: string;
  metadata: WorkflowMetadataV3;
}

export interface LegacyArtifactAlias {
  legacyPath: string;
  artifactRef: ArtifactRef;
}

export interface MigrationResumeHintV1 {
  schemaVersion: 1;
  source: 'legacy_state';
  taskRef: TaskRef;
  currentMode: string;
  currentWorkflowMode: 'man' | 'manba' | 'manteam' | null;
  lastMode: string | null;
}

export interface LegacyProjectFactsV1 {
  source: 'legacy_state';
  platform: string | null;
  techStack: string | null;
  uiLibrary: string | null;
  projectMode: string | null;
}

export interface LegacyTeamAssessmentV1 {
  source: 'legacy_state';
  teamModeAutoDetected: boolean | null;
  contributors: number | null;
}

export interface LegacyMigrationAuditV1 {
  source: 'legacy_state';
  version: string | null;
  initializedAt: string | null;
}

export interface MigratedLegacyAuxiliaryData {
  resumeHint: MigrationResumeHintV1 | null;
  projectFacts: LegacyProjectFactsV1 | null;
  teamAssessment: LegacyTeamAssessmentV1 | null;
  migrationAudit: LegacyMigrationAuditV1 | null;
}

export interface MigratedLegacyTaskCandidate {
  metadata: WorkflowMetadataV3;
  requirements: RequirementsLedgerV1;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  artifactAliases: LegacyArtifactAlias[];
  auxiliary: MigratedLegacyAuxiliaryData;
}

export interface LegacyTaskMigrationInput extends LegacyTaskMigrationSource {
  aliases: LegacyTaskAliasMap;
  idAllocator: LegacyMigrationIdAllocator;
  owner: LegacyMigrationOwner | null;
  parent: MigratedParentContext | null;
}

export type CompletionGateTuple = {
  allowed: boolean;
  requirementsStatus: RequirementsStatus;
  reviewStatus: ReviewStatus;
  verificationStatus: VerificationStatus;
  blockerIds: string[];
  requiredEvidence: string[];
};

export interface MigrationFieldMapping {
  source: string;
  sourceFields: string[];
  target: string;
  matched: boolean;
}

export interface ContextPackShadowComparisonV1 {
  purpose: ContextPurpose;
  legacyPackDigest: string;
  v3PackDigest: string;
  matched: boolean;
  differences: string[];
}

export interface MigrationContextPackShadowV1 {
  schemaVersion: 1;
  comparisons: ContextPackShadowComparisonV1[];
}

export interface MigrationParityReportV1 {
  schemaVersion: 1;
  fieldMapVersion: 1;
  legacyTaskId: string;
  taskRef: TaskRef;
  sourceDigests: LegacySourceDigests;
  v3Digests: {
    metadata: string;
    requirements: string;
    review: string;
    verification: string;
  };
  sourceFieldInventory: string[];
  fieldMappings: MigrationFieldMapping[];
  unmappedFields: string[];
  legacyGate: CompletionGateTuple;
  v3Gate: CompletionGateTuple;
  contextPackShadow: MigrationContextPackShadowV1;
  aliasResolution: {
    taskRefs: string[];
    displayIds: string[];
    artifactPaths: string[];
  };
  activationBlockers: string[];
}

/**
 * Stable IDs are derived from a caller-owned migration seed and a semantic
 * scope. The allocator rejects reuse so a mapping cannot silently collapse two
 * legacy entities into one V3 identity.
 */
export function createDeterministicMigrationIdAllocator(
  seed: string,
): LegacyMigrationIdAllocator {
  if (!seed.trim()) throw new Error('migration ID seed is required');
  const allocated = new Set<Ulid>();
  return {
    allocate(scope: string): Ulid {
      if (!scope.trim()) throw new Error('migration ID scope is required');
      for (let attempt = 0; attempt < 1024; attempt += 1) {
        const digest = createHash('sha256')
          .update(seed)
          .update('\0')
          .update(scope)
          .update('\0')
          .update(String(attempt))
          .digest();
        const timestamp = digest.readUIntBE(0, 6);
        const id = createUlid(timestamp, digest.subarray(6, 16));
        if (!allocated.has(id)) {
          allocated.add(id);
          return id;
        }
      }
      throw new Error(`unable to allocate a stable migration ID for ${scope}`);
    },
  };
}

/** Allocate task aliases independently of filesystem traversal order. */
export function createLegacyTaskAliasMap(
  legacyTaskIds: string[],
  namespace: TaskNamespace,
  idAllocator: LegacyMigrationIdAllocator,
): LegacyTaskAliasMap {
  const sorted = sortUtf8StringSet(legacyTaskIds);
  if (sorted.length !== legacyTaskIds.length) {
    throw new Error('legacy task IDs must be unique for alias allocation');
  }
  return Object.fromEntries(
    sorted.map((legacyTaskId) => [
      legacyTaskId,
      { namespace, taskId: idAllocator.allocate(`task:${legacyTaskId}`) },
    ]),
  );
}

/**
 * State pointers are global legacy hints, so validate them against the complete
 * alias map before staging individual task candidates. Nothing is guessed when
 * an old pointer resolves to zero or multiple tasks.
 */
export function assertLegacyStatePointers(
  state: Partial<MancodeState> | null,
  aliases: LegacyTaskAliasMap,
): void {
  if (state === null) return;
  if (state.currentTask !== null && state.currentTask !== undefined) {
    if (
      typeof state.currentTask !== 'string' ||
      aliases[state.currentTask] === undefined
    ) {
      throw new Error('MANCODE_MIGRATION_CURRENT_TASK_ALIAS_MISSING');
    }
  }
  const activeSoloPlan = state.activeSoloPlan;
  if (activeSoloPlan !== null && activeSoloPlan !== undefined) {
    if (
      typeof activeSoloPlan.taskId !== 'string' ||
      aliases[activeSoloPlan.taskId] === undefined ||
      !Number.isSafeInteger(activeSoloPlan.planVersion) ||
      activeSoloPlan.planVersion < 1
    ) {
      throw new Error('MANCODE_MIGRATION_SOLO_PLAN_ALIAS_MISSING');
    }
  }
  if (
    state.currentWorkflowMode !== null &&
    state.currentWorkflowMode !== undefined &&
    normalizeLegacyWorkflowMode(state.currentWorkflowMode) === null
  ) {
    throw new Error('MANCODE_MIGRATION_CURRENT_WORKFLOW_MODE_INVALID');
  }
}

/**
 * Creates an inert V3 candidate. It does not write staging files or promote
 * data. Any missing owner, parent alias, unsafe artifact path, or invalid
 * field is a hard migration failure rather than a guessed replacement.
 */
export function migrateLegacyTaskToV3(
  input: LegacyTaskMigrationInput,
): MigratedLegacyTaskCandidate {
  assertLegacyStatePointers(input.state, input.aliases);
  const workflowMode = normalizeRequiredLegacyMode(input.workflow.mode);
  const taskRef = resolveTaskAlias(input.aliases, input.workflow.taskId);
  const parent = mapParent(input, workflowMode, taskRef);
  assertTaskPlacement(workflowMode, taskRef, parent);
  const isActive = !isLegacyTerminalStatus(input.workflow.status);
  if (isActive && input.owner === null) {
    throw new Error('MANCODE_MIGRATION_OWNER_REQUIRED');
  }
  const ownerActorId = input.owner?.actorId ?? null;
  const participants = normalizeParticipants(input.owner, ownerActorId);
  const requirements = parseRequirementsLedger(mapRequirements(input, taskRef));
  const artifactAliases: LegacyArtifactAlias[] = [];
  const review = parseReviewLedger(mapReview(input, taskRef, artifactAliases));
  const verification = parseVerificationLedger(
    mapVerification(input, taskRef, requirements, review, artifactAliases),
    requirements,
  );
  const metadata = parseWorkflowMetadata(
    mapWorkflowMetadata(
      input,
      taskRef,
      workflowMode,
      parent,
      ownerActorId,
      participants,
      requirements,
      review,
      verification,
    ),
  );
  const auxiliary = mapAuxiliaryData(input, taskRef);
  return {
    metadata,
    requirements,
    review,
    verification,
    artifactAliases,
    auxiliary,
  };
}

export function evaluateLegacyCompletionGate(
  source: LegacyTaskMigrationSource,
): CompletionGateTuple {
  const requirementsStatus = legacyRequirementsStatus(source);
  const reviewStatus = legacyReviewStatus(source.review);
  const verificationStatus = legacyVerificationStatus(source);
  const blockerIds = sortUtf8StringSet(
    source.review.blockers
      .filter((blocker) => blocker.status === 'open')
      .map((blocker) => blocker.id),
  );
  const requiredEvidence = legacyRequiredEvidence(source.requirements);
  const workflow = source.workflow;
  const policyEnabled =
    workflow.planningPolicyVersion !== undefined ||
    workflow.reviewPolicyVersion !== undefined ||
    workflow.verificationPolicyVersion !== undefined;
  const governanceDecision = workflow.planDecision;
  const bypassGovernance = governanceDecision === 'solo_handoff';
  const allowed =
    !isLegacyTerminalStatus(workflow.status) &&
    workflow.status !== 'blocked' &&
    (!policyEnabled ||
      (requirementsStatus === 'ready' && governanceDecision !== undefined)) &&
    (workflow.reviewPolicyVersion === undefined ||
      bypassGovernance ||
      reviewStatus === 'passed' ||
      reviewStatus === 'skipped') &&
    (workflow.verificationPolicyVersion === undefined ||
      bypassGovernance ||
      verificationStatus === 'passed');
  return {
    allowed,
    requirementsStatus,
    reviewStatus,
    verificationStatus,
    blockerIds,
    requiredEvidence,
  };
}

export function evaluateV3CompatibilityGate(
  candidate: MigratedLegacyTaskCandidate,
): CompletionGateTuple {
  const { metadata, requirements, review, verification } = candidate;
  const requirementsStatus: RequirementsStatus =
    requirements.status === 'confirmed' && v3RequirementsAreReady(requirements)
      ? 'ready'
      : 'needs_clarification';
  const reviewStatus = deriveReviewLedgerStatus(review) as ReviewStatus;
  const verificationStatus = deriveVerificationLedgerStatus(verification, {
    requirementsDigest: requirements.contentDigest,
    planVersion: metadata.governance.planVersion,
    remediationRound: review.remediationRound,
  }) as VerificationStatus;
  const blockerIds = sortUtf8StringSet(
    review.blockers
      .filter((blocker) => blocker.status === 'open')
      .map((blocker) => blocker.legacyId ?? blocker.displayId),
  );
  const requiredEvidence = sortUtf8StringSet(
    verification.checks
      .filter((check) => check.required)
      .flatMap((check) => [
        ...(check.automated === null
          ? []
          : [`${check.legacyId ?? check.displayId}:automated`]),
        ...(check.manual === null
          ? []
          : [`${check.legacyId ?? check.displayId}:manual`]),
      ]),
  );
  const policyEnabled =
    metadata.governance.policyVersions.planning !== null ||
    metadata.governance.policyVersions.review !== null ||
    metadata.governance.policyVersions.verification !== null;
  const bypassGovernance = metadata.governance.planDecision === 'solo_handoff';
  const allowed =
    !isV3TerminalStatus(metadata.status) &&
    metadata.status !== 'blocked' &&
    (!policyEnabled ||
      (requirementsStatus === 'ready' &&
        metadata.governance.planDecision !== null)) &&
    (metadata.governance.policyVersions.review === null ||
      bypassGovernance ||
      reviewStatus === 'passed' ||
      reviewStatus === 'skipped') &&
    (metadata.governance.policyVersions.verification === null ||
      bypassGovernance ||
      verificationStatus === 'passed');
  return {
    allowed,
    requirementsStatus,
    reviewStatus,
    verificationStatus,
    blockerIds,
    requiredEvidence,
  };
}

export function createMigrationParityReport(
  source: LegacyTaskMigrationSource,
  candidate: MigratedLegacyTaskCandidate,
  aliases: LegacyTaskAliasMap,
): MigrationParityReportV1 {
  const mappings: MigrationFieldMapping[] = [];
  const inventory = buildLegacyFieldInventory(source);
  const expectedTaskRef = aliases[source.workflow.taskId];
  compare(
    mappings,
    'workflow.taskId',
    'metadata.legacyCompatibility.legacyTaskId + aliases',
    expectedTaskRef !== undefined &&
      sameTaskRef(expectedTaskRef, candidate.metadata.taskRef) &&
      candidate.metadata.legacyCompatibility?.legacyTaskId ===
        source.workflow.taskId,
  );
  compare(
    mappings,
    'workflow.task',
    'metadata.task',
    source.workflow.task === candidate.metadata.task,
  );
  compare(
    mappings,
    'workflow.mode',
    'metadata.workflowMode',
    normalizeRequiredLegacyMode(source.workflow.mode) ===
      candidate.metadata.workflowMode,
  );
  compare(
    mappings,
    'workflow.currentStep',
    'metadata.currentStep',
    source.workflow.currentStep === candidate.metadata.currentStep,
  );
  compare(
    mappings,
    'workflow.skippedSteps',
    'metadata.skippedSteps',
    sameOrderedStrings(
      source.workflow.skippedSteps,
      candidate.metadata.skippedSteps,
    ),
  );
  compare(
    mappings,
    'workflow.status',
    'metadata.status',
    source.workflow.status === candidate.metadata.status,
  );
  compare(
    mappings,
    'workflow.blockingReason',
    'metadata.blockingReason',
    (source.workflow.blockingReason ?? null) ===
      candidate.metadata.blockingReason,
  );
  compare(
    mappings,
    'workflow.outcome',
    'metadata.outcome',
    (source.workflow.outcome ?? null) === candidate.metadata.outcome,
  );
  compare(
    mappings,
    'workflow.planVersion',
    'metadata.governance.planVersion',
    (source.workflow.planVersion ?? 1) ===
      candidate.metadata.governance.planVersion,
  );
  compare(
    mappings,
    [
      'workflow.planningPolicyVersion',
      'workflow.reviewPolicyVersion',
      'workflow.verificationPolicyVersion',
    ],
    'metadata.governance.policyVersions',
    (source.workflow.planningPolicyVersion ?? null) ===
      candidate.metadata.governance.policyVersions.planning &&
      (source.workflow.reviewPolicyVersion ?? null) ===
        candidate.metadata.governance.policyVersions.review &&
      (source.workflow.verificationPolicyVersion ?? null) ===
        candidate.metadata.governance.policyVersions.verification,
  );
  compare(
    mappings,
    'workflow.planDecision',
    'metadata.governance.planDecision',
    (source.workflow.planDecision ?? null) ===
      candidate.metadata.governance.planDecision,
  );
  compare(
    mappings,
    'workflow.parentTaskId',
    'metadata.parent.taskRef',
    parentMatches(source.workflow.parentTaskId, candidate.metadata, aliases),
  );
  compare(
    mappings,
    ['workflow.startedAt', 'workflow.updatedAt'],
    'metadata.startedAt/updatedAt',
    source.workflow.startedAt === candidate.metadata.startedAt &&
      source.workflow.updatedAt === candidate.metadata.updatedAt,
  );
  compare(
    mappings,
    'source.metadataDigest',
    'metadata.legacyCompatibility.sourceMetadataDigest',
    source.sourceDigests.metadata ===
      candidate.metadata.legacyCompatibility?.sourceMetadataDigest,
  );
  compare(
    mappings,
    'workflow.requirementsStatus',
    'metadata.governance.requirementsStatus',
    source.workflow.requirementsStatus === undefined ||
      source.workflow.requirementsStatus ===
        candidate.metadata.governance.requirementsStatus,
  );
  compare(
    mappings,
    'workflow.requirementsDigest',
    'requirements.legacySource.sourceDigest',
    source.workflow.requirementsDigest === undefined ||
      normalizeLegacyDigest(source.workflow.requirementsDigest) ===
        candidate.requirements.legacySource?.sourceDigest,
  );
  compare(
    mappings,
    'workflow.verificationStatus',
    'metadata.governance.verificationStatus',
    source.workflow.verificationStatus === undefined ||
      source.workflow.verificationStatus ===
        candidate.metadata.governance.verificationStatus,
  );
  compareRequirements(source, candidate, mappings);
  compareReview(source, candidate, mappings);
  compareVerification(source, candidate, mappings);
  compareState(source, candidate, aliases, mappings);

  const legacyGate = evaluateLegacyCompletionGate(source);
  const v3Gate = evaluateV3CompatibilityGate(candidate);
  const contextPackShadow = createMigrationContextPackShadow(
    source,
    candidate,
    aliases,
  );
  const gateMatches = sameGateTuple(legacyGate, v3Gate);
  if (!gateMatches) {
    mappings.push({
      source: 'completionGate',
      sourceFields: [],
      target: 'v3CompatibilityGate',
      matched: false,
    });
  }
  const coveredFields = new Set(
    mappings.flatMap((mapping) => mapping.sourceFields),
  );
  const unmappedFields = sortUtf8StringSet([
    ...mappings
      .filter((mapping) => !mapping.matched)
      .flatMap((mapping) => mapping.sourceFields),
    ...inventory.filter((field) => !coveredFields.has(field)),
  ]);
  const activationBlockers = [...unmappedFields];
  if (!gateMatches) activationBlockers.push('completionGate');
  for (const comparison of contextPackShadow.comparisons) {
    if (!comparison.matched) {
      activationBlockers.push(`contextPackShadow:${comparison.purpose}`);
    }
  }
  if (
    candidate.metadata.workflowMode === 'manteam' &&
    !isV3TerminalStatus(candidate.metadata.status) &&
    candidate.metadata.implementationScope.source === 'legacy_unspecified'
  ) {
    activationBlockers.push('implementationScope.confirmationRequired');
  }
  const taskRefs = [formatTaskRef(candidate.metadata.taskRef)];
  if (candidate.metadata.parent !== null) {
    taskRefs.push(formatTaskRef(candidate.metadata.parent.taskRef));
  }
  return {
    schemaVersion: 1,
    fieldMapVersion: LEGACY_V3_FIELD_MAP_VERSION,
    legacyTaskId: source.workflow.taskId,
    taskRef: candidate.metadata.taskRef,
    sourceDigests: source.sourceDigests,
    v3Digests: {
      metadata: workflowMetadataDigest(candidate.metadata),
      requirements: candidate.requirements.contentDigest,
      review: candidate.review.contentDigest,
      verification: candidate.verification.contentDigest,
    },
    sourceFieldInventory: inventory,
    fieldMappings: mappings,
    unmappedFields,
    legacyGate,
    v3Gate,
    contextPackShadow,
    aliasResolution: {
      taskRefs: sortUtf8StringSet(taskRefs),
      displayIds: sortUtf8StringSet([
        ...candidate.requirements.acceptanceCriteria.map(
          (criterion) => criterion.displayId,
        ),
        ...candidate.review.blockers.map((blocker) => blocker.displayId),
        ...candidate.verification.checks.map((check) => check.displayId),
      ]),
      artifactPaths: sortUtf8StringSet(
        candidate.artifactAliases.map((alias) => alias.legacyPath),
      ),
    },
    activationBlockers: sortUtf8StringSet(activationBlockers),
  };
}

export function assertMigrationParity(report: MigrationParityReportV1): void {
  if (report.unmappedFields.length > 0) {
    throw new Error(
      `MANCODE_MIGRATION_PARITY_FAILED: unmapped fields: ${report.unmappedFields.join(', ')}`,
    );
  }
  if (!sameGateTuple(report.legacyGate, report.v3Gate)) {
    throw new Error('MANCODE_MIGRATION_PARITY_FAILED: completion gate differs');
  }
  if (report.contextPackShadow.comparisons.some((item) => !item.matched)) {
    throw new Error('MANCODE_MIGRATION_PARITY_FAILED: context pack differs');
  }
  if (report.activationBlockers.length > 0) {
    throw new Error(
      `MANCODE_MIGRATION_PARITY_FAILED: activation blockers: ${report.activationBlockers.join(', ')}`,
    );
  }
}

const CONTEXT_PACK_SHADOW_PURPOSES: ContextPurpose[] = [
  'orient',
  'plan',
  'implement',
  'review',
  'verify',
  'handoff',
];

const CONTEXT_PACK_SHADOW_POINTERS: ContextPackSectionPointer[] = [
  '/session',
  '/project',
  '/collaboration',
  '/activeTask',
  '/governance/requirements',
  '/governance/review',
  '/governance/verification',
  '/parentFreshness',
  '/conflicts',
  '/capabilities',
  '/transportFreshness',
];

interface ContextPackShadowProjection {
  project: unknown;
  collaboration: unknown;
  activeTask: unknown;
  requirements: unknown;
  review: unknown;
  verification: unknown;
  parentFreshness: unknown;
}

/**
 * Runs the purpose and omission rules of the V2 Context Pack builder against
 * privacy-safe semantic fingerprints of both authorities. The report stores
 * only digests, while a mismatch still blocks activation for the exact
 * purpose where an adapter would observe different context.
 */
export function createMigrationContextPackShadow(
  source: LegacyTaskMigrationSource,
  candidate: MigratedLegacyTaskCandidate,
  aliases: LegacyTaskAliasMap,
): MigrationContextPackShadowV1 {
  const taskRef = candidate.metadata.taskRef;
  const legacy = legacyContextPackShadowProjection(source, aliases);
  const v3 = v3ContextPackShadowProjection(candidate);
  return {
    schemaVersion: 1,
    comparisons: CONTEXT_PACK_SHADOW_PURPOSES.map((purpose) => {
      const legacyPack = buildContextPackShadow(
        purpose,
        taskRef,
        source.workflow.updatedAt,
        legacy,
      );
      const v3Pack = buildContextPackShadow(
        purpose,
        taskRef,
        candidate.metadata.updatedAt,
        v3,
      );
      const differences: string[] = CONTEXT_PACK_SHADOW_POINTERS.filter(
        (pointer) =>
          digestCanonicalJson(contextPackShadowValue(legacyPack, pointer)) !==
          digestCanonicalJson(contextPackShadowValue(v3Pack, pointer)),
      );
      if (
        legacyPack.packDigest !== v3Pack.packDigest &&
        differences.length === 0
      ) {
        differences.push('/pack');
      }
      return {
        purpose,
        legacyPackDigest: legacyPack.packDigest,
        v3PackDigest: v3Pack.packDigest,
        matched: differences.length === 0,
        differences,
      };
    }),
  };
}

function buildContextPackShadow(
  purpose: ContextPurpose,
  taskRef: TaskRef,
  generatedAt: string,
  projection: ContextPackShadowProjection,
) {
  return buildContextPack({
    generatedAt,
    level: 'task',
    purpose,
    snapshot: {
      schemaEpoch: taskRef.taskId,
      taskRevision: 1,
      requirementsDigest: null,
      reviewDigest: null,
      verificationDigest: null,
      ownershipEpoch: null,
      coordinationRevision: 1,
    },
    budgetLimit: Number.MAX_SAFE_INTEGER,
    sections: [
      contextPackShadowSection('/session', { state: 'migration_shadow' }, true),
      contextPackShadowSection('/activeTask', projection.activeTask, true),
      contextPackShadowSection('/conflicts', [], true),
      contextPackShadowSection(
        '/capabilities',
        { transport: 'migration_shadow' },
        true,
      ),
      contextPackShadowSection(
        '/transportFreshness',
        { state: 'migration_shadow' },
        true,
      ),
      contextPackShadowSection('/project', projection.project),
      contextPackShadowSection('/collaboration', projection.collaboration),
      contextPackShadowSection(
        '/governance/requirements',
        projection.requirements,
      ),
      contextPackShadowSection('/governance/review', projection.review),
      contextPackShadowSection(
        '/governance/verification',
        projection.verification,
      ),
      contextPackShadowSection('/parentFreshness', projection.parentFreshness),
    ],
  });
}

function contextPackShadowSection(
  targetJsonPointer: ContextPackSectionPointer,
  projection: unknown,
  required = false,
): ContextPackSectionInput {
  return {
    targetJsonPointer,
    value: { semanticDigest: digestCanonicalJson(projection) },
    required,
    provenance: [
      {
        targetJsonPointer,
        sourceKind: 'derived',
        taskRef: null,
        artifactRef: null,
        entityKey: null,
        sourceRevision: null,
        sourceDigest: null,
        selectedJsonPointers: [''],
        redactions: [],
      },
    ],
  };
}

function contextPackShadowValue(
  pack: ReturnType<typeof buildContextPack>,
  pointer: ContextPackSectionPointer,
): unknown {
  switch (pointer) {
    case '/session':
      return pack.session;
    case '/project':
      return pack.project;
    case '/collaboration':
      return pack.collaboration;
    case '/activeTask':
      return pack.activeTask;
    case '/governance/requirements':
      return pack.governance.requirements;
    case '/governance/review':
      return pack.governance.review;
    case '/governance/verification':
      return pack.governance.verification;
    case '/parentFreshness':
      return pack.parentFreshness;
    case '/conflicts':
      return pack.conflicts;
    case '/capabilities':
      return pack.capabilities;
    case '/transportFreshness':
      return pack.transportFreshness;
    default:
      return null;
  }
}

function legacyContextPackShadowProjection(
  source: LegacyTaskMigrationSource,
  aliases: LegacyTaskAliasMap,
): ContextPackShadowProjection {
  const workflowMode = normalizeRequiredLegacyMode(source.workflow.mode);
  const taskRef = resolveTaskAlias(aliases, source.workflow.taskId);
  return {
    project: legacyProjectShadow(source, aliases),
    collaboration: {
      workflowMode,
      parentTaskRef:
        source.workflow.parentTaskId === undefined
          ? null
          : formatTaskRef(
              resolveTaskAlias(aliases, source.workflow.parentTaskId),
            ),
    },
    activeTask: {
      taskRef: formatTaskRef(taskRef),
      task: source.workflow.task,
      workflowMode,
      status: source.workflow.status,
      currentStep: source.workflow.currentStep,
      skippedSteps: source.workflow.skippedSteps,
      blockingReason: source.workflow.blockingReason ?? null,
      outcome: source.workflow.outcome ?? null,
      governance: {
        requirementsStatus: legacyRequirementsStatus(source),
        planVersion: source.workflow.planVersion ?? 1,
        planDecision: source.workflow.planDecision ?? null,
        reviewStatus: legacyReviewStatus(source.review),
        verificationStatus: legacyVerificationStatus(source),
      },
    },
    requirements: {
      goal: source.requirements.goal,
      confirmedScope: source.requirements.confirmedScope,
      excludedScope: source.requirements.excludedScope,
      technicalDecisions: source.requirements.technicalDecisions,
      defaults: source.requirements.defaults,
      coverage: source.requirements.coverage,
      acceptanceCriteria: source.requirements.acceptanceCriteria,
      blockingUnknowns: source.requirements.blockingUnknowns,
    },
    review: source.review,
    verification: {
      version: 1,
      planVersion: source.verification.planVersion,
      requirementsDigest: normalizeLegacyDigest(
        source.verification.requirementsDigest,
      ),
      remediationRound: source.verification.remediationRound,
      status: source.verification.status,
      checks: source.verification.checks.map((item) => ({
        acceptanceId: item.acceptanceId,
        required: item.required,
        ...(item.automated === undefined
          ? {}
          : { automated: legacyVerificationEvidenceShadow(item.automated) }),
        ...(item.manual === undefined
          ? {}
          : { manual: legacyVerificationEvidenceShadow(item.manual) }),
      })),
    },
    parentFreshness: {
      parentTaskRef:
        source.workflow.parentTaskId === undefined
          ? null
          : formatTaskRef(
              resolveTaskAlias(aliases, source.workflow.parentTaskId),
            ),
    },
  };
}

function v3ContextPackShadowProjection(
  candidate: MigratedLegacyTaskCandidate,
): ContextPackShadowProjection {
  const { metadata, requirements, review, verification } = candidate;
  return {
    project: candidate.auxiliary,
    collaboration: {
      workflowMode: metadata.workflowMode,
      parentTaskRef:
        metadata.parent === null
          ? null
          : formatTaskRef(metadata.parent.taskRef),
    },
    activeTask: {
      taskRef: formatTaskRef(metadata.taskRef),
      task: metadata.task,
      workflowMode: metadata.workflowMode,
      status: metadata.status,
      currentStep: metadata.currentStep,
      skippedSteps: metadata.skippedSteps,
      blockingReason: metadata.blockingReason,
      outcome: metadata.outcome,
      governance: {
        requirementsStatus: metadata.governance.requirementsStatus,
        planVersion: metadata.governance.planVersion,
        planDecision: metadata.governance.planDecision,
        reviewStatus: metadata.governance.reviewStatus,
        verificationStatus: metadata.governance.verificationStatus,
      },
    },
    requirements: {
      goal: requirements.goal,
      confirmedScope: requirements.functionalScope.inScope,
      excludedScope: requirements.functionalScope.outOfScope,
      technicalDecisions: requirements.technicalDecisions.map(
        (item) => item.statement,
      ),
      defaults: requirements.defaults.map((item) => item.statement),
      coverage: requirements.coverage.map(
        ({ dimension, status, rationale }) => ({
          dimension,
          status,
          rationale,
        }),
      ),
      acceptanceCriteria: requirements.acceptanceCriteria.map((item) => ({
        id: item.legacyId,
        description: item.statement,
        required: item.required,
        method: item.verificationRequirement,
      })),
      blockingUnknowns: requirements.blockingUnknowns.map(
        (item) => item.statement,
      ),
    },
    review: {
      version: '1.0',
      depth: review.depth,
      requiredDomains: review.requiredDomains,
      completedDomains: review.domains
        .filter((item) => item.status === 'passed')
        .map((item) => item.domain),
      reports: Object.fromEntries(
        review.domains.flatMap((item) => {
          if (item.reportRef === null) return [];
          const alias = candidate.artifactAliases.find((candidateAlias) =>
            sameJson(candidateAlias.artifactRef, item.reportRef),
          );
          return alias === undefined ? [] : [[item.domain, alias.legacyPath]];
        }),
      ),
      blockers: review.blockers.map((item) => ({
        id: item.legacyId,
        domain: item.domain,
        status: item.status,
      })),
      remediationRounds: review.remediationRound,
      ...(review.skip === null
        ? {}
        : {
            skipped: {
              reason: review.skip.reason,
              recordedAt: review.skip.approvedAt,
            },
          }),
    },
    verification: {
      version: 1,
      planVersion: verification.planVersion,
      requirementsDigest:
        verification.legacySource?.sourceRequirementsDigest ?? null,
      remediationRound: verification.remediationRound,
      status: verification.status,
      checks: verification.checks.map((item) => ({
        acceptanceId: item.legacyId,
        required: item.required,
        automated: v3VerificationEvidenceShadow(item.automated, candidate),
        manual: v3VerificationEvidenceShadow(item.manual, candidate),
      })),
    },
    parentFreshness: {
      parentTaskRef:
        metadata.parent === null
          ? null
          : formatTaskRef(metadata.parent.taskRef),
    },
  };
}

function legacyProjectShadow(
  source: LegacyTaskMigrationSource,
  aliases: LegacyTaskAliasMap,
): unknown {
  const state = source.state;
  if (state === null) {
    return {
      resumeHint: null,
      projectFacts: null,
      teamAssessment: null,
      migrationAudit: null,
    };
  }
  return {
    resumeHint:
      state.currentTask === source.workflow.taskId &&
      typeof state.currentMode === 'string'
        ? {
            schemaVersion: 1,
            source: 'legacy_state',
            taskRef: resolveTaskAlias(aliases, source.workflow.taskId),
            currentMode: state.currentMode,
            currentWorkflowMode: normalizeLegacyWorkflowMode(
              state.currentWorkflowMode,
            ),
            lastMode:
              typeof state.lastMode === 'string' ? state.lastMode : null,
          }
        : null,
    projectFacts: {
      source: 'legacy_state',
      platform: typeof state.platform === 'string' ? state.platform : null,
      techStack: typeof state.techStack === 'string' ? state.techStack : null,
      uiLibrary: typeof state.uiLibrary === 'string' ? state.uiLibrary : null,
      projectMode:
        typeof state.projectMode === 'string' ? state.projectMode : null,
    },
    teamAssessment: {
      source: 'legacy_state',
      teamModeAutoDetected:
        typeof state.teamModeAutoDetected === 'boolean'
          ? state.teamModeAutoDetected
          : null,
      contributors:
        typeof state.contributors === 'number' ? state.contributors : null,
    },
    migrationAudit: {
      source: 'legacy_state',
      version: typeof state.version === 'string' ? state.version : null,
      initializedAt:
        typeof state.initializedAt === 'string' ? state.initializedAt : null,
    },
  };
}

function v3VerificationEvidenceShadow(
  evidence: VerificationLedgerV1['checks'][number]['automated'],
  candidate: MigratedLegacyTaskCandidate,
): unknown {
  if (evidence === null) return undefined;
  const artifactAlias =
    evidence.artifactRef === null
      ? undefined
      : candidate.artifactAliases.find((item) =>
          sameJson(item.artifactRef, evidence.artifactRef),
        );
  return {
    status: evidence.status,
    ...(evidence.summary === null ? {} : { evidence: evidence.summary }),
    ...(evidence.updatedAt === null ? {} : { updatedAt: evidence.updatedAt }),
    ...(evidence.command === null ? {} : { command: evidence.command }),
    ...(evidence.exitCode === null ? {} : { exitCode: evidence.exitCode }),
    ...(artifactAlias === undefined
      ? {}
      : { evidenceFile: artifactAlias.legacyPath }),
  };
}

function legacyVerificationEvidenceShadow(
  evidence: LegacyVerificationEvidence,
): unknown {
  return {
    status: evidence.status,
    ...(evidence.evidence === undefined ? {} : { evidence: evidence.evidence }),
    ...(evidence.updatedAt === undefined
      ? {}
      : { updatedAt: evidence.updatedAt }),
    ...(evidence.command === undefined ? {} : { command: evidence.command }),
    ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
    ...(evidence.evidenceFile === undefined
      ? {}
      : { evidenceFile: evidence.evidenceFile }),
  };
}

function mapRequirements(
  input: LegacyTaskMigrationInput,
  taskRef: TaskRef,
): RequirementsLedgerV1 {
  const legacy = input.requirements;
  const draft: RequirementsLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef,
    revision: 1,
    status: legacy.blockingUnknowns.length === 0 ? 'confirmed' : 'draft',
    goal: legacy.goal,
    functionalScope: {
      inScope: [...legacy.confirmedScope],
      outOfScope: [...legacy.excludedScope],
    },
    technicalDecisions: legacy.technicalDecisions.map((statement, index) => ({
      displayId: `TD-${index + 1}`,
      legacyId: null,
      decisionId: input.idAllocator.allocate(
        `${input.workflow.taskId}:technicalDecision:${index}`,
      ),
      statement,
    })),
    defaults: legacy.defaults.map((statement, index) => ({
      displayId: `D-${index + 1}`,
      legacyId: null,
      defaultId: input.idAllocator.allocate(
        `${input.workflow.taskId}:default:${index}`,
      ),
      statement,
    })),
    coverage: legacy.coverage.map((coverage, index) => ({
      coverageId: input.idAllocator.allocate(
        `${input.workflow.taskId}:coverage:${coverage.dimension}:${index}`,
      ),
      dimension: coverage.dimension,
      status: coverage.status,
      rationale: coverage.rationale,
    })),
    requirements: [],
    acceptanceCriteria: legacy.acceptanceCriteria.map((criterion, index) => ({
      displayId: criterion.id,
      legacyId: criterion.id,
      criterionId: input.idAllocator.allocate(
        `${input.workflow.taskId}:acceptance:${criterion.id}:${index}`,
      ),
      requirementIds: [],
      statement: criterion.description,
      required: criterion.required,
      verificationRequirement: criterion.method,
    })),
    blockingUnknowns: legacy.blockingUnknowns.map((statement, index) => ({
      displayId: `U-${index + 1}`,
      legacyId: null,
      unknownId: input.idAllocator.allocate(
        `${input.workflow.taskId}:blockingUnknown:${index}`,
      ),
      statement,
      status: 'open',
    })),
    legacySource: {
      sourceSchema: 'requirements-v1',
      sourceDigest:
        input.workflow.requirementsDigest === undefined
          ? requireDigest(
              input.sourceDigests.requirements,
              'legacy requirements source digest',
            )
          : requireDigest(
              normalizeLegacyDigest(input.workflow.requirementsDigest),
              'legacy requirements digest',
            ),
      fieldMapVersion: LEGACY_V3_FIELD_MAP_VERSION,
    },
    contentDigest: '',
    lastOperationId: null,
    updatedAt: input.workflow.updatedAt,
  };
  return { ...draft, contentDigest: requirementsLedgerDigest(draft) };
}

function mapReview(
  input: LegacyTaskMigrationInput,
  taskRef: TaskRef,
  artifactAliases: LegacyArtifactAlias[],
): ReviewLedgerV1 {
  const legacy = input.review;
  const skipped = legacy.skipped;
  const draft: ReviewLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef,
    revision: 1,
    status: 'pending',
    depth: legacy.depth,
    requirementsDigest: null,
    planVersion: null,
    requiredDomains: skipped ? [] : [...legacy.requiredDomains],
    domains: skipped
      ? []
      : legacy.requiredDomains.map((domain) => {
          const legacyPath = legacy.reports[domain];
          return {
            domain,
            status: legacy.completedDomains.includes(domain)
              ? ('passed' as const)
              : ('pending' as const),
            reportRef:
              legacyPath === undefined
                ? null
                : createArtifactAlias(
                    input,
                    taskRef,
                    legacyPath,
                    'review_report',
                    artifactAliases,
                  ),
          };
        }),
    blockers: skipped
      ? []
      : legacy.blockers.map((blocker, index) => ({
          displayId: blocker.id,
          legacyId: blocker.id,
          blockerId: input.idAllocator.allocate(
            `${input.workflow.taskId}:reviewBlocker:${blocker.id}:${index}`,
          ),
          domain: blocker.domain,
          severity: 'legacy_unknown' as const,
          status: blocker.status,
          summary: null,
          waiver: null,
        })),
    remediationRound: skipped ? 0 : legacy.remediationRounds,
    skip:
      skipped === undefined
        ? null
        : {
            reason: skipped.reason,
            approvedByActorId: null,
            approvedAt: skipped.recordedAt,
            source: 'legacy_migration' as const,
          },
    legacySource: {
      sourceSchema: 'review-ledger-1.0',
      sourceDigest: requireDigest(
        input.sourceDigests.review,
        'legacy review source digest',
      ),
      sourceRequirementsDigest: optionalLegacyDigest(
        input.workflow.requirementsDigest,
      ),
      fieldMapVersion: LEGACY_V3_FIELD_MAP_VERSION,
    },
    contentDigest: '',
    lastOperationId: null,
    updatedAt: input.workflow.updatedAt,
  };
  const withStatus = { ...draft, status: deriveReviewLedgerStatus(draft) };
  return { ...withStatus, contentDigest: reviewLedgerDigest(withStatus) };
}

function mapVerification(
  input: LegacyTaskMigrationInput,
  taskRef: TaskRef,
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
  artifactAliases: LegacyArtifactAlias[],
): VerificationLedgerV1 {
  const legacy = input.verification;
  const criteria = new Map(
    requirements.acceptanceCriteria.map((criterion) => [
      criterion.displayId,
      criterion,
    ]),
  );
  const checks = legacy.checks.map((legacyCheck, index) => {
    const criterion = criteria.get(legacyCheck.acceptanceId);
    if (criterion === undefined) {
      throw new Error(
        `MANCODE_MIGRATION_ACCEPTANCE_ALIAS_MISSING: ${legacyCheck.acceptanceId}`,
      );
    }
    return {
      displayId: criterion.displayId,
      legacyId: criterion.legacyId,
      checkId: input.idAllocator.allocate(
        `${input.workflow.taskId}:verificationCheck:${legacyCheck.acceptanceId}:${index}`,
      ),
      criterionId: criterion.criterionId,
      required: legacyCheck.required,
      verificationRequirement: criterion.verificationRequirement,
      automated: mapVerificationEvidence(
        input,
        taskRef,
        legacyCheck.automated,
        'automated',
        `${legacyCheck.acceptanceId}:automated`,
        artifactAliases,
      ),
      manual: mapVerificationEvidence(
        input,
        taskRef,
        legacyCheck.manual,
        'manual',
        `${legacyCheck.acceptanceId}:manual`,
        artifactAliases,
      ),
    };
  });
  const draft: VerificationLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef,
    revision: 1,
    status: 'pending',
    requirementsDigest: requirements.contentDigest,
    planVersion: legacy.planVersion,
    remediationRound: legacy.remediationRound,
    checks,
    legacySource: {
      sourceSchema: 'verification-v1',
      sourceDigest: requireDigest(
        input.sourceDigests.verification,
        'legacy verification source digest',
      ),
      sourceRequirementsDigest: requireDigest(
        normalizeLegacyDigest(legacy.requirementsDigest),
        'legacy verification requirements digest',
      ),
      fieldMapVersion: LEGACY_V3_FIELD_MAP_VERSION,
    },
    contentDigest: '',
    lastOperationId: null,
    updatedAt: input.workflow.updatedAt,
  };
  const stale =
    legacy.planVersion !== (input.workflow.planVersion ?? 1) ||
    legacy.remediationRound !== review.remediationRound ||
    (input.workflow.requirementsDigest !== undefined &&
      normalizeLegacyDigest(legacy.requirementsDigest) !==
        normalizeLegacyDigest(input.workflow.requirementsDigest));
  const withStatus = {
    ...draft,
    status: stale
      ? ('stale' as const)
      : (deriveVerificationLedgerStatus(draft) as VerificationLedgerStatus),
  };
  return {
    ...withStatus,
    contentDigest: verificationLedgerDigest(withStatus),
  };
}

function mapVerificationEvidence(
  input: LegacyTaskMigrationInput,
  taskRef: TaskRef,
  legacy: LegacyVerificationEvidence | undefined,
  kind: 'automated' | 'manual',
  scope: string,
  artifactAliases: LegacyArtifactAlias[],
): VerificationLedgerV1['checks'][number]['automated'] {
  if (legacy === undefined) return null;
  return {
    evidenceId: input.idAllocator.allocate(
      `${input.workflow.taskId}:verificationEvidence:${scope}`,
    ),
    status: legacy.status,
    summary: legacy.evidence ?? null,
    command: legacy.command ?? null,
    exitCode: legacy.exitCode ?? null,
    artifactRef:
      legacy.evidenceFile === undefined
        ? null
        : createArtifactAlias(
            input,
            taskRef,
            legacy.evidenceFile,
            'evidence_summary',
            artifactAliases,
          ),
    confirmedByActorId: null,
    confirmationSource:
      kind === 'manual' && legacy.status === 'passed'
        ? 'legacy_migration'
        : null,
    updatedAt: legacy.updatedAt ?? null,
  };
}

function mapWorkflowMetadata(
  input: LegacyTaskMigrationInput,
  taskRef: TaskRef,
  workflowMode: WorkflowMetadataV3['workflowMode'],
  parent: WorkflowMetadataV3['parent'],
  ownerActorId: Ulid | null,
  participants: Ulid[],
  requirements: RequirementsLedgerV1,
  review: ReviewLedgerV1,
  verification: VerificationLedgerV1,
): WorkflowMetadataV3 {
  const legacy = input.workflow;
  const scope = {
    source: 'legacy_unspecified' as const,
    include: [],
    exclude: [],
    modules: [],
  };
  const activeSoloPlan = matchingActiveSoloPlan(input.state, legacy.taskId);
  const planDecision = legacy.planDecision ?? null;
  if (activeSoloPlan !== null && planDecision !== 'solo_handoff') {
    throw new Error('MANCODE_MIGRATION_SOLO_PLAN_DECISION_MISMATCH');
  }
  if (
    activeSoloPlan !== null &&
    activeSoloPlan.planVersion !== (legacy.planVersion ?? 1)
  ) {
    throw new Error('MANCODE_MIGRATION_SOLO_PLAN_VERSION_MISMATCH');
  }
  return {
    schemaVersion: 3,
    taskRef,
    displaySlug: legacy.taskId,
    task: legacy.task,
    workflowMode,
    visibility: taskRef.namespace,
    coordination:
      workflowMode === 'manteam' || parent?.coordination === 'team'
        ? 'team'
        : 'single',
    status: legacy.status,
    currentStep: legacy.currentStep,
    skippedSteps: [...legacy.skippedSteps],
    blockingReason: legacy.blockingReason ?? null,
    outcome: legacy.outcome ?? null,
    revision: 1,
    transitionState: 'stable',
    lastOperationId: null,
    ownerActorId,
    ownershipEpoch: ownerActorId === null ? 0 : 1,
    participants,
    createdBy: {
      actorId: null,
      client: 'legacy-migration',
      source: 'legacy_migration',
    },
    base: null,
    implementationScope: {
      ...scope,
      digest: digestScope(scope),
    },
    governance: {
      requirementsStatus: legacyRequirementsStatus(input),
      requirementsDigest: requirements.contentDigest,
      planVersion: legacy.planVersion ?? 1,
      planDecision,
      policyVersions: {
        planning: legacy.planningPolicyVersion ?? null,
        review: legacy.reviewPolicyVersion ?? null,
        verification: legacy.verificationPolicyVersion ?? null,
      },
      reviewStatus: review.status,
      reviewLedgerDigest: review.contentDigest,
      verificationStatus: verification.status,
      verificationLedgerDigest: verification.contentDigest,
    },
    soloExecution:
      activeSoloPlan === null
        ? null
        : {
            state: 'active',
            planVersion: activeSoloPlan.planVersion,
            assignedSessionId: null,
            startedAt: null,
            completedAt: null,
          },
    latestCheckpointRef: null,
    parent,
    successorTaskRef: null,
    legacyCompatibility: {
      legacyTaskId: legacy.taskId,
      sourceMetadataDigest: requireDigest(
        input.sourceDigests.metadata,
        'legacy metadata source digest',
      ),
      fieldMapVersion: LEGACY_V3_FIELD_MAP_VERSION,
    },
    startedAt: legacy.startedAt,
    updatedAt: legacy.updatedAt,
  };
}

function mapParent(
  input: LegacyTaskMigrationInput,
  workflowMode: WorkflowMetadataV3['workflowMode'],
  taskRef: TaskRef,
): WorkflowMetadataV3['parent'] {
  const parentTaskId = input.workflow.parentTaskId;
  if (parentTaskId === undefined) {
    if (input.parent !== null) {
      throw new Error('MANCODE_MIGRATION_PARENT_UNEXPECTED');
    }
    return null;
  }
  if (workflowMode !== 'manba') {
    throw new Error('MANCODE_MIGRATION_PARENT_MODE_INVALID');
  }
  if (input.parent === null || input.parent.legacyTaskId !== parentTaskId) {
    throw new Error('MANCODE_MIGRATION_PARENT_ALIAS_MISSING');
  }
  const parent = input.parent.metadata;
  if (
    !sameTaskRef(resolveTaskAlias(input.aliases, parentTaskId), parent.taskRef)
  ) {
    throw new Error('MANCODE_MIGRATION_PARENT_ALIAS_MISMATCH');
  }
  if (parent.taskRef.namespace !== taskRef.namespace) {
    throw new Error('MANCODE_MIGRATION_PARENT_NAMESPACE_MISMATCH');
  }
  return {
    taskRef: parent.taskRef,
    revisionAtCreate: parent.revision,
    planVersionAtCreate: parent.governance.planVersion,
    requirementsDigestAtCreate: parent.governance.requirementsDigest,
    implementationScopeDigestAtCreate: parent.implementationScope.digest,
    visibility: parent.visibility,
    coordination: parent.coordination,
    participants: parent.participants,
  };
}

function assertTaskPlacement(
  workflowMode: WorkflowMetadataV3['workflowMode'],
  taskRef: TaskRef,
  parent: WorkflowMetadataV3['parent'],
): void {
  if (workflowMode === 'manteam' && taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_MIGRATION_MANTEAM_MUST_BE_SHARED');
  }
  if (workflowMode === 'manba' && parent !== null) {
    if (parent.visibility !== taskRef.namespace) {
      throw new Error('MANCODE_MIGRATION_CHILD_NAMESPACE_MISMATCH');
    }
    if (parent.coordination === 'team' && taskRef.namespace !== 'shared') {
      throw new Error('MANCODE_MIGRATION_CHILD_PLACEMENT_INVALID');
    }
  }
}

function mapAuxiliaryData(
  input: LegacyTaskMigrationInput,
  taskRef: TaskRef,
): MigratedLegacyAuxiliaryData {
  const state = input.state;
  if (state === null) {
    return {
      resumeHint: null,
      projectFacts: null,
      teamAssessment: null,
      migrationAudit: null,
    };
  }
  const currentTaskMatches = state.currentTask === input.workflow.taskId;
  const currentWorkflowMode = normalizeLegacyWorkflowMode(
    state.currentWorkflowMode,
  );
  return {
    resumeHint:
      currentTaskMatches && typeof state.currentMode === 'string'
        ? {
            schemaVersion: 1,
            source: 'legacy_state',
            taskRef,
            currentMode: state.currentMode,
            currentWorkflowMode,
            lastMode:
              typeof state.lastMode === 'string' ? state.lastMode : null,
          }
        : null,
    projectFacts: {
      source: 'legacy_state',
      platform: typeof state.platform === 'string' ? state.platform : null,
      techStack: typeof state.techStack === 'string' ? state.techStack : null,
      uiLibrary: typeof state.uiLibrary === 'string' ? state.uiLibrary : null,
      projectMode:
        typeof state.projectMode === 'string' ? state.projectMode : null,
    },
    teamAssessment: {
      source: 'legacy_state',
      teamModeAutoDetected:
        typeof state.teamModeAutoDetected === 'boolean'
          ? state.teamModeAutoDetected
          : null,
      contributors:
        typeof state.contributors === 'number' ? state.contributors : null,
    },
    migrationAudit: {
      source: 'legacy_state',
      version: typeof state.version === 'string' ? state.version : null,
      initializedAt:
        typeof state.initializedAt === 'string' ? state.initializedAt : null,
    },
  };
}

function createArtifactAlias(
  input: LegacyTaskMigrationInput,
  taskRef: TaskRef,
  legacyPath: string,
  kind: 'review_report' | 'evidence_summary',
  aliases: LegacyArtifactAlias[],
): ArtifactRef {
  assertSafeLegacyArtifactPath(legacyPath);
  const existing = aliases.find(
    (alias) =>
      alias.legacyPath === legacyPath && alias.artifactRef.kind === kind,
  );
  if (existing !== undefined) return existing.artifactRef;
  const artifactRef = parseArtifactRef({
    taskRef,
    kind,
    artifactId: input.idAllocator.allocate(
      `${input.workflow.taskId}:artifact:${kind}:${legacyPath}`,
    ),
  });
  aliases.push({ legacyPath, artifactRef });
  return artifactRef;
}

function compareRequirements(
  source: LegacyTaskMigrationSource,
  candidate: MigratedLegacyTaskCandidate,
  mappings: MigrationFieldMapping[],
): void {
  const legacy = source.requirements;
  const v3 = candidate.requirements;
  compare(
    mappings,
    'requirements.goal',
    'requirements.goal',
    legacy.goal === v3.goal,
  );
  compare(
    mappings,
    'requirements.confirmedScope',
    'requirements.functionalScope.inScope',
    sameOrderedStrings(legacy.confirmedScope, v3.functionalScope.inScope),
  );
  compare(
    mappings,
    'requirements.excludedScope',
    'requirements.functionalScope.outOfScope',
    sameOrderedStrings(legacy.excludedScope, v3.functionalScope.outOfScope),
  );
  compare(
    mappings,
    'requirements.technicalDecisions',
    'requirements.technicalDecisions[].statement',
    sameOrderedStrings(
      legacy.technicalDecisions,
      v3.technicalDecisions.map((item) => item.statement),
    ),
  );
  compare(
    mappings,
    'requirements.defaults',
    'requirements.defaults[].statement',
    sameOrderedStrings(
      legacy.defaults,
      v3.defaults.map((item) => item.statement),
    ),
  );
  compare(
    mappings,
    'requirements.coverage',
    'requirements.coverage',
    sameJson(
      legacy.coverage,
      v3.coverage.map(({ dimension, status, rationale }) => ({
        dimension,
        status,
        rationale,
      })),
    ),
  );
  compare(
    mappings,
    'requirements.acceptanceCriteria',
    'requirements.acceptanceCriteria',
    sameJson(
      legacy.acceptanceCriteria,
      v3.acceptanceCriteria.map((criterion) => ({
        id: criterion.legacyId,
        description: criterion.statement,
        required: criterion.required,
        method: criterion.verificationRequirement,
      })),
    ),
  );
  compare(
    mappings,
    'requirements.blockingUnknowns',
    'requirements.blockingUnknowns[].statement',
    sameOrderedStrings(
      legacy.blockingUnknowns,
      v3.blockingUnknowns.map((item) => item.statement),
    ) && v3.blockingUnknowns.every((item) => item.status === 'open'),
  );
  compare(
    mappings,
    'requirements.sourceDigest',
    'migration-parity.sourceDigests.requirements',
    legacyRequirementsSourceDigest(source) === v3.legacySource?.sourceDigest,
  );
}

function legacyRequirementsSourceDigest(
  source: LegacyTaskMigrationSource,
): string {
  return source.workflow.requirementsDigest === undefined
    ? source.sourceDigests.requirements
    : normalizeLegacyDigest(source.workflow.requirementsDigest);
}

function compareReview(
  source: LegacyTaskMigrationSource,
  candidate: MigratedLegacyTaskCandidate,
  mappings: MigrationFieldMapping[],
): void {
  const legacy = source.review;
  const v3 = candidate.review;
  compare(mappings, 'review.depth', 'review.depth', legacy.depth === v3.depth);
  compare(
    mappings,
    'review.requiredDomains',
    'review.requiredDomains',
    sameOrderedStrings(legacy.requiredDomains, v3.requiredDomains),
  );
  compare(
    mappings,
    'review.completedDomains',
    'review.domains[].status',
    sameOrderedStrings(
      legacy.completedDomains,
      v3.domains
        .filter((domain) => domain.status === 'passed')
        .map((domain) => domain.domain),
    ),
  );
  compare(
    mappings,
    'review.reports',
    'artifactAliases[review_report]',
    Object.entries(legacy.reports).every(([domain, legacyPath]) => {
      const mappedDomain = v3.domains.find((item) => item.domain === domain);
      return (
        mappedDomain?.reportRef !== null &&
        mappedDomain?.reportRef !== undefined &&
        candidate.artifactAliases.some(
          (alias) =>
            alias.legacyPath === legacyPath &&
            alias.artifactRef.kind === 'review_report' &&
            sameJson(alias.artifactRef, mappedDomain.reportRef),
        )
      );
    }),
  );
  compare(
    mappings,
    'review.blockers',
    'review.blockers',
    sameJson(
      legacy.blockers,
      v3.blockers.map((blocker) => ({
        id: blocker.legacyId,
        domain: blocker.domain,
        status: blocker.status,
      })),
    ),
  );
  compare(
    mappings,
    'review.remediationRounds',
    'review.remediationRound',
    legacy.remediationRounds === v3.remediationRound,
  );
  compare(
    mappings,
    'review.skipped',
    'review.skip',
    sameJson(
      legacy.skipped ?? null,
      v3.skip === null
        ? null
        : { reason: v3.skip.reason, recordedAt: v3.skip.approvedAt },
    ),
  );
  compare(
    mappings,
    'review.sourceDigest',
    'review.legacySource.sourceDigest',
    source.sourceDigests.review === v3.legacySource?.sourceDigest,
  );
}

function compareVerification(
  source: LegacyTaskMigrationSource,
  candidate: MigratedLegacyTaskCandidate,
  mappings: MigrationFieldMapping[],
): void {
  const legacy = source.verification;
  const v3 = candidate.verification;
  compare(
    mappings,
    'verification.planVersion',
    'verification.planVersion',
    legacy.planVersion === v3.planVersion,
  );
  compare(
    mappings,
    'verification.requirementsDigest',
    'verification.legacySource.sourceRequirementsDigest',
    normalizeLegacyDigest(legacy.requirementsDigest) ===
      v3.legacySource?.sourceRequirementsDigest,
  );
  compare(
    mappings,
    'verification.remediationRound',
    'verification.remediationRound',
    legacy.remediationRound === v3.remediationRound,
  );
  compare(
    mappings,
    'verification.checks',
    'verification.checks',
    legacy.checks.length === v3.checks.length &&
      legacy.checks.every((legacyCheck) => {
        const mapped = v3.checks.find(
          (check) => check.legacyId === legacyCheck.acceptanceId,
        );
        return (
          mapped !== undefined &&
          mapped.required === legacyCheck.required &&
          evidenceMatches(
            legacyCheck.automated,
            mapped.automated,
            candidate.artifactAliases,
            'automated',
          ) &&
          evidenceMatches(
            legacyCheck.manual,
            mapped.manual,
            candidate.artifactAliases,
            'manual',
          )
        );
      }),
  );
  compare(
    mappings,
    'verification.sourceDigest',
    'verification.legacySource.sourceDigest',
    source.sourceDigests.verification === v3.legacySource?.sourceDigest,
  );
}

function compareState(
  source: LegacyTaskMigrationSource,
  candidate: MigratedLegacyTaskCandidate,
  aliases: LegacyTaskAliasMap,
  mappings: MigrationFieldMapping[],
): void {
  const state = source.state;
  if (state === null) return;
  const auxiliary = candidate.auxiliary;
  compare(
    mappings,
    [
      'state.platform',
      'state.techStack',
      'state.uiLibrary',
      'state.projectMode',
    ],
    'auxiliary.projectFacts',
    auxiliary.projectFacts !== null &&
      auxiliary.projectFacts.platform === (state.platform ?? null) &&
      auxiliary.projectFacts.techStack === (state.techStack ?? null) &&
      auxiliary.projectFacts.uiLibrary === (state.uiLibrary ?? null) &&
      auxiliary.projectFacts.projectMode === (state.projectMode ?? null),
  );
  compare(
    mappings,
    ['state.teamModeAutoDetected', 'state.contributors'],
    'auxiliary.teamAssessment',
    auxiliary.teamAssessment !== null &&
      auxiliary.teamAssessment.teamModeAutoDetected ===
        (state.teamModeAutoDetected ?? null) &&
      auxiliary.teamAssessment.contributors === (state.contributors ?? null),
  );
  compare(
    mappings,
    ['state.version', 'state.initializedAt'],
    'auxiliary.migrationAudit',
    auxiliary.migrationAudit !== null &&
      auxiliary.migrationAudit.version === (state.version ?? null) &&
      auxiliary.migrationAudit.initializedAt === (state.initializedAt ?? null),
  );
  if (state.currentTask !== source.workflow.taskId) return;
  compare(
    mappings,
    [
      'state.currentTask',
      'state.currentWorkflowMode',
      'state.currentMode',
      'state.lastMode',
    ],
    'auxiliary.resumeHint',
    auxiliary.resumeHint !== null &&
      sameTaskRef(
        aliases[source.workflow.taskId] as TaskRef,
        auxiliary.resumeHint.taskRef,
      ) &&
      auxiliary.resumeHint.currentMode === state.currentMode &&
      auxiliary.resumeHint.currentWorkflowMode ===
        normalizeLegacyWorkflowMode(state.currentWorkflowMode) &&
      auxiliary.resumeHint.lastMode === (state.lastMode ?? null),
  );
  compare(
    mappings,
    'state.skippedSteps',
    'metadata.skippedSteps',
    sameOrderedStrings(
      state.skippedSteps ?? [],
      candidate.metadata.skippedSteps,
    ),
  );
  const activeSoloPlan = matchingActiveSoloPlan(state, source.workflow.taskId);
  compare(
    mappings,
    'state.activeSoloPlan',
    'metadata.soloExecution',
    activeSoloPlan === null
      ? candidate.metadata.soloExecution === null
      : candidate.metadata.soloExecution?.state === 'active' &&
          candidate.metadata.soloExecution.planVersion ===
            activeSoloPlan.planVersion,
  );
}

function buildLegacyFieldInventory(
  source: LegacyTaskMigrationSource,
): string[] {
  const fields = [
    'workflow.taskId',
    'workflow.task',
    'workflow.mode',
    'workflow.currentStep',
    'workflow.skippedSteps',
    'workflow.startedAt',
    'workflow.updatedAt',
    'workflow.status',
    'requirements.goal',
    'requirements.confirmedScope',
    'requirements.excludedScope',
    'requirements.technicalDecisions',
    'requirements.defaults',
    'requirements.coverage',
    'requirements.acceptanceCriteria',
    'requirements.blockingUnknowns',
    'review.depth',
    'review.requiredDomains',
    'review.completedDomains',
    'review.reports',
    'review.blockers',
    'review.remediationRounds',
    'verification.planVersion',
    'verification.requirementsDigest',
    'verification.remediationRound',
    'verification.checks',
  ];
  const workflow = source.workflow;
  if (workflow.blockingReason !== undefined)
    fields.push('workflow.blockingReason');
  if (workflow.parentTaskId !== undefined) fields.push('workflow.parentTaskId');
  if (workflow.outcome !== undefined) fields.push('workflow.outcome');
  if (workflow.planVersion !== undefined) fields.push('workflow.planVersion');
  if (workflow.reviewPolicyVersion !== undefined)
    fields.push('workflow.reviewPolicyVersion');
  if (workflow.planningPolicyVersion !== undefined)
    fields.push('workflow.planningPolicyVersion');
  if (workflow.verificationPolicyVersion !== undefined)
    fields.push('workflow.verificationPolicyVersion');
  if (workflow.requirementsStatus !== undefined)
    fields.push('workflow.requirementsStatus');
  if (workflow.requirementsDigest !== undefined)
    fields.push('workflow.requirementsDigest');
  if (workflow.planDecision !== undefined) fields.push('workflow.planDecision');
  if (workflow.verificationStatus !== undefined)
    fields.push('workflow.verificationStatus');
  if (source.review.skipped !== undefined) fields.push('review.skipped');
  if (source.state !== null) {
    fields.push(
      'state.version',
      'state.platform',
      'state.initializedAt',
      'state.techStack',
      'state.uiLibrary',
      'state.teamModeAutoDetected',
      'state.contributors',
      'state.projectMode',
    );
    if (source.state.currentTask === source.workflow.taskId) {
      fields.push(
        'state.currentMode',
        'state.lastMode',
        'state.currentTask',
        'state.currentWorkflowMode',
        'state.skippedSteps',
        'state.activeSoloPlan',
      );
    }
  }
  return sortUtf8StringSet(fields);
}

function evidenceMatches(
  legacy: LegacyVerificationEvidence | undefined,
  mapped: VerificationLedgerV1['checks'][number]['automated'],
  aliases: LegacyArtifactAlias[],
  kind: 'automated' | 'manual',
): boolean {
  if (legacy === undefined) return mapped === null;
  if (mapped === null) return false;
  const artifactMatches =
    legacy.evidenceFile === undefined
      ? mapped.artifactRef === null
      : mapped.artifactRef !== null &&
        aliases.some(
          (alias) =>
            alias.legacyPath === legacy.evidenceFile &&
            alias.artifactRef.kind === 'evidence_summary' &&
            sameJson(alias.artifactRef, mapped.artifactRef),
        );
  return (
    legacy.status === mapped.status &&
    (legacy.evidence ?? null) === mapped.summary &&
    (legacy.command ?? null) === mapped.command &&
    (legacy.exitCode ?? null) === mapped.exitCode &&
    (legacy.updatedAt ?? null) === mapped.updatedAt &&
    artifactMatches &&
    (kind !== 'manual' ||
      legacy.status !== 'passed' ||
      mapped.confirmationSource === 'legacy_migration')
  );
}

function legacyRequirementsStatus(
  source: LegacyTaskMigrationSource,
): RequirementsStatus {
  if (source.workflow.requirementsStatus !== undefined) {
    return source.workflow.requirementsStatus;
  }
  return legacyRequirementsAreReady(source.requirements)
    ? 'ready'
    : 'needs_clarification';
}

function legacyReviewStatus(legacy: LegacyReviewLedger): ReviewStatus {
  if (legacy.skipped !== undefined) return 'skipped';
  if (legacy.blockers.some((blocker) => blocker.status === 'open')) {
    return 'blocked';
  }
  if (
    legacy.requiredDomains.every((domain) =>
      legacy.completedDomains.includes(domain),
    )
  ) {
    return 'passed';
  }
  if (legacy.completedDomains.length === 0) return 'pending';
  return 'in_review';
}

function legacyVerificationStatus(
  source: LegacyTaskMigrationSource,
): VerificationStatus {
  const legacy = source.verification;
  const stale =
    legacy.planVersion !== (source.workflow.planVersion ?? 1) ||
    legacy.remediationRound !== source.review.remediationRounds ||
    (source.workflow.requirementsDigest !== undefined &&
      normalizeLegacyDigest(legacy.requirementsDigest) !==
        normalizeLegacyDigest(source.workflow.requirementsDigest));
  return stale ? 'stale' : legacy.status;
}

function legacyRequiredEvidence(
  requirements: LegacyRequirementsLedger,
): string[] {
  return sortUtf8StringSet(
    requirements.acceptanceCriteria
      .filter((criterion) => criterion.required)
      .flatMap((criterion) => [
        ...(criterion.method === 'manual' ? [] : [`${criterion.id}:automated`]),
        ...(criterion.method === 'automated' ? [] : [`${criterion.id}:manual`]),
      ]),
  );
}

function resolveTaskAlias(
  aliases: LegacyTaskAliasMap,
  legacyTaskId: string,
): TaskRef {
  const taskRef = aliases[legacyTaskId];
  if (taskRef === undefined) {
    throw new Error(`MANCODE_MIGRATION_TASK_ALIAS_MISSING: ${legacyTaskId}`);
  }
  return taskRef;
}

function normalizeRequiredLegacyMode(
  mode: LegacyWorkflowMode,
): WorkflowMetadataV3['workflowMode'] {
  const normalized = normalizeLegacyWorkflowMode(mode);
  if (normalized === null) {
    throw new Error(`MANCODE_MIGRATION_WORKFLOW_MODE_INVALID: ${mode}`);
  }
  return normalized;
}

function normalizeParticipants(
  owner: LegacyMigrationOwner | null,
  ownerActorId: Ulid | null,
): Ulid[] {
  if (owner === null || ownerActorId === null) return [];
  const participants = sortUtf8StringSet([
    ownerActorId,
    ...(owner.participants ?? []),
  ]);
  return participants as Ulid[];
}

function matchingActiveSoloPlan(
  state: Partial<MancodeState> | null,
  legacyTaskId: string,
): { taskId: string; planVersion: number } | null {
  const active = state?.activeSoloPlan;
  if (
    active === null ||
    active === undefined ||
    active.taskId !== legacyTaskId
  ) {
    return null;
  }
  return active;
}

function parentMatches(
  legacyParentTaskId: string | undefined,
  metadata: WorkflowMetadataV3,
  aliases: LegacyTaskAliasMap,
): boolean {
  if (legacyParentTaskId === undefined) return metadata.parent === null;
  const expected = aliases[legacyParentTaskId];
  return (
    expected !== undefined &&
    metadata.parent !== null &&
    sameTaskRef(expected, metadata.parent.taskRef)
  );
}

function sameTaskRef(left: TaskRef, right: TaskRef): boolean {
  return left.namespace === right.namespace && left.taskId === right.taskId;
}

function sameGateTuple(
  left: CompletionGateTuple,
  right: CompletionGateTuple,
): boolean {
  return (
    left.allowed === right.allowed &&
    left.requirementsStatus === right.requirementsStatus &&
    left.reviewStatus === right.reviewStatus &&
    left.verificationStatus === right.verificationStatus &&
    sameOrderedStrings(left.blockerIds, right.blockerIds) &&
    sameOrderedStrings(left.requiredEvidence, right.requiredEvidence)
  );
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compare(
  mappings: MigrationFieldMapping[],
  source: string | string[],
  target: string,
  matched: boolean,
): void {
  const sourceFields = Array.isArray(source) ? source : [source];
  mappings.push({
    source: sourceFields.join(' + '),
    sourceFields,
    target,
    matched,
  });
}

function requireDigest(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function optionalLegacyDigest(value: string | undefined): string | null {
  if (value === undefined) return null;
  return normalizeLegacyDigest(value);
}

function normalizeLegacyDigest(value: string): string {
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value;
  if (/^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`;
  throw new Error('legacy digest must be a SHA-256 digest');
}

function digestScope(scope: {
  source: 'legacy_unspecified';
  include: string[];
  exclude: string[];
  modules: string[];
}): string {
  return digestCanonicalJson(scope);
}

function assertSafeLegacyArtifactPath(value: string): void {
  if (
    !value ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('MANCODE_MIGRATION_ARTIFACT_PATH_UNSAFE');
  }
}

function isLegacyTerminalStatus(status: LegacyWorkflowMeta['status']): boolean {
  return status === 'completed' || status === 'abandoned';
}

function isV3TerminalStatus(status: WorkflowMetadataV3['status']): boolean {
  return (
    status === 'completed' || status === 'abandoned' || status === 'superseded'
  );
}

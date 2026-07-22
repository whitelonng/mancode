import { recordLocalDiagnostic } from '../runtime/diagnostics.js';
import {
  type EntityHomeStoreContext,
  resolveTaskEntityHomeStore,
} from '../runtime/entity-home-store.js';
import { type SessionStateV1, parseSessionState } from '../runtime/session.js';
import { checkpointDigest } from '../team/checkpoints.js';
import type { ClaimV1 } from '../team/claims.js';
import {
  type CoordinationCapabilitiesV1,
  capabilitiesFromProjectConfig,
  parseCoordinationCapabilities,
} from '../team/transport.js';
import type { TaskAggregateManifestV1 } from './aggregate.js';
import { digestCanonicalJson } from './canonical.js';
import {
  type CompatibilityFailureCode,
  type WriterCapability,
  evaluateCompatibilityGate,
} from './compatibility.js';
import {
  type ContextLevel,
  type ContextPackSectionInput,
  type ContextPackV2,
  type ContextPurpose,
  buildContextPack,
  defaultContextPackBudget,
} from './context-pack.js';
import type {
  ContextPackSectionPointer,
  ProvenanceEntry,
} from './context-pack.js';
import { type LegacyAuthorityScan, scanLegacyAuthority } from './layout.js';
import type { ManagedAdapter } from './manifest.js';
import {
  type PendingOperationRecord,
  type StoredCoordinationSnapshot,
  type StoredParentSnapshot,
  type StoredProjectSnapshot,
  type StoredTaskSnapshot,
  V3ContextStore,
} from './store.js';
import { type TaskRef, parseTaskRef, parseTaskRefValue } from './task-ref.js';
import { assertParentWorkflowRelation } from './workflow-metadata.js';
import { workflowMetadataDigest } from './workflow-metadata.js';

export type ContextResolutionIntent = 'read' | 'mutate';

export type ContextRepairCode =
  | 'MANCODE_OPERATION_REPAIR_REQUIRED'
  | 'MANCODE_TASK_TRANSITION_PENDING'
  | 'MANCODE_TASK_AGGREGATE_INCONSISTENT'
  | 'MANCODE_TASK_HEAD_FENCE_MISSING'
  | 'MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE'
  | 'MANCODE_TASK_HEAD_FENCE_MISMATCH'
  | 'MANCODE_CONFIG_POLICY_INCONSISTENT'
  | 'MANCODE_WORKSPACE_BINDING_MISMATCH'
  | 'MANCODE_PARENT_RELATION_INVALID';

export type ContextWriteBlockerCode =
  | CompatibilityFailureCode
  | 'MANCODE_SESSION_REQUIRED'
  | 'MANCODE_PARENT_UNAVAILABLE'
  | 'MANCODE_PARENT_STALE'
  | 'MANCODE_TRANSPORT_NOT_FRESH'
  | 'MANCODE_FOREIGN_ACTIVE_CLAIM'
  | ContextRepairCode;

export interface ContextResolverCompatibility {
  expectedSchemaEpoch: string;
  readerVersion: string;
  writerVersion: string;
  writerCapabilities: readonly WriterCapability[];
  adapterVersions: Partial<Record<ManagedAdapter, string>>;
}

export interface ContextResolveRequest {
  /**
   * A parsed session identity; its task pointer is convenience-only. Read-only
   * callers may omit it when they supply an explicit TaskRef.
   */
  session: SessionStateV1 | null;
  taskRef?: TaskRef | string;
  level: ContextLevel;
  purpose: ContextPurpose;
  intent?: ContextResolutionIntent;
  compatibility: ContextResolverCompatibility;
  /** The current checkout HEAD, mandatory for a stable shared-task fence. */
  codeHead?: string | null;
  capabilities?: CoordinationCapabilitiesV1;
  budgetLimit?: number;
  generatedAt?: Date;
  maxReadAttempts?: number;
}

export interface ContextResolverOptions {
  projectRoot: string;
  entityHomeStoreContext: EntityHomeStoreContext;
  store?: V3ContextStore;
  now?: () => Date;
}

export interface ContextResolutionIssue {
  code: ContextRepairCode | ContextWriteBlockerCode;
  operationIds: string[];
}

export interface ContextRepairEnvelope {
  state: 'repair_required';
  taskRef: TaskRef;
  issues: ContextResolutionIssue[];
  partialFields: Array<
    | 'session'
    | 'taskRef'
    | 'schemaEpoch'
    | 'capabilities'
    | 'transportFreshness'
  >;
}

export interface ContextResolution {
  taskRef: TaskRef;
  session: SessionStateV1 | null;
  aggregate: TaskAggregateManifestV1 | null;
  metadata: StoredTaskSnapshot['metadata'] | null;
  repair: ContextRepairEnvelope | null;
  writeBlockers: ContextResolutionIssue[];
  mutatingAllowed: boolean;
  pack: ContextPackV2;
}

interface ResolverReadSnapshot {
  project: StoredProjectSnapshot;
  task: StoredTaskSnapshot;
  coordination: StoredCoordinationSnapshot;
  parent: StoredParentSnapshot | null;
  parentReadError: string | null;
  legacy: LegacyAuthorityScan;
  capabilities: CoordinationCapabilitiesV1;
  codeHead: string | null;
  fingerprint: string;
}

const PURPOSE_REQUIRED_SECTIONS: Record<
  ContextPurpose,
  ReadonlySet<ContextPackSectionPointer>
> = {
  orient: new Set(),
  plan: new Set(['/project', '/governance/requirements', '/parentFreshness']),
  implement: new Set([
    '/governance/requirements',
    '/latestCheckpoint',
    '/claims',
  ]),
  review: new Set([
    '/governance/requirements',
    '/governance/review',
    '/governance/verification',
  ]),
  verify: new Set([
    '/governance/requirements',
    '/governance/review',
    '/governance/verification',
  ]),
  handoff: new Set([
    '/collaboration',
    '/governance/requirements',
    '/governance/review',
    '/governance/verification',
    '/latestCheckpoint',
    '/latestHandoff',
    '/claims',
  ]),
};

/**
 * Resolves one read-stable V3 tuple. A resolver never composes a Context Pack
 * from entities read at different revisions: it rereads the complete relevant
 * tuple and retries when a fingerprint changes.
 */
export class ContextResolver {
  private readonly store: V3ContextStore;
  private readonly now: () => Date;

  constructor(private readonly options: ContextResolverOptions) {
    this.store = options.store ?? new V3ContextStore(options.projectRoot);
    this.now = options.now ?? (() => new Date());
  }

  async resolve(request: ContextResolveRequest): Promise<ContextResolution> {
    const session =
      request.session === null ? null : parseSessionState(request.session);
    if (session !== null && session.status !== 'active') {
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    }
    const requestedTask = resolveRequestedTask(request.taskRef, session);
    const intent = request.intent ?? 'read';
    const maxReadAttempts = parseMaxReadAttempts(request.maxReadAttempts);
    const preflight = await this.readCompatibilityPreflight(request, intent);
    if (!preflight.readAllowed) {
      throw new Error(preflight.failures[0] ?? 'MANCODE_CONTEXT_READ_BLOCKED');
    }
    if (intent === 'mutate' && !preflight.writeAllowed) {
      throw new Error(preflight.failures[0] ?? 'MANCODE_CONTEXT_WRITE_BLOCKED');
    }
    const taskRef = (await this.store.locateTask(requestedTask)).taskRef;
    const snapshot = await this.readStableSnapshot(
      taskRef,
      request,
      maxReadAttempts,
    );
    const compatibility = this.evaluateCompatibility(
      request,
      intent,
      snapshot.project,
      snapshot.legacy,
    );
    if (!compatibility.readAllowed) {
      throw new Error(
        compatibility.failures[0] ?? 'MANCODE_CONTEXT_READ_BLOCKED',
      );
    }

    const repairIssues = collectRepairIssues(snapshot);
    const writeBlockers = collectWriteBlockers(
      snapshot,
      compatibility.failures,
      repairIssues,
      session?.actorId ?? null,
    );
    const repair =
      repairIssues.length === 0
        ? null
        : createRepairEnvelope(taskRef, repairIssues);
    const mutatingAllowed = repair === null && writeBlockers.length === 0;
    const pack =
      repair === null
        ? buildStablePack(snapshot, session, request, writeBlockers, this.now())
        : buildRepairPack(snapshot, session, request, repair, this.now());
    const resolution: ContextResolution = {
      taskRef,
      session,
      aggregate: repair === null ? snapshot.task.aggregate : null,
      metadata: repair === null ? snapshot.task.metadata : null,
      repair,
      writeBlockers,
      mutatingAllowed,
      pack,
    };
    if (intent === 'mutate' && !mutatingAllowed) {
      throw new Error(
        repair?.issues[0]?.code ??
          writeBlockers[0]?.code ??
          'MANCODE_CONTEXT_WRITE_BLOCKED',
      );
    }
    return resolution;
  }

  private async readCompatibilityPreflight(
    request: ContextResolveRequest,
    intent: ContextResolutionIntent,
  ) {
    const [project, legacy] = await Promise.all([
      this.store.readProjectSnapshot(),
      scanLegacyAuthority(this.store.projectRoot),
    ]);
    return this.evaluateCompatibility(request, intent, project, legacy);
  }

  private evaluateCompatibility(
    request: ContextResolveRequest,
    intent: ContextResolutionIntent,
    project: StoredProjectSnapshot,
    legacy: LegacyAuthorityScan,
  ) {
    return evaluateCompatibilityGate({
      manifest: project.manifest,
      expectedSchemaEpoch: request.compatibility.expectedSchemaEpoch,
      readerVersion: request.compatibility.readerVersion,
      writerVersion: request.compatibility.writerVersion,
      writerCapabilities: request.compatibility.writerCapabilities,
      adapterVersions: request.compatibility.adapterVersions,
      currentLegacyBaseline: legacy.baseline,
      legacyAuthorityPresent: legacy.authorityPresent,
      operation: intent === 'read' ? 'read' : 'v3_business_write',
    });
  }

  private async readStableSnapshot(
    taskRef: TaskRef,
    request: ContextResolveRequest,
    maxReadAttempts: number,
  ): Promise<ResolverReadSnapshot> {
    for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
      const first = await this.readSnapshot(taskRef, request);
      const second = await this.readSnapshot(taskRef, request);
      if (first.fingerprint === second.fingerprint) return first;
    }
    await recordLocalDiagnostic(this.store.projectRoot, {
      kind: 'context_stale',
    }).catch(() => undefined);
    throw new Error('MANCODE_CONTEXT_READ_UNSTABLE');
  }

  private async readSnapshot(
    taskRef: TaskRef,
    request: ContextResolveRequest,
  ): Promise<ResolverReadSnapshot> {
    const homeStore = resolveTaskEntityHomeStore(
      this.options.entityHomeStoreContext,
      taskRef,
    );
    const [project, task, coordination, legacy] = await Promise.all([
      this.store.readProjectSnapshot(),
      this.store.readTaskSnapshot(taskRef),
      this.store.readCoordinationSnapshot(taskRef, homeStore),
      scanLegacyAuthority(this.store.projectRoot),
    ]);
    const parent = await readParentForResolver(this.store, task);
    const capabilities = parseCoordinationCapabilities(
      request.capabilities ?? capabilitiesFromProjectConfig(project.config),
    );
    const codeHead = parseCodeHeadOrNull(request.codeHead);
    return {
      project,
      task,
      coordination,
      parent: parent.snapshot,
      parentReadError: parent.error,
      legacy,
      capabilities,
      codeHead,
      fingerprint: digestCanonicalJson({
        project: project.fingerprint,
        task: task.fingerprint,
        coordination: coordination.fingerprint,
        parent: parent.snapshot?.fingerprint ?? null,
        parentReadError: parent.error,
        legacy: {
          baseline: legacy.baseline,
          authorityPresent: legacy.authorityPresent,
          unsafePaths: legacy.unsafePaths,
        },
        capabilities,
        codeHead,
      }),
    };
  }
}

function resolveRequestedTask(
  explicit: ContextResolveRequest['taskRef'],
  session: SessionStateV1 | null,
): TaskRef | string {
  if (explicit !== undefined) {
    return typeof explicit === 'string'
      ? explicit.includes(':')
        ? parseTaskRef(explicit)
        : explicit
      : parseTaskRefValue(explicit);
  }
  if (session === null || session.activeTaskRef === null) {
    throw new Error('MANCODE_TASK_REQUIRED');
  }
  return session.activeTaskRef;
}

function parseMaxReadAttempts(value: number | undefined): number {
  if (value === undefined) return 3;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error(
      'context resolver maxReadAttempts must be between 1 and 10',
    );
  }
  return value;
}

function parseCodeHeadOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('context resolver codeHead is invalid');
  }
  return value;
}

async function readParentForResolver(
  store: V3ContextStore,
  task: StoredTaskSnapshot,
): Promise<{ snapshot: StoredParentSnapshot | null; error: string | null }> {
  try {
    return {
      snapshot: await store.readParentSnapshot(task.metadata),
      error: null,
    };
  } catch (error) {
    return {
      snapshot: null,
      error:
        error instanceof Error
          ? normalizeParentReadError(error.message)
          : 'MANCODE_PARENT_UNAVAILABLE',
    };
  }
}

function normalizeParentReadError(message: string): string {
  return message.startsWith('MANCODE_')
    ? 'MANCODE_PARENT_UNAVAILABLE'
    : 'MANCODE_PARENT_UNAVAILABLE';
}

function collectRepairIssues(
  snapshot: ResolverReadSnapshot,
): ContextResolutionIssue[] {
  const issues: ContextResolutionIssue[] = [];
  if (snapshot.task.aggregate === null) {
    issues.push({
      code: 'MANCODE_TASK_AGGREGATE_INCONSISTENT',
      operationIds: [],
    });
  }
  if (snapshot.task.metadata.transitionState !== 'stable') {
    issues.push({ code: 'MANCODE_TASK_TRANSITION_PENDING', operationIds: [] });
  }
  if (snapshot.coordination.pendingOperations.length > 0) {
    issues.push({
      code: 'MANCODE_OPERATION_REPAIR_REQUIRED',
      operationIds: operationIds(snapshot.coordination.pendingOperations),
    });
  }
  if (
    snapshot.project.config.workspaceId !== snapshot.project.policy.workspaceId
  ) {
    issues.push({
      code: 'MANCODE_CONFIG_POLICY_INCONSISTENT',
      operationIds: [],
    });
  }
  if (
    snapshot.project.config.workspaceId !==
    snapshot.coordination.homeStore.workspaceId
  ) {
    issues.push({
      code: 'MANCODE_WORKSPACE_BINDING_MISMATCH',
      operationIds: [],
    });
  }
  if (snapshot.task.metadata.parent !== null) {
    if (snapshot.parent !== null) {
      try {
        assertParentWorkflowRelation(
          snapshot.task.metadata,
          snapshot.parent.metadata,
        );
      } catch {
        issues.push({
          code: 'MANCODE_PARENT_RELATION_INVALID',
          operationIds: [],
        });
      }
    }
  }
  if (snapshot.task.metadata.visibility === 'shared') {
    const aggregate = snapshot.task.aggregate;
    const fence = snapshot.coordination.taskHeadFence;
    if (fence === null) {
      issues.push({
        code: 'MANCODE_TASK_HEAD_FENCE_MISSING',
        operationIds: [],
      });
    } else if (snapshot.codeHead === null) {
      issues.push({
        code: 'MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE',
        operationIds: [],
      });
    } else if (
      aggregate === null ||
      !fenceMatchesAggregate(fence, aggregate, snapshot.codeHead)
    ) {
      issues.push({
        code: 'MANCODE_TASK_HEAD_FENCE_MISMATCH',
        operationIds: [],
      });
    }
  }
  return dedupeIssues(issues);
}

function collectWriteBlockers(
  snapshot: ResolverReadSnapshot,
  compatibilityFailures: CompatibilityFailureCode[],
  repairIssues: ContextResolutionIssue[],
  actorId: string | null,
): ContextResolutionIssue[] {
  const blockers: ContextResolutionIssue[] = [
    ...repairIssues,
    ...compatibilityFailures.map((code) => ({ code, operationIds: [] })),
  ];
  if (snapshot.task.metadata.parent !== null) {
    if (snapshot.parentReadError !== null) {
      blockers.push({ code: 'MANCODE_PARENT_UNAVAILABLE', operationIds: [] });
    } else if (snapshot.parent?.staleReasons.length) {
      blockers.push({ code: 'MANCODE_PARENT_STALE', operationIds: [] });
    }
  }
  if (
    snapshot.capabilities.transport === 'git-ref' &&
    snapshot.capabilities.transportFreshness !== 'fresh'
  ) {
    blockers.push({ code: 'MANCODE_TRANSPORT_NOT_FRESH', operationIds: [] });
  }
  if (actorId === null) {
    blockers.push({ code: 'MANCODE_SESSION_REQUIRED', operationIds: [] });
  } else if (hasForeignActiveClaim(snapshot.coordination.claims, actorId)) {
    blockers.push({ code: 'MANCODE_FOREIGN_ACTIVE_CLAIM', operationIds: [] });
  }
  return dedupeIssues(blockers);
}

function fenceMatchesAggregate(
  fence: NonNullable<StoredCoordinationSnapshot['taskHeadFence']>,
  aggregate: TaskAggregateManifestV1,
  codeHead: string,
): boolean {
  return (
    fence.taskRef.namespace === aggregate.taskRef.namespace &&
    fence.taskRef.taskId === aggregate.taskRef.taskId &&
    fence.taskRevision === aggregate.taskRevision &&
    fence.ownershipEpoch === aggregate.ownershipEpoch &&
    fence.aggregateDigest === digestCanonicalJson(aggregate) &&
    fence.codeRef.head === codeHead
  );
}

function createRepairEnvelope(
  taskRef: TaskRef,
  issues: ContextResolutionIssue[],
): ContextRepairEnvelope {
  return {
    state: 'repair_required',
    taskRef,
    issues,
    partialFields: [
      'session',
      'taskRef',
      'schemaEpoch',
      'capabilities',
      'transportFreshness',
    ],
  };
}

function buildStablePack(
  snapshot: ResolverReadSnapshot,
  session: SessionStateV1 | null,
  request: ContextResolveRequest,
  writeBlockers: ContextResolutionIssue[],
  now: Date,
): ContextPackV2 {
  const { task, project, coordination, capabilities } = snapshot;
  const sections: ContextPackSectionInput[] = [
    runtimeSection('/session', sessionProjection(session), true),
    activeTaskSection(task),
    derivedSection(
      '/conflicts',
      writeBlockers,
      [task.fingerprint, coordination.fingerprint, project.fingerprint],
      true,
    ),
    runtimeSection('/capabilities', capabilitiesProjection(capabilities), true),
    runtimeSection(
      '/transportFreshness',
      transportFreshnessProjection(capabilities),
      true,
    ),
  ];
  if (request.level !== 'bootstrap' && request.level !== 'full') {
    const optionalSections: Array<ContextPackSectionInput | null> = [
      runtimeSection('/actor', { actorId: session?.actorId ?? null }),
      projectSection(project),
      entitySection(
        '/collaboration',
        collaborationProjection(task),
        task.metadata.taskRef,
        'workflow',
        task.metadata.revision,
        workflowMetadataDigest(task.metadata),
      ),
      entitySection(
        '/governance/requirements',
        task.requirements,
        task.metadata.taskRef,
        'requirements-ledger',
        task.requirements.revision,
        task.requirements.contentDigest,
      ),
      entitySection(
        '/governance/review',
        task.review,
        task.metadata.taskRef,
        'review-ledger',
        task.review.revision,
        task.review.contentDigest,
      ),
      entitySection(
        '/governance/verification',
        task.verification,
        task.metadata.taskRef,
        'verification-ledger',
        task.verification.revision,
        task.verification.contentDigest,
      ),
      parentFreshnessSection(snapshot),
      latestCheckpointSection(task),
      latestHandoffSection(coordination),
      claimsSection(coordination.claims),
    ];
    for (const section of optionalSections) {
      if (section !== null) {
        sections.push(markPurposeRequired(section, request.purpose));
      }
    }
  }
  return buildContextPack({
    generatedAt: (request.generatedAt ?? now).toISOString(),
    level: request.level,
    purpose: request.purpose,
    snapshot: {
      schemaEpoch: project.manifest.epoch,
      taskRevision: task.metadata.revision,
      requirementsDigest: task.requirements.contentDigest,
      reviewDigest: task.review.contentDigest,
      verificationDigest: task.verification.contentDigest,
      ownershipEpoch: task.metadata.ownershipEpoch,
      coordinationRevision:
        capabilities.remoteRevision ?? project.config.revision,
    },
    budgetLimit: resolveBudgetLimit(request),
    sections,
  });
}

function buildRepairPack(
  snapshot: ResolverReadSnapshot,
  session: SessionStateV1 | null,
  request: ContextResolveRequest,
  repair: ContextRepairEnvelope,
  now: Date,
): ContextPackV2 {
  const capabilities = snapshot.capabilities;
  return buildContextPack({
    generatedAt: (request.generatedAt ?? now).toISOString(),
    level: request.level,
    purpose: request.purpose,
    snapshot: {
      schemaEpoch: snapshot.project.manifest.epoch,
      taskRevision: null,
      requirementsDigest: null,
      reviewDigest: null,
      verificationDigest: null,
      ownershipEpoch: null,
      coordinationRevision:
        capabilities.remoteRevision ?? snapshot.project.config.revision,
    },
    budgetLimit: resolveBudgetLimit(request),
    sections: [
      runtimeSection('/session', sessionProjection(session), true),
      runtimeSection(
        '/activeTask',
        { taskRef: repair.taskRef, state: repair.state },
        true,
      ),
      derivedSection('/conflicts', repair.issues, [snapshot.fingerprint], true),
      runtimeSection(
        '/capabilities',
        capabilitiesProjection(capabilities),
        true,
      ),
      runtimeSection(
        '/transportFreshness',
        transportFreshnessProjection(capabilities),
        true,
      ),
    ],
  });
}

function resolveBudgetLimit(request: ContextResolveRequest): number {
  if (request.budgetLimit !== undefined) {
    if (!Number.isSafeInteger(request.budgetLimit) || request.budgetLimit < 0) {
      throw new Error('context resolver budgetLimit must be non-negative');
    }
    return request.budgetLimit;
  }
  if (request.level === 'full') return Number.MAX_SAFE_INTEGER;
  return defaultContextPackBudget(request.level);
}

function sessionProjection(session: SessionStateV1 | null) {
  if (session === null) {
    return {
      sessionId: null,
      actorId: null,
      client: null,
      identitySource: null,
      activeTaskRef: null,
      activeMode: null,
    };
  }
  return {
    sessionId: session.sessionId,
    actorId: session.actorId,
    client: session.client,
    identitySource: session.identitySource,
    activeTaskRef: session.activeTaskRef,
    activeMode: session.activeMode,
  };
}

function activeTaskProjection(task: StoredTaskSnapshot) {
  const governance = task.metadata.governance;
  return {
    taskRef: task.metadata.taskRef,
    workflowMode: task.metadata.workflowMode,
    visibility: task.metadata.visibility,
    coordination: task.metadata.coordination,
    status: task.metadata.status,
    revision: task.metadata.revision,
    currentStep: task.metadata.currentStep,
    ownerActorId: task.metadata.ownerActorId,
    implementationScope: task.metadata.implementationScope,
    governance: {
      requirementsStatus: governance.requirementsStatus,
      planVersion: governance.planVersion,
      planDecision: governance.planDecision,
      policyVersions: governance.policyVersions,
      reviewStatus: governance.reviewStatus,
      verificationStatus: governance.verificationStatus,
    },
    plan: task.plan?.artifactRef ?? null,
    latestCheckpointRef: task.metadata.latestCheckpointRef,
  };
}

function activeTaskSection(task: StoredTaskSnapshot): ContextPackSectionInput {
  const targetJsonPointer = '/activeTask';
  const provenance: ProvenanceEntry[] = [
    entityProvenance(
      targetJsonPointer,
      task.metadata.taskRef,
      'workflow',
      task.metadata.revision,
      workflowMetadataDigest(task.metadata),
    ),
  ];
  if (task.plan !== null) {
    provenance.push({
      targetJsonPointer,
      sourceKind: 'artifact',
      taskRef: task.metadata.taskRef,
      artifactRef: task.plan.artifactRef,
      entityKey: null,
      sourceRevision: null,
      sourceDigest: task.plan.digest,
      selectedJsonPointers: ['/plan'],
      redactions: [],
    });
  }
  return {
    targetJsonPointer,
    value: activeTaskProjection(task),
    required: true,
    provenance,
  };
}

function collaborationProjection(task: StoredTaskSnapshot) {
  return {
    coordination: task.metadata.coordination,
    ownerActorId: task.metadata.ownerActorId,
    ownershipEpoch: task.metadata.ownershipEpoch,
    participants: task.metadata.participants,
    implementationScope: task.metadata.implementationScope,
  };
}

function projectProjection(project: StoredProjectSnapshot) {
  return {
    workspaceId: project.config.workspaceId,
    configRevision: project.config.revision,
    policyRevision: project.policy.revision,
    transport: project.config.transport,
    teamPolicy: project.policy.policy,
    defaultVisibility: project.policy.defaultVisibility,
    schemaEpoch: project.manifest.epoch,
    facts: project.projectFacts,
    confirmedDecisions: project.confirmedDecisions,
  };
}

function projectSection(
  project: StoredProjectSnapshot,
): ContextPackSectionInput {
  const targetJsonPointer = '/project';
  const provenance: ProvenanceEntry[] = [
    entityProvenance(
      targetJsonPointer,
      null,
      'project-config',
      project.config.revision,
      digestCanonicalJson(project.config),
    ),
    entityProvenance(
      targetJsonPointer,
      null,
      'team-policy',
      project.policy.revision,
      digestCanonicalJson(project.policy),
    ),
    entityProvenance(
      targetJsonPointer,
      null,
      'schema-manifest',
      0,
      digestCanonicalJson(project.manifest),
    ),
  ];
  if (project.projectFacts !== null) {
    provenance.push(
      entityProvenance(
        targetJsonPointer,
        null,
        'project-facts',
        project.projectFacts.revision,
        digestCanonicalJson(project.projectFacts),
      ),
    );
  }
  for (const decision of project.confirmedDecisions) {
    provenance.push(
      entityProvenance(
        targetJsonPointer,
        decision.taskRef,
        `confirmed-decision:${decision.decisionId}`,
        1,
        digestCanonicalJson(decision),
      ),
    );
  }
  return {
    targetJsonPointer,
    value: projectProjection(project),
    provenance,
  };
}

function transportFreshnessProjection(
  capabilities: CoordinationCapabilitiesV1,
) {
  return {
    transport: capabilities.transport,
    freshness: capabilities.transportFreshness,
    lastSuccessfulSyncAt: capabilities.lastSuccessfulSyncAt,
    remoteRevision: capabilities.remoteRevision,
  };
}

function capabilitiesProjection(capabilities: CoordinationCapabilitiesV1) {
  return {
    claimAcquisition: capabilities.claimAcquisition,
    writeGuard: capabilities.writeGuard,
    transport: capabilities.transport,
  };
}

function parentFreshnessSection(
  snapshot: ResolverReadSnapshot,
): ContextPackSectionInput | null {
  if (snapshot.task.metadata.parent === null) return null;
  const value =
    snapshot.parentReadError !== null
      ? { state: 'unavailable', reasons: ['parent_unavailable'] }
      : {
          state: snapshot.parent?.staleReasons.length === 0 ? 'fresh' : 'stale',
          reasons: snapshot.parent?.staleReasons ?? [],
        };
  return derivedSection('/parentFreshness', value, [
    snapshot.task.fingerprint,
    snapshot.parent?.fingerprint ?? 'parent:unavailable',
  ]);
}

function latestCheckpointSection(
  task: StoredTaskSnapshot,
): ContextPackSectionInput | null {
  if (task.latestCheckpoint === null) return null;
  return entitySection(
    '/latestCheckpoint',
    task.latestCheckpoint,
    task.latestCheckpoint.taskRef,
    'checkpoint',
    task.latestCheckpoint.taskRevision,
    checkpointDigest(task.latestCheckpoint),
  );
}

function latestHandoffSection(
  coordination: StoredCoordinationSnapshot,
): ContextPackSectionInput | null {
  const handoff = coordination.handoffs[0];
  if (handoff === undefined) return null;
  return entitySection(
    '/latestHandoff',
    handoff,
    handoff.taskRef,
    'handoff',
    handoff.revision,
    digestCanonicalJson(handoff),
  );
}

function claimsSection(claims: ClaimV1[]): ContextPackSectionInput | null {
  const activeClaims = claims.filter((claim) => claim.state === 'active');
  if (activeClaims.length === 0) return null;
  return {
    targetJsonPointer: '/claims',
    value: activeClaims,
    provenance: activeClaims.map((claim) =>
      entityProvenance(
        '/claims',
        claim.taskRef,
        `claim:${claim.claimId}`,
        claim.revision,
        digestCanonicalJson(claim),
      ),
    ),
  };
}

function runtimeSection(
  targetJsonPointer: ContextPackSectionPointer,
  value: unknown,
  required = false,
): ContextPackSectionInput {
  return {
    targetJsonPointer,
    value,
    required,
    provenance: [
      {
        targetJsonPointer,
        sourceKind: 'runtime',
        taskRef: null,
        artifactRef: null,
        entityKey: null,
        sourceRevision: null,
        sourceDigest: digestCanonicalJson(value),
        selectedJsonPointers: [''],
        redactions: [],
      },
    ],
  };
}

function entitySection(
  targetJsonPointer: ContextPackSectionPointer,
  value: unknown,
  taskRef: TaskRef | null,
  entityKey: string,
  sourceRevision: number,
  sourceDigest: string,
  required = false,
): ContextPackSectionInput {
  return {
    targetJsonPointer,
    value,
    required,
    provenance: [
      entityProvenance(
        targetJsonPointer,
        taskRef,
        entityKey,
        sourceRevision,
        sourceDigest,
      ),
    ],
  };
}

function entityProvenance(
  targetJsonPointer: ContextPackSectionPointer,
  taskRef: TaskRef | null,
  entityKey: string,
  sourceRevision: number,
  sourceDigest: string,
): ProvenanceEntry {
  return {
    targetJsonPointer,
    sourceKind: 'entity',
    taskRef,
    artifactRef: null,
    entityKey,
    sourceRevision,
    sourceDigest,
    selectedJsonPointers: [''],
    redactions: [],
  };
}

function derivedSection(
  targetJsonPointer: ContextPackSectionPointer,
  value: unknown,
  sourceDigests: string[],
  required = false,
): ContextPackSectionInput {
  return {
    targetJsonPointer,
    value,
    required,
    provenance: [...new Set(sourceDigests)]
      .sort(compareUtf8)
      .map((sourceDigest) => ({
        targetJsonPointer,
        sourceKind: 'derived',
        taskRef: null,
        artifactRef: null,
        entityKey: null,
        sourceRevision: null,
        sourceDigest: /^sha256:[a-f0-9]{64}$/.test(sourceDigest)
          ? sourceDigest
          : digestCanonicalJson({ sourceDigest }),
        selectedJsonPointers: [''],
        redactions: [],
      })),
  };
}

function markPurposeRequired(
  section: ContextPackSectionInput,
  purpose: ContextPurpose,
): ContextPackSectionInput {
  return PURPOSE_REQUIRED_SECTIONS[purpose].has(section.targetJsonPointer)
    ? { ...section, required: true }
    : section;
}

function operationIds(records: PendingOperationRecord[]): string[] {
  return [...new Set(records.map((record) => record.operationId))].sort(
    compareUtf8,
  );
}

function hasForeignActiveClaim(claims: ClaimV1[], actorId: string): boolean {
  return claims.some(
    (claim) => claim.state === 'active' && claim.ownerActorId !== actorId,
  );
}

function dedupeIssues(
  issues: ContextResolutionIssue[],
): ContextResolutionIssue[] {
  const byCode = new Map<string, ContextResolutionIssue>();
  for (const issue of issues) {
    const previous = byCode.get(issue.code);
    byCode.set(issue.code, {
      code: issue.code,
      operationIds: [
        ...new Set([...(previous?.operationIds ?? []), ...issue.operationIds]),
      ].sort(compareUtf8),
    });
  }
  return [...byCode.values()].sort((left, right) =>
    left.code.localeCompare(right.code, 'en'),
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

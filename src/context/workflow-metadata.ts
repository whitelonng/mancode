import {
  type ArtifactRef,
  assertReferenceNamespace,
  parseArtifactRef,
} from './artifact-ref.js';
import { digestCanonicalJson, sortUtf8StringSet } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import { type ParentSnapshot, parseParentSnapshot } from './parent-snapshot.js';
import { assertSharedTextSafe } from './privacy.js';
import {
  type Coordination,
  type WorkflowMode,
  type WorkflowStatus,
  type WorkflowTransitionOperation,
  assertWorkflowStatusTransition,
  parseWorkflowMode,
  parseWorkflowStatus,
} from './schema.js';
import {
  type TaskNamespace,
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type WorkflowTransitionState =
  | 'stable'
  | 'operation_pending'
  | 'pending_repair';
export type RequirementsStatus = 'ready' | 'needs_clarification';
export type ReviewStatus =
  | 'pending'
  | 'in_review'
  | 'passed'
  | 'blocked'
  | 'skipped'
  | 'stale';
export type VerificationStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'stale'
  | 'manual_required'
  | 'blocked';
export type PlanDecision =
  | 'plan_only'
  | 'solo_handoff'
  | 'governed_execution'
  | null;

export type WorkflowPolicyComponent = 'planning' | 'review' | 'verification';

export const SUPPORTED_WORKFLOW_POLICY_VERSIONS = {
  planning: [1, 2],
  review: [1, 2],
  verification: [1],
} as const;

export class WorkflowPolicyVersionUnsupportedError extends Error {
  readonly code = 'MANCODE_POLICY_VERSION_UNSUPPORTED' as const;

  constructor(
    readonly component: WorkflowPolicyComponent,
    readonly observedVersion: unknown,
    readonly supportedVersions: readonly number[],
    readonly requiredWriter: string,
  ) {
    super(
      `MANCODE_POLICY_VERSION_UNSUPPORTED: component=${component} observed=${String(observedVersion)} supported=${supportedVersions.join(',')} requiredWriter=${requiredWriter}`,
    );
    this.name = 'WorkflowPolicyVersionUnsupportedError';
  }
}

export interface WorkflowMetadataV3 {
  schemaVersion: 3;
  taskRef: TaskRef;
  displaySlug: string;
  task: string;
  workflowMode: WorkflowMode;
  visibility: TaskNamespace;
  coordination: Coordination;
  status: WorkflowStatus;
  currentStep: number;
  skippedSteps: string[];
  blockingReason: string | null;
  outcome: 'fixed' | 'verified' | 'no_repro' | 'manual_test_required' | null;
  revision: number;
  transitionState: WorkflowTransitionState;
  lastOperationId: Ulid | null;
  ownerActorId: Ulid | null;
  ownershipEpoch: number;
  participants: Ulid[];
  createdBy: {
    actorId: Ulid | null;
    client: string;
    source: 'actor' | 'legacy_migration';
  };
  base: {
    branch: string;
    head: string;
    upstream: string | null;
  } | null;
  implementationScope: {
    source: 'explicit' | 'inherited' | 'legacy_unspecified';
    include: string[];
    exclude: string[];
    modules: string[];
    digest: string;
  };
  governance: {
    requirementsStatus: RequirementsStatus;
    requirementsDigest: string;
    planVersion: number;
    planDecision: PlanDecision;
    policyVersions: {
      planning: number | null;
      review: number | null;
      verification: number | null;
    };
    reviewStatus: ReviewStatus;
    reviewLedgerDigest: string;
    verificationStatus: VerificationStatus;
    verificationLedgerDigest: string;
  };
  soloExecution: {
    state: 'active' | 'completed';
    planVersion: number;
    assignedSessionId: Ulid | null;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
  latestCheckpointRef: ArtifactRef | null;
  parent: ParentSnapshot | null;
  successorTaskRef: TaskRef | null;
  legacyCompatibility: {
    legacyTaskId: string;
    sourceMetadataDigest: string;
    fieldMapVersion: number;
  } | null;
  startedAt: string;
  updatedAt: string;
}

const TRANSITION_STATES = new Set<WorkflowTransitionState>([
  'stable',
  'operation_pending',
  'pending_repair',
]);
const REQUIREMENTS_STATUSES = new Set<RequirementsStatus>([
  'ready',
  'needs_clarification',
]);
const REVIEW_STATUSES = new Set<ReviewStatus>([
  'pending',
  'in_review',
  'passed',
  'blocked',
  'skipped',
  'stale',
]);
const VERIFICATION_STATUSES = new Set<VerificationStatus>([
  'pending',
  'passed',
  'failed',
  'stale',
  'manual_required',
  'blocked',
]);
const PLAN_DECISIONS = new Set<Exclude<PlanDecision, null>>([
  'plan_only',
  'solo_handoff',
  'governed_execution',
]);
const OUTCOMES = new Set<NonNullable<WorkflowMetadataV3['outcome']>>([
  'fixed',
  'verified',
  'no_repro',
  'manual_test_required',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseWorkflowMetadata(value: unknown): WorkflowMetadataV3 {
  assertRecord(value, 'workflow metadata');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'taskRef',
      'displaySlug',
      'task',
      'workflowMode',
      'visibility',
      'coordination',
      'status',
      'currentStep',
      'skippedSteps',
      'blockingReason',
      'outcome',
      'revision',
      'transitionState',
      'lastOperationId',
      'ownerActorId',
      'ownershipEpoch',
      'participants',
      'createdBy',
      'base',
      'implementationScope',
      'governance',
      'soloExecution',
      'latestCheckpointRef',
      'parent',
      'successorTaskRef',
      'legacyCompatibility',
      'startedAt',
      'updatedAt',
    ],
    'workflow metadata',
  );
  if (value.schemaVersion !== 3) {
    throw new Error('workflow metadata schemaVersion must be 3');
  }
  if (value.visibility !== 'local' && value.visibility !== 'shared') {
    throw new Error('workflow metadata visibility must be local or shared');
  }
  if (value.coordination !== 'single' && value.coordination !== 'team') {
    throw new Error('workflow metadata coordination must be single or team');
  }
  const taskRef = parseTaskRefValue(value.taskRef);
  if (taskRef.namespace !== value.visibility) {
    throw new Error(
      'workflow metadata TaskRef namespace must match visibility',
    );
  }
  const metadata: WorkflowMetadataV3 = {
    schemaVersion: 3,
    taskRef,
    displaySlug: parseNonEmptyString(
      value.displaySlug,
      'workflow metadata displaySlug',
    ),
    task: parseNonEmptyString(value.task, 'workflow metadata task'),
    workflowMode: parseWorkflowMode(value.workflowMode),
    visibility: value.visibility,
    coordination: value.coordination,
    status: parseWorkflowStatus(value.status),
    currentStep: parseCurrentStep(value.currentStep, value.workflowMode),
    skippedSteps: parseUniqueStringList(
      value.skippedSteps,
      'workflow metadata skippedSteps',
    ),
    blockingReason: parseNonEmptyStringOrNull(
      value.blockingReason,
      'workflow metadata blockingReason',
    ),
    outcome: parseOutcome(value.outcome),
    revision: parsePositiveInteger(
      value.revision,
      'workflow metadata revision',
    ),
    transitionState: parseTransitionState(value.transitionState),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'workflow metadata lastOperationId',
    ),
    ownerActorId: parseUlidOrNull(
      value.ownerActorId,
      'workflow metadata ownerActorId',
    ),
    ownershipEpoch: parseNonNegativeInteger(
      value.ownershipEpoch,
      'workflow metadata ownershipEpoch',
    ),
    participants: parseUlidSet(
      value.participants,
      'workflow metadata participants',
    ),
    createdBy: parseCreatedBy(value.createdBy),
    base: parseBase(value.base),
    implementationScope: parseImplementationScope(value.implementationScope),
    governance: parseGovernance(value.governance),
    soloExecution: parseSoloExecution(value.soloExecution),
    latestCheckpointRef:
      value.latestCheckpointRef === null
        ? null
        : parseArtifactRef(value.latestCheckpointRef),
    parent:
      value.parent === null
        ? null
        : parseParentSnapshot({ parent: value.parent }),
    successorTaskRef:
      value.successorTaskRef === null
        ? null
        : parseTaskRefValue(value.successorTaskRef),
    legacyCompatibility: parseLegacyCompatibility(value.legacyCompatibility),
    startedAt: parseTimestamp(value.startedAt, 'workflow metadata startedAt'),
    updatedAt: parseTimestamp(value.updatedAt, 'workflow metadata updatedAt'),
  };
  assertWorkflowMetadataShape(metadata);
  if (metadata.visibility === 'shared') {
    assertSharedTextSafe(metadata.displaySlug, 'workflow metadata displaySlug');
    assertSharedTextSafe(metadata.task, 'workflow metadata task');
    if (metadata.blockingReason !== null) {
      assertSharedTextSafe(
        metadata.blockingReason,
        'workflow metadata blockingReason',
      );
    }
    for (const [label, values] of [
      ['implementationScope.include', metadata.implementationScope.include],
      ['implementationScope.exclude', metadata.implementationScope.exclude],
      ['implementationScope.modules', metadata.implementationScope.modules],
    ] as const) {
      for (const value of values) {
        assertSharedTextSafe(value, `workflow metadata ${label}`);
      }
    }
  }
  return metadata;
}

export function workflowMetadataDigest(metadata: WorkflowMetadataV3): string {
  return digestCanonicalJson({
    taskRef: metadata.taskRef,
    displaySlug: metadata.displaySlug,
    task: metadata.task,
    workflowMode: metadata.workflowMode,
    visibility: metadata.visibility,
    coordination: metadata.coordination,
    status: metadata.status,
    currentStep: metadata.currentStep,
    skippedSteps: metadata.skippedSteps,
    blockingReason: metadata.blockingReason,
    outcome: metadata.outcome,
    ownerActorId: metadata.ownerActorId,
    ownershipEpoch: metadata.ownershipEpoch,
    participants: metadata.participants,
    createdBy: metadata.createdBy,
    base: metadata.base,
    implementationScope: metadata.implementationScope,
    governance: metadata.governance,
    soloExecution: metadata.soloExecution,
    parent: metadata.parent,
    successorTaskRef: metadata.successorTaskRef,
    legacyCompatibility: metadata.legacyCompatibility,
  });
}

export function assertWorkflowMetadataTransition(
  previous: WorkflowMetadataV3,
  next: WorkflowMetadataV3,
  operation: WorkflowTransitionOperation,
): void {
  if (next.revision !== previous.revision + 1) {
    throw new Error(
      'workflow metadata revision must increase exactly once per mutation',
    );
  }
  if (
    previous.workflowMode !== next.workflowMode ||
    previous.visibility !== next.visibility ||
    previous.coordination !== next.coordination ||
    previous.taskRef.namespace !== next.taskRef.namespace ||
    previous.taskRef.taskId !== next.taskRef.taskId ||
    JSON.stringify(previous.parent) !== JSON.stringify(next.parent)
  ) {
    throw new Error(
      'workflow mode, dimensions, TaskRef, and parent are immutable',
    );
  }
  assertWorkflowStatusTransition({
    sourceTaskRef: previous.taskRef,
    from: previous.status,
    to: next.status,
    operation,
    successorTaskRef: next.successorTaskRef,
  });
}

export function assertParentWorkflowRelation(
  child: WorkflowMetadataV3,
  parent: WorkflowMetadataV3,
): void {
  if (child.parent === null) {
    throw new Error('workflow has no parent snapshot');
  }
  if (
    child.parent.taskRef.taskId !== parent.taskRef.taskId ||
    child.parent.taskRef.namespace !== parent.taskRef.namespace ||
    child.parent.visibility !== parent.visibility ||
    child.parent.coordination !== parent.coordination
  ) {
    throw new Error('parent metadata does not match the child parent snapshot');
  }
  if (child.workflowMode !== 'manba') {
    throw new Error('only manba workflows may have a parent');
  }
  if (
    (child.visibility === 'local' && parent.workflowMode !== 'man') ||
    (child.visibility === 'shared' &&
      child.coordination === 'single' &&
      parent.workflowMode !== 'man') ||
    (child.visibility === 'shared' &&
      child.coordination === 'team' &&
      parent.workflowMode !== 'manteam')
  ) {
    throw new Error(
      'parent workflow mode does not satisfy the child inheritance contract',
    );
  }
}

function parseTransitionState(value: unknown): WorkflowTransitionState {
  if (
    typeof value !== 'string' ||
    !TRANSITION_STATES.has(value as WorkflowTransitionState)
  ) {
    throw new Error('workflow metadata transitionState is invalid');
  }
  return value as WorkflowTransitionState;
}

function parseCurrentStep(value: unknown, mode: unknown): number {
  const workflowMode = parseWorkflowMode(mode);
  const maxStep = workflowMode === 'manba' ? 5 : 9;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maxStep
  ) {
    throw new Error('workflow metadata currentStep is invalid');
  }
  return value;
}

function parseOutcome(value: unknown): WorkflowMetadataV3['outcome'] {
  if (value === null) return null;
  const outcome = value as NonNullable<WorkflowMetadataV3['outcome']>;
  if (typeof value !== 'string' || !OUTCOMES.has(outcome)) {
    throw new Error('workflow metadata outcome is invalid');
  }
  return outcome;
}

function parseCreatedBy(value: unknown): WorkflowMetadataV3['createdBy'] {
  assertRecord(value, 'workflow metadata createdBy');
  assertKnownKeys(
    value,
    ['actorId', 'client', 'source'],
    'workflow metadata createdBy',
  );
  if (value.source !== 'actor' && value.source !== 'legacy_migration') {
    throw new Error('workflow metadata createdBy source is invalid');
  }
  if (typeof value.client !== 'string' || !value.client.trim()) {
    throw new Error('workflow metadata createdBy client is required');
  }
  const actorId = parseUlidOrNull(
    value.actorId,
    'workflow metadata createdBy actorId',
  );
  if (value.source === 'actor' && actorId === null) {
    throw new Error('native workflow metadata requires a createdBy actorId');
  }
  return { actorId, client: value.client, source: value.source };
}

function parseBase(value: unknown): WorkflowMetadataV3['base'] {
  if (value === null) return null;
  assertRecord(value, 'workflow metadata base');
  assertKnownKeys(
    value,
    ['branch', 'head', 'upstream'],
    'workflow metadata base',
  );
  if (
    typeof value.branch !== 'string' ||
    !value.branch.trim() ||
    typeof value.head !== 'string' ||
    !value.head.trim()
  ) {
    throw new Error('workflow metadata base branch and head are required');
  }
  return {
    branch: value.branch,
    head: value.head,
    upstream: parseNonEmptyStringOrNull(
      value.upstream,
      'workflow metadata base upstream',
    ),
  };
}

function parseImplementationScope(
  value: unknown,
): WorkflowMetadataV3['implementationScope'] {
  assertRecord(value, 'workflow metadata implementationScope');
  assertKnownKeys(
    value,
    ['source', 'include', 'exclude', 'modules', 'digest'],
    'workflow metadata implementationScope',
  );
  if (
    value.source !== 'explicit' &&
    value.source !== 'inherited' &&
    value.source !== 'legacy_unspecified'
  ) {
    throw new Error('workflow metadata implementationScope source is invalid');
  }
  const source =
    value.source as WorkflowMetadataV3['implementationScope']['source'];
  const scope = {
    source,
    include: parseStringSet(
      value.include,
      'workflow metadata implementationScope include',
    ),
    exclude: parseStringSet(
      value.exclude,
      'workflow metadata implementationScope exclude',
    ),
    modules: parseStringSet(
      value.modules,
      'workflow metadata implementationScope modules',
    ),
  };
  const digest = parseDigest(
    value.digest,
    'workflow metadata implementationScope digest',
  );
  if (digest !== digestCanonicalJson(scope)) {
    throw new Error(
      'workflow metadata implementationScope digest does not match scope',
    );
  }
  return { ...scope, digest };
}

function parseGovernance(value: unknown): WorkflowMetadataV3['governance'] {
  assertRecord(value, 'workflow metadata governance');
  assertKnownKeys(
    value,
    [
      'requirementsStatus',
      'requirementsDigest',
      'planVersion',
      'planDecision',
      'policyVersions',
      'reviewStatus',
      'reviewLedgerDigest',
      'verificationStatus',
      'verificationLedgerDigest',
    ],
    'workflow metadata governance',
  );
  if (
    typeof value.requirementsStatus !== 'string' ||
    !REQUIREMENTS_STATUSES.has(value.requirementsStatus as RequirementsStatus)
  ) {
    throw new Error(
      'workflow metadata governance requirementsStatus is invalid',
    );
  }
  if (
    typeof value.reviewStatus !== 'string' ||
    !REVIEW_STATUSES.has(value.reviewStatus as ReviewStatus)
  ) {
    throw new Error('workflow metadata governance reviewStatus is invalid');
  }
  if (
    typeof value.verificationStatus !== 'string' ||
    !VERIFICATION_STATUSES.has(value.verificationStatus as VerificationStatus)
  ) {
    throw new Error(
      'workflow metadata governance verificationStatus is invalid',
    );
  }
  return {
    requirementsStatus: value.requirementsStatus as RequirementsStatus,
    requirementsDigest: parseDigest(
      value.requirementsDigest,
      'workflow metadata governance requirementsDigest',
    ),
    planVersion: parsePositiveInteger(
      value.planVersion,
      'workflow metadata governance planVersion',
    ),
    planDecision: parsePlanDecision(value.planDecision),
    policyVersions: parsePolicyVersions(value.policyVersions),
    reviewStatus: value.reviewStatus as ReviewStatus,
    reviewLedgerDigest: parseDigest(
      value.reviewLedgerDigest,
      'workflow metadata governance reviewLedgerDigest',
    ),
    verificationStatus: value.verificationStatus as VerificationStatus,
    verificationLedgerDigest: parseDigest(
      value.verificationLedgerDigest,
      'workflow metadata governance verificationLedgerDigest',
    ),
  };
}

function parsePolicyVersions(
  value: unknown,
): WorkflowMetadataV3['governance']['policyVersions'] {
  assertRecord(value, 'workflow metadata policyVersions');
  assertKnownKeys(
    value,
    ['planning', 'review', 'verification'],
    'workflow metadata policyVersions',
  );
  return {
    planning: parsePolicyVersionOrNull(value.planning, 'planning'),
    review: parsePolicyVersionOrNull(value.review, 'review'),
    verification: parsePolicyVersionOrNull(value.verification, 'verification'),
  };
}

function parsePolicyVersionOrNull(
  value: unknown,
  component: WorkflowPolicyComponent,
): number | null {
  if (value === null) return null;
  const supported = SUPPORTED_WORKFLOW_POLICY_VERSIONS[component];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    !supported.some((version) => version === value)
  ) {
    throw new WorkflowPolicyVersionUnsupportedError(
      component,
      value,
      supported,
      component === 'planning' && value === 2 ? '0.4.0' : '>0.4.0',
    );
  }
  return value;
}

function parsePlanDecision(value: unknown): PlanDecision {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !PLAN_DECISIONS.has(value as Exclude<PlanDecision, null>)
  ) {
    throw new Error('workflow metadata governance planDecision is invalid');
  }
  return value as Exclude<PlanDecision, null>;
}

function parseSoloExecution(
  value: unknown,
): WorkflowMetadataV3['soloExecution'] {
  if (value === null) return null;
  assertRecord(value, 'workflow metadata soloExecution');
  assertKnownKeys(
    value,
    ['state', 'planVersion', 'assignedSessionId', 'startedAt', 'completedAt'],
    'workflow metadata soloExecution',
  );
  if (value.state !== 'active' && value.state !== 'completed') {
    throw new Error('workflow metadata soloExecution state is invalid');
  }
  const soloExecution: NonNullable<WorkflowMetadataV3['soloExecution']> = {
    state: value.state,
    planVersion: parsePositiveInteger(
      value.planVersion,
      'workflow metadata soloExecution planVersion',
    ),
    assignedSessionId: parseUlidOrNull(
      value.assignedSessionId,
      'workflow metadata soloExecution assignedSessionId',
    ),
    startedAt: parseTimestampOrNull(
      value.startedAt,
      'workflow metadata soloExecution startedAt',
    ),
    completedAt: parseTimestampOrNull(
      value.completedAt,
      'workflow metadata soloExecution completedAt',
    ),
  };
  if (soloExecution.state === 'active' && soloExecution.completedAt !== null) {
    throw new Error('active soloExecution cannot have completedAt');
  }
  if (
    soloExecution.state === 'completed' &&
    soloExecution.completedAt === null
  ) {
    throw new Error('completed soloExecution requires completedAt');
  }
  return soloExecution;
}

function parseLegacyCompatibility(
  value: unknown,
): WorkflowMetadataV3['legacyCompatibility'] {
  if (value === null) return null;
  assertRecord(value, 'workflow metadata legacyCompatibility');
  assertKnownKeys(
    value,
    ['legacyTaskId', 'sourceMetadataDigest', 'fieldMapVersion'],
    'workflow metadata legacyCompatibility',
  );
  return {
    legacyTaskId: parseNonEmptyString(
      value.legacyTaskId,
      'workflow metadata legacyCompatibility legacyTaskId',
    ),
    sourceMetadataDigest: parseDigest(
      value.sourceMetadataDigest,
      'workflow metadata legacyCompatibility sourceMetadataDigest',
    ),
    fieldMapVersion: parsePositiveInteger(
      value.fieldMapVersion,
      'workflow metadata legacyCompatibility fieldMapVersion',
    ),
  };
}

function assertWorkflowMetadataShape(metadata: WorkflowMetadataV3): void {
  if (metadata.workflowMode === 'man') {
    if (metadata.coordination !== 'single' || metadata.parent !== null) {
      throw new Error(
        'man metadata requires single coordination and no parent',
      );
    }
  } else if (metadata.workflowMode === 'manteam') {
    if (
      metadata.visibility !== 'shared' ||
      metadata.coordination !== 'team' ||
      metadata.parent !== null
    ) {
      throw new Error(
        'manteam metadata requires shared team coordination and no parent',
      );
    }
  } else if (metadata.visibility === 'local') {
    if (metadata.coordination !== 'single') {
      throw new Error('local manba metadata requires single coordination');
    }
  } else if (metadata.parent === null) {
    throw new Error('shared manba metadata requires a parent snapshot');
  }
  if (metadata.parent !== null) {
    if (
      metadata.parent.taskRef.namespace !== metadata.visibility ||
      metadata.parent.visibility !== metadata.visibility ||
      metadata.parent.coordination !== metadata.coordination
    ) {
      throw new Error(
        'workflow metadata parent snapshot must remain in the child namespace and coordination domain',
      );
    }
  }
  if (metadata.latestCheckpointRef !== null) {
    assertReferenceNamespace(metadata.visibility, metadata.latestCheckpointRef);
    if (
      metadata.latestCheckpointRef.kind !== 'checkpoint' ||
      !sameTaskRef(metadata.latestCheckpointRef.taskRef, metadata.taskRef)
    ) {
      throw new Error(
        'workflow metadata latestCheckpointRef must be a checkpoint for the same task',
      );
    }
  }
  if ((metadata.status === 'blocked') !== (metadata.blockingReason !== null)) {
    throw new Error(
      'workflow metadata blockingReason is only valid for blocked workflows',
    );
  }
  if (metadata.workflowMode !== 'manba' && metadata.outcome !== null) {
    throw new Error('only manba metadata may carry an outcome');
  }
  if (
    metadata.workflowMode === 'manba' &&
    metadata.status !== 'completed' &&
    metadata.outcome !== null
  ) {
    throw new Error('manba outcomes are only valid for completed workflows');
  }
  if (
    metadata.workflowMode === 'manba' &&
    metadata.status === 'completed' &&
    metadata.outcome === null
  ) {
    throw new Error('completed manba metadata requires an outcome');
  }
  if (metadata.status === 'superseded' && metadata.successorTaskRef === null) {
    throw new Error('superseded workflow metadata requires successorTaskRef');
  }
  if (metadata.status !== 'superseded' && metadata.successorTaskRef !== null) {
    throw new Error(
      'only superseded workflow metadata may carry successorTaskRef',
    );
  }
  if (metadata.successorTaskRef !== null) {
    if (
      metadata.taskRef.namespace !== 'local' ||
      metadata.successorTaskRef.namespace !== 'shared' ||
      sameTaskRef(metadata.taskRef, metadata.successorTaskRef)
    ) {
      throw new Error(
        'workflow metadata successor must promote a local task to a distinct shared TaskRef',
      );
    }
  }
  if (
    metadata.transitionState !== 'stable' &&
    metadata.lastOperationId === null
  ) {
    throw new Error('pending workflow metadata requires lastOperationId');
  }
  if (
    metadata.soloExecution !== null &&
    (metadata.workflowMode !== 'man' ||
      metadata.coordination !== 'single' ||
      metadata.governance.planDecision !== 'solo_handoff')
  ) {
    throw new Error('soloExecution requires man + single + solo_handoff');
  }
  if (metadata.legacyCompatibility === null) {
    if (
      metadata.ownerActorId === null ||
      metadata.createdBy.source !== 'actor'
    ) {
      throw new Error(
        'native workflow metadata requires an owner and actor-createdBy',
      );
    }
  } else if (
    !isTerminalStatus(metadata.status) &&
    metadata.ownerActorId === null
  ) {
    throw new Error(
      'active migrated workflow metadata requires an assigned owner',
    );
  }
}

function isTerminalStatus(status: WorkflowStatus): boolean {
  return (
    status === 'completed' || status === 'abandoned' || status === 'superseded'
  );
}

function parseStringSet(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length)
    throw new Error(`${label} must not contain duplicates`);
  return normalized;
}

/**
 * `skippedSteps` is an ordered audit trail, unlike scope and participant
 * collections. Migration must retain both the legacy spelling and sequence.
 */
function parseUniqueStringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return [...value];
}

function parseUlidSet(value: unknown, label: string): Ulid[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = parseStringSet(value, label);
  for (const item of normalized) assertUlid(item, label);
  return normalized as Ulid[];
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
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

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, label);
  return value;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function parseNonEmptyStringOrNull(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : parseNonEmptyString(value, label);
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseTimestampOrNull(value: unknown, label: string): string | null {
  return value === null ? null : parseTimestamp(value, label);
}

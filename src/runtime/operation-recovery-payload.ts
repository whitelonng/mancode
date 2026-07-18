import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { parseSchemaManifest } from '../context/manifest.js';
import {
  type RequirementsLedgerV1,
  parseRequirementsLedger,
} from '../context/requirements-ledger.js';
import {
  type ReviewLedgerV1,
  parseReviewLedger,
} from '../context/review-ledger.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import { sameTaskRef } from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  type VerificationLedgerV1,
  parseVerificationLedger,
} from '../context/verification-ledger.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
} from '../context/workflow-metadata.js';
import {
  type V3AdapterFileTarget,
  V3_ADAPTER_FILE_TARGETS,
} from '../installers/v3-adapter.js';
import {
  type CheckpointV1,
  checkpointDigest,
  parseCheckpoint,
} from '../team/checkpoints.js';
import { type ClaimV1, parseClaim } from '../team/claims.js';
import { type HandoffV1, parseHandoff } from '../team/handoff.js';
import { parseProjectConfig, parseTeamPolicy } from '../team/policy.js';
import { getOperationDefinition } from './operation-definition.js';
import type { OperationJournalV1, OperationType } from './operation-journal.js';
import { type TaskHeadFenceV1, parseTaskHeadFence } from './task-head-fence.js';

export const TASK_AUTHORITY_FILE_NAMES = [
  'metadata.json',
  'requirements.json',
  'review-ledger.json',
  'verification-ledger.json',
  'plan.md',
] as const;

export type TaskAuthorityFileName = (typeof TASK_AUTHORITY_FILE_NAMES)[number];

export interface TaskAuthorityFileRecoveryAction {
  kind: 'task_authority_file';
  stepId: string;
  taskRef: TaskRef;
  fileName: TaskAuthorityFileName;
  beforeDigest: string | null;
  targetContent: string;
}

export interface WorkflowTaskDirectoryRecoveryAction {
  kind: 'workflow_task_directory';
  stepId: string;
  taskRef: TaskRef;
  /** Authority files published atomically as the new task directory. */
  files: Array<{
    fileName: TaskAuthorityFileName;
    content: string;
  }>;
  beforeDigest: null;
}

/**
 * Migration promotes an already-audited candidate, including the report
 * artifacts referenced by its ledgers.  Keeping this distinct from ordinary
 * workflow creation prevents a generic create operation from acquiring an
 * arbitrary artifact-writing surface.
 */
export interface MigrationTaskDirectoryRecoveryAction {
  kind: 'migration_task_directory';
  stepId: string;
  taskRef: TaskRef;
  files: Array<{
    fileName: TaskAuthorityFileName;
    content: string;
  }>;
  reports: Array<{
    kind: 'review_report' | 'evidence_summary';
    artifactId: Ulid;
    content: string;
  }>;
  beforeDigest: null;
}

/** Fixed V3 project files; recovery never accepts a caller-supplied path. */
export const PROJECT_AUTHORITY_FILE_NAMES = [
  'schema.json',
  'shared/config.json',
  'shared/team/policy.json',
] as const;

export type ProjectAuthorityFileName =
  (typeof PROJECT_AUTHORITY_FILE_NAMES)[number];

export interface ProjectAuthorityFileRecoveryAction {
  kind: 'project_authority_file';
  stepId: string;
  fileName: ProjectAuthorityFileName;
  beforeDigest: string | null;
  beforeContent: string | null;
  targetContent: string;
}

/** A stage is local migration bookkeeping, but its terminal state is durable. */
export interface MigrationStageFileRecoveryAction {
  kind: 'migration_stage_file';
  stepId: string;
  stageId: Ulid;
  beforeDigest: string | null;
  beforeContent: string | null;
  targetContent: string;
}

/** Exact physical replacement for one journaled V3 adapter target. */
export interface V3AdapterFileRecoveryAction {
  kind: 'v3_adapter_file';
  stepId: string;
  target: V3AdapterFileTarget;
  beforeDigest: string | null;
  /** Retained only in the local recovery sidecar for constrained rollback. */
  beforeContent: string | null;
  targetContent: string;
}

export interface CheckpointRecoveryAction {
  kind: 'checkpoint';
  stepId: string;
  checkpoint: CheckpointV1;
  beforeDigest: string | null;
}

export interface TaskHeadFenceRecoveryAction {
  kind: 'task_head_fence';
  stepId: string;
  fence: TaskHeadFenceV1;
  beforeDigest: string | null;
}

export interface ClaimRecoveryAction {
  kind: 'claim';
  stepId: string;
  claim: ClaimV1;
  beforeDigest: string | null;
}

export interface HandoffRecoveryAction {
  kind: 'handoff';
  stepId: string;
  handoff: HandoffV1;
  beforeDigest: string | null;
}

export type OperationRecoveryActionV1 =
  | TaskAuthorityFileRecoveryAction
  | WorkflowTaskDirectoryRecoveryAction
  | MigrationTaskDirectoryRecoveryAction
  | ProjectAuthorityFileRecoveryAction
  | MigrationStageFileRecoveryAction
  | V3AdapterFileRecoveryAction
  | CheckpointRecoveryAction
  | TaskHeadFenceRecoveryAction
  | ClaimRecoveryAction
  | HandoffRecoveryAction;

/**
 * Exact, immutable targets for a durable operation. The journal binds this
 * payload's digest before its first business write, so recovery never needs
 * to recreate a plan, ledger, claim, or handoff from mutable current state.
 */
export interface OperationRecoveryPayloadV1 {
  schemaVersion: 1;
  operationId: Ulid;
  type: OperationType;
  primaryStoreId: string;
  actions: OperationRecoveryActionV1[];
  /** Business-write steps intentionally skipped by a namespace-specific path. */
  noOpStepIds: string[];
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STEP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function parseOperationRecoveryPayload(
  value: unknown,
): OperationRecoveryPayloadV1 {
  assertRecord(value, 'operation recovery payload');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'type',
      'primaryStoreId',
      'actions',
      'noOpStepIds',
    ],
    'operation recovery payload',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('operation recovery payload schemaVersion must be 1');
  }
  assertUlid(value.operationId, 'operation recovery payload operationId');
  if (typeof value.type !== 'string' || !value.type.trim()) {
    throw new Error('operation recovery payload type is required');
  }
  if (
    typeof value.primaryStoreId !== 'string' ||
    !/^[a-z][a-z0-9_-]*:[^\0]+$/.test(value.primaryStoreId)
  ) {
    throw new Error('operation recovery payload primaryStoreId is invalid');
  }
  const actions = parseActions(value.actions);
  const noOpStepIds = parseStepIds(value.noOpStepIds, 'noOpStepIds');
  const actionSteps = new Set(actions.map((action) => action.stepId));
  if (noOpStepIds.some((stepId) => actionSteps.has(stepId))) {
    throw new Error(
      'operation recovery payload cannot both write and skip the same step',
    );
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    type: value.type as OperationType,
    primaryStoreId: value.primaryStoreId,
    actions,
    noOpStepIds,
  };
}

export function operationRecoveryPayloadDigest(
  payload: OperationRecoveryPayloadV1,
): string {
  return digestCanonicalJson(parseOperationRecoveryPayload(payload));
}

/**
 * Rejects a prepared journal whose recovery sidecar cannot account for every
 * business write in its machine-readable operation definition. This runs
 * before the journal becomes durable as well as again during recovery, so a
 * new command cannot accidentally create an unrecoverable crash boundary.
 */
export function assertOperationRecoveryPayloadCoversJournal(
  journal: Pick<
    OperationJournalV1,
    'type' | 'entityLocks' | 'secondaryReservations'
  >,
  payload: OperationRecoveryPayloadV1,
): void {
  if (payload.type !== journal.type) {
    throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_TYPE_MISMATCH');
  }
  const definition = getOperationDefinition(journal.type);
  const stepIndexes = new Map(
    definition.steps.map((step, index) => [step.id, index]),
  );
  let priorIndex = -1;
  const actionSteps = new Set<string>();
  for (const action of payload.actions) {
    const index = stepIndexes.get(action.stepId);
    if (index === undefined || index < priorIndex) {
      throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_STEP_INVALID');
    }
    priorIndex = index;
    actionSteps.add(action.stepId);
    assertActionLockCoverage(journal, action);
  }
  for (const stepId of payload.noOpStepIds) {
    const step = definition.steps[stepIndexes.get(stepId) ?? -1];
    if (step?.visibility !== 'business_write') {
      throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_NOOP_INVALID');
    }
  }
  for (const step of definition.steps) {
    if (
      step.visibility === 'business_write' &&
      !actionSteps.has(step.id) &&
      !payload.noOpStepIds.includes(step.id)
    ) {
      throw new Error('MANCODE_OPERATION_RECOVERY_PAYLOAD_INCOMPLETE');
    }
  }
  assertMigrationSharedTaskHeadCoverage(journal, payload);
}

function assertMigrationSharedTaskHeadCoverage(
  journal: Pick<
    OperationJournalV1,
    'type' | 'entityLocks' | 'secondaryReservations'
  >,
  payload: OperationRecoveryPayloadV1,
): void {
  if (journal.type !== 'v3_activate') return;
  const sharedTasks = payload.actions
    .filter(
      (
        action,
      ): action is Extract<
        OperationRecoveryActionV1,
        { kind: 'migration_task_directory' }
      > =>
        action.kind === 'migration_task_directory' &&
        action.taskRef.namespace === 'shared',
    )
    .map((action) => action.taskRef.taskId);
  const fenced = new Set(
    payload.actions
      .filter(
        (
          action,
        ): action is Extract<
          OperationRecoveryActionV1,
          { kind: 'task_head_fence' }
        > => action.kind === 'task_head_fence',
      )
      .map((action) => action.fence.taskRef.taskId),
  );
  if (
    sharedTasks.some(
      (taskId) =>
        !fenced.has(taskId) ||
        !journal.entityLocks.includes(`task_head:${taskId}`),
    )
  ) {
    throw new Error('MANCODE_OPERATION_RECOVERY_SHARED_HEAD_MISSING');
  }
}

export function createTaskAuthorityFileRecoveryAction(input: {
  stepId: string;
  taskRef: TaskRef;
  fileName: TaskAuthorityFileName;
  beforeContent: string | null;
  targetContent: string;
}): TaskAuthorityFileRecoveryAction {
  const action = {
    kind: 'task_authority_file' as const,
    stepId: input.stepId,
    taskRef: parseTaskRefValue(input.taskRef),
    fileName: input.fileName,
    beforeDigest:
      input.beforeContent === null
        ? null
        : taskAuthorityContentDigest(input.fileName, input.beforeContent),
    targetContent: input.targetContent,
  };
  return parseTaskAuthorityFileAction(action);
}

export function createWorkflowTaskDirectoryRecoveryAction(input: {
  stepId: string;
  taskRef: TaskRef;
  files: Array<{
    fileName: TaskAuthorityFileName;
    content: string;
  }>;
}): WorkflowTaskDirectoryRecoveryAction {
  return parseWorkflowTaskDirectoryAction({
    kind: 'workflow_task_directory',
    stepId: input.stepId,
    taskRef: input.taskRef,
    files: input.files,
    beforeDigest: null,
  });
}

export function createMigrationTaskDirectoryRecoveryAction(input: {
  stepId: string;
  taskRef: TaskRef;
  files: Array<{
    fileName: TaskAuthorityFileName;
    content: string;
  }>;
  reports?: Array<{
    kind: 'review_report' | 'evidence_summary';
    artifactId: Ulid;
    content: string;
  }>;
}): MigrationTaskDirectoryRecoveryAction {
  return parseMigrationTaskDirectoryAction({
    kind: 'migration_task_directory',
    stepId: input.stepId,
    taskRef: input.taskRef,
    files: input.files,
    reports: input.reports ?? [],
    beforeDigest: null,
  });
}

export function createProjectAuthorityFileRecoveryAction(input: {
  stepId: string;
  fileName: ProjectAuthorityFileName;
  beforeContent: string | null;
  targetContent: string;
}): ProjectAuthorityFileRecoveryAction {
  return parseProjectAuthorityFileAction({
    kind: 'project_authority_file',
    stepId: input.stepId,
    fileName: input.fileName,
    beforeDigest:
      input.beforeContent === null
        ? null
        : projectAuthorityContentDigest(input.fileName, input.beforeContent),
    beforeContent: input.beforeContent,
    targetContent: input.targetContent,
  });
}

export function createMigrationStageFileRecoveryAction(input: {
  stepId: string;
  stageId: Ulid;
  beforeContent: string | null;
  targetContent: string;
}): MigrationStageFileRecoveryAction {
  return parseMigrationStageFileAction({
    kind: 'migration_stage_file',
    stepId: input.stepId,
    stageId: input.stageId,
    beforeDigest:
      input.beforeContent === null
        ? null
        : migrationStageContentDigest(input.beforeContent),
    beforeContent: input.beforeContent,
    targetContent: input.targetContent,
  });
}

export function createV3AdapterFileRecoveryAction(input: {
  stepId: string;
  target: V3AdapterFileTarget;
  beforeContent: string | null;
  targetContent: string;
}): V3AdapterFileRecoveryAction {
  return parseV3AdapterFileAction({
    kind: 'v3_adapter_file',
    stepId: input.stepId,
    target: input.target,
    beforeDigest: adapterFileContentDigest(input.target, input.beforeContent),
    beforeContent: input.beforeContent,
    targetContent: input.targetContent,
  });
}

export function createCheckpointRecoveryAction(input: {
  stepId: string;
  before: CheckpointV1 | null;
  checkpoint: CheckpointV1;
}): CheckpointRecoveryAction {
  return parseCheckpointAction({
    kind: 'checkpoint',
    stepId: input.stepId,
    checkpoint: input.checkpoint,
    beforeDigest: input.before === null ? null : checkpointDigest(input.before),
  });
}

export function createTaskHeadFenceRecoveryAction(input: {
  stepId: string;
  before: TaskHeadFenceV1 | null;
  fence: TaskHeadFenceV1;
}): TaskHeadFenceRecoveryAction {
  return parseTaskHeadFenceAction({
    kind: 'task_head_fence',
    stepId: input.stepId,
    fence: input.fence,
    beforeDigest:
      input.before === null ? null : digestCanonicalJson(input.before),
  });
}

export function createClaimRecoveryAction(input: {
  stepId: string;
  before: ClaimV1 | null;
  claim: ClaimV1;
}): ClaimRecoveryAction {
  return parseClaimAction({
    kind: 'claim',
    stepId: input.stepId,
    claim: input.claim,
    beforeDigest:
      input.before === null ? null : digestCanonicalJson(input.before),
  });
}

export function createHandoffRecoveryAction(input: {
  stepId: string;
  before: HandoffV1 | null;
  handoff: HandoffV1;
}): HandoffRecoveryAction {
  return parseHandoffAction({
    kind: 'handoff',
    stepId: input.stepId,
    handoff: input.handoff,
    beforeDigest:
      input.before === null ? null : digestCanonicalJson(input.before),
  });
}

function assertActionLockCoverage(
  journal: Pick<OperationJournalV1, 'entityLocks' | 'secondaryReservations'>,
  action: OperationRecoveryActionV1,
): void {
  const hasLock = (key: string) =>
    journal.entityLocks.includes(key) ||
    journal.secondaryReservations.some((reservation) =>
      reservation.entityKeys.includes(key),
    );
  switch (action.kind) {
    case 'task_authority_file':
    case 'workflow_task_directory':
    case 'migration_task_directory':
      if (!hasLock(taskKey(action.taskRef))) {
        throw new Error('MANCODE_OPERATION_RECOVERY_LOCK_MISSING');
      }
      return;
    case 'project_authority_file':
      if (
        !hasLock(
          action.fileName === 'schema.json'
            ? 'schema:project'
            : action.fileName === 'shared/config.json'
              ? 'config:project'
              : 'policy:project',
        )
      ) {
        throw new Error('MANCODE_OPERATION_RECOVERY_LOCK_MISSING');
      }
      return;
    case 'migration_stage_file':
      if (!hasLock(`stage:${action.stageId}`)) {
        throw new Error('MANCODE_OPERATION_RECOVERY_LOCK_MISSING');
      }
      return;
    case 'v3_adapter_file':
      if (!hasLock(`adapter:${action.target}`)) {
        throw new Error('MANCODE_OPERATION_RECOVERY_LOCK_MISSING');
      }
      return;
    case 'checkpoint':
      if (
        !hasLock(taskKey(action.checkpoint.taskRef)) ||
        !hasLock(`checkpoint:${action.checkpoint.checkpointId}`)
      ) {
        throw new Error('MANCODE_OPERATION_RECOVERY_LOCK_MISSING');
      }
      return;
    case 'task_head_fence':
      if (!hasLock(`task_head:${action.fence.taskRef.taskId}`)) {
        throw new Error('MANCODE_OPERATION_RECOVERY_LOCK_MISSING');
      }
      return;
    case 'claim':
      if (!hasLock(`claim:${action.claim.claimId}`)) {
        throw new Error('MANCODE_OPERATION_RECOVERY_LOCK_MISSING');
      }
      return;
    case 'handoff':
      if (!hasLock(`handoff:${action.handoff.handoffId}`)) {
        throw new Error('MANCODE_OPERATION_RECOVERY_LOCK_MISSING');
      }
      return;
  }
}

function taskKey(taskRef: TaskRef): string {
  return `task:${taskRef.namespace}:${taskRef.taskId}`;
}

export function taskAuthorityContentDigest(
  fileName: TaskAuthorityFileName,
  content: string,
): string {
  return digestCanonicalJson(parseTaskAuthorityContent(fileName, content));
}

export function projectAuthorityContentDigest(
  fileName: ProjectAuthorityFileName,
  content: string,
): string {
  if (typeof content !== 'string' || content.includes('\0')) {
    throw new Error('operation recovery project authority content is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('operation recovery project authority JSON is invalid');
  }
  switch (fileName) {
    case 'schema.json':
      return digestCanonicalJson(parseSchemaManifest(parsed));
    case 'shared/config.json':
      return digestCanonicalJson(parseProjectConfig(parsed));
    case 'shared/team/policy.json':
      return digestCanonicalJson(parseTeamPolicy(parsed));
  }
}

function projectAuthorityContentDigestOrNull(
  fileName: ProjectAuthorityFileName,
  content: string | null,
): string | null {
  return content === null
    ? null
    : projectAuthorityContentDigest(fileName, content);
}

/** Stage content is parsed again by the migration reader before use. */
export function migrationStageContentDigest(content: string): string {
  if (typeof content !== 'string' || content.includes('\0')) {
    throw new Error('operation recovery migration stage content is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('operation recovery migration stage JSON is invalid');
  }
  assertRecord(parsed, 'operation recovery migration stage');
  return digestCanonicalJson(parsed);
}

function migrationStageContentDigestOrNull(
  content: string | null,
): string | null {
  return content === null ? null : migrationStageContentDigest(content);
}

export function adapterFileContentDigest(
  target: V3AdapterFileTarget,
  content: string | null,
): string | null {
  if (!V3_ADAPTER_TARGETS.has(target)) {
    throw new Error('operation recovery adapter target is invalid');
  }
  if (
    content !== null &&
    (typeof content !== 'string' || content.includes('\0'))
  ) {
    throw new Error('operation recovery adapter content is invalid');
  }
  return content === null ? null : digestCanonicalJson({ target, content });
}

export function parseTaskAuthorityContent(
  fileName: TaskAuthorityFileName,
  content: string,
):
  | WorkflowMetadataV3
  | RequirementsLedgerV1
  | ReviewLedgerV1
  | VerificationLedgerV1
  | { content: string } {
  if (typeof content !== 'string' || content.includes('\0')) {
    throw new Error('operation recovery task authority content is invalid');
  }
  if (fileName === 'plan.md') {
    if (!content.trim()) {
      throw new Error('operation recovery plan content is required');
    }
    return { content };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('operation recovery task authority JSON is invalid');
  }
  switch (fileName) {
    case 'metadata.json':
      return parseWorkflowMetadata(parsed);
    case 'requirements.json':
      return parseRequirementsLedger(parsed);
    case 'review-ledger.json':
      return parseReviewLedger(parsed);
    case 'verification-ledger.json':
      return parseVerificationLedger(parsed);
  }
}

export function recoveryActionResourceKey(
  action: OperationRecoveryActionV1,
): string {
  switch (action.kind) {
    case 'task_authority_file':
      return `task-file:${action.taskRef.namespace}:${action.taskRef.taskId}:${action.fileName}`;
    case 'workflow_task_directory':
      return `workflow-directory:${action.taskRef.namespace}:${action.taskRef.taskId}`;
    case 'migration_task_directory':
      return `migration-workflow-directory:${action.taskRef.namespace}:${action.taskRef.taskId}`;
    case 'project_authority_file':
      return `project-file:${action.fileName}`;
    case 'migration_stage_file':
      return `migration-stage:${action.stageId}`;
    case 'v3_adapter_file':
      return `v3-adapter:${action.target}`;
    case 'checkpoint':
      return `checkpoint:${action.checkpoint.taskRef.namespace}:${action.checkpoint.taskRef.taskId}:${action.checkpoint.checkpointId}`;
    case 'task_head_fence':
      return `task-head:${action.fence.taskRef.taskId}`;
    case 'claim':
      return `claim:${action.claim.claimId}`;
    case 'handoff':
      return `handoff:${action.handoff.handoffId}`;
  }
}

export function recoveryActionTargetDigest(
  action: OperationRecoveryActionV1,
): string {
  switch (action.kind) {
    case 'task_authority_file':
      return taskAuthorityContentDigest(action.fileName, action.targetContent);
    case 'workflow_task_directory':
      return workflowTaskDirectoryDigest(action);
    case 'migration_task_directory':
      return migrationTaskDirectoryDigest(action);
    case 'project_authority_file':
      return projectAuthorityContentDigest(
        action.fileName,
        action.targetContent,
      );
    case 'migration_stage_file':
      return migrationStageContentDigest(action.targetContent);
    case 'v3_adapter_file':
      return adapterFileContentDigest(
        action.target,
        action.targetContent,
      ) as string;
    case 'checkpoint':
      return checkpointDigest(action.checkpoint);
    case 'task_head_fence':
      return digestCanonicalJson(action.fence);
    case 'claim':
      return digestCanonicalJson(action.claim);
    case 'handoff':
      return digestCanonicalJson(action.handoff);
  }
}

function parseActions(value: unknown): OperationRecoveryActionV1[] {
  if (!Array.isArray(value)) {
    throw new Error('operation recovery payload actions must be an array');
  }
  return value.map((action) => {
    assertRecord(action, 'operation recovery action');
    switch (action.kind) {
      case 'task_authority_file':
        return parseTaskAuthorityFileAction(action);
      case 'workflow_task_directory':
        return parseWorkflowTaskDirectoryAction(action);
      case 'migration_task_directory':
        return parseMigrationTaskDirectoryAction(action);
      case 'project_authority_file':
        return parseProjectAuthorityFileAction(action);
      case 'migration_stage_file':
        return parseMigrationStageFileAction(action);
      case 'v3_adapter_file':
        return parseV3AdapterFileAction(action);
      case 'checkpoint':
        return parseCheckpointAction(action);
      case 'task_head_fence':
        return parseTaskHeadFenceAction(action);
      case 'claim':
        return parseClaimAction(action);
      case 'handoff':
        return parseHandoffAction(action);
      default:
        throw new Error('operation recovery action kind is invalid');
    }
  });
}

function parseWorkflowTaskDirectoryAction(
  value: Record<string, unknown>,
): WorkflowTaskDirectoryRecoveryAction {
  assertKnownKeys(
    value,
    ['kind', 'stepId', 'taskRef', 'files', 'beforeDigest'],
    'operation recovery workflow directory action',
  );
  if (value.kind !== 'workflow_task_directory' || value.beforeDigest !== null) {
    throw new Error('operation recovery workflow directory action is invalid');
  }
  if (
    !Array.isArray(value.files) ||
    (value.files.length !== 4 && value.files.length !== 5)
  ) {
    throw new Error('operation recovery workflow directory files are invalid');
  }
  const files = value.files.map((file) => {
    assertRecord(file, 'operation recovery workflow directory file');
    assertKnownKeys(
      file,
      ['fileName', 'content'],
      'operation recovery workflow directory file',
    );
    const fileName = parseTaskAuthorityFileName(file.fileName);
    const content = parseText(file.content, 'workflow directory file content');
    taskAuthorityContentDigest(fileName, content);
    return { fileName, content };
  });
  const required = new Set<TaskAuthorityFileName>([
    'metadata.json',
    'requirements.json',
    'review-ledger.json',
    'verification-ledger.json',
  ]);
  const allowed = new Set<TaskAuthorityFileName>([...required, 'plan.md']);
  if (
    new Set(files.map((file) => file.fileName)).size !== files.length ||
    files.some((file) => !allowed.has(file.fileName)) ||
    [...required].some(
      (fileName) => !files.some((file) => file.fileName === fileName),
    )
  ) {
    throw new Error('operation recovery workflow directory files are invalid');
  }
  return {
    kind: 'workflow_task_directory',
    stepId: parseStepId(value.stepId),
    taskRef: parseTaskRefValue(value.taskRef),
    files,
    beforeDigest: null,
  };
}

function parseMigrationTaskDirectoryAction(
  value: Record<string, unknown>,
): MigrationTaskDirectoryRecoveryAction {
  assertKnownKeys(
    value,
    ['kind', 'stepId', 'taskRef', 'files', 'reports', 'beforeDigest'],
    'operation recovery migration directory action',
  );
  if (
    value.kind !== 'migration_task_directory' ||
    value.beforeDigest !== null
  ) {
    throw new Error('operation recovery migration directory action is invalid');
  }
  const files = parseTaskDirectoryFiles(
    value.files,
    'operation recovery migration directory file',
  );
  if (!Array.isArray(value.reports)) {
    throw new Error(
      'operation recovery migration directory reports are invalid',
    );
  }
  const reports = value.reports.map<
    MigrationTaskDirectoryRecoveryAction['reports'][number]
  >((report) => {
    assertRecord(report, 'operation recovery migration directory report');
    assertKnownKeys(
      report,
      ['kind', 'artifactId', 'content'],
      'operation recovery migration directory report',
    );
    const kind = report.kind;
    if (kind !== 'review_report' && kind !== 'evidence_summary') {
      throw new Error(
        'operation recovery migration directory report is invalid',
      );
    }
    assertUlid(
      report.artifactId,
      'operation recovery migration report artifactId',
    );
    return {
      kind,
      artifactId: report.artifactId,
      content: parseText(report.content, 'migration directory report content'),
    };
  });
  if (
    new Set(reports.map((report) => `${report.kind}:${report.artifactId}`))
      .size !== reports.length
  ) {
    throw new Error(
      'operation recovery migration directory reports are invalid',
    );
  }
  const taskRef = parseTaskRefValue(value.taskRef);
  assertMigrationDirectoryTaskConsistency(taskRef, files, reports);
  return {
    kind: 'migration_task_directory',
    stepId: parseStepId(value.stepId),
    taskRef,
    files,
    reports,
    beforeDigest: null,
  };
}

function assertMigrationDirectoryTaskConsistency(
  taskRef: TaskRef,
  files: Array<{ fileName: TaskAuthorityFileName; content: string }>,
  reports: MigrationTaskDirectoryRecoveryAction['reports'],
): void {
  const byName = new Map(files.map((file) => [file.fileName, file.content]));
  const metadata = parseWorkflowMetadata(
    JSON.parse(byName.get('metadata.json') as string),
  );
  const requirements = parseRequirementsLedger(
    JSON.parse(byName.get('requirements.json') as string),
  );
  const review = parseReviewLedger(
    JSON.parse(byName.get('review-ledger.json') as string),
  );
  const verification = parseVerificationLedger(
    JSON.parse(byName.get('verification-ledger.json') as string),
  );
  if (
    !sameTaskRef(metadata.taskRef, taskRef) ||
    !sameTaskRef(requirements.taskRef, taskRef) ||
    !sameTaskRef(review.taskRef, taskRef) ||
    !sameTaskRef(verification.taskRef, taskRef)
  ) {
    throw new Error('operation recovery migration directory taskRef mismatch');
  }
  const expected = new Set<string>();
  for (const domain of review.domains) {
    if (domain.reportRef?.artifactId !== undefined) {
      expected.add(`review_report:${domain.reportRef.artifactId}`);
    }
  }
  for (const check of verification.checks) {
    for (const component of [check.automated, check.manual]) {
      if (component?.artifactRef?.artifactId !== undefined) {
        expected.add(`evidence_summary:${component.artifactRef.artifactId}`);
      }
    }
  }
  const actual = new Set(
    reports.map((report) => `${report.kind}:${report.artifactId}`),
  );
  if (
    actual.size !== expected.size ||
    [...actual].some((value) => !expected.has(value))
  ) {
    throw new Error(
      'operation recovery migration reports do not match ledgers',
    );
  }
}

function parseTaskDirectoryFiles(
  value: unknown,
  label: string,
): Array<{ fileName: TaskAuthorityFileName; content: string }> {
  if (!Array.isArray(value) || (value.length !== 4 && value.length !== 5)) {
    throw new Error('operation recovery workflow directory files are invalid');
  }
  const files = value.map((file) => {
    assertRecord(file, label);
    assertKnownKeys(file, ['fileName', 'content'], label);
    const fileName = parseTaskAuthorityFileName(file.fileName);
    const content = parseText(file.content, 'workflow directory file content');
    taskAuthorityContentDigest(fileName, content);
    return { fileName, content };
  });
  const required = new Set<TaskAuthorityFileName>([
    'metadata.json',
    'requirements.json',
    'review-ledger.json',
    'verification-ledger.json',
  ]);
  const allowed = new Set<TaskAuthorityFileName>([...required, 'plan.md']);
  if (
    new Set(files.map((file) => file.fileName)).size !== files.length ||
    files.some((file) => !allowed.has(file.fileName)) ||
    [...required].some(
      (fileName) => !files.some((file) => file.fileName === fileName),
    )
  ) {
    throw new Error('operation recovery workflow directory files are invalid');
  }
  return files;
}

function parseProjectAuthorityFileAction(
  value: Record<string, unknown>,
): ProjectAuthorityFileRecoveryAction {
  assertKnownKeys(
    value,
    [
      'kind',
      'stepId',
      'fileName',
      'beforeDigest',
      'beforeContent',
      'targetContent',
    ],
    'operation recovery project authority action',
  );
  if (value.kind !== 'project_authority_file') {
    throw new Error('operation recovery project authority action is invalid');
  }
  const fileName = parseProjectAuthorityFileName(value.fileName);
  const beforeContent =
    value.beforeContent === null
      ? null
      : parseText(value.beforeContent, 'project beforeContent');
  const beforeDigest = parseDigestOrNull(value.beforeDigest, 'beforeDigest');
  if (
    beforeDigest !==
    projectAuthorityContentDigestOrNull(fileName, beforeContent)
  ) {
    throw new Error(
      'operation recovery project authority before digest is invalid',
    );
  }
  const targetContent = parseText(value.targetContent, 'project targetContent');
  projectAuthorityContentDigest(fileName, targetContent);
  return {
    kind: 'project_authority_file',
    stepId: parseStepId(value.stepId),
    fileName,
    beforeDigest,
    beforeContent,
    targetContent,
  };
}

function parseMigrationStageFileAction(
  value: Record<string, unknown>,
): MigrationStageFileRecoveryAction {
  assertKnownKeys(
    value,
    [
      'kind',
      'stepId',
      'stageId',
      'beforeDigest',
      'beforeContent',
      'targetContent',
    ],
    'operation recovery migration stage action',
  );
  if (value.kind !== 'migration_stage_file') {
    throw new Error('operation recovery migration stage action is invalid');
  }
  assertUlid(value.stageId, 'operation recovery migration stageId');
  const beforeContent =
    value.beforeContent === null
      ? null
      : parseText(value.beforeContent, 'migration stage beforeContent');
  const beforeDigest = parseDigestOrNull(value.beforeDigest, 'beforeDigest');
  if (beforeDigest !== migrationStageContentDigestOrNull(beforeContent)) {
    throw new Error(
      'operation recovery migration stage before digest is invalid',
    );
  }
  const targetContent = parseText(
    value.targetContent,
    'migration stage targetContent',
  );
  migrationStageContentDigest(targetContent);
  const target = JSON.parse(targetContent) as Record<string, unknown>;
  if (target.stageId !== value.stageId) {
    throw new Error('operation recovery migration stage target ID mismatch');
  }
  return {
    kind: 'migration_stage_file',
    stepId: parseStepId(value.stepId),
    stageId: value.stageId,
    beforeDigest,
    beforeContent,
    targetContent,
  };
}

const V3_ADAPTER_TARGETS = new Set<V3AdapterFileTarget>(
  V3_ADAPTER_FILE_TARGETS,
);

function parseV3AdapterFileAction(
  value: Record<string, unknown>,
): V3AdapterFileRecoveryAction {
  assertKnownKeys(
    value,
    [
      'kind',
      'stepId',
      'target',
      'beforeDigest',
      'beforeContent',
      'targetContent',
    ],
    'operation recovery mancode adapter action',
  );
  if (
    value.kind !== 'v3_adapter_file' ||
    !V3_ADAPTER_TARGETS.has(value.target as V3AdapterFileTarget)
  ) {
    throw new Error('operation recovery mancode adapter action is invalid');
  }
  const target = value.target as V3AdapterFileTarget;
  const beforeContent =
    value.beforeContent === null
      ? null
      : parseText(value.beforeContent, 'mancode adapter beforeContent');
  const beforeDigest = parseDigestOrNull(value.beforeDigest, 'beforeDigest');
  if (beforeDigest !== adapterFileContentDigest(target, beforeContent)) {
    throw new Error(
      'operation recovery mancode adapter before digest is invalid',
    );
  }
  const targetContent = parseText(
    value.targetContent,
    'mancode adapter targetContent',
  );
  if (!targetContent.trim()) {
    throw new Error(
      'operation recovery mancode adapter target content is invalid',
    );
  }
  adapterFileContentDigest(target, targetContent);
  return {
    kind: 'v3_adapter_file',
    stepId: parseStepId(value.stepId),
    target,
    beforeDigest,
    beforeContent,
    targetContent,
  };
}

function parseTaskAuthorityFileAction(
  value: Record<string, unknown>,
): TaskAuthorityFileRecoveryAction {
  assertKnownKeys(
    value,
    ['kind', 'stepId', 'taskRef', 'fileName', 'beforeDigest', 'targetContent'],
    'operation recovery task authority action',
  );
  if (value.kind !== 'task_authority_file') {
    throw new Error('operation recovery task authority action kind is invalid');
  }
  const fileName = parseTaskAuthorityFileName(value.fileName);
  const targetContent = parseText(value.targetContent, 'targetContent');
  taskAuthorityContentDigest(fileName, targetContent);
  return {
    kind: 'task_authority_file',
    stepId: parseStepId(value.stepId),
    taskRef: parseTaskRefValue(value.taskRef),
    fileName,
    beforeDigest: parseDigestOrNull(value.beforeDigest, 'beforeDigest'),
    targetContent,
  };
}

function parseCheckpointAction(
  value: Record<string, unknown>,
): CheckpointRecoveryAction {
  assertKnownKeys(
    value,
    ['kind', 'stepId', 'checkpoint', 'beforeDigest'],
    'operation recovery checkpoint action',
  );
  if (value.kind !== 'checkpoint') {
    throw new Error('operation recovery checkpoint action kind is invalid');
  }
  return {
    kind: 'checkpoint',
    stepId: parseStepId(value.stepId),
    checkpoint: parseCheckpoint(value.checkpoint),
    beforeDigest: parseDigestOrNull(value.beforeDigest, 'beforeDigest'),
  };
}

function parseTaskHeadFenceAction(
  value: Record<string, unknown>,
): TaskHeadFenceRecoveryAction {
  assertKnownKeys(
    value,
    ['kind', 'stepId', 'fence', 'beforeDigest'],
    'operation recovery task-head action',
  );
  if (value.kind !== 'task_head_fence') {
    throw new Error('operation recovery task-head action kind is invalid');
  }
  return {
    kind: 'task_head_fence',
    stepId: parseStepId(value.stepId),
    fence: parseTaskHeadFence(value.fence),
    beforeDigest: parseDigestOrNull(value.beforeDigest, 'beforeDigest'),
  };
}

function parseClaimAction(value: Record<string, unknown>): ClaimRecoveryAction {
  assertKnownKeys(
    value,
    ['kind', 'stepId', 'claim', 'beforeDigest'],
    'operation recovery claim action',
  );
  if (value.kind !== 'claim') {
    throw new Error('operation recovery claim action kind is invalid');
  }
  return {
    kind: 'claim',
    stepId: parseStepId(value.stepId),
    claim: parseClaim(value.claim),
    beforeDigest: parseDigestOrNull(value.beforeDigest, 'beforeDigest'),
  };
}

function parseHandoffAction(
  value: Record<string, unknown>,
): HandoffRecoveryAction {
  assertKnownKeys(
    value,
    ['kind', 'stepId', 'handoff', 'beforeDigest'],
    'operation recovery handoff action',
  );
  if (value.kind !== 'handoff') {
    throw new Error('operation recovery handoff action kind is invalid');
  }
  return {
    kind: 'handoff',
    stepId: parseStepId(value.stepId),
    handoff: parseHandoff(value.handoff),
    beforeDigest: parseDigestOrNull(value.beforeDigest, 'beforeDigest'),
  };
}

function parseTaskAuthorityFileName(value: unknown): TaskAuthorityFileName {
  if (
    typeof value !== 'string' ||
    !TASK_AUTHORITY_FILE_NAMES.includes(value as TaskAuthorityFileName)
  ) {
    throw new Error('operation recovery task authority fileName is invalid');
  }
  return value as TaskAuthorityFileName;
}

function parseProjectAuthorityFileName(
  value: unknown,
): ProjectAuthorityFileName {
  if (
    typeof value !== 'string' ||
    !PROJECT_AUTHORITY_FILE_NAMES.includes(value as ProjectAuthorityFileName)
  ) {
    throw new Error('operation recovery project authority fileName is invalid');
  }
  return value as ProjectAuthorityFileName;
}

function parseStepIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`operation recovery payload ${label} must be an array`);
  }
  const ids = value.map((item) => parseStepId(item));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`operation recovery payload ${label} must not repeat`);
  }
  return ids;
}

function parseStepId(value: unknown): string {
  if (typeof value !== 'string' || !STEP_ID_PATTERN.test(value)) {
    throw new Error('operation recovery stepId is invalid');
  }
  return value;
}

function parseText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`operation recovery ${label} is invalid`);
  }
  return value;
}

function parseDigestOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`operation recovery ${label} is invalid`);
  }
  return value;
}

export function workflowTaskDirectoryDigest(
  action: WorkflowTaskDirectoryRecoveryAction,
): string {
  return digestCanonicalJson({
    taskRef: action.taskRef,
    files: [...action.files]
      .sort((left, right) =>
        Buffer.from(left.fileName, 'utf8').compare(
          Buffer.from(right.fileName, 'utf8'),
        ),
      )
      .map((file) => ({
        fileName: file.fileName,
        digest: taskAuthorityContentDigest(file.fileName, file.content),
      })),
  });
}

export function migrationTaskDirectoryDigest(
  action: MigrationTaskDirectoryRecoveryAction,
): string {
  return digestCanonicalJson({
    taskRef: action.taskRef,
    files: [...action.files]
      .sort((left, right) =>
        Buffer.from(left.fileName, 'utf8').compare(
          Buffer.from(right.fileName, 'utf8'),
        ),
      )
      .map((file) => ({
        fileName: file.fileName,
        digest: taskAuthorityContentDigest(file.fileName, file.content),
      })),
    reports: [...action.reports]
      .sort((left, right) =>
        Buffer.from(`${left.kind}:${left.artifactId}`, 'utf8').compare(
          Buffer.from(`${right.kind}:${right.artifactId}`, 'utf8'),
        ),
      )
      .map((report) => ({
        kind: report.kind,
        artifactId: report.artifactId,
        digest: digestCanonicalJson({ content: report.content }),
      })),
  });
}

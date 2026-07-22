import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  requirementsDigest as calculateRequirementsDigest,
  readRequirementsLedger,
  requirementsAreReady,
} from './requirements-ledger.js';
import { reviewCanComplete } from './review-ledger.js';
import { upsertActivePlan } from './team-memory.js';
import {
  type VerificationOverallStatus,
  verificationCanAdvance,
} from './verification-ledger.js';

/**
 * Workflow 元数据。
 *
 * 每个 /man、/manba 或 /manteam 任务在 .mancode/workflows/<taskId>/metadata.json 里
 * 存一份，记录任务进度（见 docs/workflows.md）。
 */
export interface WorkflowMeta {
  /** YYYYMMDD-HHMMSS-<slug> 格式 */
  taskId: string;
  /** 用户的原始任务描述 */
  task: string;
  /** 触发的工作流模式 */
  mode: WorkflowMode;
  /** 当前进行到第几步（mode-dependent）*/
  currentStep: number;
  /** Policy v2 only allows clarification or the whole review. */
  skippedSteps: string[];
  /** ISO timestamp */
  startedAt: string;
  /** ISO timestamp，每次更新都刷新 */
  updatedAt: string;
  /** Workflow lifecycle state */
  status: WorkflowStatus;
  /** Reason a blocked workflow cannot continue. */
  blockingReason?: string;
  /** Parent /man or /manteam workflow for a diagnostic child. */
  parentTaskId?: string;
  /** Final diagnostic result for /manba workflows. */
  outcome?: WorkflowOutcome;
  /** Monotonically increasing plan revision for /man workflows. */
  planVersion?: number;
  /** Enables the bounded review completion gate for newly created governed workflows. */
  reviewPolicyVersion?: 1 | 2;
  /** Enables requirements and plan gates for newly created governed workflows. */
  planningPolicyVersion?: 1 | 2;
  /** Enables acceptance-linked verification gates for governed execution. */
  verificationPolicyVersion?: 1;
  /** Whether clarification has resolved every implementation-blocking unknown. */
  requirementsStatus?: RequirementsStatus;
  /** Digest of the structured requirements accepted before planning. */
  requirementsDigest?: string;
  /** User choice made at the plan gate. */
  planDecision?: PlanDecision;
  /** Cached verification state for status display and guarded unblock transitions. */
  verificationStatus?: VerificationOverallStatus;
}

export type WorkflowStatus =
  | 'in_progress'
  | 'planned'
  | 'completed'
  | 'blocked'
  | 'abandoned';
export type WorkflowMode = 'man' | 'mamba' | 'manteam';
export type WorkflowOutcome =
  | 'fixed'
  | 'verified'
  | 'no_repro'
  | 'manual_test_required';
export type RequirementsStatus = 'ready' | 'needs_clarification';
export type PlanDecision = 'plan_only' | 'solo_handoff' | 'governed_execution';

export interface CreateWorkflowOptions {
  parentTaskId?: string;
  planningPolicyVersion?: 1 | 2;
}

export interface UpdateWorkflowOptions {
  /** Internal verification recording at Step 6/9 may be incomplete between checks. */
  allowIncompleteVerification?: boolean;
}

const METADATA_FILE = 'metadata.json';
const SLUG_MAX = 30;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function isValidWorkflowTaskId(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId);
}

/**
 * 生成 task id：YYYYMMDD-HHMMSS-<slug>。
 *
 * slug = task 的 kebab-case，截断到 SLUG_MAX 字符。
 *
 * @param task 任务描述
 * @param now 便于测试注入时间
 */
export function generateTaskId(task: string, now: Date = new Date()): string {
  const slug = slugify(task).slice(0, SLUG_MAX) || 'task';
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${ts}-${slug}`;
}

/**
 * 把任意文本转成 kebab-case slug（小写、连字符分隔、仅保留字母数字）。
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 创建新 workflow 目录 + 初始化 metadata.json。
 *
 * @param projectRoot 项目根
 * @param task 任务描述
 * @param mode Internal workflow value: man / mamba / manteam.
 */
export async function createWorkflow(
  projectRoot: string,
  task: string,
  mode: WorkflowMode,
  options: CreateWorkflowOptions = {},
): Promise<WorkflowMeta> {
  await validateParentTask(projectRoot, mode, options.parentTaskId, true);
  await mkdir(workflowsRoot(projectRoot), { recursive: true });
  const taskId = await allocateTaskId(projectRoot, generateTaskId(task));
  const dir = workflowDir(projectRoot, taskId);

  const now = new Date().toISOString();
  const meta: WorkflowMeta = {
    taskId,
    task,
    mode,
    currentStep: 1,
    skippedSteps: [],
    startedAt: now,
    updatedAt: now,
    status: 'in_progress',
    ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
    ...(mode === 'man' || mode === 'manteam'
      ? {
          planVersion: 1,
          reviewPolicyVersion: options.planningPolicyVersion === 2 ? 2 : 1,
          ...(options.planningPolicyVersion === 2
            ? { verificationPolicyVersion: 1 as const }
            : {}),
          ...(options.planningPolicyVersion
            ? { planningPolicyVersion: options.planningPolicyVersion }
            : {}),
        }
      : {}),
  };

  await writeMetadata(dir, meta);
  return meta;
}

async function allocateTaskId(
  projectRoot: string,
  baseTaskId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const taskId = attempt === 0 ? baseTaskId : `${baseTaskId}-${attempt + 1}`;
    try {
      await mkdir(workflowDir(projectRoot, taskId));
      return taskId;
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`unable to allocate workflow id for: ${baseTaskId}`);
}

/**
 * 读取某个 workflow 的 metadata。
 *
 * @returns 不存在返回 null
 */
export async function readWorkflow(
  projectRoot: string,
  taskId: string,
): Promise<WorkflowMeta | null> {
  if (!isValidWorkflowTaskId(taskId)) return null;
  const file = metadataPath(projectRoot, taskId);
  try {
    const raw = await readFile(file, 'utf-8');
    return parseWorkflowMeta(raw, taskId);
  } catch {
    return null;
  }
}

/**
 * 局部更新某个 workflow 的 metadata（合并 patch）。
 */
export async function updateWorkflow(
  projectRoot: string,
  taskId: string,
  patch: Partial<WorkflowMeta>,
  options: UpdateWorkflowOptions = {},
): Promise<void> {
  assertValidTaskId(taskId);
  const existing = await readWorkflow(projectRoot, taskId);
  if (!existing) {
    throw new Error(`workflow not found: ${taskId}`);
  }

  const updated: WorkflowMeta = {
    ...existing,
    ...patch,
    taskId,
    startedAt: existing.startedAt,
    updatedAt: new Date().toISOString(),
  };
  const explicitlyPatchedBlockingReason = Object.hasOwn(
    patch,
    'blockingReason',
  );
  if (updated.status !== 'blocked' && !explicitlyPatchedBlockingReason) {
    updated.blockingReason = undefined;
  }
  await validateWorkflowMeta(projectRoot, updated, existing, options);
  await writeMetadata(workflowDir(projectRoot, taskId), updated);

  // Propagate blocked / manual_test_required to parent workflow.
  if (updated.parentTaskId) {
    await propagateChildStatus(projectRoot, updated);
  }
}

/**
 * 列出所有 workflow，按 startedAt 倒序（最新在前）。
 */
export async function listWorkflows(
  projectRoot: string,
): Promise<WorkflowMeta[]> {
  const root = workflowsRoot(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const metas: WorkflowMeta[] = [];
  for (const entry of entries) {
    const meta = await readWorkflow(projectRoot, entry);
    if (meta) metas.push(meta);
  }

  metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return metas;
}

/**
 * 删除一个 workflow 目录。不抛错（不存在时静默）。
 */
export async function deleteWorkflow(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  if (!isValidWorkflowTaskId(taskId)) return false;
  const dir = workflowDir(projectRoot, taskId);
  try {
    await stat(dir);
  } catch {
    return false;
  }
  const existing = await readWorkflow(projectRoot, taskId);
  if (
    existing &&
    (existing.mode === 'man' || existing.mode === 'manteam') &&
    (await listMambaChildren(projectRoot, taskId)).length > 0
  ) {
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}

function workflowsRoot(projectRoot: string): string {
  return path.join(projectRoot, '.mancode', 'workflows');
}

function workflowDir(projectRoot: string, taskId: string): string {
  assertValidTaskId(taskId);
  return path.join(workflowsRoot(projectRoot), taskId);
}

function metadataPath(projectRoot: string, taskId: string): string {
  return path.join(workflowDir(projectRoot, taskId), METADATA_FILE);
}

async function writeMetadata(dir: string, meta: WorkflowMeta): Promise<void> {
  const content = `${JSON.stringify(meta, null, 2)}\n`;
  await writeFile(path.join(dir, METADATA_FILE), content, 'utf-8');
}

function parseWorkflowMeta(raw: string, taskId: string): WorkflowMeta | null {
  try {
    const obj = JSON.parse(raw) as Partial<WorkflowMeta>;
    if (
      typeof obj.task !== 'string' ||
      !isWorkflowMode(obj.mode) ||
      typeof obj.currentStep !== 'number' ||
      !Array.isArray(obj.skippedSteps) ||
      typeof obj.startedAt !== 'string' ||
      typeof obj.updatedAt !== 'string' ||
      !isWorkflowStatus(obj.status) ||
      !isWorkflowShape(obj)
    ) {
      return null;
    }
    return { ...(obj as WorkflowMeta), taskId };
  } catch {
    return null;
  }
}

export function maxWorkflowStep(mode: WorkflowMode): number {
  return mode === 'mamba' ? 5 : 9;
}

export function isWorkflowMode(value: unknown): value is WorkflowMode {
  return value === 'man' || value === 'mamba' || value === 'manteam';
}

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (
    value === 'in_progress' ||
    value === 'planned' ||
    value === 'completed' ||
    value === 'blocked' ||
    value === 'abandoned'
  );
}

export function isWorkflowOutcome(value: unknown): value is WorkflowOutcome {
  return (
    value === 'fixed' ||
    value === 'verified' ||
    value === 'no_repro' ||
    value === 'manual_test_required'
  );
}

export function isRequirementsStatus(
  value: unknown,
): value is RequirementsStatus {
  return value === 'ready' || value === 'needs_clarification';
}

export function isPlanDecision(value: unknown): value is PlanDecision {
  return (
    value === 'plan_only' ||
    value === 'solo_handoff' ||
    value === 'governed_execution'
  );
}

async function validateParentTask(
  projectRoot: string,
  mode: WorkflowMode,
  parentTaskId: string | undefined,
  requireStepSix = false,
): Promise<void> {
  if (!parentTaskId) return;
  if (mode !== 'mamba') {
    throw new Error('only manba workflows can have a parent task');
  }
  const parent = await readWorkflow(projectRoot, parentTaskId);
  if (!parent || (parent.mode !== 'man' && parent.mode !== 'manteam')) {
    throw new Error(`invalid parent workflow: ${parentTaskId}`);
  }
  if (
    (parent.status !== 'in_progress' && parent.status !== 'blocked') ||
    (requireStepSix &&
      (parent.status !== 'in_progress' || parent.currentStep !== 6))
  ) {
    throw new Error(
      `parent workflow must be in_progress at step 6: ${parentTaskId}`,
    );
  }
}

async function validateWorkflowMeta(
  projectRoot: string,
  updated: WorkflowMeta,
  existing: WorkflowMeta,
  options: UpdateWorkflowOptions,
): Promise<void> {
  if (updated.mode !== existing.mode) {
    throw new Error('workflow mode cannot be changed');
  }
  if (updated.task !== existing.task) {
    throw new Error('workflow task cannot be changed');
  }
  if (updated.parentTaskId !== existing.parentTaskId) {
    throw new Error('workflow parent task cannot be changed');
  }
  if (updated.reviewPolicyVersion !== existing.reviewPolicyVersion) {
    throw new Error('workflow review policy version cannot be changed');
  }
  if (updated.planningPolicyVersion !== existing.planningPolicyVersion) {
    throw new Error('workflow planning policy version cannot be changed');
  }
  if (
    updated.requirementsDigest !== existing.requirementsDigest &&
    existing.currentStep > 2
  ) {
    throw new Error(
      'workflow requirements cannot change after planning starts',
    );
  }
  if (
    updated.verificationPolicyVersion !== existing.verificationPolicyVersion
  ) {
    throw new Error('workflow verification policy version cannot be changed');
  }
  if (
    !Number.isInteger(updated.currentStep) ||
    updated.currentStep < 1 ||
    updated.currentStep > maxWorkflowStep(updated.mode)
  ) {
    throw new Error(`invalid workflow step: ${updated.currentStep}`);
  }
  if (!isWorkflowStatus(updated.status)) {
    throw new Error(`invalid workflow status: ${String(updated.status)}`);
  }
  if (
    !Array.isArray(updated.skippedSteps) ||
    updated.skippedSteps.some((step) => typeof step !== 'string')
  ) {
    throw new Error('workflow skipped steps must be strings');
  }
  if (
    updated.reviewPolicyVersion === 2 &&
    updated.skippedSteps.some(
      (step) => step !== 'clarification' && step !== 'review',
    )
  ) {
    throw new Error(
      'workflow policy v2 only allows skipping clarification or review',
    );
  }
  if (!canTransition(existing.status, updated.status)) {
    throw new Error(
      `invalid workflow status transition: ${existing.status} -> ${updated.status}`,
    );
  }
  if (updated.status === 'planned' && updated.mode === 'mamba') {
    throw new Error('manba workflows cannot be planned');
  }
  if (updated.status === 'planned' && updated.currentStep !== 4) {
    throw new Error('planned workflows must be at step 4');
  }
  if (
    updated.status === 'completed' &&
    updated.currentStep !== maxWorkflowStep(updated.mode) &&
    !(updated.currentStep === 4 && updated.planDecision === 'solo_handoff')
  ) {
    throw new Error(
      `completed ${updated.mode === 'mamba' ? 'manba' : updated.mode} workflows must be at step ${maxWorkflowStep(updated.mode)}`,
    );
  }
  if (
    updated.blockingReason !== undefined &&
    typeof updated.blockingReason !== 'string'
  ) {
    throw new Error('workflow blocking reason must be a string');
  }
  if (updated.status === 'blocked') {
    if (!updated.blockingReason?.trim()) {
      throw new Error('blocked workflows require a blocking reason');
    }
  } else if (updated.blockingReason !== undefined) {
    throw new Error('only blocked workflows can have a blocking reason');
  }
  if (updated.mode !== 'mamba' && updated.outcome !== undefined) {
    throw new Error('only manba workflows can have an outcome');
  }
  if (updated.outcome !== undefined && !isWorkflowOutcome(updated.outcome)) {
    throw new Error(`invalid workflow outcome: ${updated.outcome}`);
  }
  if (updated.outcome !== undefined && updated.status !== 'completed') {
    throw new Error('manba outcomes can only be set on completed workflows');
  }
  if (
    updated.mode === 'mamba' &&
    updated.status === 'completed' &&
    !updated.outcome
  ) {
    throw new Error('completed manba workflows require an outcome');
  }
  if (updated.mode === 'mamba' && updated.planVersion !== undefined) {
    throw new Error('manba workflows cannot have a plan version');
  }
  if (
    updated.reviewPolicyVersion !== undefined &&
    updated.reviewPolicyVersion !== 1 &&
    updated.reviewPolicyVersion !== 2
  ) {
    throw new Error('invalid workflow review policy version');
  }
  if (updated.mode === 'mamba' && updated.reviewPolicyVersion !== undefined) {
    throw new Error('manba workflows cannot have a review policy version');
  }
  if (
    updated.planningPolicyVersion !== undefined &&
    updated.planningPolicyVersion !== 1 &&
    updated.planningPolicyVersion !== 2
  ) {
    throw new Error('invalid workflow planning policy version');
  }
  if (updated.mode === 'mamba' && updated.planningPolicyVersion !== undefined) {
    throw new Error('manba workflows cannot have a planning policy version');
  }
  if (
    updated.verificationPolicyVersion !== undefined &&
    updated.verificationPolicyVersion !== 1
  ) {
    throw new Error('invalid workflow verification policy version');
  }
  if (
    updated.mode === 'mamba' &&
    updated.verificationPolicyVersion !== undefined
  ) {
    throw new Error(
      'manba workflows cannot have a verification policy version',
    );
  }
  if (
    updated.verificationStatus !== undefined &&
    !isVerificationStatus(updated.verificationStatus)
  ) {
    throw new Error('invalid workflow verification status');
  }
  if (updated.mode === 'mamba' && updated.verificationStatus !== undefined) {
    throw new Error('manba workflows cannot have a verification status');
  }
  if (
    updated.requirementsStatus !== undefined &&
    !isRequirementsStatus(updated.requirementsStatus)
  ) {
    throw new Error('invalid workflow requirements status');
  }
  if (updated.mode === 'mamba' && updated.requirementsStatus !== undefined) {
    throw new Error('manba workflows cannot have a requirements status');
  }
  if (
    updated.requirementsDigest !== undefined &&
    typeof updated.requirementsDigest !== 'string'
  ) {
    throw new Error('workflow requirements digest must be a string');
  }
  if (updated.mode === 'mamba' && updated.requirementsDigest !== undefined) {
    throw new Error('manba workflows cannot have a requirements digest');
  }
  if (
    updated.planDecision !== undefined &&
    !isPlanDecision(updated.planDecision)
  ) {
    throw new Error('invalid workflow plan decision');
  }
  if (updated.mode === 'mamba' && updated.planDecision !== undefined) {
    throw new Error('manba workflows cannot have a plan decision');
  }
  if (
    updated.planDecision !== existing.planDecision &&
    existing.planDecision !== undefined
  ) {
    throw new Error('workflow plan decision cannot be changed');
  }
  if (
    updated.planDecision !== existing.planDecision &&
    existing.currentStep !== 4
  ) {
    throw new Error('workflow plan decision can only be set at step 4');
  }
  if (
    updated.planningPolicyVersion === 1 ||
    updated.planningPolicyVersion === 2
  ) {
    if (updated.currentStep >= 3) {
      if (updated.requirementsStatus !== 'ready') {
        throw new Error('requirements must be ready before planning');
      }
      if (
        !(await workflowArtifactExists(
          projectRoot,
          updated.taskId,
          'requirements.md',
        ))
      ) {
        throw new Error('requirements.md is required before planning');
      }
      if (updated.planningPolicyVersion === 2) {
        const requirements = await readRequirementsLedger(
          projectRoot,
          updated.taskId,
        );
        if (
          !requirements ||
          !requirementsAreReady(requirements) ||
          updated.requirementsDigest !==
            calculateRequirementsDigest(requirements)
        ) {
          throw new Error(
            'finalized requirements.json with no blocking unknowns is required before planning',
          );
        }
      }
    }
    if (
      updated.currentStep >= 4 &&
      !(await workflowArtifactExists(projectRoot, updated.taskId, 'plan.md'))
    ) {
      throw new Error('plan.md is required before the plan gate');
    }
    if (
      updated.status === 'planned' &&
      updated.planDecision !== 'plan_only' &&
      updated.planDecision !== 'solo_handoff'
    ) {
      throw new Error(
        'planned workflows require a plan-only or solo-handoff decision',
      );
    }
    if (
      updated.currentStep >= 5 &&
      updated.status === 'in_progress' &&
      updated.planDecision !== 'governed_execution'
    ) {
      throw new Error('governed execution must be confirmed before step 5');
    }
  }
  if (
    updated.verificationPolicyVersion === 1 &&
    updated.currentStep >= 7 &&
    updated.planDecision !== 'solo_handoff' &&
    !options.allowIncompleteVerification &&
    !(await verificationCanAdvance(
      projectRoot,
      updated.taskId,
      updated.planVersion ?? 1,
    ))
  ) {
    throw new Error(
      'workflow verification is incomplete, stale, or requires manual confirmation',
    );
  }
  if (
    existing.status === 'blocked' &&
    existing.blockingReason?.startsWith('[verification]') &&
    updated.status === 'in_progress' &&
    (updated.verificationStatus === 'manual_required' ||
      updated.verificationStatus === 'blocked')
  ) {
    throw new Error(
      'verification-blocked workflows must resume through verify',
    );
  }
  if (
    updated.planVersion !== undefined &&
    (!Number.isInteger(updated.planVersion) || updated.planVersion < 1)
  ) {
    throw new Error('workflow plan version must be a positive integer');
  }
  if (
    updated.planVersion !== existing.planVersion &&
    updated.planVersion !== undefined &&
    updated.planVersion !== (existing.planVersion ?? 1) + 1
  ) {
    throw new Error('workflow plan version must increase exactly once');
  }
  if (
    updated.planVersion !== existing.planVersion &&
    updated.currentStep !== 4
  ) {
    throw new Error('workflow plan version can only change at step 4');
  }
  await validateParentTask(projectRoot, updated.mode, updated.parentTaskId);
  if (
    (isTerminalWorkflowStatus(updated.status) ||
      updated.status === 'planned') &&
    (await listActiveMambaChildren(projectRoot, updated.taskId)).length > 0
  ) {
    throw new Error('cannot finish workflow with an active manba child');
  }
  if (
    updated.status === 'completed' &&
    updated.reviewPolicyVersion === 1 &&
    updated.planDecision !== 'solo_handoff' &&
    !reviewWasExplicitlySkipped(updated) &&
    !(await reviewCanComplete(projectRoot, updated.taskId))
  ) {
    throw new Error('workflow review is incomplete or still has open blockers');
  }
  if (
    updated.status === 'completed' &&
    updated.reviewPolicyVersion === 2 &&
    updated.planDecision !== 'solo_handoff' &&
    !(await reviewCanComplete(projectRoot, updated.taskId))
  ) {
    throw new Error('workflow review is incomplete or still has open blockers');
  }
  if (
    updated.status === 'completed' &&
    updated.verificationPolicyVersion === 1 &&
    updated.planDecision !== 'solo_handoff' &&
    !(await workflowArtifactExists(projectRoot, updated.taskId, 'summary.md'))
  ) {
    throw new Error('summary.md is required before workflow completion');
  }
}

function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  if (from === to) return true;
  if (from === 'in_progress') return true;
  if (from === 'planned')
    return to === 'in_progress' || to === 'completed' || to === 'abandoned';
  if (from === 'blocked') return to === 'in_progress' || to === 'abandoned';
  return false;
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'completed' || status === 'abandoned';
}

function isWorkflowShape(obj: Partial<WorkflowMeta>): boolean {
  const { currentStep, mode, status } = obj;
  if (
    !Number.isInteger(currentStep) ||
    !mode ||
    currentStep === undefined ||
    currentStep < 1 ||
    currentStep > maxWorkflowStep(mode)
  ) {
    return false;
  }
  if (!status || !Array.isArray(obj.skippedSteps)) return false;
  if (obj.skippedSteps.some((step) => typeof step !== 'string')) return false;
  if (
    obj.blockingReason !== undefined &&
    typeof obj.blockingReason !== 'string'
  )
    return false;
  if (obj.parentTaskId !== undefined && typeof obj.parentTaskId !== 'string')
    return false;
  if (obj.outcome !== undefined && !isWorkflowOutcome(obj.outcome))
    return false;
  if (
    obj.planVersion !== undefined &&
    (!Number.isInteger(obj.planVersion) || obj.planVersion < 1)
  )
    return false;
  if (
    obj.reviewPolicyVersion !== undefined &&
    obj.reviewPolicyVersion !== 1 &&
    obj.reviewPolicyVersion !== 2
  )
    return false;
  if (
    obj.planningPolicyVersion !== undefined &&
    obj.planningPolicyVersion !== 1 &&
    obj.planningPolicyVersion !== 2
  )
    return false;
  if (
    obj.verificationPolicyVersion !== undefined &&
    obj.verificationPolicyVersion !== 1
  )
    return false;
  if (
    obj.requirementsStatus !== undefined &&
    !isRequirementsStatus(obj.requirementsStatus)
  )
    return false;
  if (
    obj.requirementsDigest !== undefined &&
    typeof obj.requirementsDigest !== 'string'
  )
    return false;
  if (obj.planDecision !== undefined && !isPlanDecision(obj.planDecision))
    return false;
  if (
    obj.verificationStatus !== undefined &&
    !isVerificationStatus(obj.verificationStatus)
  )
    return false;
  if (status === 'blocked') {
    if (!obj.blockingReason?.trim()) return false;
  } else if (obj.blockingReason !== undefined) {
    return false;
  }
  if (mode === 'mamba') {
    if (
      status === 'planned' ||
      obj.planVersion !== undefined ||
      obj.reviewPolicyVersion !== undefined ||
      obj.planningPolicyVersion !== undefined ||
      obj.verificationPolicyVersion !== undefined ||
      obj.requirementsStatus !== undefined ||
      obj.requirementsDigest !== undefined ||
      obj.planDecision !== undefined ||
      obj.verificationStatus !== undefined
    )
      return false;
    if (
      obj.parentTaskId !== undefined &&
      !isValidWorkflowTaskId(obj.parentTaskId)
    )
      return false;
    if (obj.outcome !== undefined && status !== 'completed') return false;
    if (status === 'completed' && obj.outcome === undefined) return false;
  } else if (obj.parentTaskId !== undefined || obj.outcome !== undefined) {
    return false;
  }
  return true;
}

async function workflowArtifactExists(
  projectRoot: string,
  taskId: string,
  filename: string,
): Promise<boolean> {
  try {
    await stat(path.join(workflowDir(projectRoot, taskId), filename));
    return true;
  } catch {
    return false;
  }
}

function reviewWasExplicitlySkipped(meta: WorkflowMeta): boolean {
  return (
    meta.skippedSteps.includes('review') ||
    (meta.skippedSteps.includes('film-1') &&
      meta.skippedSteps.includes('film-2'))
  );
}

function isVerificationStatus(
  value: unknown,
): value is VerificationOverallStatus {
  return (
    value === 'pending' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'manual_required' ||
    value === 'blocked'
  );
}

export async function listActiveMambaChildren(
  projectRoot: string,
  parentTaskId: string,
): Promise<WorkflowMeta[]> {
  return (await listMambaChildren(projectRoot, parentTaskId)).filter(
    (workflow) =>
      workflow.status === 'in_progress' || workflow.status === 'blocked',
  );
}

async function listMambaChildren(
  projectRoot: string,
  parentTaskId: string,
): Promise<WorkflowMeta[]> {
  return (await listWorkflows(projectRoot)).filter(
    (workflow) =>
      workflow.mode === 'mamba' && workflow.parentTaskId === parentTaskId,
  );
}

/**
 * When a /manba child becomes blocked or completes with manual_test_required,
 * the parent /man or /manteam workflow must be synchronously marked blocked
 * (plan §3 Step 6). This is a no-op if the child is in a non-blocking state
 * or the parent is already blocked/terminal.
 */
async function propagateChildStatus(
  projectRoot: string,
  child: WorkflowMeta,
): Promise<void> {
  const shouldBlockParent =
    child.status === 'blocked' ||
    (child.status === 'completed' && child.outcome === 'manual_test_required');
  if (!shouldBlockParent) return;

  const parentTaskId = child.parentTaskId;
  if (!parentTaskId) return;
  const parent = await readWorkflow(projectRoot, parentTaskId);
  if (!parent || parent.status !== 'in_progress') return;

  const reason =
    child.status === 'blocked'
      ? `manba child ${child.taskId} is blocked: ${child.blockingReason ?? 'unknown reason'}`
      : `manba child ${child.taskId} requires manual testing`;

  await writeMetadata(workflowDir(projectRoot, parent.taskId), {
    ...parent,
    status: 'blocked',
    blockingReason: reason,
    updatedAt: new Date().toISOString(),
  });

  // Keep Active Plans index in sync — blocked workflows are removed from
  // the active list (plan §3 Step 3).
  if (parent.mode === 'man' || parent.mode === 'manteam') {
    await upsertActivePlan(projectRoot, {
      taskId: parent.taskId,
      status: 'blocked',
      planVersion: parent.planVersion ?? 1,
    });
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * 内部使用：检查 workflow 目录是否存在（用于 status 命令显示活跃任务）。
 */
export async function workflowExists(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  if (!isValidWorkflowTaskId(taskId)) return false;
  try {
    await stat(metadataPath(projectRoot, taskId));
    return true;
  } catch {
    return false;
  }
}

function assertValidTaskId(taskId: string): void {
  if (!isValidWorkflowTaskId(taskId)) {
    throw new Error(`invalid workflow taskId: ${taskId}`);
  }
}

import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { upsertActivePlan } from './team-memory.js';

/**
 * Workflow 元数据。
 *
 * 每个 /man、/mamba 或 /manteam 任务在 .mancode/workflows/<taskId>/metadata.json 里
 * 存一份，记录任务进度（docs/14-orchestration.md §2.1）。
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
  /** 被跳过的步骤名（如 ['warmup-drill', 'film-1']）*/
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
  /** Final diagnostic result for /mamba workflows. */
  outcome?: WorkflowOutcome;
  /** Monotonically increasing plan revision for /man workflows. */
  planVersion?: number;
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

export interface CreateWorkflowOptions {
  parentTaskId?: string;
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
 * @param mode man / mamba / manteam
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
    ...(mode === 'man' || mode === 'manteam' ? { planVersion: 1 } : {}),
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
  await validateWorkflowMeta(projectRoot, updated, existing);
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

async function validateParentTask(
  projectRoot: string,
  mode: WorkflowMode,
  parentTaskId: string | undefined,
  requireStepSix = false,
): Promise<void> {
  if (!parentTaskId) return;
  if (mode !== 'mamba') {
    throw new Error('only mamba workflows can have a parent task');
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
  if (!canTransition(existing.status, updated.status)) {
    throw new Error(
      `invalid workflow status transition: ${existing.status} -> ${updated.status}`,
    );
  }
  if (updated.status === 'planned' && updated.mode === 'mamba') {
    throw new Error('mamba workflows cannot be planned');
  }
  if (updated.status === 'planned' && updated.currentStep !== 4) {
    throw new Error('planned workflows must be at step 4');
  }
  if (
    updated.status === 'completed' &&
    updated.currentStep !== maxWorkflowStep(updated.mode)
  ) {
    throw new Error(
      `completed ${updated.mode} workflows must be at step ${maxWorkflowStep(updated.mode)}`,
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
    throw new Error('only mamba workflows can have an outcome');
  }
  if (updated.outcome !== undefined && !isWorkflowOutcome(updated.outcome)) {
    throw new Error(`invalid workflow outcome: ${updated.outcome}`);
  }
  if (updated.outcome !== undefined && updated.status !== 'completed') {
    throw new Error('mamba outcomes can only be set on completed workflows');
  }
  if (
    updated.mode === 'mamba' &&
    updated.status === 'completed' &&
    !updated.outcome
  ) {
    throw new Error('completed mamba workflows require an outcome');
  }
  if (updated.mode === 'mamba' && updated.planVersion !== undefined) {
    throw new Error('mamba workflows cannot have a plan version');
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
    throw new Error('cannot finish workflow with an active mamba child');
  }
}

function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  if (from === to) return true;
  if (from === 'in_progress') return true;
  if (from === 'planned' || from === 'blocked') {
    return to === 'in_progress' || to === 'abandoned';
  }
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
  if (status === 'blocked') {
    if (!obj.blockingReason?.trim()) return false;
  } else if (obj.blockingReason !== undefined) {
    return false;
  }
  if (mode === 'mamba') {
    if (status === 'planned' || obj.planVersion !== undefined) return false;
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
 * When a /mamba child becomes blocked or completes with manual_test_required,
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
      ? `mamba child ${child.taskId} is blocked: ${child.blockingReason ?? 'unknown reason'}`
      : `mamba child ${child.taskId} requires manual testing`;

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

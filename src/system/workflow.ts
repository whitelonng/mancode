import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

/**
 * Workflow 元数据。
 *
 * 每个 /man8 或 /man 任务在 .mancode/workflows/<taskId>/metadata.json 里
 * 存一份，记录任务进度（docs/14-orchestration.md §2.1）。
 */
export interface WorkflowMeta {
  /** YYYYMMDD-HHMMSS-<slug> 格式 */
  taskId: string;
  /** 用户的原始任务描述 */
  task: string;
  /** 触发的工作流模式 */
  mode: WorkflowMode;
  /** 当前进行到第几步（1-8）*/
  currentStep: number;
  /** 被跳过的步骤名（如 ['warmup-drill', 'film-1']）*/
  skippedSteps: string[];
  /** ISO timestamp */
  startedAt: string;
  /** ISO timestamp，每次更新都刷新 */
  updatedAt: string;
  /** 'in_progress' | 'completed' | 'abandoned' */
  status: WorkflowStatus;
}

export type WorkflowStatus = 'in_progress' | 'completed' | 'abandoned';
export type WorkflowMode = 'man8' | 'man' | 'manteam';

const METADATA_FILE = 'metadata.json';
const SLUG_MAX = 30;

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
 * @param mode man8 / man
 */
export async function createWorkflow(
  projectRoot: string,
  task: string,
  mode: WorkflowMode,
): Promise<WorkflowMeta> {
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
  await writeMetadata(workflowDir(projectRoot, taskId), updated);
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
  const dir = workflowDir(projectRoot, taskId);
  try {
    await stat(dir);
  } catch {
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}

function workflowsRoot(projectRoot: string): string {
  return path.join(projectRoot, '.mancode', 'workflows');
}

function workflowDir(projectRoot: string, taskId: string): string {
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
      typeof obj.mode !== 'string' ||
      typeof obj.currentStep !== 'number' ||
      !Array.isArray(obj.skippedSteps) ||
      typeof obj.startedAt !== 'string' ||
      typeof obj.updatedAt !== 'string' ||
      typeof obj.status !== 'string'
    ) {
      return null;
    }
    return { ...(obj as WorkflowMeta), taskId };
  } catch {
    return null;
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
  try {
    await stat(metadataPath(projectRoot, taskId));
    return true;
  } catch {
    return false;
  }
}

import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  type WorkflowMeta,
  type WorkflowStatus,
  createWorkflow,
  deleteWorkflow,
  isValidWorkflowTaskId,
  listWorkflows,
  readWorkflow,
  updateWorkflow,
} from '../system/workflow.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_INVALID_ARG = 2;

export interface WorkflowOptions {
  dryRun?: boolean;
  olderThan?: string;
  json?: boolean;
  step?: string;
  status?: string;
  skipped?: string;
}

/**
 * `mancode workflow` 子命令。
 *
 * 支持：
 * - list：列出 workflow
 * - show <taskId>：显示详情
 * - clean [--dry-run] [--older-than 30d]：清理 workflow
 */
export async function workflow(
  rootDir: string,
  subcommand: string,
  args: string[] = [],
  options: WorkflowOptions = {},
): Promise<number> {
  if (!(await pathExists(path.join(rootDir, '.mancode', 'state.json')))) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'not initialized' }, null, 2));
    } else {
      console.error('✗  mancode not initialized.');
      console.error('   Run `mancode init` to get started.');
    }
    return EXIT_NOT_INITIALIZED;
  }

  switch (subcommand) {
    case 'create':
      return workflowCreate(rootDir, args, options);
    case 'update':
      return workflowUpdate(rootDir, args[0], options);
    case 'list':
      return workflowList(rootDir, options);
    case 'show':
      return workflowShow(rootDir, args[0], options);
    case 'clean':
      return workflowClean(rootDir, options);
    default:
      if (options.json) {
        console.log(
          JSON.stringify(
            { error: `invalid subcommand: ${subcommand}` },
            null,
            2,
          ),
        );
      } else {
        console.error(`✗  Invalid workflow subcommand: ${subcommand}`);
        console.error(
          '   Use: create <man8|man> <task> | update <taskId> | list | show <taskId> | clean',
        );
      }
      return EXIT_INVALID_ARG;
  }
}

async function workflowCreate(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const mode = args[0];
  const task = args.slice(1).join(' ').trim();
  if (mode !== 'man8' && mode !== 'man') {
    return invalidArg(
      options,
      `invalid workflow mode: ${mode ?? ''}`,
      'Use: mancode workflow create <man8|man> <task>',
    );
  }
  if (!task) {
    return invalidArg(
      options,
      'missing workflow task',
      'Use: mancode workflow create <man8|man> <task>',
    );
  }

  const meta = await createWorkflow(rootDir, task, mode);
  if (options.json) {
    console.log(JSON.stringify(meta, null, 2));
  } else {
    console.log(`Created workflow: ${meta.taskId}`);
  }
  return EXIT_OK;
}

async function workflowUpdate(
  rootDir: string,
  taskId: string | undefined,
  options: WorkflowOptions,
): Promise<number> {
  if (!taskId) {
    return invalidArg(
      options,
      'missing taskId',
      'Use: mancode workflow update <taskId> [--step N] [--status in_progress|completed|abandoned] [--skipped a,b]',
    );
  }
  if (!isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId}`);
  }

  const existing = await readWorkflow(rootDir, taskId);
  if (!existing) {
    return invalidArg(options, `workflow not found: ${taskId}`);
  }

  const patch: Partial<WorkflowMeta> = {};
  if (options.step !== undefined) {
    const currentStep = Number.parseInt(options.step, 10);
    const maxStep = existing.mode === 'man' ? 8 : 3;
    if (
      !Number.isInteger(currentStep) ||
      currentStep < 1 ||
      currentStep > maxStep
    ) {
      return invalidArg(options, `invalid --step: ${options.step}`);
    }
    patch.currentStep = currentStep;
  }

  if (options.status !== undefined) {
    if (!isWorkflowStatus(options.status)) {
      return invalidArg(options, `invalid --status: ${options.status}`);
    }
    patch.status = options.status;
  }

  if (options.skipped !== undefined) {
    patch.skippedSteps = options.skipped
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (Object.keys(patch).length === 0) {
    return invalidArg(options, 'missing update fields');
  }

  await updateWorkflow(rootDir, taskId, patch);

  const updated = await readWorkflow(rootDir, taskId);
  if (options.json) {
    console.log(JSON.stringify(updated, null, 2));
  } else {
    console.log(`Updated workflow: ${taskId}`);
  }
  return EXIT_OK;
}

async function workflowList(
  rootDir: string,
  options: WorkflowOptions,
): Promise<number> {
  const workflows = await listWorkflows(rootDir);
  if (options.json) {
    console.log(JSON.stringify(workflows, null, 2));
    return EXIT_OK;
  }

  if (workflows.length === 0) {
    console.log('No workflows.');
    return EXIT_OK;
  }

  const inProgress = workflows.filter((w) => w.status === 'in_progress').length;
  console.log(
    `mancode workflows (${workflows.length} total, ${inProgress} in_progress)`,
  );
  console.log('');
  for (const meta of workflows) {
    console.log(formatWorkflowRow(meta));
  }
  return EXIT_OK;
}

async function workflowShow(
  rootDir: string,
  taskId: string | undefined,
  options: WorkflowOptions,
): Promise<number> {
  if (!taskId) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'missing taskId' }, null, 2));
    } else {
      console.error('✗  Missing taskId.');
      console.error('   Use: mancode workflow show <taskId>');
    }
    return EXIT_INVALID_ARG;
  }
  if (!isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId}`);
  }

  const meta = await readWorkflow(rootDir, taskId);
  if (!meta) {
    if (options.json) {
      console.log(
        JSON.stringify({ error: `workflow not found: ${taskId}` }, null, 2),
      );
    } else {
      console.error(`✗  Workflow not found: ${taskId}`);
    }
    return EXIT_INVALID_ARG;
  }

  if (options.json) {
    console.log(JSON.stringify(meta, null, 2));
    return EXIT_OK;
  }

  console.log(`Workflow:    ${meta.taskId}`);
  console.log(`Task:        ${meta.task}`);
  console.log(`Mode:        ${meta.mode}`);
  console.log(`Status:      ${meta.status}`);
  console.log(
    `Current step:${meta.currentStep}/${meta.mode === 'man' ? 8 : 3}`,
  );
  console.log(
    `Skipped:     ${meta.skippedSteps.length > 0 ? meta.skippedSteps.join(', ') : 'none'}`,
  );
  console.log(`Started:     ${meta.startedAt}`);
  console.log(`Updated:     ${meta.updatedAt}`);
  return EXIT_OK;
}

async function workflowClean(
  rootDir: string,
  options: WorkflowOptions,
): Promise<number> {
  const workflows = await listWorkflows(rootDir);
  const cutoff = parseOlderThan(options.olderThan);
  if (cutoff === null) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { error: `invalid --older-than: ${options.olderThan}` },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗  Invalid --older-than duration: ${options.olderThan}`);
      console.error('   Use examples like: 30d, 12h, 90m');
    }
    return EXIT_INVALID_ARG;
  }

  const candidates = workflows.filter((meta) => {
    if (!cutoff) return meta.status !== 'in_progress';
    const started = Date.parse(meta.startedAt);
    return Number.isFinite(started) && started < cutoff.getTime();
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: Boolean(options.dryRun),
          count: candidates.length,
          workflows: candidates,
        },
        null,
        2,
      ),
    );
  } else if (candidates.length === 0) {
    console.log('No workflows to clean.');
  } else if (options.dryRun) {
    console.log(`Would remove ${candidates.length} workflow(s):`);
    for (const meta of candidates) console.log(`  ${meta.taskId}`);
  } else {
    console.log(`Removed ${candidates.length} workflow(s).`);
  }

  if (!options.dryRun) {
    for (const meta of candidates) {
      await deleteWorkflow(rootDir, meta.taskId);
    }
  }
  return EXIT_OK;
}

function formatWorkflowRow(meta: WorkflowMeta): string {
  const stepMax = meta.mode === 'man' ? 8 : 3;
  const step =
    meta.status === 'in_progress'
      ? `Step ${meta.currentStep}/${stepMax}`
      : ago(meta.updatedAt);
  return `${meta.taskId.padEnd(42)} ${meta.mode.padEnd(5)} ${meta.status.padEnd(11)} ${step}`;
}

function parseOlderThan(value: string | undefined): Date | undefined | null {
  if (!value) return undefined;
  const match = /^(\d+)([dhm])$/.exec(value);
  if (!match) return null;

  const amount = Number.parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 'm';
  const ms =
    unit === 'd'
      ? amount * 24 * 60 * 60 * 1000
      : unit === 'h'
        ? amount * 60 * 60 * 1000
        : amount * 60 * 1000;
  return new Date(Date.now() - ms);
}

function invalidArg(
  options: WorkflowOptions,
  message: string,
  usage?: string,
): number {
  if (options.json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`✗  ${message}`);
    if (usage) console.error(`   ${usage}`);
  }
  return EXIT_INVALID_ARG;
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return (
    value === 'in_progress' || value === 'completed' || value === 'abandoned'
  );
}

function ago(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'unknown';
  const delta = Math.max(0, Date.now() - time);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

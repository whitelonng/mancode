import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  type WorkflowMeta,
  deleteWorkflow,
  listWorkflows,
  readWorkflow,
} from '../system/workflow.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_INVALID_ARG = 2;

export interface WorkflowOptions {
  dryRun?: boolean;
  olderThan?: string;
  json?: boolean;
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
        console.error('   Use: list | show <taskId> | clean');
      }
      return EXIT_INVALID_ARG;
  }
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

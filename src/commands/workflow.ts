import { access } from 'node:fs/promises';
import path from 'node:path';
import { upsertActivePlan } from '../system/team-memory.js';
import {
  type WorkflowMeta,
  createWorkflow,
  deleteWorkflow,
  isTerminalWorkflowStatus,
  isValidWorkflowTaskId,
  isWorkflowOutcome,
  isWorkflowStatus,
  listWorkflows,
  maxWorkflowStep,
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
  parentTask?: string;
  blockingReason?: string;
  outcome?: string;
  planVersion?: string;
}

interface WorkflowView extends WorkflowMeta {
  activeChildren?: WorkflowMeta[];
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
          '   Use: create <man|mamba|manteam> <task> | update <taskId> | list | show <taskId> | clean',
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
  if (mode !== 'man' && mode !== 'mamba' && mode !== 'manteam') {
    return invalidArg(
      options,
      `invalid workflow mode: ${mode ?? ''}`,
      'Use: mancode workflow create <man|mamba|manteam> <task> [--parent-task <taskId>]',
    );
  }
  if (!task) {
    return invalidArg(
      options,
      'missing workflow task',
      'Use: mancode workflow create <man|mamba|manteam> <task> [--parent-task <taskId>]',
    );
  }

  try {
    const meta = await createWorkflow(rootDir, task, mode, {
      parentTaskId: options.parentTask,
    });
    if (options.json) {
      console.log(JSON.stringify(meta, null, 2));
    } else {
      console.log(`Created workflow: ${meta.taskId}`);
    }
  } catch (error) {
    return invalidArg(
      options,
      error instanceof Error ? error.message : 'unable to create workflow',
    );
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
      'Use: mancode workflow update <taskId> [--step N] [--status in_progress|planned|completed|blocked|abandoned] [--blocking-reason <reason>] [--outcome <outcome>] [--plan-version N] [--skipped a,b]',
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
    const currentStep = parseExactPositiveInteger(options.step);
    const maxStep = maxWorkflowStep(existing.mode);
    if (currentStep === null || currentStep < 1 || currentStep > maxStep) {
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

  const nextStatus = patch.status ?? existing.status;

  if (options.blockingReason !== undefined) {
    if (nextStatus !== 'blocked') {
      return invalidArg(
        options,
        '--blocking-reason requires --status blocked or an already blocked workflow',
      );
    }
    patch.blockingReason = options.blockingReason;
  }

  if (options.status === 'in_progress' && existing.blockingReason) {
    patch.blockingReason = undefined;
  }

  if (options.outcome !== undefined) {
    if (!isWorkflowOutcome(options.outcome)) {
      return invalidArg(options, `invalid --outcome: ${options.outcome}`);
    }
    if (existing.mode !== 'mamba' || nextStatus !== 'completed') {
      return invalidArg(
        options,
        '--outcome is only valid when completing a mamba workflow',
      );
    }
    patch.outcome = options.outcome;
  }

  if (options.planVersion !== undefined) {
    const planVersion = parseExactPositiveInteger(options.planVersion);
    const currentVersion = existing.planVersion ?? 1;
    if (
      planVersion === null ||
      (existing.mode !== 'man' && existing.mode !== 'manteam') ||
      planVersion !== currentVersion + 1 ||
      (patch.currentStep ?? existing.currentStep) !== 4
    ) {
      return invalidArg(
        options,
        `invalid --plan-version: ${options.planVersion}; expected ${currentVersion + 1} at step 4 for ${existing.mode}`,
      );
    }
    patch.planVersion = planVersion;
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

  try {
    await updateWorkflow(rootDir, taskId, patch);
  } catch (error) {
    return invalidArg(
      options,
      error instanceof Error ? error.message : 'unable to update workflow',
    );
  }

  const updated = await readWorkflow(rootDir, taskId);
  if (updated && (updated.mode === 'man' || updated.mode === 'manteam')) {
    const shouldSyncPlan =
      updated.currentStep >= 4 || updated.status !== 'in_progress';
    if (shouldSyncPlan) {
      await upsertActivePlan(rootDir, {
        taskId: updated.taskId,
        status: updated.status,
        planVersion: updated.planVersion ?? 1,
      });
    }
  }
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
  const views = attachActiveChildren(workflows);
  if (options.json) {
    console.log(JSON.stringify(views, null, 2));
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
  for (const meta of views) {
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

  const children =
    meta.mode === 'man' || meta.mode === 'manteam'
      ? (attachActiveChildren(await listWorkflows(rootDir)).find(
          (workflow) => workflow.taskId === meta.taskId,
        )?.activeChildren ?? [])
      : undefined;

  if (options.json) {
    console.log(
      JSON.stringify(
        children === undefined ? meta : { ...meta, activeChildren: children },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  console.log(`Workflow:    ${meta.taskId}`);
  console.log(`Task:        ${meta.task}`);
  console.log(`Mode:        ${meta.mode}`);
  console.log(`Status:      ${meta.status}`);
  console.log(`Current step:${meta.currentStep}/${maxWorkflowStep(meta.mode)}`);
  console.log(
    `Skipped:     ${meta.skippedSteps.length > 0 ? meta.skippedSteps.join(', ') : 'none'}`,
  );
  console.log(`Started:     ${meta.startedAt}`);
  console.log(`Updated:     ${meta.updatedAt}`);
  if (meta.parentTaskId) console.log(`Parent:      ${meta.parentTaskId}`);
  if (meta.planVersion !== undefined)
    console.log(`Plan version: ${meta.planVersion}`);
  if (meta.outcome) console.log(`Outcome:     ${meta.outcome}`);
  if (meta.blockingReason) console.log(`Blocked:     ${meta.blockingReason}`);

  // Show active mamba children for man/manteam workflows (plan §7).
  if (children !== undefined) {
    if (children.length > 0) {
      console.log(`Children:    ${children.length} active mamba workflow(s)`);
      for (const child of children) {
        console.log(
          `  - ${child.taskId} (Step ${child.currentStep}/5, ${child.status})`,
        );
      }
    }
  }
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
    if (!isTerminalWorkflowStatus(meta.status)) return false;
    if (!cutoff) return true;
    const started = Date.parse(meta.startedAt);
    return Number.isFinite(started) && started < cutoff.getTime();
  });

  const removed: WorkflowMeta[] = [];
  if (!options.dryRun) {
    for (const meta of candidates) {
      const didRemove = await deleteWorkflow(rootDir, meta.taskId);
      if (didRemove) removed.push(meta);
      if (didRemove && (meta.mode === 'man' || meta.mode === 'manteam')) {
        await upsertActivePlan(rootDir, {
          taskId: meta.taskId,
          status: meta.status,
          planVersion: meta.planVersion ?? 1,
        });
      }
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: Boolean(options.dryRun),
          count: options.dryRun ? candidates.length : removed.length,
          workflows: options.dryRun ? candidates : removed,
        },
        null,
        2,
      ),
    );
  } else if ((options.dryRun ? candidates : removed).length === 0) {
    console.log('No workflows to clean.');
  } else if (options.dryRun) {
    console.log(`Would remove ${candidates.length} workflow(s):`);
    for (const meta of candidates) console.log(`  ${meta.taskId}`);
  } else {
    console.log(`Removed ${removed.length} workflow(s).`);
  }

  return EXIT_OK;
}

function formatWorkflowRow(meta: WorkflowView): string {
  const stepMax = maxWorkflowStep(meta.mode);
  const step =
    meta.status === 'in_progress'
      ? `Step ${meta.currentStep}/${stepMax}`
      : ago(meta.updatedAt);
  const details = [
    meta.planVersion !== undefined ? `plan=v${meta.planVersion}` : '',
    meta.parentTaskId ? `parent=${meta.parentTaskId}` : '',
    meta.outcome ? `outcome=${meta.outcome}` : '',
    meta.blockingReason ? `blocked=${meta.blockingReason}` : '',
    meta.activeChildren && meta.activeChildren.length > 0
      ? `children=${meta.activeChildren.map((child) => child.taskId).join(',')}`
      : '',
  ].filter(Boolean);
  return `${meta.taskId.padEnd(42)} ${meta.mode.padEnd(7)} ${meta.status.padEnd(11)} ${step}${details.length > 0 ? ` | ${details.join(' | ')}` : ''}`;
}

function attachActiveChildren(workflows: WorkflowMeta[]): WorkflowView[] {
  return workflows.map((meta) => {
    if (meta.mode !== 'man' && meta.mode !== 'manteam') return meta;
    return {
      ...meta,
      activeChildren: workflows.filter(
        (candidate) =>
          candidate.mode === 'mamba' &&
          candidate.parentTaskId === meta.taskId &&
          (candidate.status === 'in_progress' ||
            candidate.status === 'blocked'),
      ),
    };
  });
}

function parseExactPositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

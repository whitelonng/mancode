#!/usr/bin/env node
import { program } from 'commander';
import { init } from './commands/init.js';
import { install } from './commands/install.js';
import { listPlatforms } from './commands/list-platforms.js';
import { manps } from './commands/manps.js';
import { refreshProject } from './commands/refresh-project.js';
import { refreshStyle } from './commands/refresh-style.js';
import { status } from './commands/status.js';
import { uninstall } from './commands/uninstall.js';
import { version } from './commands/version.js';
import { workflow } from './commands/workflow.js';
import { VERSION } from './version.js';

program
  .name('mancode')
  .description(
    'AI coding agent harness. Modes: solo, man, manba, manteam, manps.',
  )
  .version(VERSION);

program
  .command('init')
  .description('Initialize mancode in the current project')
  .option('--force', 'Reinstall even if already initialized')
  .option('--yes', 'Skip all confirmations (CI mode)')
  .option('--team', 'Force enable team mode (MVP-2)')
  .option('--no-team', 'Force disable team mode (MVP-2)')
  .option('--style <name>', 'Specify aesthetic style (MVP-2)')
  .option('--platform <platforms>', 'Adapters: comma-separated names or all')
  .option('--empty', 'Initialize a safe empty directory as a generic project')
  .option('--lang <locale>', 'Initialization language: zh-CN or en')
  .action(async (options) => {
    const code = await init(process.cwd(), {
      ...options,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    process.exitCode = code;
  });

program
  .command('install [platform]')
  .description(
    'Install platform adapter (claude-code, cursor, codex, copilot, zcode)',
  )
  .option('--force', 'Reinstall even if already installed')
  .option('--minimal', 'Minimal install (MVP-2)')
  .action(async (platform, options) => {
    const code = await install(
      process.cwd(),
      platform ?? 'claude-code',
      options,
    );
    process.exitCode = code;
  });

program
  .command('status')
  .description('Show current mancode project status')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    const code = await status(process.cwd(), options);
    process.exitCode = code;
  });

program
  .command('list-platforms')
  .description('List available and installed mancode platform adapters')
  .action(async () => {
    const code = await listPlatforms(process.cwd());
    process.exitCode = code;
  });

program
  .command('uninstall [platform]')
  .description('Remove platform adapter or all mancode artifacts')
  .option('--force', 'Skip confirmation message')
  .option('--all', 'Remove everything including .mancode/ directory')
  .action(async (platform, options) => {
    const code = await uninstall(process.cwd(), platform, options);
    process.exitCode = code;
  });

program
  .command('workflow <subcommand> [args...]')
  .description('Manage mancode workflows')
  .option('--dry-run', 'Preview clean without deleting')
  .option('--older-than <duration>', 'Clean workflows older than (e.g. 30d)')
  .option('--step <n>', 'Update workflow current step')
  .option('--status <status>', 'Update workflow status')
  .option(
    '--parent-task <taskId>',
    'Parent /man or /manteam workflow for manba',
  )
  .option('--blocking-reason <reason>', 'Explain why a workflow is blocked')
  .option('--outcome <outcome>', 'Set manba outcome')
  .option('--plan-version <n>', 'Set the next man/manteam plan revision')
  .option(
    '--requirements-status <status>',
    'Planning readiness: ready or needs_clarification',
  )
  .option(
    '--plan-decision <decision>',
    'Plan gate choice: plan_only or governed_execution',
  )
  .option('--to <mode>', 'Workflow handoff target (solo)')
  .option('--complete', 'Complete an active solo handoff')
  .option(
    '--skipped <steps>',
    'Policy v2: clarification only; use workflow review skip for review',
  )
  .option('--review-depth <depth>', 'Review depth: targeted or full')
  .option('--review-domain <domain>', 'Review domain: quality or security')
  .option(
    '--report <path>',
    'Relative Markdown report path for a review domain',
  )
  .option('--blockers <ids>', 'Comma-separated blocker ids found by a review')
  .option(
    '--resolved <ids>',
    'Comma-separated blocker ids resolved in remediation',
  )
  .option('--file <path>', 'Structured requirements JSON input file')
  .option('--acceptance <id>', 'Acceptance criterion id (for example AC-1)')
  .option('--method <method>', 'Verification method: automated or manual')
  .option('--result <result>', 'Verification result')
  .option('--evidence <text>', 'Verification evidence or user confirmation')
  .option('--command <command>', 'Command used for automated verification')
  .option('--exit-code <code>', 'Exit code from automated verification')
  .option('--evidence-file <path>', 'Existing verification report or artifact')
  .option('--reason <reason>', 'Reason for an explicit review skip')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (subcommand, args, options) => {
    const code = await workflow(process.cwd(), subcommand, args ?? [], options);
    process.exitCode = code;
  });

program
  .command('manps [area]')
  .description('Run deterministic preseason health scan')
  .option('--json', 'Output as JSON (for scripts)')
  .option('--remediate', 'Review scan issues with y/n/skip prompts')
  .action(async (area, options) => {
    const code = await manps(process.cwd(), area ?? 'all', options);
    process.exitCode = code;
  });

program
  .command('refresh-style')
  .description('Refresh project profile and rescan applicable design tokens')
  .action(async () => {
    const code = await refreshStyle(process.cwd());
    process.exitCode = code;
  });

program
  .command('refresh-project')
  .description(
    'Refresh detected project facts after adding Git or project files',
  )
  .action(async () => {
    const code = await refreshProject(process.cwd());
    process.exitCode = code;
  });

program
  .command('version')
  .description('Show version, node version, and platform')
  .action(() => {
    version();
  });

program.parse();

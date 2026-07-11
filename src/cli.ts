#!/usr/bin/env node
import { program } from 'commander';
import { init } from './commands/init.js';
import { install } from './commands/install.js';
import { listPlatforms } from './commands/list-platforms.js';
import { manps } from './commands/manps.js';
import { refreshStyle } from './commands/refresh-style.js';
import { status } from './commands/status.js';
import { uninstall } from './commands/uninstall.js';
import { version } from './commands/version.js';
import { workflow } from './commands/workflow.js';
import { VERSION } from './version.js';

program
  .name('mancode')
  .description(
    'AI coding agent harness. Modes: solo, man, mamba, manteam, manps.',
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
  .option('--platform <platform>', 'Initial adapter platform (MVP-3)')
  .action(async (options) => {
    const code = await init(process.cwd(), options);
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
    'Parent /man or /manteam workflow for mamba',
  )
  .option('--blocking-reason <reason>', 'Explain why a workflow is blocked')
  .option('--outcome <outcome>', 'Set mamba outcome')
  .option('--plan-version <n>', 'Set the next man/manteam plan revision')
  .option('--skipped <steps>', 'Update skipped steps as comma-separated values')
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
  .command('version')
  .description('Show version, node version, and platform')
  .action(() => {
    version();
  });

program.parse();

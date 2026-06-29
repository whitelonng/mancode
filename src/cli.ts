#!/usr/bin/env node
import { program } from 'commander';
import { init } from './commands/init.js';
import { install } from './commands/install.js';
import { refreshStyle } from './commands/refresh-style.js';
import { status } from './commands/status.js';
import { version } from './commands/version.js';
import { workflow } from './commands/workflow.js';
import { VERSION } from './version.js';

program
  .name('mancode')
  .description('AI coding agent harness. Five modes: practice to playoffs.')
  .version(VERSION);

program
  .command('init')
  .description(
    'Initialize mancode in the current project (MVP-1: Claude Code only)',
  )
  .option('--force', 'Reinstall even if already initialized')
  .option('--yes', 'Skip all confirmations (CI mode)')
  .option('--team', 'Force enable team mode (MVP-2)')
  .option('--no-team', 'Force disable team mode (MVP-2)')
  .option('--style <name>', 'Specify aesthetic style (MVP-2)')
  .action(async (options) => {
    const code = await init(process.cwd(), options);
    process.exitCode = code;
  });

program
  .command('install [platform]')
  .description('Install platform adapter (Claude Code supported)')
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
  .command('workflow <subcommand> [arg]')
  .description('Manage mancode workflows')
  .option('--dry-run', 'Preview clean without deleting')
  .option('--older-than <duration>', 'Clean workflows older than (e.g. 30d)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (subcommand, arg, options) => {
    const code = await workflow(
      process.cwd(),
      subcommand,
      arg ? [arg] : [],
      options,
    );
    process.exitCode = code;
  });

program
  .command('refresh-style')
  .description('Rescan project design tokens and update style-tokens.json')
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

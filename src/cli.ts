#!/usr/bin/env node
import { program } from 'commander';
import { init } from './commands/init.js';
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

// TODO(MVP-1): add `status`, `install` subcommands

program.parse();

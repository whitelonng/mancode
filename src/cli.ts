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
  .action(async () => {
    const code = await init();
    process.exitCode = code;
  });

// TODO(MVP-1): add `status`, `install` subcommands

program.parse();

#!/usr/bin/env node
import { program } from 'commander';
import { VERSION } from './version.js';

program
  .name('mancode')
  .description('AI coding agent harness. Five modes: practice to playoffs.')
  .version(VERSION);

// TODO(MVP-1): add `init`, `status`, `install` subcommands

program.parse();

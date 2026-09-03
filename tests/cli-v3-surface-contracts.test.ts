import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { WORKFLOW_SUBCOMMANDS } from '../src/commands/workflow-subcommands.js';

describe('V3 CLI command surface', () => {
  it('registers coordination, migration, recovery, and explicit-sync commands', async () => {
    const parse = vi.spyOn(Command.prototype, 'parse');
    try {
      const { createCliProgram } = await import('../src/cli.js');
      expect(parse).not.toHaveBeenCalled();

      const cliProgram = createCliProgram();
      const secondProgram = createCliProgram();
      expect(secondProgram).not.toBe(cliProgram);
      expect(secondProgram.commands).not.toBe(cliProgram.commands);

      expect(cliProgram.commands.map((command) => command.name())).toEqual(
        expect.arrayContaining([
          'init',
          'workflow',
          'context',
          'operation',
          'team',
          'migrate',
          'adapter',
          'design',
        ]),
      );
      expect(commandAt(cliProgram, 'context', 'session', 'new')).toBeDefined();
      expect(commandAt(cliProgram, 'context', 'session', 'show')).toBeDefined();
      expect(
        requiredOptions(commandAt(cliProgram, 'context', 'session', 'show')),
      ).toEqual(['--session']);
      expect(
        commandAt(cliProgram, 'context', 'session', 'spike'),
      ).toBeDefined();
      expect(commandAt(cliProgram, 'context', 'glossary')).toBeDefined();
      expect(
        requiredOptions(commandAt(cliProgram, 'context', 'glossary')),
      ).toEqual([]);
      expect(
        commandAt(cliProgram, 'context', 'glossary').helpInformation(),
      ).toContain('--expected-revision');
      expect(commandAt(cliProgram, 'operation', 'repair')).toBeDefined();
      expect(
        commandAt(cliProgram, 'operation', 'repair').helpInformation(),
      ).toContain('--replacement-checkpoint-id');
      expect(commandAt(cliProgram, 'operation', 'abort')).toBeDefined();
      expect(commandAt(cliProgram, 'adapter', 'status')).toBeDefined();
      expect(commandAt(cliProgram, 'adapter', 'upgrade')).toBeDefined();
      expect(commandAt(cliProgram, 'design', 'status')).toBeDefined();
      expect(commandAt(cliProgram, 'design', 'context')).toBeDefined();
      expect(
        requiredOptions(commandAt(cliProgram, 'design', 'configure')),
      ).toEqual(['--expected-revision']);
      expect(
        requiredOptions(commandAt(cliProgram, 'design', 'disable')),
      ).toEqual(['--expected-revision']);
      expect(commandAt(cliProgram, 'team', 'sync', 'pull')).toBeDefined();
      expect(commandAt(cliProgram, 'team', 'sync', 'push')).toBeDefined();
      expect(commandAt(cliProgram, 'team', 'handoff', 'accept')).toBeDefined();
      expect(
        commandAt(cliProgram, 'migrate', 'context', 'resolve'),
      ).toBeDefined();

      expect(
        requiredOptions(commandAt(cliProgram, 'team', 'transport', 'migrate')),
      ).toEqual(['--to', '--expected-config-revision']);
      expect(
        requiredOptions(commandAt(cliProgram, 'team', 'sync', 'push')),
      ).toEqual(['--expected-task-revision']);
      expect(requiredOptions(commandAt(cliProgram, 'team', 'claim'))).toEqual([
        '--expected-task-revision',
      ]);
      expect(
        requiredOptions(commandAt(cliProgram, 'context', 'session', 'spike')),
      ).toEqual([
        '--platform',
        '--session-mode',
        '--host-session-source',
        '--command-propagation',
        '--subagent-inheritance',
        '--host-version',
        '--release-candidate',
      ]);
      expect(requiredOptions(commandAt(cliProgram, 'context', 'beta'))).toEqual(
        ['--release-candidate'],
      );
      expect(commandAt(cliProgram, 'init').helpInformation()).not.toContain(
        '--v3',
      );
      expect(
        optionDescription(commandAt(cliProgram, 'init'), '--style'),
      ).toContain('only supported with mancode init --legacy');
      expect(
        optionDescription(commandAt(cliProgram, 'install'), '--minimal'),
      ).toContain('Continuity bootstrap is already minimal');
      expect(commandAt(cliProgram, 'context').helpInformation()).not.toMatch(
        /\bbeta\b/i,
      );
      expect(renderedHelp(commandAt(cliProgram, 'workflow'))).toContain(
        WORKFLOW_SUBCOMMANDS.join(', '),
      );
      expect(WORKFLOW_SUBCOMMANDS).toEqual(
        expect.arrayContaining(['update', 'archive']),
      );
      expect(publicHelpText(cliProgram).join('\n')).not.toMatch(/\bV3\b/);
    } finally {
      parse.mockRestore();
    }
  });
});

function commandAt(root: Command, ...path: string[]): Command {
  let current = root;
  for (const name of path) {
    const next = current.commands.find((command) => command.name() === name);
    if (next === undefined)
      throw new Error(`missing CLI command: ${path.join(' ')}`);
    current = next;
  }
  return current;
}

function requiredOptions(command: Command): string[] {
  return command.options
    .filter((option) => option.mandatory)
    .map((option) => option.long)
    .filter((option): option is string => option !== undefined);
}

function optionDescription(command: Command, name: string): string {
  const option = command.options.find((candidate) => candidate.long === name);
  if (option === undefined) throw new Error(`missing CLI option: ${name}`);
  return option.description;
}

function renderedHelp(command: Command): string {
  let output = '';
  command.configureOutput({
    writeOut: (value) => {
      output += value;
    },
  });
  command.outputHelp();
  return output;
}

function publicHelpText(command: Command): string[] {
  return [
    command.description(),
    ...command.options.map((option) => option.description),
    ...command.commands.flatMap((child) => publicHelpText(child)),
  ];
}

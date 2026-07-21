import type { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

describe('V3 CLI command surface', () => {
  it('registers coordination, migration, recovery, and explicit-sync commands', async () => {
    const originalArgv = process.argv;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.argv = ['node', 'mancode', 'version'];
    try {
      const { cliProgram } = await import('../src/cli.js');

      expect(cliProgram.commands.map((command) => command.name())).toEqual(
        expect.arrayContaining([
          'init',
          'workflow',
          'context',
          'operation',
          'team',
          'migrate',
          'adapter',
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
      expect(commandAt(cliProgram, 'operation', 'repair')).toBeDefined();
      expect(commandAt(cliProgram, 'operation', 'abort')).toBeDefined();
      expect(commandAt(cliProgram, 'adapter', 'status')).toBeDefined();
      expect(commandAt(cliProgram, 'adapter', 'upgrade')).toBeDefined();
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
      expect(commandAt(cliProgram, 'context').helpInformation()).not.toMatch(
        /\bbeta\b/i,
      );
      expect(publicHelpText(cliProgram).join('\n')).not.toMatch(/\bV3\b/);
    } finally {
      process.argv = originalArgv;
      log.mockRestore();
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

function publicHelpText(command: Command): string[] {
  return [
    command.description(),
    ...command.options.map((option) => option.description),
    ...command.commands.flatMap((child) => publicHelpText(child)),
  ];
}

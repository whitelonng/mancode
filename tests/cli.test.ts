import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { VERSION } from '../src/version.js';

// Explicit candidate build prevents a test from invoking the installed governance CLI.
const binary = process.env.MANCODE_CLI_BINARY;
it.runIf(Boolean(binary))(
  'collects review inventory through the compiled CLI without initializing authority',
  async () => {
    if (!binary)
      throw new Error('MANCODE_CLI_BINARY must name the compiled candidate');
    const root = await mkdtemp(path.join(tmpdir(), 'mancode-review-cli-'));
    const exec = promisify(execFile);
    try {
      await exec('git', ['init', '--quiet'], { cwd: root });
      await exec(
        'git',
        [
          '-c',
          'user.name=Review fixture',
          '-c',
          'user.email=review@example.invalid',
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          'base',
        ],
        { cwd: root },
      );
      await writeFile(path.join(root, 'pending.txt'), 'untracked change');
      const result = await exec(
        process.execPath,
        [binary, 'review', 'inspect', '--base', 'HEAD', '--json'],
        { cwd: root },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: 'review_inventory',
        reviewStatus: 'not_reviewed',
        files: [{ path: 'pending.txt', status: 'untracked' }],
      });
      await expect(
        exec(
          process.execPath,
          [binary, 'review', 'inspect', '--base', 'missing-base', '--json'],
          { cwd: root },
        ),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        exec(process.execPath, [binary, 'review', 'inspect', '--json'], {
          cwd: root,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect((await readdir(root)).sort()).toEqual(['.git', 'pending.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.runIf(Boolean(binary))(
  'parses context read digest options without intercepting them as the root version flag',
  async () => {
    if (!binary)
      throw new Error('MANCODE_CLI_BINARY must name the compiled candidate');
    const root = await mkdtemp(path.join(tmpdir(), 'mancode-cli-version-'));
    const run = async (args: string[]) => {
      try {
        const result = await promisify(execFile)(
          process.execPath,
          [binary, ...args],
          { cwd: root, timeout: 15000 },
        );
        return { ...result, code: 0 };
      } catch (error) {
        const result = error as {
          stdout: string;
          stderr: string;
          code: number;
        };
        return result;
      }
    };
    const json = async (args: string[]) => {
      const result = await run(args);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    try {
      await initializeV3Project({ projectRoot: root });
      for (const option of ['--version', '-V'])
        expect((await run([option])).stdout.trim()).toBe(VERSION);
      expect((await run(['version'])).stdout).toContain(`mancode/${VERSION}`);
      await json([
        'team',
        'identity',
        'create',
        '--name',
        'CLI fixture',
        '--json',
      ]);
      const session = (
        await json([
          'context',
          'session',
          'new',
          '--client',
          'vitest',
          '--json',
        ])
      ).session.sessionId;
      const created = await json([
        'workflow',
        'create',
        'man',
        'Version argument fixture',
        '--session',
        session,
        '--client',
        'vitest',
        '--json',
      ]);
      const ref = `${created.taskRef.namespace}:${created.taskRef.taskId}`;
      const index = await json(['context', 'index', '--task', ref, '--json']);
      const entry = index.entries.find(
        (item: { kind: string }) => item.kind === 'requirements',
      );
      expect(entry).toBeDefined();
      const space = await json([
        'context',
        'read',
        entry.ref,
        '--version',
        entry.version,
        '--json',
      ]);
      const equals = await json([
        'context',
        'read',
        entry.ref,
        `--version=${entry.version}`,
        '--json',
      ]);
      expect(space.format).toBe('context-index-v1');
      expect(space.content).toContain('schemaVersion');
      expect(space.content).toBe(equals.content);
      for (const option of [
        ['--version', `sha256:${'0'.repeat(64)}`],
        [`--version=sha256:${'0'.repeat(64)}`],
      ]) {
        const stale = await run([
          'context',
          'read',
          entry.ref,
          ...option,
          '--json',
        ]);
        expect(stale.code).not.toBe(0);
        expect(JSON.parse(stale.stdout).status).toBe('stale');
        expect(JSON.parse(stale.stdout).content).toBeUndefined();
      }
      expect(
        (await json(['workflow', 'list', '--json'])).workflows,
      ).toHaveLength(1);
      expect((await run(['context', 'read', '--help'])).stdout).toContain(
        '--version <digest>',
      );
      console.log(
        JSON.stringify({
          binary,
          spaceStatus: space.status,
          equalsStatus: equals.status,
          staleSyntaxes: 2,
          rootVersionForms: 3,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';

// Explicit build boundary: run this integration contract against a candidate CLI,
// never accidentally against the installed governance binary.
const binary = process.env.MANCODE_PROGRESS_CLI_BINARY;
it.runIf(Boolean(binary))(
  'reflects two real CLI task mutations in preview and offline HTML within three seconds',
  async () => {
    if (!binary) throw new Error('candidate CLI path required');
    const root = await mkdtemp(path.join(tmpdir(), 'mancode-progress-cli-'));
    let preview: ChildProcess | undefined;
    const commands: string[][] = [];
    const cli = async (...args: string[]) => {
      commands.push(args);
      const result = await promisify(execFile)(
        process.execPath,
        [binary, ...args],
        {
          cwd: root,
          env: process.env,
          timeout: 15000,
        },
      );
      return JSON.parse(result.stdout);
    };
    try {
      await initializeV3Project({ projectRoot: root });
      await cli(
        'team',
        'identity',
        'create',
        '--name',
        'Progress CLI fixture',
        '--json',
      );
      const session = (
        await cli('context', 'session', 'new', '--client', 'vitest', '--json')
      ).session.sessionId;
      const auth = ['--session', session, '--client', 'vitest', '--json'];
      await cli('progress', 'init', '--json');
      const tasks = [];
      for (const title of ['Preview event A', 'Preview event B']) {
        const created = await cli('workflow', 'create', 'man', title, ...auth);
        tasks.push({
          ref: `${created.taskRef.namespace}:${created.taskRef.taskId}`,
          revision: created.metadata.revision,
        });
      }
      preview = spawn(
        process.execPath,
        [binary, 'progress', 'preview', '--json'],
        { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const url = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(
          () => reject(new Error('preview startup timeout')),
          10000,
        );
        preview?.stdout?.on('data', (chunk) => {
          output += chunk.toString();
          if (!output.includes('\n')) return;
          try {
            const value = JSON.parse(output.trim());
            clearTimeout(timeout);
            resolve(value.url);
          } catch {
            /* Wait for the complete JSON line. */
          }
        });
        preview?.once('error', reject);
        preview?.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`preview exited ${code}: ${output}`));
        });
      });
      expect(
        (await fetch(`${url}/api/version`).then((r) => r.json())).stale,
      ).toBe(false);
      const measurements = [];
      for (const [index, task] of tasks.entries()) {
        const started = performance.now();
        const status = index === 0 ? 'blocked' : 'abandoned';
        const reason =
          index === 0 ? ['--blocking-reason', 'Await fixture dependency'] : [];
        await cli(
          'workflow',
          'update',
          task.ref,
          '--status',
          status,
          '--expected-revision',
          String(task.revision),
          ...reason,
          ...auth,
        );
        const committed = performance.now();
        const expected = index === 0 ? '已暂停' : '已放弃';
        const html = await readFile(path.join(root, '项目进度.html'), 'utf8');
        const snapshot = JSON.parse(
          /id="mancode-progress-data">([\s\S]*?)<\/script>/.exec(html)?.[1] ??
            'null',
        );
        expect(
          snapshot.tasks.find((item: { id: string }) => item.id === task.ref)
            .state,
        ).toBe(expected);
        let observed = false;
        while (performance.now() - committed < 3000) {
          // Match the template's default polling period; no model/Agent polling.
          await delay(1500);
          const version = await fetch(`${url}/api/version`).then((r) =>
            r.json(),
          );
          if (version.stale) continue;
          const response = await fetch(
            `${url}/api/data?version=${version.version}`,
          );
          if (!response.ok) continue;
          const data = await response.json();
          if (
            data.tasks.find((item: { id: string }) => item.id === task.ref)
              ?.state === expected
          ) {
            observed = true;
            break;
          }
        }
        const updateMs = Math.round(performance.now() - committed);
        measurements.push({
          task: task.ref,
          state: expected,
          commandMs: Math.round(committed - started),
          updateMs,
        });
        expect(observed).toBe(true);
        expect(updateMs).toBeLessThan(3000);
      }
      console.log(JSON.stringify({ root, binary, commands, measurements }));
    } finally {
      if (preview && preview.exitCode === null) {
        const exited = once(preview, 'exit');
        preview.kill('SIGTERM');
        await exited;
      }
      if (process.env.MANCODE_KEEP_PROGRESS_FIXTURE !== '1')
        await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);

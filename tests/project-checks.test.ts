import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const temporaryRoots: string[] = [];
const qualitySteps = [
  'run lint',
  'run typecheck',
  'run build',
  'run test:dist',
  'audit --audit-level=high',
  'run test:coverage',
];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), 'mancode project checks ')),
  );
  temporaryRoots.push(directory);
  await mkdir(path.join(directory, 'scripts'));
  const script = path.join(directory, 'scripts', 'project-checks.mjs');
  await copyFile(path.join(root, 'scripts', 'project-checks.mjs'), script);
  const npmCli = path.join(directory, 'npm entry.mjs');
  const trace = path.join(directory, 'trace.jsonl');
  await writeFile(
    npmCli,
    `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const step = process.argv.slice(2).join(' ');
appendFileSync(process.env.CHECK_TRACE, JSON.stringify({ step, cwd: process.cwd(), cli: process.env.MANCODE_CLI_BINARY, progressCli: process.env.MANCODE_PROGRESS_CLI_BINARY }) + '\\n');
console.log('step output: ' + step);
if (step === process.env.FAIL_STEP) { console.error('fixture failure: ' + step); process.exit(7); }
if (step === 'run build') {
  mkdirSync('dist', { recursive: true });
  writeFileSync(path.join('dist', 'cli.js'), 'fresh build');
}
if (step === 'run test:coverage' || step === 'run test:dist') {
  for (const key of ['MANCODE_CLI_BINARY', 'MANCODE_PROGRESS_CLI_BINARY']) {
    if (readFileSync(process.env[key], 'utf8') !== 'fresh build') process.exit(9);
  }
}
`,
  );
  const env = {
    ...process.env,
    npm_execpath: npmCli,
    CHECK_TRACE: trace,
    MANCODE_CLI_BINARY: '/stale/cli.js',
    MANCODE_PROGRESS_CLI_BINARY: '/stale/progress.js',
  };
  return {
    directory,
    trace,
    run: (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: tmpdir(),
        env: { ...env, ...overrides },
        encoding: 'utf8',
      }),
    readTrace: async () =>
      (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              step: string;
              cwd: string;
              cli: string;
              progressCli: string;
            },
        ),
  };
}

describe('shared project checks', () => {
  it('runs the complete ordered quality gate against freshly built CLI paths, outside the caller cwd', async () => {
    const project = await fixture();
    const result = project.run(['quality']);
    expect(result.status, result.stderr).toBe(0);
    const trace = await project.readTrace();
    expect(trace.map((entry) => entry.step)).toEqual(qualitySteps);
    for (const entry of trace) {
      expect(entry.cwd).toBe(project.directory);
      expect(entry.cli).toBe(path.join(project.directory, 'dist', 'cli.js'));
      expect(entry.progressCli).toBe(entry.cli);
    }
    expect(result.stdout).toContain('step output: run test:coverage');
  });

  it.each(qualitySteps)(
    'propagates failure of %s and never runs a later check',
    async (step) => {
      const project = await fixture();
      const result = project.run(['quality'], { FAIL_STEP: step });
      expect(result.status).toBe(7);
      expect(result.stderr).toContain(`fixture failure: ${step}`);
      expect(result.stderr).toContain(`Project check failed: npm ${step}`);
      expect((await project.readTrace()).map((entry) => entry.step)).toEqual(
        qualitySteps.slice(0, qualitySteps.indexOf(step) + 1),
      );
    },
  );

  it('keeps all Windows lock tests after a fresh build', async () => {
    const project = await fixture();
    const result = project.run(['windows']);
    expect(result.status, result.stderr).toBe(0);
    expect((await project.readTrace()).map((entry) => entry.step)).toEqual([
      'run build',
      'exec -- vitest run tests/local-lock.test.ts tests/local-lock-crash.test.ts tests/entity-home-store-contracts.test.ts',
    ]);
  });

  it('rejects an unknown profile or missing npm launcher without executing checks', async () => {
    const project = await fixture();
    expect(project.run(['not-a-profile']).status).toBe(1);
    const missing = project.run(['quality'], { npm_execpath: '' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('through npm run check');
    await expect(readFile(project.trace)).rejects.toThrow();
  });

  it('fails visibly if the npm process cannot run', async () => {
    const project = await fixture();
    const result = project.run(['quality'], {
      npm_execpath: path.join(project.directory, 'missing.mjs'),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Project check failed: npm run lint');
    await expect(readFile(project.trace)).rejects.toThrow();
  });

  it('aligns npm, CI and publish entry points without shrinking the platform matrix', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.check).toBe(
      'node scripts/project-checks.mjs quality',
    );
    expect(packageJson.scripts['check:windows']).toBe(
      'node scripts/project-checks.mjs windows',
    );
    expect(packageJson.scripts.prepublishOnly).toBe('npm run check');
    const quality = await readFile(
      path.join(root, '.github', 'workflows', 'quality.yml'),
      'utf8',
    );
    expect(quality).toContain('node-version: [22, 24]');
    expect(quality).toContain('runs-on: ubuntu-latest');
    expect(quality).toContain('run: npm run check');
    const windows = await readFile(
      path.join(root, '.github', 'workflows', 'windows-smoke.yml'),
      'utf8',
    );
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).toContain('node-version: 22');
    expect(windows).toContain('run: npm run check:windows');
    for (const shell of ['cmd', 'powershell', 'bash']) {
      expect(windows).toContain(
        `shell: ${shell}\n        run: npm run test:windows-smoke`,
      );
    }
  });
});

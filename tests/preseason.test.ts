import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_INVALID_ARG,
  EXIT_NOT_INITIALIZED,
  EXIT_OK,
  manps,
} from '../src/commands/manps.js';
import { runPreseasonScan } from '../src/system/preseason.js';

describe('preseason scan', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-preseason-'));
    await mkdir(path.join(dir, '.mancode'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('generates a report with actionable issues', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc' },
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'src', 'auth.ts'),
      'export const token = "#ff0000"; // TODO: replace hardcoded token\n',
      'utf-8',
    );

    const report = await runPreseasonScan(dir);

    expect(report.issues.length).toBeGreaterThanOrEqual(3);
    expect(report.issues.some((issue) => issue.id === 'scripts-test')).toBe(
      true,
    );
    expect(report.issues.some((issue) => issue.type === 'dependency')).toBe(
      true,
    );
    const content = await readFile(report.reportPath, 'utf-8');
    expect(content).toContain('mancode preseason report');
    expect(content).toContain('P1: Should Fix Soon');
    await expect(
      readFile(path.join(dir, '.mancode', 'preseason-report.md'), 'utf-8'),
    ).resolves.toContain('mancode preseason report');
    const issueDb = JSON.parse(await readFile(report.issueDbPath, 'utf-8'));
    expect(issueDb.version).toBe('1.0.0');
    expect(issueDb.latestRunId).toBeTruthy();
    expect(issueDb.runs).toHaveLength(1);
    expect(issueDb.runs[0].area).toBe('all');
    expect(issueDb.issues.length).toBe(report.issues.length);
    expect(issueDb.issues[0]).toMatchObject({
      status: 'open',
      firstSeen: report.generatedAt,
      lastSeen: report.generatedAt,
      occurrences: 1,
    });
  });

  it('filters issues by area', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest' },
        dependencies: {
          moment: '^2.30.0',
          dayjs: '^1.11.0',
          request: '^2.88.0',
        },
      }),
      'utf-8',
    );
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'src', 'auth.ts'),
      '// TODO: add tests\nexport const x = 1;\n',
      'utf-8',
    );

    const deps = await runPreseasonScan(dir, 'deps');
    const security = await runPreseasonScan(dir, 'security');
    const deadCode = await runPreseasonScan(dir, 'dead-code');

    expect(deps.issues.every((issue) => issue.type === 'dependency')).toBe(
      true,
    );
    expect(security.issues.every((issue) => issue.type === 'security')).toBe(
      true,
    );
    expect(
      deadCode.issues.every(
        (issue) => issue.type === 'todo' || issue.type === 'tests',
      ),
    ).toBe(true);
  });

  it('rejects unknown areas instead of silently running a full scan', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );

    const code = await manps(dir, 'securityy');

    expect(code).toBe(EXIT_INVALID_ARG);
  });

  it('does not read source files for deps-only scans', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'src', 'legacy.ts'),
      '// TODO: this should not appear in deps scan\n',
      'utf-8',
    );

    const report = await runPreseasonScan(dir, 'deps');

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.type).toBe('dependency');
  });

  it('does not overwrite reports generated on the same day for the same area', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );

    const deps = await runPreseasonScan(dir, 'deps');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondDeps = await runPreseasonScan(dir, 'deps');

    expect(path.basename(deps.reportPath)).not.toBe(
      path.basename(secondDeps.reportPath),
    );
    await expect(readFile(deps.reportPath, 'utf-8')).resolves.toContain(
      'Area: deps',
    );
    await expect(readFile(secondDeps.reportPath, 'utf-8')).resolves.toContain(
      'Area: deps',
    );
  });

  it('tracks issue history across preseason scans', async () => {
    const packagePath = path.join(dir, 'package.json');
    await writeFile(
      packagePath,
      JSON.stringify({
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );

    const first = await runPreseasonScan(dir, 'deps');
    const second = await runPreseasonScan(dir, 'deps');

    const issueDb = JSON.parse(await readFile(second.issueDbPath, 'utf-8'));
    expect(issueDb.runs).toHaveLength(2);
    expect(issueDb.runs[0].issueKeys).toEqual(issueDb.runs[1].issueKeys);
    expect(issueDb.issues).toHaveLength(1);
    expect(issueDb.issues[0]).toMatchObject({
      key: issueDb.runs[0].issueKeys[0],
      status: 'open',
      firstSeen: first.generatedAt,
      lastSeen: second.generatedAt,
      lastArea: 'deps',
      occurrences: 2,
    });
    expect(issueDb.issues[0].sourceReports).toHaveLength(2);
  });

  it('marks previously open issues as not-found when a later scan no longer sees them', async () => {
    const packagePath = path.join(dir, 'package.json');
    await writeFile(
      packagePath,
      JSON.stringify({
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );
    const first = await runPreseasonScan(dir, 'deps');

    await writeFile(packagePath, JSON.stringify({ dependencies: {} }), 'utf-8');
    const second = await runPreseasonScan(dir, 'deps');

    const issueDb = JSON.parse(await readFile(second.issueDbPath, 'utf-8'));
    expect(issueDb.runs).toHaveLength(2);
    expect(issueDb.runs[1].issueKeys).toEqual([]);
    expect(issueDb.issues).toHaveLength(1);
    expect(issueDb.issues[0]).toMatchObject({
      key: issueDb.runs[0].issueKeys[0],
      status: 'not-found',
      firstSeen: first.generatedAt,
      lastSeen: first.generatedAt,
      occurrences: 1,
    });
  });

  it('does not mark issues from other areas as not-found during scoped scans', async () => {
    const packagePath = path.join(dir, 'package.json');
    await writeFile(
      packagePath,
      JSON.stringify({
        dependencies: {
          moment: '^2.30.0',
          dayjs: '^1.11.0',
          request: '^2.88.0',
        },
      }),
      'utf-8',
    );

    const security = await runPreseasonScan(dir, 'security');
    const deps = await runPreseasonScan(dir, 'deps');

    let issueDb = JSON.parse(await readFile(deps.issueDbPath, 'utf-8'));
    const securityIssue = issueDb.issues.find(
      (issue: { type: string }) => issue.type === 'security',
    );
    const dependencyIssue = issueDb.issues.find(
      (issue: { type: string }) => issue.type === 'dependency',
    );
    expect(securityIssue).toMatchObject({
      key: issueDb.runs[0].issueKeys[0],
      status: 'open',
      firstSeen: security.generatedAt,
      lastSeen: security.generatedAt,
      occurrences: 1,
    });
    expect(dependencyIssue).toMatchObject({
      key: issueDb.runs[1].issueKeys[0],
      status: 'open',
      firstSeen: deps.generatedAt,
      lastSeen: deps.generatedAt,
      occurrences: 1,
    });

    await writeFile(
      packagePath,
      JSON.stringify({
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );
    const secondSecurity = await runPreseasonScan(dir, 'security');
    issueDb = JSON.parse(await readFile(secondSecurity.issueDbPath, 'utf-8'));

    expect(
      issueDb.issues.find(
        (issue: { type: string }) => issue.type === 'security',
      ),
    ).toMatchObject({ status: 'not-found', occurrences: 1 });
    expect(
      issueDb.issues.find(
        (issue: { type: string }) => issue.type === 'dependency',
      ),
    ).toMatchObject({ status: 'open', occurrences: 1 });
  });

  it('does not flag CSS variable definitions as hardcoded color drift', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'biome check' } }),
      'utf-8',
    );
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'src', 'globals.css'),
      ':root {\n  --primary: #111111;\n}\n',
      'utf-8',
    );

    const report = await runPreseasonScan(dir, 'all');

    expect(report.issues.some((issue) => issue.type === 'aesthetics')).toBe(
      false,
    );
  });

  it('manps command requires initialization', async () => {
    const uninitialized = await mkdtemp(
      path.join(tmpdir(), 'mancode-preseason-empty-'),
    );
    try {
      const code = await manps(uninitialized);
      expect(code).toBe(EXIT_NOT_INITIALIZED);
    } finally {
      await rm(uninitialized, { recursive: true, force: true });
    }
  });

  it('manps command runs scan for initialized projects', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'biome check' } }),
      'utf-8',
    );

    const code = await manps(dir, 'deps');

    expect(code).toBe(EXIT_OK);
    await expect(
      readFile(path.join(dir, '.mancode', 'preseason-report.md'), 'utf-8'),
    ).resolves.toContain('Area: deps');
  });

  it('records accepted remediation decisions after showing issue files', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );

    const code = await manps(dir, 'deps', {
      remediate: true,
      answers: ['show files', 'y'],
    });

    expect(code).toBe(EXIT_OK);
    const issueDb = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'preseason-issues.json'),
        'utf-8',
      ),
    );
    expect(issueDb.issues[0]).toMatchObject({
      status: 'open',
      remediation: {
        status: 'accepted',
        applied: false,
        sourceRunId: issueDb.latestRunId,
        response: 'y',
      },
    });
  });

  it('applies safe remediation for missing config files', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest', lint: 'biome check', build: 'tsc' },
      }),
      'utf-8',
    );

    const code = await manps(dir, 'config', {
      remediate: true,
      answers: ['y', 'y'],
    });

    expect(code).toBe(EXIT_OK);
    await expect(
      readFile(path.join(dir, '.gitignore'), 'utf-8'),
    ).resolves.toContain('node_modules/');
    await expect(
      readFile(path.join(dir, '.editorconfig'), 'utf-8'),
    ).resolves.toContain('root = true');
    const issueDb = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'preseason-issues.json'),
        'utf-8',
      ),
    );
    const gitignoreIssue = issueDb.issues.find(
      (issue: { id: string }) => issue.id === 'config-gitignore',
    );
    expect(gitignoreIssue).toMatchObject({
      status: 'fixed',
      remediation: {
        status: 'accepted',
        applied: true,
        action: 'created .gitignore',
      },
    });
    const editorconfigIssue = issueDb.issues.find(
      (issue: { id: string }) => issue.id === 'config-editorconfig',
    );
    expect(editorconfigIssue).toMatchObject({
      status: 'fixed',
      remediation: {
        status: 'accepted',
        applied: true,
        action: 'created .editorconfig',
      },
    });
  });

  it('applies safe remediation for missing package scripts when matching tools exist', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    await writeFile(path.join(dir, '.editorconfig'), 'root = true\n', 'utf-8');
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        devDependencies: {
          '@biomejs/biome': '^2.0.0',
          typescript: '^5.0.0',
          vitest: '^3.0.0',
        },
      }),
      'utf-8',
    );

    const code = await manps(dir, 'config', {
      remediate: true,
      answers: ['y', 'y', 'y'],
    });

    expect(code).toBe(EXIT_OK);
    const pkg = JSON.parse(
      await readFile(path.join(dir, 'package.json'), 'utf-8'),
    );
    expect(pkg.scripts).toEqual({
      test: 'vitest run',
      lint: 'biome check .',
      build: 'tsc',
    });

    const issueDb = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'preseason-issues.json'),
        'utf-8',
      ),
    );
    expect(
      issueDb.issues.filter(
        (issue: { type: string; status: string }) =>
          issue.type === 'scripts' && issue.status === 'fixed',
      ),
    ).toHaveLength(3);
    expect(
      issueDb.issues.map(
        (issue: { remediation?: { action?: string } }) =>
          issue.remediation?.action,
      ),
    ).toEqual(
      expect.arrayContaining([
        'added npm test script',
        'added npm lint script',
        'added npm build script',
      ]),
    );
  });

  it('does not add package scripts when no matching tool dependency exists', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    await writeFile(path.join(dir, '.editorconfig'), 'root = true\n', 'utf-8');
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({}),
      'utf-8',
    );

    const code = await manps(dir, 'config', {
      remediate: true,
      answers: ['y', 'y', 'y'],
    });

    expect(code).toBe(EXIT_OK);
    const pkg = JSON.parse(
      await readFile(path.join(dir, 'package.json'), 'utf-8'),
    );
    expect(pkg.scripts).toBeUndefined();

    const issueDb = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'preseason-issues.json'),
        'utf-8',
      ),
    );
    expect(
      issueDb.issues.filter(
        (issue: { type: string; status: string }) =>
          issue.type === 'scripts' && issue.status === 'open',
      ),
    ).toHaveLength(3);
    expect(
      issueDb.issues.every(
        (issue: { remediation?: { applied?: boolean } }) =>
          issue.remediation?.applied === false,
      ),
    ).toBe(true);
  });

  it('prefers framework build scripts over plain TypeScript builds', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    await writeFile(path.join(dir, '.editorconfig'), 'root = true\n', 'utf-8');
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest run', lint: 'biome check .' },
        devDependencies: {
          typescript: '^5.0.0',
          vite: '^7.0.0',
          vitest: '^3.0.0',
        },
      }),
      'utf-8',
    );

    const code = await manps(dir, 'config', {
      remediate: true,
      answers: ['y'],
    });

    expect(code).toBe(EXIT_OK);
    const pkg = JSON.parse(
      await readFile(path.join(dir, 'package.json'), 'utf-8'),
    );
    expect(pkg.scripts.build).toBe('vite build');
  });

  it('records skipped remediation decisions without changing issue status', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );

    const code = await manps(dir, 'deps', {
      remediate: true,
      answers: ['skip'],
    });

    expect(code).toBe(EXIT_OK);
    const issueDb = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'preseason-issues.json'),
        'utf-8',
      ),
    );
    expect(issueDb.issues[0]).toMatchObject({
      status: 'open',
      remediation: {
        status: 'skipped',
        sourceRunId: issueDb.latestRunId,
        response: 'skip',
      },
    });
  });

  it('keeps json remediation output parseable', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      const code = await manps(dir, 'deps', {
        json: true,
        remediate: true,
        answers: ['y'],
      });

      expect(code).toBe(EXIT_OK);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.remediation).toMatchObject({
      reviewed: 1,
      accepted: 1,
      skipped: 0,
    });
  });

  it('rejects remediation when scripted answers run out', async () => {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      JSON.stringify({ currentMode: 'solo' }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: {},
        dependencies: { moment: '^2.30.0', dayjs: '^1.11.0' },
      }),
      'utf-8',
    );

    const code = await manps(dir, 'all', {
      remediate: true,
      answers: ['y'],
    });

    expect(code).toBe(EXIT_INVALID_ARG);
    await expect(
      readFile(path.join(dir, '.gitignore'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, '.editorconfig'), 'utf-8'),
    ).rejects.toThrow();
    const issueDb = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'preseason-issues.json'),
        'utf-8',
      ),
    );
    expect(
      issueDb.issues.filter(
        (issue: { remediation?: unknown }) => issue.remediation,
      ),
    ).toHaveLength(0);
  });
});

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
});

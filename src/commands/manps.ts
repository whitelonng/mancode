import { access } from 'node:fs/promises';
import path from 'node:path';
import { type PreseasonReport, runPreseasonScan } from '../system/preseason.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_SCAN_FAILED = 2;
export const EXIT_INVALID_ARG = 3;

export interface ManpsOptions {
  json?: boolean;
}

export async function manps(
  rootDir: string,
  area = 'all',
  options: ManpsOptions = {},
): Promise<number> {
  if (!(await pathExists(path.join(rootDir, '.mancode', 'state.json')))) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'not initialized' }, null, 2));
    } else {
      console.error('✗  mancode not initialized.');
      console.error('   Run `mancode init` first.');
    }
    return EXIT_NOT_INITIALIZED;
  }

  let report: PreseasonReport;
  try {
    report = await runPreseasonScan(rootDir, area);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const invalidArg = message.startsWith('invalid area:');
    if (options.json) {
      console.log(
        JSON.stringify(
          { error: invalidArg ? 'invalid argument' : 'scan failed', message },
          null,
          2,
        ),
      );
    } else {
      console.error(
        invalidArg
          ? '✗  Invalid manps area.'
          : '✗  mancode preseason scan failed.',
      );
      console.error(`   ${message}`);
    }
    return invalidArg ? EXIT_INVALID_ARG : EXIT_SCAN_FAILED;
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return EXIT_OK;
  }

  const p0 = report.issues.filter((issue) => issue.severity === 'P0').length;
  const p1 = report.issues.filter((issue) => issue.severity === 'P1').length;
  const p2 = report.issues.filter((issue) => issue.severity === 'P2').length;
  console.log('mancode preseason scan');
  console.log('');
  console.log(`Area:     ${report.area}`);
  console.log(
    `Issues:   ${report.issues.length} total (P0 ${p0}, P1 ${p1}, P2 ${p2})`,
  );
  console.log(`Report:   ${path.relative(rootDir, report.reportPath)}`);
  console.log(`Issue DB: ${path.relative(rootDir, report.issueDbPath)}`);
  if (report.issues.length > 0) {
    console.log('');
    for (const issue of report.issues.slice(0, 7)) {
      const file = issue.file ? ` (${issue.file})` : '';
      console.log(`- ${issue.severity} ${issue.id}: ${issue.title}${file}`);
    }
  }
  return EXIT_OK;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

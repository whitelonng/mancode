import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseSchemaManifest } from '../context/manifest.js';
import {
  type PreseasonRemediationResult,
  type PreseasonReport,
  runPreseasonRemediation,
  runPreseasonScan,
} from '../system/preseason.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_SCAN_FAILED = 2;
export const EXIT_INVALID_ARG = 3;

export interface ManpsOptions {
  json?: boolean;
  remediate?: boolean;
  answers?: string[];
}

export async function manps(
  rootDir: string,
  area = 'all',
  options: ManpsOptions = {},
): Promise<number> {
  const v3SchemaPath = path.join(rootDir, '.mancode', 'schema.json');
  const v3Activation = await readV3ActivationState(v3SchemaPath);
  if (
    v3Activation !== null &&
    v3Activation !== 'v3_active' &&
    v3Activation !== 'dual_read'
  ) {
    const message = `manps is unavailable while mancode activation is ${v3Activation}`;
    if (options.json) {
      console.log(JSON.stringify({ error: 'scan failed', message }, null, 2));
    } else {
      console.error('✗  mancode preseason scan is temporarily unavailable.');
      console.error(`   ${message}`);
    }
    return EXIT_SCAN_FAILED;
  }
  const v3Initialized = v3Activation === 'v3_active';
  const initialized =
    v3Initialized ||
    (await pathExists(path.join(rootDir, '.mancode', 'state.json')));
  if (!initialized) {
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
    report = await runPreseasonScan(rootDir, area, {
      storageRoot: v3Initialized
        ? path.join(rootDir, '.mancode', 'local')
        : undefined,
    });
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
  let remediation: PreseasonRemediationResult | undefined;
  if (options.remediate) {
    if (options.json && process.stdin.isTTY && !options.answers) {
      console.log(
        JSON.stringify(
          {
            error: 'invalid argument',
            message:
              '--json --remediate requires piped answers; omit --json for interactive review.',
          },
          null,
          2,
        ),
      );
      return EXIT_INVALID_ARG;
    }
    try {
      remediation = await runRemediation(
        rootDir,
        report,
        options,
        options.json,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.json) {
        console.log(
          JSON.stringify({ error: 'invalid argument', message }, null, 2),
        );
      } else {
        console.error('✗  mancode preseason remediation failed.');
        console.error(`   ${message}`);
      }
      return EXIT_INVALID_ARG;
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ ...report, remediation }, null, 2));
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
  if (remediation) {
    console.log('');
    console.log('Remediation review:');
    console.log(`  Reviewed: ${remediation.reviewed}`);
    console.log(`  Accepted: ${remediation.accepted}`);
    console.log(`  Skipped:  ${remediation.skipped}`);
    console.log(`  Fixed:    ${remediation.fixed}`);
    console.log(
      `  Issue DB: ${path.relative(rootDir, remediation.issueDbPath)}`,
    );
  }
  return EXIT_OK;
}

async function runRemediation(
  rootDir: string,
  report: PreseasonReport,
  options: ManpsOptions,
  silent = false,
): Promise<PreseasonRemediationResult> {
  const write = silent ? () => {} : undefined;
  if (options.answers) {
    return runPreseasonRemediation(rootDir, report.issues, {
      answers: options.answers,
      write,
      issueDbPath: report.issueDbPath,
    });
  }

  if (!process.stdin.isTTY) {
    const answers = await readStdinLines();
    if (answers.length === 0 && report.issues.length > 0) {
      throw new Error(
        'non-interactive remediation requires piped answers for each open issue',
      );
    }
    return runPreseasonRemediation(rootDir, report.issues, {
      answers,
      write,
      issueDbPath: report.issueDbPath,
    });
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await runPreseasonRemediation(rootDir, report.issues, {
      ask: (question) => rl.question(question),
      write,
      issueDbPath: report.issueDbPath,
    });
  } finally {
    rl.close();
  }
}

async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString('utf-8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readV3ActivationState(
  schemaPath: string,
): Promise<string | null> {
  if (!(await pathExists(schemaPath))) return null;
  try {
    const manifest = parseSchemaManifest(
      JSON.parse(await readFile(schemaPath, 'utf8')),
    );
    return manifest.activationState;
  } catch {
    return 'invalid';
  }
}

import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BoundedRunResult,
  VitestAssessment,
  VitestRunReport,
  VitestScenarioInput,
} from '../runtime/execution-protocol.js';

export interface VitestIdentity {
  testIdentity: string;
  configurationIdentity: string;
}

export function packagedVitestReporterPath(): string {
  const current = fileURLToPath(import.meta.url);
  return current.endsWith('.ts')
    ? path.resolve(
        path.dirname(current),
        '../../dist/execution/vitest-reporter.js',
      )
    : fileURLToPath(new URL('./execution/vitest-reporter.js', import.meta.url));
}

export function buildVitestArgv(argv: string[]): string[] {
  return [...argv, '--reporter', packagedVitestReporterPath()];
}

export async function readProjectVitestVersion(
  projectRoot: string,
): Promise<string> {
  const require = createRequire(
    path.join(path.resolve(projectRoot), 'package.json'),
  );
  const metadata = JSON.parse(
    await readFile(require.resolve('vitest/package.json'), 'utf8'),
  );
  if (typeof metadata.version !== 'string')
    throw new Error('MANCODE_VITEST_VERSION_UNAVAILABLE');
  return metadata.version;
}

export async function captureVitestIdentity(
  projectRoot: string,
  scenario: VitestScenarioInput,
): Promise<VitestIdentity> {
  const vitestVersion = await readProjectVitestVersion(projectRoot);
  if (
    !/^3\./.test(vitestVersion) ||
    !scenario.targets.length ||
    !scenario.testInputs.length ||
    !scenario.configInputs.length ||
    scenario.targets.some(
      (target) => !target.name || !scenario.testInputs.includes(target.file),
    )
  )
    throw new Error('MANCODE_TDD_INPUT_INVALID');
  const root = await realpath(projectRoot);
  const digest = async (files: string[], extra: unknown) => {
    if (new Set(files).size !== files.length)
      throw new Error('MANCODE_TDD_DUPLICATE_INPUT');
    const hash = createHash('sha256').update(JSON.stringify(extra));
    for (const file of [...files].sort()) {
      if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))
        throw new Error('MANCODE_TDD_PATH_INVALID');
      const target = path.resolve(root, file);
      const resolved = await realpath(target);
      if (
        resolved !== target ||
        !resolved.startsWith(`${root}${path.sep}`) ||
        !(await lstat(target)).isFile()
      )
        throw new Error('MANCODE_TDD_PATH_INVALID');
      const bytes = await readFile(target);
      hash.update(JSON.stringify([file, bytes.length])).update(bytes);
    }
    return `sha256:${hash.digest('hex')}`;
  };
  return {
    testIdentity: await digest(scenario.testInputs, {
      scenario: scenario.id,
      targets: scenario.targets,
    }),
    configurationIdentity: await digest(scenario.configInputs, {
      vitestVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  };
}

export async function readVitestAssessment(input: {
  reportPath: string;
  run: BoundedRunResult;
  scenario: VitestScenarioInput;
  before: VitestIdentity;
  after: VitestIdentity;
}): Promise<VitestAssessment> {
  const assessment: VitestAssessment = {
    adapter: 'vitest',
    adapterVersion: 1,
    runId: input.run.identity?.runId ?? '',
    executorId: input.run.identity?.executorId ?? '',
    ...input.before,
    assessment: 'unverified',
    targets: [],
    collectionErrors: 0,
    unhandledErrors: 0,
    reasons: [],
  };
  try {
    if (
      !input.run.identity ||
      !input.run.started ||
      !input.run.cleanupConfirmed ||
      input.run.outputTruncated ||
      !['succeeded', 'failed'].includes(input.run.status)
    )
      throw new Error('RUN_NOT_COMPLETED');
    if (
      input.before.testIdentity !== input.after.testIdentity ||
      input.before.configurationIdentity !== input.after.configurationIdentity
    )
      throw new Error('TEST_INPUT_CHANGED_DURING_RUN');
    const info = await lstat(input.reportPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error('REPORT_INVALID');
    const report: VitestRunReport = JSON.parse(
      await readFile(input.reportPath, 'utf8'),
    );
    if (
      report.protocolVersion !== 1 ||
      report.runId !== assessment.runId ||
      report.executorId !== assessment.executorId ||
      !Array.isArray(report.tests) ||
      !Number.isSafeInteger(report.collectionErrors) ||
      report.collectionErrors < 0 ||
      !Number.isSafeInteger(report.unhandledErrors) ||
      report.unhandledErrors < 0
    )
      throw new Error('REPORT_BINDING_INVALID');
    assessment.collectionErrors = report.collectionErrors;
    assessment.unhandledErrors = report.unhandledErrors;
    if (
      report.collectionErrors ||
      report.unhandledErrors ||
      report.reason === 'interrupted' ||
      !report.tests.length
    )
      throw new Error('COLLECTION_OR_ENVIRONMENT_FAILURE');
    const keys = new Set<string>();
    for (const test of report.tests) {
      const key = JSON.stringify([test.file, test.name]);
      if (
        keys.has(key) ||
        !Array.isArray(test.errorNames) ||
        test.errorNames.some((name) => typeof name !== 'string') ||
        !['passed', 'failed', 'skipped', 'pending'].includes(test.status) ||
        !Number.isSafeInteger(test.assertionErrors) ||
        test.assertionErrors < 0 ||
        !Number.isSafeInteger(test.retryCount) ||
        test.retryCount < 0 ||
        typeof test.expectedFailure !== 'boolean'
      )
        throw new Error('REPORT_TEST_INVALID');
      keys.add(key);
    }
    const targets = input.scenario.targets.map((target) =>
      report.tests.find(
        (test) => test.file === target.file && test.name === target.name,
      ),
    );
    if (targets.some((test) => !test)) throw new Error('TARGET_NOT_COLLECTED');
    for (const test of targets) {
      if (!test) continue;
      assessment.targets.push({
        file: test.file,
        name: test.name,
        status: test.status,
        errorNames: test.errorNames,
      });
      if (
        test.expectedFailure ||
        test.retryCount ||
        test.status === 'skipped' ||
        test.status === 'pending'
      )
        throw new Error('TARGET_SKIPPED_RETRIED_OR_INVERTED');
    }
    if (
      report.tests.some(
        (test) =>
          test.status === 'failed' &&
          (!targets.includes(test) ||
            test.assertionErrors !== test.errorNames.length ||
            test.assertionErrors === 0 ||
            test.errorNames.some((name) => name !== 'AssertionError')),
      )
    )
      throw new Error('NON_TARGET_ASSERTION_FAILURE');
    if (
      input.run.status === 'succeeded' &&
      input.run.exitCode === 0 &&
      report.reason === 'passed' &&
      targets.every((test) => test?.status === 'passed')
    )
      assessment.assessment = 'passed';
    else if (
      input.run.status === 'failed' &&
      input.run.exitCode !== null &&
      input.run.exitCode !== 0 &&
      report.reason === 'failed' &&
      targets.some((test) => test?.status === 'failed')
    )
      assessment.assessment = 'assertion_failure';
    else throw new Error('RUN_REPORT_DISAGREEMENT');
  } catch (error) {
    assessment.reasons.push(
      error instanceof Error ? error.message : 'REPORT_UNAVAILABLE',
    );
  }
  return assessment;
}

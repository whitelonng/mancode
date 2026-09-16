import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Reporter from '../src/system/vitest-evidence-reporter.js';
afterEach(() => vi.unstubAllEnvs());

it('preserves collection/unhandled failures and exclusively binds the report to an execution', async () => {
  const base = process.env.MANCODE_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'vitest-reporter-'));
  const output = path.join(root, 'report.json');
  vi.stubEnv('MANCODE_VITEST_REPORT', output);
  vi.stubEnv('MANCODE_EXECUTION_RUN_ID', 'run');
  vi.stubEnv('MANCODE_EXECUTOR_ID', 'executor');
  const reporter = new Reporter();
  await reporter.onTestRunEnd([], [new Error('unhandled')], 'failed');
  expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
    runId: 'run',
    executorId: 'executor',
    tests: [],
    unhandledErrors: 1,
    reason: 'failed',
  });
  await expect(reporter.onTestRunEnd([], [], 'passed')).rejects.toMatchObject({
    code: 'EEXIST',
  });
  vi.stubEnv('MANCODE_VITEST_REPORT', '');
  await expect(reporter.onTestRunEnd([], [], 'passed')).rejects.toThrow(
    'MANCODE_VITEST_REPORT_BINDING_REQUIRED',
  );
});

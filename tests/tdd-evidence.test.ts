import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  BoundedRunResult,
  VitestRunReport,
  VitestScenarioInput,
} from '../src/runtime/execution-protocol.js';
import { runBoundedCommand } from '../src/runtime/execution-runner.js';
import {
  buildVitestArgv,
  captureVitestIdentity,
  packagedVitestReporterPath,
  readProjectVitestVersion,
  readVitestAssessment,
} from '../src/system/tdd-evidence.js';

let root: string;
let worker: string;
let reporter: string;
const scenario: VitestScenarioInput = {
  id: 'value',
  targets: [{ file: 'behavior.test.ts', name: 'matches behavior' }],
  testInputs: ['behavior.test.ts'],
  configInputs: ['vitest.config.mjs', 'package.json'],
};
const testCode =
  "import {test,expect} from 'vitest'; import {value} from './value.mjs'; test('matches behavior',()=>expect(value).toBe(2));";
beforeAll(async () => {
  const base = process.env.MANCODE_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  root = await realpath(await mkdtemp(path.join(base, 'tdd-evidence-')));
  worker = path.join(root, 'worker.mjs');
  reporter = path.join(root, 'reporter.mjs');
  await build({
    entryPoints: ['src/runtime/execution-worker.ts'],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  await build({
    entryPoints: ['src/system/vitest-evidence-reporter.ts'],
    outfile: reporter,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  await symlink(
    path.resolve('node_modules'),
    path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(root, 'vitest.config.mjs'),
    "export default {test:{include:['behavior.test.ts'],maxWorkers:1,watch:false}};",
  );
  await writeFile(path.join(root, 'behavior.test.ts'), testCode);
  await writeFile(path.join(root, 'value.mjs'), 'export const value=1;');
});

async function run(id: string) {
  const before = await captureVitestIdentity(root, scenario);
  const reportPath = path.join(root, `${id}.json`);
  const result = await runBoundedCommand({
    runId: id,
    projectRoot: root,
    runDirectory: path.join(root, id),
    workerPath: worker,
    timeoutMs: 15000,
    maxOutputBytes: 65536,
    argv: [
      process.execPath,
      path.resolve('node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      path.join(root, 'vitest.config.mjs'),
      '--reporter',
      reporter,
    ],
    env: { MANCODE_VITEST_REPORT: reportPath },
  });
  const after = await captureVitestIdentity(root, scenario);
  return { reportPath, run: result, scenario, before, after };
}

describe.skipIf(process.platform === 'win32')(
  'structured Vitest behavior evidence',
  () => {
    it('observes a real assertion Red and a same-test Green after an implementation change', async () => {
      const red = await run('red');
      expect(await readVitestAssessment(red)).toMatchObject({
        assessment: 'assertion_failure',
        collectionErrors: 0,
        unhandledErrors: 0,
        targets: [{ status: 'failed', errorNames: ['AssertionError'] }],
      });
      await writeFile(path.join(root, 'value.mjs'), 'export const value=2;');
      const green = await run('green');
      expect(await readVitestAssessment(green)).toMatchObject({
        assessment: 'passed',
      });
      expect(red.before).toEqual(green.before);
      expect(await readProjectVitestVersion(root)).toMatch(/^3\./);
      expect(buildVitestArgv(['node', 'vitest', 'run'])).toEqual([
        'node',
        'vitest',
        'run',
        '--reporter',
        packagedVitestReporterPath(),
      ]);
    }, 20000);

    it.each([false, true])(
      'uses repository identities with nested cwd and custom Vitest root=%s',
      async (customRoot) => {
        const directory = customRoot ? 'custom' : 'nested';
        const cwd = path.join(root, directory);
        const testRoot = customRoot ? path.join(cwd, 'tests') : cwd;
        await mkdir(testRoot, { recursive: true });
        await writeFile(path.join(testRoot, 'behavior.test.ts'), testCode);
        await writeFile(
          path.join(testRoot, 'value.mjs'),
          'export const value=1;',
        );
        await writeFile(
          path.join(cwd, 'vitest.config.mjs'),
          `export default {${customRoot ? "root: './tests'," : ''}test:{include:['behavior.test.ts'],maxWorkers:1,watch:false}};`,
        );
        const relative = path
          .relative(root, testRoot)
          .split(path.sep)
          .join('/');
        const nestedScenario = {
          ...scenario,
          targets: [
            { file: `${relative}/behavior.test.ts`, name: 'matches behavior' },
          ],
          testInputs: [`${relative}/behavior.test.ts`],
          configInputs: ['package.json', `${directory}/vitest.config.mjs`],
        };
        for (const phase of ['red', 'green']) {
          if (phase === 'green')
            await writeFile(
              path.join(testRoot, 'value.mjs'),
              'export const value=2;',
            );
          const before = await captureVitestIdentity(root, nestedScenario);
          const runId = `${directory}-${phase}`;
          const reportPath = path.join(root, `${runId}.json`);
          const result = await runBoundedCommand({
            runId,
            projectRoot: cwd,
            runDirectory: path.join(root, runId),
            workerPath: worker,
            timeoutMs: 15000,
            maxOutputBytes: 65536,
            argv: [
              process.execPath,
              path.resolve('node_modules/vitest/vitest.mjs'),
              'run',
              '--config',
              path.join(cwd, 'vitest.config.mjs'),
              '--reporter',
              reporter,
            ],
            env: {
              MANCODE_VITEST_REPORT: reportPath,
              MANCODE_VITEST_PROJECT_ROOT: root,
            },
          });
          const assessment = await readVitestAssessment({
            reportPath,
            run: result,
            scenario: nestedScenario,
            before,
            after: await captureVitestIdentity(root, nestedScenario),
          });
          expect(assessment.assessment, JSON.stringify(assessment)).toBe(
            phase === 'red' ? 'assertion_failure' : 'passed',
          );
        }
      },
      30000,
    );

    it('keeps syntax errors, skipped tests and hook failures unverified', async () => {
      for (const [id, code] of [
        ['syntax', 'import ??? broken'],
        [
          'skip',
          "import {test} from 'vitest'; test.skip('matches behavior',()=>{});",
        ],
        [
          'hook',
          "import {test,expect,beforeEach} from 'vitest'; beforeEach(()=>expect(1).toBe(2)); test('matches behavior',()=>{});",
        ],
        [
          'no-target',
          "import {test} from 'vitest'; test('a different behavior',()=>{});",
        ],
        [
          'retry',
          "import {test,expect} from 'vitest'; let calls=0; test('matches behavior',{retry:1},()=>expect(++calls).toBe(2));",
        ],
        [
          'network',
          "import {test} from 'vitest'; test('matches behavior',()=>{throw new TypeError('fetch failed')});",
        ],
      ]) {
        await writeFile(path.join(root, 'behavior.test.ts'), code as string);
        const observed = await run(id as string);
        expect((await readVitestAssessment(observed)).assessment, id).toBe(
          'unverified',
        );
      }
      await writeFile(path.join(root, 'behavior.test.ts'), testCode);
    }, 30000);

    it('invalidates altered assertions and rejects a stale or hand-copied report binding', async () => {
      const identity = await captureVitestIdentity(root, scenario);
      await writeFile(
        path.join(root, 'behavior.test.ts'),
        testCode.replace('toBe(2)', 'toBe(99)'),
      );
      const changed = await captureVitestIdentity(root, scenario);
      expect(changed.testIdentity).not.toBe(identity.testIdentity);
      const sampleRun = JSON.parse(
        await readFile(path.join(root, 'green/result.json'), 'utf8'),
      ) as BoundedRunResult;
      const reportPath = path.join(root, 'green.json');
      expect(
        (
          await readVitestAssessment({
            reportPath,
            run: sampleRun,
            scenario,
            before: identity,
            after: changed,
          })
        ).reasons,
      ).toContain('TEST_INPUT_CHANGED_DURING_RUN');
      const report = JSON.parse(
        await readFile(reportPath, 'utf8'),
      ) as VitestRunReport;
      report.runId = 'forged-run';
      const copy = path.join(root, 'copied-report.json');
      await writeFile(copy, JSON.stringify(report));
      expect(
        (
          await readVitestAssessment({
            reportPath: copy,
            run: sampleRun,
            scenario,
            before: identity,
            after: identity,
          })
        ).reasons,
      ).toContain('REPORT_BINDING_INVALID');
    });
  },
);

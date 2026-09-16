import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Reporter,
  TestModule,
  TestRunEndReason,
  Vitest,
} from 'vitest/node';
import type { VitestRunReport } from '../runtime/execution-protocol.js';

/** Vitest 3 reported-task API; intentionally contains no task authority writes. */
export default class VitestEvidenceReporter implements Reporter {
  private root = process.cwd();
  private context: Vitest | undefined;
  onInit(context: Vitest): void {
    this.root = process.env.MANCODE_VITEST_PROJECT_ROOT || context.config.root;
    this.context = context;
  }
  async onTestRunEnd(
    modules: readonly TestModule[],
    unhandledErrors: readonly unknown[],
    reason: TestRunEndReason,
  ): Promise<void> {
    const output = process.env.MANCODE_VITEST_REPORT;
    const runId = process.env.MANCODE_EXECUTION_RUN_ID;
    const executorId = process.env.MANCODE_EXECUTOR_ID;
    if (!output || !runId || !executorId)
      throw new Error('MANCODE_VITEST_REPORT_BINDING_REQUIRED');
    const report: VitestRunReport = {
      protocolVersion: 1,
      runId,
      executorId,
      reason,
      collectionErrors: 0,
      unhandledErrors: unhandledErrors.length,
      tests: [],
    };
    const root = await realpath(
      process.env.MANCODE_VITEST_PROJECT_ROOT || this.root,
    );
    for (const module of modules) {
      const relative = path.relative(root, await realpath(module.moduleId));
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error('MANCODE_VITEST_TARGET_OUTSIDE_PROJECT');
      report.collectionErrors += module.errors().length;
      for (const suite of module.children.allSuites())
        report.collectionErrors += suite.errors().length;
      for (const test of module.children.allTests()) {
        // Vitest 3 exposes hook states on the underlying task; a failing hook
        // assertion is a harness failure, not the target behavior's Red.
        const hooks = this.context?.state.idMap.get(test.id)?.result?.hooks;
        if (Object.values(hooks ?? {}).some((state) => state !== 'pass'))
          report.collectionErrors++;
        const result = test.result();
        const errors = result.errors ?? [];
        report.tests.push({
          file: relative.split(path.sep).join('/'),
          name: test.fullName,
          status: result.state,
          errorNames: errors.map((error) => error.name ?? 'UnknownError'),
          assertionErrors: errors.filter(
            (error) =>
              error.name === 'AssertionError' &&
              (error.actual !== undefined ||
                error.expected !== undefined ||
                error.diff !== undefined),
          ).length,
          retryCount: test.diagnostic()?.retryCount ?? 0,
          expectedFailure: test.options.fails === true,
        });
      }
    }
    await writeFile(output, JSON.stringify(report), {
      mode: 0o600,
      flag: 'wx',
    });
  }
}

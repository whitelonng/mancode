import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    'gateway/worker': 'src/gateway/worker.ts',
    'execution/worker': 'src/runtime/execution-worker.ts',
    'execution/vitest-reporter': 'src/system/vitest-evidence-reporter.ts',
    'execution/ci-observer': 'src/system/ci-observer.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  // shebang 由 src/cli.ts 第一行提供，tsup 会保留
});

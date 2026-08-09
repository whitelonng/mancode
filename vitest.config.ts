import { defineConfig } from 'vitest/config';

export const CRITICAL_COVERAGE_THRESHOLDS = {
  'src/commands/project.ts': {
    statements: 90,
    branches: 70,
    functions: 100,
    lines: 90,
  },
  // Preserve explicit floors for high-risk mutation and recovery boundaries.
  // Raise these as focused command-contract coverage lands.
  'src/commands/operation.ts': { lines: 55 },
  'src/commands/team.ts': { lines: 59 },
  'src/commands/workflow.ts': { lines: 58 },
  'src/runtime/operation-recovery-store.ts': { lines: 55 },
} as const;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/version.ts'],
      thresholds: {
        statements: 80,
        branches: 72,
        functions: 90,
        lines: 80,
        ...CRITICAL_COVERAGE_THRESHOLDS,
      },
    },
  },
});

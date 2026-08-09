import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRITICAL_COVERAGE_THRESHOLDS } from '../vitest.config.js';

describe('coverage configuration', () => {
  it('keeps every file-specific threshold attached to an existing source file', async () => {
    for (const sourcePath of Object.keys(CRITICAL_COVERAGE_THRESHOLDS)) {
      await expect(access(path.join(process.cwd(), sourcePath))).resolves.toBe(
        undefined,
      );
    }
  });
});

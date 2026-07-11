import { describe, expect, it } from 'vitest';
import { detectSystemDeps } from '../src/system/detect.js';

describe('detectSystemDeps', () => {
  it('detects git without requiring a POSIX shell', async () => {
    await expect(detectSystemDeps()).resolves.toEqual({ git: true });
  });

  it('reports git as optional when PATH cannot resolve it', async () => {
    await expect(detectSystemDeps({ PATH: '' })).resolves.toEqual({
      git: false,
    });
  });
});

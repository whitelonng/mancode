import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('version', () => {
  it('is a valid semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is the alpha prerelease', () => {
    expect(VERSION).toContain('alpha');
  });
});

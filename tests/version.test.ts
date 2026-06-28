import { describe, expect, it } from 'vitest';
import { version } from '../src/commands/version.js';
import { VERSION } from '../src/version.js';

describe('version', () => {
  it('is a valid semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is the alpha prerelease', () => {
    expect(VERSION).toContain('alpha');
  });
});

describe('mancode version command', () => {
  it('outputs mancode/node/platform format', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      version();
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    expect(output).toContain(`mancode/${VERSION}`);
    expect(output).toMatch(/node\/\d+\.\d+\.\d+/);
    expect(output).toMatch(/(darwin|linux|win32)\/(arm64|x64|ia32)/);
  });
});

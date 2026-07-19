import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { version } from '../src/commands/version.js';
import { VERSION } from '../src/version.js';

describe('version', () => {
  it('is a valid semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps the npm version consumable without a prerelease tag', () => {
    expect(VERSION).not.toMatch(/-(alpha|beta|rc)\./);
  });

  it('keeps README release metadata aligned', async () => {
    const readmes = await Promise.all(
      ['../README.md', '../README.en.md'].map((file) =>
        readFile(new URL(file, import.meta.url), 'utf-8'),
      ),
    );

    for (const readme of readmes) {
      expect(readme).toContain(`v${VERSION}`);
      expect(readme).toContain(`status-Continuity%20v${VERSION}`);
      expect(readme).not.toMatch(/V3%20beta/i);
    }
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

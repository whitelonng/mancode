import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import { install } from '../src/commands/install.js';
import { listPlatforms } from '../src/commands/list-platforms.js';

describe('mancode list-platforms', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-list-platforms-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists available platforms before initialization', async () => {
    const logs = await captureLog(() => listPlatforms(dir));
    const output = logs.join('\n');

    expect(output).toContain('Available platforms:');
    expect(output).toContain('○ claude-code');
    expect(output).toContain('○ cursor');
    expect(output).toContain('○ codex');
    expect(output).toContain('○ copilot');
  });

  it('marks installed platforms after init and install', async () => {
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await silentInit(dir);
    await install(dir, 'codex');

    const logs = await captureLog(() => listPlatforms(dir));
    const output = logs.join('\n');

    expect(output).toContain('✓ claude-code');
    expect(output).toContain('✓ codex');
    expect(output).toContain('○ cursor');
    expect(output).toContain('○ copilot');
  });
});

async function silentInit(dir: string): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await init(dir);
    if (code !== 0) {
      throw new Error(`silentInit failed: init exited with ${code}`);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

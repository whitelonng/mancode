import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({
  calls: 0,
  failuresRemaining: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      reads.calls += 1;
      if (reads.failuresRemaining > 0) {
        reads.failuresRemaining -= 1;
        throw Object.assign(new Error('transient adapter read failure'), {
          code: 'EPERM',
        });
      }
      return Reflect.apply(actual.readFile, actual, args);
    },
  };
});

import {
  V3_MODE_NAMES,
  inspectV3Adapter,
  installV3Adapter,
} from '../src/installers/v3-adapter.js';

describe('V3 adapter status reads', () => {
  let root: string;

  beforeEach(async () => {
    reads.calls = 0;
    reads.failuresRemaining = 0;
    root = path.join(
      tmpdir(),
      `mancode-v3-adapter-read-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await installV3Adapter(root, 'claude-code');
    reads.calls = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('retries one transient adapter read failure', async () => {
    reads.failuresRemaining = 1;

    await expect(inspectV3Adapter(root, 'claude-code')).resolves.toMatchObject({
      installed: true,
      ready: true,
    });
    expect(reads.calls).toBe(V3_MODE_NAMES.length + 2);
  });

  it('keeps a persistent adapter read failure closed', async () => {
    reads.failuresRemaining = 4;

    await expect(inspectV3Adapter(root, 'claude-code')).resolves.toMatchObject({
      installed: true,
      ready: false,
      status: 'unreadable',
      targets: expect.arrayContaining([
        expect.objectContaining({ status: 'unreadable', actualDigest: null }),
      ]),
    });
    expect(reads.calls).toBe(V3_MODE_NAMES.length + 4);
  });
});

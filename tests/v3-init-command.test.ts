import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_INIT_FAILED, EXIT_OK, init } from '../src/commands/init.js';
import { parseSchemaManifest } from '../src/context/manifest.js';
import { runtimeCheckoutRecordPath } from '../src/runtime/project-runtime.js';

describe('journaled V3 init command', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-init-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('initializes a greenfield project without creating legacy state', async () => {
    const result = await init(root, { v3: true });

    expect(result).toBe(EXIT_OK);
    expect(
      parseSchemaManifest(
        JSON.parse(
          await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
        ),
      ).activationState,
    ).toBe('v3_active');
    await expect(
      readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(runtimeCheckoutRecordPath(root), 'utf8'),
    ).resolves.toContain('checkoutId');
  });

  it('refuses to reinterpret legacy authority as a greenfield project', async () => {
    await mkdir(path.join(root, '.mancode'), { recursive: true });
    await writeFile(path.join(root, '.mancode', 'state.json'), '{}\n');

    expect(await init(root, { v3: true })).toBe(EXIT_INIT_FAILED);
    await expect(
      readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
    ).resolves.toBe('{}\n');
  });
});

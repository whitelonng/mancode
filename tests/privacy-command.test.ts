import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privacyPolicyCommand } from '../src/commands/privacy-policy.js';
import {
  privacyPreview,
  privacyScan,
  privacyStatus,
} from '../src/commands/privacy.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { MAX_SCAN_BYTES } from '../src/privacy/detect.js';

let root: string;
let output: string[];
const input = (value: string | Buffer) => Readable.from([value]);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mancode-privacy-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((value) =>
    output.push(String(value)),
  );
  vi.spyOn(console, 'error').mockImplementation((value) =>
    output.push(String(value)),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('privacy scan and preview commands', () => {
  it('distinguishes clean, findings, and errors without exposing source values', async () => {
    expect(
      await privacyScan(root, { json: true }, input('ordinary text')),
    ).toBe(0);
    expect(await privacyScan(root, { json: true }, input('13812345678'))).toBe(
      1,
    );
    expect(
      await privacyScan(root, { json: true, file: 'missing-sensitive-name' }),
    ).toBe(2);
    expect(output.join('\n')).not.toContain('13812345678');
    expect(output.join('\n')).not.toContain('missing-sensitive-name');
    expect(output.join('\n')).not.toContain(root);
    expect(JSON.parse(output[1] ?? '{}')).toMatchObject({
      status: 'complete',
      count: 1,
    });
    expect(JSON.parse(output[2] ?? '{}')).toMatchObject({
      status: 'failed',
      reason: 'input_unreadable',
    });
  });

  it('reads strict UTF-8 across byte chunks with original UTF-16 offsets and BOM', async () => {
    const bytes = Buffer.from('\uFEFF😀 13812345678');
    expect(
      await privacyScan(
        root,
        { json: true },
        Readable.from([...bytes].map((value) => Buffer.from([value]))),
      ),
    ).toBe(1);
    expect(JSON.parse(output[0] ?? '{}').findings[0]).toMatchObject({
      start: 4,
      end: 15,
    });
    expect(
      await privacyScan(root, { json: true }, input(Buffer.from([0xc3, 0x28]))),
    ).toBe(2);
    expect(JSON.parse(output[1] ?? '{}').reason).toBe('invalid_utf8');
  });

  it('creates only a separate private preview and refuses every existing output', async () => {
    const original = 'call 13812345678';
    await fs.writeFile(path.join(root, 'source.txt'), original);
    expect(
      await privacyPreview(root, {
        file: 'source.txt',
        output: 'copy.txt',
        json: true,
      }),
    ).toBe(0);
    expect(await fs.readFile(path.join(root, 'source.txt'), 'utf8')).toBe(
      original,
    );
    expect(await fs.readFile(path.join(root, 'copy.txt'), 'utf8')).toBe(
      'call [REDACTED:phone]',
    );
    if (process.platform !== 'win32')
      expect((await fs.stat(path.join(root, 'copy.txt'))).mode & 0o777).toBe(
        0o600,
      );
    expect(
      await privacyPreview(root, {
        file: 'source.txt',
        output: 'source.txt',
        json: true,
      }),
    ).toBe(2);
    expect(
      await privacyPreview(root, {
        file: 'source.txt',
        output: 'copy.txt',
        json: true,
      }),
    ).toBe(2);
    await fs.symlink(
      path.join(root, 'source.txt'),
      path.join(root, 'linked.txt'),
    );
    expect(
      await privacyPreview(root, {
        file: 'source.txt',
        output: 'linked.txt',
        json: true,
      }),
    ).toBe(2);
    expect(await fs.readFile(path.join(root, 'source.txt'), 'utf8')).toBe(
      original,
    );
    expect(output.join('\n')).not.toContain(original);
    expect(output.join('\n')).not.toContain('source.txt');
  });

  it.each([
    [Buffer.from('a'.repeat(MAX_SCAN_BYTES + 1)), 'input_too_large'],
    [Buffer.from([0xff]), 'invalid_utf8'],
    [Buffer.from('hello\0world'), 'invalid_text'],
    [Buffer.from('13812345678 '.repeat(5000)), 'too_many_findings'],
  ])(
    'never creates a preview for incomplete input or detection',
    async (value, reason) => {
      expect(
        await privacyPreview(
          root,
          { output: 'copy.txt', json: true },
          input(value),
        ),
      ).toBe(2);
      expect(JSON.parse(output[0] ?? '{}').reason).toBe(reason);
      await expect(fs.stat(path.join(root, 'copy.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('scans and previews complete prefixed and quoted credentials without exposing any words', async () => {
    const original =
      '😀 client_password="synthetic alpha omega"; DB_PASSWORD=synthetic-other; token_count=12';
    expect(await privacyScan(root, { json: true }, input(original))).toBe(1);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      status: 'complete',
      count: 2,
    });
    expect(
      await privacyPreview(
        root,
        { output: 'copy.txt', json: true },
        input(original),
      ),
    ).toBe(0);
    expect(await fs.readFile(path.join(root, 'copy.txt'), 'utf8')).toBe(
      '😀 client_password="[REDACTED:secret]"; DB_PASSWORD=[REDACTED:secret]; token_count=12',
    );
    for (const fragment of [
      'synthetic',
      'alpha',
      'omega',
      'client_password',
      'DB_PASSWORD',
    ])
      expect(output.join('\n')).not.toContain(fragment);
  });

  it('does not publish a partial file when storage fails and allows a clean retry', async () => {
    const open = fs.open.bind(fs);
    const failure = Object.assign(new Error('sensitive path and body'), {
      code: 'ENOSPC',
    });
    const spy = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
      return handle;
    });
    expect(
      await privacyPreview(
        root,
        { output: 'copy.txt', json: true },
        input('13812345678'),
      ),
    ).toBe(2);
    expect(await fs.readdir(root)).toEqual([]);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      reason: 'output_unavailable',
      systemCode: 'ENOSPC',
    });
    expect(output.join(' ')).not.toContain('sensitive path and body');
    spy.mockRestore();
    expect(
      await privacyPreview(
        root,
        { output: 'copy.txt', json: true },
        input('13812345678'),
      ),
    ).toBe(0);
  });

  it('reports only shared status and ignores corrupt retired settings', async () => {
    const home = path.join(root, 'home');
    const old = path.join(home, '.mancode/privacy-gateway/obsolete');
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(
      path.join(old, 'config.json'),
      'sensitive-broken-content',
    );
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await initializeV3Project({ projectRoot: root, sharedPrivacy: true });
    expect(await privacyStatus(root, { json: true })).toBe(0);
    const report = JSON.parse(output.at(-1) ?? '{}');
    expect(Object.keys(report).sort()).toEqual(['schemaVersion', 'shared']);
    expect(report).toMatchObject({
      schemaVersion: 2,
      shared: { enabled: true, state: 'enabled' },
    });
    expect(output.join(' ')).not.toContain('sensitive-broken-content');
    expect(output.join(' ')).not.toContain(home);
  });

  it('reads the current shared revision for a simple dry-run and preserves explicit CAS checks', async () => {
    await initializeV3Project({ projectRoot: root });
    expect(
      await privacyPolicyCommand(root, { json: true, dryRun: true }, true),
    ).toBe(0);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      expectedRevision: 0,
      enabled: true,
    });
    expect(
      await privacyPolicyCommand(
        root,
        { json: true, dryRun: true, expectedRevision: '9' },
        true,
      ),
    ).not.toBe(0);
    expect(output.at(-1)).toContain('MANCODE_EXPECTED_REVISION_CONFLICT');
  });

  it('rejects directories, excessive files, invalid profiles and missing output safely', async () => {
    await fs.writeFile(
      path.join(root, 'large.txt'),
      Buffer.alloc(MAX_SCAN_BYTES + 1),
    );
    expect(await privacyScan(root, { file: '.', json: true })).toBe(2);
    expect(await privacyScan(root, { file: 'large.txt', json: true })).toBe(2);
    expect(
      await privacyScan(
        root,
        { profile: 'sensitive-profile', json: true },
        input('text'),
      ),
    ).toBe(2);
    expect(await privacyPreview(root, { json: true }, input('text'))).toBe(2);
    expect(output.join('\n')).not.toContain('sensitive-profile');
    expect(output.join('\n')).not.toContain('large.txt');
  });
});

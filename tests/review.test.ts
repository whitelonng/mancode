import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewInspect } from '../src/commands/review.js';

const execFile = promisify(execFileCallback);

describe('review inspect command', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-review-command-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('returns a nonzero structured failure without creating task authority', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await reviewInspect({ base: 'HEAD', json: true }, root)).toBe(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: 'MANCODE_REVIEW_GIT_REQUIRED' },
    });
    await expect(access(path.join(root, '.mancode'))).rejects.toThrow();
  });

  it('prints metadata only and preserves source for a repository without mancode initialization', async () => {
    const git = (args: string[]) => execFile('git', args, { cwd: root });
    await git(['init']);
    await git(['config', 'user.name', 'Review Test']);
    await git(['config', 'user.email', 'review@example.test']);
    await writeFile(path.join(root, 'app.txt'), 'before\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'baseline']);
    await writeFile(path.join(root, 'app.txt'), 'SECRET SOURCE CONTENT\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await reviewInspect({ base: 'HEAD', json: true }, root)).toBe(0);
    const result = String(output.mock.calls[0]?.[0]);
    expect(JSON.parse(result)).toMatchObject({
      kind: 'review_inventory',
      reviewStatus: 'not_reviewed',
      files: [{ status: 'modified', path: 'app.txt' }],
    });
    expect(result).not.toContain('SECRET SOURCE CONTENT');
    expect(await readFile(path.join(root, 'app.txt'), 'utf8')).toBe(
      'SECRET SOURCE CONTENT\n',
    );
    await expect(access(path.join(root, '.mancode'))).rejects.toThrow();
    output.mockClear();
    expect(await reviewInspect({ base: 'HEAD' }, root)).toBe(0);
    expect(output).toHaveBeenCalledWith('modified [working_tree]: "app.txt"');
  });

  it('renders a useful non-JSON error for missing baseline', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await reviewInspect({ base: '' }, root)).toBe(1);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('MANCODE_REVIEW_BASE_REQUIRED'),
    );
  });
});

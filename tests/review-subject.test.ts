import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectReviewSubject } from '../src/system/review-subject.js';

const execFile = promisify(execFileCallback);

describe('read-only complete-review inventory', () => {
  let root: string;
  const git = (args: string[]) => execFile('git', args, { cwd: root });
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-review-subject-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Review Test']);
    await git(['config', 'user.email', 'review@example.test']);
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    for (const file of ['old.txt', 'delete.txt', 'working.txt']) {
      await writeFile(path.join(root, file), `original ${file}\n`);
    }
    await git(['add', '.']);
    await git(['commit', '-m', 'baseline']);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collects committed, staged, unstaged and untracked changes including rename and deletion', async () => {
    const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(path.join(root, 'committed.txt'), 'committed secret\n');
    await git(['add', 'committed.txt']);
    await git(['commit', '-m', 'commit change']);
    await rename(path.join(root, 'old.txt'), path.join(root, 'renamed.txt'));
    await git(['add', 'old.txt', 'renamed.txt']);
    await rm(path.join(root, 'delete.txt'));
    await writeFile(path.join(root, 'working.txt'), 'working secret\n');
    await mkdir(path.join(root, 'tests'));
    await writeFile(path.join(root, 'tests/new.test.ts'), 'test secret\n');
    await writeFile(path.join(root, 'ignored.txt'), 'ignored secret\n');
    const indexBefore = await readFile(path.join(root, '.git/index'));
    const subject = await inspectReviewSubject(root, base);
    expect(subject.files).toEqual(
      expect.arrayContaining([
        {
          status: 'added',
          path: 'committed.txt',
          layers: ['head', 'index', 'working_tree'],
        },
        { status: 'deleted', path: 'delete.txt', layers: ['working_tree'] },
        {
          status: 'renamed',
          previousPath: 'old.txt',
          path: 'renamed.txt',
          layers: ['index', 'working_tree'],
        },
        { status: 'modified', path: 'working.txt', layers: ['working_tree'] },
        {
          status: 'untracked',
          path: 'tests/new.test.ts',
          layers: ['untracked'],
        },
      ]),
    );
    expect(subject.files).toHaveLength(5);
    expect(subject.base.commit).toBe(base);
    expect(subject.head).toBe((await git(['rev-parse', 'HEAD'])).stdout.trim());
    expect(subject.reviewStatus).toBe('not_reviewed');
    expect(JSON.stringify(subject)).not.toContain('secret');
    expect(await readFile(path.join(root, '.git/index'))).toEqual(indexBefore);
    await expect(access(path.join(root, '.mancode'))).rejects.toThrow();
  });

  it('keeps paths literal and captures the repository even when invoked in a subdirectory', async () => {
    const names = [
      '--leading space 中文.txt',
      ...(process.platform === 'win32' ? [] : ['tab\tand\nnewline.txt']),
    ];
    for (const name of names) await writeFile(path.join(root, name), 'private');
    await mkdir(path.join(root, 'nested'));
    await git(['config', 'diff.relative', 'true']);
    const subject = await inspectReviewSubject(
      path.join(root, 'nested'),
      'HEAD',
    );
    expect(subject.files).toEqual(
      names.map((name) => ({
        status: 'untracked',
        path: name,
        layers: ['untracked'],
      })),
    );
    expect(await realpath(subject.repositoryRoot)).toBe(await realpath(root));
  });

  it('retains both paths of an unstaged move without pretending untracked data is staged', async () => {
    await rename(path.join(root, 'old.txt'), path.join(root, 'new.txt'));
    const subject = await inspectReviewSubject(root, 'HEAD');
    expect(subject.files).toEqual(
      expect.arrayContaining([
        { status: 'deleted', path: 'old.txt', layers: ['working_tree'] },
        { status: 'untracked', path: 'new.txt', layers: ['untracked'] },
      ]),
    );
  });

  it('retains an index-only change canceled in the working tree', async () => {
    const original = await readFile(path.join(root, 'working.txt'), 'utf8');
    await writeFile(path.join(root, 'working.txt'), 'broken staged content\n');
    await git(['add', 'working.txt']);
    await writeFile(path.join(root, 'working.txt'), original);
    const subject = await inspectReviewSubject(root, 'HEAD');
    expect(subject.files).toEqual([
      { status: 'modified', path: 'working.txt', layers: ['index'] },
    ]);
  });

  it('retains a committed change canceled in the index and working tree', async () => {
    const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const original = await readFile(path.join(root, 'working.txt'), 'utf8');
    await writeFile(
      path.join(root, 'working.txt'),
      'broken committed content\n',
    );
    await git(['commit', '-am', 'committed change']);
    await writeFile(path.join(root, 'working.txt'), original);
    await git(['add', 'working.txt']);
    const subject = await inspectReviewSubject(root, base);
    expect(subject.files).toEqual([
      { status: 'modified', path: 'working.txt', layers: ['head'] },
    ]);
  });

  it('retains different change kinds for the same path across layers', async () => {
    const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(path.join(root, 'working.txt'), 'committed modification\n');
    await git(['commit', '-am', 'committed change']);
    await git(['rm', 'working.txt']);
    const subject = await inspectReviewSubject(root, base);
    expect(subject.files).toEqual([
      { status: 'modified', path: 'working.txt', layers: ['head'] },
      {
        status: 'deleted',
        path: 'working.txt',
        layers: ['index', 'working_tree'],
      },
    ]);
  });

  it('does not execute configured filters, external diff or fsmonitor helpers', async () => {
    await writeFile(
      path.join(root, '.gitattributes'),
      'working.txt filter=spy diff=spy\n',
    );
    await writeFile(
      path.join(root, 'helper.cjs'),
      "require('node:fs').writeFileSync('helper-ran', 'bad'); process.stdin.pipe(process.stdout);\n",
    );
    const helper = `"${process.execPath}" "${path.join(root, 'helper.cjs')}"`;
    await git(['config', 'filter.spy.clean', helper]);
    await git(['config', 'filter.spy.process', helper]);
    await git(['config', 'filter.spy.required', 'true']);
    await git(['config', 'diff.spy.command', helper]);
    await git(['config', 'diff.spy.textconv', helper]);
    await git(['config', 'core.fsmonitor', helper]);
    await writeFile(path.join(root, 'working.txt'), 'changed\n');
    const subject = await inspectReviewSubject(root, 'HEAD');
    expect(subject.files).toContainEqual({
      status: 'modified',
      path: 'working.txt',
      layers: ['working_tree'],
    });
    await expect(access(path.join(root, 'helper-ran'))).rejects.toThrow();
  });

  it('fails closed for missing Git, invalid base and option-like base arguments', async () => {
    await expect(inspectReviewSubject(root, '')).rejects.toMatchObject({
      code: 'MANCODE_REVIEW_BASE_REQUIRED',
    });
    await expect(
      inspectReviewSubject(root, 'missing-ref'),
    ).rejects.toMatchObject({ code: 'MANCODE_REVIEW_BASE_INVALID' });
    await expect(inspectReviewSubject(root, '--all')).rejects.toMatchObject({
      code: 'MANCODE_REVIEW_BASE_INVALID',
    });
    await rm(path.join(root, '.git'), { recursive: true });
    await expect(inspectReviewSubject(root, 'HEAD')).rejects.toMatchObject({
      code: 'MANCODE_REVIEW_GIT_REQUIRED',
    });
  });

  it('fails rather than returning a complete-looking inventory for an unresolved merge', async () => {
    await git(['checkout', '-b', 'other']);
    await writeFile(path.join(root, 'working.txt'), 'other\n');
    await git(['commit', '-am', 'other']);
    await git(['checkout', 'main']);
    await writeFile(path.join(root, 'working.txt'), 'main\n');
    await git(['commit', '-am', 'main']);
    await expect(git(['merge', 'other'])).rejects.toThrow();
    await expect(inspectReviewSubject(root, 'HEAD')).rejects.toMatchObject({
      code: 'MANCODE_REVIEW_UNMERGED',
    });
  });

  it('does not call a clean inventory a completed review', async () => {
    const subject = await inspectReviewSubject(root, 'HEAD');
    expect(subject.files).toEqual([]);
    expect(subject.reviewStatus).toBe('not_reviewed');
    expect(subject.notes.join(' ')).toContain('not a completed review');
  });
});

import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceManDeliveryRecord } from '../src/context/man-delivery-plan.js';
import {
  bindManPlan,
  captureManSubject,
  inspectManPublication,
  readManPlanFile,
} from '../src/context/man-delivery-runtime.js';
import type { StoredTaskSnapshot } from '../src/context/store.js';

const execFile = promisify(execFileCallback);
const document =
  '<!-- mancode:plan-baseline:start -->\nAC-1: export records\n<!-- mancode:plan-baseline:end -->\n<!-- mancode:delivery-record:start -->\nPending\n<!-- mancode:delivery-record:end -->\n';

describe('man delivery content and file contracts', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-delivery-'));
    await execFile('git', ['init', '-q'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'Contract'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'contract@example.test'], {
      cwd: root,
    });
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs/export.md'), document);
    await writeFile(path.join(root, 'app.js'), 'export const value = 1;');
    await commit();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function commit() {
    await execFile('git', ['add', 'docs/export.md', 'app.js'], { cwd: root });
    await execFile('git', ['commit', '-qm', 'fixture'], { cwd: root });
  }
  async function task(): Promise<Pick<StoredTaskSnapshot, 'plan'>> {
    return {
      plan: {
        artifactRef: {
          taskRef: { namespace: 'local', taskId: '01JZ4B6W5Z0A1B2C3D4E5F6G7H' },
          kind: 'plan',
        },
        digest: '',
        content: await bindManPlan(root, 'docs/export.md', document, null),
      },
    };
  }

  it('ignores delivery prose and authority files, but not changed approved targets', async () => {
    const bound = await task();
    const first = await captureManSubject(root, bound);
    await writeFile(
      path.join(root, 'docs/export.md'),
      replaceManDeliveryRecord(document, 'Awaiting review'),
    );
    await mkdir(path.join(root, '.mancode/local/drafts'), { recursive: true });
    await writeFile(path.join(root, '.mancode/local/drafts/review.json'), '{}');
    expect(await captureManSubject(root, bound)).toEqual(first);
    await writeFile(
      path.join(root, 'docs/export.md'),
      document.replace('export records', 'skip export'),
    );
    await expect(captureManSubject(root, bound)).rejects.toThrow(
      'BASELINE_CHANGED',
    );
  });

  it('detects unstaged, staged and untracked code while retaining evidence across a content-only commit', async () => {
    const bound = await task();
    const first = await captureManSubject(root, bound);
    await writeFile(path.join(root, 'app.js'), 'export const value = 2;');
    const changed = await captureManSubject(root, bound);
    expect(changed).not.toEqual(first);
    await execFile('git', ['add', 'app.js'], { cwd: root });
    expect(await captureManSubject(root, bound)).toEqual(changed);
    await commit();
    expect(await captureManSubject(root, bound)).toEqual(changed);
    await writeFile(path.join(root, 'new.js'), 'export const feature = true;');
    expect(await captureManSubject(root, bound)).not.toEqual(changed);
  });

  it('rejects an ignored plan without forcing it into Git', async () => {
    await writeFile(path.join(root, '.gitignore'), 'docs/\n');
    await expect(readManPlanFile(root, 'docs/export.md')).rejects.toThrow(
      'PLAN_IGNORED',
    );
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(
      'docs/\n',
    );
  });

  it('rejects a plan symlink escaping the approved project', async () => {
    const external = await mkdtemp(path.join(tmpdir(), 'mancode-private-'));
    try {
      await writeFile(path.join(external, 'plan.md'), document);
      await symlink(
        path.join(external, 'plan.md'),
        path.join(root, 'docs/linked.md'),
      );
      await expect(readManPlanFile(root, 'docs/linked.md')).rejects.toThrow(
        'PATH_INVALID',
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it('allows planning without Git, but never claims versioned evidence without it', async () => {
    const unversioned = await mkdtemp(
      path.join(tmpdir(), 'mancode-unversioned-'),
    );
    try {
      await mkdir(path.join(unversioned, 'docs'));
      await writeFile(path.join(unversioned, 'docs/export.md'), document);
      const plan = await bindManPlan(
        unversioned,
        'docs/export.md',
        document,
        null,
      );
      expect(plan).toContain('"baseHead":null');
      await expect(
        captureManSubject(unversioned, {
          plan: {
            ...((await task()).plan as NonNullable<StoredTaskSnapshot['plan']>),
            content: plan,
          },
        }),
      ).rejects.toThrow('GIT_REQUIRED');
    } finally {
      await rm(unversioned, { recursive: true, force: true });
    }
  });

  it('checks actual upstream publication independently from delivery without configuring or pushing anything itself', async () => {
    expect(await inspectManPublication(root)).toMatchObject({
      status: 'unpublished',
      reason: 'no upstream configured',
    });
    const remote = await mkdtemp(path.join(tmpdir(), 'mancode-upstream-'));
    try {
      await execFile('git', ['init', '--bare', '-q', remote]);
      await execFile('git', ['remote', 'add', 'origin', remote], { cwd: root });
      await execFile('git', ['push', '-u', 'origin', 'HEAD'], { cwd: root });
      expect(await inspectManPublication(root)).toMatchObject({
        status: 'published',
      });
      await writeFile(path.join(root, 'app.js'), 'export const value=3;');
      await commit();
      expect(await inspectManPublication(root)).toMatchObject({
        status: 'unpublished',
      });
      await execFile('git', ['push'], { cwd: root });
      expect(await inspectManPublication(root)).toMatchObject({
        status: 'published',
      });
      await execFile(
        'git',
        ['remote', 'set-url', 'origin', path.join(remote, 'absent')],
        { cwd: root },
      );
      expect(await inspectManPublication(root)).toMatchObject({
        status: 'unverified',
      });
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
});

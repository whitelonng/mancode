import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectProgressController } from '../src/commands/progress.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import {
  bindProjectProgress,
  readProjectProgressBinding,
  readProjectProgressSnapshotVersion,
  rebuildSharedProjectProgress,
  writeProjectProgressSnapshot,
} from '../src/context/project-progress-storage.js';

import * as atomicFile from '../src/runtime/atomic-file.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(git = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-progress-storage-'));
  roots.push(root);
  if (git) await promisify(execFile)('git', ['init'], { cwd: root });
  await initializeV3Project({ projectRoot: root });
  return root;
}

describe('progress snapshot storage', () => {
  it('binds once, generates a standalone snapshot and leaves identical content untouched', async () => {
    const root = await fixture(true);
    const binding = await bindProjectProgress(root);
    expect(await bindProjectProgress(root)).toEqual(binding);
    const controller = await createProjectProgressController(root);
    await controller.refresh();
    const first = await writeProjectProgressSnapshot(root, controller, null);
    expect(first.status).toBe('updated');
    const html = await readFile(path.join(root, '项目进度.html'), 'utf8');
    expect(html).toContain('mancode-progress-data');
    const second = await writeProjectProgressSnapshot(
      root,
      controller,
      first.version,
    );
    expect(second.status).toBe('unchanged');
    expect(
      (
        await promisify(execFile)(
          'git',
          ['-c', 'core.quotepath=false', 'check-ignore', '--', '项目进度.html'],
          { cwd: root },
        )
      ).stdout,
    ).toContain('项目进度.html');
    expect(await readProjectProgressSnapshotVersion(root)).toBe(first.version);
    await expect(
      writeProjectProgressSnapshot(root, controller, null),
    ).rejects.toThrow('MANCODE_PROGRESS_PUBLICATION_STALE');
  });
  it('holds the Git index writer lock through final publication', async () => {
    const root = await fixture(true);
    await bindProjectProgress(root);
    const controller = await createProjectProgressController(root);
    await controller.refresh();
    const replace = atomicFile.replaceFileAtomically;
    let attempts = 0;
    vi.spyOn(atomicFile, 'replaceFileAtomically').mockImplementation(
      async (source, target) => {
        if (target.endsWith('项目进度.html')) {
          attempts++;
          await expect(
            promisify(execFile)('git', ['add', '-A'], { cwd: root }),
          ).rejects.toThrow('index.lock');
        }
        return replace(source, target);
      },
    );
    await writeProjectProgressSnapshot(root, controller, null);
    expect(attempts).toBe(1);
    await expect(
      readFile(path.join(root, '.git/index.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('stages local HTML only in a Git-excluded directory and rejects stale shared rebuilds', async () => {
    const root = await fixture(true);
    await bindProjectProgress(root);
    const controller = await createProjectProgressController(root);
    await controller.refresh();
    const replace = atomicFile.replaceFileAtomically;
    let checked = false;
    vi.spyOn(atomicFile, 'replaceFileAtomically').mockImplementation(
      async (source, target) => {
        if (target === path.join(root, '项目进度.html')) {
          expect(path.dirname(source)).toBe(path.join(root, '.mancode/local'));
          await promisify(execFile)(
            'git',
            ['check-ignore', '-q', '--', path.relative(root, source)],
            { cwd: root },
          );
          checked = true;
        }
        return replace(source, target);
      },
    );
    const first = await writeProjectProgressSnapshot(root, controller, null);
    expect(checked).toBe(true);
    await expect(
      rebuildSharedProjectProgress(root, controller, null),
    ).rejects.toThrow('MANCODE_PROGRESS_PUBLICATION_STALE');
    expect(await readProjectProgressSnapshotVersion(root)).toBe(first.version);
  });
  it('preserves an existing custom page including legacy JSON contracts', async () => {
    const root = await fixture();
    const html =
      '<h1>Owned by user</h1><script type="application/json" id="mancode-progress-data">{"schemaVersion":1,"tasks":[]}</script>';
    await writeFile(path.join(root, '项目进度.html'), html);
    await expect(bindProjectProgress(root)).rejects.toThrow(
      'MANCODE_PROGRESS_MANUAL_SYNC_REQUIRED',
    );
    expect(await readFile(path.join(root, '项目进度.html'), 'utf8')).toBe(html);
    expect(await readProjectProgressBinding(root)).toBeNull();
  });
  it('refuses a local snapshot after Git starts tracking it and safely rebuilds shared output', async () => {
    const root = await fixture(true);
    await bindProjectProgress(root);
    const controller = await createProjectProgressController(root);
    await controller.refresh();
    const first = await writeProjectProgressSnapshot(root, controller, null);
    await promisify(execFile)('git', ['add', '-f', '项目进度.html'], {
      cwd: root,
    });
    await expect(
      writeProjectProgressSnapshot(root, controller, first.version),
    ).rejects.toThrow('MANCODE_PROGRESS_SHARED_REBUILD_REQUIRED');
    await rebuildSharedProjectProgress(root, controller, first.version);
    expect((await readProjectProgressBinding(root))?.visibility).toBe(
      'shared-snapshot',
    );
    const html = await readFile(path.join(root, '项目进度.html'), 'utf8');
    expect(html).toContain('"visibility":"shared-snapshot"');
    expect(html).toContain('"checkoutId":null');
  });
});

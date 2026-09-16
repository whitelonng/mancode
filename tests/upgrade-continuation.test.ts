import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUlid } from '../src/context/ids.js';
import {
  type UpgradeContinuation,
  clearUpgradeContinuation,
  readUpgradeContinuation,
  writeUpgradeContinuation,
} from '../src/runtime/upgrade-continuation.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe('upgrade continuation', () => {
  it('round trips only a receipt bound to the current project', async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'upgrade-receipt-')),
    );
    roots.push(root);
    const receipt: UpgradeContinuation = {
      schemaVersion: 1,
      projectRoot: root,
      operationId: createUlid(),
      sessionId: createUlid(),
      platforms: ['codex'],
      targetVersion: '0.6.8',
      initialVersion: '0.6.8',
      installationEntry: null,
      client: 'mancode-cli',
      createdSession: true,
      phase: 'project',
    };
    expect(await readUpgradeContinuation(root)).toBeNull();
    await writeUpgradeContinuation(root, receipt);
    expect(await readUpgradeContinuation(root)).toEqual(receipt);
    await writeUpgradeContinuation(root, {
      ...receipt,
      projectRoot: '/different',
    });
    await expect(readUpgradeContinuation(root)).rejects.toThrow(
      'RECEIPT_INVALID',
    );
    await clearUpgradeContinuation(root);
    expect(await readUpgradeContinuation(root)).toBeNull();
  });
  it('refuses a redirected receipt directory', async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'upgrade-receipt-')),
    );
    roots.push(root);
    await mkdir(path.join(root, '.mancode/local'), { recursive: true });
    await symlink(root, path.join(root, '.mancode/local/upgrade'), 'dir');
    await expect(readUpgradeContinuation(root)).rejects.toThrow(
      'RECEIPT_PATH_INVALID',
    );
  });
  it('rejects redirected ancestors before creating directories through them', async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'upgrade-receipt-')),
    );
    roots.push(root);
    await mkdir(path.join(root, '.mancode'));
    await mkdir(path.join(root, 'outside'));
    await symlink(
      path.join(root, 'outside'),
      path.join(root, '.mancode/local'),
      'dir',
    );
    await expect(
      writeUpgradeContinuation(root, {} as UpgradeContinuation),
    ).rejects.toThrow('RECEIPT_PATH_INVALID');
    await expect(
      realpath(path.join(root, 'outside/upgrade')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

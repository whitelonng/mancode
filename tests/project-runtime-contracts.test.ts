import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureProjectRuntimeContext,
  readProjectRuntimeContext,
  repositoryRuntimeBindingPath,
  runtimeCheckoutBindingPath,
  runtimeCheckoutRecordPath,
  workspaceRuntimeBindingPath,
} from '../src/runtime/project-runtime.js';

const run = promisify(execFile);
const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';

describe('project runtime binding contract', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-project-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await writeV3Config(root, WORKSPACE_ID);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps a non-Git checkout local and read-only resolution does not bootstrap it', async () => {
    await expect(readProjectRuntimeContext(root)).rejects.toThrow(
      'MANCODE_WORKSPACE_BINDING_MISMATCH',
    );
    const runtime = await ensureProjectRuntimeContext(
      root,
      new Date('2026-07-17T12:00:00.000Z'),
    );

    expect(runtime).toMatchObject({
      workspaceId: WORKSPACE_ID,
      repositoryBindingId: null,
      gitCommonDir: null,
    });
    await expect(
      readFile(runtimeCheckoutRecordPath(root), 'utf8'),
    ).resolves.toContain(runtime.checkoutId);
    await expect(readProjectRuntimeContext(root)).resolves.toMatchObject({
      checkoutId: runtime.checkoutId,
      gitCommonDir: null,
    });
  });

  it('binds one Git worktree to a common-dir workspace without storing raw paths in records', async () => {
    await run('git', ['init'], { cwd: root });
    const runtime = await ensureProjectRuntimeContext(
      root,
      new Date('2026-07-17T12:00:00.000Z'),
    );

    expect(runtime.gitCommonDir).not.toBeNull();
    expect(runtime.repositoryBindingId).not.toBeNull();
    const commonDir = runtime.gitCommonDir as string;
    await expect(
      readFile(repositoryRuntimeBindingPath(commonDir), 'utf8'),
    ).resolves.toContain('commonDirHash');
    await expect(
      readFile(workspaceRuntimeBindingPath(commonDir, WORKSPACE_ID), 'utf8'),
    ).resolves.not.toContain(root);
    await expect(
      readFile(runtimeCheckoutBindingPath(root), 'utf8'),
    ).resolves.not.toContain(root);
    await expect(readProjectRuntimeContext(root)).resolves.toMatchObject({
      checkoutId: runtime.checkoutId,
      repositoryBindingId: runtime.repositoryBindingId,
    });
  });

  it('refuses a runtime record when the project config switches workspace identity', async () => {
    await ensureProjectRuntimeContext(root);
    await writeV3Config(root, '01JZ4B6W5Z0A1B2C3D4E5F6G7J');

    await expect(readProjectRuntimeContext(root)).rejects.toThrow(
      'MANCODE_WORKSPACE_BINDING_MISMATCH',
    );
  });

  it('requires an explicit registration for a linked worktree and then gives it an independent checkout identity', async () => {
    await run('git', ['init'], { cwd: root });
    await run('git', ['config', 'user.email', 'vitest@example.test'], {
      cwd: root,
    });
    await run('git', ['config', 'user.name', 'Vitest'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), '# fixture\n');
    await run('git', ['add', 'README.md'], { cwd: root });
    await run('git', ['commit', '-m', 'fixture'], { cwd: root });
    const primary = await ensureProjectRuntimeContext(root);
    const linked = path.join(
      tmpdir(),
      `mancode-linked-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      await run('git', ['worktree', 'add', '-b', 'linked-v3', linked], {
        cwd: root,
      });
      const linkedConfig = path.join(
        linked,
        '.mancode',
        'shared',
        'config.json',
      );
      await mkdir(path.dirname(linkedConfig), { recursive: true });
      await copyFile(
        path.join(root, '.mancode', 'shared', 'config.json'),
        linkedConfig,
      );

      await expect(readProjectRuntimeContext(linked)).rejects.toThrow(
        'MANCODE_WORKSPACE_BINDING_MISMATCH',
      );
      const registered = await ensureProjectRuntimeContext(linked);
      expect(registered).toMatchObject({
        workspaceId: primary.workspaceId,
        repositoryBindingId: primary.repositoryBindingId,
        gitCommonDir: primary.gitCommonDir,
      });
      expect(registered.checkoutId).not.toBe(primary.checkoutId);
      await expect(readProjectRuntimeContext(linked)).resolves.toMatchObject({
        checkoutId: registered.checkoutId,
        workspaceId: primary.workspaceId,
      });
    } finally {
      await run('git', ['worktree', 'remove', '--force', linked], {
        cwd: root,
      });
      await rm(linked, { recursive: true, force: true });
    }
  });
});

async function writeV3Config(root: string, workspaceId: string): Promise<void> {
  const target = path.join(root, '.mancode', 'shared', 'config.json');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        revision: 1,
        workspaceId,
        transport: { mode: 'local', remote: null },
        lastOperationId: null,
        updatedAt: '2026-07-17T10:00:00.000Z',
      },
      null,
      2,
    )}\n`,
  );
}

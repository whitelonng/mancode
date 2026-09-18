import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectUpgradeInstallation } from '../src/system/upgrade-installation.js';
import type { UpgradeCommandRunner } from '../src/system/upgrade-package.js';

let root: string;
let globalRoot: string;
const run: UpgradeCommandRunner = async (args) => ({
  stdout: args.includes('--prefix')
    ? path.join(
        args[args.indexOf('--prefix') + 1] ?? '',
        process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      )
    : globalRoot,
  stderr: '',
});
async function write(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
async function fixture(packageRoot: string) {
  await write(path.join(packageRoot, 'package.json'), {
    name: 'mancode',
    version: '0.6.8',
    bin: { mancode: 'dist/cli.js' },
  });
  const entryPath = path.join(packageRoot, 'dist/cli.js');
  await write(entryPath, 'console.log("0.6.8")');
  return entryPath;
}
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-installation-')),
  );
  globalRoot = path.join(
    root,
    'global',
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('upgrade installation identification', () => {
  it.each(['dependencies', 'devDependencies', 'optionalDependencies'])(
    'preserves %s ownership and tilde style',
    async (section) => {
      await write(path.join(root, 'package.json'), {
        [section]: { mancode: '~0.6.8' },
      });
      const entryPath = await fixture(path.join(root, 'node_modules/mancode'));
      expect(
        await detectUpgradeInstallation({ cwd: root, entryPath, run }),
      ).toMatchObject({
        kind: 'npm-local',
        dependencySection: section,
        versionStyle: '~',
        declaration: '~0.6.8',
        projectRoot: root,
      });
    },
  );
  it.each([
    'file:../mancode',
    'github:owner/mancode',
    'workspace:*',
    '>=0.6.8',
    'latest',
  ])('does not rewrite unsupported declaration %s', async (declaration) => {
    await write(path.join(root, 'package.json'), {
      dependencies: { mancode: declaration },
    });
    const entryPath = await fixture(path.join(root, 'node_modules/mancode'));
    expect(
      (await detectUpgradeInstallation({ cwd: root, entryPath, run })).kind,
    ).toBe('unsupported');
  });
  it.each(['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'])(
    'recognizes %s without npm writes',
    async (marker) => {
      await write(path.join(root, 'package.json'), {
        dependencies: { mancode: '^0.6.8' },
      });
      await write(path.join(root, marker), '');
      const entryPath = await fixture(path.join(root, 'node_modules/mancode'));
      expect(
        (await detectUpgradeInstallation({ cwd: root, entryPath, run })).kind,
      ).toBe('unsupported');
    },
  );
  it('recognizes an ancestor workspace', async () => {
    await write(path.join(root, 'package.json'), {
      workspaces: ['packages/*'],
    });
    const project = path.join(root, 'packages/app');
    await write(path.join(project, 'package.json'), {
      devDependencies: { mancode: '^0.6.8' },
    });
    const entryPath = await fixture(path.join(project, 'node_modules/mancode'));
    expect(
      (await detectUpgradeInstallation({ cwd: project, entryPath, run }))
        .reason,
    ).toContain('workspaces');
  });
  it('blocks npx and source checkouts', async () => {
    for (const packageRoot of [
      path.join(root, '_npx/hash/node_modules/mancode'),
      path.join(root, 'source'),
    ]) {
      const entryPath = await fixture(packageRoot);
      expect(
        (await detectUpgradeInstallation({ cwd: root, entryPath, run })).kind,
      ).toBe('unsupported');
    }
  });
  it('resolves the real entry of an npm link and does not overwrite its source', async () => {
    const entryPath = await fixture(path.join(root, 'source'));
    const shim = path.join(root, 'mancode');
    await fs.symlink(entryPath, shim);
    expect(
      (await detectUpgradeInstallation({ cwd: root, entryPath: shim, run }))
        .kind,
    ).toBe('unsupported');
  });
  it('detects both local and global copies and permits explicit target selection', async () => {
    await write(path.join(root, 'package.json'), {
      dependencies: { mancode: '0.6.8' },
    });
    const local = await fixture(path.join(root, 'node_modules/mancode'));
    const global = await fixture(path.join(globalRoot, 'mancode'));
    const ambiguous = await detectUpgradeInstallation({
      cwd: root,
      entryPath: local,
      run,
    });
    expect(ambiguous).toMatchObject({
      kind: 'ambiguous',
      conflicts: [local, global],
    });
    expect(
      (
        await detectUpgradeInstallation({
          cwd: root,
          entryPath: local,
          run,
          selectedInstallation: true,
        })
      ).kind,
    ).toBe('npm-local');
  });
  it('verifies the actual npm global prefix and bin', async () => {
    const entryPath = await fixture(path.join(globalRoot, 'mancode'));
    const prefix = path.join(root, 'global');
    const shim = path.join(
      prefix,
      process.platform === 'win32' ? 'mancode.cmd' : 'bin/mancode',
    );
    await fs.mkdir(path.dirname(shim), { recursive: true });
    if (process.platform === 'win32') await fs.writeFile(shim, '@echo off');
    else await fs.symlink(entryPath, shim);
    expect(
      await detectUpgradeInstallation({ cwd: root, entryPath, run }),
    ).toMatchObject({ kind: 'npm-global', prefix });
  });
  it('refuses a package bin pointing outside the package', async () => {
    await fixture(path.join(root, 'node_modules/mancode'));
    await write(path.join(root, 'node_modules/mancode/package.json'), {
      name: 'mancode',
      version: '0.6.8',
      bin: { mancode: '../../other.js' },
    });
    expect(
      (
        await detectUpgradeInstallation({
          cwd: root,
          entryPath: path.join(root, 'node_modules/mancode/dist/cli.js'),
          run,
        })
      ).kind,
    ).toBe('unsupported');
  });
});

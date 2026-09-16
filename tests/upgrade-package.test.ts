import { promises as fs } from 'node:fs';
import { type ServerResponse, createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectUpgradeInstallation } from '../src/system/upgrade-installation.js';
import {
  type UpgradeCommandRunner,
  type UpgradeTarget,
  buildUpgradeInstallArgs,
  installUpgradePackage,
  prepareUpgradeCandidate,
  redactUpgradeOutput,
  resolveUpgradeTarget,
  runUpgradeNpm,
} from '../src/system/upgrade-package.js';

let root: string;
const target: UpgradeTarget = {
  version: '0.6.9',
  integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  tarball: 'https://registry.example/mancode-0.6.9.tgz',
  registry: 'https://registry.example/',
};
const metadata = {
  version: target.version,
  dist: { integrity: target.integrity, tarball: target.tarball },
  engines: { node: '>=22.5.0' },
};
const output = (value: unknown) => ({
  stdout: typeof value === 'string' ? value : JSON.stringify(value),
  stderr: '',
});

it.runIf(Boolean(process.env.MANCODE_UPGRADE_REAL_TEST_ROOT))(
  'real npm upgrades a temporary global prefix and ordinary local declarations using an isolated registry',
  async () => {
    const testRoot = await fs.realpath(
      await fs.mkdtemp(
        path.join(
          process.env.MANCODE_UPGRADE_REAL_TEST_ROOT ?? root,
          'package-spike-',
        ),
      ),
    );
    const run: UpgradeCommandRunner = (args, options) =>
      runUpgradeNpm(
        [...args, '--cache', path.join(testRoot, 'npm-cache')],
        options,
      );
    const packages = new Map<
      string,
      { metadata: Record<string, unknown>; tarball: Buffer }
    >();
    for (const version of ['0.6.8', '0.6.9']) {
      const packageRoot = path.join(testRoot, `source-${version}`);
      await packageFixture(packageRoot, version);
      const packed = await run(['pack', '--json', '--ignore-scripts'], {
        cwd: packageRoot,
      });
      const detail = JSON.parse(packed.stdout)[0] as {
        filename: string;
        integrity: string;
        shasum: string;
      };
      packages.set(version, {
        metadata: {
          name: 'mancode',
          version,
          bin: { mancode: 'dist/cli.js' },
          dist: { integrity: detail.integrity, shasum: detail.shasum },
        },
        tarball: await fs.readFile(path.join(packageRoot, detail.filename)),
      });
    }
    let stalled: (() => void) | undefined;
    let stalledResponse: ServerResponse | undefined;
    let stalledClosed: Promise<void> | undefined;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url?.startsWith('/mancode/-/')) {
        if (stalled) {
          stalledResponse = response;
          stalledClosed = new Promise((resolve) =>
            response.once('close', resolve),
          );
          stalled();
          return;
        }
        const version = /mancode-(.+)\.tgz/.exec(request.url)?.[1];
        const pkg = version ? packages.get(version) : undefined;
        if (pkg) {
          response.setHeader('content-type', 'application/octet-stream');
          response.end(pkg.tarball);
          return;
        }
      }
      if (request.url?.split('?')[0] === '/mancode') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            name: 'mancode',
            'dist-tags': { latest: '0.6.9' },
            versions: Object.fromEntries(
              [...packages].map(([version, pkg]) => [version, pkg.metadata]),
            ),
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end('{}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture registry address unavailable');
    const registry = `http://127.0.0.1:${address.port}/`;
    for (const [version, pkg] of packages)
      (pkg.metadata.dist as Record<string, unknown>).tarball =
        `${registry}mancode/-/mancode-${version}.tgz`;
    try {
      await write(
        path.join(testRoot, '.npmrc'),
        `registry=${registry}\ncache=${path.join(testRoot, 'npm-cache')}\n`,
      );
      const prefix = path.join(testRoot, '全局 prefix');
      await run(
        [
          'install',
          'mancode@0.6.8',
          '--global',
          '--prefix',
          prefix,
          '--registry',
          registry,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        { cwd: testRoot, timeoutMs: 60_000 },
      );
      const globalPackage = path.join(
        prefix,
        process.platform === 'win32'
          ? 'node_modules/mancode'
          : 'lib/node_modules/mancode',
      );
      const global = await detectUpgradeInstallation({
        cwd: testRoot,
        entryPath: path.join(globalPackage, 'dist/cli.js'),
        selectedInstallation: true,
        run,
      });
      expect(global.kind).toBe('npm-global');
      const frozen = await resolveUpgradeTarget({
        currentVersion: '0.6.8',
        cwd: testRoot,
        run,
      });
      const candidate = await prepareUpgradeCandidate({
        target: frozen,
        cwd: testRoot,
        tempRoot: testRoot,
        run,
      });
      expect(
        await installUpgradePackage({
          installation: global,
          target: frozen,
          candidate,
          lockRoot: path.join(testRoot, 'locks'),
          run,
        }),
      ).toMatchObject({ version: '0.6.9' });
      for (const [section, style, save] of [
        ['dependencies', '^', '--save-prod'],
        ['devDependencies', '~', '--save-dev'],
        ['optionalDependencies', '', '--save-optional'],
      ] as const) {
        const project = path.join(testRoot, `本地 ${section}`);
        await write(path.join(project, 'package.json'), {
          name: 'fixture-project',
          version: '1.0.0',
          private: true,
        });
        await run(
          [
            'install',
            'mancode@0.6.8',
            '--prefix',
            project,
            save,
            ...(style
              ? [`--save-prefix=${style}`, '--save-exact=false']
              : ['--save-exact']),
            '--registry',
            registry,
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
          ],
          { cwd: testRoot, timeoutMs: 60_000 },
        );
        const installation = await detectUpgradeInstallation({
          cwd: project,
          entryPath: path.join(project, 'node_modules/mancode/dist/cli.js'),
          selectedInstallation: true,
          run,
        });
        expect(installation).toMatchObject({
          kind: 'npm-local',
          dependencySection: section,
          versionStyle: style || 'exact',
        });
        expect(
          await installUpgradePackage({
            installation,
            target: frozen,
            candidate,
            lockRoot: path.join(testRoot, 'locks'),
            run,
          }),
        ).toMatchObject({ version: '0.6.9' });
        const manifest = JSON.parse(
          await fs.readFile(path.join(project, 'package.json'), 'utf8'),
        );
        const lock = JSON.parse(
          await fs.readFile(path.join(project, 'package-lock.json'), 'utf8'),
        );
        expect(manifest[section].mancode).toBe(`${style}0.6.9`);
        expect(lock.packages['node_modules/mancode'].version).toBe('0.6.9');
        expect(lock.packages[''][section].mancode).toBe(`${style}0.6.9`);
      }
      const stoppedInstallations: Record<string, unknown>[] = [];
      for (const mode of ['cancel', 'timeout'] as const) {
        const destination = path.join(testRoot, `${mode}-prefix`);
        const controller = new AbortController();
        const waitingForTarball = new Promise<void>((resolve) => {
          stalled = resolve;
        });
        const interrupted = runUpgradeNpm(
          [
            'install',
            'mancode@0.6.9',
            '--global',
            '--prefix',
            destination,
            '--registry',
            registry,
            '--cache',
            path.join(testRoot, `${mode}-cache`),
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
          ],
          {
            cwd: testRoot,
            signal: controller.signal,
            timeoutMs: mode === 'timeout' ? 5000 : 30_000,
          },
        );
        const interruptedResult = interrupted.catch((error) => error);
        await waitingForTarball;
        if (mode === 'cancel') controller.abort();
        expect(await interruptedResult).toMatchObject({
          code: 'MANCODE_UPGRADE_NPM_FAILED',
        });
        await stalledClosed;
        expect(stalledResponse?.destroyed).toBe(true);
        const snapshot = async () => {
          let files: string[];
          try {
            files = await fs.readdir(destination, { recursive: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
          }
          return Promise.all(
            files.sort().map(async (file) => {
              const stat = await fs.lstat(path.join(destination, file));
              return { file, size: stat.size, modified: stat.mtimeMs };
            }),
          );
        };
        const before = await snapshot();
        const requestCount = requests.length;
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await snapshot()).toEqual(before);
        expect(requests).toHaveLength(requestCount);
        stoppedInstallations.push({
          mode,
          socketClosed: true,
          filesUnchanged: true,
          requestsAfterCompletion: 0,
        });
        stalled = undefined;
      }
      await write(path.join(testRoot, 'result.json'), {
        status: 'passed',
        node: process.version,
        platform: process.platform,
        registry,
        globalPrefix: prefix,
        tested: [
          'npm global',
          'dependencies caret',
          'devDependencies tilde',
          'optionalDependencies exact',
          'cancel npm during tarball download',
          'timeout npm during tarball download',
        ],
        stoppedInstallations,
        version: '0.6.9',
      });
      await candidate.cleanup();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  120_000,
);
const registryRun: UpgradeCommandRunner = async (args) =>
  output(args[0] === 'config' ? target.registry : metadata);
async function write(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
async function packageFixture(packageRoot: string, version: string) {
  await write(path.join(packageRoot, 'package.json'), {
    name: 'mancode',
    version,
    bin: { mancode: 'dist/cli.js' },
  });
  await write(
    path.join(packageRoot, 'dist/cli.js'),
    `console.log(${JSON.stringify(version)})`,
  );
}
const candidateRun: UpgradeCommandRunner = async (args) => {
  const prefix = args[args.indexOf('--prefix') + 1] ?? '';
  await packageFixture(
    path.join(prefix, 'node_modules/mancode'),
    target.version,
  );
  await write(path.join(prefix, 'package-lock.json'), {
    packages: {
      'node_modules/mancode': {
        integrity: target.integrity,
        resolved: target.tarball,
      },
    },
  });
  return output('');
};
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-package-')),
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('frozen upgrade target', () => {
  it('freezes registry metadata and node compatibility', async () => {
    expect(
      await resolveUpgradeTarget({
        currentVersion: '0.6.8',
        cwd: root,
        run: registryRun,
        nodeVersion: '22.5.0',
      }),
    ).toEqual({ ...target, nodeRange: '>=22.5.0' });
  });
  it.each(['latest', '^0.6.9', 'v0.6.9', '0.6'])(
    'rejects non-exact --to %s before calling npm',
    async (to) => {
      const run = vi.fn(registryRun);
      await expect(
        resolveUpgradeTarget({ currentVersion: '0.6.8', to, cwd: root, run }),
      ).rejects.toMatchObject({ code: 'MANCODE_UPGRADE_INVALID_TARGET' });
      expect(run).not.toHaveBeenCalled();
    },
  );
  it('compares semver instead of lexical version order', async () => {
    const run: UpgradeCommandRunner = async (args) =>
      args[0] === 'config'
        ? registryRun(args, { cwd: root })
        : output({ ...metadata, version: '0.6.10' });
    expect(
      (await resolveUpgradeTarget({ currentVersion: '0.6.9', cwd: root, run }))
        .version,
    ).toBe('0.6.10');
  });
  it('refuses downgrades, incompatible engines, and silent prereleases', async () => {
    await expect(
      resolveUpgradeTarget({
        currentVersion: '0.7.0',
        cwd: root,
        run: registryRun,
      }),
    ).rejects.toMatchObject({ code: 'MANCODE_UPGRADE_DOWNGRADE' });
    await expect(
      resolveUpgradeTarget({
        currentVersion: '0.6.8',
        cwd: root,
        run: registryRun,
        nodeVersion: '20.0.0',
      }),
    ).rejects.toMatchObject({ code: 'MANCODE_UPGRADE_NODE_ENGINE' });
    const run: UpgradeCommandRunner = async (args) =>
      output(
        args[0] === 'config'
          ? target.registry
          : { ...metadata, version: '0.6.9-beta.1' },
      );
    await expect(
      resolveUpgradeTarget({ currentVersion: '0.6.8', cwd: root, run }),
    ).rejects.toMatchObject({ code: 'MANCODE_UPGRADE_INVALID_TARGET' });
    expect(
      (
        await resolveUpgradeTarget({
          currentVersion: '0.6.8',
          to: '0.6.9-beta.1',
          cwd: root,
          run,
        })
      ).version,
    ).toBe('0.6.9-beta.1');
  });
  it('preserves a registry failure instead of claiming latest', async () => {
    const error = new Error('offline');
    await expect(
      resolveUpgradeTarget({
        currentVersion: '0.6.8',
        cwd: root,
        run: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });
  it('rejects install scripts before package preparation', async () => {
    const run: UpgradeCommandRunner = async (args) =>
      output(
        args[0] === 'config'
          ? target.registry
          : { ...metadata, scripts: { postinstall: 'node install.js' } },
      );
    await expect(
      resolveUpgradeTarget({ currentVersion: '0.6.8', cwd: root, run }),
    ).rejects.toMatchObject({ code: 'MANCODE_UPGRADE_INSTALL_SCRIPTS' });
  });
  it('redacts credentials from npm diagnostic output', () => {
    expect(
      redactUpgradeOutput(
        'https://alice:secret@example.test _authToken=hidden',
      ),
    ).toBe('https://[redacted]@example.test _authToken=[redacted]');
  });
});

describe('candidate preparation and package installation', () => {
  it('isolates preparation, pins integrity, and executes the real candidate bin', async () => {
    const run = vi.fn(candidateRun);
    const candidate = await prepareUpgradeCandidate({
      target,
      cwd: root,
      tempRoot: root,
      run,
    });
    expect(candidate.version).toBe(target.version);
    expect(run.mock.calls[0]?.[0]).toContain('--ignore-scripts');
    expect(await fs.readdir(root)).toEqual([path.basename(candidate.rootDir)]);
    await candidate.cleanup();
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('rejects registry substitution and removes only its temporary candidate', async () => {
    await write(path.join(root, 'keep.txt'), 'existing');
    const run: UpgradeCommandRunner = async (args, options) => {
      await candidateRun(args, options);
      const prefix = args[args.indexOf('--prefix') + 1] ?? '';
      await write(path.join(prefix, 'package-lock.json'), {
        packages: {
          'node_modules/mancode': {
            integrity: 'different',
            resolved: target.tarball,
          },
        },
      });
      return output('');
    };
    await expect(
      prepareUpgradeCandidate({ target, cwd: root, tempRoot: root, run }),
    ).rejects.toMatchObject({ code: 'MANCODE_UPGRADE_INTEGRITY' });
    expect(await fs.readdir(root)).toEqual(['keep.txt']);
  });
  it.each(['dependencies', 'devDependencies', 'optionalDependencies'] as const)(
    'uses the correct npm flag for %s and retains range style',
    (section) => {
      const args = buildUpgradeInstallArgs(
        {
          kind: 'npm-local',
          packageRoot: '/app/node_modules/mancode',
          projectRoot: '/app',
          entryPath: '/app/node_modules/mancode/dist/cli.js',
          version: '0.6.8',
          versionStyle: '~',
          dependencySection: section,
        },
        target,
      );
      expect(args).toContain(
        {
          dependencies: '--save-prod',
          devDependencies: '--save-dev',
          optionalDependencies: '--save-optional',
        }[section],
      );
      expect(args).toContain('--save-prefix=~');
      expect(args).toContain('--ignore-scripts');
    },
  );
  it('validates the changed local installation and preserves its declaration', async () => {
    const project = path.join(root, '中文 project');
    const packageRoot = path.join(project, 'node_modules/mancode');
    await packageFixture(packageRoot, '0.6.8');
    await write(path.join(project, 'package.json'), {
      devDependencies: { mancode: '~0.6.8' },
    });
    const installation = await detectUpgradeInstallation({
      cwd: project,
      entryPath: path.join(packageRoot, 'dist/cli.js'),
      selectedInstallation: true,
    });
    const candidate = await prepareUpgradeCandidate({
      target,
      cwd: root,
      tempRoot: root,
      run: candidateRun,
    });
    const run: UpgradeCommandRunner = async (args) => {
      if (args[0] !== 'install') return registryRun(args, { cwd: project });
      await packageFixture(packageRoot, target.version);
      await write(path.join(project, 'package.json'), {
        devDependencies: { mancode: '~0.6.9' },
      });
      return output('');
    };
    expect(
      await installUpgradePackage({
        installation,
        target,
        candidate,
        run,
        lockRoot: path.join(root, 'locks'),
      }),
    ).toEqual({
      version: target.version,
      entryPath: path.join(packageRoot, 'dist/cli.js'),
    });
  });
  it('does not install if the dependency changed after preview', async () => {
    const project = path.join(root, 'project');
    const packageRoot = path.join(project, 'node_modules/mancode');
    await packageFixture(packageRoot, '0.6.8');
    await write(path.join(project, 'package.json'), {
      dependencies: { mancode: '^0.6.8' },
    });
    const installation = await detectUpgradeInstallation({
      cwd: project,
      entryPath: path.join(packageRoot, 'dist/cli.js'),
      selectedInstallation: true,
    });
    const candidate = await prepareUpgradeCandidate({
      target,
      cwd: root,
      tempRoot: root,
      run: candidateRun,
    });
    await write(path.join(project, 'package.json'), {
      dependencies: { mancode: '~0.6.8' },
    });
    const run = vi.fn(registryRun);
    await expect(
      installUpgradePackage({
        installation,
        target,
        candidate,
        run,
        lockRoot: path.join(root, 'locks'),
      }),
    ).rejects.toMatchObject({ code: 'MANCODE_UPGRADE_INSTALLATION_CHANGED' });
    expect(run).not.toHaveBeenCalled();
  });
  it('serializes updates of the same installation until npm completes', async () => {
    const packageRoot = path.join(root, 'node_modules/mancode');
    await packageFixture(packageRoot, '0.6.8');
    await write(path.join(root, 'package.json'), {
      dependencies: { mancode: '^0.6.8' },
    });
    const installation = await detectUpgradeInstallation({
      cwd: root,
      entryPath: path.join(packageRoot, 'dist/cli.js'),
      selectedInstallation: true,
    });
    const candidate = await prepareUpgradeCandidate({
      target,
      cwd: root,
      tempRoot: root,
      run: candidateRun,
    });
    let started: () => void = () => undefined;
    let finish: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run: UpgradeCommandRunner = async (args) => {
      if (args[0] !== 'install') return registryRun(args, { cwd: root });
      started();
      await released;
      await packageFixture(packageRoot, target.version);
      await write(path.join(root, 'package.json'), {
        dependencies: { mancode: '^0.6.9' },
      });
      return output('');
    };
    const input = {
      installation,
      target,
      candidate,
      run,
      lockRoot: path.join(root, 'locks'),
    };
    const first = installUpgradePackage(input);
    await entered;
    await expect(installUpgradePackage(input)).rejects.toThrow(
      'MANCODE_LOCK_HELD',
    );
    finish();
    await expect(first).resolves.toMatchObject({ version: '0.6.9' });
  });
  it.each(['missing', 'replaced', 'unchanged'])(
    'handles an existing script dependency that is %s',
    async (state) => {
      const packageRoot = path.join(root, 'node_modules/mancode');
      const dependency = path.join(root, 'node_modules/native-dependency');
      await packageFixture(packageRoot, '0.6.8');
      await write(path.join(root, 'package.json'), {
        dependencies: { mancode: '^0.6.8', 'native-dependency': '1.0.0' },
      });
      const lock = {
        packages: {
          'node_modules/native-dependency': {
            version: '1.0.0',
            hasInstallScript: true,
          },
        },
      };
      await write(path.join(root, 'package-lock.json'), lock);
      if (state !== 'missing')
        await write(path.join(dependency, 'package.json'), {
          name: 'native-dependency',
          version: '1.0.0',
        });
      const installation = await detectUpgradeInstallation({
        cwd: root,
        entryPath: path.join(packageRoot, 'dist/cli.js'),
        selectedInstallation: true,
      });
      const candidate = await prepareUpgradeCandidate({
        target,
        cwd: root,
        tempRoot: root,
        run: candidateRun,
      });
      const run = vi.fn<UpgradeCommandRunner>(async (args) => {
        if (args[0] !== 'install') return registryRun(args, { cwd: root });
        await packageFixture(packageRoot, target.version);
        await write(path.join(root, 'package.json'), {
          dependencies: { mancode: '^0.6.9', 'native-dependency': '1.0.0' },
        });
        if (state === 'replaced') {
          await fs.rename(dependency, `${dependency}-old`);
          await write(path.join(dependency, 'package.json'), {
            name: 'native-dependency',
            version: '1.0.0',
          });
        }
        return output('');
      });
      const promise = installUpgradePackage({
        installation,
        target,
        candidate,
        run,
        lockRoot: path.join(root, 'locks'),
      });
      if (state === 'unchanged')
        await expect(promise).resolves.toMatchObject({ version: '0.6.9' });
      else
        await expect(promise).rejects.toMatchObject({
          code: 'MANCODE_UPGRADE_INSTALL_SCRIPTS',
        });
      if (state === 'missing') expect(run).not.toHaveBeenCalled();
    },
  );
});

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inc } from 'semver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveUpgradeNpmEntry } from '../src/system/upgrade-package.js';

const execute = promisify(execFile);
const binary = process.env.MANCODE_CLI_BINARY;
const testBase = process.env.MANCODE_UPGRADE_REAL_TEST_ROOT;
const suites = binary ? describe : describe.skip;

/** Faults live only in copies of the built package served by this test registry. */
function instrumentFixtureCli(input: string): string {
  let source = input;
  const helper = `
import * as __upgradeFixtureFs from "node:fs";
function __upgradeFixtureFault(point) {
  const marker = process.env.MANCODE_FIXTURE_FAULT_MARKER;
  if (!marker || process.env.MANCODE_FIXTURE_FAULT !== point || __upgradeFixtureFs.existsSync(marker)) return false;
  __upgradeFixtureFs.writeFileSync(marker, JSON.stringify({ point, pid: process.pid, argv: process.argv, time: Date.now(), interruption: point.startsWith("adapter:") || process.platform === "win32" ? "exception" : "signal" }));
  return true;
}
async function __upgradeFixtureInterrupt(point) {
  if (!__upgradeFixtureFault(point)) return;
  // Windows kill(SIGINT) is a hard termination, unlike console Ctrl-C.
  // Exercise its process-exit recovery separately without claiming console-signal coverage.
  if (process.platform === "win32") throw new Error("MANCODE_UPGRADE_CANCELLED");
  process.kill(process.pid, "SIGINT");
  await new Promise(resolve => setTimeout(resolve, 30));
}
`;
  const replace = (pattern: string | RegExp, replacement: string) => {
    const changed = source.replace(pattern, replacement);
    if (changed === source)
      throw new Error(
        `Built upgrade fixture injection point missing: ${String(pattern)}`,
      );
    source = changed;
  };
  replace('#!/usr/bin/env node\n', `#!/usr/bin/env node\n${helper}`);
  replace(
    'receiptSaved = true;',
    'receiptSaved = true;\n          await __upgradeFixtureInterrupt("project-receipt");',
  );
  replace(
    'const installed = await dependencies.installPackage({',
    'await __upgradeFixtureInterrupt("before-install");\n          const installed = await dependencies.installPackage({',
  );
  replace(
    /(receipt\.installationEntry = installed\.entryPath;\s+await writeUpgradeContinuation\(root, receipt\);)/,
    '$1\n            await __upgradeFixtureInterrupt("after-install");',
  );
  replace(
    'async function installUpgradePackage(options) {',
    'async function installUpgradePackage(options) {\n  if (process.env.MANCODE_FIXTURE_INSTALL_TRACE) __upgradeFixtureFs.appendFileSync(process.env.MANCODE_FIXTURE_INSTALL_TRACE, JSON.stringify({ pid: process.pid, version: options.target.version }) + "\\n");',
  );
  replace(
    /(await run\(args, \{ cwd, timeoutMs: 12e4, signal: options\.signal \}\);)/,
    '$1\n    await __upgradeFixtureInterrupt("install-result-unknown");',
  );
  replace(
    'function throwIfOperationCrashInjected(operationType, crashAfter) {',
    'function throwIfOperationCrashInjected(operationType, crashAfter) {\n  if (operationType === "adapter_upgrade" && __upgradeFixtureFault("adapter:" + crashAfter)) throw new Error("MANCODE_TEST_OPERATION_CRASH_INJECTED");',
  );
  return source;
}

suites('real CLI upgrade through npm and the target renderer', () => {
  let root: string;
  let npm: string;
  let registry: string;
  let oldVersion: string;
  let targetVersion: string;
  let newerVersion: string;
  let targetPackage: Record<string, unknown>;
  let oldTarball: string;
  const tarballs = new Map<string, Buffer>();
  const versions: Record<string, unknown> = {};
  const requests: string[] = [];
  const testShell = process.env.MANCODE_UPGRADE_TEST_SHELL;
  const shellInvocations: { shim: string; args: string[] }[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const blob = tarballs.get(req.url ?? '');
    if (blob) {
      res.end(blob);
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mancode' || req.url?.startsWith('/mancode?')) {
      res.end(
        JSON.stringify({
          name: 'mancode',
          'dist-tags': { latest: targetVersion },
          versions,
        }),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  const envFor = (prefix: string) => ({
    ...process.env,
    npm_config_prefix: prefix,
    npm_config_registry: registry,
    npm_config_cache: path.join(root, 'cache'),
    npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0',
    MANCODE_SESSION_ID: '',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  });
  async function npmRun(args: string[], cwd: string, prefix: string) {
    return execute(
      process.execPath,
      [npm, ...args, '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd,
        env: envFor(prefix),
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
      },
    );
  }
  async function cli(
    entry: string,
    args: string[],
    cwd: string,
    prefix: string,
  ) {
    let command = process.execPath;
    let commandArgs = [entry, ...args];
    const env: NodeJS.ProcessEnv = envFor(prefix);
    const packageRoot = path.dirname(path.dirname(entry));
    // Candidate copies deliberately use Node. Persistently installed packages
    // must exercise npm's real shell entry, including paths with spaces/Unicode.
    if (
      testShell &&
      path.basename(path.dirname(packageRoot)) === 'node_modules'
    ) {
      const globalRoot = path.join(
        prefix,
        process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
        'mancode',
      );
      const bin =
        packageRoot === globalRoot
          ? process.platform === 'win32'
            ? prefix
            : path.join(prefix, 'bin')
          : path.join(path.dirname(packageRoot), '.bin');
      const extension =
        testShell === 'cmd' ? '.cmd' : testShell === 'powershell' ? '.ps1' : '';
      const shim = path.join(bin, `mancode${extension}`);
      await readFile(shim);
      env.MANCODE_UPGRADE_SHIM = shim;
      if (testShell === 'bash') {
        command = process.env.MANCODE_UPGRADE_TEST_BASH ?? 'bash';
        if (
          process.platform === 'win32' &&
          !process.env.MANCODE_UPGRADE_TEST_BASH
        )
          throw new Error('Explicit Git Bash executable required on Windows');
        env.MANCODE_UPGRADE_SHIM = shim.replaceAll('\\', '/');
        commandArgs = [
          '-c',
          'exec "$MANCODE_UPGRADE_SHIM" "$@"',
          'mancode-upgrade-test',
          ...args,
        ];
      } else if (testShell === 'powershell') {
        command = 'powershell.exe';
        env.MANCODE_UPGRADE_ARGV = JSON.stringify(args);
        commandArgs = [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $cliArgs = @(ConvertFrom-Json $env:MANCODE_UPGRADE_ARGV); & $env:MANCODE_UPGRADE_SHIM @cliArgs; exit $LASTEXITCODE',
        ];
      } else if (testShell === 'cmd') {
        // Only fixed fixture arguments are accepted by this CMD test driver.
        // Never interpolate external text into its command string.
        if ([shim, ...args].some((value) => /[%!"&|<>^\r\n]/.test(value)))
          throw new Error('Unsupported CMD fixture argument');
        for (const [index, arg] of args.entries())
          env[`MANCODE_UPGRADE_ARG_${index}`] = arg;
        command = process.env.ComSpec ?? 'cmd.exe';
        commandArgs = [
          '/d',
          '/s',
          '/c',
          `chcp 65001 >nul & call "%MANCODE_UPGRADE_SHIM%" ${args.map((_, index) => `"%MANCODE_UPGRADE_ARG_${index}%"`).join(' ')}`,
        ];
      } else {
        throw new Error(`Unsupported upgrade test shell: ${testShell}`);
      }
      shellInvocations.push({ shim, args });
    }
    const result = await execute(command, commandArgs, {
      cwd,
      env,
      // CMD parses this prequoted command string itself; Node's default Windows
      // argv quoting would turn its quotes into literal backslash-quote pairs.
      windowsVerbatimArguments:
        process.platform === 'win32' && testShell === 'cmd',
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return result.stdout;
  }
  async function interruptedCli(
    entry: string,
    args: string[],
    project: string,
    prefix: string,
    fault: string,
    marker: string,
    trace: string,
  ) {
    try {
      const result = await execute(process.execPath, [entry, ...args], {
        cwd: project,
        env: {
          ...envFor(prefix),
          MANCODE_FIXTURE_FAULT: fault,
          MANCODE_FIXTURE_FAULT_MARKER: marker,
          MANCODE_FIXTURE_INSTALL_TRACE: trace,
        },
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        signal?: string;
      };
      if (typeof failure.code !== 'number') throw error;
      return {
        code: failure.code,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  }
  beforeAll(async () => {
    if (!binary) throw new Error('Explicit candidate build required');
    if (testBase) await mkdir(testBase, { recursive: true });
    root = await realpath(
      await mkdtemp(path.join(testBase ?? tmpdir(), 'upgrade-e2e-')),
    );
    npm = await resolveUpgradeNpmEntry();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture registry failed');
    registry = `http://127.0.0.1:${address.port}`;
    const sourceRoot = path.dirname(path.dirname(binary));
    targetPackage = JSON.parse(
      await readFile(path.join(sourceRoot, 'package.json'), 'utf8'),
    );
    targetVersion = String(targetPackage.version);
    newerVersion = inc(targetVersion, 'patch') ?? '';
    if (!newerVersion) throw new Error('Invalid target fixture version');
    oldVersion = '0.6.7';
    const dependencies = targetPackage.dependencies as Record<string, string>;
    for (const version of [oldVersion, targetVersion, newerVersion]) {
      const pkg = path.join(root, `package-${version}`);
      await mkdir(pkg);
      await cp(path.join(sourceRoot, 'dist'), path.join(pkg, 'dist'), {
        recursive: true,
      });
      const metadata = {
        ...targetPackage,
        version,
        scripts: {},
        files: ['dist'],
        bundledDependencies: Object.keys(dependencies),
        devDependencies: {},
        overrides: {},
      };
      await writeFile(path.join(pkg, 'package.json'), JSON.stringify(metadata));
      const copied = new Set<string>();
      async function copyDependency(name: string) {
        if (copied.has(name)) return;
        copied.add(name);
        const from = path.join(sourceRoot, 'node_modules', name);
        await cp(from, path.join(pkg, 'node_modules', name), {
          recursive: true,
          dereference: true,
        });
        const dep = JSON.parse(
          await readFile(path.join(from, 'package.json'), 'utf8'),
        );
        for (const child of Object.keys(dep.dependencies ?? {}))
          await copyDependency(child);
      }
      for (const name of Object.keys(dependencies)) await copyDependency(name);
      const fixtureCli = path.join(pkg, 'dist/cli.js');
      await writeFile(
        fixtureCli,
        instrumentFixtureCli(await readFile(fixtureCli, 'utf8')),
      );
      if (version === oldVersion) {
        for (const file of await readdir(path.join(pkg, 'dist'))) {
          if (!file.endsWith('.js')) continue;
          const target = path.join(pkg, 'dist', file);
          const text = await readFile(target, 'utf8');
          await writeFile(
            target,
            text.replaceAll(
              'Before the first command,',
              'UPGRADE_OLD_RENDERER Before the first command,',
            ),
          );
        }
      }
      await npmRun(['pack', '--json'], pkg, path.join(root, 'pack-prefix'));
      const archive = path.join(pkg, `mancode-${version}.tgz`);
      const blob = await readFile(archive);
      const route = `/mancode/-/mancode-${version}.tgz`;
      tarballs.set(route, blob);
      versions[version] = {
        ...metadata,
        dist: {
          tarball: `${registry}${route}`,
          integrity: `sha512-${createHash('sha512').update(blob).digest('base64')}`,
        },
      };
      if (version === oldVersion) oldTarball = archive;
    }
  }, 120_000);
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (testShell && root) {
      await writeFile(
        path.join(root, 'shell-entry-results.json'),
        JSON.stringify(
          { shell: testShell, invocations: shellInvocations },
          null,
          2,
        ),
      );
      expect(shellInvocations.some(({ args }) => args[0] === 'upgrade')).toBe(
        true,
      );
    }
    if (root && testBase)
      await writeFile(
        path.join(root, 'registry-requests.json'),
        JSON.stringify(requests, null, 2),
      );
    else if (root) await rm(root, { recursive: true, force: true });
  });
  it('updates a global prefix and publishes rules generated by the new CLI', async () => {
    const prefix = path.join(root, 'global prefix 中文');
    const project = path.join(root, 'global project 中文');
    await mkdir(project);
    await npmRun(
      ['install', '--global', '--prefix', prefix, oldTarball],
      project,
      prefix,
    );
    const packageRoot = path.join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'mancode',
    );
    const entry = path.join(packageRoot, 'dist/cli.js');
    await cli(
      entry,
      ['init', '--platform', 'codex', '--empty', '--yes'],
      project,
      prefix,
    );
    const agents = path.join(project, 'AGENTS.md');
    expect(await readFile(agents, 'utf8')).toContain('UPGRADE_OLD_RENDERER');
    await writeFile(
      agents,
      `${await readFile(agents, 'utf8')}\nCustom user instructions.\n`,
    );
    const output = JSON.parse(
      await cli(
        entry,
        ['upgrade', '--yes', '--name', 'Upgrade Test', '--json'],
        project,
        prefix,
      ),
    );
    expect(output).toMatchObject({
      state: 'completed',
      cli: { status: 'updated', version: targetVersion },
      project: { status: 'updated', ready: true },
    });
    expect((await cli(entry, ['--version'], project, prefix)).trim()).toBe(
      targetVersion,
    );
    const actual = await readFile(agents, 'utf8');
    expect(actual).not.toContain('UPGRADE_OLD_RENDERER');
    expect(actual).toContain('Custom user instructions.');
    const state = JSON.parse(
      await cli(entry, ['adapter', 'status', '--json'], project, prefix),
    );
    expect(state.ready).toBe(true);
    expect(Object.keys(state.manifestAdapters)).toEqual(['codex']);
    const second = JSON.parse(
      await cli(entry, ['upgrade', '--yes', '--json'], project, prefix),
    );
    expect(second).toMatchObject({
      state: 'completed',
      cli: { status: 'ready' },
      project: { status: 'ready' },
    });
    await writeFile(
      path.join(root, 'global-result.json'),
      JSON.stringify({ output, second, ready: state.ready }, null, 2),
    );
  }, 120_000);
  it('updates a local dependency and its lockfile without changing its declaration style', async () => {
    const prefix = path.join(root, 'unused global');
    const project = path.join(root, 'local project 中文');
    await mkdir(project);
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({
        name: 'upgrade-fixture',
        private: true,
        devDependencies: { mancode: `~${oldVersion}` },
      }),
    );
    await npmRun(
      [
        'install',
        `mancode@${oldVersion}`,
        '--save-dev',
        '--save-prefix',
        '~',
        '--prefix',
        project,
      ],
      project,
      prefix,
    );
    const entry = path.join(project, 'node_modules/mancode/dist/cli.js');
    await cli(entry, ['init', '--platform', 'codex', '--yes'], project, prefix);
    const output = JSON.parse(
      await cli(
        entry,
        ['upgrade', '--yes', '--name', 'Local Upgrade Test', '--json'],
        project,
        prefix,
      ),
    );
    expect(output).toMatchObject({
      state: 'completed',
      cli: { version: targetVersion, declaration: `~${targetVersion}` },
      project: { status: 'updated' },
    });
    const manifest = JSON.parse(
      await readFile(path.join(project, 'package.json'), 'utf8'),
    );
    expect(manifest.devDependencies.mancode).toBe(`~${targetVersion}`);
    const lock = JSON.parse(
      await readFile(path.join(project, 'package-lock.json'), 'utf8'),
    );
    expect(lock.packages['node_modules/mancode'].version).toBe(targetVersion);
    await writeFile(
      path.join(root, 'local-result.json'),
      JSON.stringify(
        { output, declaration: manifest.devDependencies.mancode },
        null,
        2,
      ),
    );
  }, 120_000);
  it('honors project-only interruption (real SIGINT on POSIX) after saving its receipt and resumes safely', async () => {
    const project = path.join(root, 'project-only SIGINT 中文');
    const prefix = path.join(root, 'project-only-prefix');
    const entry = path.join(root, `package-${targetVersion}`, 'dist/cli.js');
    const marker = path.join(root, 'project-only-sigint-fault.json');
    const trace = path.join(root, 'project-only-sigint-trace.jsonl');
    await mkdir(project);
    await cli(
      entry,
      ['init', '--platform', 'codex', '--empty', '--yes'],
      project,
      prefix,
    );
    const skill = path.join(project, '.agents/skills/man/SKILL.md');
    const original = `${await readFile(skill, 'utf8')}\nobsolete managed content`;
    await writeFile(skill, original);
    const args = [
      'upgrade',
      '--project-only',
      '--yes',
      '--name',
      'Signal Test',
      '--json',
    ];
    const first = await interruptedCli(
      entry,
      args,
      project,
      prefix,
      'project-receipt',
      marker,
      trace,
    );
    expect(first.code, first.stdout || first.stderr).toBe(130);
    expect(JSON.parse(first.stdout).state).toBe('interrupted');
    expect(await readFile(skill, 'utf8')).toBe(original);
    const receiptFile = path.join(
      project,
      '.mancode/local/upgrade/continuation.json',
    );
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    await expect(
      readFile(
        path.join(
          project,
          '.mancode/local/runtime/operations',
          `${receipt.operationId}.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const second = await interruptedCli(
      entry,
      args,
      project,
      prefix,
      'project-receipt',
      marker,
      trace,
    );
    expect(second.code, second.stdout || second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).project).toMatchObject({
      ready: true,
      status: 'updated',
    });
    expect(await readFile(skill, 'utf8')).not.toContain(
      'obsolete managed content',
    );
    await expect(readFile(receiptFile)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await writeFile(
      path.join(root, 'project-only-sigint-result.json'),
      JSON.stringify(
        { first, second, receipt, platform: process.platform },
        null,
        2,
      ),
    );
  }, 120_000);
  it('requires a fresh preview when a persistent CLI changes version after the confirmed installation', async () => {
    const project = path.join(root, 'persistent version drift 中文');
    const prefix = path.join(root, 'persistent version drift prefix 中文');
    const marker = path.join(root, 'persistent-version-drift-fault.json');
    const trace = path.join(root, 'persistent-version-drift-trace.jsonl');
    await mkdir(project);
    await npmRun(
      ['install', '--global', '--prefix', prefix, oldTarball],
      project,
      prefix,
    );
    const entry = path.join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'mancode/dist/cli.js',
    );
    await cli(
      entry,
      ['init', '--platform', 'codex', '--empty', '--yes'],
      project,
      prefix,
    );
    const first = await interruptedCli(
      entry,
      ['upgrade', '--yes', '--name', 'Version Drift Test', '--json'],
      project,
      prefix,
      'after-install',
      marker,
      trace,
    );
    expect(first.code, first.stdout || first.stderr).toBe(130);
    const receiptFile = path.join(
      project,
      '.mancode/local/upgrade/continuation.json',
    );
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    expect(receipt).toMatchObject({
      phase: 'project',
      targetVersion,
      installationEntry: entry,
    });
    const agents = path.join(project, 'AGENTS.md');
    const before = await readFile(agents, 'utf8');
    // An actual original-package-manager update, not an edited receipt/version mock.
    await npmRun(
      ['install', '--global', '--prefix', prefix, `mancode@${newerVersion}`],
      project,
      prefix,
    );
    expect((await cli(entry, ['--version'], project, prefix)).trim()).toBe(
      newerVersion,
    );
    const retry = (args: string[]) =>
      interruptedCli(
        entry,
        args,
        project,
        prefix,
        'after-install',
        marker,
        trace,
      );
    const changed = await retry([
      'upgrade',
      '--project-only',
      '--yes',
      '--json',
    ]);
    expect(changed.code).toBe(4);
    expect(JSON.parse(changed.stdout).code).toBe(
      'MANCODE_UPGRADE_PREVIEW_VERSION_CHANGED',
    );
    expect(await readFile(agents, 'utf8')).toBe(before);
    await expect(readFile(receiptFile)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const unconfirmed = await retry(['upgrade', '--project-only', '--json']);
    expect(unconfirmed.code).toBe(2);
    expect(await readFile(agents, 'utf8')).toBe(before);
    const confirmed = JSON.parse(
      await cli(
        entry,
        ['upgrade', '--project-only', '--yes', '--json'],
        project,
        prefix,
      ),
    );
    expect(confirmed).toMatchObject({
      state: 'completed',
      project: { status: 'updated', ready: true },
    });
    expect(await readFile(agents, 'utf8')).not.toContain(
      'UPGRADE_OLD_RENDERER',
    );
    await writeFile(
      path.join(root, 'persistent-version-drift-result.json'),
      JSON.stringify(
        { first, receipt, changed, unconfirmed, confirmed, newerVersion },
        null,
        2,
      ),
    );
  }, 120_000);
  it.each([
    'before-install',
    'after-install',
    'adapter:prepared',
    'adapter:replace-managed-adapters:agents',
    'adapter:commit',
    'install-result-unknown',
  ])(
    'preserves and resumes the real upgrade at %s',
    async (fault) => {
      const label = fault.replaceAll(':', '-').replaceAll('/', '-');
      const project = path.join(root, `interruption ${label} 中文`);
      const prefix = path.join(root, `interruption-prefix ${label} 中文`);
      const marker = path.join(root, `${label}-fault.json`);
      const trace = path.join(root, `${label}-install-trace.jsonl`);
      await mkdir(project);
      await writeFile(trace, '');
      await npmRun(
        ['install', '--global', '--prefix', prefix, oldTarball],
        project,
        prefix,
      );
      const packageRoot = path.join(
        prefix,
        process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
        'mancode',
      );
      const entry = path.join(packageRoot, 'dist/cli.js');
      await cli(
        entry,
        ['init', '--platform', 'codex', '--empty', '--yes'],
        project,
        prefix,
      );
      const agents = path.join(project, 'AGENTS.md');
      await writeFile(
        agents,
        `${await readFile(agents, 'utf8')}\nPreserve interruption fixture content.\n`,
      );
      const args = [
        'upgrade',
        '--yes',
        '--name',
        'Interruption User',
        '--json',
      ];
      const first = await interruptedCli(
        entry,
        args,
        project,
        prefix,
        fault,
        marker,
        trace,
      );
      expect(first.code, first.stdout || first.stderr).not.toBe(0);
      if (!fault.startsWith('adapter:')) expect(first.code).toBe(130);
      const observation = JSON.parse(await readFile(marker, 'utf8'));
      expect(observation).toMatchObject({
        point: fault,
        pid: expect.any(Number),
        interruption:
          fault.startsWith('adapter:') || process.platform === 'win32'
            ? 'exception'
            : 'signal',
      });
      const receiptFile = path.join(
        project,
        '.mancode/local/upgrade/continuation.json',
      );
      const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
      const installedVersion = (
        await cli(entry, ['--version'], project, prefix)
      ).trim();
      expect(installedVersion).toBe(
        fault === 'before-install' ? oldVersion : targetVersion,
      );
      expect(receipt.phase).toBe(
        fault === 'before-install' || fault === 'install-result-unknown'
          ? 'installing'
          : 'project',
      );
      const journalFile = path.join(
        project,
        '.mancode/local/runtime/operations',
        `${receipt.operationId}.json`,
      );
      let journalBefore: {
        state: string;
        operationId: string;
        type: string;
      } | null = null;
      if (fault.startsWith('adapter:')) {
        journalBefore = JSON.parse(await readFile(journalFile, 'utf8'));
        expect(journalBefore).toMatchObject({
          operationId: receipt.operationId,
          type: 'adapter_upgrade',
        });
        expect(journalBefore?.state).toBe(
          fault === 'adapter:prepared'
            ? 'aborted'
            : fault === 'adapter:commit'
              ? 'committed'
              : 'repair_required',
        );
      }
      const attemptsBefore = (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean).length;
      const second = await interruptedCli(
        entry,
        args,
        project,
        prefix,
        fault,
        marker,
        trace,
      );
      const attemptsAfter = (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean).length;
      const output = JSON.parse(second.stdout);
      let explicitProjectRecovery: unknown = null;
      if (fault === 'install-result-unknown') {
        expect(second.code).not.toBe(0);
        expect(output.code).toBe('MANCODE_UPGRADE_INSTALL_RESULT_UNKNOWN');
        expect(attemptsAfter).toBe(attemptsBefore);
        expect(
          JSON.parse(await readFile(receiptFile, 'utf8')).operationId,
        ).toBe(receipt.operationId);
        expect(await readFile(agents, 'utf8')).toContain(
          'UPGRADE_OLD_RENDERER',
        );
        // After inspecting the installed target, the operator explicitly chooses
        // project recovery. This does not replay the uncertain package install.
        const recovery = await interruptedCli(
          entry,
          ['upgrade', '--project-only', '--yes', '--json'],
          project,
          prefix,
          fault,
          marker,
          trace,
        );
        expect(recovery.code, recovery.stdout || recovery.stderr).toBe(0);
        explicitProjectRecovery = JSON.parse(recovery.stdout);
        expect(explicitProjectRecovery).toMatchObject({
          project: { status: 'updated', ready: true },
        });
        expect(await readFile(agents, 'utf8')).not.toContain(
          'UPGRADE_OLD_RENDERER',
        );
        expect(
          (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean),
        ).toHaveLength(attemptsAfter);
        await expect(readFile(receiptFile, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        expect(second.code, second.stdout || second.stderr).toBe(0);
        expect(output.state).toBe('completed');
        // The trace counts installPackage entries, including a POSIX SIGINT
        // rejected by its abort signal before npm starts. Only before-install
        // recovery may enter it again; installedVersion above proves no first write.
        expect(attemptsAfter).toBe(
          fault === 'before-install' && process.platform !== 'win32' ? 2 : 1,
        );
        expect(attemptsAfter - attemptsBefore).toBe(
          fault === 'before-install' ? 1 : 0,
        );
        const actual = await readFile(agents, 'utf8');
        expect(actual).not.toContain('UPGRADE_OLD_RENDERER');
        expect(actual).toContain('Preserve interruption fixture content.');
        expect(
          JSON.parse(
            await cli(entry, ['adapter', 'status', '--json'], project, prefix),
          ).ready,
        ).toBe(true);
        await expect(readFile(receiptFile, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        if (journalBefore) {
          const journalAfter = JSON.parse(await readFile(journalFile, 'utf8'));
          // A safely aborted pre-write journal is retained, never overwritten.
          expect(journalAfter.state).toBe(
            fault === 'adapter:prepared' ? 'aborted' : 'committed',
          );
          expect(journalAfter.operationId).toBe(receipt.operationId);
        }
      }
      await writeFile(
        path.join(root, `${label}-result.json`),
        JSON.stringify(
          {
            fault,
            platform: process.platform,
            node: process.version,
            observation,
            first,
            second,
            explicitProjectRecovery,
            receipt,
            journalBefore,
            attemptsBefore,
            attemptsAfter,
          },
          null,
          2,
        ),
      );
    },
    120_000,
  );
});

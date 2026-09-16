import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { lt, prerelease, satisfies, valid, validRange } from 'semver';
import { createUlid } from '../context/ids.js';
import { acquireLocalLock } from '../runtime/local-lock.js';
import {
  type UpgradeInstallation,
  detectUpgradeInstallation,
} from './upgrade-installation.js';

const execute = promisify(execFile);
export type UpgradeCommandRunner = (
  args: string[],
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;
export interface UpgradeTarget {
  version: string;
  integrity: string;
  tarball: string;
  registry: string;
  nodeRange?: string;
}
export interface UpgradeCandidate {
  rootDir: string;
  packageRoot: string;
  entryPath: string;
  version: string;
  integrity: string;
  packageDigest: string;
  cleanup(): Promise<void>;
}
export class UpgradePackageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UpgradePackageError';
  }
}

/** Resolve npm's JavaScript entry, including Windows installations, without a shell. */
export async function resolveUpgradeNpmEntry(): Promise<string> {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      'node_modules/npm/bin/npm-cli.js',
    ),
    path.resolve(
      path.dirname(process.execPath),
      '../lib/node_modules/npm/bin/npm-cli.js',
    ),
  ];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    candidates.push(
      path.join(directory, 'npm'),
      path.join(directory, 'node_modules/npm/bin/npm-cli.js'),
    );
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const real = await fs.realpath(candidate);
      if (path.basename(real) !== 'npm-cli.js') continue;
      const pkg = JSON.parse(
        await fs.readFile(path.resolve(real, '../../package.json'), 'utf8'),
      ) as { name?: string };
      if (pkg.name === 'npm') return real;
    } catch (error) {
      if (
        !['ENOENT', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  }
  throw new UpgradePackageError(
    'MANCODE_UPGRADE_NPM_UNAVAILABLE',
    'Cannot locate npm-cli.js; update with the original package manager.',
  );
}

export const runUpgradeNpm: UpgradeCommandRunner = async (args, options) => {
  const npm = await resolveUpgradeNpmEntry();
  const supervised = args[0] === 'install';
  let helperRoot: string | undefined;
  try {
    let childArgs = [npm, ...args];
    if (supervised) {
      helperRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'mancode-npm-helper-'),
      );
      await fs.chmod(helperRoot, 0o700);
      const helper = path.join(helperRoot, 'install.cjs');
      // This standalone supervisor remains available while npm replaces the old CLI.
      await fs.writeFile(helper, NPM_INSTALL_SUPERVISOR, { mode: 0o600 });
      childArgs = [
        helper,
        npm,
        JSON.stringify(args),
        String(process.pid),
        String(options.timeoutMs ?? 120_000),
      ];
    }
    return await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        if (supervised && options.signal?.aborted) {
          reject(new Error('npm installation was cancelled before starting.'));
          return;
        }
        let completion:
          | { error: Error | null; stdout: string; stderr: string }
          | undefined;
        const child = execFile(
          process.execPath,
          childArgs,
          {
            cwd: options.cwd,
            // Killing the supervisor is not cancellation: on Windows its npm
            // child would survive. The supervisor owns timeout and termination.
            signal: supervised ? undefined : options.signal,
            timeout: supervised ? 0 : (options.timeoutMs ?? 30_000),
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            completion = { error, stdout, stderr };
          },
        );
        const cancelInstallation = () => {
          if (child.stdin?.writable) child.stdin.write('cancel\n');
        };
        let cancellationError: Error | undefined;
        if (supervised) {
          // A close racing cancellation can close stdin first. The subprocess
          // result remains the authority for success or failure in that case.
          child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')
              return;
            cancellationError = error;
            child.stdin?.destroy();
          });
          options.signal?.addEventListener('abort', cancelInstallation, {
            once: true,
          });
          if (options.signal?.aborted) cancelInstallation();
        }
        // Abort callbacks can run before npm has stopped. Keep the installation
        // lock until the supervisor actually closes its process and output pipes.
        child.once('close', () => {
          options.signal?.removeEventListener('abort', cancelInstallation);
          if (!completion) {
            reject(new Error('npm supervisor closed without a result.'));
            return;
          }
          if (completion.error) reject(completion.error);
          else if (cancellationError) reject(cancellationError);
          else
            resolve({ stdout: completion.stdout, stderr: completion.stderr });
        });
      },
    );
  } catch (error) {
    const failure = error as Error & {
      stderr?: string;
      code?: string | number;
    };
    // npm output may contain registry credentials; retain the original cause privately.
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_NPM_FAILED',
      `npm ${args[0] ?? ''} failed (${failure.code ?? failure.name}). ${redactUpgradeOutput(failure.stderr ?? failure.message)}`,
      { cause: error },
    );
  } finally {
    if (helperRoot) await fs.rm(helperRoot, { recursive: true, force: true });
  }
};

const NPM_INSTALL_SUPERVISOR = `
const { execFile } = require('node:child_process');
const [npm, json, parent, timeout] = process.argv.slice(2);
let stopped = false;
const child = execFile(process.execPath, [npm, ...JSON.parse(json)], {
  encoding: 'utf8', timeout: Number(timeout), killSignal: 'SIGKILL', maxBuffer: 4194304, windowsHide: true
}, (error, stdout, stderr) => {
  clearInterval(monitor);
  process.stdin.destroy();
  process.stdout.write(stdout || '');
  process.stderr.write(stderr || '');
  if (error && !stderr) process.stderr.write(error.message);
  process.exitCode = stopped ? 130 : error ? 1 : 0;
});
const stop = () => { stopped = true; child.kill('SIGKILL'); };
let control = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  control = (control + chunk).slice(0, 64);
  if (control.includes('cancel\\n')) stop();
});
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const monitor = setInterval(() => {
  try { process.kill(Number(parent), 0); }
  catch (error) { if (error.code === 'ESRCH') stop(); }
}, 250);
`;

export function redactUpgradeOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(
      /((?:_authToken|_auth|token|password)\s*[=:]\s*)[^\s]+/gi,
      '$1[redacted]',
    )
    .slice(0, 2000);
}

export async function resolveUpgradeTarget(options: {
  currentVersion: string;
  to?: string;
  cwd: string;
  run?: UpgradeCommandRunner;
  signal?: AbortSignal;
  nodeVersion?: string;
  registry?: string;
}): Promise<UpgradeTarget> {
  if (options.to && valid(options.to) !== options.to)
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INVALID_TARGET',
      '--to requires an exact SemVer version.',
    );
  if (!valid(options.currentVersion))
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INVALID_VERSION',
      'The installed version is not valid SemVer.',
    );
  const run = options.run ?? runUpgradeNpm;
  const config = options.registry
    ? { stdout: options.registry }
    : await run(['config', 'get', 'registry'], {
        cwd: options.cwd,
        signal: options.signal,
        timeoutMs: 15_000,
      });
  const registry = config.stdout.trim();
  assertRegistryUrl(registry);
  const output = await run(
    [
      'view',
      `mancode@${options.to ?? 'latest'}`,
      '--json',
      '--registry',
      registry,
    ],
    { cwd: options.cwd, signal: options.signal, timeoutMs: 30_000 },
  );
  let data: {
    version?: string;
    dist?: { integrity?: string; tarball?: string };
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  try {
    data = JSON.parse(output.stdout) as typeof data;
  } catch (cause) {
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INVALID_METADATA',
      'npm returned invalid package metadata.',
      { cause },
    );
  }
  const version = data.version;
  if (
    !version ||
    valid(version) !== version ||
    (options.to && version !== options.to) ||
    (!options.to && prerelease(version))
  )
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INVALID_TARGET',
      'Registry did not resolve an exact permitted target version.',
    );
  if (lt(version, options.currentVersion))
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_DOWNGRADE',
      `Refusing to downgrade ${options.currentVersion} to ${version}.`,
    );
  const nodeRange = data.engines?.node;
  if (
    nodeRange &&
    (!validRange(nodeRange) ||
      !satisfies(options.nodeVersion ?? process.versions.node, nodeRange))
  )
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_NODE_ENGINE',
      `Target requires Node ${nodeRange}; current Node is ${options.nodeVersion ?? process.versions.node}.`,
    );
  if (
    !data.dist?.integrity ||
    !/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/.test(data.dist.integrity) ||
    !data.dist.tarball
  )
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INTEGRITY',
      'Target metadata has no supported integrity binding.',
    );
  assertRegistryUrl(data.dist.tarball);
  if (
    ['preinstall', 'install', 'postinstall'].some(
      (name) => data.scripts?.[name],
    )
  )
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INSTALL_SCRIPTS',
      'Target package requires installation scripts. Update explicitly with the original package manager.',
    );
  return {
    version,
    integrity: data.dist.integrity,
    tarball: data.dist.tarball,
    registry,
    ...(nodeRange ? { nodeRange } : {}),
  };
}

function assertRegistryUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INVALID_METADATA',
      'Invalid registry URL.',
    );
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INVALID_METADATA',
      'Registry URLs must use HTTP(S) without embedded credentials.',
    );
}

export async function verifyUpgradeExecutable(
  entryPath: string,
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await execute(process.execPath, [entryPath, '--version'], {
    signal,
    timeout: 15_000,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (result.stdout.trim() !== version)
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_VERSION_MISMATCH',
      'The installed CLI did not report the frozen target version.',
    );
}

async function packageDigest(packageRoot: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const file = path.join(directory, entry.name);
      const relative = path
        .relative(packageRoot, file)
        .split(path.sep)
        .join('/');
      if (entry.isSymbolicLink())
        throw new UpgradePackageError(
          'MANCODE_UPGRADE_UNSAFE_PACKAGE',
          'Package contains a symbolic link.',
        );
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        hash.update(`${relative}\0`);
        hash.update(await fs.readFile(file));
        hash.update('\0');
      }
    }
  }
  await visit(packageRoot);
  return hash.digest('hex');
}

async function packageEntry(
  packageRoot: string,
  version: string,
): Promise<string> {
  const metadata = JSON.parse(
    await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    name?: string;
    version?: string;
    bin?: string | { mancode?: string };
    scripts?: Record<string, string>;
  };
  if (metadata.name !== 'mancode' || metadata.version !== version)
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_VERSION_MISMATCH',
      'Package metadata does not match the frozen target.',
    );
  if (
    ['preinstall', 'install', 'postinstall'].some(
      (name) => metadata.scripts?.[name],
    )
  )
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INSTALL_SCRIPTS',
      'Package installation scripts cannot be silently enabled.',
    );
  const bin =
    typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.mancode;
  if (!bin)
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INVALID_METADATA',
      'Target has no mancode bin.',
    );
  const entryPath = await fs.realpath(path.resolve(packageRoot, bin));
  const relative = path.relative(await fs.realpath(packageRoot), entryPath);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_UNSAFE_PACKAGE',
      'Package bin escapes its installation.',
    );
  return entryPath;
}

export async function prepareUpgradeCandidate(options: {
  target: UpgradeTarget;
  cwd: string;
  tempRoot?: string;
  run?: UpgradeCommandRunner;
  signal?: AbortSignal;
}): Promise<UpgradeCandidate> {
  const rootDir = await fs.realpath(
    await fs.mkdtemp(
      path.join(options.tempRoot ?? os.tmpdir(), 'mancode-upgrade-'),
    ),
  );
  await fs.chmod(rootDir, 0o700);
  try {
    await fs.writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({
        name: 'mancode-upgrade-candidate',
        private: true,
        version: '0.0.0',
      }),
      { mode: 0o600 },
    );
    await (options.run ?? runUpgradeNpm)(
      [
        'install',
        `mancode@${options.target.version}`,
        '--prefix',
        rootDir,
        '--save-exact',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        options.target.registry,
      ],
      { cwd: options.cwd, timeoutMs: 120_000, signal: options.signal },
    );
    const lock = JSON.parse(
      await fs.readFile(path.join(rootDir, 'package-lock.json'), 'utf8'),
    ) as {
      packages?: Record<
        string,
        { integrity?: string; resolved?: string; hasInstallScript?: boolean }
      >;
    };
    const installed = lock.packages?.['node_modules/mancode'];
    if (
      installed?.integrity !== options.target.integrity ||
      installed.resolved !== options.target.tarball
    )
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_INTEGRITY',
        'Candidate does not match the frozen registry package.',
      );
    if (Object.values(lock.packages ?? {}).some((pkg) => pkg.hasInstallScript))
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_INSTALL_SCRIPTS',
        'A target dependency requires installation scripts; automatic installation is unavailable.',
      );
    const packageRoot = path.join(rootDir, 'node_modules/mancode');
    const entryPath = await packageEntry(packageRoot, options.target.version);
    await verifyUpgradeExecutable(
      entryPath,
      options.target.version,
      options.signal,
    );
    return {
      rootDir,
      packageRoot,
      entryPath,
      version: options.target.version,
      integrity: options.target.integrity,
      packageDigest: await packageDigest(packageRoot),
      cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

export function buildUpgradeInstallArgs(
  installation: UpgradeInstallation,
  target: UpgradeTarget,
): string[] {
  if (installation.kind !== 'npm-global' && installation.kind !== 'npm-local')
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_UNSUPPORTED_INSTALLATION',
      installation.reason ?? 'Choose a supported persistent installation.',
    );
  const args = [
    'install',
    `mancode@${target.version}`,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-bundle=false',
    '--registry',
    target.registry,
  ];
  if (installation.kind === 'npm-global') {
    if (!installation.prefix)
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_INVALID_INSTALLATION',
        'Missing npm global prefix.',
      );
    return [...args, '--global', '--prefix', installation.prefix];
  }
  if (
    !installation.projectRoot ||
    !installation.dependencySection ||
    !installation.versionStyle
  )
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INVALID_INSTALLATION',
      'Missing npm dependency ownership.',
    );
  const save = {
    dependencies: '--save-prod',
    devDependencies: '--save-dev',
    optionalDependencies: '--save-optional',
  }[installation.dependencySection];
  return [
    ...args,
    '--prefix',
    installation.projectRoot,
    '--package-lock=true',
    save,
    ...(installation.versionStyle === 'exact'
      ? ['--save-exact']
      : ['--save-exact=false', `--save-prefix=${installation.versionStyle}`]),
  ];
}

interface ScriptDependencySnapshot {
  version: string;
  integrity?: string;
  device: number;
  inode: number;
  modified: number;
}

async function scriptDependencies(
  projectRoot: string,
): Promise<Record<string, ScriptDependencySnapshot>> {
  let lock:
    | {
        packages?: Record<
          string,
          { version?: string; integrity?: string; hasInstallScript?: boolean }
        >;
      }
    | undefined;
  for (const filename of [
    'npm-shrinkwrap.json',
    'package-lock.json',
    'node_modules/.package-lock.json',
  ]) {
    try {
      lock = JSON.parse(
        await fs.readFile(path.join(projectRoot, filename), 'utf8'),
      ) as typeof lock;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const result: Record<string, ScriptDependencySnapshot> = {};
  for (const [relative, pkg] of Object.entries(lock?.packages ?? {})) {
    if (!pkg.hasInstallScript) continue;
    const directory = path.resolve(projectRoot, relative);
    if (
      !relative.startsWith('node_modules/') ||
      path.relative(projectRoot, directory).startsWith('..')
    )
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_INSTALL_SCRIPTS',
        'A workspace or linked dependency requires its original installation workflow.',
      );
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(directory, 'package.json'), 'utf8'),
      ) as { version?: string };
      const stat = await fs.stat(directory);
      if (!manifest.version || manifest.version !== pkg.version)
        throw new Error('Installed dependency does not match its lockfile.');
      result[relative] = {
        version: manifest.version,
        integrity: pkg.integrity,
        device: stat.dev,
        inode: stat.ino,
        modified: stat.mtimeMs,
      };
    } catch (cause) {
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_INSTALL_SCRIPTS',
        `Dependency ${relative} requires its original install scripts; restore the existing installation before upgrading.`,
        { cause },
      );
    }
  }
  return result;
}

/** npm runs in its own Node process; loaded old modules are never re-imported during replacement. */
export async function installUpgradePackage(options: {
  installation: UpgradeInstallation;
  target: UpgradeTarget;
  candidate: UpgradeCandidate;
  run?: UpgradeCommandRunner;
  signal?: AbortSignal;
  lockRoot?: string;
}): Promise<{ entryPath: string; version: string }> {
  const { installation, target, candidate } = options;
  const args = buildUpgradeInstallArgs(installation, target);
  if (
    candidate.version !== target.version ||
    candidate.integrity !== target.integrity ||
    (await packageDigest(candidate.packageRoot)) !== candidate.packageDigest
  )
    throw new UpgradePackageError(
      'MANCODE_UPGRADE_INTEGRITY',
      'The prepared candidate has changed.',
    );
  const location = await fs.realpath(
    installation.prefix ?? installation.projectRoot ?? installation.packageRoot,
  );
  const lockKey = createHash('sha256')
    .update(process.platform === 'win32' ? location.toLowerCase() : location)
    .digest('hex');
  const id = createUlid();
  const lock = await acquireLocalLock(
    {
      kind: 'checkout_local',
      root:
        options.lockRoot ??
        path.join(
          os.tmpdir(),
          `mancode-package-upgrade-${process.getuid?.() ?? 'user'}`,
        ),
      storeId: 'mancode-package-upgrade',
      workspaceId: id,
      checkoutId: null,
      repositoryBindingId: null,
    },
    {
      operationId: id,
      entityLockKey: `installation:${lockKey}`,
      leaseMs: 300_000,
    },
  );
  try {
    const current = await detectUpgradeInstallation({
      cwd: installation.projectRoot ?? location,
      entryPath: installation.entryPath,
      selectedInstallation: true,
      run: options.run,
    });
    if (
      current.kind !== installation.kind ||
      current.packageRoot !== installation.packageRoot ||
      current.version !== installation.version ||
      current.declaration !== installation.declaration
    )
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_INSTALLATION_CHANGED',
        'Installation changed after preview; check and confirm again.',
      );
    const cwd = installation.projectRoot ?? candidate.rootDir;
    const scriptsBefore = installation.projectRoot
      ? await scriptDependencies(installation.projectRoot)
      : {};
    const run = options.run ?? runUpgradeNpm;
    const refreshed = await resolveUpgradeTarget({
      currentVersion: installation.version,
      to: target.version,
      registry: target.registry,
      cwd,
      run,
      signal: options.signal,
    });
    if (
      refreshed.integrity !== target.integrity ||
      refreshed.tarball !== target.tarball ||
      refreshed.registry !== target.registry
    )
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_INTEGRITY',
        'Registry target changed after preview.',
      );
    await run(args, { cwd, timeoutMs: 120_000, signal: options.signal });
    if (installation.projectRoot) {
      const scriptsAfter = await scriptDependencies(installation.projectRoot);
      if (JSON.stringify(scriptsAfter) !== JSON.stringify(scriptsBefore))
        throw new UpgradePackageError(
          'MANCODE_UPGRADE_INSTALL_SCRIPTS',
          'npm changed a dependency that requires install scripts. Installation is not fully verified; use the original package manager to finish its setup.',
        );
    }
    const entryPath = await packageEntry(
      installation.packageRoot,
      target.version,
    );
    if (
      (await packageDigest(installation.packageRoot)) !==
      candidate.packageDigest
    )
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_INTEGRITY',
        'Installed package differs from the approved candidate. CLI installation is not verified.',
      );
    await verifyUpgradeExecutable(entryPath, target.version, options.signal);
    if (installation.kind === 'npm-local') {
      const after = await detectUpgradeInstallation({
        cwd,
        entryPath,
        selectedInstallation: true,
        run,
      });
      if (
        after.dependencySection !== installation.dependencySection ||
        after.versionStyle !== installation.versionStyle ||
        after.declaration !==
          `${installation.versionStyle === 'exact' ? '' : installation.versionStyle}${target.version}`
      )
        throw new UpgradePackageError(
          'MANCODE_UPGRADE_DEPENDENCY_CHANGED',
          'npm did not preserve dependency ownership and version style.',
        );
    }
    return { entryPath, version: target.version };
  } finally {
    await lock.release();
  }
}

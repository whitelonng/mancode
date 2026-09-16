import { promises as fs } from 'node:fs';
import path from 'node:path';
import { valid } from 'semver';
import { type UpgradeCommandRunner, runUpgradeNpm } from './upgrade-package.js';

export type UpgradeDependencySection =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies';
export interface UpgradeInstallation {
  kind: 'npm-global' | 'npm-local' | 'unsupported' | 'ambiguous';
  packageRoot: string;
  entryPath: string;
  version: string;
  prefix?: string;
  projectRoot?: string;
  dependencySection?: UpgradeDependencySection;
  versionStyle?: '^' | '~' | 'exact';
  declaration?: string;
  reason?: string;
  guidance?: string;
  conflicts?: string[];
}

interface PackageMetadata {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readPackage(root: string): Promise<PackageMetadata | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(root, 'package.json'), 'utf8'),
    ) as PackageMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function ancestors(start: string): string[] {
  const result: string[] = [];
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    result.push(current);
    if (path.dirname(current) === current) return result;
  }
}

export async function detectUpgradeInstallation(options: {
  cwd: string;
  entryPath?: string;
  run?: UpgradeCommandRunner;
  selectedInstallation?: boolean;
}): Promise<UpgradeInstallation> {
  const input = path.resolve(options.entryPath ?? process.argv[1] ?? '');
  let entryPath: string;
  try {
    entryPath = await fs.realpath(input);
  } catch {
    return {
      kind: 'unsupported',
      packageRoot: '',
      entryPath: input,
      version: 'unknown',
      reason: 'CLI entry cannot be resolved.',
      guidance:
        'Use your original package manager to install a persistent mancode CLI.',
    };
  }
  let packageRoot = '';
  let metadata: PackageMetadata | null = null;
  for (const root of ancestors(path.dirname(entryPath))) {
    const value = await readPackage(root);
    if (value?.name === 'mancode') {
      packageRoot = root;
      metadata = value;
      break;
    }
  }
  const result: UpgradeInstallation = {
    kind: 'unsupported',
    packageRoot,
    entryPath,
    version: metadata?.version ?? 'unknown',
  };
  const unsupported = (
    reason: string,
    guidance: string,
  ): UpgradeInstallation => ({ ...result, reason, guidance });
  if (!metadata || !valid(result.version))
    return unsupported(
      'The running entry is not an identifiable mancode package.',
      'Use your original installation method.',
    );
  const bin =
    typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.mancode;
  if (!bin || path.resolve(packageRoot, bin) !== entryPath)
    return unsupported(
      'The running entry does not match the package bin.',
      'Run the original mancode package entry.',
    );
  const segments = packageRoot.split(path.sep);
  if (segments.includes('_npx'))
    return unsupported(
      'This is a temporary npx installation.',
      'Install mancode persistently with your package manager first.',
    );
  if (segments.includes('.pnpm'))
    return unsupported(
      'This installation is managed by pnpm.',
      'Use pnpm update mancode (or pnpm update -g mancode for a global installation).',
    );
  if (await exists(path.join(packageRoot, '.git')))
    return unsupported(
      'This is a source checkout or linked development package.',
      'Update the source checkout using its development workflow; use --project-only for project entries.',
    );
  if (
    path.basename(packageRoot) !== 'mancode' ||
    path.basename(path.dirname(packageRoot)) !== 'node_modules'
  )
    return unsupported(
      'This is a linked, source, or unsupported installation.',
      'Use the original installation method; --project-only remains available.',
    );
  const localRoot = path.dirname(path.dirname(packageRoot));
  const owner = await readPackage(localRoot);
  const sections = (
    ['dependencies', 'devDependencies', 'optionalDependencies'] as const
  ).filter((section) => typeof owner?.[section]?.mancode === 'string');
  if (owner && (sections.length || owner.peerDependencies?.mancode)) {
    result.projectRoot = localRoot;
    for (const root of ancestors(localRoot)) {
      const pkg = await readPackage(root);
      if (pkg?.workspaces)
        return unsupported(
          'npm workspaces require their original workspace update workflow.',
          'Update mancode from the workspace owner using the original package manager.',
        );
      for (const [file, manager] of [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'Yarn'],
        ['bun.lock', 'Bun'],
        ['bun.lockb', 'Bun'],
      ] as const) {
        if (await exists(path.join(root, file)))
          return unsupported(
            `This project is managed by ${manager}.`,
            `Update mancode with ${manager}; --project-only remains available.`,
          );
      }
      if (pkg?.packageManager && !pkg.packageManager.startsWith('npm@'))
        return unsupported(
          `This project uses ${pkg.packageManager.split('@')[0]}.`,
          'Use the declared package manager to update mancode.',
        );
    }
    if (sections.length !== 1 || owner.peerDependencies?.mancode)
      return unsupported(
        'The dependency has multiple or peer ownership declarations.',
        'Update the dependency explicitly with the original package manager.',
      );
    const section = sections[0] as UpgradeDependencySection;
    const declaration = owner[section]?.mancode ?? '';
    const prefix =
      declaration[0] === '^' || declaration[0] === '~' ? declaration[0] : '';
    if (
      !valid(prefix ? declaration.slice(1) : declaration) ||
      valid(prefix ? declaration.slice(1) : declaration) !==
        (prefix ? declaration.slice(1) : declaration)
    )
      return unsupported(
        `Unsupported mancode dependency declaration: ${declaration}`,
        'Update this dependency explicitly; automatic updates preserve only exact, ^ and ~ declarations.',
      );
    Object.assign(result, {
      kind: 'npm-local',
      dependencySection: section,
      versionStyle: prefix || 'exact',
      declaration,
    });
  } else {
    const prefix =
      path.basename(localRoot) === 'lib' ? path.dirname(localRoot) : localRoot;
    const run = options.run ?? runUpgradeNpm;
    const output = await run(['root', '--global', '--prefix', prefix], {
      cwd: options.cwd,
      timeoutMs: 10_000,
    });
    if (path.resolve(output.stdout.trim()) !== path.dirname(packageRoot))
      return unsupported(
        'The package location is not a verified npm global root.',
        'Use the original installation method.',
      );
    // A normal global install has a public bin beside its verified prefix.
    const shim = path.join(
      prefix,
      process.platform === 'win32' ? 'mancode.cmd' : 'bin/mancode',
    );
    if (!(await exists(shim)))
      return unsupported(
        'The global installation has no npm bin entry.',
        'Repair the installation with the original package manager.',
      );
    if (process.platform !== 'win32' && (await fs.realpath(shim)) !== entryPath)
      return unsupported(
        'The global bin points to a different package.',
        'Select the CLI installation you intend to update.',
      );
    Object.assign(result, { kind: 'npm-global', prefix });
  }
  if (!options.selectedInstallation) {
    const conflicts = new Set([entryPath]);
    for (const root of ancestors(options.cwd)) {
      const localPackage = path.join(root, 'node_modules/mancode');
      const pkg = await readPackage(localPackage);
      const localBin =
        typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.mancode;
      if (
        pkg?.name === 'mancode' &&
        localBin &&
        (await exists(path.join(localPackage, localBin)))
      )
        conflicts.add(await fs.realpath(path.join(localPackage, localBin)));
    }
    // When invoked locally, also detect the npm global copy before choosing.
    if (result.kind === 'npm-local') {
      const output = await (options.run ?? runUpgradeNpm)(
        ['root', '--global'],
        { cwd: options.cwd, timeoutMs: 10_000 },
      );
      const globalPackage = path.join(output.stdout.trim(), 'mancode');
      const pkg = await readPackage(globalPackage);
      const globalBin =
        typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.mancode;
      if (
        pkg?.name === 'mancode' &&
        globalBin &&
        (await exists(path.join(globalPackage, globalBin)))
      )
        conflicts.add(await fs.realpath(path.join(globalPackage, globalBin)));
    }
    if (conflicts.size > 1)
      return {
        ...result,
        kind: 'ambiguous',
        conflicts: [...conflicts],
        reason: 'Both local and global CLI installations are present.',
        guidance: 'Select the exact installation before updating.',
      };
  }
  return result;
}

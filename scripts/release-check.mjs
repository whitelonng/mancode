import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const options = parseOptions(process.argv.slice(2));

if (options.help) {
  console.log(
    'Usage: npm run release:check -- --candidate <commit> [--output <report.json>]',
  );
  process.exit(0);
}

const sourceStatus = runCaptured('git', ['status', '--porcelain'], sourceRoot);
assert(sourceStatus === '', 'release check requires a clean source checkout');

const candidate = normalizeCandidate(
  options.candidate ?? runCaptured('git', ['rev-parse', 'HEAD'], sourceRoot),
);
const sourceHead = runCaptured('git', ['rev-parse', 'HEAD'], sourceRoot);
assert(sourceHead === candidate, 'release candidate must equal source HEAD');

const remote = runCaptured('git', ['remote', 'get-url', 'origin'], sourceRoot);
const originDevelop = remoteRef(remote, 'refs/heads/develop');
const originMainBefore = remoteRef(remote, 'refs/heads/main');
assert(
  originMainBefore === candidate,
  'release candidate must equal origin/main',
);

const outputPath = path.resolve(
  sourceRoot,
  options.output ??
    path.join(
      '.mancode',
      'local',
      'release-evidence',
      `${candidate}.json`,
    ),
);
const outputDirectory = path.dirname(outputPath);
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), 'mancode-release-check-'),
);
const checkout = path.join(temporaryRoot, 'checkout');
const installFixture = path.join(temporaryRoot, 'install-smoke');
const checks = [];

try {
  runCheck(checks, 'clean_clone', 'git', [
    'clone',
    '--branch',
    'main',
    '--single-branch',
    remote,
    checkout,
  ], temporaryRoot);
  assert(
    runCaptured('git', ['rev-parse', 'HEAD'], checkout) === candidate,
    'clean checkout does not match the release candidate',
  );

  runCheck(checks, 'npm_ci', 'npm', ['ci'], checkout);
  runCheck(
    checks,
    'prepublish',
    'npm',
    ['run', 'prepublishOnly'],
    checkout,
  );
  runCheck(
    checks,
    'cross_clone',
    'npx',
    [
      'vitest',
      'run',
      'tests/git-ref-cross-clone-e2e.test.ts',
      'tests/git-ref-clock-skew-contracts.test.ts',
      'tests/git-ref-handoff-repair-contracts.test.ts',
    ],
    checkout,
  );
  runCheck(
    checks,
    'legacy_migration',
    'npx',
    [
      'vitest',
      'run',
      'tests/migrate-contracts.test.ts',
      'tests/migrate-command-contracts.test.ts',
      'tests/migration-parity-contracts.test.ts',
      'tests/legacy-cli-compatibility-contracts.test.ts',
    ],
    checkout,
  );

  const audit = JSON.parse(
    runCaptured('npm', ['audit', '--omit=dev', '--json'], checkout),
  );
  const vulnerabilities = audit.metadata?.vulnerabilities?.total;
  assert(vulnerabilities === 0, 'production dependency audit is not clean');
  checks.push({ name: 'production_audit', status: 'passed' });

  const dryRun = parseSinglePackResult(
    runCaptured('npm', ['pack', '--dry-run', '--json'], checkout),
  );
  checks.push({ name: 'pack_dry_run', status: 'passed' });
  const packed = parseSinglePackResult(
    runCaptured('npm', ['pack', '--json'], checkout),
  );
  const tarballPath = path.join(checkout, packed.filename);
  const tarballBytes = await readFile(tarballPath);
  const tarballSha256 = createHash('sha256')
    .update(tarballBytes)
    .digest('hex');

  await mkdir(installFixture, { recursive: true });
  await writeFile(
    path.join(installFixture, 'package.json'),
    `${JSON.stringify({ name: 'mancode-release-install-smoke', private: true })}\n`,
  );
  runCheck(
    checks,
    'tarball_install',
    'npm',
    ['install', '--no-audit', '--no-fund', tarballPath],
    installFixture,
  );
  const installedCli = path.join(
    installFixture,
    'node_modules',
    'mancode',
    'dist',
    'cli.js',
  );
  const installedVersion = runCaptured(
    process.execPath,
    [installedCli, '--version'],
    installFixture,
  );
  const packageMetadata = JSON.parse(
    await readFile(path.join(checkout, 'package.json'), 'utf8'),
  );
  assert(
    installedVersion === packageMetadata.version,
    'installed CLI version does not match package.json',
  );
  runCheck(
    checks,
    'tarball_cli',
    process.execPath,
    [installedCli, 'init', '--empty', '--platform', 'all', '--lang', 'en'],
    installFixture,
  );
  const status = JSON.parse(
    runCaptured(
      process.execPath,
      [installedCli, 'status', '--brief', '--json'],
      installFixture,
    ),
  );
  assert(
    status.runtime === 'mancode-continuity' && status.ready === true,
    'installed tarball did not produce a ready Continuity runtime',
  );
  runCheck(
    checks,
    'tarball_module',
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const mod = await import('mancode'); if (Object.keys(mod).length === 0) process.exit(1);",
    ],
    installFixture,
  );

  const originMainAfter = remoteRef(remote, 'refs/heads/main');
  assert(originMainAfter === originMainBefore, 'origin/main changed during release check');
  checks.push({ name: 'origin_main_unchanged', status: 'passed' });

  await mkdir(outputDirectory, { recursive: true });
  const artifactFile = `mancode-${packageMetadata.version}-${candidate.slice(0, 12)}.tgz`;
  await copyFile(tarballPath, path.join(outputDirectory, artifactFile));
  const report = {
    schemaVersion: 1,
    localReady: true,
    releaseCandidate: candidate,
    packageVersion: packageMetadata.version,
    generatedAt: new Date().toISOString(),
    source: {
      branch: 'main',
      originDevelop,
      originMainBefore,
      originMainAfter,
    },
    environment: {
      nodeVersion: process.version,
      npmVersion: runCaptured('npm', ['--version'], checkout),
      platform: process.platform,
      arch: process.arch,
    },
    tarball: {
      artifactFile,
      sha256: tarballSha256,
      npmShasum: packed.shasum,
      npmIntegrity: packed.integrity,
      size: packed.size,
      unpackedSize: packed.unpackedSize,
      fileCount: packed.entryCount ?? packed.files?.length ?? null,
      dryRunFileCount: dryRun.entryCount ?? dryRun.files?.length ?? null,
    },
    checks,
    externalGates: {
      platformSessionEvidence: 'pending',
      betaGate: 'pending',
      githubQuality: 'pending',
      githubWindows: 'pending',
    },
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Local release check passed: ${outputPath}`);
  console.log(`Candidate tarball: ${path.join(outputDirectory, artifactFile)}`);
  console.log(`SHA-256: ${tarballSha256}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runCheck(checks, name, command, args, cwd) {
  run(command, args, cwd, 'inherit');
  checks.push({ name, status: 'passed' });
}

function runCaptured(command, args, cwd) {
  return run(command, args, cwd, 'pipe').trim();
}

function run(command, args, cwd, stdio) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})${detail ? `:\n${detail}` : ''}`,
    );
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

function remoteRef(remote, ref) {
  const output = runCaptured('git', ['ls-remote', remote, ref], sourceRoot);
  const [commit] = output.split(/\s+/u);
  return normalizeCandidate(commit ?? '');
}

function parseSinglePackResult(output) {
  const parsed = JSON.parse(output);
  assert(
    Array.isArray(parsed) && parsed.length === 1,
    'npm pack returned an unexpected result',
  );
  return parsed[0];
}

function normalizeCandidate(value) {
  const candidate = String(value).trim();
  assert(
    /^[a-f0-9]{40}$/u.test(candidate),
    'release candidate must be a full Git commit SHA',
  );
  return candidate;
}

function parseOptions(args) {
  const parsed = { candidate: null, output: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') {
      parsed.help = true;
      continue;
    }
    if (argument !== '--candidate' && argument !== '--output') {
      throw new Error(`unknown release-check argument: ${argument}`);
    }
    const value = args[index + 1];
    assert(value !== undefined, `${argument} requires a value`);
    if (argument === '--candidate') parsed.candidate = value;
    else parsed.output = value;
    index += 1;
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

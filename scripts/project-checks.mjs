import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profiles = {
  quality: [
    ['run', 'lint'],
    ['run', 'typecheck'],
    ['run', 'build'],
    ['run', 'test:dist'],
    ['audit', '--audit-level=high'],
    ['run', 'test:coverage'],
  ],
  windows: [
    ['run', 'build'],
    [
      'exec',
      '--',
      'vitest',
      'run',
      'tests/local-lock.test.ts',
      'tests/local-lock-crash.test.ts',
      'tests/entity-home-store-contracts.test.ts',
    ],
  ],
};

function main() {
  const args = process.argv.slice(2);
  const profile = args[0] ?? 'quality';
  if (args.length > 1 || !Object.hasOwn(profiles, profile)) {
    console.error('Usage: npm run check | npm run check:windows');
    return 1;
  }
  // npm supplies its JS entry point. Running it with Node avoids shell quoting
  // and Windows .cmd execution, including installations under paths with spaces.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    console.error('Run project checks through npm run check or npm run check:windows.');
    return 1;
  }
  const cli = path.join(root, 'dist', 'cli.js');
  const env = {
    ...process.env,
    MANCODE_CLI_BINARY: cli,
    MANCODE_PROGRESS_CLI_BINARY: cli,
  };
  for (const argv of profiles[profile]) {
    console.log(`Project check: npm ${argv.join(' ')}`);
    const result = spawnSync(process.execPath, [npmCli, ...argv], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    if (result.error || result.signal || result.status !== 0) {
      console.error(
        `Project check failed: npm ${argv.join(' ')} (${result.error?.message ?? result.signal ?? `exit ${result.status}`})`,
      );
      return result.status || 1;
    }
  }
  return 0;
}

process.exitCode = main();

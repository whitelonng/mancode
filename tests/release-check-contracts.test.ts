import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const scriptPath = path.join(root, 'scripts', 'release-check.mjs');

describe('release candidate check', () => {
  it('documents the immutable candidate input without publishing npm', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      '--help',
    ]);
    expect(stdout).toContain('--candidate <commit>');
    expect(stdout).toContain('--output <report.json>');

    const script = await readFile(scriptPath, 'utf8');
    expect(script).toContain("'cross_clone'");
    expect(script).toContain("'legacy_migration'");
    expect(script).toContain("'tarball_install'");
    expect(script).toContain("'origin_main_unchanged'");
    expect(script).toContain('release candidate must equal origin/main');
    expect(script).not.toContain('release candidate must equal origin/develop');
    expect(script).toMatch(/'clone',[\s\S]*'--branch',\s*'main'/);
    expect(script).toContain("branch: 'main'");
    expect(script).toContain("createHash('sha256')");
    expect(script).toContain("['audit', '--audit-level=high', '--json']");
    expect(script).toContain("'dependency_audit'");
    expect(script).not.toContain("'--omit=dev'");
    expect(script).not.toMatch(/['"]publish['"]/);
    expect(script).not.toContain('dist-tag');
  });

  it('registers release and publish quality gates explicitly', async () => {
    const packageMetadata = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageMetadata.scripts['release:check']).toBe(
      'node scripts/release-check.mjs',
    );
    expect(packageMetadata.scripts.prepublishOnly).toContain(
      'npm audit --audit-level=high',
    );
    expect(packageMetadata.scripts.prepublishOnly).toContain(
      'npm run test:coverage',
    );
  });
});

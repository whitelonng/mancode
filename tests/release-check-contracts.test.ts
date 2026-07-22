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
    expect(script).toContain("createHash('sha256')");
    expect(script).not.toMatch(/['"]publish['"]/);
    expect(script).not.toContain('dist-tag');
  });

  it('is registered as an explicit package script', async () => {
    const packageMetadata = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageMetadata.scripts['release:check']).toBe(
      'node scripts/release-check.mjs',
    );
  });
});

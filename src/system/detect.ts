import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Optional tools that improve mancode behavior but do not gate init. */
export interface SystemDeps {
  git: boolean;
}

/**
 * Detect optional system dependencies without invoking a shell.
 *
 * `execFile` lets Node resolve `git` through PATH on macOS, Linux, Windows
 * CMD, PowerShell, and Git Bash without assuming `/bin/bash` exists.
 */
export async function detectSystemDeps(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SystemDeps> {
  try {
    await execFileAsync('git', ['--version'], {
      env,
      windowsHide: true,
    });
    return { git: true };
  } catch {
    return { git: false };
  }
}

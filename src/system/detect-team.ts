import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 多人协作检测结果。
 *
 * 三条件同时满足才判定为团队：
 * 1. contributors > 1（历史多个贡献者）
 * 2. hasRemote = true（有 github/gitlab/bitbucket remote）
 * 3. recentActive > 1（最近 30 天多人活跃，避免老项目误判）
 */
export interface TeamStatus {
  isTeam: boolean;
  contributors: number;
  recentActive: number;
  hasRemote: boolean;
}

const NO_TEAM: TeamStatus = {
  isTeam: false,
  contributors: 1,
  recentActive: 1,
  hasRemote: false,
};

const REMOTE_PATTERN = /github\.com|gitlab\.com|bitbucket\.org/;

const GIT_ENV = {
  ...process.env,
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Detect team activity with direct git process calls and Node parsing.
 * Missing git, a non-git directory, or an unreadable history safely degrades
 * to solo defaults.
 */
export async function detectTeamStatus(
  projectRoot: string,
): Promise<TeamStatus> {
  try {
    await access(path.join(projectRoot, '.git'));
    const inside = await runGit(projectRoot, [
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (inside.trim() !== 'true') return NO_TEAM;

    const [allEmails, recentEmails, remotes] = await Promise.all([
      runGit(projectRoot, ['log', '--all', '--format=%ae']),
      runGit(projectRoot, ['log', '--since=30 days ago', '--format=%ae']),
      runGit(projectRoot, ['remote', '-v']),
    ]);

    const contributors = countUniqueLines(allEmails);
    const recentActive = countUniqueLines(recentEmails);
    const hasRemote = REMOTE_PATTERN.test(remotes);

    return {
      isTeam: contributors > 1 && hasRemote && recentActive > 1,
      contributors: contributors || 1,
      recentActive: recentActive || 1,
      hasRemote,
    };
  } catch {
    return NO_TEAM;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: GIT_ENV,
    windowsHide: true,
  });
  return stdout;
}

function countUniqueLines(output: string): number {
  return new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ).size;
}

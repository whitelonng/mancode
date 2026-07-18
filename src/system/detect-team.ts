import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type { TeamAssessmentSignals } from '../team/assessment.js';

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
  const signals = await detectTeamAssessmentSignals(projectRoot);
  if (signals === null) return NO_TEAM;
  return {
    isTeam:
      signals.contributorsRecent > 1 &&
      (signals.remoteCount > 0 || signals.hasTrackedUpstream),
    contributors: signals.contributorsAllTime || 1,
    recentActive: signals.contributorsRecent || 1,
    hasRemote: signals.remoteCount > 0 || signals.hasTrackedUpstream,
  };
}

/**
 * Collects the bounded Git and repository-layout facts consumed by V3's team
 * assessment. A self-hosted remote is just as valid as a hosted one; the
 * assessment decides whether these facts recommend team coordination.
 */
export async function detectTeamAssessmentSignals(
  projectRoot: string,
  recentDays = 30,
): Promise<TeamAssessmentSignals | null> {
  if (!Number.isSafeInteger(recentDays) || recentDays < 0) {
    throw new Error('MANCODE_TEAM_RECENT_DAYS_INVALID');
  }
  try {
    const inside = await runGit(projectRoot, [
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (inside.trim() !== 'true') {
      return emptySignals(false);
    }

    const [allEmails, recentEmails, remotes, hasTrackedUpstream, templates] =
      await Promise.all([
        runGit(projectRoot, ['log', '--all', '--format=%ae']),
        runGit(projectRoot, [
          'log',
          `--since=${recentDays} days ago`,
          '--format=%ae',
        ]),
        runGit(projectRoot, ['remote']),
        hasGitTrackedUpstream(projectRoot),
        detectRepositoryTemplates(projectRoot),
      ]);

    return {
      isGitRepository: true,
      remoteCount: countUniqueLines(remotes),
      contributorsAllTime: countUniqueLines(allEmails),
      contributorsRecent: countUniqueLines(recentEmails),
      hasTrackedUpstream,
      hasCodeowners: templates.hasCodeowners,
      hasPullRequestTemplate: templates.hasPullRequestTemplate,
    };
  } catch {
    return null;
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

async function hasGitTrackedUpstream(projectRoot: string): Promise<boolean> {
  try {
    const upstream = await runGit(projectRoot, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    return Boolean(upstream.trim());
  } catch {
    return false;
  }
}

async function detectRepositoryTemplates(projectRoot: string): Promise<{
  hasCodeowners: boolean;
  hasPullRequestTemplate: boolean;
}> {
  const [hasCodeowners, hasPullRequestTemplate] = await Promise.all([
    anyPathExists(projectRoot, [
      'CODEOWNERS',
      '.github/CODEOWNERS',
      'docs/CODEOWNERS',
    ]),
    anyPathExists(projectRoot, [
      'PULL_REQUEST_TEMPLATE.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE',
      '.github/pull_request_template',
    ]),
  ]);
  return { hasCodeowners, hasPullRequestTemplate };
}

async function anyPathExists(
  projectRoot: string,
  candidates: readonly string[],
): Promise<boolean> {
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(path.join(projectRoot, candidate));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

function emptySignals(isGitRepository: boolean): TeamAssessmentSignals {
  return {
    isGitRepository,
    remoteCount: 0,
    contributorsAllTime: 0,
    contributorsRecent: 0,
    hasTrackedUpstream: false,
    hasCodeowners: false,
    hasPullRequestTemplate: false,
  };
}

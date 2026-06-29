import { exec } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * 多人协作检测结果。
 *
 * 三条件同时满足才判定为团队（docs/13-scanning.md §6）：
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

/**
 * 所有 exec 调用共用：禁用 pager（否则 shortlog 会拉起 less 阻塞等输入）。
 */
const EXEC_OPTS = {
  shell: '/bin/bash',
  encoding: 'utf-8' as const,
  env: {
    ...process.env,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  },
};

/**
 * 检测多人协作状态。
 *
 * 算法来源：docs/07-hooks.md §2.3 detect_team()（已同步为 TS 实现）。
 *
 * 行为：
 * - 非 git 目录 → 返回默认单人状态
 * - git 命令失败 → 返回默认单人状态（保守降级，不抛错）
 * - 三条件全满足 → isTeam=true
 *
 * @param projectRoot 项目根目录
 */
export async function detectTeamStatus(
  projectRoot: string,
): Promise<TeamStatus> {
  const gitDir = path.join(projectRoot, '.git');
  try {
    await execAsync('git rev-parse --is-inside-work-tree', {
      cwd: projectRoot,
      ...EXEC_OPTS,
    });
  } catch {
    return NO_TEAM;
  }

  // 检查 .git 目录确实存在（rev-parse 在某些情况下也会成功）
  try {
    await execAsync(`test -d ${JSON.stringify(gitDir)}`, {
      cwd: projectRoot,
      ...EXEC_OPTS,
    });
  } catch {
    return NO_TEAM;
  }

  const contributors = await countUniqueEmails(
    "git log --all --format='%ae'",
    projectRoot,
  );
  const recentActive = await countUniqueEmails(
    "git log --since='30 days ago' --format='%ae'",
    projectRoot,
  );
  const hasRemote = await checkRemote(projectRoot);

  // 兜底：exec 输出非数字时回到 0/1
  const safeContributors = Number.isFinite(contributors) ? contributors : 0;
  const safeRecent = Number.isFinite(recentActive) ? recentActive : 0;

  const isTeam = safeContributors > 1 && hasRemote && safeRecent > 1;

  return {
    isTeam,
    contributors: safeContributors || 1,
    recentActive: safeRecent || 1,
    hasRemote,
  };
}

async function countUniqueEmails(
  command: string,
  cwd: string,
): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `${command} 2>/dev/null | sort -u | grep -c . || true`,
      { cwd, ...EXEC_OPTS },
    );
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function checkRemote(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git remote -v 2>/dev/null || true', {
      cwd,
      ...EXEC_OPTS,
    });
    return REMOTE_PATTERN.test(stdout);
  } catch {
    return false;
  }
}

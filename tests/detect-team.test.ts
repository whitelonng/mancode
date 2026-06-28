import { exec } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectTeamStatus } from '../src/system/detect-team.js';

const execAsync = promisify(exec);

async function git(cwd: string, ...args: string[]): Promise<void> {
  // -c 必须放在子命令之前，否则 git init/remote 等会拒绝
  await execAsync(`git -c commit.gpgsign=false ${args.join(' ')}`, {
    cwd,
    shell: '/bin/bash',
  });
}

async function commit(cwd: string, email: string, name: string): Promise<void> {
  await execAsync(
    `git -c user.email=${email} -c user.name=${name} -c commit.gpgsign=false commit --allow-empty -q -m t`,
    { cwd, shell: '/bin/bash' },
  );
}

describe('detectTeamStatus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-team-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns solo defaults when directory is not a git repo', async () => {
    // 没初始化 git
    const result = await detectTeamStatus(dir);
    expect(result.isTeam).toBe(false);
    expect(result.contributors).toBe(1);
    expect(result.recentActive).toBe(1);
    expect(result.hasRemote).toBe(false);
  });

  it('returns isTeam=false for single-contributor repo without remote', async () => {
    await git(dir, 'init', '-q');
    await commit(dir, 'a@example.com', 'A');

    const result = await detectTeamStatus(dir);
    expect(result.isTeam).toBe(false);
    expect(result.hasRemote).toBe(false);
  }, 15000);

  it('returns isTeam=false when multi-contributor but no remote', async () => {
    await git(dir, 'init', '-q');
    await commit(dir, 'a@example.com', 'A');
    await commit(dir, 'b@example.com', 'B');
    await commit(dir, 'c@example.com', 'C');

    const result = await detectTeamStatus(dir);
    expect(result.contributors).toBeGreaterThan(1);
    expect(result.hasRemote).toBe(false);
    expect(result.isTeam).toBe(false);
  }, 15000);

  it('returns isTeam=false when has remote but only one contributor', async () => {
    await git(dir, 'init', '-q');
    await git(dir, 'remote', 'add', 'origin', 'https://github.com/foo/bar.git');
    await commit(dir, 'a@example.com', 'A');

    const result = await detectTeamStatus(dir);
    expect(result.contributors).toBe(1);
    expect(result.hasRemote).toBe(true);
    expect(result.isTeam).toBe(false);
  }, 15000);

  it('returns isTeam=true when all three conditions met', async () => {
    await git(dir, 'init', '-q');
    await git(dir, 'remote', 'add', 'origin', 'https://github.com/foo/bar.git');
    // 多个贡献者且都在最近 30 天内活跃
    await commit(dir, 'a@example.com', 'A');
    await commit(dir, 'b@example.com', 'B');
    await commit(dir, 'c@example.com', 'C');

    const result = await detectTeamStatus(dir);
    expect(result.contributors).toBeGreaterThan(1);
    expect(result.recentActive).toBeGreaterThan(1);
    expect(result.hasRemote).toBe(true);
    expect(result.isTeam).toBe(true);
  }, 15000);

  it('detects github/classic remotes correctly', async () => {
    await git(dir, 'init', '-q');
    await git(dir, 'remote', 'add', 'origin', 'git@gitlab.com:foo/bar.git');
    await commit(dir, 'a@example.com', 'A');

    const result = await detectTeamStatus(dir);
    expect(result.hasRemote).toBe(true);
  }, 15000);
});

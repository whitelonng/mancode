import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import {
  EXIT_NOT_INITIALIZED,
  EXIT_OK,
  EXIT_UNSUPPORTED_PLATFORM,
  install,
} from '../src/commands/install.js';
import { DEFAULT_CONFIG } from '../src/templates/defaults.js';

const execFileAsync = promisify(execFile);

describe('mancode install', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-install-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns EXIT_NOT_INITIALIZED when mancode is not initialized', async () => {
    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_NOT_INITIALIZED);
  });

  it('returns EXIT_OK when installing claude-code on initialized project', async () => {
    await silentInit(dir);
    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_OK);
  });

  it('reinstalls hooks and skills with --force', async () => {
    await silentInit(dir);

    // 删掉一个 hook 文件
    await rm(path.join(dir, '.mancode', 'hooks', 'session-start.sh'), {
      force: true,
    });

    const code = await install(dir, 'claude-code', { force: true });
    expect(code).toBe(EXIT_OK);

    // hook 文件应该恢复
    const hookPath = path.join(dir, '.mancode', 'hooks', 'session-start.sh');
    const content = await readFile(hookPath, 'utf-8');
    expect(content).toContain('mancode');
  });

  it('install --minimal --force keeps only solo skill and removes coaching staff', async () => {
    await silentInit(dir);

    expect(
      await pathExists(path.join(dir, '.claude', 'skills', 'man8', 'SKILL.md')),
    ).toBe(true);
    expect(await pathExists(path.join(dir, '.claude', 'agents'))).toBe(true);

    const code = await install(dir, 'claude-code', {
      force: true,
      minimal: true,
    });

    expect(code).toBe(EXIT_OK);
    expect(
      await pathExists(path.join(dir, '.claude', 'skills', 'solo', 'SKILL.md')),
    ).toBe(true);
    expect(await pathExists(path.join(dir, '.claude', 'skills', 'man8'))).toBe(
      false,
    );
    expect(
      await pathExists(path.join(dir, '.claude', 'skills', 'manteam')),
    ).toBe(false);
    expect(await pathExists(path.join(dir, '.claude', 'agents'))).toBe(false);
  });

  it('installs team commit and pull request templates without overwriting them', async () => {
    await silentInit(dir);

    const commitTemplatePath = path.join(
      dir,
      '.mancode',
      'team',
      'commit-template.txt',
    );
    const prTemplatePath = path.join(
      dir,
      '.github',
      'PULL_REQUEST_TEMPLATE.md',
    );

    await expect(readFile(commitTemplatePath, 'utf-8')).resolves.toContain(
      '<type>(<scope>): <summary>',
    );
    await expect(readFile(prTemplatePath, 'utf-8')).resolves.toContain(
      '## Team Coordination',
    );

    await writeFile(commitTemplatePath, 'custom commit template\n', 'utf-8');
    await writeFile(prTemplatePath, 'custom pr template\n', 'utf-8');

    const code = await install(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_OK);
    await expect(readFile(commitTemplatePath, 'utf-8')).resolves.toBe(
      'custom commit template\n',
    );
    await expect(readFile(prTemplatePath, 'utf-8')).resolves.toBe(
      'custom pr template\n',
    );
  });

  it('minimal install does not create team templates', async () => {
    await silentInit(dir);

    await rm(path.join(dir, '.mancode', 'team'), {
      recursive: true,
      force: true,
    });
    await rm(path.join(dir, '.github'), { recursive: true, force: true });

    const code = await install(dir, 'claude-code', {
      force: true,
      minimal: true,
    });

    expect(code).toBe(EXIT_OK);
    expect(await pathExists(path.join(dir, '.mancode', 'team'))).toBe(false);
    expect(await pathExists(path.join(dir, '.github'))).toBe(false);
  });

  it('does not install the optional commit hook by default', async () => {
    await silentInit(dir);

    expect(
      await pathExists(path.join(dir, '.git', 'hooks', 'commit-msg')),
    ).toBe(false);
  });

  it('installs optional team commit hook without overwriting custom hooks', async () => {
    await silentInit(dir);

    const gitHookPath = path.join(dir, '.git', 'hooks', 'commit-msg');
    const logPath = path.join(dir, '.mancode', 'logs', 'hooks.log');
    const validatorPath = path.join(dir, '.mancode', 'team', 'commit-msg.sh');
    await writeFile(logPath, 'preserve existing logs\n', 'utf-8');

    const code = await install(dir, 'claude-code', { commitHook: true });

    expect(code).toBe(EXIT_OK);
    await expect(readFile(gitHookPath, 'utf-8')).resolves.toContain(
      '.mancode/team/commit-msg.sh',
    );
    await expect(readFile(validatorPath, 'utf-8')).resolves.toContain(
      'Conventional Commits',
    );
    await expect(readFile(logPath, 'utf-8')).resolves.toBe(
      'preserve existing logs\n',
    );

    await writeFile(gitHookPath, '#!/usr/bin/env bash\necho custom\n', 'utf-8');

    const reinstallCode = await install(dir, 'claude-code', {
      force: true,
      commitHook: true,
    });

    expect(reinstallCode).toBe(EXIT_OK);
    await expect(readFile(gitHookPath, 'utf-8')).resolves.toBe(
      '#!/usr/bin/env bash\necho custom\n',
    );
  });

  it('installs optional commit hook in linked git worktrees', async () => {
    await rm(path.join(dir, '.git'), { recursive: true, force: true });
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: dir,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], {
      cwd: dir,
    });
    await writeFile(path.join(dir, 'README.md'), '# test\n', 'utf-8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'chore: init'], { cwd: dir });

    const linkedDir = await mkdtemp(path.join(tmpdir(), 'mancode-linked-'));
    await rm(linkedDir, { recursive: true, force: true });

    try {
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', 'mancode-linked-test', linkedDir, 'HEAD'],
        { cwd: dir },
      );
      await silentInit(linkedDir);

      const code = await install(linkedDir, 'claude-code', {
        commitHook: true,
      });
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--git-path', 'hooks/commit-msg'],
        { cwd: linkedDir },
      );
      const hookPath = stdout.trim();

      expect(code).toBe(EXIT_OK);
      await expect(readFile(hookPath, 'utf-8')).resolves.toContain(
        '.mancode/team/commit-msg.sh',
      );
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', linkedDir], {
        cwd: dir,
      }).catch(() => {});
      await rm(linkedDir, { recursive: true, force: true });
    }
  });

  it('returns EXIT_OK when already installed (idempotent, no --force)', async () => {
    await silentInit(dir);
    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_OK);
  });

  it('returns EXIT_UNSUPPORTED_PLATFORM for unknown platform', async () => {
    await silentInit(dir);
    const code = await install(dir, 'cursor');
    expect(code).toBe(EXIT_UNSUPPORTED_PLATFORM);
  });

  it('updates config.json platforms on install', async () => {
    await silentInit(dir);

    // 清空 config.json 的 platforms
    await writeFile(
      path.join(dir, '.mancode', 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, platforms: [] }, null, 2),
      'utf-8',
    );

    await install(dir, 'claude-code');

    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.platforms).toContain('claude-code');
  });

  it('does not duplicate platform in config.json on repeat install', async () => {
    await silentInit(dir);

    await install(dir, 'claude-code');
    await install(dir, 'claude-code', { force: true });

    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const count = config.platforms.filter(
      (p: string) => p === 'claude-code',
    ).length;
    expect(count).toBe(1);
  });

  it('default platform is claude-code when none specified', async () => {
    await silentInit(dir);

    // install without explicit platform name
    const code = await install(dir);
    expect(code).toBe(EXIT_OK);

    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.platforms).toContain('claude-code');
  });

  it('handles missing config.json gracefully', async () => {
    await silentInit(dir);

    // 删除 config.json
    await rm(path.join(dir, '.mancode', 'config.json'), { force: true });

    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_OK);

    // config.json 应该被重建
    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.platforms).toContain('claude-code');
    expect(config.forceTeamMode).toBe(false);
    expect(config.defaultStyle).toBeNull();
    expect(config.cliCommand).toBe(DEFAULT_CONFIG.cliCommand);
    expect(config.hooks).toEqual(DEFAULT_CONFIG.hooks);
    expect(config.logging).toEqual(DEFAULT_CONFIG.logging);
  });

  it('preserves configured team/style/cli options on forced reinstall', async () => {
    await silentInit(dir, { team: true, style: 'brutalist' });
    const configPath = path.join(dir, '.mancode', 'config.json');
    const initialConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    await writeFile(
      configPath,
      `${JSON.stringify(
        { ...initialConfig, cliCommand: "node '/tmp/mancode/dist/cli.js'" },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const code = await install(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_OK);
    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.platforms).toContain('claude-code');
    expect(config.forceTeamMode).toBe(true);
    expect(config.defaultStyle).toBe('brutalist');
    expect(config.cliCommand).toBe("node '/tmp/mancode/dist/cli.js'");
    expect(config.hooks).toEqual(DEFAULT_CONFIG.hooks);
    expect(config.logging).toEqual(DEFAULT_CONFIG.logging);
  });

  it('--force does not wipe scanned style-tokens.json', async () => {
    // 创建前端项目 + tailwind config
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        dependencies: {
          react: '^18.0.0',
          tailwindcss: '^3.4.0',
        },
      }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      `module.exports = {
  theme: {
    extend: {
      colors: { primary: '#3b82f6' },
    },
  },
};`,
      'utf-8',
    );

    // init 会扫描审美 token
    await silentInit(dir);

    // 确认 style-tokens.json 有扫描结果
    const tokensBefore = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
        'utf-8',
      ),
    );
    expect(tokensBefore.matchLevel).toBe('high');
    expect(tokensBefore.colors).toHaveProperty('primary', '#3b82f6');

    // install --force 应该恢复 hooks/skills，但不应擦除已扫描的 token
    await install(dir, 'claude-code', { force: true });

    const tokensAfter = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
        'utf-8',
      ),
    );
    expect(tokensAfter.matchLevel).toBe('high');
    expect(tokensAfter.colors).toHaveProperty('primary', '#3b82f6');
  });
});

/**
 * 静默执行 init，吞掉 init 的 stdout/stderr 噪音。
 */
async function silentInit(
  dir: string,
  options: Parameters<typeof init>[1] = {},
): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await init(dir, options);
    if (code !== 0) {
      throw new Error(`silentInit failed: init exited with ${code}`);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

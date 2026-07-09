import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_ALREADY_INITIALIZED,
  EXIT_INIT_FAILED,
  EXIT_NOT_A_PROJECT_DIR,
  EXIT_OK,
  type MancodeState,
  init,
} from '../src/commands/init.js';
import { VERSION } from '../src/version.js';

describe('mancode init', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-init-'));
    // 创建 .git 使其成为项目目录（所有测试都需要）
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates all 8 files/directories (exit 0)', async () => {
    const code = await init(dir);

    expect(code).toBe(EXIT_OK);

    // 验证 state.json
    const statePath = path.join(dir, '.mancode', 'state.json');
    const stateRaw = await readFile(statePath, 'utf-8');
    const state: MancodeState = JSON.parse(stateRaw);

    expect(state.currentMode).toBe('solo');
    expect(state.platform).toBe('claude-code');
    expect(state.version).toBe(VERSION);
    expect(state.initializedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // 验证 config.json
    const configPath = path.join(dir, '.mancode', 'config.json');
    const configRaw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    expect(config.platforms).toEqual(['claude-code']);
    expect(config.cliCommand).toBe('mancode');
    expect(config.cliArgs).toEqual([]);
    expect(config.hooks.sessionStart).toBe(true);

    // 验证 hooks（2 个文件，可执行）
    const hooks = await readdir(path.join(dir, '.mancode', 'hooks'));
    expect(hooks).toContain('session-start.sh');
    expect(hooks).toContain('user-prompt-submit.sh');

    // 验证 style-tokens.json
    const tokensPath = path.join(
      dir,
      '.mancode',
      'aesthetics',
      'style-tokens.json',
    );
    const tokensRaw = await readFile(tokensPath, 'utf-8');
    const tokens = JSON.parse(tokensRaw);
    expect(tokens.colors).toEqual({});

    // 验证 hooks.log
    const logPath = path.join(dir, '.mancode', 'logs', 'hooks.log');
    const logContent = await readFile(logPath, 'utf-8');
    expect(logContent).toBe('');

    // 验证 MVP-2 P1 durable outputs
    const memoryFiles = await readdir(path.join(dir, '.mancode', 'memory'));
    expect(memoryFiles.sort()).toEqual(['decisions.md', 'prd.md', 'spec.md']);
    const reportDirs = await readdir(path.join(dir, '.mancode'));
    expect(reportDirs).toContain('preseason-reports');

    // 验证 .claude/settings.json（官方 schema: matcher group 数组）
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const settingsRaw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsRaw);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].type).toBe('command');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      '.mancode/hooks/session-start.sh',
    );
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      '.mancode/hooks/user-prompt-submit.sh',
    );
    expect(settings.skills).toBeUndefined();

    // 验证 solo skill
    const skillPath = path.join(dir, '.claude', 'skills', 'solo', 'SKILL.md');
    const skillContent = await readFile(skillPath, 'utf-8');
    expect(skillContent).toContain('name: solo');
    expect(skillContent).toContain('mancode · solo mode');
    expect(skillContent).toContain('YAGNI');

    // 验证 MVP-2 slash skills 使用 Claude Code 官方目录结构
    const man8Skill = await readFile(
      path.join(dir, '.claude', 'skills', 'man8', 'SKILL.md'),
      'utf-8',
    );
    expect(man8Skill).toContain('name: man8');

    const skillNames = await readdir(path.join(dir, '.claude', 'skills'));
    expect(skillNames.sort()).toEqual([
      'man',
      'man8',
      'manps',
      'mansolo',
      'manteam',
      'solo',
    ]);
  });

  it('persists --team / --no-team / --style options', async () => {
    const teamCode = await init(dir, { team: true, style: 'brutalist' });
    expect(teamCode).toBe(EXIT_OK);

    const teamState: MancodeState = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    const teamConfig = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(teamState.teamModeAutoDetected).toBe(true);
    expect(teamConfig.forceTeamMode).toBe(true);
    expect(teamConfig.defaultStyle).toBe('brutalist');

    const otherDir = await mkdtemp(
      path.join(tmpdir(), 'mancode-init-no-team-'),
    );
    await mkdir(path.join(otherDir, '.git'), { recursive: true });
    try {
      const noTeamCode = await init(otherDir, { team: false });
      expect(noTeamCode).toBe(EXIT_OK);
      const noTeamState: MancodeState = JSON.parse(
        await readFile(path.join(otherDir, '.mancode', 'state.json'), 'utf-8'),
      );
      const noTeamConfig = JSON.parse(
        await readFile(path.join(otherDir, '.mancode', 'config.json'), 'utf-8'),
      );
      expect(noTeamState.teamModeAutoDetected).toBe(false);
      expect(noTeamConfig.forceTeamMode).toBe(false);
      expect(noTeamConfig.defaultStyle).toBeNull();
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('initializes Cursor without creating Claude Code files', async () => {
    const code = await init(dir, { platform: 'cursor' });

    expect(code).toBe(EXIT_OK);
    const state: MancodeState = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );

    expect(state.platform).toBe('cursor');
    expect(config.platforms).toEqual(['cursor']);
    await expect(
      readFile(path.join(dir, '.cursor', 'rules', 'mancode-solo.mdc'), 'utf-8'),
    ).resolves.toContain('# mancode solo');
    await expect(
      readFile(path.join(dir, '.claude', 'settings.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it.each([
    ['cursor', ['.cursor', 'rules', 'mancode-context.mdc']],
    ['codex', ['AGENTS.md']],
    ['copilot', ['.github', 'copilot-instructions.md']],
    ['zcode', ['AGENTS.md']],
  ] as const)(
    'initializes %s with freshly scanned frontend style tokens',
    async (platform, outputPath) => {
      await writeFrontendFixture(dir);

      const code = await init(dir, { platform });

      expect(code).toBe(EXIT_OK);
      const generated = await readFile(path.join(dir, ...outputPath), 'utf-8');
      expect(generated).toContain('brand=#123456');
      expect(generated).not.toContain('No strong project style tokens');
    },
  );

  it('initializes Codex without creating Claude Code files', async () => {
    const code = await init(dir, { platform: 'codex' });

    expect(code).toBe(EXIT_OK);
    const state: MancodeState = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );

    expect(state.platform).toBe('codex');
    expect(config.platforms).toEqual(['codex']);
    await expect(
      readFile(path.join(dir, 'AGENTS.md'), 'utf-8'),
    ).resolves.toContain('Platform adapter: Codex CLI');
    await expect(
      readFile(path.join(dir, '.claude', 'settings.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('initializes ZCode without creating Claude Code files', async () => {
    const code = await init(dir, { platform: 'zcode' });

    expect(code).toBe(EXIT_OK);
    const state: MancodeState = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );

    expect(state.platform).toBe('zcode');
    expect(config.platforms).toEqual(['zcode']);
    await expect(
      readFile(path.join(dir, 'AGENTS.md'), 'utf-8'),
    ).resolves.toContain('Platform adapter: ZCode');
    await expect(
      readFile(path.join(dir, '.agents', 'skills', 'man8', 'SKILL.md'), 'utf-8'),
    ).resolves.toContain('name: man8');
    await expect(
      readFile(path.join(dir, '.claude', 'settings.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('initializes GitHub Copilot without creating AGENTS.md or Claude Code files', async () => {
    const code = await init(dir, { platform: 'copilot' });

    expect(code).toBe(EXIT_OK);
    const state: MancodeState = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );

    expect(state.platform).toBe('copilot');
    expect(config.platforms).toEqual(['copilot']);
    await expect(
      readFile(path.join(dir, '.github', 'copilot-instructions.md'), 'utf-8'),
    ).resolves.toContain('Platform adapter: GitHub Copilot');
    await expect(
      readFile(path.join(dir, 'AGENTS.md'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, '.claude', 'settings.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('returns init failure for unsupported init platform', async () => {
    const code = await init(dir, { platform: 'unknown-platform' });

    expect(code).toBe(EXIT_INIT_FAILED);
    await expect(
      readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('does not validate Claude settings when initializing another platform', async () => {
    const claudeDir = path.join(dir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      '{ invalid',
      'utf-8',
    );

    const code = await init(dir, { platform: 'codex' });

    expect(code).toBe(EXIT_OK);
    await expect(
      readFile(path.join(dir, 'AGENTS.md'), 'utf-8'),
    ).resolves.toContain('Platform adapter: Codex CLI');
  });

  it('does not claim package.json is missing when it has no known deps', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'empty-node-project', version: '1.0.0' }),
      'utf-8',
    );

    const logs = await captureLog(() => init(dir));
    const output = logs.join('\n');

    expect(output).toContain(
      'package.json found, no known framework dependencies',
    );
    expect(output).not.toContain('No package.json found');
  });

  it('returns EXIT_ALREADY_INITIALIZED on second run without --force', async () => {
    const first = await init(dir);
    const statePath = path.join(dir, '.mancode', 'state.json');
    const firstContent = await readFile(statePath, 'utf-8');

    await new Promise((r) => setTimeout(r, 1100));

    const second = await init(dir);
    const secondContent = await readFile(statePath, 'utf-8');

    expect(first).toBe(EXIT_OK);
    expect(second).toBe(EXIT_ALREADY_INITIALIZED);
    expect(secondContent).toBe(firstContent);
  });

  it('reinstalls when --force is passed', async () => {
    await init(dir);
    const statePath = path.join(dir, '.mancode', 'state.json');
    const firstRaw = await readFile(statePath, 'utf-8');
    const firstState = JSON.parse(firstRaw);

    await new Promise((r) => setTimeout(r, 1100));

    const code = await init(dir, { force: true });
    const secondRaw = await readFile(statePath, 'utf-8');
    const secondState = JSON.parse(secondRaw);

    expect(code).toBe(EXIT_OK);
    expect(secondState.initializedAt).not.toBe(firstState.initializedAt);
  });

  it('returns EXIT_OK when .mancode dir pre-exists but no state.json', async () => {
    // .git 已在 beforeEach 创建
    await mkdir(path.join(dir, '.mancode'), { recursive: true });
    const code = await init(dir);
    expect(code).toBe(EXIT_OK);

    const statePath = path.join(dir, '.mancode', 'state.json');
    const raw = await readFile(statePath, 'utf-8');
    expect(JSON.parse(raw).currentMode).toBe('solo');
  });

  it('returns EXIT_NOT_A_PROJECT_DIR when target dir does not exist', async () => {
    const code = await init('/dev/null/mancode-test-should-fail');
    expect(code).toBe(EXIT_NOT_A_PROJECT_DIR);
  });

  it('returns EXIT_NOT_A_PROJECT_DIR for empty directory (no .git or package.json)', async () => {
    // tmpdir 是空目录，没有 .git 或 package.json
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'mancode-empty-'));
    const code = await init(emptyDir);
    expect(code).toBe(EXIT_NOT_A_PROJECT_DIR);
    await rm(emptyDir, { recursive: true, force: true });
  });

  it('merges hooks idempotently into existing .claude/settings.json', async () => {
    // 用户已有 .claude/settings.json（使用官方 matcher group 数组 schema）
    const claudeDir = path.join(dir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const existingSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: 'echo "user hook"' }],
          },
        ],
      },
      skills: {
        custom: '.claude/skills/custom.md',
      },
    };
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(existingSettings, null, 2),
      'utf-8',
    );

    // 运行 init
    await init(dir);

    const settingsPath = path.join(claudeDir, 'settings.json');
    const settingsRaw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsRaw);

    // 用户 matcher group 应该保留
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      'echo "user hook"',
    );

    // mancode matcher group 应该存在
    expect(settings.hooks.SessionStart[1].hooks).toHaveLength(1);
    expect(settings.hooks.SessionStart[1].hooks[0].command).toContain(
      '.mancode/hooks/',
    );

    // 用户 skill 应该保留
    expect(settings.skills.custom).toBe('.claude/skills/custom.md');
    expect(settings.skills.solo).toBeUndefined();
  });

  it('migrates legacy hook settings and removes old mancode hooks on --force', async () => {
    const claudeDir = path.join(dir, '.claude');
    const mancodeDir = path.join(dir, '.mancode');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(mancodeDir, { recursive: true });
    await writeFile(
      path.join(mancodeDir, 'state.json'),
      JSON.stringify(
        {
          version: VERSION,
          currentMode: 'solo',
          platform: 'claude-code',
          initializedAt: new Date().toISOString(),
          techStack: 'Unknown',
          uiLibrary: 'None',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const existingSettings = {
      hooks: {
        SessionStart: [
          { command: 'bash .mancode/hooks/session-start.sh' },
          { command: 'echo "legacy user hook"' },
        ],
        UserPromptSubmit: {
          mancode: {
            hooks: [{ type: 'command', command: 'bash .mancode/hooks/old.sh' }],
          },
        },
      },
      skills: {
        custom: '.claude/skills/custom.md',
      },
    };
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(existingSettings, null, 2),
      'utf-8',
    );

    const code = await init(dir, { force: true });

    const settingsRaw = await readFile(
      path.join(claudeDir, 'settings.json'),
      'utf-8',
    );
    const settings = JSON.parse(settingsRaw);

    expect(code).toBe(EXIT_OK);
    expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      'echo "legacy user hook"',
    );
    expect(settings.hooks.SessionStart[1].hooks[0].command).toBe(
      'bash .mancode/hooks/session-start.sh',
    );
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'bash .mancode/hooks/user-prompt-submit.sh',
    );
    expect(settings.skills.custom).toBe('.claude/skills/custom.md');
    expect(settings.skills.man8).toBeUndefined();
  });

  it('returns init failure without writing state when Claude settings are invalid', async () => {
    const claudeDir = path.join(dir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      '{ invalid',
      'utf-8',
    );

    const code = await init(dir);

    expect(code).toBe(EXIT_INIT_FAILED);
    await expect(
      readFile(path.join(dir, '.claude', 'settings.json'), 'utf-8'),
    ).resolves.toBe('{ invalid');
    await expect(
      readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    ).rejects.toThrow();
  });
});

async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

async function writeFrontendFixture(dir: string): Promise<void> {
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'frontend',
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
  darkMode: 'class',
  theme: {
    extend: {
      colors: { brand: '#123456' },
      fontFamily: { sans: ['Inter', 'sans-serif'] },
    },
  },
};`,
    'utf-8',
  );
}

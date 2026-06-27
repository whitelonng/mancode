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

    // 验证 .claude/settings.json（新 schema: matcher group）
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const settingsRaw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsRaw);
    expect(settings.hooks.SessionStart.mancode.hooks).toHaveLength(1);
    expect(settings.hooks.SessionStart.mancode.hooks[0].type).toBe('command');
    expect(settings.hooks.SessionStart.mancode.hooks[0].command).toContain(
      '.mancode/hooks/session-start.sh',
    );
    expect(settings.skills.solo).toBe('.claude/skills/mancode-solo.md');

    // 验证 solo skill
    const skillPath = path.join(dir, '.claude', 'skills', 'mancode-solo.md');
    const skillContent = await readFile(skillPath, 'utf-8');
    expect(skillContent).toContain('mancode · solo mode');
    expect(skillContent).toContain('YAGNI');
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
    // 用户已有 .claude/settings.json（使用新 schema）
    const claudeDir = path.join(dir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const existingSettings = {
      hooks: {
        SessionStart: {
          default: {
            hooks: [{ type: 'command', command: 'echo "user hook"' }],
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

    // 运行 init
    await init(dir);

    const settingsPath = path.join(claudeDir, 'settings.json');
    const settingsRaw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsRaw);

    // 用户的 "default" matcher group 应该保留
    expect(settings.hooks.SessionStart.default.hooks).toHaveLength(1);
    expect(settings.hooks.SessionStart.default.hooks[0].command).toBe(
      'echo "user hook"',
    );

    // mancode matcher group 应该存在
    expect(settings.hooks.SessionStart.mancode.hooks).toHaveLength(1);
    expect(settings.hooks.SessionStart.mancode.hooks[0].command).toContain(
      '.mancode/hooks/',
    );

    // 用户 skill 应该保留
    expect(settings.skills.custom).toBe('.claude/skills/custom.md');
    expect(settings.skills.solo).toBe('.claude/skills/mancode-solo.md');
  });
});

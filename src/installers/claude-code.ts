import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, EMPTY_STYLE_TOKENS } from '../templates/defaults.js';
import {
  SESSION_START_HOOK,
  SOLO_SKILL,
  USER_PROMPT_SUBMIT_HOOK,
} from '../templates/inline.js';

/**
 * Claude Code 平台安装器。
 *
 * 职责（docs/08-cli-spec.md §2.4）：
 * 1. 创建 .mancode/ 下 8 个文件/目录
 * 2. 创建 .claude/settings.json（幂等合并，不覆盖用户已有配置）
 * 3. 创建 .claude/skills/mancode-solo.md
 *
 * 幂等：重复运行不会丢失用户配置，hook 会去重。
 */
export async function installClaudeCode(
  projectRoot: string,
  options: {
    techStack: string[];
    uiLibrary: string | null;
  },
): Promise<void> {
  const mancodeDir = path.join(projectRoot, '.mancode');
  const claudeDir = path.join(projectRoot, '.claude');

  // 1. 创建 .mancode/ 子目录
  await mkdir(path.join(mancodeDir, 'hooks'), { recursive: true });
  await mkdir(path.join(mancodeDir, 'aesthetics'), { recursive: true });
  await mkdir(path.join(mancodeDir, 'logs'), { recursive: true });

  // 2. 写入 config.json
  const configPath = path.join(mancodeDir, 'config.json');
  const configContent = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
  await writeFile(configPath, configContent, 'utf-8');

  // 3. 写入 hooks
  await installHooks(path.join(mancodeDir, 'hooks'));

  // 4. 写入 style-tokens.json（空，MVP-1 不扫描）
  const tokensPath = path.join(mancodeDir, 'aesthetics', 'style-tokens.json');
  const tokensContent = `${JSON.stringify(EMPTY_STYLE_TOKENS, null, 2)}\n`;
  await writeFile(tokensPath, tokensContent, 'utf-8');

  // 5. 创建空 hooks.log
  const logPath = path.join(mancodeDir, 'logs', 'hooks.log');
  await writeFile(logPath, '', 'utf-8');

  // 6. 创建 .claude/skills/ 并写入 solo skill
  await mkdir(path.join(claudeDir, 'skills'), { recursive: true });
  await installSoloSkill(path.join(claudeDir, 'skills'));

  // 7. 更新 .claude/settings.json（幂等合并）
  await updateClaudeSettings(claudeDir);
}

async function installHooks(hooksDir: string): Promise<void> {
  // session-start.sh
  const sessionStartDst = path.join(hooksDir, 'session-start.sh');
  await writeFile(sessionStartDst, SESSION_START_HOOK, 'utf-8');
  await chmod(sessionStartDst, 0o755);

  // user-prompt-submit.sh
  const userPromptDst = path.join(hooksDir, 'user-prompt-submit.sh');
  await writeFile(userPromptDst, USER_PROMPT_SUBMIT_HOOK, 'utf-8');
  await chmod(userPromptDst, 0o755);
}

async function installSoloSkill(skillsDir: string): Promise<void> {
  const skillDst = path.join(skillsDir, 'mancode-solo.md');
  await writeFile(skillDst, SOLO_SKILL, 'utf-8');
}

interface ClaudeHook {
  command: string;
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: {
    [event: string]: ClaudeHook[];
  };
  skills?: {
    [name: string]: string;
  };
  [key: string]: unknown;
}

/**
 * 幂等更新 .claude/settings.json。
 *
 * docs/15-adapters.md §2.1 要求：
 * - 先过滤掉旧 mancode hook（按 command 里的 'mancode/hooks/' 标记判断）
 * - 再 push 新版本
 * - 不覆盖用户已有 hooks/skills
 */
async function updateClaudeSettings(claudeDir: string): Promise<void> {
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings: ClaudeSettings = {};

  // 读取现有 settings（如有）
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as ClaudeSettings;
  } catch {
    // 文件不存在或解析失败，用空对象
  }

  // 幂等合并：先过滤旧 mancode hook
  const MANCODE_TAG = '.mancode/hooks/';
  const isMancodeHook = (h: ClaudeHook) =>
    typeof h?.command === 'string' && h.command.includes(MANCODE_TAG);

  settings.hooks = settings.hooks || {};
  for (const event of [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
  ]) {
    settings.hooks[event] = (settings.hooks[event] || []).filter(
      (h) => !isMancodeHook(h),
    );
  }

  // Push 新 hook
  settings.hooks.SessionStart.push({
    command: 'bash .mancode/hooks/session-start.sh',
  });
  settings.hooks.UserPromptSubmit.push({
    command: 'bash .mancode/hooks/user-prompt-submit.sh',
  });

  // 添加 solo skill
  settings.skills = settings.skills || {};
  settings.skills.solo = '.claude/skills/mancode-solo.md';

  // 写回
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(settingsPath, content, 'utf-8');
}

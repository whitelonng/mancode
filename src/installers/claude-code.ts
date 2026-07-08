import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ALL_AGENTS, renderAgent } from '../templates/agents/index.js';
import { SOLO_SKILL } from '../templates/inline.js';
import { MVP2_SKILLS, renderSkill } from '../templates/skills/index.js';
import { installMancodeCore } from './common.js';

/**
 * Claude Code 平台安装器。
 *
 * 职责（docs/08-cli-spec.md §2.4）：
 * 1. 创建/修复平台无关的 .mancode/ 文件（通过 installMancodeCore）
 * 2. 创建 .claude/settings.json（幂等合并，不覆盖用户已有配置）
 * 3. 创建 .claude/skills/<name>/SKILL.md
 *
 * 幂等：重复运行不会丢失用户配置，hook 会去重。
 */
export async function validateClaudeCodeSettings(
  projectRoot: string,
): Promise<void> {
  await readClaudeSettings(path.join(projectRoot, '.claude'));
}

export async function installClaudeCode(
  projectRoot: string,
  options: {
    techStack: string[];
    uiLibrary: string | null;
    minimal?: boolean;
  },
): Promise<void> {
  const claudeDir = path.join(projectRoot, '.claude');
  const settings = await readClaudeSettings(claudeDir);

  await installMancodeCore(projectRoot);

  // 1. 创建 .claude/skills/ 并写入 solo skill + MVP-2 skills
  await mkdir(path.join(claudeDir, 'skills'), { recursive: true });
  await installSoloSkill(path.join(claudeDir, 'skills'));
  if (options.minimal) {
    await uninstallMvp2Skills(path.join(claudeDir, 'skills'));
  } else {
    await installMvp2Skills(path.join(claudeDir, 'skills'));
  }

  // 2. 创建 .claude/agents/ 并写入教练组（MVP-2）
  if (options.minimal) {
    await uninstallAgents(path.join(claudeDir, 'agents'));
  } else {
    await installAgents(path.join(claudeDir, 'agents'));
  }

  // 3. 更新 .claude/settings.json（幂等合并）
  await updateClaudeSettings(claudeDir, settings);
}

async function installSoloSkill(skillsDir: string): Promise<void> {
  await installProjectSkill(skillsDir, {
    name: 'solo',
    description: 'Default mancode solo-mode guidance for small, focused tasks.',
    body: SOLO_SKILL,
  });
  await removeLegacyFlatSkill(skillsDir, 'mancode-solo');
}

/**
 * 写入 MVP-2 skill 目录（/man8 /man /mansolo，docs/03）。
 *
 * 目录：.claude/skills/<name>/SKILL.md（Claude Code 通过目录名识别命令）。
 * `--force` 重装时直接覆盖（内容随 mancode 版本演进）。
 */
async function installMvp2Skills(skillsDir: string): Promise<void> {
  for (const skill of MVP2_SKILLS) {
    await installProjectSkill(skillsDir, skill);
    await removeLegacyFlatSkill(skillsDir, `mancode-${skill.name}`);
  }
}

async function uninstallMvp2Skills(skillsDir: string): Promise<void> {
  for (const skill of MVP2_SKILLS) {
    await rm(path.join(skillsDir, skill.name), {
      recursive: true,
      force: true,
    });
    await removeLegacyFlatSkill(skillsDir, `mancode-${skill.name}`);
  }
}

async function installProjectSkill(
  skillsDir: string,
  skill: { name: string; description: string; body: string },
): Promise<void> {
  const skillDir = path.join(skillsDir, skill.name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), renderSkill(skill), 'utf-8');
}

async function removeLegacyFlatSkill(
  skillsDir: string,
  legacyName: string,
): Promise<void> {
  await rm(path.join(skillsDir, `${legacyName}.md`), { force: true });
}

/**
 * 写入教练组 agent 文件（MVP-2）。
 *
 * 每个 agent 渲染为 .claude/agents/<name>.md（YAML frontmatter + body）。
 * `--force` 重装时直接覆盖（内容随 mancode 版本演进）。
 */
async function installAgents(agentsDir: string): Promise<void> {
  await mkdir(agentsDir, { recursive: true });
  for (const agent of ALL_AGENTS) {
    const content = renderAgent(agent);
    await writeFile(path.join(agentsDir, `${agent.name}.md`), content, 'utf-8');
  }
}

async function uninstallAgents(agentsDir: string): Promise<void> {
  for (const agent of ALL_AGENTS) {
    await rm(path.join(agentsDir, `${agent.name}.md`), { force: true });
  }
}

interface ClaudeHookItem {
  type: 'command';
  command: string;
  [key: string]: unknown;
}

interface ClaudeMatcherGroup {
  matcher?: string;
  hooks: ClaudeHookItem[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  skills?: {
    [name: string]: string;
  };
  [key: string]: unknown;
}

/**
 * 幂等更新 .claude/settings.json。
 *
 * Claude Code hooks schema (官方格式):
 * {
 *   "hooks": {
 *     "SessionStart": [
 *       { "hooks": [{ "type": "command", "command": "..." }] }
 *     ]
 *   }
 * }
 *
 * 幂等策略：
 * - 兼容旧版数组 hook item、错误对象 map、官方 matcher group 数组
 * - 过滤旧 mancode hook（按 command 里的 .mancode/hooks/ 判断）
 * - 追加新的 mancode matcher group
 * - 不覆盖用户已有 matcher groups
 */
async function readClaudeSettings(claudeDir: string): Promise<ClaudeSettings> {
  const settingsPath = path.join(claudeDir, 'settings.json');
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return {};
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot update .claude/settings.json because it is unreadable or invalid JSON: ${reason}`,
    );
  }
}

async function updateClaudeSettings(
  claudeDir: string,
  settings: ClaudeSettings,
): Promise<void> {
  const settingsPath = path.join(claudeDir, 'settings.json');
  // 初始化 hooks 对象
  settings.hooks = settings.hooks || {};

  settings.hooks.SessionStart = [
    ...normalizeHookGroups(settings.hooks.SessionStart),
    createCommandGroup('bash .mancode/hooks/session-start.sh'),
  ];
  settings.hooks.UserPromptSubmit = [
    ...normalizeHookGroups(settings.hooks.UserPromptSubmit),
    createCommandGroup('bash .mancode/hooks/user-prompt-submit.sh'),
  ];

  removeLegacyMancodeSkillSettings(settings);

  // 写回
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(settingsPath, content, 'utf-8');
}

function removeLegacyMancodeSkillSettings(settings: ClaudeSettings): void {
  if (!settings.skills) return;
  const legacyNames = new Set([
    'solo',
    'man8',
    'man',
    'manteam',
    'manps',
    'mansolo',
  ]);
  const retained = Object.fromEntries(
    Object.entries(settings.skills).filter(([name]) => !legacyNames.has(name)),
  );
  settings.skills = Object.keys(retained).length > 0 ? retained : undefined;
}

function createCommandGroup(command: string): ClaudeMatcherGroup {
  return {
    hooks: [
      {
        type: 'command',
        command,
      },
    ],
  };
}

function normalizeHookGroups(value: unknown): ClaudeMatcherGroup[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const group = normalizeMatcherGroup(entry);
      if (group) return [group];

      const hook = normalizeHookItem(entry);
      if (hook && !isMancodeHook(hook)) return [{ hooks: [hook] }];

      return [];
    });
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap((entry) => {
      const group = normalizeMatcherGroup(entry);
      return group ? [group] : [];
    });
  }

  return [];
}

function normalizeMatcherGroup(value: unknown): ClaudeMatcherGroup | null {
  if (!isRecord(value) || !Array.isArray(value.hooks)) {
    return null;
  }

  const hooks = value.hooks
    .map(normalizeHookItem)
    .filter((hook): hook is ClaudeHookItem => hook !== null)
    .filter((hook) => !isMancodeHook(hook));

  if (hooks.length === 0) {
    return null;
  }

  return {
    ...value,
    hooks,
  } as ClaudeMatcherGroup;
}

function normalizeHookItem(value: unknown): ClaudeHookItem | null {
  if (!isRecord(value) || typeof value.command !== 'string') {
    return null;
  }

  return {
    ...value,
    type: 'command',
    command: value.command,
  } as ClaudeHookItem;
}

function isMancodeHook(hook: ClaudeHookItem): boolean {
  return hook.command.includes('.mancode/hooks/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

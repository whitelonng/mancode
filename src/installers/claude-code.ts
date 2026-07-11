import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { ALL_AGENTS, renderAgent } from '../templates/agents/index.js';
import { SOLO_SKILL } from '../templates/inline.js';
import { MVP2_SKILLS, renderSkill } from '../templates/skills/index.js';
import { installMancodeCore } from './common.js';

export const CLAUDE_SKILL_MANAGED_MARKER =
  '<!-- Managed by mancode:claude-skill. Do not edit this marker. -->';
export const CLAUDE_AGENT_MANAGED_MARKER =
  '<!-- Managed by mancode:claude-agent. Do not edit this marker. -->';

export const MANCODE_HOOK_COMMANDS = [
  'node ".mancode/hooks/session-start.mjs"',
  'node ".mancode/hooks/user-prompt-submit.mjs"',
] as const;

const LEGACY_MANCODE_HOOK_COMMANDS = [
  'bash .mancode/hooks/session-start.sh',
  'bash .mancode/hooks/user-prompt-submit.sh',
] as const;

export function isGeneratedMancodeHookCommand(command: string): boolean {
  const normalized = command.trim();
  return [...MANCODE_HOOK_COMMANDS, ...LEGACY_MANCODE_HOOK_COMMANDS].some(
    (item) => item === normalized,
  );
}

export const LEGACY_CLAUDE_SKILL_SETTINGS: Readonly<Record<string, string>> = {
  solo: '.claude/skills/mancode-solo.md',
  man8: '.claude/skills/mancode-man8.md',
  man: '.claude/skills/mancode-man.md',
  mansolo: '.claude/skills/mancode-mansolo.md',
};

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
    force?: boolean;
  },
): Promise<void> {
  const claudeDir = path.join(projectRoot, '.claude');
  const settings = await readClaudeSettings(claudeDir);
  // When force is false (auto-repair), only write skills/agents that are
  // missing — do not overwrite user-customized files.
  const force = options.force ?? false;

  await installMancodeCore(projectRoot);

  // 1. 创建 .claude/skills/ 并写入 solo skill + MVP-2 skills
  await mkdir(path.join(claudeDir, 'skills'), { recursive: true });
  // solo skill is core — always repair even without --force
  await installSoloSkill(path.join(claudeDir, 'skills'), force);
  if (options.minimal) {
    await uninstallMvp2Skills(path.join(claudeDir, 'skills'));
  } else {
    await installMvp2Skills(path.join(claudeDir, 'skills'), force);
  }

  // 2. 创建 .claude/agents/ 并写入教练组（MVP-2）
  if (options.minimal) {
    await uninstallAgents(path.join(claudeDir, 'agents'));
  } else {
    await installAgents(path.join(claudeDir, 'agents'), force);
  }

  // 3. 更新 .claude/settings.json（幂等合并）
  await updateClaudeSettings(claudeDir, settings);
  await removeLegacyHookFiles(projectRoot);
}

async function removeLegacyHookFiles(projectRoot: string): Promise<void> {
  const hooksDir = path.join(projectRoot, '.mancode', 'hooks');
  await Promise.all([
    rm(path.join(hooksDir, 'session-start.sh'), { force: true }),
    rm(path.join(hooksDir, 'user-prompt-submit.sh'), { force: true }),
  ]);
}

async function installSoloSkill(
  skillsDir: string,
  force: boolean,
): Promise<void> {
  await installProjectSkill(
    skillsDir,
    {
      name: 'solo',
      description:
        'Default mancode solo-mode guidance for small, focused tasks.',
      body: SOLO_SKILL,
    },
    force,
  );
  await removeLegacyFlatSkill(skillsDir, 'mancode-solo', 'solo');
}

/**
 * 写入 MVP-2 skill 目录（/man /mamba /mansolo，docs/03）。
 *
 * 目录：.claude/skills/<name>/SKILL.md（Claude Code 通过目录名识别命令）。
 * `--force` 重装时只覆盖可识别的 mancode 生成文件。
 * auto-repair（force=false）时只写入缺失的 skill，不覆盖用户自定义。
 */
async function installMvp2Skills(
  skillsDir: string,
  force: boolean,
): Promise<void> {
  await removeManagedLegacyMan8Skill(skillsDir);
  for (const skill of MVP2_SKILLS) {
    await installProjectSkill(skillsDir, skill, force);
    await removeLegacyFlatSkill(skillsDir, `mancode-${skill.name}`, skill.name);
  }
}

async function removeManagedLegacyMan8Skill(skillsDir: string): Promise<void> {
  await removeGeneratedSkillDir(skillsDir, 'man8');
}

async function uninstallMvp2Skills(skillsDir: string): Promise<void> {
  for (const skill of MVP2_SKILLS) {
    await removeGeneratedSkillDir(skillsDir, skill.name);
    await removeLegacyFlatSkill(skillsDir, `mancode-${skill.name}`, skill.name);
  }
}

async function installProjectSkill(
  skillsDir: string,
  skill: { name: string; description: string; body: string },
  force = true,
): Promise<void> {
  const skillDir = path.join(skillsDir, skill.name);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const existing = await readTextIfExists(skillPath);
  if (existing !== null && !force) {
    return;
  }
  if (
    existing !== null &&
    force &&
    !isGeneratedClaudeSkill(existing, skill.name)
  ) {
    throw new Error(
      `refusing to overwrite user-authored Claude Code skill: ${skillPath}`,
    );
  }
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    skillPath,
    addManagedMarker(renderSkill(skill), CLAUDE_SKILL_MANAGED_MARKER),
    'utf-8',
  );
}

async function removeLegacyFlatSkill(
  skillsDir: string,
  legacyName: string,
  modeName: string,
): Promise<void> {
  const legacyPath = path.join(skillsDir, `${legacyName}.md`);
  const content = await readTextIfExists(legacyPath);
  if (content && isGeneratedClaudeSkill(content, modeName)) {
    await rm(legacyPath, { force: true });
  }
}

/**
 * 写入教练组 agent 文件（MVP-2）。
 *
 * 每个 agent 渲染为 .claude/agents/<name>.md（YAML frontmatter + body）。
 * `--force` 重装时直接覆盖（内容随 mancode 版本演进）。
 * auto-repair（force=false）时只写入缺失的 agent，不覆盖用户自定义。
 */
async function installAgents(agentsDir: string, force: boolean): Promise<void> {
  await mkdir(agentsDir, { recursive: true });
  for (const agent of ALL_AGENTS) {
    const agentPath = path.join(agentsDir, `${agent.name}.md`);
    if (!force) {
      // auto-repair: skip if the agent already exists (may be user-customized)
      try {
        await access(agentPath);
        continue;
      } catch {
        // file missing — proceed to write
      }
    }
    const existing = await readTextIfExists(agentPath);
    if (
      existing !== null &&
      force &&
      !isGeneratedClaudeAgent(existing, agent.name)
    ) {
      throw new Error(
        `refusing to overwrite user-authored Claude Code agent: ${agentPath}`,
      );
    }
    const content = addManagedMarker(
      renderAgent(agent),
      CLAUDE_AGENT_MANAGED_MARKER,
    );
    await writeFile(agentPath, content, 'utf-8');
  }
}

async function uninstallAgents(agentsDir: string): Promise<void> {
  for (const agent of ALL_AGENTS) {
    const agentPath = path.join(agentsDir, `${agent.name}.md`);
    const content = await readTextIfExists(agentPath);
    if (content && isGeneratedClaudeAgent(content, agent.name)) {
      await rm(agentPath, { force: true });
    }
  }
}

/** Remove only Claude skills and agents that can be identified as generated. */
export async function removeClaudeGeneratedContent(
  projectRoot: string,
): Promise<void> {
  const claudeDir = path.join(projectRoot, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  for (const modeName of [
    'solo',
    'man8',
    ...MVP2_SKILLS.map((skill) => skill.name),
  ]) {
    await removeGeneratedSkillDir(skillsDir, modeName);
    await removeLegacyFlatSkill(skillsDir, `mancode-${modeName}`, modeName);
  }
  await uninstallAgents(path.join(claudeDir, 'agents'));
}

async function removeGeneratedSkillDir(
  skillsDir: string,
  modeName: string,
): Promise<void> {
  const skillDir = path.join(skillsDir, modeName);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const content = await readTextIfExists(skillPath);
  if (!content || !isGeneratedClaudeSkill(content, modeName)) return;
  await rm(skillPath, { force: true });
  await removeIfEmpty(skillDir);
}

export function isGeneratedClaudeSkill(
  content: string,
  modeName: string,
): boolean {
  if (content.includes(CLAUDE_SKILL_MANAGED_MARKER)) return true;
  if (!content.includes(`name: ${modeName}`)) return false;
  const heading =
    modeName === 'solo'
      ? '# mancode · solo mode'
      : modeName === 'man8'
        ? '# mancode · /man8 (4 AM Warmup)'
        : `# mancode · /${modeName}`;
  return content.includes(heading);
}

export function isGeneratedClaudeAgent(content: string, name: string): boolean {
  return (
    content.includes(CLAUDE_AGENT_MANAGED_MARKER) ||
    (content.includes(`name: ${name}`) && content.includes('mancode 教练组'))
  );
}

function addManagedMarker(content: string, marker: string): string {
  return content.replace('---\n\n', `---\n\n${marker}\n\n`);
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // Missing directory: nothing to clean.
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
 * - 过滤 mancode 生成的 hook（只匹配已知的精确命令）
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
    createCommandGroup(MANCODE_HOOK_COMMANDS[0]),
  ];
  settings.hooks.UserPromptSubmit = [
    ...normalizeHookGroups(settings.hooks.UserPromptSubmit),
    createCommandGroup(MANCODE_HOOK_COMMANDS[1]),
  ];

  removeLegacyMancodeSkillSettings(settings);

  // 写回
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(settingsPath, content, 'utf-8');
}

function removeLegacyMancodeSkillSettings(settings: ClaudeSettings): void {
  if (!settings.skills) return;
  const retained = Object.fromEntries(
    Object.entries(settings.skills).filter(
      ([name, value]) => LEGACY_CLAUDE_SKILL_SETTINGS[name] !== value,
    ),
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
    return value.flatMap(normalizeHookGroupEntry);
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) => {
      if (key === 'mancode' && containsLegacyMancodeHookPath(entry)) return [];
      return normalizeHookGroupEntry(entry);
    });
  }

  return [];
}

function normalizeHookGroupEntry(entry: unknown): ClaudeMatcherGroup[] {
  const group = normalizeMatcherGroup(entry);
  if (group) return [group];

  const hook = normalizeHookItem(entry);
  if (hook && !isMancodeHook(hook)) return [{ hooks: [hook] }];

  if (Array.isArray(entry)) {
    return entry.flatMap(normalizeHookGroupEntry);
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
  return isGeneratedMancodeHookCommand(hook.command);
}

function containsLegacyMancodeHookPath(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsLegacyMancodeHookPath);
  if (!isRecord(value)) return false;
  if (
    typeof value.command === 'string' &&
    value.command.includes('.mancode/hooks/')
  ) {
    return true;
  }
  return Object.values(value).some(containsLegacyMancodeHookPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

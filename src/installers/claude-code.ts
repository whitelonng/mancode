import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureTeamMemory } from '../system/team-memory.js';
import { ALL_AGENTS, renderAgent } from '../templates/agents/index.js';
import { DEFAULT_CONFIG, EMPTY_STYLE_TOKENS } from '../templates/defaults.js';
import {
  SESSION_START_HOOK,
  SOLO_SKILL,
  USER_PROMPT_SUBMIT_HOOK,
} from '../templates/inline.js';
import { MVP2_SKILLS, renderSkill } from '../templates/skills/index.js';

const execFileAsync = promisify(execFile);

/**
 * Claude Code 平台安装器。
 *
 * 职责（docs/08-cli-spec.md §2.4）：
 * 1. 创建 .mancode/ 下 8 个文件/目录
 * 2. 创建 .claude/settings.json（幂等合并，不覆盖用户已有配置）
 * 3. 创建 .claude/skills/<name>/SKILL.md
 *
 * 幂等：重复运行不会丢失用户配置，hook 会去重。
 */
export async function installClaudeCode(
  projectRoot: string,
  options: {
    techStack: string[];
    uiLibrary: string | null;
    minimal?: boolean;
    commitHook?: boolean;
  },
): Promise<void> {
  const mancodeDir = path.join(projectRoot, '.mancode');
  const claudeDir = path.join(projectRoot, '.claude');

  // 1. 创建 .mancode/ 子目录
  await mkdir(path.join(mancodeDir, 'hooks'), { recursive: true });
  await mkdir(path.join(mancodeDir, 'aesthetics'), { recursive: true });
  await mkdir(path.join(mancodeDir, 'logs'), { recursive: true });
  // MVP-2: workflow 目录存放 /man8 /man 的任务进度
  await mkdir(path.join(mancodeDir, 'workflows'), { recursive: true });
  // MVP-2 P1: team memory + preseason reports provide durable mode outputs.
  await ensureTeamMemory(projectRoot);
  await mkdir(path.join(mancodeDir, 'preseason-reports'), { recursive: true });

  // 2. 写入 config.json
  const configPath = path.join(mancodeDir, 'config.json');
  const configContent = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
  await writeFile(configPath, configContent, 'utf-8');

  // 3. 写入 hooks
  await installHooks(path.join(mancodeDir, 'hooks'));

  // 4. 写入 style-tokens.json（仅在不存在时写入空模板）
  // installClaudeCode 是骨架安装器，审美扫描是 init/refresh-style 的职责。
  // 跳过已存在的文件避免 install --force 擦除已扫描的 token。
  const tokensPath = path.join(mancodeDir, 'aesthetics', 'style-tokens.json');
  if (!(await pathExists(tokensPath))) {
    const tokensContent = `${JSON.stringify(EMPTY_STYLE_TOKENS, null, 2)}\n`;
    await writeFile(tokensPath, tokensContent, 'utf-8');
  }

  // 5. 创建空 hooks.log
  const logPath = path.join(mancodeDir, 'logs', 'hooks.log');
  await writeFile(logPath, '', 'utf-8');

  // 6. 创建 .claude/skills/ 并写入 solo skill + MVP-2 skills
  await mkdir(path.join(claudeDir, 'skills'), { recursive: true });
  await installSoloSkill(path.join(claudeDir, 'skills'));
  if (options.minimal) {
    await uninstallMvp2Skills(path.join(claudeDir, 'skills'));
  } else {
    await installMvp2Skills(path.join(claudeDir, 'skills'));
  }

  // 7. 创建 .claude/agents/ 并写入教练组（MVP-2）
  if (options.minimal) {
    await rm(path.join(claudeDir, 'agents'), { recursive: true, force: true });
  } else {
    await installAgents(path.join(claudeDir, 'agents'));
    await installTeamTemplates(projectRoot);
    if (options.commitHook) {
      await installTeamCommitHook(projectRoot);
    }
  }

  // 8. 更新 .claude/settings.json（幂等合并）
  await updateClaudeSettings(claudeDir);
}

export async function installClaudeCodeCommitHook(
  projectRoot: string,
): Promise<void> {
  await installTeamTemplates(projectRoot);
  await installTeamCommitHook(projectRoot);
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

async function installTeamTemplates(projectRoot: string): Promise<void> {
  const teamDir = path.join(projectRoot, '.mancode', 'team');
  await mkdir(teamDir, { recursive: true });
  await writeFileIfMissing(
    path.join(teamDir, 'commit-template.txt'),
    TEAM_COMMIT_TEMPLATE,
  );

  const githubDir = path.join(projectRoot, '.github');
  await mkdir(githubDir, { recursive: true });
  await writeFileIfMissing(
    path.join(githubDir, 'PULL_REQUEST_TEMPLATE.md'),
    PULL_REQUEST_TEMPLATE,
  );
}

async function installTeamCommitHook(projectRoot: string): Promise<void> {
  const teamDir = path.join(projectRoot, '.mancode', 'team');
  await mkdir(teamDir, { recursive: true });

  const validatorPath = path.join(teamDir, 'commit-msg.sh');
  await writeFile(validatorPath, TEAM_COMMIT_MSG_HOOK, 'utf-8');
  await chmod(validatorPath, 0o755);

  const gitHookPath = await resolveGitHookPath(projectRoot);
  if (!gitHookPath) return;

  const gitHooksDir = path.dirname(gitHookPath);
  try {
    await mkdir(gitHooksDir, { recursive: true });
  } catch {
    return;
  }

  const wrapper = TEAM_COMMIT_MSG_WRAPPER;

  if (await pathExists(gitHookPath)) {
    const existing = await readFile(gitHookPath, 'utf-8');
    if (!existing.includes('.mancode/team/commit-msg.sh')) return;
  }

  await writeFile(gitHookPath, wrapper, 'utf-8');
  await chmod(gitHookPath, 0o755);
}

async function resolveGitHookPath(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      projectRoot,
      'rev-parse',
      '--git-path',
      'hooks/commit-msg',
    ]);
    const hookPath = stdout.trim();
    if (hookPath) {
      return path.isAbsolute(hookPath)
        ? hookPath
        : path.join(projectRoot, hookPath);
    }
  } catch {
    // Fall back for tests or partially initialized repositories.
  }

  const gitDir = path.join(projectRoot, '.git');
  try {
    const gitDirStat = await stat(gitDir);
    if (gitDirStat.isDirectory()) {
      return path.join(gitDir, 'hooks', 'commit-msg');
    }
  } catch {
    return null;
  }

  return null;
}

async function writeFileIfMissing(
  file: string,
  content: string,
): Promise<void> {
  if (await pathExists(file)) return;
  await writeFile(file, content, 'utf-8');
}

const TEAM_COMMIT_TEMPLATE = `<type>(<scope>): <summary>

Context:
- task:
- workflow:
- validation:

# Types: feat, fix, docs, test, refactor, perf, chore
# Keep summary imperative and under 72 characters.
# Remove comment lines before committing.
`;

const PULL_REQUEST_TEMPLATE = `## Summary

-

## Validation

- [ ] Tests/lint/build run, or reason documented
- [ ] Screenshots or smoke notes added for UI/CLI behavior

## Team Coordination

- Related mancode workflow:
- Shared modules touched:
- Rollback notes:
- Follow-up TODOs:
`;

const TEAM_COMMIT_MSG_WRAPPER = `#!/usr/bin/env bash
# mancode managed commit-msg hook
set -euo pipefail
exec bash .mancode/team/commit-msg.sh "$@"
`;

const TEAM_COMMIT_MSG_HOOK = `#!/usr/bin/env bash
set -euo pipefail

msg_file="\${1:-}"
if [[ -z "$msg_file" || ! -f "$msg_file" ]]; then
  exit 0
fi

subject="$(grep -vE '^[[:space:]]*(#|$)' "$msg_file" | head -n 1 || true)"

if [[ -z "$subject" ]]; then
  exit 0
fi

if [[ "$subject" =~ ^(Merge|Revert)[[:space:]] ]]; then
  exit 0
fi

pattern='^(feat|fix|docs|test|tests|refactor|perf|chore|build|ci|style|revert)(\\([A-Za-z0-9._/-]+\\))?!?: .{1,72}$'

if [[ "$subject" =~ $pattern ]]; then
  exit 0
fi

cat >&2 <<'EOF'
mancode: commit message must use Conventional Commits.

Expected:
  feat(scope): short imperative summary
  fix: short imperative summary

Allowed types:
  feat, fix, docs, test, tests, refactor, perf, chore, build, ci, style, revert

Tip:
  See .mancode/team/commit-template.txt
EOF

exit 1
`;

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

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { MANCODE_CURSOR_RULE_FILES } from '../installers/cursor.js';
import { removeManagedBlock } from '../installers/managed-block.js';
import {
  removeCodexSkills,
  removeCopilotPrompts,
  removeCursorCommands,
  removeZcodeSkills,
} from '../installers/mode-skills.js';
import {
  formatPlatformName,
  getPlatformInstaller,
  getPlatformInstallers,
} from '../installers/registry.js';
import {
  ZCODE_MANCODE_END_MARKER,
  ZCODE_MANCODE_START_MARKER,
} from '../installers/zcode.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_UNSUPPORTED_PLATFORM = 2;

const CLAUDE_SKILL_DIRS = [
  'solo',
  'man8',
  'man',
  'manteam',
  'manps',
  'mansolo',
];
const CLAUDE_AGENT_FILES = [
  'scout.md',
  'head-coach.md',
  'film-analyst-offense.md',
  'film-analyst-defense.md',
  'plan-coach.md',
];

export interface UninstallOptions {
  /** --force: skip confirmation */
  force?: boolean;
  /** --all: remove everything including .mancode/ */
  all?: boolean;
}

/**
 * `mancode uninstall [platform]` command.
 *
 * - With a platform name: removes that platform's generated files.
 * - Without a platform name (or --all): removes all mancode artifacts.
 *
 * Always preserves user-authored content (custom rules, user AGENTS.md text,
 * user Claude Code settings).
 */
export async function uninstall(
  rootDir: string = process.cwd(),
  platform?: string,
  options: UninstallOptions = {},
): Promise<number> {
  const stateFile = path.join(rootDir, '.mancode', 'state.json');
  if (!(await pathExists(stateFile))) {
    console.error('✗  mancode not initialized.');
    console.error('   Run `mancode init` first.');
    return EXIT_NOT_INITIALIZED;
  }

  const removeAll = !platform || options.all;

  if (platform) {
    const installer = getPlatformInstaller(platform);
    if (!installer) {
      console.error(`✗  Unsupported platform: ${platform}`);
      console.error(
        `   Supported platforms: ${getPlatformInstallers()
          .map((item) => item.name)
          .join(', ')}`,
      );
      return EXIT_UNSUPPORTED_PLATFORM;
    }
  }

  if (!options.force) {
    const target = platform
      ? `${formatPlatformName(platform)} adapter`
      : 'all mancode artifacts';
    console.log(`ℹ️  This will remove ${target}.`);
    console.log('   User-authored content is preserved.');
    console.log('   Run with --force to skip this message.');
  }

  if (removeAll) {
    await uninstallAll(rootDir);
  } else {
    await uninstallPlatform(rootDir, platform ?? 'claude-code');
  }

  console.log('✓  Uninstall complete.');
  return EXIT_OK;
}

async function uninstallPlatform(
  rootDir: string,
  platform: string,
): Promise<void> {
  console.log(`✓  Removing ${formatPlatformName(platform)} adapter...`);

  if (platform === 'claude-code') {
    await uninstallClaudeCode(rootDir);
  } else if (platform === 'cursor') {
    await uninstallCursor(rootDir);
  } else if (platform === 'codex') {
    await uninstallCodex(rootDir);
  } else if (platform === 'copilot') {
    await uninstallCopilot(rootDir);
  } else if (platform === 'zcode') {
    await uninstallZcode(rootDir);
  }

  await removeFromConfig(rootDir, platform);
}

async function uninstallAll(rootDir: string): Promise<void> {
  console.log('✓  Removing all platform adapters...');
  for (const p of getPlatformInstallers().map((platform) => platform.name)) {
    await uninstallPlatform(rootDir, p);
  }

  console.log('✓  Removing .mancode/ directory...');
  await rm(path.join(rootDir, '.mancode'), {
    recursive: true,
    force: true,
  });
}

async function uninstallClaudeCode(rootDir: string): Promise<void> {
  const claudeDir = path.join(rootDir, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  const agentsDir = path.join(claudeDir, 'agents');

  for (const skillDir of CLAUDE_SKILL_DIRS) {
    await rm(path.join(skillsDir, skillDir), { recursive: true, force: true });
  }

  for (const agentFile of CLAUDE_AGENT_FILES) {
    await rm(path.join(agentsDir, agentFile), { force: true });
  }

  await cleanClaudeSettings(rootDir);
}

async function cleanClaudeSettings(rootDir: string): Promise<void> {
  const settingsPath = path.join(rootDir, '.claude', 'settings.json');
  let content: string;
  try {
    content = await readFile(settingsPath, 'utf-8');
  } catch {
    return;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(content);
  } catch {
    return;
  }

  if (!isRecord(settings.hooks)) return;

  const cleanedHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      cleanedHooks[event] = groups;
      continue;
    }
    const filtered = groups.flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter(
        (hook) =>
          !(
            isRecord(hook) &&
            typeof hook.command === 'string' &&
            hook.command.includes('.mancode/hooks/')
          ),
      );
      return hooks.length > 0 ? [{ ...group, hooks }] : [];
    });
    if (filtered.length > 0) {
      cleanedHooks[event] = filtered;
    }
  }

  if (Object.keys(cleanedHooks).length > 0) {
    settings.hooks = cleanedHooks;
  } else {
    settings.hooks = undefined;
  }

  await writeFile(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf-8',
  );
}

async function uninstallCursor(rootDir: string): Promise<void> {
  const rulesDir = path.join(rootDir, '.cursor', 'rules');
  for (const file of MANCODE_CURSOR_RULE_FILES) {
    await rm(path.join(rulesDir, file), { force: true });
  }
  await removeCursorCommands(rootDir);
}

async function uninstallCodex(rootDir: string): Promise<void> {
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  try {
    const content = await readFile(agentsPath, 'utf-8');
    const cleaned = removeManagedBlock(content);
    if (cleaned.trim()) {
      await writeFile(agentsPath, `${cleaned}\n`, 'utf-8');
    } else {
      await rm(agentsPath, { force: true });
    }
  } catch {
    // AGENTS.md doesn't exist — nothing to do
  }
  // Codex and ZCode share .agents/skills/. Only remove skills if ZCode is not
  // also active, otherwise we would delete the other platform's skills too.
  if (!(await otherAgentSkillsPlatformActive(rootDir, 'codex'))) {
    await removeCodexSkills(rootDir);
  }
}

async function uninstallCopilot(rootDir: string): Promise<void> {
  const instructionsPath = path.join(
    rootDir,
    '.github',
    'copilot-instructions.md',
  );
  try {
    const content = await readFile(instructionsPath, 'utf-8');
    const cleaned = removeManagedBlock(content);
    if (cleaned.trim()) {
      await writeFile(instructionsPath, `${cleaned}\n`, 'utf-8');
    } else {
      await rm(instructionsPath, { force: true });
    }
  } catch {
    // copilot-instructions.md doesn't exist — nothing to do
  }
  await removeCopilotPrompts(rootDir);
}

async function uninstallZcode(rootDir: string): Promise<void> {
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  try {
    const content = await readFile(agentsPath, 'utf-8');
    const cleaned = removeManagedBlock(
      content,
      ZCODE_MANCODE_START_MARKER,
      ZCODE_MANCODE_END_MARKER,
    );
    if (cleaned.trim()) {
      await writeFile(agentsPath, `${cleaned}\n`, 'utf-8');
    } else {
      await rm(agentsPath, { force: true });
    }
  } catch {
    // AGENTS.md doesn't exist — nothing to do
  }
  // Codex and ZCode share .agents/skills/. Only remove skills if Codex is not
  // also active, otherwise we would delete the other platform's skills too.
  if (!(await otherAgentSkillsPlatformActive(rootDir, 'zcode'))) {
    await removeZcodeSkills(rootDir);
  }
}

async function removeFromConfig(
  rootDir: string,
  platform: string,
): Promise<void> {
  const configPath = path.join(rootDir, '.mancode', 'config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as {
      platforms?: string[];
      platformOptions?: Record<string, unknown>;
    };
    if (Array.isArray(config.platforms)) {
      config.platforms = config.platforms.filter((p) => p !== platform);
      if (isRecord(config.platformOptions)) {
        const platformOptions = Object.fromEntries(
          Object.entries(config.platformOptions).filter(
            ([name]) => name !== platform,
          ),
        );
        config.platformOptions =
          Object.keys(platformOptions).length > 0 ? platformOptions : undefined;
      }
      await writeFile(
        configPath,
        `${JSON.stringify(config, null, 2)}\n`,
        'utf-8',
      );
    }
  } catch {
    // config.json doesn't exist or is invalid — nothing to update
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether another agents-skills platform (Codex/ZCode) is still recorded
 * in config.json. Both platforms share the .agents/skills/ directory, so when
 * uninstalling one we must not delete skill files if the other is still active.
 */
async function otherAgentSkillsPlatformActive(
  rootDir: string,
  excluding: string,
): Promise<boolean> {
  try {
    const raw = await readFile(
      path.join(rootDir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(raw) as { platforms?: unknown };
    const platforms = Array.isArray(config.platforms)
      ? (config.platforms as string[])
      : [];
    const peers = ['codex', 'zcode'].filter((p) => p !== excluding);
    return platforms.some((p) => peers.includes(p));
  } catch {
    return false;
  }
}

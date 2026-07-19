import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  LEGACY_CLAUDE_SKILL_SETTINGS,
  isGeneratedMancodeHookCommand,
  removeClaudeGeneratedContent,
} from '../installers/claude-code.js';
import { removeCursorGeneratedRules } from '../installers/cursor.js';
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
import { removeV3Adapter } from '../installers/v3-adapter.js';
import {
  ZCODE_MANCODE_END_MARKER,
  ZCODE_MANCODE_START_MARKER,
} from '../installers/zcode.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_UNSUPPORTED_PLATFORM = 2;
export const EXIT_V3_AUTHORITY_PROTECTED = 3;

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
  const v3SchemaFile = path.join(rootDir, '.mancode', 'schema.json');
  if (await pathExists(v3SchemaFile)) {
    return uninstallV3(rootDir, platform, options);
  }
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

async function uninstallV3(
  rootDir: string,
  platform: string | undefined,
  options: UninstallOptions,
): Promise<number> {
  if (!platform || options.all) {
    console.error('✗  mancode authority is protected from bulk uninstall.');
    console.error(
      '   Remove a single bootstrap with `mancode uninstall <platform>`. Inspect runtime retention with `mancode context compact --dry-run`; V3 workflow authority is not bulk-deleted.',
    );
    return EXIT_V3_AUTHORITY_PROTECTED;
  }
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
  if (!options.force) {
    console.log(
      `ℹ️  This will remove only the ${formatPlatformName(platform)} mancode bootstrap.`,
    );
    console.log(
      '   mancode task, session, and shared authority are preserved.',
    );
  }
  try {
    await removeV3Adapter(rootDir, installer.name);
    console.log(
      `✓  Removed ${formatPlatformName(platform)} mancode bootstrap.`,
    );
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗  mancode bootstrap removal failed: ${message}`);
    return EXIT_V3_AUTHORITY_PROTECTED;
  }
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
  await removeClaudeGeneratedContent(rootDir);
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

  const cleanedHooks: Record<string, unknown> = {};
  if (isRecord(settings.hooks)) {
    for (const [event, value] of Object.entries(settings.hooks)) {
      const cleaned = cleanClaudeHookValue(value);
      if (cleaned !== undefined) cleanedHooks[event] = cleaned;
    }
    settings.hooks =
      Object.keys(cleanedHooks).length > 0 ? cleanedHooks : undefined;
  }

  if (isRecord(settings.skills)) {
    const retainedSkills = Object.fromEntries(
      Object.entries(settings.skills).filter(
        ([name, value]) => LEGACY_CLAUDE_SKILL_SETTINGS[name] !== value,
      ),
    );
    settings.skills =
      Object.keys(retainedSkills).length > 0 ? retainedSkills : undefined;
  }

  await writeFile(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf-8',
  );
}

function cleanClaudeHookValue(value: unknown): unknown | undefined {
  if (Array.isArray(value)) {
    const entries = value.flatMap(cleanClaudeHookEntry);
    return entries.length > 0 ? entries : undefined;
  }
  if (!isRecord(value)) return value;
  if (Array.isArray(value.hooks) || typeof value.command === 'string') {
    const entries = cleanClaudeHookEntry(value);
    return entries.length > 0 ? entries : undefined;
  }

  const entries = Object.entries(value).flatMap(([key, item]) => {
    if (key === 'mancode' && containsLegacyMancodeHookPath(item)) return [];
    const cleaned = cleanClaudeHookValue(item);
    return cleaned === undefined ? [] : [[key, cleaned] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function cleanClaudeHookEntry(entry: unknown): unknown[] {
  if (Array.isArray(entry)) return entry.flatMap(cleanClaudeHookEntry);
  if (!isRecord(entry)) return [entry];
  if (Array.isArray(entry.hooks)) {
    const hooks = entry.hooks.filter((hook) => !isMancodeHookEntry(hook));
    return hooks.length > 0 ? [{ ...entry, hooks }] : [];
  }
  return isMancodeHookEntry(entry) ? [] : [entry];
}

function isMancodeHookEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.command === 'string' &&
    isGeneratedMancodeHookCommand(value.command)
  );
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

async function uninstallCursor(rootDir: string): Promise<void> {
  await removeCursorGeneratedRules(rootDir);
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
  await removeCodexSkills(rootDir);
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
  await removeZcodeSkills(rootDir);
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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MANCODE_CURSOR_CORE_RULE_FILES } from './cursor.js';
import {
  DEFAULT_MANCODE_END_MARKER,
  DEFAULT_MANCODE_START_MARKER,
  hasManagedBlock,
} from './managed-block.js';
import {
  CODEX_SKILL_MANAGED_MARKER,
  MODE_NAMES,
  ZCODE_SKILL_MANAGED_MARKER,
} from './mode-skills.js';
import {
  ZCODE_MANCODE_END_MARKER,
  ZCODE_MANCODE_START_MARKER,
} from './zcode.js';

export interface PlatformStatus {
  installed: boolean;
  ready: boolean;
  target: string;
  detail: string;
}

export async function checkPlatformStatus(
  rootDir: string,
  platform: string,
  installed: boolean,
): Promise<PlatformStatus> {
  const readiness = await checkPlatformReadiness(rootDir, platform);
  return {
    installed,
    ready: installed && readiness.ready,
    target: readiness.target,
    detail: describeStatus(installed, readiness),
  };
}

async function checkPlatformReadiness(
  rootDir: string,
  platform: string,
): Promise<{
  present: boolean;
  ready: boolean;
  target: string;
  readyDetail: string;
}> {
  if (platform === 'claude-code') {
    const hasSoloSkill = await pathExists(
      path.join(rootDir, '.claude', 'skills', 'solo', 'SKILL.md'),
    );
    const registered = await claudeHooksRegistered(rootDir);
    const present = hasSoloSkill && registered;
    return {
      present,
      ready: present,
      target: '.claude/',
      readyDetail: 'skills and hooks registered',
    };
  }

  if (platform === 'cursor') {
    const present = await allPathsExist(
      MANCODE_CURSOR_CORE_RULE_FILES.map((file) =>
        path.join(rootDir, '.cursor', 'rules', file),
      ),
    );
    return {
      present,
      ready: present,
      target: '.cursor/rules/',
      readyDetail: 'mancode rules present',
    };
  }

  if (platform === 'codex') {
    const hasBlock = await fileHasManagedBlock(path.join(rootDir, 'AGENTS.md'));
    if (!hasBlock) {
      return {
        present: false,
        ready: false,
        target: 'AGENTS.md',
        readyDetail: 'managed block missing',
      };
    }
    if (await isPlatformMinimal(rootDir, 'codex')) {
      return {
        present: true,
        ready: true,
        target: 'AGENTS.md',
        readyDetail: 'managed block present',
      };
    }

    // Non-minimal installs should expose all five mancode-managed mode skills.
    const skillsDir = path.join(rootDir, '.codex', 'skills');
    const hasSkills = await allManagedSkills(
      MODE_NAMES.map((mode) => path.join(skillsDir, mode, 'SKILL.md')),
      CODEX_SKILL_MANAGED_MARKER,
    );
    return {
      present: true,
      ready: hasSkills,
      target: 'AGENTS.md + .codex/skills/',
      readyDetail: hasSkills
        ? 'managed block and skills present'
        : 'mode skills are missing, incomplete, or user-authored',
    };
  }

  if (platform === 'zcode') {
    const hasBlock = await fileHasManagedBlock(
      path.join(rootDir, 'AGENTS.md'),
      ZCODE_MANCODE_START_MARKER,
      ZCODE_MANCODE_END_MARKER,
    );
    if (!hasBlock) {
      return {
        present: false,
        ready: false,
        target: 'AGENTS.md',
        readyDetail: 'managed block missing',
      };
    }
    if (await isPlatformMinimal(rootDir, 'zcode')) {
      return {
        present: true,
        ready: true,
        target: 'AGENTS.md',
        readyDetail: 'managed block present',
      };
    }

    // Non-minimal installs should expose all five mancode-managed mode skills.
    const skillsDir = path.join(rootDir, '.zcode', 'skills');
    const hasSkills = await allManagedSkills(
      MODE_NAMES.map((mode) => path.join(skillsDir, mode, 'SKILL.md')),
      ZCODE_SKILL_MANAGED_MARKER,
    );
    return {
      present: true,
      ready: hasSkills,
      target: 'AGENTS.md + .zcode/skills/',
      readyDetail: hasSkills
        ? 'managed block and skills present'
        : 'mode skills are missing, incomplete, or user-authored',
    };
  }

  // copilot
  const hasBlock = await fileHasManagedBlock(
    path.join(rootDir, '.github', 'copilot-instructions.md'),
  );
  if (!hasBlock) {
    return {
      present: false,
      ready: false,
      target: '.github/copilot-instructions.md',
      readyDetail: 'managed block missing',
    };
  }
  // If .github/prompts/ exists (non-minimal install), verify at least one prompt.
  // Minimal installs have no prompts directory, so ready stays true.
  const promptsDir = path.join(rootDir, '.github', 'prompts');
  if (await pathExists(promptsDir)) {
    const hasPrompt = await pathExists(path.join(promptsDir, 'man8.prompt.md'));
    return {
      present: hasPrompt,
      ready: hasPrompt,
      target: '.github/copilot-instructions.md + .github/prompts/',
      readyDetail: hasPrompt
        ? 'managed block and prompts present'
        : 'prompts directory exists but man8 prompt missing',
    };
  }
  return {
    present: true,
    ready: true,
    target: '.github/copilot-instructions.md',
    readyDetail: 'managed block present',
  };
}

function describeStatus(
  installed: boolean,
  readiness: { present: boolean; ready: boolean; readyDetail: string },
): string {
  if (installed && readiness.present) return readiness.readyDetail;
  if (!installed && readiness.present) {
    return 'target files present but platform is not recorded in config';
  }
  return 'missing generated files or registration';
}

async function allPathsExist(paths: string[]): Promise<boolean> {
  const results = await Promise.all(paths.map(pathExists));
  return results.every(Boolean);
}

async function allManagedSkills(
  paths: string[],
  marker: string,
): Promise<boolean> {
  const results = await Promise.all(
    paths.map((filePath) => fileHasText(filePath, marker)),
  );
  return results.every(Boolean);
}

async function fileHasText(filePath: string, needle: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.includes(needle);
  } catch {
    return false;
  }
}

async function isPlatformMinimal(
  rootDir: string,
  platform: string,
): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(raw) as { platformOptions?: unknown };
    if (!isRecord(config.platformOptions)) return false;
    const options = config.platformOptions[platform];
    return isRecord(options) && options.minimal === true;
  } catch {
    return false;
  }
}

async function fileHasManagedBlock(
  filePath: string,
  startMarker = DEFAULT_MANCODE_START_MARKER,
  endMarker = DEFAULT_MANCODE_END_MARKER,
): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return hasManagedBlock(content, startMarker, endMarker);
  } catch {
    return false;
  }
}

async function claudeHooksRegistered(rootDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, '.claude', 'settings.json'),
      'utf-8',
    );
    const settings = JSON.parse(raw);
    return hooksRegistered(settings);
  } catch {
    return false;
  }
}

function hooksRegistered(settings: unknown): boolean {
  if (!isRecord(settings)) return false;
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return false;

  return (
    hasHookCommand(hooks.SessionStart, '.mancode/hooks/session-start.sh') &&
    hasHookCommand(
      hooks.UserPromptSubmit,
      '.mancode/hooks/user-prompt-submit.sh',
    )
  );
}

function hasHookCommand(value: unknown, needle: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((hook) => {
      if (!isRecord(hook) || typeof hook.command !== 'string') return false;
      return hook.command.includes(needle);
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

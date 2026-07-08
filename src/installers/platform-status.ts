import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MANCODE_CURSOR_CORE_RULE_FILES } from './cursor.js';
import {
  DEFAULT_MANCODE_END_MARKER,
  DEFAULT_MANCODE_START_MARKER,
  hasManagedBlock,
} from './managed-block.js';

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
    ready: installed && readiness.present,
    target: readiness.target,
    detail: describeStatus(installed, readiness),
  };
}

async function checkPlatformReadiness(
  rootDir: string,
  platform: string,
): Promise<{ present: boolean; target: string; readyDetail: string }> {
  if (platform === 'claude-code') {
    const hasSoloSkill = await pathExists(
      path.join(rootDir, '.claude', 'skills', 'solo', 'SKILL.md'),
    );
    const registered = await claudeHooksRegistered(rootDir);
    return {
      present: hasSoloSkill && registered,
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
      target: '.cursor/rules/',
      readyDetail: 'mancode rules present',
    };
  }

  if (platform === 'codex') {
    const hasBlock = await fileHasManagedBlock(path.join(rootDir, 'AGENTS.md'));
    if (!hasBlock) {
      return {
        present: false,
        target: 'AGENTS.md',
        readyDetail: 'managed block missing',
      };
    }
    // If .agents/skills/ exists (non-minimal install), verify at least one mode skill.
    // Minimal installs have no skills directory, so ready stays true.
    const skillsDir = path.join(rootDir, '.agents', 'skills');
    if (await pathExists(skillsDir)) {
      const hasSkill = await pathExists(
        path.join(skillsDir, 'man8', 'SKILL.md'),
      );
      return {
        present: hasSkill,
        target: 'AGENTS.md + .agents/skills/',
        readyDetail: hasSkill
          ? 'managed block and skills present'
          : 'skills directory exists but man8 skill missing',
      };
    }
    return {
      present: true,
      target: 'AGENTS.md',
      readyDetail: 'managed block present',
    };
  }

  // copilot
  const hasBlock = await fileHasManagedBlock(
    path.join(rootDir, '.github', 'copilot-instructions.md'),
  );
  if (!hasBlock) {
    return {
      present: false,
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
      target: '.github/copilot-instructions.md + .github/prompts/',
      readyDetail: hasPrompt
        ? 'managed block and prompts present'
        : 'prompts directory exists but man8 prompt missing',
    };
  }
  return {
    present: true,
    target: '.github/copilot-instructions.md',
    readyDetail: 'managed block present',
  };
}

function describeStatus(
  installed: boolean,
  readiness: { present: boolean; readyDetail: string },
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

async function fileHasManagedBlock(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return hasManagedBlock(
      content,
      DEFAULT_MANCODE_START_MARKER,
      DEFAULT_MANCODE_END_MARKER,
    );
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

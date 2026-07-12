import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALL_AGENTS } from '../templates/agents/index.js';
import { MVP2_SKILLS } from '../templates/skills/index.js';
import {
  isGeneratedClaudeAgent,
  isGeneratedClaudeSkill,
} from './claude-code.js';
import {
  CURSOR_RULE_MANAGED_MARKER,
  MANCODE_CURSOR_CORE_RULE_FILES,
  MANCODE_CURSOR_RULE_FILES,
} from './cursor.js';
import {
  DEFAULT_MANCODE_END_MARKER,
  DEFAULT_MANCODE_START_MARKER,
  hasManagedBlock,
} from './managed-block.js';
import {
  MANCODE_AGENT_SKILL_MARKERS,
  MODE_FILE_MANAGED_MARKER,
  MODE_NAMES,
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

export async function isPlatformPresent(
  rootDir: string,
  platform: string,
): Promise<boolean> {
  return (await checkPlatformReadiness(rootDir, platform)).present;
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
    const [hasSoloSkill, registered, hasHookFiles] = await Promise.all([
      fileMatches(
        path.join(rootDir, '.claude', 'skills', 'solo', 'SKILL.md'),
        (content) => isGeneratedClaudeSkill(content, 'solo'),
      ),
      claudeHooksRegistered(rootDir),
      pathsExist([
        path.join(rootDir, '.mancode', 'hooks', 'session-start.mjs'),
        path.join(rootDir, '.mancode', 'hooks', 'user-prompt-submit.mjs'),
      ]),
    ]);
    const present = hasSoloSkill && registered && hasHookFiles;
    const minimal = await isPlatformMinimal(rootDir, 'claude-code');
    const fullContentReady = minimal
      ? true
      : await claudeFullContentReady(rootDir);
    return {
      present,
      ready: present && fullContentReady,
      target: '.claude/',
      readyDetail:
        present && fullContentReady
          ? minimal
            ? 'solo skill and hooks ready'
            : 'skills, agents, and hooks ready'
          : 'skills, agents, hook files, or hook registration are incomplete',
    };
  }

  if (platform === 'cursor') {
    const hasCoreRules = await allManagedSkills(
      MANCODE_CURSOR_CORE_RULE_FILES.map((file) =>
        path.join(rootDir, '.cursor', 'rules', file),
      ),
      [CURSOR_RULE_MANAGED_MARKER],
    );
    if (await isPlatformMinimal(rootDir, 'cursor')) {
      return {
        present: hasCoreRules,
        ready: hasCoreRules,
        target: '.cursor/rules/',
        readyDetail: 'mancode core rules present',
      };
    }
    const [hasRules, hasCommands] = await Promise.all([
      allManagedSkills(
        MANCODE_CURSOR_RULE_FILES.map((file) =>
          path.join(rootDir, '.cursor', 'rules', file),
        ),
        [CURSOR_RULE_MANAGED_MARKER],
      ),
      allManagedSkills(
        MODE_NAMES.map((mode) =>
          path.join(rootDir, '.cursor', 'commands', `${mode}.md`),
        ),
        [MODE_FILE_MANAGED_MARKER],
      ),
    ]);
    return {
      present: hasCoreRules,
      ready: hasRules && hasCommands,
      target: '.cursor/rules/ + .cursor/commands/',
      readyDetail:
        hasRules && hasCommands
          ? 'mancode rules and commands present'
          : 'mode rules or commands are missing, incomplete, or user-authored',
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
    const skillsDir = path.join(rootDir, '.agents', 'skills');
    const hasSkills = await allManagedSkills(
      MODE_NAMES.map((mode) => path.join(skillsDir, mode, 'SKILL.md')),
      MANCODE_AGENT_SKILL_MARKERS,
    );
    return {
      present: true,
      ready: hasSkills,
      target: 'AGENTS.md + .agents/skills/',
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
    const skillsDir = path.join(rootDir, '.agents', 'skills');
    const hasSkills = await allManagedSkills(
      MODE_NAMES.map((mode) => path.join(skillsDir, mode, 'SKILL.md')),
      MANCODE_AGENT_SKILL_MARKERS,
    );
    return {
      present: true,
      ready: hasSkills,
      target: 'AGENTS.md + .agents/skills/',
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
  if (!(await isPlatformMinimal(rootDir, 'copilot'))) {
    const promptsDir = path.join(rootDir, '.github', 'prompts');
    const hasPrompts = await allManagedSkills(
      MODE_NAMES.map((mode) => path.join(promptsDir, `${mode}.prompt.md`)),
      [MODE_FILE_MANAGED_MARKER],
    );
    return {
      present: true,
      ready: hasPrompts,
      target: '.github/copilot-instructions.md + .github/prompts/',
      readyDetail: hasPrompts
        ? 'managed block and prompts present'
        : 'mode prompts are missing, incomplete, or user-authored',
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

async function allManagedSkills(
  paths: string[],
  markers: readonly string[],
): Promise<boolean> {
  const results = await Promise.all(
    paths.map((filePath) => fileHasAnyMarker(filePath, markers)),
  );
  return results.every(Boolean);
}

async function claudeFullContentReady(rootDir: string): Promise<boolean> {
  const skillChecks = MVP2_SKILLS.map((skill) =>
    fileMatches(
      path.join(rootDir, '.claude', 'skills', skill.name, 'SKILL.md'),
      (content) => isGeneratedClaudeSkill(content, skill.name),
    ),
  );
  const agentChecks = ALL_AGENTS.map((agent) =>
    fileMatches(
      path.join(rootDir, '.claude', 'agents', `${agent.name}.md`),
      (content) => isGeneratedClaudeAgent(content, agent.name),
    ),
  );
  const results = await Promise.all([...skillChecks, ...agentChecks]);
  return results.every(Boolean);
}

async function fileMatches(
  filePath: string,
  predicate: (content: string) => boolean,
): Promise<boolean> {
  try {
    return predicate(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return false;
  }
}

async function pathsExist(paths: string[]): Promise<boolean> {
  return (await Promise.all(paths.map(pathExists))).every(Boolean);
}

async function fileHasAnyMarker(
  filePath: string,
  needles: readonly string[],
): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return needles.some((needle) => content.includes(needle));
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
    hasHookCommand(hooks.SessionStart, '.mancode/hooks/session-start.mjs') &&
    hasHookCommand(
      hooks.UserPromptSubmit,
      '.mancode/hooks/user-prompt-submit.mjs',
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

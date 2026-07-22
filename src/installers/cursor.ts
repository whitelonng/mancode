import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installMancodeCore } from './common.js';
import { installCursorCommands, renderModeSkill } from './mode-skills.js';
import type { InstallAdapterOptions } from './registry.js';
import { generateSharedContent } from './shared-content.js';

export const MANCODE_CURSOR_CORE_RULE_FILES = [
  'mancode-context.mdc',
  'mancode-practice.mdc',
  'mancode-solo.mdc',
] as const;

export const MANCODE_CURSOR_ADVANCED_RULE_FILES = [
  'mancode-manba.mdc',
  'mancode-man.mdc',
  'mancode-manteam.mdc',
  'mancode-manps.mdc',
] as const;

export const MANCODE_CURSOR_LEGACY_RULE_FILES = [
  'mancode-mamba.mdc',
  'mancode-man8.mdc',
] as const;

export const CURSOR_RULE_MANAGED_MARKER =
  '<!-- Managed by mancode:cursor-rule. Do not edit this marker. -->';

export const MANCODE_CURSOR_RULE_FILES = [
  ...MANCODE_CURSOR_CORE_RULE_FILES,
  ...MANCODE_CURSOR_ADVANCED_RULE_FILES,
] as const;

export async function installCursor(
  projectRoot: string,
  options: InstallAdapterOptions,
): Promise<void> {
  await installMancodeCore(projectRoot);

  const rulesDir = path.join(projectRoot, '.cursor', 'rules');
  await mkdir(rulesDir, { recursive: true });

  const sharedContent = await generateSharedContent(projectRoot, {
    platform: 'cursor',
    displayName: 'Cursor',
    capabilities: {
      slashCommands: 'native',
      subagents: false,
      hooks: false,
      skills: 'rules',
    },
    // Keep the always-applied context rule compact; full mode guidance lives in
    // the mode-specific Cursor rules below.
    minimal: true,
    techStack: options.techStack,
    uiLibrary: options.uiLibrary,
    projectProfile: options.projectProfile,
  });

  await writeRule(
    rulesDir,
    'mancode-context.mdc',
    'mancode project context, style tokens, and default constraints',
    true,
    sharedContent,
  );
  await writeRule(
    rulesDir,
    'mancode-practice.mdc',
    'mancode YAGNI ladder and three-question practice reminder',
    true,
    renderPracticeRule(),
  );
  await writeRule(
    rulesDir,
    'mancode-solo.mdc',
    'mancode solo mode for small focused implementation tasks',
    true,
    renderSoloRule(),
  );

  if (options.minimal) {
    await removeAdvancedRules(rulesDir);
    await installCursorCommands(projectRoot, true);
    return;
  }

  await writeRule(
    rulesDir,
    'mancode-manba.mdc',
    'Use for bug diagnosis and real regression testing',
    false,
    renderManbaRule(),
  );
  await writeRule(
    rulesDir,
    'mancode-man.mdc',
    'Use when the user invokes /man or asks for high-risk implementation with review',
    false,
    renderManRule(),
  );
  await writeRule(
    rulesDir,
    'mancode-manteam.mdc',
    'Use when the user invokes /manteam or asks for team handoff-aware implementation',
    false,
    renderManteamRule(),
  );
  await writeRule(
    rulesDir,
    'mancode-manps.mdc',
    'Use when the user invokes /manps or asks for project health cleanup',
    false,
    renderManpsRule(),
  );
  await removeLegacyCursorRules(projectRoot);

  await installCursorCommands(projectRoot, options.minimal ?? false);
}

async function writeRule(
  rulesDir: string,
  fileName: (typeof MANCODE_CURSOR_RULE_FILES)[number],
  description: string,
  alwaysApply: boolean,
  body: string,
): Promise<void> {
  const frontmatter = [
    '---',
    `description: ${JSON.stringify(description)}`,
    `alwaysApply: ${alwaysApply ? 'true' : 'false'}`,
  ];
  if (alwaysApply) {
    frontmatter.push('globs: "**/*"');
  }
  frontmatter.push('---');

  const content = `${frontmatter.join('\n')}\n\n${body.trim()}\n`;
  const rulePath = path.join(rulesDir, fileName);
  const existing = await readTextIfExists(rulePath);
  if (existing !== null && !isGeneratedCursorRule(existing, fileName)) {
    throw new Error(
      `refusing to overwrite user-authored Cursor rule: ${rulePath}`,
    );
  }
  await writeFile(
    rulePath,
    content.replace('---\n\n', `---\n\n${CURSOR_RULE_MANAGED_MARKER}\n\n`),
    'utf-8',
  );
}

async function removeAdvancedRules(rulesDir: string): Promise<void> {
  for (const fileName of MANCODE_CURSOR_ADVANCED_RULE_FILES) {
    await removeGeneratedCursorRule(rulesDir, fileName);
  }
  await removeLegacyCursorRules(path.dirname(path.dirname(rulesDir)));
}

/** Remove current Cursor rules only when they are mancode-generated. */
export async function removeCursorGeneratedRules(
  projectRoot: string,
): Promise<void> {
  const rulesDir = path.join(projectRoot, '.cursor', 'rules');
  for (const fileName of MANCODE_CURSOR_RULE_FILES) {
    await removeGeneratedCursorRule(rulesDir, fileName);
  }
  await removeLegacyCursorRules(projectRoot);
}

/** Remove old public mode rules only when they are mancode-generated. */
export async function removeLegacyCursorRules(
  projectRoot: string,
): Promise<void> {
  const rulesDir = path.join(projectRoot, '.cursor', 'rules');
  for (const fileName of MANCODE_CURSOR_LEGACY_RULE_FILES) {
    await removeGeneratedCursorRule(rulesDir, fileName);
  }
}

async function removeGeneratedCursorRule(
  rulesDir: string,
  fileName:
    | (typeof MANCODE_CURSOR_RULE_FILES)[number]
    | (typeof MANCODE_CURSOR_LEGACY_RULE_FILES)[number],
): Promise<void> {
  const rulePath = path.join(rulesDir, fileName);
  const content = await readTextIfExists(rulePath);
  if (content && isGeneratedCursorRule(content, fileName)) {
    await rm(rulePath, { force: true });
  }
}

function isGeneratedCursorRule(
  content: string,
  fileName:
    | (typeof MANCODE_CURSOR_RULE_FILES)[number]
    | (typeof MANCODE_CURSOR_LEGACY_RULE_FILES)[number],
): boolean {
  if (content.includes(CURSOR_RULE_MANAGED_MARKER)) return true;
  if (fileName === 'mancode-context.mdc') {
    return (
      content.includes('# mancode Configuration') &&
      content.includes('Platform adapter: Cursor')
    );
  }
  if (fileName === 'mancode-practice.mdc') {
    return (
      content.includes('# mancode Practice') && content.includes('YAGNI ladder')
    );
  }
  if (fileName === 'mancode-solo.mdc') {
    return (
      content.includes('# mancode solo') && content.includes('Use solo mode')
    );
  }
  const mode = fileName.replace(/^mancode-/, '').replace(/\.mdc$/, '');
  return (
    content.includes(`# mancode ${mode} —`) &&
    content.includes('## Mode Persistence')
  );
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function renderPracticeRule(): string {
  return [
    '# mancode Practice',
    '',
    'Before writing code, apply the YAGNI ladder:',
    '',
    '1. Reuse existing project code.',
    '2. Use the standard library.',
    '3. Use platform-native behavior.',
    '4. Use already installed dependencies.',
    '5. Prefer a one-line fix when it is enough.',
    '6. Only then write the smallest new implementation.',
    '',
    'For each request, consider why this change is needed, what already exists, and what the smallest useful diff is.',
  ].join('\n');
}

function renderSoloRule(): string {
  return [
    '# mancode solo',
    '',
    'Use solo mode for small, focused tasks.',
    '',
    '- Keep the diff narrow.',
    '- Reuse existing functions, components, styles, and dependencies.',
    '- Read `.mancode/project-profile.json` before choosing tools or validation. For detected UI assets and UI work, read `.mancode/aesthetics/style-tokens.json` and inspect existing components before inventing new styles.',
    '- Verify with the narrowest meaningful test, lint, build, or smoke check.',
    '- Perform one bounded self-check limited to the current diff. Do not start another reviewer, create a review artifact, or repeat the review.',
    '- Recommend /man and explain why when platform entry/flow differs, the semantic owner or source of truth is unclear, status/contract/policy semantics change, scope/architecture/cost/acceptance crosses files or modules, or historical compatibility, migration, cross-platform, or team evidence is required. Auth, payment, sensitive data, deletion, public APIs, untrusted input, concurrency, and infrastructure remain hard-risk signals. Advice alone never changes mode, step, policy, or authority.',
    '- While executing confirmed requirements/plan, new evidence that invalidates its goal, owner, source of truth, acceptance, or scope, or a stale adapter/incompatible writer/unfinished operation/active child/open handoff/active solo assignment, requires the read-only diagnostic `NEEDS_REALIGNMENT` with reason `MANCODE_REFRAME_REQUIRED`. Preserve authority and do not call generic workflow update or modify metadata, requirements, plan, ledgers, claims, or handoffs.',
  ].join('\n');
}

function renderManbaRule(): string {
  return renderModeSkill('manba', '/');
}

function renderManRule(): string {
  return renderModeSkill('man', '/');
}

function renderManteamRule(): string {
  return renderModeSkill('manteam', '/');
}

function renderManpsRule(): string {
  return renderModeSkill('manps', '/');
}

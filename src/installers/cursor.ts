import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installMancodeCore } from './common.js';
import type { InstallAdapterOptions } from './registry.js';
import { generateSharedContent } from './shared-content.js';

export const MANCODE_CURSOR_CORE_RULE_FILES = [
  'mancode-context.mdc',
  'mancode-practice.mdc',
  'mancode-solo.mdc',
] as const;

export const MANCODE_CURSOR_ADVANCED_RULE_FILES = [
  'mancode-man8.mdc',
  'mancode-man.mdc',
  'mancode-manteam.mdc',
  'mancode-manps.mdc',
] as const;

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
    return;
  }

  await writeRule(
    rulesDir,
    'mancode-man8.mdc',
    'Use when the user invokes /man8 or asks for investigation and planning before implementation',
    false,
    renderMan8Rule(),
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

  await writeFile(path.join(rulesDir, fileName), content, 'utf-8');
}

async function removeAdvancedRules(rulesDir: string): Promise<void> {
  for (const fileName of MANCODE_CURSOR_ADVANCED_RULE_FILES) {
    await rm(path.join(rulesDir, fileName), { force: true });
  }
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
    '- For UI work, read `.mancode/aesthetics/style-tokens.json` and inspect existing components before inventing new styles.',
    '- Verify with the narrowest meaningful test, lint, build, or smoke check.',
  ].join('\n');
}

function renderMan8Rule(): string {
  return [
    '# mancode man8',
    '',
    'Use this when the user asks for /man8, planning, investigation, architecture, migration, integration, or risk assessment.',
    '',
    'Cursor does not provide isolated mancode subagents. Simulate the flow in sequence:',
    '',
    '1. Scout: inspect the relevant code and summarize constraints.',
    '2. Head Coach: write a concrete implementation plan.',
    '3. Stop for user approval when the user asked for planning only.',
  ].join('\n');
}

function renderManRule(): string {
  return [
    '# mancode man',
    '',
    'Use this when the user asks for /man or a high-risk production change.',
    '',
    'Simulate the full workflow in one conversation:',
    '',
    '1. Scout investigates the codebase.',
    '2. Head Coach proposes the plan.',
    '3. Wait for approval when required.',
    '4. Implement and self-test.',
    '5. Film Analyst Offense reviews readability, DRY, and YAGNI.',
    '6. Fix review findings.',
    '7. Film Analyst Defense reviews auth, injection, concurrency, and resource risks.',
    '8. Summarize verification and remaining risk.',
  ].join('\n');
}

function renderManteamRule(): string {
  return [
    '# mancode manteam',
    '',
    'Use this when the user asks for /manteam or when the task affects shared team context.',
    '',
    '- Read `.mancode/memory/prd.md`, `.mancode/memory/spec.md`, and `.mancode/memory/decisions.md` when relevant.',
    '- Preserve decisions and leave handoff-friendly summaries.',
    '- Prefer Conventional Commit style when suggesting commits.',
  ].join('\n');
}

function renderManpsRule(): string {
  return [
    '# mancode manps',
    '',
    'Use this when the user asks for /manps or project health cleanup.',
    '',
    '- Prefer `mancode manps [area]` before manual cleanup.',
    '- Supported areas: all, deps, security, dead-code, config.',
    '- Treat scan output as triage data; do not remediate without clear user approval.',
  ].join('\n');
}

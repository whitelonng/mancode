import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Mode skill names — used for .agents/skills/, .cursor/commands/, .github/prompts/
 */
export const MODE_NAMES = [
  'man8',
  'man',
  'manteam',
  'manps',
  'mansolo',
] as const;
export type ModeName = (typeof MODE_NAMES)[number];

/**
 * Generate SKILL.md body content for a mode.
 *
 * Shared across Codex (.agents/skills/), Cursor (.cursor/commands/),
 * and Copilot (.github/prompts/). The content is platform-agnostic —
 * it assumes no subagents, no hooks, and instructs the AI to simulate
 * the coaching staff in sequence within a single conversation.
 */
export function renderModeSkill(mode: ModeName): string {
  const meta = MODE_META[mode];
  return [
    meta.intro,
    '',
    '## Mode Persistence',
    '',
    'Continue following these instructions for ALL subsequent tasks in this',
    'conversation until the user switches modes ($man8, $man, $manteam, $manps, $mansolo).',
    '',
    'When entering this mode, update `.mancode/state.json` and set',
    `"currentMode" to "${mode}" so the mode persists across session restarts.`,
    'If unsure whether a mode is active, read `.mancode/state.json` to verify.',
    '',
    '## Practice',
    '',
    'Before writing new code, check the YAGNI ladder:',
    '',
    '1. Reuse existing project code.',
    '2. Use the standard library.',
    '3. Use platform-native behavior.',
    '4. Use already installed dependencies.',
    '5. Prefer a one-line fix when it is enough.',
    '6. Only then write the smallest new implementation.',
    '',
    'For every task, consider: why this change, what already exists, and what',
    'is the smallest useful diff?',
    '',
    'For UI tasks, read `.mancode/aesthetics/style-tokens.json` for current',
    'design tokens before inventing new styles.',
    '',
    meta.workflow,
  ].join('\n');
}

/**
 * Write mode skill files for Codex (.agents/skills/<name>/SKILL.md).
 */
export async function installCodexSkills(
  projectRoot: string,
  minimal: boolean,
): Promise<void> {
  if (minimal) {
    await removeCodexSkills(projectRoot);
    return;
  }
  const skillsDir = path.join(projectRoot, '.agents', 'skills');
  for (const mode of MODE_NAMES) {
    const modeDir = path.join(skillsDir, mode);
    await mkdir(modeDir, { recursive: true });
    const meta = MODE_META[mode];
    const content = [
      '---',
      `name: ${mode}`,
      `description: ${JSON.stringify(meta.description)}`,
      '---',
      '',
      renderModeSkill(mode),
      '',
    ].join('\n');
    await writeFile(path.join(modeDir, 'SKILL.md'), content, 'utf-8');
  }
}

/**
 * Write command files for Cursor (.cursor/commands/<name>.md).
 */
export async function installCursorCommands(
  projectRoot: string,
  minimal: boolean,
): Promise<void> {
  if (minimal) {
    await removeCursorCommands(projectRoot);
    return;
  }
  const commandsDir = path.join(projectRoot, '.cursor', 'commands');
  await mkdir(commandsDir, { recursive: true });
  for (const mode of MODE_NAMES) {
    const meta = MODE_META[mode];
    const content = [
      '---',
      `description: ${JSON.stringify(meta.description)}`,
      '---',
      '',
      renderModeSkill(mode),
      '',
    ].join('\n');
    await writeFile(path.join(commandsDir, `${mode}.md`), content, 'utf-8');
  }
}

/**
 * Write prompt files for Copilot (.github/prompts/<name>.prompt.md).
 */
export async function installCopilotPrompts(
  projectRoot: string,
  minimal: boolean,
): Promise<void> {
  if (minimal) {
    await removeCopilotPrompts(projectRoot);
    return;
  }
  const promptsDir = path.join(projectRoot, '.github', 'prompts');
  await mkdir(promptsDir, { recursive: true });
  for (const mode of MODE_NAMES) {
    const meta = MODE_META[mode];
    const content = [
      '---',
      `description: ${JSON.stringify(meta.description)}`,
      '---',
      '',
      renderModeSkill(mode),
      '',
    ].join('\n');
    await writeFile(
      path.join(promptsDir, `${mode}.prompt.md`),
      content,
      'utf-8',
    );
  }
}

export async function removeCodexSkills(projectRoot: string): Promise<void> {
  for (const mode of MODE_NAMES) {
    await rm(path.join(projectRoot, '.agents', 'skills', mode), {
      recursive: true,
      force: true,
    });
  }
}

export async function removeCursorCommands(projectRoot: string): Promise<void> {
  for (const mode of MODE_NAMES) {
    await rm(path.join(projectRoot, '.cursor', 'commands', `${mode}.md`), {
      force: true,
    });
  }
}

export async function removeCopilotPrompts(projectRoot: string): Promise<void> {
  for (const mode of MODE_NAMES) {
    await rm(
      path.join(projectRoot, '.github', 'prompts', `${mode}.prompt.md`),
      { force: true },
    );
  }
}

interface ModeMeta {
  description: string;
  intro: string;
  workflow: string;
}

const MODE_META: Record<ModeName, ModeMeta> = {
  man8: {
    description:
      'Investigate first, then produce a plan before implementation. Use when the user asks for man8, planning, architecture, migration, integration, or risk assessment.',
    intro: '# mancode man8 — Investigate and Plan',
    workflow: [
      '## Workflow (simulate in single conversation)',
      '',
      'This platform does not provide isolated subagents. Simulate the coaching',
      'staff in sequence:',
      '',
      '1. **Scout**: Investigate the relevant code and summarize constraints,',
      '   existing patterns, and dependencies.',
      '2. **Head Coach**: Write a concrete implementation plan based on the',
      '   Scout findings.',
      '3. **Stop for user approval** before implementing. Do not write code',
      '   until the user confirms.',
      '',
      'After user approval, switch to solo mode (update state.json currentMode',
      'to "solo") and implement the plan.',
    ].join('\n'),
  },
  man: {
    description:
      'Full high-risk workflow with plan, implementation, verification, and review. Use when the user asks for man or a high-risk production change.',
    intro: '# mancode man — Full Review Workflow',
    workflow: [
      '## Workflow (simulate in single conversation)',
      '',
      'This platform does not provide isolated subagents. Simulate the full',
      'coaching staff workflow in sequence:',
      '',
      '1. **Scout**: Investigate the codebase and summarize constraints.',
      '2. **Head Coach**: Propose a concrete implementation plan.',
      '3. **Wait for approval** when the task is high-risk.',
      '4. **Implement** the plan and self-test.',
      '5. **Film Analyst Offense**: Review readability, DRY, and YAGNI.',
      '6. **Fix** review findings.',
      '7. **Film Analyst Defense**: Review auth, injection, concurrency, and',
      '   resource risks.',
      '8. **Summarize** verification results and remaining risk.',
    ].join('\n'),
  },
  manteam: {
    description:
      'Team-aware workflow with handoff-friendly summaries. Use when the user asks for manteam or when the task affects shared team context.',
    intro: '# mancode manteam — Team Workflow',
    workflow: [
      '## Workflow',
      '',
      '1. Read `.mancode/memory/prd.md`, `.mancode/memory/spec.md`, and',
      '   `.mancode/memory/decisions.md` when relevant.',
      '2. Preserve decisions and leave handoff-friendly summaries.',
      '3. Prefer Conventional Commit style when suggesting commits.',
      '4. Simulate the coaching staff in sequence (same as man mode) but',
      '   with extra emphasis on documentation and handoff clarity.',
    ].join('\n'),
  },
  manps: {
    description:
      'Run project health and cleanup scans before remediation. Use when the user asks for manps or project health cleanup.',
    intro: '# mancode manps — Project Health Scan',
    workflow: [
      '## Workflow',
      '',
      '1. Run `mancode manps [area]` to scan for tech debt, unused dependencies,',
      '   security issues, dead code, and config drift.',
      '2. Supported areas: all, deps, security, dead-code, config.',
      '3. Treat scan output as triage data — do not remediate without clear',
      '   user approval for each item.',
      '4. Present findings as a prioritized list with severity and recommendation.',
    ].join('\n'),
  },
  mansolo: {
    description:
      'Exit any active mancode mode and return to default solo behavior.',
    intro: '# mancode mansolo — Return to Solo',
    workflow: [
      '## Solo Behavior',
      '',
      'You are now in solo (default) mode.',
      '',
      'Update `.mancode/state.json` and set `currentMode` to "solo".',
      '',
      '- Keep the diff narrow.',
      '- Reuse existing functions, components, styles, and dependencies.',
      '- For UI work, read `.mancode/aesthetics/style-tokens.json`.',
      '- Verify with the narrowest meaningful test, lint, build, or smoke check.',
    ].join('\n'),
  },
};

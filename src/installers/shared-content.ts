import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlatformCapabilities, PlatformName } from './registry.js';

export interface SharedContentOptions {
  platform: PlatformName;
  displayName: string;
  capabilities: PlatformCapabilities;
  minimal?: boolean;
  techStack: string[];
  uiLibrary: string | null;
  projectProfile?: ProjectProfileOnDisk;
}

interface MancodeStateOnDisk {
  currentMode?: string;
  activeSoloPlan?: { taskId?: string; planVersion?: number } | null;
  techStack?: string;
  uiLibrary?: string;
}

interface StyleTokensOnDisk {
  colors?: Record<string, unknown>;
  fonts?: Record<string, unknown>;
  components?: unknown[];
  cssVariables?: Record<string, unknown>;
  uiLibrary?: string | null;
  darkMode?: string | null;
  matchLevel?: string;
}

interface ProjectProfileOnDisk {
  projectKind?: string;
  languages?: string[];
  frameworks?: string[];
  availableValidation?: string[];
  uiAssets?: 'none' | 'detected';
}

export async function generateSharedContent(
  projectRoot: string,
  options: SharedContentOptions,
): Promise<string> {
  const [state, tokens, profile] = await Promise.all([
    readJson<MancodeStateOnDisk>(
      path.join(projectRoot, '.mancode', 'state.json'),
    ),
    readJson<StyleTokensOnDisk>(
      path.join(projectRoot, '.mancode', 'aesthetics', 'style-tokens.json'),
    ),
    readJson<ProjectProfileOnDisk>(
      path.join(projectRoot, '.mancode', 'project-profile.json'),
    ),
  ]);
  const currentProfile = options.projectProfile ?? profile;

  const sections = [
    renderProjectContext(state, tokens, profile, options),
    renderPracticeRules(),
    currentProfile?.uiAssets === 'detected' ? renderAesthetics(tokens) : '',
  ];

  if (!options.minimal) {
    sections.push(renderModes(options), renderPlatformDowngrade(options));
  }

  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

function renderProjectContext(
  state: MancodeStateOnDisk | null,
  tokens: StyleTokensOnDisk | null,
  profile: ProjectProfileOnDisk | null,
  options: SharedContentOptions,
): string {
  const currentProfile = options.projectProfile ?? profile;
  const techStack = options.projectProfile
    ? options.techStack.join(' + ') || 'Unknown'
    : state?.techStack || options.techStack.join(' + ') || 'Unknown';
  const uiLibrary = options.projectProfile
    ? options.uiLibrary || 'None'
    : state?.uiLibrary || tokens?.uiLibrary || options.uiLibrary || 'None';
  const mode =
    state?.currentMode === 'mamba' ? 'manba' : state?.currentMode || 'solo';

  return [
    '## mancode Project Context',
    '',
    `- Platform adapter: ${options.displayName}`,
    `- Current mode: ${mode}`,
    `- Tech stack: ${techStack}`,
    `- UI library: ${uiLibrary}`,
    `- Project profile: ${currentProfile?.projectKind || 'unknown'}; validation: ${currentProfile?.availableValidation?.join(', ') || 'inspect project'}`,
    '- At the start of each session, read `.mancode/state.json` to check the current mode and project context.',
    ...(state?.activeSoloPlan?.taskId
      ? [
          `- Active solo plan: ${state.activeSoloPlan.taskId} (plan v${state.activeSoloPlan.planVersion ?? 1}); read its requirements.md and plan.md before implementation.`,
        ]
      : []),
    '- Read `.mancode/project-profile.json` before choosing tools or validation. Only for a UI task in a profile with detected UI assets, read `.mancode/aesthetics/style-tokens.json`.',
  ].join('\n');
}

function renderPracticeRules(): string {
  return [
    '## mancode Practice Rules',
    '',
    'Before writing new code, check this YAGNI ladder:',
    '',
    '1. Reuse existing project code.',
    '2. Use the standard library.',
    '3. Use platform-native behavior.',
    '4. Use already installed dependencies.',
    '5. Prefer a one-line fix when it is enough.',
    '6. Only then write the smallest new implementation.',
    '',
    'For every task, consider: why this change, what already exists, and what is the smallest useful diff?',
    '',
    'In solo mode, use the narrowest meaningful validation and one bounded self-check limited to the current diff. Do not start another reviewer or repeat the review. Only recommend man for auth, payment, sensitive data, migrations/deletion, public APIs, untrusted input, concurrency, or infrastructure risk.',
  ].join('\n');
}

function renderAesthetics(tokens: StyleTokensOnDisk | null): string {
  const colors = summarizeRecord(tokens?.colors, 8);
  const fonts = summarizeRecord(tokens?.fonts, 4);
  const cssVariables = summarizeRecord(tokens?.cssVariables, 8);
  const components = summarizeList(tokens?.components, 8);
  const hasTokenSummary = Boolean(
    colors || fonts || cssVariables || components,
  );

  if (!tokens || tokens.matchLevel === 'none' || !hasTokenSummary) {
    const lowConfidence =
      tokens?.matchLevel && tokens.matchLevel !== 'none'
        ? `- Match level: ${tokens.matchLevel}. Inspect existing components manually.`
        : '- No strong project style tokens were detected.';
    return [
      '## mancode Aesthetics',
      '',
      lowConfidence,
      '- For UI work, inspect existing components before inventing new styles.',
    ].join('\n');
  }

  const lines = ['## mancode Aesthetics', ''];
  if (tokens.matchLevel) lines.push(`- Match level: ${tokens.matchLevel}`);
  if (tokens.uiLibrary) lines.push(`- UI library: ${tokens.uiLibrary}`);
  if (tokens.darkMode) lines.push(`- Dark mode: ${tokens.darkMode}`);

  if (colors) lines.push(`- Colors: ${colors}`);
  if (fonts) lines.push(`- Fonts: ${fonts}`);
  if (components) lines.push(`- Components: ${components}`);
  if (cssVariables) lines.push(`- CSS variables: ${cssVariables}`);
  lines.push(
    '- For UI changes, prefer these tokens and components over new ad hoc styling.',
  );

  return lines.join('\n');
}

function renderModes(options: SharedContentOptions): string {
  let commandLabel: string;
  if (options.capabilities.skills === 'agents-skills') {
    commandLabel =
      'Invoke mode skills with `$man`, `$manba`, `$manteam`, `$manps`, `$mansolo`.';
  } else if (options.capabilities.slashCommands === 'native') {
    commandLabel = 'Use the named commands directly when available.';
  } else {
    commandLabel =
      'Treat these as prompt conventions when native commands are unavailable.';
  }

  return [
    '## mancode Modes',
    '',
    `- solo: default lightweight mode. ${commandLabel}`,
    '- man: progressive governance workflow with planning and optional full execution.',
    '- manba: diagnose bugs and validate real user flows or regressions.',
    '- manteam: use team memory and leave handoff-friendly summaries.',
    '- manps: run project health and cleanup scans before remediation.',
    '- mansolo: return to solo mode.',
  ].join('\n');
}

function renderPlatformDowngrade(options: SharedContentOptions): string {
  if (options.capabilities.subagents && options.capabilities.hooks) {
    return [
      '## mancode Platform Capabilities',
      '',
      '- This platform supports native mancode hooks and isolated subagents.',
    ].join('\n');
  }

  const lines = [
    '## mancode Platform Downgrade',
    '',
    '- This platform does not provide the full Claude Code hook/subagent model.',
  ];

  if (!options.capabilities.hooks) {
    lines.push(
      '- Session and prompt-submit hooks are represented as persistent instructions.',
    );
  }
  if (!options.capabilities.subagents) {
    lines.push(
      '- Simulate the coaching staff in sequence inside the same conversation: Scout, Plan Coach, Head Coach, Film Analyst Offense, Film Analyst Defense.',
    );
  }

  return lines.join('\n');
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function summarizeRecord(
  value: Record<string, unknown> | undefined,
  limit: number,
): string {
  if (!value) return '';
  return Object.entries(value)
    .slice(0, limit)
    .map(([key, item]) => `${key}=${formatValue(item)}`)
    .join(', ');
}

function summarizeList(value: unknown[] | undefined, limit: number): string {
  if (!Array.isArray(value)) return '';
  return value.slice(0, limit).map(formatValue).filter(Boolean).join(', ');
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(' ');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

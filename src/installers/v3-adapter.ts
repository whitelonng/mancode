import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  hasManagedBlock,
  removeManagedBlock,
  replaceManagedBlock,
} from './managed-block.js';
import type { PlatformName } from './registry.js';

/**
 * This is the schema of the generated bootstrap, not a product version.  The
 * schema manifest records the expected renderer schema while physical status
 * is derived from the managed files below.
 */
export const V3_ADAPTER_VERSION = '3';

export const V3_ADAPTER_MANAGED_MARKER =
  '<!-- Managed by mancode:v3-adapter. Do not edit this marker. -->';

const V3_CODEX_START_MARKER = '<!-- mancode:v3:codex:start -->';
const V3_CODEX_END_MARKER = '<!-- mancode:v3:codex:end -->';
const V3_ZCODE_START_MARKER = '<!-- mancode:v3:zcode:start -->';
const V3_ZCODE_END_MARKER = '<!-- mancode:v3:zcode:end -->';
const V3_COPILOT_START_MARKER = '<!-- mancode:v3:copilot:start -->';
const V3_COPILOT_END_MARKER = '<!-- mancode:v3:copilot:end -->';
const RETRIABLE_ADAPTER_READ_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const ADAPTER_READ_MAX_ATTEMPTS = 4;
const ADAPTER_READ_RETRY_DELAY_MS = 25;

export interface V3AdapterCapabilities {
  nativeModeEntry: boolean;
  sessionHook: false;
  promptHook: false;
  sessionIdentity: 'explicit-required';
}

export interface V3PlatformAdapterStatus {
  version: string;
  installed: boolean;
  ready: boolean;
  target: string;
  detail: string;
  capabilities: V3AdapterCapabilities;
}

/**
 * A physical file touched by the V3 bootstrap renderer. Codex and ZCode
 * deliberately share the AGENTS target, so activation journals these files
 * rather than individual platform installs.
 */
export type V3AdapterFileTarget =
  | 'claude-skill'
  | 'cursor-rule'
  | 'agents'
  | 'copilot-instructions';

export interface V3AdapterFilePlan {
  target: V3AdapterFileTarget;
  beforeContent: string | null;
  targetContent: string;
}

export interface V3StagedAdapter {
  platform: PlatformName;
  /** The corresponding live target, relative to the project root. */
  target: string;
  /** The generated candidate, kept under V3 staging rather than the live target. */
  stagingTarget: string;
}

const V3_ADAPTER_FILE_TARGETS: V3AdapterFileTarget[] = [
  'claude-skill',
  'cursor-rule',
  'agents',
  'copilot-instructions',
];

/**
 * Calculates exact file replacements without publishing them. This lets a
 * migration journal bind the combined AGENTS.md result before its first
 * visible write and preserves all user-authored content outside our blocks.
 */
export async function planV3AdapterFiles(
  projectRoot: string,
): Promise<V3AdapterFilePlan[]> {
  const root = path.resolve(projectRoot);
  const existing = new Map<V3AdapterFileTarget, string | null>();
  for (const target of V3_ADAPTER_FILE_TARGETS) {
    existing.set(target, await readAdapterTarget(root, target));
  }
  const agents = existing.get('agents') ?? '';
  const nextAgents = replaceManagedV3BlockText(
    replaceManagedV3BlockText(
      agents,
      V3_CODEX_START_MARKER,
      V3_CODEX_END_MARKER,
      renderV3Bootstrap('codex'),
    ),
    V3_ZCODE_START_MARKER,
    V3_ZCODE_END_MARKER,
    renderV3Bootstrap('zcode'),
  );
  const plans: V3AdapterFilePlan[] = [
    managedFilePlan(
      'claude-skill',
      existing.get('claude-skill') ?? null,
      renderClaudeSkill(renderV3Bootstrap('claude-code')),
    ),
    managedFilePlan(
      'cursor-rule',
      existing.get('cursor-rule') ?? null,
      renderCursorRule(renderV3Bootstrap('cursor')),
    ),
    {
      target: 'agents',
      beforeContent: existing.get('agents') ?? null,
      targetContent: nextAgents,
    },
    {
      target: 'copilot-instructions',
      beforeContent: existing.get('copilot-instructions') ?? null,
      targetContent: replaceManagedV3BlockText(
        existing.get('copilot-instructions') ?? '',
        V3_COPILOT_START_MARKER,
        V3_COPILOT_END_MARKER,
        renderV3Bootstrap('copilot'),
      ),
    },
  ];
  return plans;
}

/** Publishes one precomputed fixed-target replacement with atomic rename. */
export async function applyV3AdapterFilePlan(
  projectRoot: string,
  plan: V3AdapterFilePlan,
): Promise<void> {
  const root = path.resolve(projectRoot);
  if (!V3_ADAPTER_FILE_TARGETS.includes(plan.target)) {
    throw new Error('MANCODE_V3_ADAPTER_TARGET_INVALID');
  }
  if (typeof plan.targetContent !== 'string' || !plan.targetContent.trim()) {
    throw new Error('MANCODE_V3_ADAPTER_TARGET_INVALID');
  }
  const target = v3AdapterTargetPath(root, plan.target);
  await mkdir(path.dirname(target), { recursive: true });
  await atomicWrite(target, plan.targetContent);
}

/**
 * Renders a complete adapter candidate under V3 staging. Shadow integration
 * may inspect this exact replacement without changing a live managed file.
 */
export async function stageV3Adapter(
  projectRoot: string,
  platform: PlatformName,
): Promise<V3StagedAdapter> {
  const root = path.resolve(projectRoot);
  const target = targetFor(platform);
  const content = await renderV3AdapterCandidate(root, platform);
  const stagingTarget = path.join(
    '.mancode',
    'staging',
    'adapters',
    'v3',
    platform,
    target,
  );
  const destination = path.join(root, stagingTarget);
  await mkdir(path.dirname(destination), { recursive: true });
  await atomicWrite(destination, content);
  return { platform, target, stagingTarget };
}

export function v3AdapterTargetPath(
  projectRoot: string,
  target: V3AdapterFileTarget,
): string {
  const root = path.resolve(projectRoot);
  switch (target) {
    case 'claude-skill':
      return path.join(root, '.claude', 'skills', 'mancode-v3', 'SKILL.md');
    case 'cursor-rule':
      return path.join(root, '.cursor', 'rules', 'mancode-v3.mdc');
    case 'agents':
      return path.join(root, 'AGENTS.md');
    case 'copilot-instructions':
      return path.join(root, '.github', 'copilot-instructions.md');
  }
}

/**
 * Writes only stable V3 bootstrap instructions.  In particular, this never
 * creates legacy authority or copies task state into an adapter file.
 */
export async function installV3Adapter(
  projectRoot: string,
  platform: PlatformName,
): Promise<V3PlatformAdapterStatus> {
  const root = path.resolve(projectRoot);
  const content = renderV3Bootstrap(platform);
  switch (platform) {
    case 'claude-code':
      await writeManagedFile(
        path.join(root, '.claude', 'skills', 'mancode-v3', 'SKILL.md'),
        renderClaudeSkill(content),
      );
      break;
    case 'cursor':
      await writeManagedFile(
        path.join(root, '.cursor', 'rules', 'mancode-v3.mdc'),
        renderCursorRule(content),
      );
      break;
    case 'codex':
      await replaceManagedV3Block(
        path.join(root, 'AGENTS.md'),
        V3_CODEX_START_MARKER,
        V3_CODEX_END_MARKER,
        content,
      );
      break;
    case 'copilot':
      await replaceManagedV3Block(
        path.join(root, '.github', 'copilot-instructions.md'),
        V3_COPILOT_START_MARKER,
        V3_COPILOT_END_MARKER,
        content,
      );
      break;
    case 'zcode':
      await replaceManagedV3Block(
        path.join(root, 'AGENTS.md'),
        V3_ZCODE_START_MARKER,
        V3_ZCODE_END_MARKER,
        content,
      );
      break;
  }
  return inspectV3Adapter(root, platform);
}

/** Physical adapter status intentionally does not infer hook approval. */
export async function inspectV3Adapter(
  projectRoot: string,
  platform: PlatformName,
): Promise<V3PlatformAdapterStatus> {
  const root = path.resolve(projectRoot);
  const target = targetFor(platform);
  const installed = await adapterTargetPresent(root, platform);
  return {
    version: V3_ADAPTER_VERSION,
    installed,
    ready: installed,
    target,
    detail: installed
      ? 'V3 bootstrap is present; session identity is explicit-required.'
      : 'V3 bootstrap is not installed.',
    capabilities: capabilitiesFor(platform),
  };
}

/** Actual on-disk inventory for compatibility gates; never trust manifest echo. */
export async function inspectV3AdapterVersions(
  projectRoot: string,
): Promise<Record<PlatformName, string>> {
  const platforms: PlatformName[] = [
    'claude-code',
    'codex',
    'cursor',
    'copilot',
    'zcode',
  ];
  const entries = await Promise.all(
    platforms.map(async (platform) => {
      const status = await inspectV3Adapter(projectRoot, platform);
      return [platform, status.ready ? status.version : 'missing'] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<PlatformName, string>;
}

/** Removes only the V3 bootstrap owned by this renderer, never V3 authority. */
export async function removeV3Adapter(
  projectRoot: string,
  platform: PlatformName,
): Promise<void> {
  const root = path.resolve(projectRoot);
  switch (platform) {
    case 'claude-code':
      await removeManagedFile(
        path.join(root, '.claude', 'skills', 'mancode-v3', 'SKILL.md'),
      );
      return;
    case 'cursor':
      await removeManagedFile(
        path.join(root, '.cursor', 'rules', 'mancode-v3.mdc'),
      );
      return;
    case 'codex':
      await removeManagedV3Block(
        path.join(root, 'AGENTS.md'),
        V3_CODEX_START_MARKER,
        V3_CODEX_END_MARKER,
      );
      return;
    case 'copilot':
      await removeManagedV3Block(
        path.join(root, '.github', 'copilot-instructions.md'),
        V3_COPILOT_START_MARKER,
        V3_COPILOT_END_MARKER,
      );
      return;
    case 'zcode':
      await removeManagedV3Block(
        path.join(root, 'AGENTS.md'),
        V3_ZCODE_START_MARKER,
        V3_ZCODE_END_MARKER,
      );
  }
}

export function renderV3Bootstrap(platform: PlatformName): string {
  const platformLabel = platformLabelFor(platform);
  const modeEntry = capabilitiesFor(platform).nativeModeEntry
    ? 'Use the platform mode entry only as a shortcut; resolve a Context Pack first.'
    : 'This platform has no native V3 mode entry; use the CLI commands explicitly.';
  return [
    '# mancode V3 bootstrap',
    '',
    V3_ADAPTER_MANAGED_MARKER,
    '',
    `- Platform: ${platformLabel}. This file is a non-authoritative bootstrap.`,
    '- Locate the project root before running mancode commands.',
    `- Create or supply an explicit session: \`mancode context session new --client ${platform}\` or \`--session <id>\`.`,
    '- Read current task context with `mancode context show --purpose orient --session <id>`; for anonymous diagnosis, include an explicit `--task <namespace:id>`.',
    '- For a mode entry, request the matching Context Pack purpose: `plan`, `implement`, `review`, `verify`, or `handoff`.',
    '- Perform mutations only through `mancode workflow`, `mancode team`, and `mancode context` commands with their required revision and session arguments.',
    '- Do not persist task, mode, or session state in this adapter file or any legacy state file.',
    `- ${modeEntry}`,
    `- No approved session or prompt hook is assumed. After a real-host spike is recorded for ${platform}, a verified host may provide MANCODE_HOST_SESSION_KEY; otherwise mutations require an explicit \`--session\`.`,
  ].join('\n');
}

async function renderV3AdapterCandidate(
  root: string,
  platform: PlatformName,
): Promise<string> {
  switch (platform) {
    case 'claude-code': {
      const existing = await readAdapterTarget(root, 'claude-skill');
      return managedFilePlan(
        'claude-skill',
        existing,
        renderClaudeSkill(renderV3Bootstrap(platform)),
      ).targetContent;
    }
    case 'cursor': {
      const existing = await readAdapterTarget(root, 'cursor-rule');
      return managedFilePlan(
        'cursor-rule',
        existing,
        renderCursorRule(renderV3Bootstrap(platform)),
      ).targetContent;
    }
    case 'codex': {
      const existing = (await readAdapterTarget(root, 'agents')) ?? '';
      return replaceManagedV3BlockText(
        existing,
        V3_CODEX_START_MARKER,
        V3_CODEX_END_MARKER,
        renderV3Bootstrap(platform),
      );
    }
    case 'copilot': {
      const existing =
        (await readAdapterTarget(root, 'copilot-instructions')) ?? '';
      return replaceManagedV3BlockText(
        existing,
        V3_COPILOT_START_MARKER,
        V3_COPILOT_END_MARKER,
        renderV3Bootstrap(platform),
      );
    }
    case 'zcode': {
      const existing = (await readAdapterTarget(root, 'agents')) ?? '';
      return replaceManagedV3BlockText(
        existing,
        V3_ZCODE_START_MARKER,
        V3_ZCODE_END_MARKER,
        renderV3Bootstrap(platform),
      );
    }
  }
}

function renderClaudeSkill(content: string): string {
  return [
    '---',
    'name: mancode-v3',
    'description: "Stable bootstrap for mancode V3 context and workflow commands."',
    '---',
    '',
    content,
    '',
  ].join('\n');
}

function renderCursorRule(content: string): string {
  return [
    '---',
    'description: "Stable bootstrap for mancode V3 context and workflow commands."',
    'alwaysApply: true',
    'globs: "**/*"',
    '---',
    '',
    content,
    '',
  ].join('\n');
}

async function adapterTargetPresent(
  root: string,
  platform: PlatformName,
): Promise<boolean> {
  switch (platform) {
    case 'claude-code':
      return managedFilePresent(
        path.join(root, '.claude', 'skills', 'mancode-v3', 'SKILL.md'),
      );
    case 'cursor':
      return managedFilePresent(
        path.join(root, '.cursor', 'rules', 'mancode-v3.mdc'),
      );
    case 'codex':
      return managedBlockPresent(
        path.join(root, 'AGENTS.md'),
        V3_CODEX_START_MARKER,
        V3_CODEX_END_MARKER,
      );
    case 'copilot':
      return managedBlockPresent(
        path.join(root, '.github', 'copilot-instructions.md'),
        V3_COPILOT_START_MARKER,
        V3_COPILOT_END_MARKER,
      );
    case 'zcode':
      return managedBlockPresent(
        path.join(root, 'AGENTS.md'),
        V3_ZCODE_START_MARKER,
        V3_ZCODE_END_MARKER,
      );
  }
}

async function writeManagedFile(
  filePath: string,
  content: string,
): Promise<void> {
  const existing = await readTextIfExists(filePath);
  if (existing !== null && !existing.includes(V3_ADAPTER_MANAGED_MARKER)) {
    throw new Error('MANCODE_V3_ADAPTER_TARGET_USER_AUTHORED');
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, content);
}

async function removeManagedFile(filePath: string): Promise<void> {
  const existing = await readTextIfExists(filePath);
  if (existing?.includes(V3_ADAPTER_MANAGED_MARKER)) {
    await rm(filePath, { force: true });
  }
}

async function replaceManagedV3Block(
  filePath: string,
  startMarker: string,
  endMarker: string,
  content: string,
): Promise<void> {
  const existing = (await readTextIfExists(filePath)) ?? '';
  const block = [startMarker, content, endMarker].join('\n');
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(
    filePath,
    replaceManagedBlock(existing, block, startMarker, endMarker),
  );
}

function replaceManagedV3BlockText(
  existing: string,
  startMarker: string,
  endMarker: string,
  content: string,
): string {
  return replaceManagedBlock(
    existing,
    [startMarker, content, endMarker].join('\n'),
    startMarker,
    endMarker,
  );
}

function managedFilePlan(
  target: V3AdapterFileTarget,
  beforeContent: string | null,
  targetContent: string,
): V3AdapterFilePlan {
  if (
    beforeContent !== null &&
    !beforeContent.includes(V3_ADAPTER_MANAGED_MARKER)
  ) {
    throw new Error('MANCODE_V3_ADAPTER_TARGET_USER_AUTHORED');
  }
  return { target, beforeContent, targetContent };
}

async function readAdapterTarget(
  root: string,
  target: V3AdapterFileTarget,
): Promise<string | null> {
  const filePath = v3AdapterTargetPath(root, target);
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  return readFile(filePath, 'utf8');
}

async function removeManagedV3Block(
  filePath: string,
  startMarker: string,
  endMarker: string,
): Promise<void> {
  const existing = await readTextIfExists(filePath);
  if (existing === null || !hasManagedBlock(existing, startMarker, endMarker)) {
    return;
  }
  const cleaned = removeManagedBlock(existing, startMarker, endMarker);
  if (cleaned.trim()) {
    await atomicWrite(filePath, `${cleaned.trimEnd()}\n`);
  } else {
    await rm(filePath, { force: true });
  }
}

async function managedFilePresent(filePath: string): Promise<boolean> {
  const content = await readTextIfExists(filePath);
  return content?.includes(V3_ADAPTER_MANAGED_MARKER) ?? false;
}

async function managedBlockPresent(
  filePath: string,
  startMarker: string,
  endMarker: string,
): Promise<boolean> {
  const content = await readTextIfExists(filePath);
  return content !== null && hasManagedBlock(content, startMarker, endMarker);
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  for (let attempt = 1; attempt <= ADAPTER_READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      if (
        !isRetriableAdapterReadError(error) ||
        attempt === ADAPTER_READ_MAX_ATTEMPTS
      ) {
        throw error;
      }
      await delay(ADAPTER_READ_RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error('MANCODE_V3_ADAPTER_READ_RETRY_EXHAUSTED');
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function targetFor(platform: PlatformName): string {
  switch (platform) {
    case 'claude-code':
      return '.claude/skills/mancode-v3/SKILL.md';
    case 'cursor':
      return '.cursor/rules/mancode-v3.mdc';
    case 'codex':
    case 'zcode':
      return 'AGENTS.md';
    case 'copilot':
      return '.github/copilot-instructions.md';
  }
}

function platformLabelFor(platform: PlatformName): string {
  switch (platform) {
    case 'claude-code':
      return 'Claude Code';
    case 'cursor':
      return 'Cursor';
    case 'codex':
      return 'Codex';
    case 'copilot':
      return 'GitHub Copilot';
    case 'zcode':
      return 'ZCode';
  }
}

function capabilitiesFor(platform: PlatformName): V3AdapterCapabilities {
  return {
    nativeModeEntry: platform === 'claude-code' || platform === 'cursor',
    sessionHook: false,
    promptHook: false,
    sessionIdentity: 'explicit-required',
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isRetriableAdapterReadError(error: unknown): boolean {
  return (
    isNodeError(error) && RETRIABLE_ADAPTER_READ_CODES.has(error.code ?? '')
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

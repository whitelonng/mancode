import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  INTERFACE_EMOJI_ICON_GUIDANCE,
  VISUAL_DIRECTION_SELECTION_GUIDANCE,
} from '../context/design-guidance.js';
import {
  DEFAULT_DESIGN_POLICY,
  type DesignBrowserValidation,
  type DesignEmojiPolicy,
  type DesignIconPolicy,
  type DesignMotionPolicy,
  type DesignPolicyV1,
  type DesignPreset,
  configureDesignPolicy,
  designPolicyPath,
  isDesignBrowserValidation,
  isDesignEmojiPolicy,
  isDesignIconPolicy,
  isDesignMotionPolicy,
  isDesignPreset,
  readDesignPolicy,
} from '../context/design-policy.js';
import { V3ContextStore } from '../context/store.js';
import type { ProjectProfile } from '../system/project-profile.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_DESIGN_FAILED = 2;
export const EXIT_DESIGN_ARGUMENT_INVALID = 3;

export interface DesignOutputOptions {
  json?: boolean;
}

export interface DesignConfigureOptions extends DesignOutputOptions {
  expectedRevision?: string;
  preset?: string;
  icons?: string;
  emoji?: string;
  motion?: string;
  browserValidation?: string;
  confirmExperimental?: boolean;
}

interface SafeStyleSummary {
  scopeRoot: string;
  lastScanned: string | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
  matchLevel: 'high' | 'low' | 'none';
  uiLibrary: string | null;
  darkMode: string | null;
  colors: Record<string, string>;
  fonts: Record<string, string[]>;
  components: string[];
  cssVariables: Record<string, string>;
  sourceFiles: string[];
}

export async function designStatus(
  rootDir: string = process.cwd(),
  options: DesignOutputOptions = {},
): Promise<number> {
  if (!(await initializedKind(rootDir))) {
    return printError(
      options.json,
      'MANCODE_NOT_INITIALIZED',
      'Run `mancode init` first.',
      EXIT_NOT_INITIALIZED,
    );
  }
  const policyResult = await readPolicyFailOpen(rootDir);
  const payload = {
    schemaVersion: 1,
    policyStatus: policyResult.status,
    policy: policyResult.policy,
    effectivePreset:
      policyResult.policy?.enabled === true
        ? policyResult.policy.preset
        : 'preserve',
    effectiveEmojiPolicy: 'forbid-as-interface-icon',
    policyPath: relativePath(rootDir, designPolicyPath(rootDir)),
    warning: effectivePolicyWarning(policyResult.policy, policyResult.warning),
  };
  return printResult(options.json, payload, [
    `Design policy: ${payload.policyStatus}`,
    `Effective preset: ${payload.effectivePreset}`,
    `Effective emoji policy: ${payload.effectiveEmojiPolicy}`,
    `Revision: ${payload.policy?.revision ?? 0}`,
    ...(payload.warning === null ? [] : [`Warning: ${payload.warning}`]),
  ]);
}

export async function designContext(
  rootDir: string = process.cwd(),
  options: DesignOutputOptions = {},
): Promise<number> {
  const kind = await initializedKind(rootDir);
  if (!kind) {
    return printError(
      options.json,
      'MANCODE_NOT_INITIALIZED',
      'Run `mancode init` first.',
      EXIT_NOT_INITIALIZED,
    );
  }
  try {
    const [profile, policyResult, style] = await Promise.all([
      readProfile(rootDir, kind),
      readPolicyFailOpen(rootDir),
      readStyleSummary(rootDir, kind),
    ]);
    const configured = policyResult.policy;
    const active = configured?.enabled === true;
    const policy = effectivePolicy(active ? configured : disabledPolicy());
    const rootUiDetected = profile?.uiAssets === 'detected';
    const scopedUiDetected =
      style.scopeRoot !== '.' && style.lastScanned !== null;
    const applicable = rootUiDetected || scopedUiDetected;
    const payload = {
      schemaVersion: 1,
      applicable,
      reason: rootUiDetected
        ? 'ui_assets_detected'
        : scopedUiDetected
          ? 'scoped_ui_assets_detected'
          : 'ui_assets_not_detected',
      policyStatus: policyResult.status,
      policySource: active ? 'project' : 'built-in-safe-default',
      policy: {
        enabled: policy.enabled,
        revision: configured?.revision ?? 0,
        preset: policy.preset,
        iconPolicy: policy.iconPolicy,
        emojiPolicy: policy.emojiPolicy,
        motionPolicy: policy.motionPolicy,
        browserValidation: policy.browserValidation,
      },
      constraints: active
        ? {
            doNotExpandTaskScope: true,
            reuseExistingDesignSystem: true,
            dependencyChangesRequireTaskApproval: true,
            experimentalDoesNotAuthorizeProductChanges: true,
            interfaceEmojiIconsForbidden: true,
            contentEmojiAllowed: true,
            iconFallbackMustNotBeEmoji: true,
          }
        : {
            doNotExpandTaskScope: true,
            reuseExistingDesignSystem: true,
            interfaceEmojiIconsForbidden: true,
            contentEmojiAllowed: true,
            iconFallbackMustNotBeEmoji: true,
          },
      project: {
        kind: profile?.projectKind ?? 'unknown',
        uiAssets: profile?.uiAssets ?? 'none',
        browserAutomation: profile?.browserAutomation ?? 'unknown',
      },
      guidance: designGuidance(policy),
      qualityGates: designQualityGates(policy),
      style,
      warning: effectivePolicyWarning(configured, policyResult.warning),
    };
    return printResult(options.json, payload, [
      `Applicable: ${payload.applicable ? 'yes' : 'no'}`,
      `Design preset: ${payload.policy.preset}`,
      `Policy: ${payload.policyStatus}`,
      `Style match: ${payload.style.matchLevel} (${payload.style.freshness})`,
    ]);
  } catch (error) {
    return printError(
      options.json,
      'MANCODE_DESIGN_CONTEXT_FAILED',
      error instanceof Error ? error.message : 'Unable to read design context.',
      EXIT_DESIGN_FAILED,
    );
  }
}

export async function designConfigure(
  rootDir: string,
  options: DesignConfigureOptions,
): Promise<number> {
  const availability = await policyMutationAvailability(rootDir, options.json);
  if (availability !== null) return availability;
  const expectedRevision = parseNonNegativeInteger(options.expectedRevision);
  const values = parseConfigureValues(options);
  if (expectedRevision === null || values === null) {
    return printError(
      options.json,
      'MANCODE_DESIGN_ARGUMENT_INVALID',
      'Use valid design policy values and --expected-revision <n>.',
      EXIT_DESIGN_ARGUMENT_INVALID,
    );
  }
  if (
    values.preset === 'experimental' &&
    options.confirmExperimental !== true
  ) {
    return printError(
      options.json,
      'MANCODE_DESIGN_EXPERIMENTAL_CONFIRMATION_REQUIRED',
      'Pass --confirm-experimental to enable the experimental preset.',
      EXIT_DESIGN_ARGUMENT_INVALID,
    );
  }
  try {
    const legacyEmojiAllow = options.emoji === 'allow';
    const result = await configureDesignPolicy({
      projectRoot: rootDir,
      expectedRevision,
      enabled: true,
      confirmExperimental: options.confirmExperimental,
      ...values,
    });
    const warning = legacyEmojiAllow
      ? '--emoji allow is deprecated and was normalized to forbid-as-interface-icon; emoji remains allowed in user-authored content, chat messages, editorial copy, and domain data.'
      : null;
    return printResult(options.json, { schemaVersion: 1, ...result, warning }, [
      `Design policy configured: ${result.policy.preset}`,
      `Revision: ${result.policy.revision}`,
      ...(warning === null ? [] : [`Warning: ${warning}`]),
    ]);
  } catch (error) {
    const code = errorCode(error, 'MANCODE_DESIGN_CONFIGURE_FAILED');
    return printError(
      options.json,
      code,
      error instanceof Error
        ? error.message
        : 'Unable to configure design policy.',
      code === 'MANCODE_DESIGN_EXPERIMENTAL_CONFIRMATION_REQUIRED'
        ? EXIT_DESIGN_ARGUMENT_INVALID
        : EXIT_DESIGN_FAILED,
    );
  }
}

export async function designDisable(
  rootDir: string,
  options: Pick<DesignConfigureOptions, 'expectedRevision' | 'json'>,
): Promise<number> {
  const availability = await policyMutationAvailability(rootDir, options.json);
  if (availability !== null) return availability;
  const expectedRevision = parseNonNegativeInteger(options.expectedRevision);
  if (expectedRevision === null) {
    return printError(
      options.json,
      'MANCODE_DESIGN_ARGUMENT_INVALID',
      'Use --expected-revision <n>.',
      EXIT_DESIGN_ARGUMENT_INVALID,
    );
  }
  try {
    const result = await configureDesignPolicy({
      projectRoot: rootDir,
      expectedRevision,
      enabled: false,
    });
    return printResult(options.json, { schemaVersion: 1, ...result }, [
      'Design policy disabled.',
      `Revision: ${result.policy.revision}`,
    ]);
  } catch (error) {
    return printError(
      options.json,
      errorCode(error, 'MANCODE_DESIGN_DISABLE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to disable design policy.',
      EXIT_DESIGN_FAILED,
    );
  }
}

function parseConfigureValues(options: DesignConfigureOptions): {
  preset?: DesignPreset;
  iconPolicy?: DesignIconPolicy;
  emojiPolicy?: DesignEmojiPolicy;
  motionPolicy?: DesignMotionPolicy;
  browserValidation?: DesignBrowserValidation;
} | null {
  if (options.preset !== undefined && !isDesignPreset(options.preset))
    return null;
  if (options.icons !== undefined && !isDesignIconPolicy(options.icons))
    return null;
  if (options.emoji !== undefined && !isDesignEmojiPolicy(options.emoji))
    return null;
  if (options.motion !== undefined && !isDesignMotionPolicy(options.motion))
    return null;
  if (
    options.browserValidation !== undefined &&
    !isDesignBrowserValidation(options.browserValidation)
  ) {
    return null;
  }
  return {
    preset: options.preset,
    iconPolicy: options.icons,
    emojiPolicy:
      options.emoji === 'allow' ? 'forbid-as-interface-icon' : options.emoji,
    motionPolicy: options.motion,
    browserValidation: options.browserValidation,
  };
}

async function readPolicyFailOpen(rootDir: string): Promise<{
  status: 'configured' | 'missing' | 'invalid';
  policy: DesignPolicyV1 | null;
  warning: string | null;
}> {
  try {
    const policy = await readDesignPolicy(rootDir);
    return policy === null
      ? { status: 'missing', policy: null, warning: null }
      : { status: 'configured', policy, warning: null };
  } catch {
    return {
      status: 'invalid',
      policy: null,
      warning: 'Design policy is invalid; using the built-in preserve policy.',
    };
  }
}

async function readProfile(
  rootDir: string,
  kind: 'continuity' | 'legacy',
): Promise<ProjectProfile | null> {
  if (kind === 'continuity') {
    return (
      (await new V3ContextStore(rootDir).readProjectSnapshot()).projectFacts
        ?.profile ?? null
    );
  }
  try {
    return JSON.parse(
      await readFile(
        path.join(rootDir, '.mancode', 'project-profile.json'),
        'utf8',
      ),
    ) as ProjectProfile;
  } catch {
    return null;
  }
}

async function readStyleSummary(
  rootDir: string,
  kind: 'continuity' | 'legacy',
): Promise<SafeStyleSummary> {
  const cachePath =
    kind === 'continuity'
      ? path.join(rootDir, '.mancode', 'local', 'cache', 'style-tokens.json')
      : path.join(rootDir, '.mancode', 'aesthetics', 'style-tokens.json');
  try {
    const raw = JSON.parse(await readFile(cachePath, 'utf8')) as unknown;
    return sanitizeStyleSummary(rootDir, raw);
  } catch {
    return emptyStyleSummary();
  }
}

async function sanitizeStyleSummary(
  rootDir: string,
  value: unknown,
): Promise<SafeStyleSummary> {
  if (!isRecord(value)) return emptyStyleSummary();
  const scopeRoot = safeScopeRoot(value.scopeRoot);
  const lastScanned = safeTimestamp(value.lastScanned);
  const sourceFiles = safeStringList(value.sourceFiles, 12, isSafeRelativeFile);
  return {
    scopeRoot,
    lastScanned,
    freshness: await styleFreshness(
      rootDir,
      scopeRoot,
      lastScanned,
      sourceFiles,
    ),
    matchLevel: safeMatchLevel(value.matchLevel),
    uiLibrary: safeShortText(value.uiLibrary),
    darkMode: safeShortText(value.darkMode),
    colors: safeStringRecord(value.colors, 8),
    fonts: safeFontRecord(value.fonts, 4),
    components: safeStringList(value.components, 8, (item) =>
      /^[A-Z][A-Za-z0-9]{0,79}$/.test(item),
    ),
    cssVariables: safeStringRecord(value.cssVariables, 8),
    sourceFiles,
  };
}

async function styleFreshness(
  rootDir: string,
  scopeRoot: string,
  lastScanned: string | null,
  sourceFiles: string[],
): Promise<SafeStyleSummary['freshness']> {
  if (lastScanned === null || sourceFiles.length === 0) return 'unavailable';
  const scannedAt = Date.parse(lastScanned);
  for (const file of sourceFiles) {
    try {
      const info = await stat(path.resolve(rootDir, scopeRoot, file));
      if (info.mtimeMs > scannedAt) return 'stale';
    } catch {
      return 'stale';
    }
  }
  return 'fresh';
}

function disabledPolicy(): DesignPolicyV1 {
  return {
    ...DEFAULT_DESIGN_POLICY,
    motionPolicy: 'minimal',
    browserValidation: 'off',
  };
}

function effectivePolicy(policy: DesignPolicyV1): DesignPolicyV1 {
  return policy.emojiPolicy === 'forbid-as-interface-icon'
    ? policy
    : { ...policy, emojiPolicy: 'forbid-as-interface-icon' };
}

function effectivePolicyWarning(
  policy: DesignPolicyV1 | null,
  warning: string | null,
): string | null {
  const legacyWarning =
    policy?.emojiPolicy === 'allow'
      ? 'The legacy emoji policy "allow" is constrained to forbid-as-interface-icon; emoji remains allowed in user-authored content, chat messages, editorial copy, and domain data.'
      : null;
  return [warning, legacyWarning].filter(Boolean).join(' ') || null;
}

function designGuidance(policy: DesignPolicyV1): string[] {
  return [
    directionSelectionGuidance(),
    presetGuidance(policy.preset),
    iconGuidance(policy.iconPolicy),
    emojiGuidance(),
    motionGuidance(policy.motionPolicy),
  ];
}

function directionSelectionGuidance(): string {
  return VISUAL_DIRECTION_SELECTION_GUIDANCE;
}

function presetGuidance(preset: DesignPreset): string {
  if (preset === 'refine') {
    return 'Preserve the product structure while improving hierarchy, typography, spacing, interaction states, and responsive behavior within the task scope.';
  }
  if (preset === 'experimental') {
    return 'After the user chooses a direction, execute one coherent, product-appropriate visual system. For brand, campaign, editorial, portfolio, or launch surfaces, make the first viewport the strongest brand signal and carry its visual motif through the full page; for task-oriented products, prioritize workflow clarity over spectacle. Advanced composition and purposeful motion are allowed only within the task scope and must not obscure core workflows.';
  }
  return 'Retain the existing visual hierarchy, layout, component system, and interaction patterns; make only task-required UI changes.';
}

function iconGuidance(policy: DesignIconPolicy): string {
  return policy === 'lucide'
    ? 'Use Lucide for interface icons when it is already available; adding or replacing a dependency requires explicit task approval.'
    : "Reuse the project's existing icon system; do not introduce another icon library without explicit task approval.";
}

function emojiGuidance(): string {
  return INTERFACE_EMOJI_ICON_GUIDANCE.replace('Never use', 'Do not use');
}

function motionGuidance(policy: DesignMotionPolicy): string {
  return policy === 'purposeful'
    ? 'Use motion only to clarify hierarchy, state changes, or spatial relationships, and preserve reduced-motion accessibility.'
    : 'Keep motion minimal and preserve reduced-motion accessibility.';
}

function designQualityGates(policy: DesignPolicyV1): string[] {
  const browserGate =
    policy.browserValidation === 'required'
      ? 'Validate changed UI in a browser at relevant desktop and mobile viewports before completion; report a blocker if browser validation is unavailable.'
      : policy.browserValidation === 'when-available'
        ? 'When existing browser tooling is available, validate changed UI at relevant desktop and mobile viewports.'
        : 'Use the project checks already available; browser automation is not required by this policy.';
  return [
    'Preserve task-critical workflows, keyboard access, visible focus, readable contrast, and responsive behavior on changed surfaces.',
    'Check changed surfaces for clipping, unintended overlap, horizontal overflow, and unstable layout.',
    'Inspect changed navigation, buttons, controls, actions, and status indicators to confirm that no emoji is used as an interface icon; do not flag emoji in user-authored content, chat messages, editorial copy, or domain data.',
    browserGate,
  ];
}

function emptyStyleSummary(): SafeStyleSummary {
  return {
    scopeRoot: '.',
    lastScanned: null,
    freshness: 'unavailable',
    matchLevel: 'none',
    uiLibrary: null,
    darkMode: null,
    colors: {},
    fonts: {},
    components: [],
    cssVariables: {},
    sourceFiles: [],
  };
}

async function initializedKind(
  rootDir: string,
): Promise<'continuity' | 'legacy' | null> {
  if (await exists(path.join(rootDir, '.mancode', 'schema.json'))) {
    return 'continuity';
  }
  if (await exists(path.join(rootDir, '.mancode', 'state.json')))
    return 'legacy';
  return null;
}

async function policyMutationAvailability(
  rootDir: string,
  json: boolean | undefined,
): Promise<number | null> {
  const kind = await initializedKind(rootDir);
  if (kind === null) {
    return printError(
      json,
      'MANCODE_NOT_INITIALIZED',
      'Run `mancode init` first.',
      EXIT_NOT_INITIALIZED,
    );
  }
  if (kind === 'legacy') {
    return printError(
      json,
      'MANCODE_DESIGN_POLICY_REQUIRES_CONTINUITY',
      'Legacy projects can read the safe preserve context but cannot configure a shared design policy.',
      EXIT_DESIGN_FAILED,
    );
  }
  return null;
}

function safeStringRecord(
  value: unknown,
  limit: number,
): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, string] =>
          /^[A-Za-z0-9_-]{1,80}$/.test(entry[0]) &&
          typeof entry[1] === 'string' &&
          entry[1].length <= 120 &&
          /^[#\w\s,.%()/+-]+$/.test(entry[1]),
      )
      .slice(0, limit),
  );
}

function safeFontRecord(
  value: unknown,
  limit: number,
): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          /^[A-Za-z0-9_-]{1,80}$/.test(key) && Array.isArray(item),
      )
      .map(([key, item]) => [
        key,
        (item as unknown[])
          .filter(
            (font): font is string =>
              typeof font === 'string' &&
              font.length <= 80 &&
              /^[\w\s,'"-]+$/.test(font),
          )
          .slice(0, 6),
      ])
      .filter(([, fonts]) => (fonts as string[]).length > 0)
      .slice(0, limit),
  );
}

function safeStringList(
  value: unknown,
  limit: number,
  predicate: (item: string) => boolean,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string => typeof item === 'string' && predicate(item),
    )
    .slice(0, limit);
}

function safeScopeRoot(value: unknown): string {
  if (value === undefined || value === '.') return '.';
  return typeof value === 'string' && isSafeRelativeFile(value) ? value : '.';
}

function safeTimestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function safeMatchLevel(value: unknown): SafeStyleSummary['matchLevel'] {
  return value === 'high' || value === 'low' ? value : 'none';
}

function safeShortText(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 100 &&
    /^[A-Za-z0-9@/_. -]+$/.test(value)
    ? value
    : null;
}

function isSafeRelativeFile(value: string): boolean {
  return (
    value.length <= 240 &&
    !path.isAbsolute(value) &&
    !value.includes('\0') &&
    value
      .split(/[\\/]/)
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function relativePath(rootDir: string, target: string): string {
  return path.relative(path.resolve(rootDir), target).split(path.sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function printResult(
  json: boolean | undefined,
  payload: unknown,
  lines: string[],
): number {
  if (json) console.log(JSON.stringify(payload));
  else for (const line of lines) console.log(line);
  return EXIT_OK;
}

function printError(
  json: boolean | undefined,
  code: string,
  message: string,
  exitCode: number,
): number {
  if (json) console.log(JSON.stringify({ error: { code, message } }));
  else console.error(`${code}: ${message}`);
  return exitCode;
}

function errorCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const match = error.message.match(/\bMANCODE_[A-Z0-9_]+\b/);
  return match?.[0] ?? fallback;
}

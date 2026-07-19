import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { evaluateCompatibilityGate } from '../context/compatibility.js';
import { assertUlid } from '../context/ids.js';
import { scanLegacyAuthority } from '../context/layout.js';
import { V3ContextStore } from '../context/store.js';
import {
  type PlatformStatus,
  checkPlatformStatus as checkOnePlatformStatus,
} from '../installers/platform-status.js';
import {
  type PlatformName,
  formatPlatformName,
  getPlatformInstallers,
} from '../installers/registry.js';
import {
  type V3PlatformAdapterStatus,
  inspectV3Adapter,
} from '../installers/v3-adapter.js';
import { listPlatformSessionSpikes } from '../runtime/platform-spike-store.js';
import {
  type SessionSpikePlatform,
  platformSpikeFreezeStatus,
} from '../runtime/platform-spike.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { readSession } from '../runtime/session.js';
import {
  detectTeamAssessmentSignals,
  detectTeamStatus,
} from '../system/detect-team.js';
import { PROJECT_MANIFESTS } from '../system/project-profile.js';
import {
  type WorkflowMode,
  type WorkflowOutcome,
  type WorkflowStatus,
  listWorkflows,
  maxWorkflowStep,
  readWorkflow,
} from '../system/workflow.js';
import { readLocalActor } from '../team/actor.js';
import { type TeamAssessment, assessTeam } from '../team/assessment.js';
import {
  capabilitiesFromGitRefCache,
  readGitRefTeamCache,
} from '../team/git-ref-cache.js';
import { capabilitiesFromProjectConfig } from '../team/transport.js';
import { VERSION } from '../version.js';

const HOOK_ESTIMATE_TIMEOUT_MS = 2000;

/**
 * 退出码契约 — 见 docs/08-cli-spec.md §4
 */
export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_CORRUPT_STATE = 2;

/**
 * status 命令读取的 state.json 结构。
 *
 * 与 init.ts 的 MancodeState 字段一致，但所有字段放宽为 string，
 * 因为 status 是从磁盘读取——不应因字段类型限制而失败。
 */
export interface StatusState {
  version: string;
  currentMode: string;
  platform: string;
  initializedAt: string;
  techStack: string;
  uiLibrary: string;
  currentTask?: string | null;
  currentWorkflowMode?: string | null;
  activeSoloPlan?: { taskId: string; planVersion: number } | null;
  teamModeAutoDetected?: boolean;
  contributors?: number;
  projectMode?: 'generic' | 'detected';
}

export interface StatusOptions {
  /** --json: 输出 JSON（脚本用）*/
  json?: boolean;
}

export interface StatusResult {
  version: string;
  project: string;
  techStack: string;
  mode: string;
  platforms: string[];
  uiLibrary: string;
  initializedAt: string;
  hooks: {
    sessionStart: boolean;
    userPromptSubmit: boolean;
    registered: boolean;
  };
  hookInjection: {
    tokens: number;
    cap: number;
  };
  team: {
    isTeam: boolean;
    contributors: number;
    recentActive: number;
    hasRemote: boolean;
    autoDetected: boolean;
    forced: boolean;
  };
  currentWorkflow: {
    taskId: string;
    task: string;
    mode: WorkflowMode;
    currentStep: number;
    status: WorkflowStatus;
    blockingReason?: string;
    parentTaskId?: string;
    outcome?: WorkflowOutcome;
    planVersion?: number;
    activeChildren?: Array<{
      taskId: string;
      currentStep: number;
      status: WorkflowStatus;
    }>;
  } | null;
  activeSoloPlan: { taskId: string; planVersion: number } | null;
  platformStatus: Record<string, PlatformStatus>;
  projectRefreshRecommended: boolean;
}

/** V3 status never derives state from legacy hooks or adapter copies. */
export interface V3StatusResult {
  schemaVersion: 1;
  authority: 'v3';
  version: string;
  project: string;
  activation: {
    state: string;
    epoch: string;
    activatedAt: string | null;
    managedAdapters: Record<PlatformName, string>;
  };
  compatibility: {
    readAllowed: boolean;
    writeAllowed: boolean;
    failures: string[];
  };
  runtime: {
    binding: 'ready' | 'registration_required';
    workspaceId: string | null;
    checkoutId: string | null;
    repositoryBindingId: string | null;
    gitCommonDir: string | null;
    error: string | null;
  };
  transport: {
    mode: 'local' | 'git-ref';
    remote: string | null;
  };
  capabilities: ReturnType<typeof capabilitiesFromProjectConfig>;
  remoteSnapshot: {
    revision: number;
    fetchedAt: string;
    receipt: string | null;
  } | null;
  policy: {
    revision: number;
    mode: string;
    defaultVisibility: string;
  };
  assessment: TeamAssessment;
  localIdentity: {
    actorId: string | null;
    displayName: string | null;
  };
  currentSession: {
    sessionId: string;
    client: string;
    activeTaskRef: { namespace: 'local' | 'shared'; taskId: string } | null;
  } | null;
  currentTask: {
    taskRef: { namespace: 'local' | 'shared'; taskId: string };
    workflowMode: 'man' | 'manba' | 'manteam';
    visibility: 'local' | 'shared';
    coordination: 'single' | 'team';
    status:
      | 'in_progress'
      | 'planned'
      | 'blocked'
      | 'completed'
      | 'abandoned'
      | 'superseded';
    revision: number;
  } | null;
  sessionEvidence: {
    ready: boolean;
    missingPlatforms: SessionSpikePlatform[];
    explicitRequiredPlatforms: SessionSpikePlatform[];
  };
  adapters: Record<PlatformName, V3PlatformAdapterStatus>;
  legacyAuthorityPresent: boolean;
}

interface DetectedTeamStatus {
  isTeam: boolean;
  contributors: number;
  recentActive: number;
  hasRemote: boolean;
}

interface StatusConfig {
  platforms?: string[];
  forceTeamMode?: boolean;
  teamMode?: 'auto' | 'on' | 'off';
}

/**
 * `mancode status` 命令。
 *
 * 职责（docs/08-cli-spec.md §4 + progress.md Step 3）：
 * 1. 读取 .mancode/state.json（未初始化则报错退出）
 * 2. 显示项目状态（mode/platform/techStack/uiLibrary）
 * 3. 显示初始化时间
 * 4. 显示 hooks 状态（文件存在 + settings.json 注册）
 * 5. 支持 --json 输出
 *
 * @param rootDir 目标项目根目录，默认 process.cwd()
 * @param options CLI 参数
 * @returns 退出码（0=成功，1=未初始化，2=state.json 损坏）
 */
export async function status(
  rootDir: string = process.cwd(),
  options: StatusOptions = {},
): Promise<number> {
  const stateFile = path.join(rootDir, '.mancode', 'state.json');
  const v3SchemaFile = path.join(rootDir, '.mancode', 'schema.json');

  if (await pathExists(v3SchemaFile)) {
    return statusV3(rootDir, options);
  }

  // 1. 检查是否已初始化
  if (!(await pathExists(stateFile))) {
    console.error('✗  mancode not initialized.');
    console.error('   Run `mancode init` to get started.');
    return EXIT_NOT_INITIALIZED;
  }

  // 2. 读取并解析 state.json（区分"不存在"和"损坏"）
  let state: StatusState;
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    state = JSON.parse(raw) as StatusState;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error('✗  .mancode/state.json is corrupt or unreadable.');
      console.error(`   ${err.message}`);
      console.error('   Run `mancode init --force` to repair.');
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗  Failed to read .mancode/state.json: ${msg}`);
    }
    return EXIT_CORRUPT_STATE;
  }

  // 3. 并行收集：项目名、hooks 状态、已安装平台、hook 注入预算、团队状态、当前 workflow
  const [
    project,
    hooksStatus,
    config,
    hookInjection,
    teamStatus,
    currentWorkflow,
    projectRefreshRecommended,
  ] = await Promise.all([
    getProjectName(rootDir),
    checkHooks(rootDir),
    readConfig(rootDir),
    estimateHookInjection(rootDir),
    detectTeamStatus(rootDir),
    getCurrentWorkflow(rootDir, state.currentTask ?? null),
    shouldRefreshProject(rootDir, state),
  ]);
  const effectiveTeam = getEffectiveTeamStatus(state, config, teamStatus);

  const result: StatusResult = {
    version: state.version || VERSION,
    project,
    techStack: state.techStack || 'Unknown',
    mode: state.currentMode || 'solo',
    platforms: getInstalledPlatforms(config, state.platform),
    uiLibrary: state.uiLibrary || 'None',
    initializedAt: state.initializedAt || 'unknown',
    hooks: hooksStatus,
    hookInjection,
    team: effectiveTeam,
    currentWorkflow,
    activeSoloPlan: state.activeSoloPlan ?? null,
    platformStatus: {},
    projectRefreshRecommended,
  };
  result.platformStatus = await checkPlatformStatus(rootDir, result.platforms);

  // 4. 输出
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }

  return EXIT_OK;
}

async function statusV3(
  rootDir: string,
  options: StatusOptions,
): Promise<number> {
  try {
    const store = new V3ContextStore(rootDir);
    const [
      snapshot,
      project,
      legacy,
      actor,
      adapterEntries,
      sessionSpikes,
      assessmentSignals,
      currentSession,
    ] = await Promise.all([
      store.readProjectSnapshot(),
      getProjectName(rootDir),
      scanLegacyAuthority(rootDir),
      readLocalActor(rootDir).catch(() => null),
      Promise.all(
        getPlatformInstallers().map(async (platform) =>
          Promise.all([
            platform.name,
            inspectV3Adapter(rootDir, platform.name),
          ]),
        ),
      ),
      listPlatformSessionSpikes(rootDir),
      detectTeamAssessmentSignals(rootDir),
      readV3StatusSession(rootDir),
    ]);
    const compatibility = evaluateCompatibilityGate({
      manifest: snapshot.manifest,
      expectedSchemaEpoch: snapshot.manifest.epoch,
      readerVersion: VERSION,
      writerVersion: VERSION,
      adapterVersions: snapshot.manifest.managedAdapters,
      currentLegacyBaseline: legacy.baseline,
      legacyAuthorityPresent: legacy.authorityPresent,
      operation: 'read',
    });
    const adapters = Object.fromEntries(adapterEntries) as Record<
      PlatformName,
      V3PlatformAdapterStatus
    >;
    const cache = await readGitRefTeamCache(rootDir, snapshot.config);
    const capabilities =
      snapshot.config.transport.mode === 'git-ref'
        ? capabilitiesFromGitRefCache(snapshot.config, cache)
        : capabilitiesFromProjectConfig(snapshot.config);
    const currentTask =
      currentSession === null || currentSession.activeTaskRef === null
        ? null
        : await store
            .readTaskSnapshot(currentSession.activeTaskRef)
            .then((task) => ({
              taskRef: task.metadata.taskRef,
              workflowMode: task.metadata.workflowMode,
              visibility: task.metadata.visibility,
              coordination: task.metadata.coordination,
              status: task.metadata.status,
              revision: task.metadata.revision,
            }))
            .catch(() => null);
    let runtime: V3StatusResult['runtime'];
    try {
      const context = await readProjectRuntimeContext(rootDir);
      runtime = {
        binding: 'ready',
        workspaceId: context.workspaceId,
        checkoutId: context.checkoutId,
        repositoryBindingId: context.repositoryBindingId,
        gitCommonDir: context.gitCommonDir,
        error: null,
      };
    } catch (error) {
      runtime = {
        binding: 'registration_required',
        workspaceId: snapshot.config.workspaceId,
        checkoutId: null,
        repositoryBindingId: null,
        gitCommonDir: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const result: V3StatusResult = {
      schemaVersion: 1,
      authority: 'v3',
      version: VERSION,
      project,
      activation: {
        state: snapshot.manifest.activationState,
        epoch: snapshot.manifest.epoch,
        activatedAt: snapshot.manifest.activatedAt,
        managedAdapters: snapshot.manifest.managedAdapters,
      },
      compatibility: {
        readAllowed: compatibility.readAllowed,
        writeAllowed: compatibility.writeAllowed,
        failures: compatibility.failures,
      },
      runtime,
      transport: snapshot.config.transport,
      capabilities,
      remoteSnapshot:
        cache === null
          ? null
          : {
              revision: cache.manifest?.revision ?? 0,
              fetchedAt: cache.fetchedAt,
              receipt: cache.receipt,
            },
      policy: {
        revision: snapshot.policy.revision,
        mode: snapshot.policy.policy,
        defaultVisibility: snapshot.policy.defaultVisibility,
      },
      assessment: assessTeam({
        policy: snapshot.policy.policy,
        signals: assessmentSignals,
        evaluatedAt: new Date().toISOString(),
      }),
      localIdentity: {
        actorId: actor?.actorId ?? null,
        displayName: actor?.displayName ?? null,
      },
      currentSession:
        currentSession === null
          ? null
          : {
              sessionId: currentSession.sessionId,
              client: currentSession.client,
              activeTaskRef: currentSession.activeTaskRef,
            },
      currentTask,
      sessionEvidence: platformSpikeFreezeStatus(sessionSpikes),
      adapters,
      legacyAuthorityPresent: legacy.authorityPresent,
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printV3Text(result);
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('✗  .mancode/schema.json is corrupt or incomplete.');
    console.error(`   ${message}`);
    return EXIT_CORRUPT_STATE;
  }
}

/** Status is read-only: an invalid ambient session is simply not current. */
async function readV3StatusSession(rootDir: string) {
  const sessionId = process.env.MANCODE_SESSION_ID;
  if (sessionId === undefined || !sessionId) return null;
  try {
    assertUlid(sessionId, 'status sessionId');
    return await readSession(rootDir, sessionId);
  } catch {
    return null;
  }
}

async function shouldRefreshProject(
  rootDir: string,
  state: StatusState,
): Promise<boolean> {
  if (state.projectMode !== 'generic') return false;
  const hasGit = await pathExists(path.join(rootDir, '.git'));
  if (hasGit) return true;
  for (const manifest of PROJECT_MANIFESTS) {
    if (await pathExists(path.join(rootDir, manifest))) return true;
  }
  return false;
}

async function checkPlatformStatus(
  rootDir: string,
  installedPlatforms: string[],
): Promise<Record<string, PlatformStatus>> {
  const installed = new Set(installedPlatforms);
  const entries = await Promise.all(
    getPlatformInstallers().map(async (platform) => {
      const status = await checkOnePlatformStatus(
        rootDir,
        platform.name,
        installed.has(platform.name),
      );
      return [platform.name, status] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function getCurrentWorkflow(
  rootDir: string,
  taskId: string | null,
): Promise<StatusResult['currentWorkflow']> {
  if (!taskId) return null;
  const meta = await readWorkflow(rootDir, taskId);
  if (!meta) return null;
  const activeChildren =
    meta.mode === 'man' || meta.mode === 'manteam'
      ? (await listWorkflows(rootDir))
          .filter(
            (candidate) =>
              candidate.mode === 'mamba' &&
              candidate.parentTaskId === meta.taskId &&
              (candidate.status === 'in_progress' ||
                candidate.status === 'blocked'),
          )
          .map((candidate) => ({
            taskId: candidate.taskId,
            currentStep: candidate.currentStep,
            status: candidate.status,
          }))
      : undefined;
  return {
    taskId: meta.taskId,
    task: meta.task,
    mode: meta.mode,
    currentStep: meta.currentStep,
    status: meta.status,
    ...(meta.blockingReason ? { blockingReason: meta.blockingReason } : {}),
    ...(meta.parentTaskId ? { parentTaskId: meta.parentTaskId } : {}),
    ...(meta.outcome ? { outcome: meta.outcome } : {}),
    ...(meta.planVersion ? { planVersion: meta.planVersion } : {}),
    ...(activeChildren ? { activeChildren } : {}),
  };
}

/**
 * 从 package.json 读取项目名称，fallback 到目录名。
 */
async function getProjectName(rootDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(rootDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg.name && typeof pkg.name === 'string') {
      return pkg.name;
    }
  } catch {
    // package.json 不存在或解析失败——fallback 到目录名
  }
  return path.basename(rootDir);
}

/**
 * 从 config.json 读取已安装平台列表，fallback 到 state.platform。
 */
async function readConfig(rootDir: string): Promise<StatusConfig> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, '.mancode', 'config.json'),
      'utf-8',
    );
    return JSON.parse(raw) as StatusConfig;
  } catch {
    // config.json 不存在或解析失败——调用方使用 fallback
    return {};
  }
}

function getInstalledPlatforms(
  config: StatusConfig,
  fallback: string,
): string[] {
  if (Array.isArray(config.platforms) && config.platforms.length > 0) {
    return config.platforms;
  }
  return fallback ? [fallback] : [];
}

function getEffectiveTeamStatus(
  state: StatusState,
  config: StatusConfig,
  detected: DetectedTeamStatus,
): StatusResult['team'] {
  const configuredTeam =
    config.forceTeamMode === true
      ? true
      : config.teamMode === 'on'
        ? true
        : config.teamMode === 'off'
          ? false
          : (state.teamModeAutoDetected ?? detected.isTeam);
  const forced = config.teamMode === 'on' || config.forceTeamMode === true;
  const autoDetected =
    config.forceTeamMode === true ||
    config.teamMode === 'on' ||
    config.teamMode === 'off'
      ? false
      : (state.teamModeAutoDetected ?? detected.isTeam);

  return {
    ...detected,
    isTeam: configuredTeam,
    contributors: Math.max(detected.contributors, state.contributors ?? 0, 1),
    autoDetected,
    forced,
  };
}

/**
 * 检查 hooks 状态：2 个脚本文件是否存在 + settings.json 是否注册。
 *
 * 3 项检查互相独立，并行执行。
 */
async function checkHooks(rootDir: string): Promise<{
  sessionStart: boolean;
  userPromptSubmit: boolean;
  registered: boolean;
}> {
  const [sessionStart, userPromptSubmit, registered] = await Promise.all([
    pathExists(path.join(rootDir, '.mancode', 'hooks', 'session-start.mjs')),
    pathExists(
      path.join(rootDir, '.mancode', 'hooks', 'user-prompt-submit.mjs'),
    ),
    isRegistered(rootDir),
  ]);
  return { sessionStart, userPromptSubmit, registered };
}

/**
 * 检查 .claude/settings.json 是否注册了 mancode 的两个 hooks。
 */
async function isRegistered(rootDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, '.claude', 'settings.json'),
      'utf-8',
    );
    const settings = JSON.parse(raw);
    return hooksRegistered(settings);
  } catch {
    // settings.json 不存在或解析失败——未注册
    return false;
  }
}

/**
 * 遍历 settings.json 的 hooks 结构，检查 mancode hooks 是否已注册。
 *
 * Claude Code 官方格式：
 * { hooks: { SessionStart: [{ hooks: [{ command: "..." }] }] } }
 *
 * 与 installers/claude-code.ts 的 isMancodeHook 逻辑一致：
 * 检查 command 字段是否包含 .mancode/hooks/ 路径。
 *
 * 注意：此函数只认官方 matcher group 数组格式。
 * 旧版/错误 schema（flat 数组、object map 等）会直接返回 false，
 * 即显示"未注册"。这是有意为之——status 是诊断工具，不是兼容层。
 * 旧 schema 的迁移由 installers/claude-code.ts 的 normalizeHookGroups 负责。
 */
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

/**
 * 在 matcher group 数组中查找包含指定路径的 command。
 */
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

/**
 * 估算 UserPromptSubmit hook 的注入大小。
 *
 * 用一个前端相关 fake prompt 触发审美 token 摘要，stdout bytes / 4 ≈ tokens。
 */
async function estimateHookInjection(
  rootDir: string,
): Promise<{ tokens: number; cap: number }> {
  const hookPath = path.join(
    rootDir,
    '.mancode',
    'hooks',
    'user-prompt-submit.mjs',
  );
  if (!(await pathExists(hookPath))) {
    return { tokens: 0, cap: 800 };
  }

  try {
    const output = await runHookEstimate(rootDir, hookPath);
    return {
      tokens: Math.ceil(Buffer.byteLength(output, 'utf-8') / 4),
      cap: 800,
    };
  } catch {
    return { tokens: 0, cap: 800 };
  }
}

function runHookEstimate(rootDir: string, hookPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('hook estimate timed out')));
    }, HOOK_ESTIMATE_TIMEOUT_MS);

    let stdout = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`hook exited with ${code}`));
      });
    });
    child.stdin.end(
      JSON.stringify({ prompt: 'design a button component with tailwind css' }),
    );
  });
}

/**
 * 文本格式输出（默认），字段命名对齐 docs/08-cli-spec.md §4.3。
 */
function printText(r: StatusResult): void {
  const publicMode = r.mode === 'mamba' ? 'manba' : r.mode;
  const modeLabel =
    publicMode === 'solo' ? `${publicMode} (default)` : publicMode;

  console.log('');
  console.log(`mancode v${r.version}`);
  console.log('');
  console.log(`Project:     ${r.project} (${r.techStack})`);
  console.log(`Mode:        ${modeLabel}`);
  console.log(`Style:       ${r.uiLibrary}`);
  console.log(`Initialized: ${r.initializedAt}`);
  console.log(`Team:        ${formatTeamStatus(r.team)}`);
  if (r.projectRefreshRecommended) {
    console.log(
      'Project:     new Git or project files detected; run `mancode refresh-project`.',
    );
  }
  if (r.currentWorkflow) {
    const stepMax = workflowStepMax(r.currentWorkflow.mode);
    console.log(
      `Workflow:    ${r.currentWorkflow.taskId} (Step ${r.currentWorkflow.currentStep}/${stepMax}, ${r.currentWorkflow.status})`,
    );
    if (r.currentWorkflow.parentTaskId) {
      console.log(`Parent:      ${r.currentWorkflow.parentTaskId}`);
    }
    if (r.currentWorkflow.planVersion !== undefined) {
      console.log(`Plan version: ${r.currentWorkflow.planVersion}`);
    }
    if (r.currentWorkflow.outcome) {
      console.log(`Outcome:     ${r.currentWorkflow.outcome}`);
    }
    if (r.currentWorkflow.blockingReason) {
      console.log(`Blocked:     ${r.currentWorkflow.blockingReason}`);
    }
    if (r.currentWorkflow.activeChildren?.length) {
      console.log(
        `Children:    ${r.currentWorkflow.activeChildren.map((child) => `${child.taskId} (${child.status})`).join(', ')}`,
      );
    }
  }
  if (r.activeSoloPlan) {
    console.log(
      `Solo plan:   ${r.activeSoloPlan.taskId} (plan v${r.activeSoloPlan.planVersion})`,
    );
  }
  console.log('');
  console.log('Installed platforms:');
  for (const p of r.platforms) {
    console.log(`  ✓ ${formatPlatformName(p)}`);
  }
  console.log('');
  console.log('Platform status:');
  for (const platform of getPlatformInstallers()) {
    const status = r.platformStatus[platform.name];
    if (!status) continue;
    const installedMarker = status.installed ? '✓' : '○';
    const readyMarker = status.ready ? 'ready' : 'not ready';
    console.log(
      `  ${installedMarker} ${platform.displayName}: ${readyMarker} (${status.target})`,
    );
  }
  console.log('');
  if (r.platforms.includes('claude-code')) {
    console.log('Hooks:');
    console.log(`  ${r.hooks.sessionStart ? '✓' : '✗'} session-start.mjs`);
    console.log(
      `  ${r.hooks.userPromptSubmit ? '✓' : '✗'} user-prompt-submit.mjs`,
    );
    console.log(
      `  ${r.hooks.registered ? '✓' : '✗'} registered in .claude/settings.json`,
    );
    console.log(
      `  Hook injection: ~${r.hookInjection.tokens} tokens (cap ${r.hookInjection.cap})`,
    );
    console.log('');
  }
}

function printV3Text(result: V3StatusResult): void {
  console.log('');
  console.log(`mancode v${result.version}`);
  console.log('');
  console.log(`Project:     ${result.project}`);
  console.log(
    `Activation:  ${formatActivationState(result.activation.state)} (epoch ${result.activation.epoch})`,
  );
  console.log(
    `Runtime:     ${result.runtime.binding}${result.runtime.error ? ` (${result.runtime.error})` : ''}`,
  );
  console.log(
    `Transport:   ${result.transport.mode}${result.transport.remote ? ` (${result.transport.remote})` : ''}`,
  );
  console.log(
    `Team:        ${result.assessment.recommendation} (${result.assessment.confidence}; ${result.assessment.reasons.join('; ')})`,
  );
  console.log(
    `Claim/write: ${result.capabilities.claimAcquisition}/${result.capabilities.writeGuard} (${result.capabilities.transportFreshness})`,
  );
  if (result.currentTask !== null) {
    console.log(
      `Current task:${result.currentTask.taskRef.namespace}:${result.currentTask.taskRef.taskId} / ${result.currentTask.workflowMode} / ${result.currentTask.status} r${result.currentTask.revision}`,
    );
  }
  console.log(
    `Identity:    ${result.localIdentity.displayName ?? 'not configured'}`,
  );
  const sessionEvidenceDetail = result.sessionEvidence.ready
    ? 'ready'
    : [
        ...result.sessionEvidence.explicitRequiredPlatforms,
        ...result.sessionEvidence.missingPlatforms.filter(
          (platform) =>
            !result.sessionEvidence.explicitRequiredPlatforms.includes(
              platform,
            ),
        ),
      ].join(', ') || 'none recorded';
  console.log(
    `Session evidence: ${result.sessionEvidence.ready ? 'ready' : `explicit required (${sessionEvidenceDetail})`}`,
  );
  if (result.compatibility.failures.length > 0) {
    console.log(`Compatibility: ${result.compatibility.failures.join(', ')}`);
  }
  if (result.legacyAuthorityPresent) {
    console.log(
      'Legacy:      legacy authority detected; mancode writes may be blocked.',
    );
  }
  console.log('');
  console.log('mancode adapter status:');
  for (const platform of getPlatformInstallers()) {
    const adapter = result.adapters[platform.name];
    const marker = adapter.installed ? '✓' : '○';
    const readiness = adapter.ready ? 'ready' : 'not installed';
    console.log(
      `  ${marker} ${platform.displayName}: ${readiness} (${adapter.target}; session=${adapter.capabilities.sessionIdentity})`,
    );
  }
  if (result.runtime.binding !== 'ready') {
    console.log('');
    console.log(
      'Run `mancode context worktree register` in this checkout before mancode mutations.',
    );
  }
  console.log('');
}

function formatActivationState(state: string): string {
  return state.replace(/^v3_/, '').replaceAll('_', ' ');
}

function formatTeamStatus(team: StatusResult['team']): string {
  if (team.forced) return `forced (${team.contributors} contributors)`;
  if (team.isTeam) return `detected (${team.contributors} contributors)`;
  return 'solo';
}

function workflowStepMax(mode: WorkflowMode): number {
  return maxWorkflowStep(mode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

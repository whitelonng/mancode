import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { validateClaudeCodeSettings } from '../installers/claude-code.js';
import { installMancodeCore } from '../installers/common.js';
import { MANCODE_CURSOR_RULE_FILES } from '../installers/cursor.js';
import { MODE_NAMES } from '../installers/mode-skills.js';
import { isPlatformPresent } from '../installers/platform-status.js';
import {
  type PlatformName,
  getPlatformInstaller,
  getPlatformInstallers,
} from '../installers/registry.js';
import { detectTeamStatus } from '../system/detect-team.js';
import { detectSystemDeps } from '../system/detect.js';
import {
  type InitLocale,
  type InitPrompter,
  createTerminalPrompter,
  detectInitLocale,
  detectPlatformHints,
  parsePlatformSelection,
} from '../system/init-onboarding.js';
import {
  PROJECT_MANIFESTS,
  detectProjectProfile,
  primaryUiLibrary,
} from '../system/project-profile.js';
import { scanAesthetics } from '../system/scan-aesthetics.js';
import { ALL_AGENTS } from '../templates/agents/index.js';
import { VERSION } from '../version.js';

/**
 * 退出码契约 — 见 docs/08-cli-spec.md §2.5
 */
export const EXIT_OK = 0;
export const EXIT_ALREADY_INITIALIZED = 1;
export const EXIT_NOT_A_PROJECT_DIR = 2;
export const EXIT_USER_CANCEL = 3;
export const EXIT_NETWORK_ERROR = 4;
export const EXIT_INIT_FAILED = 5;

const DEFAULT_INIT_PLATFORM: PlatformName = 'claude-code';

/**
 * mancode state 文件的内容。
 *
 * 字段命名采用 camelCase（JSON 输出），与 docs/12-lifecycle.md
 * 的 SessionStart hook 读取逻辑（json_get "currentMode"）保持一致。
 *
 * MVP-2 新增字段（currentTask / currentWorkflowMode / skippedSteps /
 * teamModeAutoDetected / contributors）支持 /man /manba 流程和团队检测。
 */
export interface MancodeState {
  version: string;
  currentMode: 'solo' | 'man' | 'mamba' | 'manteam' | 'manps';
  lastMode: 'solo' | 'man' | 'mamba' | 'manteam' | 'manps';
  /** Initial/default adapter platform. Installed platforms live in config.json. */
  platform: PlatformName;
  initializedAt: string;
  techStack: string;
  uiLibrary: string;
  // MVP-2: workflow 状态
  currentTask: string | null;
  currentWorkflowMode: 'man' | 'mamba' | 'manteam' | null;
  skippedSteps: string[];
  /** Confirmed /man plan currently being implemented in lightweight solo mode. */
  activeSoloPlan: { taskId: string; planVersion: number } | null;
  // MVP-2: 团队检测
  teamModeAutoDetected: boolean;
  contributors: number;
  /** Whether init started from an empty directory rather than detected project files. */
  projectMode?: 'generic' | 'detected';
}

export interface InitOptions {
  /** --force: 覆盖已有配置 */
  force?: boolean;
  /** --yes: 跳过通用项目确认；CI 仍需显式指定平台 */
  yes?: boolean;
  /** --team / --no-team: 强制启用/禁用团队模式（MVP-2）*/
  team?: boolean;
  /** --style <name>: 指定审美风格（MVP-2）*/
  style?: string;
  /** --platform <platform>: initial adapter platform (MVP-3) */
  platform?: string;
  /** --empty: allow a safe, empty directory to become a generic project. */
  empty?: boolean;
  /** --lang <locale>: onboarding language (zh-CN or en). */
  lang?: string;
  /** Internal CLI flag. Undefined preserves the programmatic API's legacy default. */
  interactive?: boolean;
  /** Injectable prompt adapter for terminal and tests. */
  prompter?: InitPrompter;
}

/**
 * `mancode init` 命令（完整版）。
 *
 * 职责（docs/08-cli-spec.md §2.1-2.4）：
 * 1. 检测可选系统依赖（git）
 * 2. 检测中立 project profile（类型、语言、框架与验证能力）
 * 3. 创建 8 个文件/目录（.mancode/ + .claude/）
 * 4. 支持 --force / --yes / --team / --style 参数
 *
 * MVP-1 实现范围：
 * - ✅ 跨平台可选依赖检测 + 安全降级
 * - ✅ 跨常见生态的保守 project profile 检测
 * - ✅ 创建 8 个文件
 * - ✅ --force / --yes 参数
 * - ✅ --team / --no-team / --style 参数（MVP-2）
 * - ✅ 空目录确认与多平台交互选择
 *
 * @param rootDir 目标项目根目录，默认 process.cwd()
 * @param options CLI 参数
 * @returns 退出码（见上方常量）
 */
export async function init(
  rootDir: string = process.cwd(),
  options: InitOptions = {},
): Promise<number> {
  const mancodeDir = path.join(rootDir, '.mancode');
  const stateFile = path.join(mancodeDir, 'state.json');
  const wasInitialized = await pathExists(stateFile);
  let mutationSnapshots: FileSnapshot[] = [];
  let directorySnapshots: DirectorySnapshot[] = [];
  const locale = detectInitLocale(options.lang);
  if (!locale) {
    console.error(`✗  Unsupported init language: ${options.lang}`);
    console.error('   Supported values: zh-CN, en');
    return EXIT_INIT_FAILED;
  }

  // 1. 幂等检查
  if (wasInitialized) {
    if (!options.force) {
      console.log(
        localize(
          locale,
          'ℹ️  mancode 已经初始化。',
          'ℹ️  mancode already initialized.',
        ),
      );
      console.log(`   ${stateFile}`);
      console.log(
        localize(
          locale,
          '   运行 `mancode init --force` 重新安装。',
          '   Run `mancode init --force` to reinstall.',
        ),
      );
      return EXIT_ALREADY_INITIALIZED;
    }
    // --force: 继续，覆盖已有配置
    console.log(
      localize(
        locale,
        '⚠️  正在使用 --force 重新安装...',
        '⚠️  Reinstalling with --force...',
      ),
    );
  }

  // 2. 校验目标目录存在
  if (!(await pathExists(rootDir))) {
    console.error(
      localize(
        locale,
        `✗  目标目录不存在：${rootDir}`,
        `✗  Target directory does not exist: ${rootDir}`,
      ),
    );
    return EXIT_NOT_A_PROJECT_DIR;
  }

  // 2.1 校验是项目目录（git 或任一常见项目 manifest）。空目录可明确作为通用项目初始化。
  const isGitRepo = await pathExists(path.join(rootDir, '.git'));
  const hasManifest = await hasProjectManifest(rootDir);
  let isGenericProject = false;

  if (!isGitRepo && !hasManifest) {
    const genericSafety = await canInitializeGenericProject(rootDir);
    if (
      !genericSafety.ok &&
      !(wasInitialized && genericSafety.reason === 'nonempty')
    ) {
      printNotProjectDirectory(rootDir, locale, genericSafety.reason);
      return EXIT_NOT_A_PROJECT_DIR;
    }
    if (!wasInitialized) {
      const prompter =
        options.prompter ??
        (options.interactive ? createTerminalPrompter() : null);
      const confirmed =
        options.empty || options.yes
          ? true
          : prompter
            ? await prompter.confirmGenericProject({ rootDir, locale })
            : false;
      if (!confirmed) {
        if (options.interactive) {
          console.log(
            locale === 'zh-CN' ? '已取消初始化。' : 'Initialization cancelled.',
          );
          return EXIT_USER_CANCEL;
        }
        printNotProjectDirectory(rootDir, locale, 'empty');
        return EXIT_NOT_A_PROJECT_DIR;
      }
    }
    isGenericProject = true;
  }

  try {
    // 3. 检测系统依赖
    console.log(
      localize(
        locale,
        '✓  检测系统依赖...',
        '✓  Checking system dependencies...',
      ),
    );
    const deps = await detectSystemDeps();

    if (!deps.git) {
      console.log(
        localize(
          locale,
          '⚠️  未找到 Git（可选）。团队自动检测将使用 solo 默认值。',
          '⚠️  Git not found (optional). Team auto-detection will use solo defaults.',
        ),
      );
    } else {
      console.log('   git ✓');
    }

    // 4. 检测项目类型
    console.log(
      localize(locale, '✓  检测项目类型...', '✓  Detecting project type...'),
    );
    const profile = await detectProjectProfile(rootDir);
    const profileStack = [...profile.languages, ...profile.frameworks];
    const techStackStr = profileStack.join(' + ') || 'Unknown';
    const uiLibrary = primaryUiLibrary(profile);
    const uiLibraryStr = uiLibrary || 'None';

    if (profileStack.length > 0) {
      console.log(`   ${techStackStr}`);
      if (uiLibrary) {
        console.log(`   UI: ${uiLibraryStr}`);
      }
    } else if (hasManifest) {
      console.log(
        localize(
          locale,
          '   已发现项目 manifest，未识别到框架依赖',
          '   Project manifest found; no known framework dependencies',
        ),
      );
    } else {
      console.log(
        localize(
          locale,
          '   （未发现已识别的 manifest，项目画像置信度较低）',
          '   (No recognized manifest found; profile confidence is low)',
        ),
      );
    }

    const existingPlatform = wasInitialized
      ? await readExistingInitPlatform(stateFile)
      : null;
    const existingConfig = wasInitialized
      ? await readExistingInitPreferences(mancodeDir)
      : { platforms: [], minimalByPlatform: {} };
    const recoverablePlatforms =
      wasInitialized && existingConfig.platforms.length === 0
        ? await detectManagedInitPlatforms(rootDir)
        : [];
    const forceReinstallPlatforms =
      options.force && options.platform === undefined
        ? existingConfig.platforms.length > 0
          ? existingConfig.platforms
          : recoverablePlatforms
        : [];
    const platformHints = await detectPlatformHints(rootDir);
    const selectedPlatforms = await selectInitPlatforms({
      option:
        options.platform ??
        (forceReinstallPlatforms.length > 0
          ? forceReinstallPlatforms.join(',')
          : undefined),
      existingPlatform,
      hints: platformHints,
      interactive: options.interactive,
      prompter: options.prompter,
      locale,
      yes: options.yes,
    });
    if (!selectedPlatforms) {
      console.error(
        locale === 'zh-CN'
          ? '✗  未选择平台。请重新运行并选择平台，或使用 --platform codex,cursor / --platform all。'
          : '✗  No platform selected. Choose one interactively or pass --platform codex,cursor / --platform all.',
      );
      return EXIT_INIT_FAILED;
    }
    if (selectedPlatforms.length === 0) {
      console.error('✗  No platform selected.');
      return EXIT_INIT_FAILED;
    }
    const firstPlatform = selectedPlatforms[0];
    if (!firstPlatform) {
      console.error('✗  No platform selected.');
      return EXIT_INIT_FAILED;
    }
    const installers = selectedPlatforms.map(getPlatformInstaller);
    if (installers.some((installer) => !installer)) {
      console.error(`✗  Unsupported platform: ${options.platform}`);
      return EXIT_INIT_FAILED;
    }
    const typedInstallers = installers.filter(
      (installer): installer is NonNullable<typeof installer> =>
        installer !== null,
    );
    const onlyPlatformHint =
      platformHints.length === 1 ? platformHints[0] : null;
    const detectedPrimary =
      onlyPlatformHint && selectedPlatforms.includes(onlyPlatformHint)
        ? onlyPlatformHint
        : null;
    const primaryPlatform =
      existingPlatform && selectedPlatforms.includes(existingPlatform)
        ? existingPlatform
        : (detectedPrimary ?? firstPlatform);

    const managedFiles = getInitManagedFilePaths(rootDir, selectedPlatforms);
    mutationSnapshots = await snapshotFiles(managedFiles);
    directorySnapshots = await snapshotDirectories(managedFiles, [
      path.join(mancodeDir, 'workflows'),
      path.join(mancodeDir, 'preseason-reports'),
    ]);

    // 4.1 检测多人协作（MVP-2）
    const team = await detectTeamStatus(rootDir);
    const platformMinimal = Object.fromEntries(
      selectedPlatforms.map((platform) => [
        platform,
        existingConfig.minimalByPlatform[platform] ?? false,
      ]),
    ) as Partial<Record<PlatformName, boolean>>;
    const existingTeamMode =
      existingConfig.forceTeamMode === true
        ? 'on'
        : (existingConfig.teamMode ?? 'auto');
    const teamModeEnabled =
      options.team ??
      (existingTeamMode === 'on'
        ? true
        : existingTeamMode === 'off'
          ? false
          : team.isTeam);
    if (options.team === true) {
      console.log(
        localize(
          locale,
          '   团队模式：强制开启（--team）',
          '   team: forced on (--team)',
        ),
      );
    } else if (options.team === false) {
      console.log(
        localize(
          locale,
          '   团队模式：强制关闭（--no-team）',
          '   team: forced off (--no-team)',
        ),
      );
    } else if (team.isTeam) {
      console.log(
        localize(
          locale,
          `   团队模式：${team.contributors} 位贡献者（可使用 /manteam）`,
          `   team: ${team.contributors} contributors (/manteam available)`,
        ),
      );
    }

    const state: MancodeState = {
      version: VERSION,
      currentMode: 'solo',
      lastMode: 'solo',
      platform: primaryPlatform,
      initializedAt: new Date().toISOString(),
      techStack: techStackStr,
      uiLibrary: uiLibraryStr,
      currentTask: null,
      currentWorkflowMode: null,
      skippedSteps: [],
      activeSoloPlan: null,
      teamModeAutoDetected: teamModeEnabled,
      contributors: team.contributors,
      projectMode: isGenericProject ? 'generic' : 'detected',
    };

    // 5. 预检用户 Claude Code settings，避免坏 JSON 导致半初始化。
    if (selectedPlatforms.includes('claude-code')) {
      await validateClaudeCodeSettings(rootDir);
    }

    // 6. 创建平台无关的 .mancode/ 基础文件。
    await installMancodeCore(rootDir);

    // 7. 创建 .mancode/state.json。静态平台 adapter 会读取它生成规则。
    await fs.mkdir(mancodeDir, { recursive: true });
    const stateContent = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(stateFile, stateContent, 'utf-8');
    await fs.writeFile(
      path.join(mancodeDir, 'project-profile.json'),
      `${JSON.stringify(profile, null, 2)}\n`,
      'utf-8',
    );

    await updateConfigOptions(
      mancodeDir,
      {
        forceTeamMode:
          options.team === undefined && wasInitialized
            ? undefined
            : options.team === true,
        teamMode:
          options.team === undefined && wasInitialized
            ? undefined
            : options.team === true
              ? 'on'
              : options.team === false
                ? 'off'
                : 'auto',
        defaultStyle:
          options.style === undefined && wasInitialized
            ? undefined
            : (options.style ?? null),
        platforms: selectedPlatforms,
        platformOptions: {
          ...Object.fromEntries(
            selectedPlatforms.map((platform) => [
              platform,
              { minimal: platformMinimal[platform] ?? false },
            ]),
          ),
        },
      },
      wasInitialized,
    );

    // 8. 审美扫描（profile 确认 UI 资产时才扫）。必须早于静态平台规则生成。
    let styleLine = localize(
      locale,
      '  .mancode/aesthetics/        # style-tokens.json（空）',
      '  .mancode/aesthetics/        # style-tokens.json (empty)',
    );
    if (profile.uiAssets === 'detected') {
      console.log(
        localize(
          locale,
          '✓  扫描审美 token...',
          '✓  Scanning design tokens...',
        ),
      );
      const tokens = await scanAesthetics(rootDir, uiLibrary);
      const tokensPath = path.join(
        mancodeDir,
        'aesthetics',
        'style-tokens.json',
      );
      await fs.writeFile(
        tokensPath,
        `${JSON.stringify(tokens, null, 2)}\n`,
        'utf-8',
      );

      if (tokens.matchLevel === 'high') {
        const colorCount = Object.keys(tokens.colors).length;
        const fontCount = Object.keys(tokens.fonts).length;
        console.log(
          localize(
            locale,
            `   ${colorCount} 个颜色，${fontCount} 个字体（匹配度：高）`,
            `   ${colorCount} colors, ${fontCount} fonts (match: high)`,
          ),
        );
        styleLine = localize(
          locale,
          `  .mancode/aesthetics/        # style-tokens.json（${colorCount} 个颜色）`,
          `  .mancode/aesthetics/        # style-tokens.json (${colorCount} colors)`,
        );
      } else if (tokens.matchLevel === 'low') {
        console.log(
          localize(
            locale,
            '   已检测到 UI 资源，未找到可复用 token（匹配度：低）',
            '   UI assets detected; no reusable tokens found (match: low)',
          ),
        );
        styleLine = localize(
          locale,
          '  .mancode/aesthetics/        # style-tokens.json（低匹配）',
          '  .mancode/aesthetics/        # style-tokens.json (low match)',
        );
      } else {
        console.log(
          localize(
            locale,
            '   未找到设计 token（无匹配）',
            '   No design tokens found (match: none)',
          ),
        );
        styleLine = localize(
          locale,
          '  .mancode/aesthetics/        # style-tokens.json（无 token）',
          '  .mancode/aesthetics/        # style-tokens.json (no tokens)',
        );
      }
    }

    // 9. 安装平台适配。
    for (const installer of typedInstallers) {
      console.log(
        localize(
          locale,
          `✓  安装 ${installer.displayName} 适配器...`,
          `✓  Installing ${installer.displayName} adapter...`,
        ),
      );
      await installer.install(rootDir, {
        techStack: profileStack,
        uiLibrary,
        projectProfile: profile,
        minimal: platformMinimal[installer.name] ?? false,
        force: options.force,
      });
    }

    // 10. 完成
    console.log('');
    console.log(
      localize(locale, '✓  mancode 初始化完成。', '✓  mancode initialized.'),
    );
    console.log('');
    console.log(localize(locale, '已创建：', 'Created:'));
    console.log(
      localize(
        locale,
        '  .mancode/state.json         # 项目状态',
        '  .mancode/state.json         # project state',
      ),
    );
    console.log(
      localize(
        locale,
        '  .mancode/project-profile.json # 检测到的项目事实',
        '  .mancode/project-profile.json # detected project facts',
      ),
    );
    console.log(
      localize(
        locale,
        '  .mancode/config.json        # 配置',
        '  .mancode/config.json        # configuration',
      ),
    );
    console.log(
      localize(
        locale,
        '  .mancode/hooks/             # SessionStart + UserPromptSubmit',
        '  .mancode/hooks/             # SessionStart + UserPromptSubmit',
      ),
    );
    console.log(styleLine);
    console.log('  .mancode/logs/              # hooks.log');
    for (const platform of selectedPlatforms)
      printPlatformCreatedFiles(platform, locale);
    console.log('');
    console.log(localize(locale, '下一步：', 'Next:'));
    console.log(
      localize(
        locale,
        '  mancode status              # 显示项目状态',
        '  mancode status              # Show project state',
      ),
    );
    if (selectedPlatforms.includes('claude-code')) {
      console.log(
        localize(
          locale,
          '  （重启 Claude Code 以加载 hooks）',
          '  (Restart Claude Code to load hooks)',
        ),
      );
    }
    if (selectedPlatforms.includes('codex')) {
      console.log(
        localize(
          locale,
          '  （如果 skills 未出现，请重启 ChatGPT 桌面应用或 Codex 会话）',
          '  (If skills do not appear, restart the ChatGPT desktop app or Codex session)',
        ),
      );
    }

    return EXIT_OK;
  } catch (err) {
    await restoreFiles(mutationSnapshots);
    await removeNewEmptyDirectories(directorySnapshots);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      localize(
        locale,
        `✗  mancode 初始化失败：${msg}`,
        `✗  mancode init failed: ${msg}`,
      ),
    );
    return EXIT_INIT_FAILED;
  }
}

async function updateConfigOptions(
  mancodeDir: string,
  patch: {
    forceTeamMode?: boolean;
    teamMode?: 'auto' | 'on' | 'off';
    defaultStyle?: string | null;
    platforms: PlatformName[];
    platformOptions: Partial<Record<PlatformName, { minimal: boolean }>>;
  },
  preserveInstalledPlatforms: boolean,
): Promise<void> {
  const configPath = path.join(mancodeDir, 'config.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    // installClaudeCode normally writes config.json; keep init robust if it did not.
  }
  const existingPlatforms = Array.isArray(config.platforms)
    ? config.platforms.filter(
        (platform): platform is string => typeof platform === 'string',
      )
    : [];
  const existingPlatformOptions = isRecord(config.platformOptions)
    ? config.platformOptions
    : {};
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const mergedPatch = preserveInstalledPlatforms
    ? {
        ...definedPatch,
        platforms: Array.from(
          new Set([...existingPlatforms, ...patch.platforms]),
        ),
        platformOptions: {
          ...existingPlatformOptions,
          ...patch.platformOptions,
        },
      }
    : definedPatch;
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, ...mergedPatch }, null, 2)}\n`,
    'utf-8',
  );
}

async function readExistingInitPreferences(mancodeDir: string): Promise<{
  platforms: PlatformName[];
  forceTeamMode?: boolean;
  teamMode?: 'auto' | 'on' | 'off';
  minimalByPlatform: Partial<Record<PlatformName, boolean>>;
}> {
  try {
    const config = JSON.parse(
      await fs.readFile(path.join(mancodeDir, 'config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const preferences: {
      platforms: PlatformName[];
      forceTeamMode?: boolean;
      teamMode?: 'auto' | 'on' | 'off';
      minimalByPlatform: Partial<Record<PlatformName, boolean>>;
    } = {
      platforms: Array.isArray(config.platforms)
        ? config.platforms.filter(
            (platform): platform is PlatformName =>
              typeof platform === 'string' &&
              getPlatformInstaller(platform) !== null,
          )
        : [],
      minimalByPlatform: {},
    };
    if (typeof config.forceTeamMode === 'boolean') {
      preferences.forceTeamMode = config.forceTeamMode;
    }
    if (
      config.teamMode === 'auto' ||
      config.teamMode === 'on' ||
      config.teamMode === 'off'
    ) {
      preferences.teamMode = config.teamMode;
    }
    if (isRecord(config.platformOptions)) {
      for (const platform of preferences.platforms) {
        const platformOptions = config.platformOptions[platform];
        if (isRecord(platformOptions) && platformOptions.minimal === true) {
          preferences.minimalByPlatform[platform] = true;
        }
      }
    }
    return preferences;
  } catch {
    return { platforms: [], minimalByPlatform: {} };
  }
}

async function readExistingInitPlatform(
  stateFile: string,
): Promise<PlatformName | null> {
  try {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as {
      platform?: unknown;
    };
    return typeof state.platform === 'string' &&
      getPlatformInstaller(state.platform)
      ? (state.platform as PlatformName)
      : null;
  } catch {
    return null;
  }
}

async function detectManagedInitPlatforms(
  rootDir: string,
): Promise<PlatformName[]> {
  const detected = await Promise.all(
    getPlatformInstallers().map(async (platform) => ({
      name: platform.name,
      present: await isPlatformPresent(rootDir, platform.name),
    })),
  );
  return detected
    .filter((platform) => platform.present)
    .map(({ name }) => name);
}

async function selectInitPlatforms(input: {
  option?: string;
  existingPlatform: PlatformName | null;
  hints: PlatformName[];
  interactive?: boolean;
  prompter?: InitPrompter;
  locale: InitLocale;
  yes?: boolean;
}): Promise<PlatformName[] | null> {
  if (input.option !== undefined) {
    return parsePlatformSelection(input.option);
  }
  // Preserve the historical direct-function API and force reinstall behavior.
  if (input.existingPlatform) return [input.existingPlatform];
  if (input.yes && input.interactive !== undefined) {
    return input.hints.length === 1 ? input.hints : null;
  }
  if (input.interactive) {
    const prompter = input.prompter ?? createTerminalPrompter();
    return prompter.selectPlatforms({
      locale: input.locale,
      detected: input.hints,
    });
  }
  if (input.interactive === false) {
    // A non-interactive CLI must be deterministic. A single runtime hint is safe;
    // otherwise require --platform rather than silently installing Claude Code.
    return input.hints.length === 1 ? input.hints : null;
  }
  return [DEFAULT_INIT_PLATFORM];
}

async function hasProjectManifest(rootDir: string): Promise<boolean> {
  for (const name of PROJECT_MANIFESTS) {
    if (await pathExists(path.join(rootDir, name))) return true;
  }
  return false;
}

async function canInitializeGenericProject(
  rootDir: string,
): Promise<{ ok: true } | { ok: false; reason: 'unsafe' | 'nonempty' }> {
  const resolved = path.resolve(rootDir);
  if (
    resolved === path.parse(resolved).root ||
    resolved === path.resolve(os.homedir())
  ) {
    return { ok: false, reason: 'unsafe' };
  }
  try {
    const entries = await fs.readdir(resolved);
    const meaningfulEntries = entries.filter(
      (entry) => !['.DS_Store', 'Thumbs.db', '.gitkeep'].includes(entry),
    );
    return meaningfulEntries.length === 0
      ? { ok: true }
      : { ok: false, reason: 'nonempty' };
  } catch {
    return { ok: false, reason: 'unsafe' };
  }
}

function printNotProjectDirectory(
  rootDir: string,
  locale: InitLocale,
  reason: 'unsafe' | 'nonempty' | 'empty',
): void {
  if (locale === 'zh-CN') {
    console.error(`✗  当前目录不是可初始化的项目目录：${rootDir}`);
    if (reason === 'unsafe') {
      console.error('   为避免误写，不能在 Home 目录或磁盘根目录初始化。');
    } else if (reason === 'nonempty') {
      console.error(
        '   未识别到项目文件，且目录中已有文件。请先进入项目目录。',
      );
    } else {
      console.error(
        '   未发现 .git 或项目文件。交互终端中可确认通用项目，或使用 --empty。',
      );
    }
    return;
  }
  console.error(`✗  Not a project directory: ${rootDir}`);
  if (reason === 'unsafe') {
    console.error(
      '   Refusing to initialize a home directory or filesystem root.',
    );
  } else if (reason === 'nonempty') {
    console.error(
      '   No project files were detected and the directory is not empty.',
    );
  } else {
    console.error(
      '   No .git or recognized project manifest found. Use an interactive terminal or --empty for a new project.',
    );
  }
}

interface FileSnapshot {
  filePath: string;
  content: string | null;
}

interface DirectorySnapshot {
  dirPath: string;
  existed: boolean;
}

function getInitManagedFilePaths(
  rootDir: string,
  platforms: PlatformName[],
): string[] {
  const files = [
    '.mancode/state.json',
    '.mancode/config.json',
    '.mancode/project-profile.json',
    '.mancode/aesthetics/style-tokens.json',
    '.mancode/hooks/session-start.mjs',
    '.mancode/hooks/user-prompt-submit.mjs',
    '.mancode/logs/hooks.log',
    '.mancode/memory/prd.md',
    '.mancode/memory/spec.md',
    '.mancode/memory/decisions.md',
  ];
  if (platforms.includes('claude-code')) {
    files.push(
      '.mancode/hooks/session-start.sh',
      '.mancode/hooks/user-prompt-submit.sh',
      '.claude/settings.json',
      '.claude/skills/man8/SKILL.md',
      '.claude/skills/mamba/SKILL.md',
      '.claude/skills/solo/SKILL.md',
      '.claude/skills/mancode-mamba.md',
      '.claude/skills/mancode-solo.md',
      '.claude/skills/mancode-man8.md',
    );
    for (const mode of MODE_NAMES) {
      files.push(
        `.claude/skills/${mode}/SKILL.md`,
        `.claude/skills/mancode-${mode}.md`,
      );
    }
    for (const agent of ALL_AGENTS) {
      files.push(`.claude/agents/${agent.name}.md`);
    }
  }
  if (platforms.includes('cursor')) {
    files.push(
      '.cursor/rules/mancode-mamba.mdc',
      '.cursor/rules/mancode-man8.mdc',
      '.cursor/commands/mamba.md',
      '.cursor/commands/man8.md',
    );
    for (const fileName of MANCODE_CURSOR_RULE_FILES) {
      files.push(`.cursor/rules/${fileName}`);
    }
    for (const mode of MODE_NAMES) {
      files.push(`.cursor/commands/${mode}.md`);
    }
  }
  if (platforms.includes('codex') || platforms.includes('zcode')) {
    files.push(
      'AGENTS.md',
      '.agents/skills/mamba/SKILL.md',
      '.agents/skills/man8/SKILL.md',
    );
    for (const mode of MODE_NAMES) {
      files.push(`.agents/skills/${mode}/SKILL.md`);
    }
  }
  if (platforms.includes('codex')) {
    files.push('.codex/skills/mamba/SKILL.md', '.codex/skills/man8/SKILL.md');
    for (const mode of MODE_NAMES) {
      files.push(`.codex/skills/${mode}/SKILL.md`);
    }
  }
  if (platforms.includes('zcode')) {
    files.push('.zcode/skills/mamba/SKILL.md', '.zcode/skills/man8/SKILL.md');
    for (const mode of MODE_NAMES) {
      files.push(`.zcode/skills/${mode}/SKILL.md`);
    }
  }
  if (platforms.includes('copilot')) {
    files.push(
      '.github/copilot-instructions.md',
      '.github/prompts/mamba.prompt.md',
      '.github/prompts/man8.prompt.md',
    );
    for (const mode of MODE_NAMES) {
      files.push(`.github/prompts/${mode}.prompt.md`);
    }
  }
  return [...new Set(files.map((file) => path.join(rootDir, file)))];
}

async function snapshotFiles(filePaths: string[]): Promise<FileSnapshot[]> {
  return Promise.all(
    filePaths.map(async (filePath) => {
      try {
        return { filePath, content: await fs.readFile(filePath, 'utf-8') };
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return { filePath, content: null };
        }
        throw error;
      }
    }),
  );
}

async function snapshotDirectories(
  filePaths: string[],
  additionalDirectories: string[] = [],
): Promise<DirectorySnapshot[]> {
  const directories = new Set<string>(additionalDirectories);
  for (const filePath of filePaths) {
    let current = path.dirname(filePath);
    while (current !== path.dirname(current)) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return Promise.all(
    [...directories].map(async (dirPath) => ({
      dirPath,
      existed: await pathExists(dirPath),
    })),
  );
}

async function restoreFiles(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.content === null) {
      await fs.rm(snapshot.filePath, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(snapshot.filePath), { recursive: true });
    await fs.writeFile(snapshot.filePath, snapshot.content, 'utf-8');
  }
}

async function removeNewEmptyDirectories(
  snapshots: DirectorySnapshot[],
): Promise<void> {
  const candidates = snapshots
    .filter((snapshot) => !snapshot.existed)
    .sort((a, b) => b.dirPath.length - a.dirPath.length);
  for (const { dirPath } of candidates) {
    try {
      await fs.rmdir(dirPath);
    } catch {
      // Preserve non-empty directories and any user files they contain.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function printPlatformCreatedFiles(
  platform: PlatformName,
  locale: InitLocale,
): void {
  if (platform === 'claude-code') {
    console.log(
      localize(
        locale,
        '  .claude/settings.json       # hook 注册',
        '  .claude/settings.json       # hook registration',
      ),
    );
    console.log(
      localize(
        locale,
        '  .claude/skills/             # solo + MVP-2 slash skills',
        '  .claude/skills/             # solo + MVP-2 slash skills',
      ),
    );
    return;
  }
  if (platform === 'cursor') {
    console.log('  .cursor/rules/              # Cursor project rules');
    return;
  }
  if (platform === 'codex') {
    console.log('  AGENTS.md                   # Codex managed block');
    console.log('  .agents/skills/              # Codex mode skills');
    return;
  }
  if (platform === 'zcode') {
    console.log('  AGENTS.md                   # ZCode managed block');
    console.log('  .agents/skills/             # ZCode mode skills');
    return;
  }
  console.log('  .github/copilot-instructions.md # Copilot instructions');
}

function localize(
  locale: InitLocale,
  chinese: string,
  english: string,
): string {
  return locale === 'zh-CN' ? chinese : english;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

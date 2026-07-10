import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { validateClaudeCodeSettings } from '../installers/claude-code.js';
import { installMancodeCore } from '../installers/common.js';
import {
  type PlatformName,
  getPlatformInstaller,
} from '../installers/registry.js';
import { detectTeamStatus } from '../system/detect-team.js';
import { detectSystemDeps } from '../system/detect.js';
import {
  PROJECT_MANIFESTS,
  detectProjectProfile,
  primaryUiLibrary,
} from '../system/project-profile.js';
import { scanAesthetics } from '../system/scan-aesthetics.js';
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
 * teamModeAutoDetected / contributors）支持 /man /mamba 流程和团队检测。
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
  // MVP-2: 团队检测
  teamModeAutoDetected: boolean;
  contributors: number;
}

export interface InitOptions {
  /** --force: 覆盖已有配置 */
  force?: boolean;
  /** --yes: 跳过所有确认（CI 用）*/
  yes?: boolean;
  /** --team / --no-team: 强制启用/禁用团队模式（MVP-2）*/
  team?: boolean;
  /** --style <name>: 指定审美风格（MVP-2）*/
  style?: string;
  /** --platform <platform>: initial adapter platform (MVP-3) */
  platform?: string;
}

/**
 * `mancode init` 命令（完整版）。
 *
 * 职责（docs/08-cli-spec.md §2.1-2.4）：
 * 1. 检测系统依赖（bash/git/jq）
 * 2. 检测中立 project profile（类型、语言、框架与验证能力）
 * 3. 创建 8 个文件/目录（.mancode/ + .claude/）
 * 4. 支持 --force / --yes / --team / --style 参数
 *
 * MVP-1 实现范围：
 * - ✅ 系统依赖检测 + 警告
 * - ✅ 跨常见生态的保守 project profile 检测
 * - ✅ 创建 8 个文件
 * - ✅ --force / --yes 参数
 * - ✅ --team / --no-team / --style 参数（MVP-2）
 * - ⏸️ 交互式确认（默认静默安装，--yes 保持兼容）
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
  let reinstallSnapshots: FileSnapshot[] = [];

  // 1. 幂等检查
  if (wasInitialized) {
    if (!options.force) {
      console.log('ℹ️  mancode already initialized.');
      console.log(`   ${stateFile}`);
      console.log('   Run `mancode init --force` to reinstall.');
      return EXIT_ALREADY_INITIALIZED;
    }
    try {
      reinstallSnapshots = await snapshotFiles([
        stateFile,
        path.join(mancodeDir, 'config.json'),
        path.join(mancodeDir, 'project-profile.json'),
        path.join(mancodeDir, 'aesthetics', 'style-tokens.json'),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗  Cannot snapshot existing mancode state: ${message}`);
      return EXIT_INIT_FAILED;
    }
    // --force: 继续，覆盖已有配置
    console.log('⚠️  Reinstalling with --force...');
  }

  // 2. 校验目标目录存在
  if (!(await pathExists(rootDir))) {
    console.error(`✗  Target directory does not exist: ${rootDir}`);
    return EXIT_NOT_A_PROJECT_DIR;
  }

  // 2.1 校验是项目目录（git 或任一常见项目 manifest）
  const isGitRepo = await pathExists(path.join(rootDir, '.git'));
  const hasManifest = await Promise.any(
    PROJECT_MANIFESTS.map(async (name) => {
      if (await pathExists(path.join(rootDir, name))) return true;
      throw new Error('manifest missing');
    }),
  ).catch(() => false);

  if (!isGitRepo && !hasManifest) {
    console.error(`✗  Not a project directory: ${rootDir}`);
    console.error('   (No .git or recognized project manifest found)');
    console.error('');
    console.error(
      '   Run mancode init in a git repository or a recognized project directory.',
    );
    return EXIT_NOT_A_PROJECT_DIR;
  }

  try {
    // 3. 检测系统依赖
    console.log('✓  检测系统依赖...');
    const deps = await detectSystemDeps();

    if (!deps.bash || !deps.git) {
      console.error('✗  Missing required dependencies:');
      if (!deps.bash) console.error('   - bash (required)');
      if (!deps.git) console.error('   - git (required)');
      console.error('');
      console.error('   Install them and try again.');
      return EXIT_NOT_A_PROJECT_DIR;
    }

    if (!deps.jq) {
      console.log(
        '⚠️  jq not found (optional). Hooks will use grep/sed fallback (slightly slower).',
      );
    } else {
      console.log('   bash ✓ git ✓ jq ✓');
    }

    // 4. 检测项目类型
    console.log('✓  检测项目类型...');
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
      console.log('   project manifest found, no known framework dependencies');
    } else {
      console.log(
        '   (No recognized manifest found, profile confidence is low)',
      );
    }

    const existingPlatform = wasInitialized
      ? await readExistingInitPlatform(stateFile)
      : null;
    const initPlatformName =
      options.platform ?? existingPlatform ?? DEFAULT_INIT_PLATFORM;
    const installer = getPlatformInstaller(initPlatformName);
    if (!installer) {
      console.error(`✗  Unsupported platform: ${initPlatformName}`);
      return EXIT_INIT_FAILED;
    }

    // 4.1 检测多人协作（MVP-2）
    const team = await detectTeamStatus(rootDir);
    const existingPreferences = wasInitialized
      ? await readExistingInitPreferences(mancodeDir, installer.name)
      : {};
    const initialMinimal = existingPreferences.minimal ?? false;
    const teamModeEnabled =
      options.team ?? existingPreferences.forceTeamMode ?? team.isTeam;
    if (options.team === true) {
      console.log('   team: forced on (--team)');
    } else if (options.team === false) {
      console.log('   team: forced off (--no-team)');
    } else if (team.isTeam) {
      console.log(
        `   team: ${team.contributors} contributors (/manteam available)`,
      );
    }

    const state: MancodeState = {
      version: VERSION,
      currentMode: 'solo',
      lastMode: 'solo',
      platform: installer.name,
      initializedAt: new Date().toISOString(),
      techStack: techStackStr,
      uiLibrary: uiLibraryStr,
      currentTask: null,
      currentWorkflowMode: null,
      skippedSteps: [],
      teamModeAutoDetected: teamModeEnabled,
      contributors: team.contributors,
    };

    // 5. 预检用户 Claude Code settings，避免坏 JSON 导致半初始化。
    if (installer.name === 'claude-code') {
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
        defaultStyle:
          options.style === undefined && wasInitialized
            ? undefined
            : (options.style ?? null),
        platforms: [installer.name],
        platformOptions: {
          [installer.name]: { minimal: initialMinimal },
        },
      },
      wasInitialized,
    );

    // 8. 审美扫描（profile 确认 UI 资产时才扫）。必须早于静态平台规则生成。
    let styleLine = '  .mancode/aesthetics/        # style-tokens.json (空)';
    if (profile.uiAssets === 'detected') {
      console.log('✓  扫描审美 token...');
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
          `   ${colorCount} colors, ${fontCount} fonts (match: high)`,
        );
        styleLine = `  .mancode/aesthetics/        # style-tokens.json (${colorCount} colors)`;
      } else if (tokens.matchLevel === 'low') {
        console.log(
          '   UI assets detected, no reusable tokens found (match: low)',
        );
        styleLine =
          '  .mancode/aesthetics/        # style-tokens.json (low match)';
      } else {
        console.log('   No design tokens found (match: none)');
        styleLine =
          '  .mancode/aesthetics/        # style-tokens.json (no tokens)';
      }
    }

    // 9. 安装平台适配。
    console.log(`✓  安装 ${installer.displayName} 适配...`);
    await installer.install(rootDir, {
      techStack: profileStack,
      uiLibrary,
      projectProfile: profile,
      minimal: initialMinimal,
      force: options.force,
    });

    // 10. 完成
    console.log('');
    console.log('✓  mancode initialized.');
    console.log('');
    console.log('Created:');
    console.log('  .mancode/state.json         # 项目状态');
    console.log('  .mancode/project-profile.json # 检测到的项目事实');
    console.log('  .mancode/config.json        # 配置');
    console.log(
      '  .mancode/hooks/             # SessionStart + UserPromptSubmit',
    );
    console.log(styleLine);
    console.log('  .mancode/logs/              # hooks.log');
    printPlatformCreatedFiles(installer.name);
    console.log('');
    console.log('Next:');
    console.log('  mancode status              # Show project state');
    if (installer.name === 'claude-code') {
      console.log('  (Restart Claude Code to load hooks)');
    } else if (installer.name === 'codex') {
      console.log(
        '  (If skills do not appear, restart the ChatGPT desktop app or Codex session)',
      );
    }

    return EXIT_OK;
  } catch (err) {
    if (wasInitialized) {
      await restoreFiles(reinstallSnapshots);
    } else {
      await fs.rm(stateFile, { force: true });
      await fs.rm(path.join(mancodeDir, 'project-profile.json'), {
        force: true,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗  mancode init failed: ${msg}`);
    return EXIT_INIT_FAILED;
  }
}

async function updateConfigOptions(
  mancodeDir: string,
  patch: {
    forceTeamMode?: boolean;
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

async function readExistingInitPreferences(
  mancodeDir: string,
  platform: PlatformName,
): Promise<{ forceTeamMode?: boolean; minimal?: boolean }> {
  try {
    const config = JSON.parse(
      await fs.readFile(path.join(mancodeDir, 'config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const preferences: { forceTeamMode?: boolean; minimal?: boolean } = {};
    if (typeof config.forceTeamMode === 'boolean') {
      preferences.forceTeamMode = config.forceTeamMode;
    }
    if (
      Array.isArray(config.platforms) &&
      config.platforms.includes(platform) &&
      isRecord(config.platformOptions)
    ) {
      const platformOptions = config.platformOptions[platform];
      if (isRecord(platformOptions) && platformOptions.minimal === true) {
        preferences.minimal = true;
      }
    }
    return preferences;
  } catch {
    return {};
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

interface FileSnapshot {
  filePath: string;
  content: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function printPlatformCreatedFiles(platform: PlatformName): void {
  if (platform === 'claude-code') {
    console.log('  .claude/settings.json       # hook 注册');
    console.log('  .claude/skills/             # solo + MVP-2 slash skills');
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

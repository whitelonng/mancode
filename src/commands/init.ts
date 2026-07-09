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
import { detectProjectType, detectSystemDeps } from '../system/detect.js';
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
 * teamModeAutoDetected / contributors）支持 /man /man8 流程和团队检测。
 */
export interface MancodeState {
  version: string;
  currentMode: 'solo' | 'man8' | 'man' | 'manteam' | 'manps';
  lastMode: 'solo' | 'man8' | 'man' | 'manteam' | 'manps';
  /** Initial/default adapter platform. Installed platforms live in config.json. */
  platform: PlatformName;
  initializedAt: string;
  techStack: string;
  uiLibrary: string;
  // MVP-2: workflow 状态
  currentTask: string | null;
  currentWorkflowMode: 'man8' | 'man' | null;
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
 * 2. 检测项目类型（frontend/backend/tech stack）
 * 3. 创建 8 个文件/目录（.mancode/ + .claude/）
 * 4. 支持 --force / --yes / --team / --style 参数
 *
 * MVP-1 实现范围：
 * - ✅ 系统依赖检测 + 警告
 * - ✅ 项目类型检测（基于 package.json）
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

  // 1. 幂等检查
  if (wasInitialized) {
    if (!options.force) {
      console.log('ℹ️  mancode already initialized.');
      console.log(`   ${stateFile}`);
      console.log('   Run `mancode init --force` to reinstall.');
      return EXIT_ALREADY_INITIALIZED;
    }
    // --force: 继续，覆盖已有配置
    console.log('⚠️  Reinstalling with --force...');
  }

  // 2. 校验目标目录存在
  if (!(await pathExists(rootDir))) {
    console.error(`✗  Target directory does not exist: ${rootDir}`);
    return EXIT_NOT_A_PROJECT_DIR;
  }

  // 2.1 校验是项目目录（至少有 .git 或 package.json）
  const isGitRepo = await pathExists(path.join(rootDir, '.git'));
  const hasPackageJson = await pathExists(path.join(rootDir, 'package.json'));

  if (!isGitRepo && !hasPackageJson) {
    console.error(`✗  Not a project directory: ${rootDir}`);
    console.error('   (No .git or package.json found)');
    console.error('');
    console.error(
      '   Run mancode init in a git repository or Node.js project.',
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
    const project = await detectProjectType(rootDir);
    const techStackStr = project.techStack.join(' + ') || 'Unknown';
    const uiLibraryStr = project.uiLibrary || 'None';

    if (project.techStack.length > 0) {
      console.log(`   ${techStackStr}`);
      if (project.uiLibrary) {
        console.log(`   UI: ${uiLibraryStr}`);
      }
    } else if (hasPackageJson) {
      console.log('   package.json found, no known framework dependencies');
    } else {
      console.log('   (No package.json found, skipping tech detection)');
    }

    const initPlatformName = options.platform ?? DEFAULT_INIT_PLATFORM;
    const installer = getPlatformInstaller(initPlatformName);
    if (!installer) {
      console.error(`✗  Unsupported platform: ${initPlatformName}`);
      return EXIT_INIT_FAILED;
    }

    // 4.1 检测多人协作（MVP-2）
    const team = await detectTeamStatus(rootDir);
    const teamModeEnabled = options.team ?? team.isTeam;
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

    await updateConfigOptions(mancodeDir, {
      forceTeamMode: options.team === true,
      defaultStyle: options.style ?? null,
      platforms: [installer.name],
      platformOptions: {
        [installer.name]: { minimal: false },
      },
    });

    // 8. 审美扫描（前端项目才扫）。必须早于静态平台规则生成。
    let styleLine = '  .mancode/aesthetics/        # style-tokens.json (空)';
    if (project.hasFrontend) {
      console.log('✓  扫描审美 token...');
      const tokens = await scanAesthetics(rootDir, project.uiLibrary);
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
        console.log('   Tailwind detected, no config found (match: low)');
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
      techStack: project.techStack,
      uiLibrary: project.uiLibrary,
    });

    // 10. 完成
    console.log('');
    console.log('✓  mancode initialized.');
    console.log('');
    console.log('Created:');
    console.log('  .mancode/state.json         # 项目状态');
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
    }

    return EXIT_OK;
  } catch (err) {
    if (!wasInitialized) {
      await fs.rm(stateFile, { force: true });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗  mancode init failed: ${msg}`);
    return EXIT_INIT_FAILED;
  }
}

async function updateConfigOptions(
  mancodeDir: string,
  patch: {
    forceTeamMode: boolean;
    defaultStyle: string | null;
    platforms: PlatformName[];
    platformOptions: Partial<Record<PlatformName, { minimal: boolean }>>;
  },
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
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, ...patch }, null, 2)}\n`,
    'utf-8',
  );
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
    console.log('  .codex/skills/              # Codex mode skills');
    return;
  }
  if (platform === 'zcode') {
    console.log('  AGENTS.md                   # ZCode managed block');
    console.log('  .zcode/skills/              # ZCode mode skills');
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

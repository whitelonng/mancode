import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { installClaudeCode } from '../installers/claude-code.js';
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

/**
 * mancode state 文件的内容。
 *
 * 字段命名采用 camelCase（JSON 输出），与 docs/12-lifecycle.md
 * 的 SessionStart hook 读取逻辑（json_get "currentMode"）保持一致。
 */
export interface MancodeState {
  version: string;
  currentMode: 'solo';
  platform: 'claude-code';
  initializedAt: string;
  techStack: string;
  uiLibrary: string;
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
 * - ⏸️ --team / --style（MVP-2）
 * - ⏸️ 交互式确认（MVP-1 暂用 --yes 默认静默安装）
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

  // 1. 幂等检查
  if (await pathExists(stateFile)) {
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
    } else {
      console.log('   (No package.json found, skipping tech detection)');
    }

    // 5. 创建 .mancode/state.json
    await fs.mkdir(mancodeDir, { recursive: true });

    const state: MancodeState = {
      version: VERSION,
      currentMode: 'solo',
      platform: 'claude-code',
      initializedAt: new Date().toISOString(),
      techStack: techStackStr,
      uiLibrary: uiLibraryStr,
    };

    const stateContent = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(stateFile, stateContent, 'utf-8');

    // 6. 安装 Claude Code 适配（8 个文件）
    console.log('✓  安装 Claude Code 适配...');
    await installClaudeCode(rootDir, {
      techStack: project.techStack,
      uiLibrary: project.uiLibrary,
    });

    // 7. 审美扫描（前端项目才扫）
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

    // 8. 完成
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
    console.log('  .claude/settings.json       # hook 注册');
    console.log('  .claude/skills/mancode-solo.md');
    console.log('');
    console.log('Next:');
    console.log('  mancode status              # Show project state');
    console.log('  (Restart Claude Code to load hooks)');

    return EXIT_OK;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗  mancode init failed: ${msg}`);
    return EXIT_NOT_A_PROJECT_DIR;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

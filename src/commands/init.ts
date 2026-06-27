import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { VERSION } from '../version.js';

/**
 * 退出码契约 — 见 docs/08-cli-spec.md §2.5
 *
 * 注意：`1 = already initialized` 是文档定义的语义，不是通用错误。
 * shell 脚本可以靠 `[ "$?" -eq 1 ]` 判断需要 `--force`。
 *
 * 完整退出码（设计目标）：
 *   0 = 成功
 *   1 = 已初始化过（用 --force 重装）
 *   2 = 不是项目目录（找不到 package.json / .git）
 *   3 = 用户取消
 *   4 = 网络错误
 *
 * 当前实现仅覆盖 0 / 1 / 2；3、4 等 Step 2 完整版补齐。
 */
export const EXIT_OK = 0;
export const EXIT_ALREADY_INITIALIZED = 1;
export const EXIT_NOT_A_PROJECT_DIR = 2;

/**
 * mancode state 文件的内容。
 *
 * 字段命名采用 camelCase（JSON 输出），与 docs/12-lifecycle.md
 * 的 SessionStart hook 读取逻辑（json_get "currentMode"）保持一致。
 */
export interface MancodeState {
  /** mancode 写入此文件时的版本号 */
  version: string;
  /** 当前激活的模式。MVP-1 只有 solo */
  currentMode: 'solo';
  /** 当前适配的平台。MVP-1 只有 claude-code */
  platform: 'claude-code';
  /** ISO 8601 字符串，记录首次初始化时间 */
  initializedAt: string;
}

/**
 * `mancode init` 命令（最小版本）。
 *
 * 行为：
 * - 在 rootDir/.mancode/ 下创建 state.json
 * - 已存在 state.json 时返回 EXIT_ALREADY_INITIALIZED（不报错，但语义上"非成功"）
 * - rootDir 不存在或不可写时返回 EXIT_NOT_A_PROJECT_DIR
 *
 * TODO(Step 2 完整版)：补齐 8 个文件 + 交互流程 + options
 *   详见 docs/08-cli-spec.md §2.2-2.4
 *
 * @param rootDir 目标项目根目录，默认 process.cwd()
 * @returns 退出码（见上方常量）
 */
export async function init(rootDir: string = process.cwd()): Promise<number> {
  const mancodeDir = path.join(rootDir, '.mancode');
  const stateFile = path.join(mancodeDir, 'state.json');

  // 幂等：已初始化 → 退出码 1（提示用 --force，但 --force 在 Step 2 完整版才实现）
  if (await pathExists(stateFile)) {
    console.log('ℹ️  mancode already initialized.');
    console.log(`   ${stateFile}`);
    console.log('   Run `mancode init --force` to reinstall (coming soon).');
    return EXIT_ALREADY_INITIALIZED;
  }

  // 校验目标目录存在且可写
  if (!(await pathExists(rootDir))) {
    console.error(`✗  Target directory does not exist: ${rootDir}`);
    return EXIT_NOT_A_PROJECT_DIR;
  }

  try {
    await fs.mkdir(mancodeDir, { recursive: true });

    const state: MancodeState = {
      version: VERSION,
      currentMode: 'solo',
      platform: 'claude-code',
      initializedAt: new Date().toISOString(),
    };

    const content = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(stateFile, content, 'utf-8');

    console.log('✓  mancode initialized.');
    console.log(`   ${stateFile}`);
    console.log('');
    console.log('Next:');
    console.log('  mancode status    # Show project state');
    return EXIT_OK;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗  mancode init failed: ${msg}`);
    // ENOTDIR / EACCES / EROFS 等通常意味着目标不是可写目录
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

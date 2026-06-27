import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { detectProjectType } from '../system/detect.js';
import { scanAesthetics } from '../system/scan-aesthetics.js';

/**
 * 退出码契约 — 见 docs/08-cli-spec.md §7
 */
export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;

/**
 * `mancode refresh-style` 命令。
 *
 * 职责（docs/08-cli-spec.md §7 + docs/06-aesthetics.md §9.2）：
 * 1. 检查项目已初始化
 * 2. 重新扫描项目审美 token
 * 3. 覆盖 .mancode/aesthetics/style-tokens.json
 * 4. 输出扫描结果摘要
 *
 * 触发场景（docs/06-aesthetics.md §9.2）：
 * - 用户改了 tailwind.config.js
 * - 用户改了 package.json dependencies
 * - 用户手动执行
 *
 * @param rootDir 目标项目根目录
 * @returns 退出码
 */
export async function refreshStyle(
  rootDir: string = process.cwd(),
): Promise<number> {
  const stateFile = path.join(rootDir, '.mancode', 'state.json');

  // 1. 检查是否已初始化
  if (!(await pathExists(stateFile))) {
    console.error('✗  mancode not initialized.');
    console.error('   Run `mancode init` first.');
    return EXIT_NOT_INITIALIZED;
  }

  // 2. 检测项目类型（需要 uiLibrary 和 hasFrontend）
  const project = await detectProjectType(rootDir);

  if (!project.hasFrontend) {
    console.log('ℹ️  No frontend framework detected. Nothing to scan.');
    return EXIT_OK;
  }

  // 3. 扫描审美 token
  console.log('✓  扫描项目设计 token...');
  const tokens = await scanAesthetics(rootDir, project.uiLibrary);

  // 4. 写入 style-tokens.json
  const tokensPath = path.join(
    rootDir,
    '.mancode',
    'aesthetics',
    'style-tokens.json',
  );
  await fs.writeFile(
    tokensPath,
    `${JSON.stringify(tokens, null, 2)}\n`,
    'utf-8',
  );

  // 5. 输出摘要
  console.log('');
  if (tokens.matchLevel === 'none') {
    console.log('未检测到设计 token。');
    console.log('  建议：添加 tailwind.config.js 或手动编辑 style-tokens.json');
  } else {
    if (tokens.sourceFiles.length > 0) {
      console.log('扫描来源：');
      for (const f of tokens.sourceFiles) {
        console.log(`  ✓ ${f}`);
      }
    }

    console.log('');
    console.log('检测结果：');
    if (tokens.uiLibrary) {
      console.log(`  UI 库:    ${tokens.uiLibrary}`);
    }
    if (tokens.darkMode) {
      console.log(`  Dark mode: ${tokens.darkMode}`);
    }

    const colorCount = Object.keys(tokens.colors).length;
    const fontCount = Object.keys(tokens.fonts).length;
    if (colorCount > 0) {
      console.log(`  颜色:     ${colorCount} 个`);
      for (const [name, value] of Object.entries(tokens.colors)) {
        console.log(`    ${name}: ${value}`);
      }
    }
    if (fontCount > 0) {
      console.log(`  字体:     ${fontCount} 个`);
      for (const [name, stack] of Object.entries(tokens.fonts)) {
        console.log(`    ${name}: ${stack.join(', ')}`);
      }
    }

    console.log(`  匹配度:   ${tokens.matchLevel}`);
  }

  console.log('');
  console.log('已更新 .mancode/aesthetics/style-tokens.json');
  return EXIT_OK;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

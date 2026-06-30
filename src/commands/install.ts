import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { installClaudeCode } from '../installers/claude-code.js';
import { detectProjectType } from '../system/detect.js';
import { DEFAULT_CONFIG } from '../templates/defaults.js';

/**
 * 退出码契约 — 见 docs/08-cli-spec.md §3
 */
export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_UNSUPPORTED_PLATFORM = 2;

/**
 * 当前支持的平台。
 *
 * 后续会加入 cursor / codex / copilot。
 */
const SUPPORTED_PLATFORMS = new Set(['claude-code']);

export interface InstallOptions {
  /** --force: 覆盖已有配置 */
  force?: boolean;
  /** --minimal: 最小安装（MVP-2 预留） */
  minimal?: boolean;
}

/**
 * `mancode install <platform>` 命令。
 *
 * 职责（docs/08-cli-spec.md §3 + docs/15-adapters.md §8）：
 * 1. 检查项目已初始化（state.json 存在）
 * 2. 验证平台名（MVP-1 仅 claude-code）
 * 3. 调用对应适配器安装
 * 4. 更新 config.json 的 platforms 数组
 * 5. 支持 --force 重装
 *
 * @param rootDir 目标项目根目录
 * @param platform 平台名（如 'claude-code'）
 * @param options CLI 参数
 * @returns 退出码
 */
export async function install(
  rootDir: string = process.cwd(),
  platform = 'claude-code',
  options: InstallOptions = {},
): Promise<number> {
  const stateFile = path.join(rootDir, '.mancode', 'state.json');

  // 1. 检查是否已初始化
  if (!(await pathExists(stateFile))) {
    console.error('✗  mancode not initialized.');
    console.error('   Run `mancode init` first.');
    return EXIT_NOT_INITIALIZED;
  }

  // 2. 验证平台名
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    console.error(`✗  Unsupported platform: ${platform}`);
    console.error('   Supported platforms:');
    console.error('     claude-code          Claude Code');
    console.error('');
    console.error('   Coming in MVP-3:');
    console.error('     cursor               Cursor');
    console.error('     codex                Codex CLI');
    console.error('     copilot              GitHub Copilot');
    return EXIT_UNSUPPORTED_PLATFORM;
  }

  // 3. 检查是否已安装（除非 --force）
  const configResult = await readConfig(rootDir);
  const config = withDefaultConfig(configResult.config);
  const alreadyInstalled =
    configResult.valid && config.platforms && Array.isArray(config.platforms)
      ? config.platforms.includes(platform)
      : false;

  if (alreadyInstalled && !options.force) {
    console.log(
      `ℹ️  ${formatPlatformName(platform)} adapter already installed.`,
    );
    console.log('   Run with --force to reinstall.');
    return EXIT_OK;
  }

  // 4. 安装
  console.log(`✓  Installing ${formatPlatformName(platform)} adapter...`);
  const project = await detectProjectType(rootDir);
  await installClaudeCode(rootDir, {
    techStack: project.techStack,
    uiLibrary: project.uiLibrary,
    minimal: options.minimal,
  });

  // 5. 更新 config.json platforms
  const platforms = Array.isArray(config.platforms) ? config.platforms : [];
  if (!platforms.includes(platform)) {
    platforms.push(platform);
  }
  await updateConfig(rootDir, { ...config, platforms });

  // 6. 完成
  console.log(`✓  ${formatPlatformName(platform)} adapter installed.`);
  return EXIT_OK;
}

/**
 * 读取 .mancode/config.json。
 */
async function readConfig(
  rootDir: string,
): Promise<{ config: Record<string, unknown>; valid: boolean }> {
  const configPath = path.join(rootDir, '.mancode', 'config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return { config: JSON.parse(raw) as Record<string, unknown>, valid: true };
  } catch {
    // config.json 不存在或损坏——返回空对象，install 会重建 platforms
    return { config: {}, valid: false };
  }
}

/**
 * 写入 .mancode/config.json。
 */
async function updateConfig(
  rootDir: string,
  config: Record<string, unknown>,
): Promise<void> {
  const configPath = path.join(rootDir, '.mancode', 'config.json');
  const content = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, content, 'utf-8');
}

function withDefaultConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    hooks: isRecord(config.hooks) ? config.hooks : DEFAULT_CONFIG.hooks,
    logging: isRecord(config.logging) ? config.logging : DEFAULT_CONFIG.logging,
  };
}

/**
 * 平台内部名 → 显示名。
 */
function formatPlatformName(p: string): string {
  const names: Record<string, string> = {
    'claude-code': 'Claude Code',
    cursor: 'Cursor',
    codex: 'Codex CLI',
    copilot: 'GitHub Copilot',
  };
  return names[p] ?? p;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

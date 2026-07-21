import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { assertUlid } from '../context/ids.js';
import { V3ContextStore } from '../context/store.js';
import { upgradeV3Adapters } from '../installers/adapter-upgrade.js';
import { checkPlatformStatus } from '../installers/platform-status.js';
import {
  formatPlatformName,
  getPlatformInstaller,
  getPlatformInstallers,
} from '../installers/registry.js';
import { stageV3Adapter } from '../installers/v3-adapter.js';
import {
  detectProjectProfile,
  primaryUiLibrary,
} from '../system/project-profile.js';
import { DEFAULT_CONFIG } from '../templates/defaults.js';
import { readV3CommandProject, resolveV3CommandSession } from './v3-support.js';

/**
 * 退出码契约见 docs/workflows.md。
 */
export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_UNSUPPORTED_PLATFORM = 2;
export const EXIT_INSTALL_FAILED = 3;

interface ConfigReadResult {
  config: Record<string, unknown>;
  valid: boolean;
}

export interface InstallOptions {
  /** --force: 覆盖已有配置 */
  force?: boolean;
  /** --minimal: 最小安装（MVP-2 预留） */
  minimal?: boolean;
  /** Render a V3 adapter candidate under staging without changing live files. */
  shadow?: boolean;
  /** Confirm a journaled V3 adapter install or repair. */
  confirm?: boolean;
  operationId?: string;
  session?: string;
  client?: string;
}

/**
 * `mancode install <platform>` 命令。
 *
 * 职责见 docs/workflows.md 和 docs/platform-adapters.md：
 * 1. 检查项目已初始化（state.json 存在）
 * 2. 验证平台名
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
  const v3SchemaFile = path.join(rootDir, '.mancode', 'schema.json');

  // V3 authority is physically separate from legacy state. Never fall
  // through to installMancodeCore when a V3 manifest is present.
  if (await pathExists(v3SchemaFile)) {
    return installV3(rootDir, platform, options);
  }
  if (options.shadow) {
    console.error('✗  MANCODE_V3_ADAPTER_SHADOW_REQUIRES_V3');
    console.error(
      '   Adapter shadow staging requires a mancode dual-read project.',
    );
    return EXIT_INSTALL_FAILED;
  }

  // 1. 检查是否已初始化
  if (!(await pathExists(stateFile))) {
    console.error('✗  mancode not initialized.');
    console.error('   Run `mancode init` first.');
    return EXIT_NOT_INITIALIZED;
  }

  // 2. 验证平台名
  const installer = getPlatformInstaller(platform);
  if (!installer) {
    printUnsupportedPlatform(platform);
    return EXIT_UNSUPPORTED_PLATFORM;
  }

  // 3. 检查是否已安装（除非 --force）
  let configResult: ConfigReadResult;
  try {
    configResult = await readConfig(rootDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗  Cannot read .mancode/config.json: ${msg}`);
    return EXIT_INSTALL_FAILED;
  }
  const config = withDefaultConfig(
    configResult.config,
    await readStatePlatform(rootDir),
  );
  const alreadyInstalled =
    configResult.valid && config.platforms && Array.isArray(config.platforms)
      ? config.platforms.includes(platform)
      : false;
  const configuredMinimal = readConfiguredMinimal(
    config.platformOptions,
    platform,
  );
  const effectiveMinimal =
    options.minimal === true ||
    (!options.force && alreadyInstalled && configuredMinimal);

  if (alreadyInstalled && !options.force) {
    const status = await checkPlatformStatus(rootDir, platform, true);
    if (status.ready) {
      if (!options.minimal) {
        console.log(
          `ℹ️  ${formatPlatformName(platform)} adapter already installed.`,
        );
        console.log('   Run with --force to reinstall.');
        return EXIT_OK;
      }
      console.log(
        `ℹ️  ${formatPlatformName(platform)} adapter already installed; switching to minimal install.`,
      );
      console.log('   Run with --force to fully reinstall.');
    } else {
      console.log(
        `ℹ️  ${formatPlatformName(platform)} is recorded in config but not ready; repairing generated files.`,
      );
    }
  }

  // 4. 安装
  console.log(`✓  Installing ${formatPlatformName(platform)} adapter...`);
  const profile = await detectProjectProfile(rootDir);
  try {
    await installer.install(rootDir, {
      techStack: [...profile.languages, ...profile.frameworks],
      uiLibrary: primaryUiLibrary(profile),
      projectProfile: profile,
      minimal: effectiveMinimal,
      force: options.force,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `✗  ${formatPlatformName(platform)} adapter install failed: ${msg}`,
    );
    return EXIT_INSTALL_FAILED;
  }

  // 5. 更新 config.json platforms
  const platforms = Array.isArray(config.platforms) ? config.platforms : [];
  if (!platforms.includes(platform)) {
    platforms.push(platform);
  }
  await updateConfig(rootDir, {
    ...config,
    platforms,
    platformOptions: updatePlatformOptions(config.platformOptions, platform, {
      ...options,
      minimal: effectiveMinimal,
    }),
  });

  // 6. 完成
  console.log(`✓  ${formatPlatformName(platform)} adapter installed.`);
  return EXIT_OK;
}

async function installV3(
  rootDir: string,
  platform: string,
  options: InstallOptions,
): Promise<number> {
  const installer = getPlatformInstaller(platform);
  if (installer === null) {
    printUnsupportedPlatform(platform);
    return EXIT_UNSUPPORTED_PLATFORM;
  }
  try {
    const project = await new V3ContextStore(rootDir).readProjectSnapshot();
    if (options.shadow) {
      if (project.manifest.activationState !== 'dual_read') {
        throw new Error('MANCODE_V3_ADAPTER_SHADOW_REQUIRES_DUAL_READ');
      }
      const staged = await stageV3Adapter(rootDir, installer.name);
      console.log(
        `✓  ${formatPlatformName(platform)} mancode bootstrap and original mode entries staged for shadow comparison.`,
      );
      console.log(`   ${staged.stagingTarget}`);
      for (const entry of staged.modeEntries) {
        console.log(`   ${entry.stagingTarget}`);
      }
      return EXIT_OK;
    }
    if (project.manifest.activationState !== 'v3_active') {
      throw new Error('MANCODE_V3_ADAPTER_INSTALL_REQUIRES_ACTIVE');
    }
    if (options.minimal) {
      console.log(
        'ℹ️  mancode adapters are already bootstrap-only; --minimal has no additional effect.',
      );
    }
    let sessionId: string | undefined;
    if (options.operationId !== undefined) {
      assertUlid(options.operationId, 'adapter install operationId');
    }
    if (options.confirm === true) {
      const commandProject = await readV3CommandProject(rootDir);
      sessionId = (
        await resolveV3CommandSession(commandProject, {
          session: options.session,
          client: options.client,
        })
      ).sessionId;
    }
    const installed = await upgradeV3Adapters({
      projectRoot: rootDir,
      platforms: [installer.name],
      explicitConfirmation: options.confirm,
      ...(options.operationId === undefined
        ? {}
        : { operationId: options.operationId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    console.log(
      installed.state === 'already_ready'
        ? `ℹ️  ${formatPlatformName(platform)} mancode bootstrap is already ready.`
        : `✓  ${formatPlatformName(platform)} mancode bootstrap installed.`,
    );
    for (const target of installed.filePlans)
      console.log(`   ${target.target}`);
    return EXIT_OK;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `✗  ${formatPlatformName(platform)} mancode adapter install failed: ${message}`,
    );
    return EXIT_INSTALL_FAILED;
  }
}

function printUnsupportedPlatform(platform: string): void {
  console.error(`✗  Unsupported platform: ${platform}`);
  console.error('   Supported platforms:');
  for (const item of getPlatformInstallers()) {
    console.error(`     ${item.name.padEnd(20)} ${item.displayName}`);
  }
}

/**
 * 读取 .mancode/config.json。
 */
async function readConfig(rootDir: string): Promise<ConfigReadResult> {
  const configPath = path.join(rootDir, '.mancode', 'config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return { config: JSON.parse(raw) as Record<string, unknown>, valid: true };
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { config: {}, valid: false };
    }
    // config.json 损坏时不要静默覆盖，避免丢失用户配置。
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
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
  fallbackPlatform: string | null,
): Record<string, unknown> {
  const fallback = fallbackPlatform ?? DEFAULT_CONFIG.platforms[0];
  const platforms = Array.isArray(config.platforms)
    ? config.platforms
    : [fallback];
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
  };
  return {
    ...merged,
    platforms,
    hooks: isRecord(config.hooks) ? config.hooks : DEFAULT_CONFIG.hooks,
    logging: isRecord(config.logging) ? config.logging : DEFAULT_CONFIG.logging,
  };
}

function updatePlatformOptions(
  value: unknown,
  platform: string,
  options: InstallOptions,
): Record<string, unknown> {
  const platformOptions = isRecord(value) ? { ...value } : {};
  const existing = platformOptions[platform];
  platformOptions[platform] = {
    ...(isRecord(existing) ? existing : {}),
    minimal: options.minimal === true,
  };
  return platformOptions;
}

function readConfiguredMinimal(value: unknown, platform: string): boolean {
  if (!isRecord(value)) return false;
  const platformOptions = value[platform];
  return isRecord(platformOptions) && platformOptions.minimal === true;
}

async function readStatePlatform(rootDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, '.mancode', 'state.json'),
      'utf-8',
    );
    const state = JSON.parse(raw) as { platform?: unknown };
    return typeof state.platform === 'string' ? state.platform : null;
  } catch {
    return null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

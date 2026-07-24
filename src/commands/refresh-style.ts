import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  createProjectFacts,
  writeProjectFacts as writeV3ProjectFacts,
} from '../context/project-facts.js';
import { V3ContextStore } from '../context/store.js';
import {
  detectProjectProfile,
  primaryUiLibrary,
} from '../system/project-profile.js';
import { scanAesthetics } from '../system/scan-aesthetics.js';

/**
 * 退出码契约见 docs/workflows.md。
 */
export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_V3_REFRESH_FAILED = 2;

export interface RefreshStyleOptions {
  root?: string;
}

/**
 * `mancode refresh-style` 命令。
 *
 * 职责见 docs/project-intelligence.md：
 * 1. 检查项目已初始化
 * 2. 重新扫描项目审美 token
 * 3. 覆盖 .mancode/aesthetics/style-tokens.json
 * 4. 输出扫描结果摘要
 *
 * 触发场景见 docs/project-intelligence.md：
 * - 用户改了 tailwind.config.js
 * - 用户改了 package.json dependencies
 * - 用户手动执行
 *
 * @param rootDir 目标项目根目录
 * @returns 退出码
 */
export async function refreshStyle(
  rootDir: string = process.cwd(),
  options: RefreshStyleOptions = {},
): Promise<number> {
  const scanTarget = await resolveScanTarget(rootDir, options.root);
  if (scanTarget === null) {
    console.error('✗  style scan root must stay inside the project root.');
    return EXIT_V3_REFRESH_FAILED;
  }
  const stateFile = path.join(rootDir, '.mancode', 'state.json');
  if (await pathExists(path.join(rootDir, '.mancode', 'schema.json'))) {
    return refreshV3Style(rootDir, scanTarget.root, scanTarget.scopeRoot);
  }

  // 1. 检查是否已初始化
  if (!(await pathExists(stateFile))) {
    console.error('✗  mancode not initialized.');
    console.error('   Run `mancode init` first.');
    return EXIT_NOT_INITIALIZED;
  }

  // 2. 刷新 project profile
  console.log('✓  刷新项目 profile...');
  const profile = await detectProjectProfile(rootDir);
  const profilePath = path.join(rootDir, '.mancode', 'project-profile.json');
  await fs.writeFile(
    profilePath,
    `${JSON.stringify(profile, null, 2)}\n`,
    'utf-8',
  );
  const scanProfile =
    scanTarget.scopeRoot === '.'
      ? profile
      : await detectProjectProfile(scanTarget.root);
  const uiLibraryHint = primaryUiLibrary(scanProfile);
  await refreshLegacyStateContext(rootDir, profile, uiLibraryHint);
  console.log(
    `   类型: ${profile.projectKind} | UI: ${profile.uiAssets} | 浏览器: ${profile.browserAutomation}`,
  );

  // 3. 审美扫描（仅在 profile 确认 UI 资产时执行）
  if (scanProfile.uiAssets !== 'detected') {
    console.log(
      'ℹ️  No UI assets detected in project profile. Skipping style scan.',
    );
    console.log('   Updated .mancode/project-profile.json.');
    await printStaticPlatformRefreshHint(rootDir);
    return EXIT_OK;
  }

  // 4. 扫描审美 token
  console.log('✓  扫描项目设计 token...');
  const tokens = await scanAesthetics(
    scanTarget.root,
    uiLibraryHint,
    scanTarget.scopeRoot,
  );

  // 5. 写入 style-tokens.json
  const tokensPath = path.join(
    rootDir,
    '.mancode',
    'aesthetics',
    'style-tokens.json',
  );
  await fs.mkdir(path.dirname(tokensPath), { recursive: true });
  await fs.writeFile(
    tokensPath,
    `${JSON.stringify(tokens, null, 2)}\n`,
    'utf-8',
  );

  // 6. 输出摘要
  printAestheticsSummary(tokens);

  console.log('');
  console.log(
    '已更新 .mancode/project-profile.json 和 .mancode/aesthetics/style-tokens.json',
  );
  await printStaticPlatformRefreshHint(rootDir);
  return EXIT_OK;
}

function printAestheticsSummary(
  tokens: Awaited<ReturnType<typeof scanAesthetics>>,
): void {
  console.log('');
  if (tokens.matchLevel === 'none') {
    console.log('未检测到设计 token。');
    console.log(
      '  建议：检查项目现有主题、组件或 token 文件，必要时手动维护 style-tokens.json',
    );
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
}

/** V3 keeps detected facts shared and rebuildable style scans checkout-local. */
async function refreshV3Style(
  rootDir: string,
  scanRoot: string,
  scopeRoot: string,
): Promise<number> {
  try {
    const project = await new V3ContextStore(rootDir).readProjectSnapshot();
    if (project.manifest.activationState !== 'v3_active') {
      throw new Error('MANCODE_V3_REFRESH_REQUIRES_ACTIVE');
    }
    console.log('✓  刷新 mancode 项目 profile...');
    const profile = await detectProjectProfile(rootDir);
    const scanProfile =
      scopeRoot === '.' ? profile : await detectProjectProfile(scanRoot);
    const uiLibraryHint = primaryUiLibrary(scanProfile);
    await writeV3ProjectFacts(
      rootDir,
      createProjectFacts(profile, {
        revision: (project.projectFacts?.revision ?? 0) + 1,
      }),
    );
    console.log(
      `   类型: ${profile.projectKind} | UI: ${profile.uiAssets} | 浏览器: ${profile.browserAutomation}`,
    );

    const tokensPath = path.join(
      rootDir,
      '.mancode',
      'local',
      'cache',
      'style-tokens.json',
    );
    if (scanProfile.uiAssets !== 'detected') {
      await fs.rm(tokensPath, { force: true });
      console.log(
        'ℹ️  No UI assets detected in project profile. Skipping style scan.',
      );
      console.log('   Updated mancode project facts.');
      return EXIT_OK;
    }

    console.log('✓  扫描项目设计 token...');
    const tokens = await scanAesthetics(scanRoot, uiLibraryHint, scopeRoot);
    await fs.mkdir(path.dirname(tokensPath), { recursive: true });
    await fs.writeFile(
      tokensPath,
      `${JSON.stringify(tokens, null, 2)}\n`,
      'utf-8',
    );
    printAestheticsSummary(tokens);
    console.log('');
    console.log(
      '已更新 .mancode/shared/context/project.json 和 .mancode/local/cache/style-tokens.json',
    );
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗  mancode style refresh failed: ${message}`);
    return EXIT_V3_REFRESH_FAILED;
  }
}

async function printStaticPlatformRefreshHint(rootDir: string): Promise<void> {
  const platforms = await readInstalledPlatforms(rootDir);
  const staticPlatforms = platforms.filter(
    (platform) => platform !== 'claude-code',
  );
  if (staticPlatforms.length === 0) return;

  console.log('');
  console.log(
    `ℹ️  Style tokens updated. Non-Claude-Code platforms (${staticPlatforms.join(', ')}) use static generated instructions.`,
  );
  console.log(
    '   Run `mancode install <platform> --force` to refresh their embedded style summaries.',
  );
}

async function refreshLegacyStateContext(
  rootDir: string,
  profile: Awaited<ReturnType<typeof detectProjectProfile>>,
  uiLibrary: string | null,
): Promise<void> {
  const statePath = path.join(rootDir, '.mancode', 'state.json');
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const stack = [...profile.languages, ...profile.frameworks];
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          techStack: stack.join(' + ') || profile.projectKind,
          uiLibrary: uiLibrary ?? 'None',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
  } catch {
    // state.json was validated before refresh; keep profile refresh usable if a
    // concurrent process removes or replaces it.
  }
}

async function readInstalledPlatforms(rootDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(raw) as { platforms?: unknown };
    return Array.isArray(config.platforms)
      ? config.platforms.filter(
          (platform): platform is string => typeof platform === 'string',
        )
      : [];
  } catch {
    return [];
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

async function resolveScanTarget(
  rootDir: string,
  requestedRoot: string | undefined,
): Promise<{ root: string; scopeRoot: string } | null> {
  const projectRoot = await fs
    .realpath(path.resolve(rootDir))
    .catch(() => null);
  if (projectRoot === null) return null;
  if (requestedRoot === undefined || requestedRoot === '.') {
    return { root: projectRoot, scopeRoot: '.' };
  }
  if (
    path.isAbsolute(requestedRoot) ||
    requestedRoot.includes('\0') ||
    requestedRoot
      .split(/[\\/]/)
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null;
  }
  const candidate = await fs
    .realpath(path.resolve(projectRoot, requestedRoot))
    .catch(() => null);
  if (candidate === null) return null;
  const relative = path.relative(projectRoot, candidate);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return {
    root: candidate,
    scopeRoot: relative.split(path.sep).join('/') || '.',
  };
}

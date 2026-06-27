import { exec } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * 系统依赖检测结果。
 */
export interface SystemDeps {
  bash: boolean;
  git: boolean;
  jq: boolean;
  node: boolean;
}

/**
 * 项目类型检测结果。
 */
export interface ProjectType {
  hasFrontend: boolean;
  hasBackend: boolean;
  techStack: string[];
  uiLibrary: string | null;
}

/**
 * 检测系统依赖（bash、git、jq、node）。
 *
 * docs/08-cli-spec.md §12.1 要求：
 * - bash/git/node 必需
 * - jq 可选（无则警告，hook 走 grep/sed fallback）
 */
export async function detectSystemDeps(): Promise<SystemDeps> {
  const ALLOWED_COMMANDS = new Set(['bash', 'git', 'jq', 'node']);

  const check = async (cmd: string): Promise<boolean> => {
    // 白名单验证（防御性编程）
    if (!ALLOWED_COMMANDS.has(cmd)) {
      throw new Error(`Unsupported dependency check: ${cmd}`);
    }

    try {
      await execAsync(`command -v ${cmd}`, { shell: '/bin/bash' });
      return true;
    } catch {
      return false;
    }
  };

  const [bash, git, jq, node] = await Promise.all([
    check('bash'),
    check('git'),
    check('jq'),
    check('node'),
  ]);

  return { bash, git, jq, node };
}

/**
 * 检测项目类型（frontend / backend / tech stack）。
 *
 * 当前版本：基于 package.json dependencies 简单推断。
 * 完整版见 docs/13-scanning.md（扫描 tsconfig / vite.config / 文件结构）。
 *
 * @param projectRoot 项目根目录
 */
export async function detectProjectType(
  projectRoot: string,
): Promise<ProjectType> {
  const pkgPath = path.join(projectRoot, 'package.json');

  try {
    await access(pkgPath);
  } catch (err) {
    // 只在文件不存在时返回空，其他错误（权限、磁盘错误等）抛出
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        hasFrontend: false,
        hasBackend: false,
        techStack: [],
        uiLibrary: null,
      };
    }
    throw err;
  }

  const raw = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw);

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };

  const deps = Object.keys(allDeps || {});

  // 前端框架
  const hasFrontend =
    deps.some((d) => ['react', 'vue', 'svelte', 'angular'].includes(d)) ||
    deps.some((d) => d.startsWith('@angular/'));

  // 后端框架
  const hasBackend =
    deps.some((d) =>
      ['express', 'koa', 'fastify', 'hapi', 'next'].includes(d),
    ) || deps.some((d) => d.startsWith('@nestjs/'));

  // 技术栈（简单枚举）
  const techStack: string[] = [];
  if (deps.includes('react')) techStack.push('React');
  if (deps.includes('vue')) techStack.push('Vue');
  if (deps.includes('svelte')) techStack.push('Svelte');
  if (deps.includes('typescript')) techStack.push('TypeScript');
  if (deps.includes('tailwindcss')) techStack.push('Tailwind CSS');

  // UI 库
  let uiLibrary: string | null = null;

  // shadcn/ui 检测：Radix 依赖 + src/components/ui 目录
  const hasRadix = deps.some((d) => d.startsWith('@radix-ui/'));
  const uiDir = path.join(projectRoot, 'src', 'components', 'ui');
  const hasUiDir = await pathExists(uiDir);

  if (hasRadix && hasUiDir) {
    uiLibrary = 'shadcn/ui';
  } else if (deps.includes('@mui/material')) {
    uiLibrary = 'MUI';
  } else if (deps.includes('antd')) {
    uiLibrary = 'Ant Design';
  } else if (deps.includes('@headlessui/react')) {
    uiLibrary = 'headlessUI';
  }

  return { hasFrontend, hasBackend, techStack, uiLibrary };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

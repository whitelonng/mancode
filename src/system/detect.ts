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
  const check = async (cmd: string): Promise<boolean> => {
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
  } catch {
    // 无 package.json → 不是 Node 项目，返回空
    return {
      hasFrontend: false,
      hasBackend: false,
      techStack: [],
      uiLibrary: null,
    };
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
  if (deps.some((d) => d.includes('shadcn') || d === '@radix-ui/react-icons'))
    uiLibrary = 'shadcn/ui';
  else if (deps.includes('@mui/material')) uiLibrary = 'MUI';
  else if (deps.includes('antd')) uiLibrary = 'Ant Design';
  else if (deps.includes('@headlessui/react')) uiLibrary = 'headlessUI';

  return { hasFrontend, hasBackend, techStack, uiLibrary };
}

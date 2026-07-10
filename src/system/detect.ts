import { exec } from 'node:child_process';
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

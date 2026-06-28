import process from 'node:process';
import { VERSION } from '../version.js';

/**
 * `mancode version` 命令。
 *
 * 输出格式（docs/08-cli-spec.md §5.3）：
 * ```
 * mancode/0.1.0
 * node/20.10.0
 * darwin/arm64
 * ```
 */
export function version(): void {
  const nodeVersion = process.version;
  const platform = `${process.platform}/${process.arch}`;
  console.log(`mancode/${VERSION}`);
  console.log(`node/${nodeVersion.replace('v', '')}`);
  console.log(platform);
}

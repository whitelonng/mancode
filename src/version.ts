import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageJson {
  version: string;
}

const packageJson = require('../package.json') as PackageJson;

/**
 * mancode 版本号。
 *
 * 单一来源：package.json 的 version 字段。
 * 运行时通过 createRequire 读取，避免双源头同步问题。
 */
export const VERSION: string = packageJson.version;

import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

/**
 * 审美扫描结果（MVP-1 范围）。
 *
 * 结构对齐 docs/06-aesthetics.md §9.3 和 docs/13-scanning.md §8.2。
 * MVP-1 只提取 Tailwind colors/fonts + darkMode + uiLibrary。
 * MVP-2 会加 components / cssVariables。
 */
export interface AestheticsTokens {
  version: string;
  lastScanned: string | null;
  colors: Record<string, string>;
  fonts: Record<string, string[]>;
  components: string[];
  cssVariables: Record<string, string>;
  uiLibrary: string | null;
  darkMode: string | null;
  matchLevel: 'high' | 'low' | 'none';
  sourceFiles: string[];
}

const MAX_COMPONENT_SCAN_DEPTH = 12;
const MAX_COMPONENT_FILES = 2000;

/**
 * 扫描项目审美 token（MVP-1）。
 *
 * 职责（docs/13-scanning.md §4 + docs/06-aesthetics.md §3）：
 * 1. 检测 tailwind.config.{js,ts,cjs,mjs}，提取 colors 和 fontFamily
 * 2. 检测 darkMode 策略
 * 3. matchLevel: 有 tailwind config → high，有 tailwind 依赖但无 config → low，都没有 → none
 *
 * MVP-1 不做（推迟到 MVP-2）：
 * - shadcn/ui CSS 变量提取（docs/13-scanning.md §4.2）
 * - 组件扫描（docs/13-scanning.md §5）
 * - theme.json / tokens.json 等
 *
 * @param projectRoot 项目根目录
 * @param uiLibrary 已检测到的 UI 库（从 detectProjectType 传入，避免重复检测）
 */
export async function scanAesthetics(
  projectRoot: string,
  uiLibrary: string | null = null,
): Promise<AestheticsTokens> {
  const sourceFiles: string[] = [];

  // 1. 查找 tailwind config
  const configResult = await findTailwindConfig(projectRoot);
  let colors: Record<string, string> = {};
  let fonts: Record<string, string[]> = {};
  let darkMode: string | null = null;
  const components = await scanComponents(projectRoot);
  const cssScan = await scanCssVariables(projectRoot);

  if (configResult) {
    sourceFiles.push(configResult.relPath);
    const content = await fs.readFile(configResult.absPath, 'utf-8');
    const themeBlock = findKeyBlock(content, 'theme');
    if (themeBlock) {
      // 先在 theme.extend 里找 section，找不到再在 theme 里直接找
      const extendBlock = findKeyBlock(themeBlock, 'extend');
      const searchBlock = extendBlock ?? themeBlock;

      const colorsBlock = findKeyBlock(searchBlock, 'colors');
      if (colorsBlock) {
        colors = extractTopLevelStringValues(colorsBlock);
      }

      const fontsBlock = findKeyBlock(searchBlock, 'fontFamily');
      if (fontsBlock) {
        fonts = extractTopLevelArrayValues(fontsBlock);
      }
    }
    darkMode = extractDarkMode(stripJsComments(content));
  }

  // 2. 判断 matchLevel
  let matchLevel: AestheticsTokens['matchLevel'] = 'none';
  if (configResult) {
    matchLevel = 'high';
  } else if (await hasTailwindDep(projectRoot)) {
    matchLevel = 'low';
  }

  if (uiLibrary) {
    sourceFiles.push('package.json');
  }
  sourceFiles.push(...cssScan.sourceFiles);

  return {
    version: '1.0.0',
    lastScanned: new Date().toISOString(),
    colors,
    fonts,
    components,
    cssVariables: cssScan.variables,
    uiLibrary,
    darkMode,
    matchLevel,
    sourceFiles,
  };
}

/**
 * 查找 tailwind.config.{js,ts,cjs,mjs}。
 * 返回绝对路径和相对路径，找不到返回 null。
 */
async function findTailwindConfig(
  projectRoot: string,
): Promise<{ absPath: string; relPath: string } | null> {
  const candidates = [
    'tailwind.config.js',
    'tailwind.config.ts',
    'tailwind.config.cjs',
    'tailwind.config.mjs',
  ];

  for (const name of candidates) {
    const absPath = path.join(projectRoot, name);
    if (await pathExists(absPath)) {
      return { absPath, relPath: name };
    }
  }

  return null;
}

// ─── 花括号深度遍历工具 ───────────────────────────────────────────

/**
 * 在 content 中查找 `key:` 后面跟着的花括号块，返回块内容（不含外层花括号）。
 *
 * 正确处理嵌套：theme: { extend: { colors: { ... } } }
 * 找到第一个 `key:` 后跟着 `{` 的位置，提取完整块。
 *
 * 作用域安全：调用方传入的是父块的内容（已提取），所以第一个匹配
 * 就是当前层级的 key，不会误匹配嵌套块内的同名 key。
 *
 * @param content 要搜索的内容
 * @param key 要查找的键名（如 "theme" / "extend" / "colors"）
 * @returns 花括号内的内容，找不到返回 null
 */
function findKeyBlock(content: string, key: string): string | null {
  const keyPattern = new RegExp(`['"]?${escapeRegex(key)}['"]?\\s*:`);

  let searchStart = 0;
  while (searchStart < content.length) {
    const remaining = content.slice(searchStart);
    const match = keyPattern.exec(remaining);
    if (!match) break;

    const absPos = searchStart + match.index;

    // 从 match 结束位置找第一个 {
    let i = absPos + match[0].length;
    while (i < content.length && content[i] !== '{') {
      // 遇到非空白字符说明值不是对象，跳过
      const char = content[i];
      if (char === undefined || !/\s/.test(char)) break;
      i++;
    }
    if (i >= content.length || content[i] !== '{') {
      searchStart = absPos + match[0].length;
      continue;
    }

    // 按花括号深度提取完整块
    return extractBraceContent(content, i);
  }

  return null;
}

/**
 * 从开 { 位置开始，按花括号深度提取完整块内容。
 *
 * @param content 完整文本
 * @param bracePos 开 { 的位置
 * @returns 花括号内的内容（不含外层花括号），不匹配返回 null
 */
function extractBraceContent(content: string, bracePos: number): string | null {
  if (content[bracePos] !== '{') return null;

  let i = bracePos + 1;
  let depth = 1;
  const start = i;

  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0) break;
    i++;
  }

  if (depth !== 0) return null;
  return content.slice(start, i);
}

// ─── 值提取工具 ───────────────────────────────────────────────────

/**
 * 从块内容中提取顶层（depth 0）的 key: "string" 对。
 *
 * 只匹配当前层级的键值对，跳过嵌套对象内的值。
 * 例如 `{ primary: { 500: "#abc" }, background: "#fff" }`
 * 只提取 background，不提取 500。
 */
function extractTopLevelStringValues(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pairs = extractTopLevelPairs(block);

  for (const { key, value } of pairs) {
    if (!isSafeTokenName(key)) continue;
    // 值必须是引号包裹的字符串（不是对象、不是数组）
    const strMatch = value.match(/^['"]([^'"]+)['"]$/);
    const tokenValue = strMatch?.[1];
    if (tokenValue && isSafeColorValue(tokenValue)) {
      result[key] = tokenValue;
    }
  }

  return result;
}

/**
 * 从块内容中提取顶层（depth 0）的 key: ["a", "b"] 对。
 *
 * 只匹配当前层级的键值对，跳过嵌套对象内的值。
 */
function extractTopLevelArrayValues(block: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const pairs = extractTopLevelPairs(block);

  for (const { key, value } of pairs) {
    if (!isSafeTokenName(key)) continue;
    // 值必须是数组
    const arrMatch = value.match(/^\[([^\]]+)\]$/);
    const rawItems = arrMatch?.[1];
    if (rawItems) {
      const items = rawItems
        .split(',')
        .map((v) => v.trim().replace(/['"]/g, ''))
        .filter((v) => v.length > 0);
      if (items.length > 0) {
        result[key] = items;
      }
    }
  }

  return result;
}

/**
 * 提取块内容中顶层（depth 0）的 key: value 对。
 *
 * 遍历块内容，在 depth 0 处识别 `key: value` 结构。
 * value 可以是字符串、数组、或嵌套对象（嵌套对象被跳过，只记录 key）。
 */
function extractTopLevelPairs(
  block: string,
): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];

  let i = 0;
  while (i < block.length) {
    // 跳过空白和逗号
    while (i < block.length && /[\s,]/.test(block[i] ?? '')) i++;
    if (i >= block.length) break;

    // 提取 key（可能是带引号或不带引号的标识符）
    const keyResult = parseKey(block, i);
    if (!keyResult) {
      i++;
      continue;
    }
    const { key, nextPos: afterKey } = keyResult;

    // 跳过 key 后的空白
    i = afterKey;
    while (i < block.length && /\s/.test(block[i] ?? '')) i++;

    // 期望冒号
    if (block[i] !== ':') continue;
    i++;
    while (i < block.length && /\s/.test(block[i] ?? '')) i++;
    if (i >= block.length) break;

    // 提取 value（在 depth 0）
    const valueResult = parseValue(block, i);
    if (!valueResult) {
      i++;
      continue;
    }

    pairs.push({ key, value: valueResult.value.trim() });
    i = valueResult.nextPos;
  }

  return pairs;
}

/**
 * 从位置 i 开始解析键名。
 * 支持带引号和不带引号的标识符。
 */
function parseKey(
  content: string,
  start: number,
): { key: string; nextPos: number } | null {
  if (start >= content.length) return null;

  // 带引号的 key
  if (content[start] === '"' || content[start] === "'") {
    const quote = content[start];
    let i = start + 1;
    while (i < content.length && content[i] !== quote) {
      if (content[i] === '\\') i++;
      i++;
    }
    if (i >= content.length) return null;
    return {
      key: content.slice(start + 1, i),
      nextPos: i + 1,
    };
  }

  // 不带引号的 key（标识符）
  const match = /^[\w-]+/.exec(content.slice(start));
  if (!match) return null;

  return {
    key: match[0],
    nextPos: start + match[0].length,
  };
}

/**
 * 从位置 i 开始解析值（在 depth 0）。
 * 支持字符串、数组、嵌套对象（跳过嵌套对象内容，只记录起始位置到结束）。
 */
function parseValue(
  content: string,
  start: number,
): { value: string; nextPos: number } | null {
  if (start >= content.length) return null;

  // 字符串值
  if (content[start] === '"' || content[start] === "'") {
    const quote = content[start];
    let i = start + 1;
    while (i < content.length && content[i] !== quote) {
      if (content[i] === '\\') i++;
      i++;
    }
    if (i >= content.length) return null;
    return {
      value: content.slice(start, i + 1),
      nextPos: i + 1,
    };
  }

  // 数组值
  if (content[start] === '[') {
    let i = start + 1;
    let depth = 1;
    while (i < content.length && depth > 0) {
      if (content[i] === '[') depth++;
      else if (content[i] === ']') depth--;
      i++;
    }
    if (depth !== 0) return null;
    return {
      value: content.slice(start, i),
      nextPos: i,
    };
  }

  // 嵌套对象值——跳过整个块
  if (content[start] === '{') {
    let i = start + 1;
    let depth = 1;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) return null;
    return {
      value: content.slice(start, i),
      nextPos: i,
    };
  }

  return null;
}

// ─── 其他工具 ─────────────────────────────────────────────────────

/**
 * 从 tailwind config 提取 darkMode 策略。
 *
 * 匹配 darkMode: "class" / darkMode: "media"
 */
function extractDarkMode(content: string): string | null {
  const match = content.match(/darkMode\s*:\s*['"](\w+)['"]/);
  return match?.[1] ?? null;
}

/**
 * 去掉 JS/TS 注释，避免从注释里的示例配置误提取 darkMode。
 * 保留字符串内容，防止 URL 或文字里的 // 被误删。
 */
function stripJsComments(content: string): string {
  let result = '';
  let i = 0;
  let quote: '"' | "'" | '`' | null = null;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    if (quote) {
      result += ch;
      if (ch === '\\') {
        i++;
        if (i < content.length) result += content[i];
      } else if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      result += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (
        i < content.length &&
        !(content[i] === '*' && content[i + 1] === '/')
      ) {
        if (content[i] === '\n') result += '\n';
        i++;
      }
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

async function scanComponents(projectRoot: string): Promise<string[]> {
  const roots = ['src/components', 'components', 'app/components'];
  const names = new Set<string>();
  let visitedFiles = 0;
  for (const relRoot of roots) {
    const absRoot = path.join(projectRoot, relRoot);
    if (!(await pathExists(absRoot))) continue;
    visitedFiles = await collectComponentNames(absRoot, names, 0, visitedFiles);
    if (visitedFiles >= MAX_COMPONENT_FILES) break;
  }
  return Array.from(names).sort();
}

async function collectComponentNames(
  dir: string,
  names: Set<string>,
  depth: number,
  visitedFiles: number,
): Promise<number> {
  if (depth > MAX_COMPONENT_SCAN_DEPTH || visitedFiles >= MAX_COMPONENT_FILES) {
    return visitedFiles;
  }
  let fileCount = visitedFiles;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return fileCount;
  }

  for (const entry of entries) {
    if (fileCount >= MAX_COMPONENT_FILES) return fileCount;
    const abs = path.join(dir, entry);
    let info: Stats;
    try {
      info = await fs.lstat(abs);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      fileCount = await collectComponentNames(abs, names, depth + 1, fileCount);
      continue;
    }
    if (!/\.(tsx|jsx|ts|js|vue|svelte)$/.test(entry)) continue;
    fileCount++;
    if (isNonComponentFile(entry)) continue;
    let base = entry.replace(/\.(tsx|jsx|ts|js|vue|svelte)$/, '');
    if (base === 'index') {
      base = path.basename(dir);
    }
    if (base.startsWith('.')) continue;
    const componentName = toPascalCase(base);
    if (isSafeComponentName(componentName)) {
      names.add(componentName);
    }
  }
  return fileCount;
}

async function scanCssVariables(
  projectRoot: string,
): Promise<{ variables: Record<string, string>; sourceFiles: string[] }> {
  const candidates = [
    'src/app/globals.css',
    'src/index.css',
    'src/globals.css',
    'app/globals.css',
    'styles/globals.css',
    'globals.css',
  ];
  const variables: Record<string, string> = {};
  const sourceFiles: string[] = [];
  for (const relPath of candidates) {
    const absPath = path.join(projectRoot, relPath);
    if (!(await pathExists(absPath))) continue;
    const content = await fs.readFile(absPath, 'utf-8');
    const found = extractCssVariables(content);
    if (Object.keys(found).length === 0) continue;
    Object.assign(variables, found);
    sourceFiles.push(relPath);
  }
  return { variables, sourceFiles };
}

function extractCssVariables(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const regex = /--([a-zA-Z0-9-_]+)\s*:\s*([^;{}]+);/g;
  let match = regex.exec(withoutComments);
  while (match !== null) {
    const key = match[1];
    const value = match[2]?.trim();
    if (key && value && value.length <= 120 && isSafeCssVariableValue(value)) {
      result[key] = value;
    }
    match = regex.exec(withoutComments);
  }
  return result;
}

function isSafeColorValue(value: string): boolean {
  return /^[#\w\s,.%()/+-]+$/.test(value);
}

function isSafeCssVariableValue(value: string): boolean {
  return /^[#\w\s,.%()/+-]+$/.test(value);
}

function isSafeTokenName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function isSafeComponentName(value: string): boolean {
  return /^[A-Z][A-Za-z0-9]{0,79}$/.test(value);
}

function isNonComponentFile(filename: string): boolean {
  return /\.(test|spec|stories|story|d)\.(tsx|jsx|ts|js)$/.test(filename);
}

function toPascalCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

/**
 * 检查 package.json 是否有 tailwindcss 依赖。
 */
async function hasTailwindDep(projectRoot: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(projectRoot, 'package.json'),
      'utf-8',
    );
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.tailwindcss || pkg.devDependencies?.tailwindcss,
    );
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

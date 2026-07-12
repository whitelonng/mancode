import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  PLATFORM_INSTALLERS,
  type PlatformName,
} from '../installers/registry.js';

export type InitLocale = 'zh-CN' | 'en';

export interface InitPrompter {
  confirmGenericProject(context: {
    rootDir: string;
    locale: InitLocale;
  }): Promise<boolean>;
  selectPlatforms(context: {
    locale: InitLocale;
    detected: PlatformName[];
  }): Promise<PlatformName[] | null>;
}

const ALL_PLATFORMS = Object.keys(PLATFORM_INSTALLERS) as PlatformName[];

export function detectInitLocale(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
  systemLocale: string = Intl.DateTimeFormat().resolvedOptions().locale,
): InitLocale | null {
  if (override) return parseLocale(override);
  const environmentLocale =
    environment.LC_ALL ?? environment.LC_MESSAGES ?? environment.LANG;
  return parseLocale(environmentLocale) ?? parseLocale(systemLocale) ?? 'en';
}

function parseLocale(value?: string): InitLocale | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace('_', '-');
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  return null;
}

export function parsePlatformSelection(value: string): PlatformName[] | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'all' || normalized === '全部') return [...ALL_PLATFORMS];
  const choices = normalized
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (choices.length === 0) return null;
  if (
    !choices.every((item): item is PlatformName => item in PLATFORM_INSTALLERS)
  ) {
    return null;
  }
  return [...new Set(choices)];
}

export async function detectPlatformHints(
  rootDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PlatformName[]> {
  const hints = new Set<PlatformName>();
  if (environment.CLAUDECODE || environment.CLAUDE_CODE)
    hints.add('claude-code');
  if (environment.CODEX_HOME) hints.add('codex');
  if (environment.CURSOR_TRACE_ID) hints.add('cursor');
  if (environment.COPILOT_AGENT || environment.GITHUB_COPILOT)
    hints.add('copilot');
  const exists = async (relative: string): Promise<boolean> => {
    try {
      await fs.access(path.join(rootDir, relative));
      return true;
    } catch {
      return false;
    }
  };
  if (await exists('.claude')) hints.add('claude-code');
  if (await exists('.cursor')) hints.add('cursor');
  if (await exists('.github/copilot-instructions.md')) hints.add('copilot');
  return ALL_PLATFORMS.filter((platform) => hints.has(platform));
}

export function createTerminalPrompter(): InitPrompter {
  return {
    async confirmGenericProject({ rootDir, locale }) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        if (locale === 'zh-CN') {
          console.log('当前目录没有识别到项目文件。');
          console.log(`目录：${rootDir}`);
          console.log('这是一个新项目吗？');
          console.log('[y] 初始化为通用项目');
          console.log('[n] 退出');
          const answer = await rl.question('请选择 [y/N]: ');
          return ['y', 'yes', '是'].includes(answer.trim().toLowerCase());
        }
        console.log('No project files were detected in the current directory.');
        console.log(`Directory: ${rootDir}`);
        console.log('Is this a new project?');
        console.log('[y] Initialize as a generic project');
        console.log('[n] Exit');
        const answer = await rl.question('Choose [y/N]: ');
        return ['y', 'yes'].includes(answer.trim().toLowerCase());
      } finally {
        rl.close();
      }
    },
    async selectPlatforms({ locale, detected }) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const names = ALL_PLATFORMS.map((platform, index) => {
          const suffix = detected.includes(platform)
            ? locale === 'zh-CN'
              ? '（已检测到）'
              : ' (detected)'
            : '';
          return `${index + 1}. ${PLATFORM_INSTALLERS[platform].displayName}${suffix}`;
        });
        console.log(
          locale === 'zh-CN'
            ? '\n选择要初始化的平台：'
            : '\nChoose platforms to initialize:',
        );
        console.log(names.join('\n'));
        console.log(locale === 'zh-CN' ? 'a. 全部平台' : 'a. All platforms');
        console.log(
          locale === 'zh-CN'
            ? '可输入编号（例如 1,3）或 a。'
            : 'Enter numbers (for example 1,3) or a.',
        );
        const answer = (
          await rl.question(locale === 'zh-CN' ? '选择: ' : 'Selection: ')
        )
          .trim()
          .toLowerCase();
        if (answer === 'a' || answer === 'all' || answer === '全部')
          return [...ALL_PLATFORMS];
        const indexes = answer.split(',').map((item) => Number(item.trim()));
        if (
          !indexes.length ||
          indexes.some(
            (index) =>
              !Number.isInteger(index) ||
              index < 1 ||
              index > ALL_PLATFORMS.length,
          )
        ) {
          return null;
        }
        const selected: PlatformName[] = [];
        for (const index of indexes) {
          const platform = ALL_PLATFORMS[index - 1];
          if (!platform) return null;
          selected.push(platform);
        }
        return [...new Set(selected)];
      } finally {
        rl.close();
      }
    },
  };
}

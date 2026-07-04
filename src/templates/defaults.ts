/**
 * 默认的 .mancode/config.json 内容。
 *
 * 见 docs/08-cli-spec.md §11.1
 */
export const DEFAULT_CONFIG = {
  version: '1.0.0',
  platforms: ['claude-code'],
  cliCommand: 'mancode',
  cliArgs: [],
  forceTeamMode: false,
  defaultStyle: null,
  hooks: {
    sessionStart: true,
    userPromptSubmit: true,
  },
  logging: {
    level: 'info',
    file: '.mancode/logs/hooks.log',
  },
};

/**
 * 空的 style-tokens.json（非前端项目或 matchLevel=none 时用）。
 *
 * 结构对齐 src/system/scan-aesthetics.ts 的 AestheticsTokens。
 * 审美扫描见 docs/13-scanning.md。
 */
export const EMPTY_STYLE_TOKENS = {
  version: '1.0.0',
  lastScanned: null,
  colors: {},
  fonts: {},
  components: [],
  cssVariables: {},
  uiLibrary: null,
  darkMode: null,
  matchLevel: 'none',
  sourceFiles: [],
};

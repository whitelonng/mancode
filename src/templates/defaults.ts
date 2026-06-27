/**
 * 默认的 .mancode/config.json 内容。
 *
 * 见 docs/08-cli-spec.md §11.1
 */
export const DEFAULT_CONFIG = {
  version: '1.0.0',
  platforms: ['claude-code'],
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
 * 空的 style-tokens.json（MVP-1 不扫描，留空）。
 *
 * 审美扫描在后续 step 补齐，见 docs/13-scanning.md。
 */
export const EMPTY_STYLE_TOKENS = {
  colors: {},
  fonts: {},
  spacing: {},
  components: [],
  uiLibrary: null,
  scannedAt: null,
};

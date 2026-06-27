import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAesthetics } from '../src/system/scan-aesthetics.js';

describe('scanAesthetics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-scan-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns matchLevel=none when no tailwind config and no tailwind dep', async () => {
    const result = await scanAesthetics(dir, null);
    expect(result.matchLevel).toBe('none');
    expect(result.colors).toEqual({});
    expect(result.fonts).toEqual({});
    expect(result.sourceFiles).toEqual([]);
  });

  it('returns matchLevel=low when tailwind dep exists but no config file', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { tailwindcss: '^3.4.0' },
      }),
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.matchLevel).toBe('low');
    expect(result.colors).toEqual({});
  });

  it('returns matchLevel=high when tailwind.config.js exists', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_BASIC,
      'utf-8',
    );

    const result = await scanAesthetics(dir, 'shadcn/ui');
    expect(result.matchLevel).toBe('high');
    expect(result.sourceFiles).toContain('tailwind.config.js');
    expect(result.sourceFiles).toContain('package.json');
    expect(result.uiLibrary).toBe('shadcn/ui');
  });

  it('extracts colors from theme.extend.colors', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_BASIC,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.colors).toHaveProperty('primary', '#3b82f6');
    expect(result.colors).toHaveProperty('secondary', '#8b5cf6');
    expect(result.colors).toHaveProperty('background', '#ffffff');
  });

  it('extracts fonts from theme.extend.fontFamily', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_BASIC,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.fonts.sans).toEqual(['Inter', 'system-ui', 'sans-serif']);
    expect(result.fonts.mono).toEqual(['Fira Code', 'monospace']);
  });

  it('extracts darkMode strategy', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_BASIC,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.darkMode).toBe('class');
  });

  it('handles tailwind.config.ts', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.ts'),
      TAILWIND_CONFIG_TS,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.matchLevel).toBe('high');
    expect(result.sourceFiles).toContain('tailwind.config.ts');
    expect(result.colors).toHaveProperty('brand', '#0066ff');
  });

  it('handles config with nested color objects gracefully', async () => {
    // 嵌套对象的顶层 key 被跳过，内部数字键也不泄漏到 tokens
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_NESTED,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.matchLevel).toBe('high');
    // primary 是嵌套对象，不被提取
    expect(result.colors).not.toHaveProperty('primary');
    // 嵌套对象内的数字键（500/600）不泄漏
    expect(result.colors).not.toHaveProperty('500');
    expect(result.colors).not.toHaveProperty('600');
    // background 是字符串值，被提取
    expect(result.colors).toHaveProperty('background', '#ffffff');
  });

  it('handles config without theme.extend (flat theme)', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_FLAT,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.matchLevel).toBe('high');
    expect(result.colors).toHaveProperty('accent', '#f59e0b');
  });

  it('handles empty tailwind config', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      "/** @type {import('tailwindcss').Config} */\nmodule.exports = {\n  content: [],\n};\n",
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.matchLevel).toBe('high');
    expect(result.colors).toEqual({});
    expect(result.fonts).toEqual({});
    expect(result.darkMode).toBeNull();
  });

  it('sets lastScanned to ISO timestamp', async () => {
    const result = await scanAesthetics(dir, null);
    expect(result.lastScanned).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('does not crash on non-existent project dir', async () => {
    const result = await scanAesthetics('/nonexistent/path', null);
    expect(result.matchLevel).toBe('none');
    expect(result.colors).toEqual({});
  });

  it('handles tailwind.config.cjs', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.cjs'),
      TAILWIND_CONFIG_BASIC,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.matchLevel).toBe('high');
    expect(result.sourceFiles).toContain('tailwind.config.cjs');
  });

  it('extracts from theme.extend.colors, not from other colors blocks', async () => {
    // config 里有 plugin 也定义了 colors:，但不应被提取
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_WITH_DISTRACTORS,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    expect(result.matchLevel).toBe('high');
    // 只提取 theme.extend.colors 里的值
    expect(result.colors).toHaveProperty('primary', '#3b82f6');
    // plugin 里的 colors 不应出现
    expect(result.colors).not.toHaveProperty('pluginColor');
  });

  it('prefers theme.extend.colors over theme.colors when both exist', async () => {
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_BOTH,
      'utf-8',
    );

    const result = await scanAesthetics(dir, null);
    // extend 优先
    expect(result.colors).toHaveProperty('primary', '#3b82f6');
    // theme.colors 的值不应出现（extend 优先）
    expect(result.colors).not.toHaveProperty('legacy');
  });
});

const TAILWIND_CONFIG_BASIC = `/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#3b82f6',
        secondary: '#8b5cf6',
        background: '#ffffff',
        foreground: '#0a0a0a',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
`;

const TAILWIND_CONFIG_TS = `import type { Config } from 'tailwindcss';

export default {
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        brand: '#0066ff',
      },
    },
  },
} satisfies Config;
`;

const TAILWIND_CONFIG_NESTED = `module.exports = {
  theme: {
    extend: {
      colors: {
        primary: {
          500: '#3b82f6',
          600: '#2563eb',
        },
        background: '#ffffff',
      },
    },
  },
};
`;

const TAILWIND_CONFIG_FLAT = `module.exports = {
  theme: {
    colors: {
      accent: '#f59e0b',
    },
  },
};
`;

// P2-a: 包含其他 colors: 块（模拟 plugin 配置），验证提取限定在 theme.extend.colors
const TAILWIND_CONFIG_WITH_DISTRACTORS = `module.exports = {
  theme: {
    extend: {
      colors: {
        primary: '#3b82f6',
      },
    },
  },
  plugins: [
    {
      colors: {
        pluginColor: '#ff0000',
      },
    },
  ],
};
`;

// theme.extend.colors 和 theme.colors 同时存在，extend 应优先
const TAILWIND_CONFIG_BOTH = `module.exports = {
  theme: {
    colors: {
      legacy: '#aaaaaa',
    },
    extend: {
      colors: {
        primary: '#3b82f6',
      },
    },
  },
};
`;

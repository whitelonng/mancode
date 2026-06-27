import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import {
  EXIT_NOT_INITIALIZED,
  EXIT_OK,
  refreshStyle,
} from '../src/commands/refresh-style.js';

describe('mancode refresh-style', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-refresh-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns EXIT_NOT_INITIALIZED when mancode is not initialized', async () => {
    const code = await refreshStyle(dir);
    expect(code).toBe(EXIT_NOT_INITIALIZED);
  });

  it('returns EXIT_OK on initialized project', async () => {
    await silentInit(dir);
    const code = await refreshStyle(dir);
    expect(code).toBe(EXIT_OK);
  });

  it('skips scan for non-frontend project', async () => {
    await silentInit(dir);
    // no package.json with frontend deps → hasFrontend=false
    const code = await refreshStyle(dir);
    expect(code).toBe(EXIT_OK);
  });

  it('writes scanned tokens to style-tokens.json', async () => {
    // 创建前端项目
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-frontend',
        dependencies: {
          react: '^18.0.0',
          tailwindcss: '^3.4.0',
        },
      }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG,
      'utf-8',
    );

    await silentInit(dir);
    await refreshStyle(dir);

    const tokensRaw = await readFile(
      path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
      'utf-8',
    );
    const tokens = JSON.parse(tokensRaw);
    expect(tokens.matchLevel).toBe('high');
    expect(tokens.colors).toHaveProperty('primary', '#3b82f6');
    expect(tokens.fonts.sans).toEqual(['Inter', 'system-ui', 'sans-serif']);
  });

  it('overwrites previous tokens on re-scan', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-frontend',
        dependencies: {
          react: '^18.0.0',
          tailwindcss: '^3.4.0',
        },
      }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG,
      'utf-8',
    );

    await silentInit(dir);

    // 第一次扫描
    await refreshStyle(dir);
    const tokens1 = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
        'utf-8',
      ),
    );

    // 修改 tailwind config
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      TAILWIND_CONFIG_V2,
      'utf-8',
    );

    // 第二次扫描
    await refreshStyle(dir);
    const tokens2 = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
        'utf-8',
      ),
    );

    expect(tokens1.colors).toHaveProperty('primary', '#3b82f6');
    expect(tokens2.colors).toHaveProperty('primary', '#ff0000');
    expect(tokens2.lastScanned).not.toBe(tokens1.lastScanned);
  });
});

const TAILWIND_CONFIG = `module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#3b82f6',
        secondary: '#8b5cf6',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
};
`;

const TAILWIND_CONFIG_V2 = `module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#ff0000',
        accent: '#00ff00',
      },
      fontFamily: {
        sans: ['Geist', 'sans-serif'],
      },
    },
  },
};
`;

/**
 * 静默执行 init，吞掉 stdout/stderr 噪音。
 */
async function silentInit(dir: string): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await init(dir);
    if (code !== 0) {
      throw new Error(`silentInit failed: init exited with ${code}`);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

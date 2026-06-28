import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installClaudeCode } from '../src/installers/claude-code.js';

describe('UserPromptSubmit hook context budget', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-hook-budget-'));
    await installClaudeCode(dir, { techStack: [], uiLibrary: null });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('injects all colors when there are 8 or fewer', async () => {
    await writeTokens(dir, {
      colors: {
        primary: '#111111',
        secondary: '#222222',
        accent: '#333333',
      },
    });

    const output = await runHook(dir);

    expect(output).toContain('## 审美 token 摘要');
    expect(output).toContain('Colors (前 8):');
    expect(output).toContain('primary=#111111');
    expect(output).toContain('secondary=#222222');
    expect(output).toContain('accent=#333333');
  });

  it('caps colors at the first 8 entries', async () => {
    await writeTokens(dir, {
      colors: Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [`color${i + 1}`, `#${i + 1}`]),
      ),
    });

    const output = await runHook(dir);

    expect(output).toContain('color1=#1');
    expect(output).toContain('color8=#8');
    expect(output).not.toContain('color9=#9');
    expect(output).not.toContain('color15=#15');
  });

  it('caps fonts at the first 4 entries', async () => {
    await writeTokens(dir, {
      fonts: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `font${i + 1}`,
          [`Font ${i + 1}`, 'sans-serif'],
        ]),
      ),
    });

    const output = await runHook(dir);

    expect(output).toContain('Fonts (前 4):');
    expect(output).toContain('font1=Font 1');
    expect(output).toContain('font4=Font 4');
    expect(output).not.toContain('font5=Font 5');
    expect(output).not.toContain('font6=Font 6');
  });

  it('falls back to a pointer when jq is unavailable', async () => {
    await writeTokens(dir, {
      colors: { primary: '#111111' },
      fonts: { sans: ['Inter', 'sans-serif'] },
    });

    const output = await runHook(dir, { MANCODE_DISABLE_JQ: '1' });

    expect(output).toContain('## 审美 token');
    expect(output).toContain('读取 .mancode/aesthetics/style-tokens.json');
    expect(output).not.toContain('Colors (前 8):');
  });

  it('keeps frontend hook output below the 800-token budget', async () => {
    await writeTokens(dir, {
      colors: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `veryLongColorTokenName${i + 1}`,
          `#${String(i + 1).padStart(6, '0')}`,
        ]),
      ),
      fonts: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          `veryLongFontTokenName${i + 1}`,
          [`Very Long Font Family ${i + 1}`, 'sans-serif'],
        ]),
      ),
    });

    const output = await runHook(dir);

    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThan(3200);
  });
});

async function writeTokens(
  dir: string,
  patch: {
    colors?: Record<string, string>;
    fonts?: Record<string, string[]>;
  },
): Promise<void> {
  const tokens = {
    version: '1.0',
    lastScanned: '2026-06-28T00:00:00.000Z',
    colors: patch.colors ?? {},
    fonts: patch.fonts ?? {},
    uiLibrary: 'Tailwind CSS',
    darkMode: 'class',
    matchLevel: 'high',
    sourceFiles: ['tailwind.config.js'],
  };
  await writeFile(
    path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
    `${JSON.stringify(tokens, null, 2)}\n`,
    'utf-8',
  );
}

function runHook(dir: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/bash',
      [path.join(dir, '.mancode', 'hooks', 'user-prompt-submit.sh')],
      {
        cwd: dir,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`hook exited with ${code}: ${stderr}`));
    });

    child.stdin.end(
      JSON.stringify({ prompt: 'design a button component with tailwind css' }),
    );
  });
}

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

  it('routes planning/research prompts to the man8 skill', async () => {
    await writeState(dir, {
      currentMode: 'solo',
      teamModeAutoDetected: false,
      contributors: 1,
    });

    const output = await runHook(
      dir,
      {},
      {
        prompt: '先别改代码，帮我看看这个项目怎么加登录功能，给我一个方案',
      },
    );

    expect(output).toContain('## mancode 自动路由');
    expect(output).toContain("skill='man8'");
    expect(output).toContain('不要直接进入 solo 实施');
  });

  it('routes English planning prompts to the man8 skill', async () => {
    await writeState(dir, {
      currentMode: 'solo',
      teamModeAutoDetected: false,
      contributors: 1,
    });

    const output = await runHook(
      dir,
      {},
      {
        prompt:
          'Do not edit files yet. Investigate the best approach for adding authentication and give me a plan.',
      },
    );

    expect(output).toContain('## mancode 自动路由');
    expect(output).toContain("skill='man8'");
  });

  it('does not route small direct edits to man8', async () => {
    await writeState(dir, {
      currentMode: 'solo',
      teamModeAutoDetected: false,
      contributors: 1,
    });

    const output = await runHook(
      dir,
      {},
      {
        prompt: '把 README 加一行 Usage',
      },
    );

    expect(output).not.toContain('## mancode 自动路由');
    expect(output).not.toContain("skill='man8'");
  });
});

describe('SessionStart hook team reminder', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-session-start-'));
    await installClaudeCode(dir, { techStack: [], uiLibrary: null });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reminds team projects to use /manteam while in solo mode', async () => {
    await writeState(dir, {
      currentMode: 'solo',
      teamModeAutoDetected: true,
      contributors: 3,
    });

    const output = await runSessionStartHook(dir);

    expect(output).toContain('### 团队协作提醒');
    expect(output).toContain('contributors: 3');
    expect(output).toContain('/manteam <task>');
  });

  it('does not show the team reminder for solo projects', async () => {
    await writeState(dir, {
      currentMode: 'solo',
      teamModeAutoDetected: false,
      contributors: 1,
    });

    const output = await runSessionStartHook(dir);

    expect(output).not.toContain('### 团队协作提醒');
    expect(output).not.toContain('/manteam <task>');
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

function runHook(
  dir: string,
  env: NodeJS.ProcessEnv = {},
  input: { prompt: string } = {
    prompt: 'design a button component with tailwind css',
  },
): Promise<string> {
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

    child.stdin.end(JSON.stringify(input));
  });
}

async function writeState(
  dir: string,
  patch: {
    currentMode: string;
    teamModeAutoDetected: boolean;
    contributors: number;
  },
): Promise<void> {
  await writeFile(
    path.join(dir, '.mancode', 'state.json'),
    `${JSON.stringify(
      {
        version: '0.1.0-alpha.1',
        currentMode: patch.currentMode,
        lastMode: 'solo',
        platform: 'claude-code',
        initializedAt: '2026-06-28T00:00:00.000Z',
        techStack: 'Unknown',
        uiLibrary: 'None',
        currentTask: null,
        currentWorkflowMode: null,
        skippedSteps: [],
        teamModeAutoDetected: patch.teamModeAutoDetected,
        contributors: patch.contributors,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

function runSessionStartHook(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/bash',
      [path.join(dir, '.mancode', 'hooks', 'session-start.sh')],
      {
        cwd: dir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
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
  });
}

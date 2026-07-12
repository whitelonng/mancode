import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_INIT_FAILED,
  EXIT_NOT_A_PROJECT_DIR,
  EXIT_OK,
  init,
} from '../src/commands/init.js';
import {
  EXIT_CORRUPT_STATE as EXIT_REFRESH_CORRUPT_STATE,
  EXIT_REFRESH_FAILED,
  refreshProject,
} from '../src/commands/refresh-project.js';
import type { InitPrompter } from '../src/system/init-onboarding.js';
import {
  detectInitLocale,
  detectNativeSystemLocale,
  parsePlatformSelection,
} from '../src/system/init-onboarding.js';

describe('init onboarding', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('uses an explicit locale override before automatic detection', () => {
    expect(
      detectInitLocale('en', { LANG: 'zh_CN.UTF-8' }, 'zh-CN', 'zh-CN'),
    ).toBe('en');
    expect(detectInitLocale('fr', {})).toBeNull();
  });

  it('prefers the macOS UI language when the terminal locale is C.UTF-8', () => {
    expect(
      detectInitLocale(
        undefined,
        { LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
        'en-US',
        'zh-Hans-CN',
      ),
    ).toBe('zh-CN');
  });

  it('uses Linux locale variables and treats C/POSIX as unknown', () => {
    expect(
      detectInitLocale(
        undefined,
        { LANGUAGE: 'zh_CN:en_US', LANG: 'en_US.UTF-8' },
        'en-US',
        null,
      ),
    ).toBe('zh-CN');
    expect(
      detectInitLocale(
        undefined,
        { LC_MESSAGES: 'zh_CN.UTF-8' },
        'en-US',
        null,
      ),
    ).toBe('zh-CN');
    expect(
      detectInitLocale(undefined, { LANG: 'zh_CN.UTF-8' }, 'en-US', null),
    ).toBe('zh-CN');
    expect(
      detectInitLocale(
        undefined,
        { LC_ALL: 'POSIX', LANG: 'C.UTF-8' },
        'zh-CN',
        null,
      ),
    ).toBe('zh-CN');
  });

  it('reads the primary macOS Apple language', () => {
    const locale = detectNativeSystemLocale('darwin', (command, args) => {
      expect(command).toBe('defaults');
      expect(args).toEqual(['read', '-g', 'AppleLanguages']);
      return '(\n    "zh-Hans-CN",\n    "en-CN"\n)';
    });

    expect(locale).toBe('zh-Hans-CN');
  });

  it('falls back to the macOS Apple locale', () => {
    const locale = detectNativeSystemLocale('darwin', (_command, args) =>
      args.includes('AppleLanguages') ? null : 'zh_CN',
    );

    expect(locale).toBe('zh_CN');
  });

  it('reads the Windows UI culture without a shell pipeline', () => {
    const locale = detectNativeSystemLocale('win32', (command, args) => {
      expect(command).toBe('powershell.exe');
      expect(args).toContain(
        '[System.Globalization.CultureInfo]::CurrentUICulture.Name',
      );
      return '\uFEFFzh-CN\r\n';
    });

    expect(locale).toBe('zh-CN');
  });

  it('keeps English init output consistently English', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-locale-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.git'));

    const logs = await captureOutput(() =>
      init(dir, { platform: 'codex', lang: 'en' }),
    );

    expect(logs).toContain('Checking system dependencies');
    expect(logs).toContain('Installing Codex');
    expect(logs).not.toMatch(/检测|安装|项目状态|扫描|适配/);
  });

  it('accepts comma-separated adapters and the all shorthand', () => {
    expect(parsePlatformSelection('codex, cursor,codex')).toEqual([
      'codex',
      'cursor',
    ]);
    expect(parsePlatformSelection('all')).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'copilot',
      'zcode',
    ]);
    expect(parsePlatformSelection('unknown')).toBeNull();
  });

  it('initializes a safe empty directory after an explicit confirmation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-generic-'));
    dirs.push(dir);
    const prompt: InitPrompter = {
      confirmGenericProject: async () => true,
      selectPlatforms: async () => ['codex', 'cursor'],
    };

    expect(await init(dir, { interactive: true, prompter: prompt })).toBe(
      EXIT_OK,
    );
    const state = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(state.projectMode).toBe('generic');
    expect(state.platform).toBe('codex');
    expect(config.platforms).toEqual(['codex', 'cursor']);
  });

  it('force reinstalls an initialized generic project without project markers', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-generic-force-'));
    dirs.push(dir);
    expect(await init(dir, { empty: true, platform: 'codex' })).toBe(EXIT_OK);
    await writeFile(path.join(dir, 'notes.txt'), 'user content\n');

    expect(await init(dir, { force: true })).toBe(EXIT_OK);
    const state = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    expect(state.projectMode).toBe('generic');
    await expect(readFile(path.join(dir, 'notes.txt'), 'utf-8')).resolves.toBe(
      'user content\n',
    );
  });

  it('refuses force reinstallation in home even when state.json exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-fake-home-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.mancode'));
    await writeFile(path.join(dir, '.mancode', 'state.json'), '{}\n');
    await writeFile(path.join(dir, 'notes.txt'), 'user content\n');
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(dir);

    try {
      expect(await init(dir, { force: true, platform: 'codex' })).toBe(
        EXIT_NOT_A_PROJECT_DIR,
      );
    } finally {
      homedir.mockRestore();
    }
    await expect(readFile(path.join(dir, 'notes.txt'), 'utf-8')).resolves.toBe(
      'user content\n',
    );
  });

  it('uses the single detected platform as primary when all are selected', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-primary-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.git'));
    await mkdir(path.join(dir, '.cursor'));

    expect(await init(dir, { platform: 'all' })).toBe(EXIT_OK);
    const state = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    expect(state.platform).toBe('cursor');
  });

  it('ignores malformed files owned by an unselected platform', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-isolation-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.git'));
    await mkdir(path.join(dir, '.claude', 'settings.json'), {
      recursive: true,
    });

    expect(await init(dir, { platform: 'codex' })).toBe(EXIT_OK);
    await expect(
      readFile(path.join(dir, 'AGENTS.md'), 'utf-8'),
    ).resolves.toContain('Platform adapter: Codex');
  });

  it('does not initialize an empty directory in non-interactive mode without --empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-generic-'));
    dirs.push(dir);
    expect(await init(dir, { interactive: false, platform: 'codex' })).toBe(
      EXIT_NOT_A_PROJECT_DIR,
    );
  });

  it('requires a platform for a non-interactive CLI when no agent is detected', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-cli-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.git'));
    expect(await init(dir, { interactive: false })).toBe(EXIT_INIT_FAILED);
  });

  it('does not let --yes silently choose an adapter in a CLI', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-cli-yes-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.git'));
    expect(await init(dir, { interactive: false, yes: true })).toBe(
      EXIT_INIT_FAILED,
    );
  });

  it('refreshes a generic project after Git and a manifest are added', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-refresh-'));
    dirs.push(dir);
    expect(await init(dir, { empty: true, platform: 'codex' })).toBe(EXIT_OK);
    await mkdir(path.join(dir, '.git'));
    await writeFile(
      path.join(dir, 'package.json'),
      '{"name":"later-project"}\n',
    );
    expect(await refreshProject(dir)).toBe(EXIT_OK);
    const state = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    expect(state.projectMode).toBe('detected');
  });

  it('regenerates installed static adapters with refreshed project facts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-refresh-static-'));
    dirs.push(dir);
    expect(await init(dir, { empty: true, platform: 'codex' })).toBe(EXIT_OK);
    const agentsPath = path.join(dir, 'AGENTS.md');
    const before = await readFile(agentsPath, 'utf-8');
    await writeFile(
      path.join(dir, 'package.json'),
      '{"name":"app","dependencies":{"react":"latest"}}\n',
    );

    expect(await refreshProject(dir)).toBe(EXIT_OK);
    const after = await readFile(agentsPath, 'utf-8');
    expect(after).not.toBe(before);
    expect(after).toContain('React');
  });

  it('refuses to overwrite a corrupt state during refresh', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-corrupt-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.mancode'));
    const statePath = path.join(dir, '.mancode', 'state.json');
    await writeFile(statePath, '{broken');

    expect(await refreshProject(dir)).toBe(EXIT_REFRESH_CORRUPT_STATE);
    expect(await readFile(statePath, 'utf-8')).toBe('{broken');
  });

  it('keeps state intact when another refresh target cannot be written', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-refresh-write-'));
    dirs.push(dir);
    expect(await init(dir, { empty: true, platform: 'codex' })).toBe(EXIT_OK);
    const statePath = path.join(dir, '.mancode', 'state.json');
    const stateBefore = await readFile(statePath, 'utf-8');
    const profilePath = path.join(dir, '.mancode', 'project-profile.json');
    await rm(profilePath);
    await mkdir(profilePath);
    await writeFile(path.join(dir, 'package.json'), '{"name":"app"}\n');

    expect(await refreshProject(dir)).toBe(EXIT_REFRESH_FAILED);
    expect(await readFile(statePath, 'utf-8')).toBe(stateBefore);
  });

  it('preserves an explicit --no-team choice during refresh', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-no-team-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.git'));
    expect(await init(dir, { platform: 'codex', team: false })).toBe(EXIT_OK);
    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.teamMode).toBe('off');

    const statePath = path.join(dir, '.mancode', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    state.teamModeAutoDetected = true;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    expect(await refreshProject(dir)).toBe(EXIT_OK);
    const refreshed = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(refreshed.teamModeAutoDetected).toBe(false);
  });

  it('rolls back earlier adapters when a later adapter fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-rollback-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.git'));
    const customRule = path.join(
      dir,
      '.cursor',
      'rules',
      'mancode-context.mdc',
    );
    await mkdir(path.dirname(customRule), { recursive: true });
    await writeFile(customRule, 'user rule\n');

    expect(await init(dir, { platform: 'codex,cursor' })).toBe(
      EXIT_INIT_FAILED,
    );
    await expect(
      readFile(path.join(dir, 'AGENTS.md'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    ).rejects.toThrow();
    await expect(readdir(path.join(dir, '.mancode'))).rejects.toThrow();
    await expect(readdir(path.join(dir, '.agents'))).rejects.toThrow();
    await expect(readFile(customRule, 'utf-8')).resolves.toBe('user rule\n');
  });
});

async function captureOutput(fn: () => Promise<unknown>): Promise<string> {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join('\n');
}

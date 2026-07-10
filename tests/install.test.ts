import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import {
  EXIT_INSTALL_FAILED,
  EXIT_NOT_INITIALIZED,
  EXIT_OK,
  EXIT_UNSUPPORTED_PLATFORM,
  install,
} from '../src/commands/install.js';
import { DEFAULT_CONFIG } from '../src/templates/defaults.js';

describe('mancode install', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-install-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns EXIT_NOT_INITIALIZED when mancode is not initialized', async () => {
    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_NOT_INITIALIZED);
  });

  it('returns EXIT_OK when installing claude-code on initialized project', async () => {
    await silentInit(dir);
    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_OK);
  });

  it('reinstalls hooks and skills with --force', async () => {
    await silentInit(dir);

    // 删掉一个 hook 文件
    await rm(path.join(dir, '.mancode', 'hooks', 'session-start.sh'), {
      force: true,
    });

    const code = await install(dir, 'claude-code', { force: true });
    expect(code).toBe(EXIT_OK);

    // hook 文件应该恢复
    const hookPath = path.join(dir, '.mancode', 'hooks', 'session-start.sh');
    const content = await readFile(hookPath, 'utf-8');
    expect(content).toContain('mancode');
    await expect(
      readFile(
        path.join(dir, '.claude', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toContain('Managed by mancode:claude-skill');
    await expect(
      readFile(path.join(dir, '.claude', 'agents', 'scout.md'), 'utf-8'),
    ).resolves.toContain('Managed by mancode:claude-agent');
  });

  it('force install refuses to overwrite user-authored same-name Claude files', async () => {
    await silentInit(dir);
    const skillPath = path.join(dir, '.claude', 'skills', 'mamba', 'SKILL.md');
    const agentPath = path.join(dir, '.claude', 'agents', 'scout.md');
    await writeFile(skillPath, '# custom mamba\n', 'utf-8');
    await writeFile(agentPath, '# custom scout\n', 'utf-8');

    const code = await install(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_INSTALL_FAILED);
    await expect(readFile(skillPath, 'utf-8')).resolves.toBe(
      '# custom mamba\n',
    );
    await expect(readFile(agentPath, 'utf-8')).resolves.toBe(
      '# custom scout\n',
    );
  });

  it('preserves a user-authored legacy Claude man8 skill during upgrade', async () => {
    await silentInit(dir);
    const legacyDir = path.join(dir, '.claude', 'skills', 'man8');
    await mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'SKILL.md');
    await writeFile(
      legacyPath,
      '---\nname: man8\n---\n\n# mancode custom workflow\n',
      'utf-8',
    );

    const code = await install(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_OK);
    await expect(readFile(legacyPath, 'utf-8')).resolves.toContain(
      '# mancode custom workflow',
    );
  });

  it('install --minimal --force keeps only solo skill and removes only mancode agents', async () => {
    await silentInit(dir);
    const customAgentPath = path.join(dir, '.claude', 'agents', 'custom.md');
    await writeFile(customAgentPath, '# custom agent\n', 'utf-8');

    expect(
      await pathExists(
        path.join(dir, '.claude', 'skills', 'mamba', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      await pathExists(path.join(dir, '.claude', 'agents', 'scout.md')),
    ).toBe(true);

    const code = await install(dir, 'claude-code', {
      force: true,
      minimal: true,
    });

    expect(code).toBe(EXIT_OK);
    expect(
      await pathExists(path.join(dir, '.claude', 'skills', 'solo', 'SKILL.md')),
    ).toBe(true);
    expect(await pathExists(path.join(dir, '.claude', 'skills', 'mamba'))).toBe(
      false,
    );
    expect(
      await pathExists(path.join(dir, '.claude', 'skills', 'manteam')),
    ).toBe(false);
    expect(
      await pathExists(path.join(dir, '.claude', 'agents', 'scout.md')),
    ).toBe(false);
    expect(await readFile(customAgentPath, 'utf-8')).toBe('# custom agent\n');
  });

  it('install --minimal switches an already-ready adapter without --force', async () => {
    await silentInit(dir);

    const code = await install(dir, 'claude-code', { minimal: true });

    expect(code).toBe(EXIT_OK);
    expect(
      await pathExists(path.join(dir, '.claude', 'skills', 'solo', 'SKILL.md')),
    ).toBe(true);
    expect(await pathExists(path.join(dir, '.claude', 'skills', 'mamba'))).toBe(
      false,
    );
    expect(
      await pathExists(path.join(dir, '.claude', 'agents', 'scout.md')),
    ).toBe(false);
  });

  it('minimal install preserves user-authored same-name Claude files', async () => {
    await silentInit(dir);
    const skillPath = path.join(dir, '.claude', 'skills', 'mamba', 'SKILL.md');
    const agentPath = path.join(dir, '.claude', 'agents', 'scout.md');
    await writeFile(skillPath, '# custom mamba\n', 'utf-8');
    await writeFile(agentPath, '# custom scout\n', 'utf-8');

    const code = await install(dir, 'claude-code', { minimal: true });

    expect(code).toBe(EXIT_OK);
    await expect(readFile(skillPath, 'utf-8')).resolves.toBe(
      '# custom mamba\n',
    );
    await expect(readFile(agentPath, 'utf-8')).resolves.toBe(
      '# custom scout\n',
    );
  });

  it('preserves raw user hooks from legacy object-mapped settings', async () => {
    await silentInit(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: {
              userLegacyHook: {
                type: 'command',
                command: 'echo user legacy hook',
              },
              oldMancodeHook: {
                type: 'command',
                command: 'bash .mancode/hooks/session-start.sh',
              },
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const code = await install(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_OK);
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    const commands = settings.hooks.SessionStart.flatMap(
      (group: { hooks?: { command?: string }[] }) =>
        group.hooks?.map((hook) => hook.command) ?? [],
    );
    expect(commands).toContain('echo user legacy hook');
    expect(
      commands.filter(
        (command: string) => command === 'bash .mancode/hooks/session-start.sh',
      ),
    ).toHaveLength(1);
  });

  it('preserves raw user hook arrays from legacy object-mapped settings', async () => {
    await silentInit(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: {
              legacyArray: [
                {
                  type: 'command',
                  command: 'echo array user hook',
                },
                {
                  type: 'command',
                  command: 'bash .mancode/hooks/session-start.sh',
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const code = await install(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_OK);
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    const commands = settings.hooks.SessionStart.flatMap(
      (group: { hooks?: { command?: string }[] }) =>
        group.hooks?.map((hook) => hook.command) ?? [],
    );
    expect(commands).toContain('echo array user hook');
    expect(
      commands.filter(
        (command: string) => command === 'bash .mancode/hooks/session-start.sh',
      ),
    ).toHaveLength(1);
  });

  it('removes only exact legacy mancode skill mappings from Claude settings', async () => {
    await silentInit(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {},
          skills: {
            solo: '.claude/skills/custom-solo.md',
            man: '.claude/skills/mancode-man.md',
            custom: '.claude/skills/custom.md',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const code = await install(dir, 'claude-code', { force: true });
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));

    expect(code).toBe(EXIT_OK);
    expect(settings.skills).toEqual({
      solo: '.claude/skills/custom-solo.md',
      custom: '.claude/skills/custom.md',
    });
  });

  it('auto-repair without --force preserves user-customized skills', async () => {
    await silentInit(dir);

    // User customizes a skill
    const mambaPath = path.join(dir, '.claude', 'skills', 'mamba', 'SKILL.md');
    const customContent = '# Custom mamba skill\n\nUser customizations here.\n';
    await writeFile(mambaPath, customContent, 'utf-8');

    // Break readiness by deleting settings.json
    await rm(path.join(dir, '.claude', 'settings.json'), { force: true });

    // Auto-repair without --force
    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_OK);

    // settings.json should be restored (hooks registered)
    const settings = JSON.parse(
      await readFile(path.join(dir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.hooks.SessionStart).toBeDefined();

    // User-customized skill should be preserved (not overwritten)
    const mambaContent = await readFile(mambaPath, 'utf-8');
    expect(mambaContent).toBe(customContent);
  });

  it('returns EXIT_OK when already installed (idempotent, no --force)', async () => {
    await silentInit(dir);
    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_OK);
  });

  it('returns EXIT_UNSUPPORTED_PLATFORM for unknown platform', async () => {
    await silentInit(dir);
    const code = await install(dir, 'unknown-platform');
    expect(code).toBe(EXIT_UNSUPPORTED_PLATFORM);
  });

  it('updates config.json platforms on install', async () => {
    await silentInit(dir);

    // 清空 config.json 的 platforms
    await writeFile(
      path.join(dir, '.mancode', 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, platforms: [] }, null, 2),
      'utf-8',
    );

    await install(dir, 'claude-code');

    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.platforms).toContain('claude-code');
  });

  it('does not duplicate platform in config.json on repeat install', async () => {
    await silentInit(dir);

    await install(dir, 'claude-code');
    await install(dir, 'claude-code', { force: true });

    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    const count = config.platforms.filter(
      (p: string) => p === 'claude-code',
    ).length;
    expect(count).toBe(1);
  });

  it('default platform is claude-code when none specified', async () => {
    await silentInit(dir);

    // install without explicit platform name
    const code = await install(dir);
    expect(code).toBe(EXIT_OK);

    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.platforms).toContain('claude-code');
  });

  it('handles missing config.json gracefully', async () => {
    await silentInit(dir);

    // 删除 config.json
    await rm(path.join(dir, '.mancode', 'config.json'), { force: true });

    const code = await install(dir, 'claude-code');
    expect(code).toBe(EXIT_OK);

    // config.json 应该被重建
    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.platforms).toContain('claude-code');
    expect(config.forceTeamMode).toBe(false);
    expect(config.defaultStyle).toBeNull();
    expect(config.hooks).toEqual(DEFAULT_CONFIG.hooks);
    expect(config.logging).toEqual(DEFAULT_CONFIG.logging);
  });

  it('rebuilds missing config.json from the initialized platform', async () => {
    await silentInit(dir, { platform: 'codex' });

    await rm(path.join(dir, '.mancode', 'config.json'), { force: true });

    const code = await install(dir, 'cursor');
    expect(code).toBe(EXIT_OK);

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).toEqual(['codex', 'cursor']);
  });

  it('does not overwrite corrupt config.json', async () => {
    await silentInit(dir, { platform: 'codex' });
    const configPath = path.join(dir, '.mancode', 'config.json');
    const corruptConfig = '{ invalid config';
    await writeFile(configPath, corruptConfig, 'utf-8');

    const code = await install(dir, 'cursor');

    expect(code).toBe(EXIT_INSTALL_FAILED);
    expect(await readFile(configPath, 'utf-8')).toBe(corruptConfig);
  });

  it('repairs a recorded adapter when generated files are missing', async () => {
    await silentInit(dir, { platform: 'codex' });
    const agentsPath = path.join(dir, 'AGENTS.md');
    await rm(agentsPath, { force: true });

    const code = await install(dir, 'codex');

    expect(code).toBe(EXIT_OK);
    await expect(readFile(agentsPath, 'utf-8')).resolves.toContain(
      'Platform adapter: Codex CLI',
    );
  });

  it('repairs a minimal adapter without silently upgrading it to full', async () => {
    await silentInit(dir);
    await install(dir, 'codex', { minimal: true });
    await rm(path.join(dir, 'AGENTS.md'));

    const code = await install(dir, 'codex');
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );

    expect(code).toBe(EXIT_OK);
    expect(agents).toContain('mancode Practice Rules');
    expect(agents).not.toContain('mancode Modes');
    expect(config.platformOptions.codex.minimal).toBe(true);
    expect(
      await pathExists(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
      ),
    ).toBe(false);
  });

  it('generates a newly installed static adapter from the live project profile', async () => {
    await silentInit(dir);
    await writeFile(path.join(dir, 'go.mod'), 'module example\n', 'utf-8');
    await mkdir(path.join(dir, 'server'));

    const code = await install(dir, 'codex');
    const content = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');

    expect(code).toBe(EXIT_OK);
    expect(content).toContain('Tech stack: Go + Go modules');
    expect(content).toContain(
      'Project profile: backend; validation: go test ./...',
    );
    expect(content).not.toContain('Tech stack: Unknown');
  });

  it('preserves configured team/style options on forced reinstall', async () => {
    await silentInit(dir, { team: true, style: 'brutalist' });

    const code = await install(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_OK);
    const configRaw = await readFile(
      path.join(dir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(configRaw);
    expect(config.platforms).toContain('claude-code');
    expect(config.forceTeamMode).toBe(true);
    expect(config.defaultStyle).toBe('brutalist');
    expect(config.hooks).toEqual(DEFAULT_CONFIG.hooks);
    expect(config.logging).toEqual(DEFAULT_CONFIG.logging);
  });

  it('--force does not wipe scanned style-tokens.json', async () => {
    // 创建前端项目 + tailwind config
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        dependencies: {
          react: '^18.0.0',
          tailwindcss: '^3.4.0',
        },
      }),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'tailwind.config.js'),
      `module.exports = {
  theme: {
    extend: {
      colors: { primary: '#3b82f6' },
    },
  },
};`,
      'utf-8',
    );

    // init 会扫描审美 token
    await silentInit(dir);

    // 确认 style-tokens.json 有扫描结果
    const tokensBefore = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
        'utf-8',
      ),
    );
    expect(tokensBefore.matchLevel).toBe('high');
    expect(tokensBefore.colors).toHaveProperty('primary', '#3b82f6');

    // install --force 应该恢复 hooks/skills，但不应擦除已扫描的 token
    await install(dir, 'claude-code', { force: true });

    const tokensAfter = JSON.parse(
      await readFile(
        path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
        'utf-8',
      ),
    );
    expect(tokensAfter.matchLevel).toBe('high');
    expect(tokensAfter.colors).toHaveProperty('primary', '#3b82f6');
  });

  it('fails without rewriting invalid .claude/settings.json', async () => {
    await silentInit(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const configPath = path.join(dir, '.mancode', 'config.json');
    const logPath = path.join(dir, '.mancode', 'logs', 'hooks.log');
    const hookPath = path.join(dir, '.mancode', 'hooks', 'session-start.sh');
    const skillPath = path.join(dir, '.claude', 'skills', 'mamba', 'SKILL.md');
    const agentPath = path.join(dir, '.claude', 'agents', 'scout.md');
    const invalidSettings = '{ invalid json';
    const existingConfig = {
      ...DEFAULT_CONFIG,
      platforms: ['claude-code'],
      forceTeamMode: true,
      defaultStyle: 'brutalist',
    };
    await writeFile(settingsPath, invalidSettings, 'utf-8');
    await writeFile(
      configPath,
      JSON.stringify(existingConfig, null, 2),
      'utf-8',
    );
    await writeFile(logPath, 'existing log\n', 'utf-8');
    await writeFile(hookPath, 'existing hook\n', 'utf-8');
    await writeFile(skillPath, 'existing skill\n', 'utf-8');
    await writeFile(agentPath, 'existing agent\n', 'utf-8');

    const code = await install(dir, 'claude-code', { force: true });

    expect(code).not.toBe(EXIT_OK);
    expect(await readFile(settingsPath, 'utf-8')).toBe(invalidSettings);
    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toEqual(
      existingConfig,
    );
    expect(await readFile(logPath, 'utf-8')).toBe('existing log\n');
    expect(await readFile(hookPath, 'utf-8')).toBe('existing hook\n');
    expect(await readFile(skillPath, 'utf-8')).toBe('existing skill\n');
    expect(await readFile(agentPath, 'utf-8')).toBe('existing agent\n');
  });
});

/**
 * 静默执行 init，吞掉 init 的 stdout/stderr 噪音。
 */
async function silentInit(
  dir: string,
  options: Parameters<typeof init>[1] = {},
): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await init(dir, options);
    if (code !== 0) {
      throw new Error(`silentInit failed: init exited with ${code}`);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

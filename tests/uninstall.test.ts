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
import { install } from '../src/commands/install.js';
import {
  EXIT_NOT_INITIALIZED,
  EXIT_OK,
  EXIT_UNSUPPORTED_PLATFORM,
  uninstall,
} from '../src/commands/uninstall.js';

describe('mancode uninstall', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-uninstall-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns EXIT_NOT_INITIALIZED when mancode is not initialized', async () => {
    const code = await uninstall(dir, 'claude-code', { force: true });
    expect(code).toBe(EXIT_NOT_INITIALIZED);
  });

  it('returns EXIT_UNSUPPORTED_PLATFORM for unknown platform', async () => {
    await silentInit(dir);
    const code = await uninstall(dir, 'unknown', { force: true });
    expect(code).toBe(EXIT_UNSUPPORTED_PLATFORM);
  });

  it('removes Codex managed block while preserving user AGENTS.md content', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      '# My Project\n\nKeep this.\n\n<!-- mancode:start -->\nmanaged\n<!-- mancode:end -->\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'codex', { force: true });
    expect(code).toBe(EXIT_OK);

    const content = await readFile(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('Keep this.');
    expect(content).not.toContain('<!-- mancode:start -->');
    expect(content).not.toContain('<!-- mancode:end -->');
  });

  it('removes Codex managed block and deletes AGENTS.md if only mancode content', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    const code = await uninstall(dir, 'codex', { force: true });
    expect(code).toBe(EXIT_OK);

    await expect(
      readFile(path.join(dir, 'AGENTS.md'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('removes Cursor rules while preserving custom rules', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');
    const rulesDir = path.join(dir, '.cursor', 'rules');
    await writeFile(path.join(rulesDir, 'custom.mdc'), '# custom\n', 'utf-8');
    await writeFile(
      path.join(rulesDir, 'mancode-man8.mdc'),
      '# mancode man8 — Investigate and Plan\n\n## Mode Persistence\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'cursor', { force: true });
    expect(code).toBe(EXIT_OK);

    expect(await readFile(path.join(rulesDir, 'custom.mdc'), 'utf-8')).toBe(
      '# custom\n',
    );
    await expect(
      readFile(path.join(rulesDir, 'mancode-man8.mdc'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(rulesDir, 'mancode-solo.mdc'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(rulesDir, 'mancode-context.mdc'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('preserves a user-authored legacy Cursor rule on uninstall', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');
    const legacyPath = path.join(dir, '.cursor', 'rules', 'mancode-man8.mdc');
    await writeFile(legacyPath, '# user-authored legacy rule\n', 'utf-8');

    await uninstall(dir, 'cursor', { force: true });

    await expect(readFile(legacyPath, 'utf-8')).resolves.toBe(
      '# user-authored legacy rule\n',
    );
  });

  it('preserves a user-authored same-name current Cursor rule on uninstall', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');
    const customPath = path.join(dir, '.cursor', 'rules', 'mancode-solo.mdc');
    await writeFile(customPath, '# custom solo rule\n', 'utf-8');

    await uninstall(dir, 'cursor', { force: true });

    await expect(readFile(customPath, 'utf-8')).resolves.toBe(
      '# custom solo rule\n',
    );
  });

  it('removes Cursor .cursor/commands/ on uninstall', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');

    const code = await uninstall(dir, 'cursor', { force: true });
    expect(code).toBe(EXIT_OK);

    await expect(
      readFile(path.join(dir, '.cursor', 'commands', 'mamba.md'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, '.cursor', 'commands', 'mansolo.md'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('removes Codex .agents/skills/ on uninstall', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    const code = await uninstall(dir, 'codex', { force: true });
    expect(code).toBe(EXIT_OK);

    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mansolo', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('uninstall preserves user-authored same-name Codex skills', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await writeFile(
      path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
      '# custom mamba\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'codex', { force: true });

    expect(code).toBe(EXIT_OK);
    await expect(
      readFile(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toBe('# custom mamba\n');
  });

  it('also removes legacy .codex/skills/ managed files from pre-fix versions', async () => {
    await silentInit(dir);
    // Simulate a pre-fix install that wrote managed skills to .codex/skills/.
    await mkdir(path.join(dir, '.codex', 'skills', 'mamba'), {
      recursive: true,
    });
    await writeFile(
      path.join(dir, '.codex', 'skills', 'mamba', 'SKILL.md'),
      [
        '---',
        'name: mamba',
        'description: "legacy"',
        '---',
        '',
        '<!-- Managed by mancode:codex-skill. Do not edit this file manually. -->',
        '',
        'legacy content',
      ].join('\n'),
      'utf-8',
    );

    const code = await uninstall(dir, 'codex', { force: true });
    expect(code).toBe(EXIT_OK);

    await expect(
      readFile(
        path.join(dir, '.codex', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it.each([
    ['codex', 'zcode'],
    ['zcode', 'codex'],
  ] as const)(
    'handles shared skills safely when %s is installed before %s',
    async (first, second) => {
      await silentInit(dir);
      await install(dir, first);
      await install(dir, second);
      const skillPath = path.join(
        dir,
        '.agents',
        'skills',
        'mamba',
        'SKILL.md',
      );

      await uninstall(dir, second, { force: true });
      await expect(readFile(skillPath, 'utf-8')).resolves.toContain(
        'Managed by mancode:',
      );

      await uninstall(dir, first, { force: true });
      await expect(readFile(skillPath, 'utf-8')).rejects.toThrow();
    },
  );

  it('does not let one minimal adapter delete shared skills needed by its peer', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'zcode');

    await install(dir, 'zcode', { force: true, minimal: true });

    const skillPath = path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md');
    await expect(readFile(skillPath, 'utf-8')).resolves.toContain(
      'Managed by mancode:zcode-skill',
    );

    await uninstall(dir, 'codex', { force: true });
    await expect(readFile(skillPath, 'utf-8')).rejects.toThrow();
  });

  it('removes Copilot .github/prompts/ on uninstall', async () => {
    await silentInit(dir);
    await install(dir, 'copilot');

    const code = await uninstall(dir, 'copilot', { force: true });
    expect(code).toBe(EXIT_OK);

    await expect(
      readFile(
        path.join(dir, '.github', 'prompts', 'mamba.prompt.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(dir, '.github', 'prompts', 'mansolo.prompt.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('removes Copilot managed block while preserving user instructions', async () => {
    await silentInit(dir);
    await install(dir, 'copilot');
    const instructionsPath = path.join(
      dir,
      '.github',
      'copilot-instructions.md',
    );
    await writeFile(
      instructionsPath,
      '# My Instructions\n\nKeep.\n\n<!-- mancode:start -->\nmanaged\n<!-- mancode:end -->\n',
      'utf-8',
    );

    const code = await uninstall(dir, 'copilot', { force: true });
    expect(code).toBe(EXIT_OK);

    const content = await readFile(instructionsPath, 'utf-8');
    expect(content).toContain('Keep.');
    expect(content).not.toContain('<!-- mancode:start -->');
  });

  it('removes Claude Code skills and agents while preserving custom agents', async () => {
    await silentInit(dir);
    const customAgentPath = path.join(dir, '.claude', 'agents', 'custom.md');
    await writeFile(customAgentPath, '# custom agent\n', 'utf-8');

    const code = await uninstall(dir, 'claude-code', { force: true });
    expect(code).toBe(EXIT_OK);

    expect(await pathExists(path.join(dir, '.claude', 'skills', 'solo'))).toBe(
      false,
    );
    expect(
      await pathExists(path.join(dir, '.claude', 'agents', 'scout.md')),
    ).toBe(false);
    expect(await readFile(customAgentPath, 'utf-8')).toBe('# custom agent\n');
    await expect(
      readFile(
        path.join(dir, '.claude', 'skills', 'mamba', 'SKILL.md'),
        'utf-8',
      ),
    ).rejects.toThrow();
  });

  it('preserves user-authored same-name Claude skills and agents', async () => {
    await silentInit(dir);
    const skillPath = path.join(dir, '.claude', 'skills', 'mamba', 'SKILL.md');
    const agentPath = path.join(dir, '.claude', 'agents', 'scout.md');
    await writeFile(skillPath, '# custom mamba\n', 'utf-8');
    await writeFile(agentPath, '# custom scout\n', 'utf-8');

    const code = await uninstall(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_OK);
    await expect(readFile(skillPath, 'utf-8')).resolves.toBe(
      '# custom mamba\n',
    );
    await expect(readFile(agentPath, 'utf-8')).resolves.toBe(
      '# custom scout\n',
    );
  });

  it('cleans mancode hooks from .claude/settings.json but preserves user hooks', async () => {
    await silentInit(dir);

    const code = await uninstall(dir, 'claude-code', { force: true });
    expect(code).toBe(EXIT_OK);

    const settings = JSON.parse(
      await readFile(path.join(dir, '.claude', 'settings.json'), 'utf-8'),
    );
    const hookEvents = Object.keys(settings.hooks ?? {});
    for (const event of hookEvents) {
      const groups = settings.hooks[event];
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!group?.hooks) continue;
        for (const hook of group.hooks) {
          expect(hook.command).not.toContain('.mancode/hooks/');
        }
      }
    }
  });

  it('removes only mancode hooks from mixed Claude Code matcher groups', async () => {
    await silentInit(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: 'bash .mancode/hooks/user-prompt-submit.sh',
                  },
                  {
                    type: 'command',
                    command: 'echo user hook',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const code = await uninstall(dir, 'claude-code', { force: true });

    expect(code).toBe(EXIT_OK);
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(settings.hooks.UserPromptSubmit).toEqual([
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: 'echo user hook',
          },
        ],
      },
    ]);
  });

  it('preserves user hooks stored under .mancode/hooks during uninstall', async () => {
    await silentInit(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    settings.hooks.SessionStart.unshift({
      hooks: [
        {
          type: 'command',
          command: 'bash .mancode/hooks/custom-user-hook.sh',
        },
      ],
    });
    await writeFile(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      'utf-8',
    );

    const code = await uninstall(dir, 'claude-code', { force: true });
    const updated = JSON.parse(await readFile(settingsPath, 'utf-8'));
    const commands = updated.hooks.SessionStart.flatMap(
      (group: { hooks?: Array<{ command?: string }> }) =>
        group.hooks?.map((hook) => hook.command) ?? [],
    );

    expect(code).toBe(EXIT_OK);
    expect(commands).toEqual(['bash .mancode/hooks/custom-user-hook.sh']);
  });

  it('removes legacy object-mapped mancode hooks while preserving user entries', async () => {
    await silentInit(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: {
              mancode: {
                type: 'command',
                command: 'bash .mancode/hooks/old.sh',
              },
              user: {
                type: 'command',
                command: 'echo user hook',
              },
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const code = await uninstall(dir, 'claude-code', { force: true });
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));

    expect(code).toBe(EXIT_OK);
    expect(settings.hooks.SessionStart.mancode).toBeUndefined();
    expect(settings.hooks.SessionStart.user).toEqual([
      { type: 'command', command: 'echo user hook' },
    ]);
  });

  it('cleans exact legacy Claude skill mappings without deleting same-name user mappings', async () => {
    await silentInit(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          skills: {
            solo: '.claude/skills/mancode-solo.md',
            man: '.claude/skills/custom-man.md',
            custom: '.claude/skills/custom.md',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const code = await uninstall(dir, 'claude-code', { force: true });
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));

    expect(code).toBe(EXIT_OK);
    expect(settings.skills).toEqual({
      man: '.claude/skills/custom-man.md',
      custom: '.claude/skills/custom.md',
    });
  });

  it('updates config.json platforms after single platform uninstall', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    await uninstall(dir, 'codex', { force: true });

    const config = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'config.json'), 'utf-8'),
    );
    expect(config.platforms).not.toContain('codex');
    expect(config.platforms).toContain('claude-code');
  });

  it('removes all mancode artifacts with --all', async () => {
    await silentInit(dir);
    await install(dir, 'codex');
    await install(dir, 'cursor');
    await install(dir, 'zcode');

    const code = await uninstall(dir, undefined, {
      force: true,
      all: true,
    });
    expect(code).toBe(EXIT_OK);

    expect(await pathExists(path.join(dir, '.mancode'))).toBe(false);
    expect(await pathExists(path.join(dir, 'AGENTS.md'))).toBe(false);
    expect(
      await pathExists(path.join(dir, '.cursor', 'rules', 'mancode-solo.mdc')),
    ).toBe(false);
    expect(
      await pathExists(
        path.join(dir, '.agents', 'skills', 'mamba', 'SKILL.md'),
      ),
    ).toBe(false);
  });

  it('removes all mancode artifacts when no platform specified', async () => {
    await silentInit(dir);
    await install(dir, 'codex');

    const code = await uninstall(dir, undefined, { force: true });
    expect(code).toBe(EXIT_OK);

    expect(await pathExists(path.join(dir, '.mancode'))).toBe(false);
  });
});

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

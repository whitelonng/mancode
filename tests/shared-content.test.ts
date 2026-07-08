import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSharedContent } from '../src/installers/shared-content.js';

describe('generateSharedContent', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-shared-content-'));
    await mkdir(path.join(dir, '.mancode', 'aesthetics'), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders project context, practice rules, modes, and downgrade guidance', async () => {
    await writeState({
      currentMode: 'solo',
      techStack: 'React + TypeScript',
      uiLibrary: 'shadcn/ui',
    });

    const content = await generateSharedContent(dir, {
      platform: 'codex',
      displayName: 'Codex CLI',
      capabilities: {
        slashCommands: 'partial',
        subagents: false,
        hooks: false,
        skills: 'single-file',
      },
      techStack: [],
      uiLibrary: null,
    });

    expect(content).toContain('Platform adapter: Codex CLI');
    expect(content).toContain('Tech stack: React + TypeScript');
    expect(content).toContain('read `.mancode/state.json`');
    expect(content).toContain('read `.mancode/aesthetics/style-tokens.json`');
    expect(content).toContain('YAGNI ladder');
    expect(content).toContain('man8: investigate first');
    expect(content).toContain('Platform Downgrade');
    expect(content).toContain('Simulate the coaching staff');
  });

  it('uses provided project detection when state is missing', async () => {
    const content = await generateSharedContent(dir, {
      platform: 'cursor',
      displayName: 'Cursor',
      capabilities: {
        slashCommands: 'native',
        subagents: false,
        hooks: false,
        skills: 'rules',
      },
      techStack: ['Vue', 'TypeScript'],
      uiLibrary: 'None',
    });

    expect(content).toContain('Tech stack: Vue + TypeScript');
    expect(content).toContain('UI library: None');
  });

  it('summarizes aesthetics with caps', async () => {
    await writeTokens({
      matchLevel: 'high',
      uiLibrary: 'shadcn/ui',
      darkMode: 'class',
      colors: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `color${index}`,
          `#00000${index}`,
        ]),
      ),
      fonts: {
        sans: ['Inter', 'system-ui'],
      },
      components: Array.from({ length: 10 }, (_, index) => `Component${index}`),
      cssVariables: {
        primary: '240 10% 10%',
      },
    });

    const content = await generateSharedContent(dir, {
      platform: 'cursor',
      displayName: 'Cursor',
      capabilities: {
        slashCommands: 'native',
        subagents: false,
        hooks: false,
        skills: 'rules',
      },
      techStack: [],
      uiLibrary: null,
    });

    expect(content).toContain('Colors: color0=#000000');
    expect(content).toContain('color7=#000007');
    expect(content).not.toContain('color8=#000008');
    expect(content).toContain('Fonts: sans=Inter system-ui');
    expect(content).toContain('Components: Component0');
    expect(content).toContain('Component7');
    expect(content).not.toContain('Component8');
    expect(content).toContain('CSS variables: primary=240 10% 10%');
  });

  it('does not tell agents to prefer missing low-confidence tokens', async () => {
    await writeTokens({
      matchLevel: 'low',
      colors: {},
      fonts: {},
      components: [],
      cssVariables: {},
    });

    const content = await generateSharedContent(dir, {
      platform: 'codex',
      displayName: 'Codex CLI',
      capabilities: {
        slashCommands: 'partial',
        subagents: false,
        hooks: false,
        skills: 'single-file',
      },
      techStack: [],
      uiLibrary: null,
    });

    expect(content).toContain(
      'Match level: low. Inspect existing components manually.',
    );
    expect(content).not.toContain('prefer these tokens and components');
  });

  it('omits mode and downgrade sections for minimal output', async () => {
    const content = await generateSharedContent(dir, {
      platform: 'copilot',
      displayName: 'GitHub Copilot',
      capabilities: {
        slashCommands: 'none',
        subagents: false,
        hooks: false,
        skills: 'instructions',
      },
      minimal: true,
      techStack: ['TypeScript'],
      uiLibrary: null,
    });

    expect(content).toContain('mancode Practice Rules');
    expect(content).not.toContain('mancode Modes');
    expect(content).not.toContain('mancode Platform Downgrade');
  });

  async function writeState(value: unknown): Promise<void> {
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      `${JSON.stringify(value, null, 2)}\n`,
      'utf-8',
    );
  }

  async function writeTokens(value: unknown): Promise<void> {
    await writeFile(
      path.join(dir, '.mancode', 'aesthetics', 'style-tokens.json'),
      `${JSON.stringify(value, null, 2)}\n`,
      'utf-8',
    );
  }
});

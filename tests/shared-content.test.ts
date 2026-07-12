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
    await writeProfile({
      projectKind: 'web',
      uiAssets: 'detected',
      availableValidation: [],
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
      displayName: 'Codex (ChatGPT desktop/CLI)',
      capabilities: {
        slashCommands: 'partial',
        subagents: false,
        hooks: false,
        skills: 'single-file',
      },
      techStack: [],
      uiLibrary: null,
    });

    expect(content).toContain('Platform adapter: Codex (ChatGPT desktop/CLI)');
    expect(content).toContain('Tech stack: React + TypeScript');
    expect(content).toContain('read `.mancode/state.json`');
    expect(content).toContain('read `.mancode/aesthetics/style-tokens.json`');
    expect(content).toContain('YAGNI ladder');
    expect(content).toContain('manba: diagnose bugs');
    expect(content).toContain('Platform Downgrade');
    expect(content).toContain('Simulate the coaching staff');
    expect(content).toContain('Scout, Plan Coach, Head Coach');
  });

  it('renders the public manba name for legacy workflow state', async () => {
    await writeState({ currentMode: 'mamba' });

    const content = await generateSharedContent(dir, {
      platform: 'codex',
      displayName: 'Codex (ChatGPT desktop/CLI)',
      capabilities: {
        slashCommands: 'partial',
        subagents: false,
        hooks: false,
        skills: 'agents-skills',
      },
      techStack: [],
      uiLibrary: null,
    });

    expect(content).toContain('Current mode: manba');
    expect(content).not.toContain('Current mode: mamba');
  });

  it('uses the live install profile instead of stale persisted context', async () => {
    await writeState({
      currentMode: 'solo',
      techStack: 'JavaScript/TypeScript + React',
      uiLibrary: 'MUI',
    });
    await writeTokens({
      matchLevel: 'high',
      colors: { stale: '#123456' },
      fonts: {},
      components: [],
      cssVariables: {},
    });

    const content = await generateSharedContent(dir, {
      platform: 'codex',
      displayName: 'Codex (ChatGPT desktop/CLI)',
      capabilities: {
        slashCommands: 'partial',
        subagents: false,
        hooks: false,
        skills: 'agents-skills',
      },
      techStack: ['Go', 'Go modules'],
      uiLibrary: null,
      projectProfile: {
        projectKind: 'backend',
        languages: ['Go'],
        frameworks: ['Go modules'],
        availableValidation: ['go test ./...'],
        uiAssets: 'none',
      },
    });

    expect(content).toContain('Tech stack: Go + Go modules');
    expect(content).toContain('UI library: None');
    expect(content).toContain(
      'Project profile: backend; validation: go test ./...',
    );
    expect(content).not.toContain('JavaScript/TypeScript + React');
    expect(content).not.toContain('stale=#123456');
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
      displayName: 'Codex (ChatGPT desktop/CLI)',
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

  it('does not embed stale tokens when the project profile has no UI', async () => {
    await writeProfile({
      projectKind: 'backend',
      uiAssets: 'none',
      availableValidation: ['go test ./...'],
    });
    await writeTokens({
      matchLevel: 'high',
      colors: { stale: '#123456' },
      fonts: {},
      components: [],
      cssVariables: {},
    });

    const content = await generateSharedContent(dir, {
      platform: 'codex',
      displayName: 'Codex (ChatGPT desktop/CLI)',
      capabilities: {
        slashCommands: 'partial',
        subagents: false,
        hooks: false,
        skills: 'single-file',
      },
      techStack: [],
      uiLibrary: null,
    });

    expect(content).not.toContain('stale=#123456');
    expect(content).not.toContain('mancode Aesthetics');
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

  async function writeProfile(value: unknown): Promise<void> {
    await writeFile(
      path.join(dir, '.mancode', 'project-profile.json'),
      `${JSON.stringify(value, null, 2)}\n`,
      'utf-8',
    );
  }
});

import type { ProjectProfile } from '../system/project-profile.js';
import { installClaudeCode } from './claude-code.js';
import { installCodex } from './codex.js';
import { installCopilot } from './copilot.js';
import { installCursor } from './cursor.js';
import { installZcode } from './zcode.js';

export type PlatformName =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'copilot'
  | 'zcode';

export interface PlatformCapabilities {
  slashCommands: 'native' | 'partial' | 'none';
  subagents: boolean;
  hooks: boolean;
  skills: 'native' | 'rules' | 'single-file' | 'instructions' | 'agents-skills';
}

export interface InstallAdapterOptions {
  techStack: string[];
  uiLibrary: string | null;
  /** Live profile detected for this install. Static adapters use it instead of stale state. */
  projectProfile?: ProjectProfile;
  minimal?: boolean;
  /** --force: explicit reinstall request. When false (auto-repair), adapters should
   *  avoid overwriting user-customized files — only repair missing ones. */
  force?: boolean;
}

export interface PlatformInstaller {
  name: PlatformName;
  displayName: string;
  capabilities: PlatformCapabilities;
  install(projectRoot: string, options: InstallAdapterOptions): Promise<void>;
}

export const PLATFORM_INSTALLERS: Record<PlatformName, PlatformInstaller> = {
  'claude-code': {
    name: 'claude-code',
    displayName: 'Claude Code',
    capabilities: {
      slashCommands: 'native',
      subagents: true,
      hooks: true,
      skills: 'native',
    },
    install: installClaudeCode,
  },
  cursor: {
    name: 'cursor',
    displayName: 'Cursor',
    capabilities: {
      slashCommands: 'native',
      subagents: false,
      hooks: false,
      skills: 'rules',
    },
    install: installCursor,
  },
  codex: {
    name: 'codex',
    displayName: 'Codex (ChatGPT desktop/CLI)',
    capabilities: {
      slashCommands: 'partial',
      subagents: false,
      hooks: false,
      skills: 'agents-skills',
    },
    install: installCodex,
  },
  copilot: {
    name: 'copilot',
    displayName: 'GitHub Copilot',
    capabilities: {
      slashCommands: 'none',
      subagents: false,
      hooks: false,
      skills: 'instructions',
    },
    install: installCopilot,
  },
  zcode: {
    name: 'zcode',
    displayName: 'ZCode',
    capabilities: {
      slashCommands: 'partial',
      subagents: false,
      hooks: false,
      skills: 'agents-skills',
    },
    install: installZcode,
  },
};

export function getPlatformInstaller(
  platform: string,
): PlatformInstaller | null {
  if (!isPlatformName(platform)) return null;
  return PLATFORM_INSTALLERS[platform];
}

export function getPlatformInstallers(): PlatformInstaller[] {
  return Object.values(PLATFORM_INSTALLERS);
}

export function formatPlatformName(platform: string): string {
  return getPlatformInstaller(platform)?.displayName ?? platform;
}

function isPlatformName(platform: string): platform is PlatformName {
  return Object.prototype.hasOwnProperty.call(PLATFORM_INSTALLERS, platform);
}

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installMancodeCore, readTextIfExists } from './common.js';
import {
  DEFAULT_MANCODE_END_MARKER,
  DEFAULT_MANCODE_START_MARKER,
  replaceManagedBlock,
} from './managed-block.js';
import { installCodexSkills } from './mode-skills.js';
import type { InstallAdapterOptions } from './registry.js';
import { generateSharedContent } from './shared-content.js';

export async function installCodex(
  projectRoot: string,
  options: InstallAdapterOptions,
): Promise<void> {
  await installMancodeCore(projectRoot);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const existing = await readTextIfExists(agentsPath);
  const sharedContent = await generateSharedContent(projectRoot, {
    platform: 'codex',
    displayName: 'Codex CLI',
    capabilities: {
      slashCommands: 'partial',
      subagents: false,
      hooks: false,
      skills: 'agents-skills',
    },
    minimal: options.minimal,
    techStack: options.techStack,
    uiLibrary: options.uiLibrary,
    projectProfile: options.projectProfile,
  });

  const block = [
    DEFAULT_MANCODE_START_MARKER,
    '<!-- Managed by mancode. Do not edit this block manually. -->',
    '',
    '# mancode Configuration',
    '',
    sharedContent.trim(),
    DEFAULT_MANCODE_END_MARKER,
  ].join('\n');

  await writeFile(agentsPath, replaceManagedBlock(existing, block), 'utf-8');

  await installCodexSkills(projectRoot, options.minimal ?? false);
}

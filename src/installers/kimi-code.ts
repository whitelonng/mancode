import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installMancodeCore, readTextIfExists } from './common.js';
import { replaceManagedBlock } from './managed-block.js';
import { installKimiSkills } from './mode-skills.js';
import type { InstallAdapterOptions } from './registry.js';
import { generateSharedContent } from './shared-content.js';

export const KIMI_MANCODE_START_MARKER = '<!-- mancode:kimi-code:start -->';
export const KIMI_MANCODE_END_MARKER = '<!-- mancode:kimi-code:end -->';

export async function installKimiCode(
  projectRoot: string,
  options: InstallAdapterOptions,
): Promise<void> {
  await installMancodeCore(projectRoot);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const existing = await readTextIfExists(agentsPath);
  const sharedContent = await generateSharedContent(projectRoot, {
    platform: 'kimi-code',
    displayName: 'Kimi Code (desktop/CLI)',
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
    KIMI_MANCODE_START_MARKER,
    '<!-- Managed by mancode. Do not edit this block manually. -->',
    '',
    '# mancode Configuration',
    '',
    sharedContent.trim(),
    KIMI_MANCODE_END_MARKER,
  ].join('\n');

  await writeFile(
    agentsPath,
    replaceManagedBlock(
      existing,
      block,
      KIMI_MANCODE_START_MARKER,
      KIMI_MANCODE_END_MARKER,
    ),
    'utf-8',
  );

  await installKimiSkills(projectRoot, options.minimal ?? false);
}

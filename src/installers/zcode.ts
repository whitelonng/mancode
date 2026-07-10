import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installMancodeCore, readTextIfExists } from './common.js';
import { replaceManagedBlock } from './managed-block.js';
import { installZcodeSkills } from './mode-skills.js';
import type { InstallAdapterOptions } from './registry.js';
import { generateSharedContent } from './shared-content.js';

export const ZCODE_MANCODE_START_MARKER = '<!-- mancode:zcode:start -->';
export const ZCODE_MANCODE_END_MARKER = '<!-- mancode:zcode:end -->';

export async function installZcode(
  projectRoot: string,
  options: InstallAdapterOptions,
): Promise<void> {
  await installMancodeCore(projectRoot);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const existing = await readTextIfExists(agentsPath);
  const sharedContent = await generateSharedContent(projectRoot, {
    platform: 'zcode',
    displayName: 'ZCode',
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
    ZCODE_MANCODE_START_MARKER,
    '<!-- Managed by mancode. Do not edit this block manually. -->',
    '',
    '# mancode Configuration',
    '',
    sharedContent.trim(),
    ZCODE_MANCODE_END_MARKER,
  ].join('\n');

  await writeFile(
    agentsPath,
    replaceManagedBlock(
      existing,
      block,
      ZCODE_MANCODE_START_MARKER,
      ZCODE_MANCODE_END_MARKER,
    ),
    'utf-8',
  );

  await installZcodeSkills(projectRoot, options.minimal ?? false);
}

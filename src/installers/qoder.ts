import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installMancodeCore, readTextIfExists } from './common.js';
import { replaceManagedBlock } from './managed-block.js';
import { installQoderCommands } from './mode-skills.js';
import type { InstallAdapterOptions } from './registry.js';
import { generateSharedContent } from './shared-content.js';

export const QODER_MANCODE_START_MARKER = '<!-- mancode:qoder:start -->';
export const QODER_MANCODE_END_MARKER = '<!-- mancode:qoder:end -->';

export async function installQoder(
  projectRoot: string,
  options: InstallAdapterOptions,
): Promise<void> {
  await installMancodeCore(projectRoot);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const existing = await readTextIfExists(agentsPath);
  const sharedContent = await generateSharedContent(projectRoot, {
    platform: 'qoder',
    displayName: 'Qoder (IDE/CLI)',
    capabilities: {
      slashCommands: 'partial',
      subagents: false,
      hooks: false,
      skills: 'rules',
    },
    minimal: options.minimal,
    techStack: options.techStack,
    uiLibrary: options.uiLibrary,
    projectProfile: options.projectProfile,
  });

  const block = [
    QODER_MANCODE_START_MARKER,
    '<!-- Managed by mancode. Do not edit this block manually. -->',
    '',
    '# mancode Configuration',
    '',
    sharedContent.trim(),
    QODER_MANCODE_END_MARKER,
  ].join('\n');

  await writeFile(
    agentsPath,
    replaceManagedBlock(
      existing,
      block,
      QODER_MANCODE_START_MARKER,
      QODER_MANCODE_END_MARKER,
    ),
    'utf-8',
  );

  await installQoderCommands(projectRoot, options.minimal ?? false);
}

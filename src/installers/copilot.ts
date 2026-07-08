import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installMancodeCore, readTextIfExists } from './common.js';
import {
  DEFAULT_MANCODE_END_MARKER,
  DEFAULT_MANCODE_START_MARKER,
  replaceManagedBlock,
} from './managed-block.js';
import { installCopilotPrompts } from './mode-skills.js';
import type { InstallAdapterOptions } from './registry.js';
import { generateSharedContent } from './shared-content.js';

export async function installCopilot(
  projectRoot: string,
  options: InstallAdapterOptions,
): Promise<void> {
  await installMancodeCore(projectRoot);

  const githubDir = path.join(projectRoot, '.github');
  await mkdir(githubDir, { recursive: true });

  const instructionsPath = path.join(githubDir, 'copilot-instructions.md');
  const existing = await readTextIfExists(instructionsPath);
  const sharedContent = await generateSharedContent(projectRoot, {
    platform: 'copilot',
    displayName: 'GitHub Copilot',
    capabilities: {
      slashCommands: 'none',
      subagents: false,
      hooks: false,
      skills: 'instructions',
    },
    minimal: true,
    techStack: options.techStack,
    uiLibrary: options.uiLibrary,
  });

  const sections = [
    DEFAULT_MANCODE_START_MARKER,
    '<!-- Managed by mancode. Do not edit this block manually. -->',
    '',
    '# mancode for GitHub Copilot',
    '',
    sharedContent.trim(),
  ];

  if (!options.minimal) {
    sections.push('', renderCopilotPromptConventions());
  }

  sections.push(DEFAULT_MANCODE_END_MARKER);

  await writeFile(
    instructionsPath,
    replaceManagedBlock(existing, sections.join('\n')),
    'utf-8',
  );

  await installCopilotPrompts(projectRoot, options.minimal ?? false);
}

function renderCopilotPromptConventions(): string {
  return [
    '## mancode Prompt Conventions',
    '',
    'GitHub Copilot does not provide native mancode slash commands, hooks, or isolated subagents. Treat these names as user prompt conventions:',
    '',
    '- man8: investigate first and produce a plan before implementation.',
    '- man: use a careful plan, implementation, verification, and review loop.',
    '- manteam: read team memory and write handoff-friendly summaries.',
    '- manps: prefer `mancode manps [area]` before cleanup.',
  ].join('\n');
}

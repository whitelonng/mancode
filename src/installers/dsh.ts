import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installMancodeCore, readTextIfExists } from './common.js';
import { replaceManagedBlock } from './managed-block.js';
import { installDshSkills } from './mode-skills.js';
import type { InstallAdapterOptions } from './registry.js';
import { generateSharedContent } from './shared-content.js';

export const DSH_MANCODE_START_MARKER = '<!-- mancode:dsh:start -->';
export const DSH_MANCODE_END_MARKER = '<!-- mancode:dsh:end -->';

const DSH_MODE_PATH_NAMES = [
  'manba',
  'man',
  'manteam',
  'manps',
  'mansolo',
  'mamba',
  'man8',
] as const;

export async function installDsh(
  projectRoot: string,
  options: InstallAdapterOptions,
): Promise<void> {
  const root = path.resolve(projectRoot);
  await assertDshAdapterPathsSafe(root);
  await installMancodeCore(root);

  const agentsPath = path.join(root, 'AGENTS.md');
  const existing = await readTextIfExists(agentsPath);
  const sharedContent = await generateSharedContent(root, {
    platform: 'dsh',
    displayName: 'DeepSeek Harness',
    capabilities: {
      slashCommands: 'partial',
      subagents: true,
      hooks: false,
      skills: 'dsh-skills',
    },
    minimal: options.minimal,
    techStack: options.techStack,
    uiLibrary: options.uiLibrary,
    projectProfile: options.projectProfile,
  });

  const block = [
    DSH_MANCODE_START_MARKER,
    '<!-- Managed by mancode. Do not edit this block manually. -->',
    '',
    '# mancode Configuration',
    '',
    sharedContent.trim(),
    DSH_MANCODE_END_MARKER,
  ].join('\n');

  await writeDshAgentsFile(
    root,
    replaceManagedBlock(
      existing,
      block,
      DSH_MANCODE_START_MARKER,
      DSH_MANCODE_END_MARKER,
    ),
  );

  await assertDshAdapterPathsSafe(root);
  await installDshSkills(root, options.minimal ?? false);
}

export async function assertDshAdapterPathsSafe(
  projectRoot: string,
): Promise<void> {
  const root = path.resolve(projectRoot);
  const targets = [
    path.join(root, 'AGENTS.md'),
    ...DSH_MODE_PATH_NAMES.map((mode) =>
      path.join(root, '.dsh', 'skills', mode, 'SKILL.md'),
    ),
  ];
  for (const target of targets) {
    await assertDshArtifactPathSafe(root, target);
  }
}

export async function writeDshAgentsFile(
  projectRoot: string,
  content: string,
): Promise<void> {
  const root = path.resolve(projectRoot);
  const agentsPath = path.join(root, 'AGENTS.md');
  await assertDshArtifactPathSafe(root, agentsPath);
  const temporary = path.join(
    root,
    `.AGENTS.md.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: 'utf-8', flag: 'wx' });
    await rename(temporary, agentsPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertDshArtifactPathSafe(
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const segments = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? '');
    try {
      const entry = await lstat(current);
      if (
        entry.isSymbolicLink() ||
        (index < segments.length - 1 && !entry.isDirectory()) ||
        (index === segments.length - 1 && !entry.isFile())
      ) {
        throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

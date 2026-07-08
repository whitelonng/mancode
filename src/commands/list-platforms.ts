import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  type PlatformInstaller,
  getPlatformInstallers,
} from '../installers/registry.js';

export const EXIT_OK = 0;

export async function listPlatforms(
  rootDir: string = process.cwd(),
): Promise<number> {
  const installed = new Set(await readInstalledPlatforms(rootDir));
  const platforms = getPlatformInstallers();

  console.log('');
  console.log('Available platforms:');
  for (const platform of platforms) {
    console.log(formatPlatformLine(platform, installed.has(platform.name)));
  }
  console.log('');

  return EXIT_OK;
}

async function readInstalledPlatforms(rootDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(
      path.join(rootDir, '.mancode', 'config.json'),
      'utf-8',
    );
    const config = JSON.parse(raw) as { platforms?: unknown };
    return Array.isArray(config.platforms)
      ? config.platforms.filter(
          (item): item is string => typeof item === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function formatPlatformLine(
  platform: PlatformInstaller,
  installed: boolean,
): string {
  const marker = installed ? '✓' : '○';
  const capability = describePlatform(platform);
  return `  ${marker} ${platform.name.padEnd(12)} ${platform.displayName.padEnd(16)} ${capability}`;
}

function describePlatform(platform: PlatformInstaller): string {
  if (platform.capabilities.hooks && platform.capabilities.subagents) {
    return 'skills + agents + hooks';
  }
  return platform.capabilities.skills;
}

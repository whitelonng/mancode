import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  type PlatformInstaller,
  getPlatformInstallers,
} from '../installers/registry.js';
import { inspectV3Adapter } from '../installers/v3-adapter.js';

export const EXIT_OK = 0;

export async function listPlatforms(
  rootDir: string = process.cwd(),
): Promise<number> {
  if (await pathExists(path.join(rootDir, '.mancode', 'schema.json'))) {
    return listV3Platforms(rootDir);
  }
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

async function listV3Platforms(rootDir: string): Promise<number> {
  const platforms = getPlatformInstallers();
  const statuses = await Promise.all(
    platforms.map((platform) => inspectV3Adapter(rootDir, platform.name)),
  );
  console.log('');
  console.log('Available platforms (V3 bootstrap):');
  for (const [index, platform] of platforms.entries()) {
    const status = statuses[index];
    if (status === undefined) {
      throw new Error('MANCODE_V3_ADAPTER_STATUS_UNAVAILABLE');
    }
    const marker = status.installed ? '✓' : '○';
    console.log(
      `  ${marker} ${platform.name.padEnd(12)} ${platform.displayName.padEnd(16)} V3 bootstrap; explicit session identity`,
    );
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
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

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  type PlatformName,
  getPlatformInstaller,
} from '../installers/registry.js';
import { detectTeamStatus } from '../system/detect-team.js';
import {
  PROJECT_MANIFESTS,
  detectProjectProfile,
  primaryUiLibrary,
} from '../system/project-profile.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_CORRUPT_STATE = 2;
export const EXIT_REFRESH_FAILED = 3;

/** Refresh facts that can change after a generic project later gains Git or a manifest. */
export async function refreshProject(
  rootDir: string = process.cwd(),
): Promise<number> {
  const mancodeDir = path.join(rootDir, '.mancode');
  const statePath = path.join(mancodeDir, 'state.json');
  if (!(await pathExists(statePath))) {
    console.error('✗  mancode not initialized.');
    console.error('   Run `mancode init` first.');
    return EXIT_NOT_INITIALIZED;
  }

  const state = await readRequiredState(statePath);
  if (!state) {
    console.error('✗  .mancode/state.json is corrupt or incomplete.');
    console.error('   Run `mancode init --force` to repair it.');
    return EXIT_CORRUPT_STATE;
  }

  let factsWritten = false;
  try {
    const [profile, team, hasGit, hasManifest] = await Promise.all([
      detectProjectProfile(rootDir),
      detectTeamStatus(rootDir),
      pathExists(path.join(rootDir, '.git')),
      hasProjectManifest(rootDir),
    ]);
    const uiLibrary = primaryUiLibrary(profile);
    const stack = [...profile.languages, ...profile.frameworks];
    const config = await readJson(path.join(mancodeDir, 'config.json'));
    const configuredTeam =
      config.forceTeamMode === true
        ? true
        : config.teamMode === 'on'
          ? true
          : config.teamMode === 'off'
            ? false
            : team.isTeam;
    const nextState = {
      ...state,
      techStack: stack.join(' + ') || profile.projectKind,
      uiLibrary: uiLibrary ?? 'None',
      projectMode: hasGit || hasManifest ? 'detected' : 'generic',
      teamModeAutoDetected: configuredTeam,
      contributors: team.contributors,
    };
    await writeProjectFacts(
      statePath,
      path.join(mancodeDir, 'project-profile.json'),
      `${JSON.stringify(nextState, null, 2)}\n`,
      `${JSON.stringify(profile, null, 2)}\n`,
    );
    factsWritten = true;

    const refreshedPlatforms = await refreshStaticPlatforms(
      rootDir,
      config,
      state.platform,
      stack,
      uiLibrary,
      profile,
    );
    console.log('✓  Project facts refreshed.');
    console.log(
      `   ${hasGit ? 'Git detected' : 'No Git repository'} | ${hasManifest ? 'project manifest detected' : 'generic project'}`,
    );
    console.log(
      `   Stack: ${nextState.techStack} | UI: ${nextState.uiLibrary}`,
    );
    if (refreshedPlatforms.length > 0) {
      console.log(`   Refreshed adapters: ${refreshedPlatforms.join(', ')}`);
    }
    console.log(
      '   Run `mancode refresh-style` if UI files or dependencies changed.',
    );
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗  Project refresh failed: ${message}`);
    if (factsWritten) {
      console.error(
        '   Project facts were saved, but one or more static adapters remain stale.',
      );
    }
    return EXIT_REFRESH_FAILED;
  }
}

async function hasProjectManifest(rootDir: string): Promise<boolean> {
  for (const manifest of PROJECT_MANIFESTS) {
    if (await pathExists(path.join(rootDir, manifest))) return true;
  }
  return false;
}

async function writeProjectFacts(
  statePath: string,
  profilePath: string,
  stateContent: string,
  profileContent: string,
): Promise<void> {
  await Promise.all([
    ensureReplaceableFile(statePath),
    ensureReplaceableFile(profilePath),
  ]);
  const previousProfile = await readOptionalText(profilePath);
  const stateTemp = temporaryPath(statePath);
  const profileTemp = temporaryPath(profilePath);
  let profileReplaced = false;
  try {
    await Promise.all([
      fs.writeFile(stateTemp, stateContent, 'utf-8'),
      fs.writeFile(profileTemp, profileContent, 'utf-8'),
    ]);
    await fs.rename(profileTemp, profilePath);
    profileReplaced = true;
    await fs.rename(stateTemp, statePath);
  } catch (error) {
    if (profileReplaced) {
      if (previousProfile === null) {
        await fs.rm(profilePath, { force: true });
      } else {
        await replaceTextFile(profilePath, previousProfile);
      }
    }
    throw error;
  } finally {
    await Promise.all([
      fs.rm(stateTemp, { force: true }),
      fs.rm(profileTemp, { force: true }),
    ]);
  }
}

async function ensureReplaceableFile(filePath: string): Promise<void> {
  try {
    const entry = await fs.lstat(filePath);
    if (!entry.isFile()) {
      throw new Error(`cannot replace non-file path: ${filePath}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

async function replaceTextFile(
  filePath: string,
  content: string,
): Promise<void> {
  const tempPath = temporaryPath(filePath);
  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function temporaryPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function refreshStaticPlatforms(
  rootDir: string,
  config: Record<string, unknown>,
  fallbackPlatform: unknown,
  stack: string[],
  uiLibrary: string | null,
  profile: Awaited<ReturnType<typeof detectProjectProfile>>,
): Promise<string[]> {
  const platforms = configuredPlatforms(config, fallbackPlatform).filter(
    (platform) => platform !== 'claude-code',
  );
  const refreshed: string[] = [];
  for (const platform of platforms) {
    const installer = getPlatformInstaller(platform);
    if (!installer) continue;
    await installer.install(rootDir, {
      techStack: stack,
      uiLibrary,
      projectProfile: profile,
      minimal: platformIsMinimal(config, platform),
      force: true,
    });
    refreshed.push(installer.displayName);
  }
  return refreshed;
}

function configuredPlatforms(
  config: Record<string, unknown>,
  fallbackPlatform: unknown,
): PlatformName[] {
  const configured = Array.isArray(config.platforms)
    ? config.platforms
    : [fallbackPlatform];
  return configured.filter(
    (platform): platform is PlatformName =>
      typeof platform === 'string' && getPlatformInstaller(platform) !== null,
  );
}

function platformIsMinimal(
  config: Record<string, unknown>,
  platform: PlatformName,
): boolean {
  if (!isRecord(config.platformOptions)) return false;
  const options = config.platformOptions[platform];
  return isRecord(options) && options.minimal === true;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function readRequiredState(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  let state: Record<string, unknown>;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    state = parsed;
  } catch {
    return null;
  }
  return typeof state.version === 'string' &&
    typeof state.currentMode === 'string' &&
    typeof state.platform === 'string'
    ? state
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

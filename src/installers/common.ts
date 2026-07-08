import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureTeamMemory } from '../system/team-memory.js';
import { DEFAULT_CONFIG, EMPTY_STYLE_TOKENS } from '../templates/defaults.js';
import {
  SESSION_START_HOOK,
  USER_PROMPT_SUBMIT_HOOK,
} from '../templates/inline.js';

/**
 * Install platform-neutral mancode project files.
 *
 * This setup is shared by all platform adapters. Platform-specific installers
 * should create only their native target files after this core is present.
 */
export async function installMancodeCore(projectRoot: string): Promise<void> {
  const mancodeDir = path.join(projectRoot, '.mancode');

  await mkdir(path.join(mancodeDir, 'hooks'), { recursive: true });
  await mkdir(path.join(mancodeDir, 'aesthetics'), { recursive: true });
  await mkdir(path.join(mancodeDir, 'logs'), { recursive: true });
  await mkdir(path.join(mancodeDir, 'workflows'), { recursive: true });
  await ensureTeamMemory(projectRoot);
  await mkdir(path.join(mancodeDir, 'preseason-reports'), { recursive: true });

  const configPath = path.join(mancodeDir, 'config.json');
  if (!(await pathExists(configPath))) {
    await writeFile(
      configPath,
      `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
      'utf-8',
    );
  }

  await installHooks(path.join(mancodeDir, 'hooks'));

  const tokensPath = path.join(mancodeDir, 'aesthetics', 'style-tokens.json');
  if (!(await pathExists(tokensPath))) {
    await writeFile(
      tokensPath,
      `${JSON.stringify(EMPTY_STYLE_TOKENS, null, 2)}\n`,
      'utf-8',
    );
  }

  const logPath = path.join(mancodeDir, 'logs', 'hooks.log');
  if (!(await pathExists(logPath))) {
    await writeFile(logPath, '', 'utf-8');
  }
}

export async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return '';
    throw err;
  }
}

async function installHooks(hooksDir: string): Promise<void> {
  const sessionStartDst = path.join(hooksDir, 'session-start.sh');
  await writeFile(sessionStartDst, SESSION_START_HOOK, 'utf-8');
  await chmod(sessionStartDst, 0o755);

  const userPromptDst = path.join(hooksDir, 'user-prompt-submit.sh');
  await writeFile(userPromptDst, USER_PROMPT_SUBMIT_HOOK, 'utf-8');
  await chmod(userPromptDst, 0o755);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFileAtomically } from './atomic-file.js';
import {
  type PlatformSessionSpike,
  SESSION_SPIKE_PLATFORMS,
  type SessionSpikePlatform,
  parsePlatformSessionSpike,
} from './platform-spike.js';

const EVIDENCE_DIRECTORY_SEGMENTS = [
  '.mancode',
  'local',
  'evidence',
  'platform-session',
] as const;

/**
 * Session-spike evidence is local operational evidence. It is intentionally
 * outside shared authority and contains outcomes only, never host keys.
 */
export function platformSessionSpikeDirectory(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ...EVIDENCE_DIRECTORY_SEGMENTS);
}

export function platformSessionSpikePath(
  projectRoot: string,
  platform: SessionSpikePlatform,
): string {
  assertPlatform(platform);
  return path.join(
    platformSessionSpikeDirectory(projectRoot),
    `${platform}.json`,
  );
}

export async function readPlatformSessionSpike(
  projectRoot: string,
  platform: SessionSpikePlatform,
): Promise<PlatformSessionSpike | null> {
  assertPlatform(platform);
  const directory = await safeEvidenceDirectory(projectRoot, false);
  if (directory === null) return null;
  try {
    const raw = await readSafeRegularFile(
      path.join(directory, `${platform}.json`),
    );
    return parsePlatformSessionSpike(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_PLATFORM_SPIKE_CORRUPT');
    }
    throw error;
  }
}

export async function listPlatformSessionSpikes(
  projectRoot: string,
): Promise<PlatformSessionSpike[]> {
  const spikes = await Promise.all(
    SESSION_SPIKE_PLATFORMS.map((platform) =>
      readPlatformSessionSpike(projectRoot, platform),
    ),
  );
  return spikes.filter(
    (spike): spike is PlatformSessionSpike => spike !== null,
  );
}

export async function writePlatformSessionSpike(
  projectRoot: string,
  spike: PlatformSessionSpike,
): Promise<PlatformSessionSpike> {
  const parsed = parsePlatformSessionSpike(spike);
  if (parsed.schemaVersion !== 2) {
    throw new Error('MANCODE_PLATFORM_SPIKE_RECAPTURE_REQUIRED');
  }
  const directory = await safeEvidenceDirectory(projectRoot, true);
  if (directory === null) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const target = path.join(directory, `${parsed.platform}.json`);
  await assertSafeReplacementTarget(target);
  const temporary = path.join(
    directory,
    `.${parsed.platform}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await replaceFileAtomically(temporary, target);
    await assertSafeReplacementTarget(target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return parsed;
}

async function safeEvidenceDirectory(
  projectRoot: string,
  create: boolean,
): Promise<string | null> {
  let current = path.resolve(projectRoot);
  for (const segment of EVIDENCE_DIRECTORY_SEGMENTS) {
    const target = path.join(current, segment);
    try {
      await assertSafeDirectory(target);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (!create) return null;
      try {
        await mkdir(target);
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      await assertSafeDirectory(target);
    }
    current = target;
  }
  return current;
}

async function assertSafeDirectory(target: string): Promise<void> {
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
}

async function assertSafeReplacementTarget(target: string): Promise<void> {
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
    }
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function readSafeRegularFile(target: string): Promise<string> {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const content = await readFile(target, 'utf8');
  const after = await lstat(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  return content;
}

function assertPlatform(value: unknown): asserts value is SessionSpikePlatform {
  if (
    typeof value !== 'string' ||
    !SESSION_SPIKE_PLATFORMS.includes(value as SessionSpikePlatform)
  ) {
    throw new Error('MANCODE_PLATFORM_SPIKE_PLATFORM_INVALID');
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

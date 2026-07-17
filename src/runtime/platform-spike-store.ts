import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFileAtomically } from './atomic-file.js';
import {
  type PlatformSessionSpikeV1,
  SESSION_SPIKE_PLATFORMS,
  type SessionSpikePlatform,
  parsePlatformSessionSpike,
} from './platform-spike.js';

/**
 * Session-spike evidence is local operational evidence. It is intentionally
 * outside shared authority and contains outcomes only, never host keys.
 */
export function platformSessionSpikeDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'local',
    'evidence',
    'platform-session',
  );
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
): Promise<PlatformSessionSpikeV1 | null> {
  try {
    const raw = await readFile(
      platformSessionSpikePath(projectRoot, platform),
      'utf8',
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
): Promise<PlatformSessionSpikeV1[]> {
  const spikes = await Promise.all(
    SESSION_SPIKE_PLATFORMS.map((platform) =>
      readPlatformSessionSpike(projectRoot, platform),
    ),
  );
  return spikes.filter(
    (spike): spike is PlatformSessionSpikeV1 => spike !== null,
  );
}

export async function writePlatformSessionSpike(
  projectRoot: string,
  spike: PlatformSessionSpikeV1,
): Promise<PlatformSessionSpikeV1> {
  const parsed = parsePlatformSessionSpike(spike);
  const directory = platformSessionSpikeDirectory(projectRoot);
  await mkdir(directory, { recursive: true });
  const target = platformSessionSpikePath(projectRoot, parsed.platform);
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
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return parsed;
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

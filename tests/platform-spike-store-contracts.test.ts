import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPlatformSessionSpike,
  writePlatformSessionSpike,
} from '../src/runtime/platform-spike-store.js';
import { createPlatformSessionSpike } from '../src/runtime/platform-spike.js';
import { VERSION } from '../src/version.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('platform session spike evidence store', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects an evidence directory symlink instead of reading or writing outside the project',
    async () => {
      const root = await fixtureDirectory('mancode-platform-spike-root-');
      const outside = await fixtureDirectory('mancode-platform-spike-outside-');
      const evidenceParent = path.join(root, '.mancode', 'local', 'evidence');
      await mkdir(evidenceParent, { recursive: true });
      await symlink(outside, path.join(evidenceParent, 'platform-session'));
      const spike = fixtureSpike();
      await writeFile(
        path.join(outside, 'codex.json'),
        `${JSON.stringify(spike)}\n`,
      );

      await expect(readPlatformSessionSpike(root, 'codex')).rejects.toThrow(
        'MANCODE_ARTIFACT_PATH_UNSAFE',
      );
      await expect(writePlatformSessionSpike(root, spike)).rejects.toThrow(
        'MANCODE_ARTIFACT_PATH_UNSAFE',
      );
    },
  );
});

async function fixtureDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fixtureSpike() {
  return createPlatformSessionSpike({
    platform: 'codex',
    observedAt: '2026-07-18T12:00:00.000Z',
    hostSessionSource: 'api',
    firstWindowHostSessionKey: 'window-a',
    secondWindowHostSessionKey: 'window-b',
    commandPropagation: 'proven',
    subagentInheritance: 'proven',
    hookApproval: 'not_applicable',
    evidence: {
      releaseCandidate: '5c40d6b',
      mancodeVersion: VERSION,
      hostVersion: 'fixture-host-1.0.0',
      nodeVersion: process.version,
      runtimePlatform: `${process.platform}-${process.arch}`,
    },
  });
}

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilitiesFromGitRefCache,
  readGitRefTeamCache,
  writeGitRefTeamCache,
} from '../src/team/git-ref-cache.js';
import { parseProjectConfig } from '../src/team/policy.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('git-ref local cache contract', () => {
  it('reports freshness without performing a remote read', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-cache-'));
    roots.push(root);
    const config = gitRefConfig(3);
    const cache = await writeGitRefTeamCache(root, config, {
      manifest: null,
      commit: null,
      receipt: null,
      fetchedAt: '2026-07-18T10:00:00.000Z',
    });

    await expect(readGitRefTeamCache(root, config)).resolves.toEqual(cache);
    expect(
      capabilitiesFromGitRefCache(
        config,
        cache,
        new Date('2026-07-18T10:04:59.000Z'),
      ),
    ).toMatchObject({
      claimAcquisition: 'unavailable',
      transportFreshness: 'fresh',
      remoteRevision: 0,
    });
    expect(
      capabilitiesFromGitRefCache(
        config,
        cache,
        new Date('2026-07-18T10:05:01.000Z'),
      ),
    ).toMatchObject({
      claimAcquisition: 'unavailable',
      transportFreshness: 'stale',
    });
  });

  it('does not reuse a cache from an older transport epoch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-cache-'));
    roots.push(root);
    await writeGitRefTeamCache(root, gitRefConfig(2), {
      manifest: null,
      commit: null,
      receipt: null,
      fetchedAt: '2026-07-18T10:00:00.000Z',
    });
    await expect(
      readGitRefTeamCache(root, gitRefConfig(3)),
    ).resolves.toBeNull();
  });
});

function gitRefConfig(epoch: number) {
  return parseProjectConfig({
    schemaVersion: 1,
    revision: epoch,
    workspaceId: WORKSPACE_ID,
    transport: { mode: 'git-ref', remote: 'origin', epoch },
    lastOperationId: null,
    updatedAt: '2026-07-18T10:00:00.000Z',
  });
}

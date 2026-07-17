import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextBeta } from '../src/commands/context.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createUlid } from '../src/context/ids.js';
import { installV3Adapter } from '../src/installers/v3-adapter.js';
import { writePlatformSessionSpike } from '../src/runtime/platform-spike-store.js';
import {
  SESSION_SPIKE_PLATFORMS,
  createPlatformSessionSpike,
} from '../src/runtime/platform-spike.js';

describe('V3 Beta gate', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-beta-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: new Date('2026-07-18T12:00:00.000Z'),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses Beta while real-host spike evidence and adapters are missing', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await contextBeta(root, { json: true })).toBe(3);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        ready: false,
        blockers: expect.arrayContaining([
          'MANCODE_BETA_PLATFORM_SESSION_SPIKE_REQUIRED',
          'MANCODE_BETA_ADAPTER_SHADOW_OR_INSTALL_REQUIRED',
        ]),
        sessionEvidence: {
          missingPlatforms: expect.arrayContaining(['codex']),
        },
      });
    } finally {
      logs.mockRestore();
    }
  });

  it('passes only after every V3 adapter and every platform spike is present', async () => {
    for (const platform of [
      'claude-code',
      'codex',
      'cursor',
      'copilot',
      'zcode',
    ] as const) {
      await installV3Adapter(root, platform);
    }
    await Promise.all(
      SESSION_SPIKE_PLATFORMS.map((platform) =>
        writePlatformSessionSpike(
          root,
          createPlatformSessionSpike({
            platform,
            observedAt: '2026-07-18T12:00:00.000Z',
            hostSessionSource: 'api',
            firstWindowHostSessionKey: `${platform}-window-a`,
            secondWindowHostSessionKey: `${platform}-window-b`,
            commandPropagation: 'proven',
            subagentInheritance: 'not_applicable',
            hookApproval: 'not_applicable',
          }),
        ),
      ),
    );
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await contextBeta(root, { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        ready: true,
        blockers: [],
        sessionEvidence: { ready: true },
        runtimeBinding: 'ready',
      });
    } finally {
      logs.mockRestore();
    }
  });
});

function id(offset: number) {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

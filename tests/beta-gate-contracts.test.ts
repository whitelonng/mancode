import { mkdir, rm, writeFile } from 'node:fs/promises';
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
import { VERSION } from '../src/version.js';

const RELEASE_CANDIDATE = '5c40d6b';

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
      managedAdapters: {
        'claude-code': '3',
        codex: '3',
        cursor: '3',
        copilot: '3',
        zcode: '3',
      },
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
    await rm(path.join(root, '.cursor', 'rules', 'mancode-continuity.mdc'));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await contextBeta(root, {
          releaseCandidate: RELEASE_CANDIDATE,
          json: true,
        }),
      ).toBe(3);
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
    await makeBetaReady(root);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await contextBeta(root, {
          releaseCandidate: RELEASE_CANDIDATE,
          json: true,
        }),
      ).toBe(0);
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

  it('refuses Beta when any platform has not proven child inheritance', async () => {
    await makeBetaReady(root, 'not_proven');
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await contextBeta(root, {
          releaseCandidate: RELEASE_CANDIDATE,
          json: true,
        }),
      ).toBe(3);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        ready: false,
        blockers: expect.arrayContaining([
          'MANCODE_BETA_PLATFORM_SESSION_SPIKE_REQUIRED',
        ]),
        sessionEvidence: {
          explicitRequiredPlatforms: expect.arrayContaining(['codex']),
        },
      });
    } finally {
      logs.mockRestore();
    }
  });

  it('refuses Beta when evidence belongs to another release candidate', async () => {
    await makeBetaReady(root, 'proven', '721845d');
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await contextBeta(root, {
          releaseCandidate: RELEASE_CANDIDATE,
          json: true,
        }),
      ).toBe(3);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        ready: false,
        sessionEvidence: {
          evidenceMismatchPlatforms: expect.arrayContaining(['codex']),
        },
      });
    } finally {
      logs.mockRestore();
    }
  });

  it('blocks Beta for an unfinished durable git-ref workflow repair', async () => {
    await makeBetaReady(root);
    const directory = path.join(
      root,
      '.mancode',
      'local',
      'journals',
      'git-ref-workflow',
    );
    const operationId = id(40);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${operationId}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          operationId,
          actorId: id(41),
          sessionId: id(42),
          state: 'awaiting_remote',
          prepared: {
            kind: 'workflow_update',
            targetRemoteRevision: 1,
            targetBundle: {
              taskRef: { namespace: 'shared', taskId: id(43) },
            },
          },
          updatedAt: '2026-07-18T12:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await contextBeta(root, {
          releaseCandidate: RELEASE_CANDIDATE,
          json: true,
        }),
      ).toBe(3);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        ready: false,
        blockers: expect.arrayContaining([
          'MANCODE_BETA_OPERATION_RECOVERY_REQUIRED',
        ]),
        unfinishedGitRefWorkflowRepairs: [
          {
            operationId,
            kind: 'workflow_update',
            state: 'awaiting_remote',
          },
        ],
      });
    } finally {
      logs.mockRestore();
    }
  });
});

async function makeBetaReady(
  projectRoot: string,
  subagentInheritance: 'proven' | 'not_proven' = 'proven',
  releaseCandidate = RELEASE_CANDIDATE,
): Promise<void> {
  for (const platform of [
    'claude-code',
    'codex',
    'cursor',
    'copilot',
    'zcode',
  ] as const) {
    await installV3Adapter(projectRoot, platform);
  }
  await Promise.all(
    SESSION_SPIKE_PLATFORMS.map((platform) =>
      writePlatformSessionSpike(
        projectRoot,
        createPlatformSessionSpike({
          platform,
          observedAt: '2026-07-18T12:00:00.000Z',
          hostSessionSource: 'api',
          firstWindowHostSessionKey: `${platform}-window-a`,
          secondWindowHostSessionKey: `${platform}-window-b`,
          commandPropagation: 'proven',
          subagentInheritance,
          hookApproval: 'not_applicable',
          evidence: {
            releaseCandidate,
            mancodeVersion: VERSION,
            hostVersion: 'fixture-host-1.0.0',
            nodeVersion: process.version,
            runtimePlatform: `${process.platform}-${process.arch}`,
          },
        }),
      ),
    ),
  );
}

function id(offset: number) {
  return createUlid(
    Date.parse('2026-07-18T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

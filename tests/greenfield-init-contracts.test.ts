import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  abortStagedGreenfieldInitialization,
  greenfieldStagingPath,
  greenfieldTargetPath,
  initializeGreenfield,
  recoverGreenfieldInitialization,
  stageGreenfieldInitialization,
} from '../src/context/greenfield-init.js';
import { parseSchemaManifest } from '../src/context/manifest.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';

const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const EPOCH = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';

describe('journaled greenfield initialization contract', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-greenfield-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stages outside .mancode and activates only after binding registration', async () => {
    let registrations = 0;
    const journal = await initializeGreenfield(input(root), {
      registerWorkspaceBinding: async () => {
        registrations += 1;
      },
      now: new Date('2026-07-17T12:00:00.000Z'),
    });
    expect(journal.state).toBe('activated');
    expect(registrations).toBe(1);
    await expect(
      readFile(greenfieldStagingPath(root, OPERATION_ID)),
    ).rejects.toThrow();
    const manifest = parseSchemaManifest(
      JSON.parse(
        await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
      ),
    );
    expect(manifest).toMatchObject({
      activationState: 'v3_active',
      legacyBaseline: null,
    });
    expect(
      await readFile(path.join(root, '.mancode', '.gitignore'), 'utf8'),
    ).toContain('local/');
    expect(
      JSON.parse(
        await readFile(
          path.join(root, '.mancode', 'shared', 'context', 'project.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      trust: 'detected',
      profile: { projectKind: 'unknown' },
      lastOperationId: OPERATION_ID,
    });
    expect(journal.projectFactsDigest).toMatch(/^sha256:/);
  });

  it('refuses legacy authority before it creates a staging root', async () => {
    await mkdir(path.join(root, '.mancode'), { recursive: true });
    await writeFile(path.join(root, '.mancode', 'state.json'), '{}');
    await expect(stageGreenfieldInitialization(input(root))).rejects.toThrow(
      'MANCODE_LEGACY_AUTHORITY_PRESENT',
    );
    await expect(
      readFile(greenfieldStagingPath(root, OPERATION_ID)),
    ).rejects.toThrow();
  });

  it('never replaces a competing V3 target and permits only verified staging abort', async () => {
    await stageGreenfieldInitialization(input(root));
    await mkdir(greenfieldTargetPath(root));
    await expect(
      recoverGreenfieldInitialization({
        projectRoot: root,
        operationId: OPERATION_ID,
        registerWorkspaceBinding: async () => {},
      }),
    ).rejects.toThrow('MANCODE_GREENFIELD_REPAIR_REQUIRED');
    await rm(greenfieldTargetPath(root), { recursive: true });
    await abortStagedGreenfieldInitialization(root, OPERATION_ID);
    await expect(
      readFile(greenfieldStagingPath(root, OPERATION_ID)),
    ).rejects.toThrow();
  });

  it('forward-repairs a crash after atomic publication rather than rolling it back', async () => {
    await stageGreenfieldInitialization(input(root));
    await rename(
      greenfieldStagingPath(root, OPERATION_ID),
      greenfieldTargetPath(root),
    );
    let registrations = 0;
    await expect(
      recoverGreenfieldInitialization({
        projectRoot: root,
        operationId: OPERATION_ID,
        registerWorkspaceBinding: async () => {
          registrations += 1;
        },
        now: new Date('2026-07-17T12:01:00.000Z'),
      }),
    ).resolves.toBe('forward_repaired');
    expect(registrations).toBe(1);
    const manifest = parseSchemaManifest(
      JSON.parse(
        await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
      ),
    );
    expect(manifest.activationState).toBe('v3_active');
  });

  it('runs the real initializer and custom recovery at every declared crash point', async () => {
    for (const [
      index,
      fixture,
    ] of OPERATION_CRASH_FIXTURES.greenfield_initialize.entries()) {
      const caseRoot = path.join(root, `case-${index}`);
      await mkdir(caseRoot, { recursive: true });
      let registrations = 0;
      const recoveryInput = {
        projectRoot: caseRoot,
        operationId: OPERATION_ID,
        registerWorkspaceBinding: async () => {
          registrations += 1;
        },
        now: new Date('2026-07-17T12:02:00.000Z'),
      };

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          initializeGreenfield(input(caseRoot), recoveryInput),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      if (fixture.expectedRecovery === 'safe_abort') {
        if (fixture.crashAfter === 'verify-no-legacy-authority') {
          await expect(
            recoverGreenfieldInitialization(recoveryInput),
          ).rejects.toThrow('MANCODE_GREENFIELD_INITIALIZATION_NOT_FOUND');
        } else {
          await expect(
            recoverGreenfieldInitialization(recoveryInput),
          ).resolves.toBe('safe_abort_available');
          await abortStagedGreenfieldInitialization(caseRoot, OPERATION_ID);
        }
        expect(
          await pathExists(greenfieldStagingPath(caseRoot, OPERATION_ID)),
        ).toBe(false);
        expect(await pathExists(greenfieldTargetPath(caseRoot))).toBe(false);
        await expect(
          initializeGreenfield(input(caseRoot), recoveryInput),
        ).resolves.toMatchObject({ state: 'activated' });
      } else {
        await expect(
          recoverGreenfieldInitialization(recoveryInput),
        ).resolves.toBe(
          fixture.crashAfter === 'commit'
            ? 'already_activated'
            : 'forward_repaired',
        );
      }

      await expect(
        recoverGreenfieldInitialization(recoveryInput),
      ).resolves.toBe('already_activated');
      await expect(
        recoverGreenfieldInitialization(recoveryInput),
      ).resolves.toBe('already_activated');
      expect(registrations).toBeGreaterThanOrEqual(1);
    }
  });
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function input(projectRoot: string) {
  return {
    projectRoot,
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    schemaEpoch: EPOCH,
    minReaderVersion: '0.4.0',
    minWriterVersion: '0.4.0',
    managedAdapters: {
      'claude-code': '3',
      codex: '3',
      cursor: '3',
      copilot: '3',
      zcode: '3',
    },
    projectConfig: {
      schemaVersion: 1 as const,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      transport: { mode: 'local' as const, remote: null },
      lastOperationId: null,
      updatedAt: '2026-07-17T10:00:00.000Z',
    },
    teamPolicy: {
      schemaVersion: 1 as const,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      policy: 'auto' as const,
      recentDays: 30,
      defaultVisibility: 'local' as const,
      shareConfirmedDecisions: false,
      retention: {
        localRawArtifactDays: 7,
        localCacheDays: 7,
        completedSessionDays: 30,
      },
      lastOperationId: null,
      updatedAt: '2026-07-17T10:00:00.000Z',
    },
    now: new Date('2026-07-17T10:00:00.000Z'),
  };
}

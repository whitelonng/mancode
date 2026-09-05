import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
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
  parseGreenfieldInitializationJournal,
  recoverGreenfieldInitialization,
  stageGreenfieldInitialization,
} from '../src/context/greenfield-init.js';
import { parseSchemaManifest } from '../src/context/manifest.js';
import { inspectV3AdapterVersions } from '../src/installers/v3-adapter.js';
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
      manifestVersion: 2,
      activationState: 'v3_active',
      legacyBaseline: null,
      workflowPolicyDefaults: { planning: 2 },
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

  it.each([
    'unchanged',
    'logical-retargeted',
    'physical-symlink',
    'content-drift',
  ] as const)(
    'recovers a legacy resolvedTarget-only journal only with its pinned target: %s',
    async (scenario) => {
      const physicalPath = path.join(root, 'SHARED.md');
      const logicalPath = path.join(root, 'CLAUDE.md');
      const alternatePath = path.join(root, 'ALTERNATE.md');
      const before = '# Shared instructions\n';
      await writeFile(physicalPath, before);
      await writeFile(alternatePath, before);
      await symlink('SHARED.md', logicalPath);
      const journal = await stageGreenfieldInitialization({
        ...input(root),
        managedAdapters: { 'claude-code': '3' },
      });
      const plan = journal.adapterPlans.find(
        (candidate) => candidate.resolvedTarget,
      );
      if (plan === undefined) throw new Error('expected symlink adapter plan');
      expect(plan.target).toBe('claude-skill');
      plan.linkIdentities = undefined;
      const journalPath = path.join(
        greenfieldStagingPath(root, OPERATION_ID),
        'local',
        'runtime',
        'initialization',
        `${OPERATION_ID}.json`,
      );
      await writeFile(journalPath, JSON.stringify(journal));
      await rename(
        greenfieldStagingPath(root, OPERATION_ID),
        greenfieldTargetPath(root),
      );
      if (scenario === 'logical-retargeted') {
        await rm(logicalPath);
        await symlink('ALTERNATE.md', logicalPath);
      } else if (scenario === 'physical-symlink') {
        await rm(physicalPath);
        await symlink('ALTERNATE.md', physicalPath);
      } else if (scenario === 'content-drift') {
        await writeFile(physicalPath, '# Edited instructions\n');
      }
      const recovery = recoverGreenfieldInitialization({
        projectRoot: root,
        operationId: OPERATION_ID,
        registerWorkspaceBinding: async () => {},
      });
      if (scenario === 'unchanged') {
        await expect(recovery).resolves.toBe('forward_repaired');
        await expect(readFile(physicalPath, 'utf8')).resolves.toBe(
          plan.targetContent,
        );
      } else {
        await expect(recovery).rejects.toThrow(
          'MANCODE_V3_ADAPTER_TARGET_CONFLICT',
        );
        await expect(readFile(physicalPath, 'utf8')).resolves.toBe(
          scenario === 'content-drift' ? '# Edited instructions\n' : before,
        );
      }
      expect((await lstat(logicalPath)).isSymbolicLink()).toBe(true);
      await expect(readFile(alternatePath, 'utf8')).resolves.toBe(before);
    },
  );

  it('strictly validates new journal link identities without rejecting legacy metadata', async () => {
    await writeFile(path.join(root, 'SHARED.md'), '# Shared instructions\n');
    await symlink('SHARED.md', path.join(root, 'CLAUDE.md'));
    const journal = await stageGreenfieldInitialization({
      ...input(root),
      managedAdapters: { 'claude-code': '3' },
    });
    const plan = journal.adapterPlans.find(
      (candidate) => candidate.resolvedTarget,
    );
    if (plan === undefined) throw new Error('expected symlink adapter plan');
    expect(
      parseGreenfieldInitializationJournal(journal).adapterPlans,
    ).toContainEqual(plan);
    for (const metadata of [
      { linkIdentities: [] },
      { linkIdentities: null },
      { resolvedTarget: undefined },
      { resolvedTarget: '../outside.md' },
      {
        linkIdentities: [{ linkPath: '../CLAUDE.md', linkTarget: 'SHARED.md' }],
      },
      { linkIdentities: [{ linkPath: 'CLAUDE.md', linkTarget: '' }] },
      {
        linkIdentities: [
          ...(plan.linkIdentities ?? []),
          ...(plan.linkIdentities ?? []),
        ],
      },
    ]) {
      expect(() =>
        parseGreenfieldInitializationJournal({
          ...journal,
          adapterPlans: [{ ...plan, ...metadata }],
        }),
      ).toThrow('greenfield initialization journal adapterPlans is invalid');
    }
    const { linkIdentities: _identities, ...legacyPlan } = plan;
    expect(
      parseGreenfieldInitializationJournal({
        ...journal,
        adapterPlans: [legacyPlan],
      }).adapterPlans,
    ).toEqual([legacyPlan]);
  });

  it('rejects changed new-format link identity even when its destination is unchanged', async () => {
    const physicalPath = path.join(root, 'SHARED.md');
    const logicalPath = path.join(root, 'CLAUDE.md');
    const before = '# Shared instructions\n';
    await writeFile(physicalPath, before);
    await symlink('SHARED.md', logicalPath);
    await stageGreenfieldInitialization({
      ...input(root),
      managedAdapters: { 'claude-code': '3' },
    });
    await rename(
      greenfieldStagingPath(root, OPERATION_ID),
      greenfieldTargetPath(root),
    );
    await rm(logicalPath);
    await symlink('./SHARED.md', logicalPath);

    await expect(
      recoverGreenfieldInitialization({
        projectRoot: root,
        operationId: OPERATION_ID,
        registerWorkspaceBinding: async () => {},
      }),
    ).rejects.toThrow('MANCODE_V3_ADAPTER_TARGET_CONFLICT');
    await expect(readFile(physicalPath, 'utf8')).resolves.toBe(before);
    expect((await lstat(logicalPath)).isSymbolicLink()).toBe(true);
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

  it('keeps V2 inactive and forward-repairs a crash after the first adapter target', async () => {
    const recoveryInput = {
      projectRoot: root,
      operationId: OPERATION_ID,
      registerWorkspaceBinding: async () => {},
      now: new Date('2026-07-17T12:03:00.000Z'),
    };
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: 'greenfield_initialize',
          crashAfter: 'publish-managed-adapters:claude-skill',
        },
        () => initializeGreenfield(input(root), recoveryInput),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

    expect(
      parseSchemaManifest(
        JSON.parse(
          await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
        ),
      ).activationState,
    ).toBe('initializing');
    await expect(recoverGreenfieldInitialization(recoveryInput)).resolves.toBe(
      'forward_repaired',
    );
    await expect(
      inspectV3AdapterVersions(root, [
        'claude-code',
        'codex',
        'cursor',
        'copilot',
        'zcode',
      ]),
    ).resolves.toEqual({
      'claude-code': '3',
      codex: '3',
      cursor: '3',
      copilot: '3',
      zcode: '3',
    });
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

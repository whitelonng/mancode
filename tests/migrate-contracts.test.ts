import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSchemaManifest } from '../src/context/manifest.js';
import {
  DUAL_READ_BOOTSTRAP_OPERATION,
  activateLegacyMigration,
  dryRunLegacyMigration,
  dualReadBootstrapLockPath,
  dualReadBootstrapStagingPath,
  dualReadBootstrapStatePath,
  listMigrationStages,
  migrationStagePath,
  parseDualReadBootstrapState,
  resolveLegacyMigration,
  rollbackLegacyMigration,
  stageLegacyMigration,
} from '../src/context/migrate.js';
import {
  createOperationLockPauseForTesting,
  withOperationCrashInjectionForTesting,
} from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';

const OWNER_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const LEGACY_TASK_ID = '20260717-120000-login-rate-limit';
const ACTIVATION_OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const SHARED_ADAPTER_CONTENT =
  '# User instructions\r\nKeep this text unchanged.\r\n<!-- mancode:start -->\n<!-- Managed by mancode. Do not edit this block manually. -->\nLegacy Codex instructions.\n<!-- mancode:end -->\n';

describe('legacy migration stage contract', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-migrate-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await writeLegacyFixture(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('dry-runs without creating V3 paths and makes missing active ownership explicit', async () => {
    const before = await readLegacyAuthorityBytes(root);

    const report = await dryRunLegacyMigration(root);

    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0]).toMatchObject({
      legacyTaskId: LEGACY_TASK_ID,
      state: 'blocked',
      blockers: ['MANCODE_MIGRATION_OWNER_REQUIRED'],
    });
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json')),
    ).rejects.toThrow();
    expect(await readLegacyAuthorityBytes(root)).toEqual(before);
  });

  it('requires an explicit adapter inventory when legacy evidence is absent', async () => {
    await rm(path.join(root, '.mancode', 'state.json'), { force: false });

    await expect(dryRunLegacyMigration(root)).rejects.toThrow(
      'MANCODE_MIGRATION_ADAPTER_INVENTORY_REQUIRED',
    );
    await expect(stageLegacyMigration({ projectRoot: root })).rejects.toThrow(
      'MANCODE_MIGRATION_ADAPTER_INVENTORY_REQUIRED',
    );
    await expect(
      readFile(path.join(root, '.mancode', 'schema.json')),
    ).rejects.toThrow();
  });

  it('infers a single legacy platform without registering the other adapters', async () => {
    const report = await dryRunLegacyMigration(root);

    expect(report.managedAdapters).toEqual({
      'claude-code': 'legacy-unmanaged',
    });
    expect(report.managedAdaptersDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.adapterEvidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('infers multiple platforms from explicit markers in one shared AGENTS.md', async () => {
    await rm(path.join(root, '.mancode', 'state.json'), { force: false });
    await writeFile(
      path.join(root, 'AGENTS.md'),
      [
        '# User instructions',
        '<!-- mancode:continuity:codex:start -->',
        'Codex marker.',
        '<!-- mancode:continuity:codex:end -->',
        '<!-- mancode:zcode:start -->',
        'ZCode marker.',
        '<!-- mancode:zcode:end -->',
      ].join('\n'),
      'utf8',
    );

    const report = await dryRunLegacyMigration(root);

    expect(report.managedAdapters).toEqual({
      codex: 'legacy-unmanaged',
      zcode: 'legacy-unmanaged',
    });
  });

  it('recognizes the old generic managed block by its platform-specific file', async () => {
    await rm(path.join(root, '.mancode', 'state.json'), { force: false });
    await mkdir(path.join(root, '.github'), { recursive: true });
    const genericBlock = [
      '<!-- mancode:start -->',
      '<!-- Managed by mancode. Do not edit this block manually. -->',
      'Legacy managed instructions.',
      '<!-- mancode:end -->',
    ].join('\n');
    await writeFile(path.join(root, 'AGENTS.md'), genericBlock, 'utf8');
    await writeFile(
      path.join(root, '.github', 'copilot-instructions.md'),
      genericBlock,
      'utf8',
    );

    const report = await dryRunLegacyMigration(root);

    expect(report.managedAdapters).toEqual({
      codex: 'legacy-unmanaged',
      copilot: 'legacy-unmanaged',
    });
  });

  it('honors an explicit empty inventory and persists it in the shell and stage', async () => {
    await rm(path.join(root, '.mancode', 'state.json'), { force: false });

    const staged = await stageLegacyMigration({
      projectRoot: root,
      managedAdapters: {},
    });

    expect(staged.managedAdapters).toEqual({});
    expect(staged.managedAdaptersDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(staged.adapterEvidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const manifest = parseSchemaManifest(
      JSON.parse(
        await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
      ),
    );
    expect(manifest.managedAdapters).toEqual({});
  });

  it('keeps an existing all-platform manifest authoritative and compatible', async () => {
    const initial = await stageLegacyMigration({ projectRoot: root });
    const schemaPath = path.join(root, '.mancode', 'schema.json');
    const manifest = parseSchemaManifest(
      JSON.parse(await readFile(schemaPath, 'utf8')),
    );
    await rm(path.join(root, '.mancode', 'local'), {
      recursive: true,
      force: true,
    });
    const allPlatforms = {
      'claude-code': '3',
      codex: '3',
      cursor: '3',
      copilot: '3',
      zcode: '3',
      'kimi-code': '3',
      qoder: '3',
      dsh: '3',
    } as const;
    await writeFile(
      schemaPath,
      `${JSON.stringify({ ...manifest, managedAdapters: allPlatforms }, null, 2)}\n`,
      'utf8',
    );

    const staged = await stageLegacyMigration({ projectRoot: root });

    expect(staged.managedAdapters).toEqual(allPlatforms);
    await expect(
      stageLegacyMigration({
        projectRoot: root,
        stageId: staged.stageId,
        managedAdapters: { codex: '3' },
      }),
    ).rejects.toThrow('MANCODE_MIGRATION_ADAPTER_INVENTORY_CONFLICT');
    expect(initial.stageId).not.toBe(staged.stageId);
  });

  it('rejects adapter evidence drift after staging', async () => {
    const staged = await stageLegacyMigration({ projectRoot: root });
    await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
    await writeFile(
      path.join(root, '.cursor', 'rules', 'user.mdc'),
      'user-owned rule\n',
      'utf8',
    );

    await expect(
      resolveLegacyMigration({
        projectRoot: root,
        stageId: staged.stageId,
        legacyTaskId: LEGACY_TASK_ID,
        expectedStageRevision: staged.revision,
        ownerActorId: OWNER_ID,
      }),
    ).rejects.toThrow('MANCODE_MIGRATION_ADAPTER_EVIDENCE_CHANGED');
  });

  it('activates exactly the selected inventory', async () => {
    const staged = await stageLegacyMigration({
      projectRoot: root,
      managedAdapters: { codex: 'legacy-unmanaged' },
    });
    const resolved = await resolveLegacyMigration({
      projectRoot: root,
      stageId: staged.stageId,
      legacyTaskId: LEGACY_TASK_ID,
      expectedStageRevision: staged.revision,
      ownerActorId: OWNER_ID,
    });
    const actor = await createLocalActor(root, {
      actorId: OWNER_ID,
      displayName: 'Inventory owner',
    });
    await publishSharedActorProfile(root, createSharedActorProfile(actor));
    const session = await createSession(root, {
      actorId: actor.actorId,
      client: 'inventory-test',
      identitySource: 'explicit',
    });

    const activated = await activateLegacyMigration({
      projectRoot: root,
      stageId: resolved.stageId,
      expectedStageRevision: resolved.revision,
      sessionId: session.sessionId,
      explicitConfirmation: true,
      sharedPrivacyConfirmed: false,
    });

    expect(activated.manifest.managedAdapters).toEqual({ codex: '3' });
    await expect(readFile(path.join(root, 'CLAUDE.md'))).rejects.toThrow();
    await expect(
      readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    ).resolves.toContain('mancode:continuity:codex:start');
  });

  it('keeps repeated staging idempotent for the inventory snapshot', async () => {
    const stageId = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
    const first = await stageLegacyMigration({
      projectRoot: root,
      stageId,
    });
    const second = await stageLegacyMigration({
      projectRoot: root,
      stageId,
    });

    expect(second.managedAdapters).toEqual(first.managedAdapters);
    expect(second.managedAdaptersDigest).toBe(first.managedAdaptersDigest);
    expect(second.adapterEvidenceDigest).toBe(first.adapterEvidenceDigest);
    expect(await listMigrationStages(root)).toHaveLength(1);
  });

  it.each([
    'staging-config',
    'prepared',
    'config-before',
    'config',
    'config-after',
    'policy-before',
    'policy',
    'policy-after',
    'schema-before',
    'schema',
    'schema-after',
    'commit',
  ] as const)(
    'recovers the dual-read shell after %s',
    async (crashAfter) => {
      const caseRoot = path.join(root, `bootstrap-crash-${crashAfter}`);
      await mkdir(caseRoot, { recursive: true });
      await writeLegacyFixture(caseRoot);

      await expect(
        withOperationCrashInjectionForTesting(
          { operationType: DUAL_READ_BOOTSTRAP_OPERATION, crashAfter },
          () =>
            stageLegacyMigration({
              projectRoot: caseRoot,
              now: new Date('2026-07-17T12:00:00.000Z'),
            }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      if (!crashAfter.startsWith('schema') && crashAfter !== 'commit') {
        await expect(
          readFile(path.join(caseRoot, '.mancode', 'schema.json')),
        ).rejects.toThrow();
      }

      const recovered = await stageLegacyMigration({
        projectRoot: caseRoot,
        now: new Date('2026-07-17T12:01:00.000Z'),
      });
      await assertDualReadBootstrapCommitted(caseRoot);

      const repeated = await stageLegacyMigration({
        projectRoot: caseRoot,
        stageId: recovered.stageId,
        now: new Date('2026-07-17T12:02:00.000Z'),
      });
      expect(repeated.managedAdapters).toEqual(recovered.managedAdapters);
      await assertDualReadBootstrapCommitted(caseRoot);
    },
    60_000,
  );

  it('rebuilds damaged staging from the durable bootstrap state', async () => {
    const caseRoot = path.join(root, 'bootstrap-damaged-staging');
    await mkdir(caseRoot, { recursive: true });
    await writeLegacyFixture(caseRoot);

    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: DUAL_READ_BOOTSTRAP_OPERATION,
          crashAfter: 'prepared',
        },
        () => stageLegacyMigration({ projectRoot: caseRoot }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    const state = await readDualReadBootstrapState(caseRoot);
    const stagingConfig = path.join(
      dualReadBootstrapStagingPath(caseRoot, state.operationId),
      'shared',
      'config.json',
    );
    await writeFile(stagingConfig, '{ damaged staging }\n', 'utf8');

    await stageLegacyMigration({ projectRoot: caseRoot });

    await assertDualReadBootstrapCommitted(caseRoot);
  });

  it('rejects a schema symlink instead of accepting a manifest through it', async () => {
    const manifestTarget = path.join(root, 'schema-target.json');
    await writeFile(manifestTarget, '{}\n', 'utf8');
    await symlink(manifestTarget, path.join(root, '.mancode', 'schema.json'));

    await expect(dryRunLegacyMigration(root)).rejects.toThrow(
      'MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED',
    );
  });

  it('persists repair-required when a durable journal finds a damaged target', async () => {
    const caseRoot = path.join(root, 'bootstrap-target-symlink');
    await mkdir(caseRoot, { recursive: true });
    await writeLegacyFixture(caseRoot);
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: DUAL_READ_BOOTSTRAP_OPERATION,
          crashAfter: 'prepared',
        },
        () => stageLegacyMigration({ projectRoot: caseRoot }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    await mkdir(path.join(caseRoot, '.mancode', 'shared'), {
      recursive: true,
    });
    const target = path.join(caseRoot, 'user-config.json');
    await writeFile(target, '{}\n', 'utf8');
    await symlink(
      target,
      path.join(caseRoot, '.mancode', 'shared', 'config.json'),
    );

    await expect(
      stageLegacyMigration({ projectRoot: caseRoot }),
    ).rejects.toThrow('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    await expect(readDualReadBootstrapState(caseRoot)).resolves.toMatchObject({
      state: 'repair_required',
    });
  });

  it('rebuilds ordinary staging debris but rejects staging symlinks', async () => {
    const rebuildRoot = path.join(root, 'bootstrap-staging-debris');
    await mkdir(rebuildRoot, { recursive: true });
    await writeLegacyFixture(rebuildRoot);
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: DUAL_READ_BOOTSTRAP_OPERATION,
          crashAfter: 'prepared',
        },
        () => stageLegacyMigration({ projectRoot: rebuildRoot }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    const rebuildState = await readDualReadBootstrapState(rebuildRoot);
    await writeFile(
      path.join(
        dualReadBootstrapStagingPath(rebuildRoot, rebuildState.operationId),
        'leftover.txt',
      ),
      'ordinary debris\n',
      'utf8',
    );

    await stageLegacyMigration({ projectRoot: rebuildRoot });
    await assertDualReadBootstrapCommitted(rebuildRoot);

    const unsafeRoot = path.join(root, 'bootstrap-staging-symlink');
    await mkdir(unsafeRoot, { recursive: true });
    await writeLegacyFixture(unsafeRoot);
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: DUAL_READ_BOOTSTRAP_OPERATION,
          crashAfter: 'prepared',
        },
        () => stageLegacyMigration({ projectRoot: unsafeRoot }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    const unsafeState = await readDualReadBootstrapState(unsafeRoot);
    const unsafeTarget = path.join(unsafeRoot, 'user-owned.txt');
    await writeFile(unsafeTarget, 'keep\n', 'utf8');
    await symlink(
      unsafeTarget,
      path.join(
        dualReadBootstrapStagingPath(unsafeRoot, unsafeState.operationId),
        'unsafe-link',
      ),
    );

    await expect(
      stageLegacyMigration({ projectRoot: unsafeRoot }),
    ).rejects.toThrow('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    await expect(readDualReadBootstrapState(unsafeRoot)).resolves.toMatchObject(
      { state: 'repair_required' },
    );
  });

  it('makes dry-run report a durable partial bootstrap while stage repairs it', async () => {
    const caseRoot = path.join(root, 'bootstrap-dry-run-partial');
    await mkdir(caseRoot, { recursive: true });
    await writeLegacyFixture(caseRoot);
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: DUAL_READ_BOOTSTRAP_OPERATION,
          crashAfter: 'prepared',
        },
        () => stageLegacyMigration({ projectRoot: caseRoot }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

    await expect(dryRunLegacyMigration(caseRoot)).rejects.toThrow(
      'MANCODE_MIGRATION_DUAL_READ_SHELL_RECOVERY_REQUIRED',
    );
    await stageLegacyMigration({ projectRoot: caseRoot });
    await assertDualReadBootstrapCommitted(caseRoot);
  });

  it('requires the durable target order to match config, policy, and schema', async () => {
    await stageLegacyMigration({ projectRoot: root });
    const state = await readDualReadBootstrapState(root);

    expect(() =>
      parseDualReadBootstrapState({
        ...state,
        targets: [...state.targets].reverse(),
      }),
    ).toThrow('dual-read bootstrap state targets are not ordered');
  });

  it('marks the bootstrap repair-required when a published target is externally changed', async () => {
    const caseRoot = path.join(root, 'bootstrap-external-change');
    await mkdir(caseRoot, { recursive: true });
    await writeLegacyFixture(caseRoot);
    await stageLegacyMigration({ projectRoot: caseRoot });

    const configPath = path.join(caseRoot, '.mancode', 'shared', 'config.json');
    await writeFile(configPath, '{ "external": true }\n', 'utf8');

    await expect(
      stageLegacyMigration({ projectRoot: caseRoot }),
    ).rejects.toThrow('MANCODE_MIGRATION_DUAL_READ_SHELL_CONFLICT');
    await expect(readDualReadBootstrapState(caseRoot)).resolves.toMatchObject({
      state: 'repair_required',
    });
    await expect(readFile(configPath, 'utf8')).resolves.toBe(
      '{ "external": true }\n',
    );
  });

  it('returns repair-required for a corrupted bootstrap journal without exposing schema', async () => {
    const caseRoot = path.join(root, 'bootstrap-corrupt-journal');
    await mkdir(caseRoot, { recursive: true });
    await writeLegacyFixture(caseRoot);
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: DUAL_READ_BOOTSTRAP_OPERATION,
          crashAfter: 'prepared',
        },
        () => stageLegacyMigration({ projectRoot: caseRoot }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    await writeFile(
      dualReadBootstrapStatePath(caseRoot),
      '{ broken journal\n',
      'utf8',
    );

    await expect(
      stageLegacyMigration({ projectRoot: caseRoot }),
    ).rejects.toThrow('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    await expect(
      readFile(path.join(caseRoot, '.mancode', 'schema.json')),
    ).rejects.toThrow();
  });

  it('returns repair-required when schema is visible but config or policy is missing', async () => {
    const caseRoot = path.join(root, 'bootstrap-missing-prerequisite');
    await mkdir(caseRoot, { recursive: true });
    await writeLegacyFixture(caseRoot);
    await stageLegacyMigration({ projectRoot: caseRoot });

    const schemaPath = path.join(caseRoot, '.mancode', 'schema.json');
    const schemaBefore = await readFile(schemaPath, 'utf8');
    await rm(dualReadBootstrapStatePath(caseRoot), { force: false });
    await rm(path.join(caseRoot, '.mancode', 'shared', 'config.json'), {
      force: false,
    });
    await rm(path.join(caseRoot, '.mancode', 'shared', 'team', 'policy.json'), {
      force: false,
    });

    await expect(
      stageLegacyMigration({ projectRoot: caseRoot }),
    ).rejects.toThrow('MANCODE_MIGRATION_DUAL_READ_SHELL_REPAIR_REQUIRED');
    await expect(readFile(schemaPath, 'utf8')).resolves.toBe(schemaBefore);
  });

  it.each(['normal', 'concurrent', 'changed-owner', 'abandoned-guard'])(
    'safely handles expired bootstrap locks: %s',
    async (scenario) => {
      const caseRoot = path.join(root, 'bootstrap-stale-lock');
      await mkdir(caseRoot, { recursive: true });
      await writeLegacyFixture(caseRoot);
      await expect(
        withOperationCrashInjectionForTesting(
          {
            operationType: DUAL_READ_BOOTSTRAP_OPERATION,
            crashAfter: 'prepared',
          },
          () => stageLegacyMigration({ projectRoot: caseRoot }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
      const state = await readDualReadBootstrapState(caseRoot);
      const lockPath = dualReadBootstrapLockPath(caseRoot);
      const expired = '2020-01-01T00:00:00.000Z';
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            operationId: state.operationId,
            processId: 2_147_483_647,
            acquiredAt: expired,
            leaseExpiresAt: expired,
            statePath: path.relative(
              caseRoot,
              dualReadBootstrapStatePath(caseRoot),
            ),
            stagingDirectory: path.relative(
              caseRoot,
              dualReadBootstrapStagingPath(caseRoot, state.operationId),
            ),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      await utimes(lockPath, new Date(expired), new Date(expired));

      if (scenario === 'abandoned-guard') {
        await mkdir(`${lockPath}.reclaim`);
        await expect(
          stageLegacyMigration({ projectRoot: caseRoot }),
        ).rejects.toThrow('MANCODE_MIGRATION_BOOTSTRAP_LOCK_STALE_UNVERIFIED');
        await expect(lstat(lockPath)).resolves.toBeDefined();
        expect(await readDualReadBootstrapState(caseRoot)).toEqual(state);
        return;
      }
      if (scenario === 'normal') {
        await stageLegacyMigration({ projectRoot: caseRoot });
      } else {
        const pause = createOperationLockPauseForTesting({
          operationId: state.operationId,
          pauseAfter: 'bootstrap_reclaim_held',
        });
        const winner = pause.run(() =>
          stageLegacyMigration({ projectRoot: caseRoot }),
        );
        void winner.catch(() => undefined);
        try {
          await pause.reached;
          if (scenario === 'concurrent') {
            await expect(
              stageLegacyMigration({ projectRoot: caseRoot }),
            ).rejects.toThrow(
              'MANCODE_MIGRATION_BOOTSTRAP_LOCK_STALE_UNVERIFIED',
            );
          } else {
            const ownerPath = path.join(lockPath, 'owner.json');
            const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
            await writeFile(
              ownerPath,
              JSON.stringify({ ...owner, processId: process.pid }),
            );
          }
        } finally {
          pause.release();
        }
        if (scenario === 'changed-owner') {
          await expect(winner).rejects.toThrow(
            'MANCODE_MIGRATION_BOOTSTRAP_LOCK_HELD',
          );
          expect(
            JSON.parse(
              await readFile(path.join(lockPath, 'owner.json'), 'utf8'),
            ).processId,
          ).toBe(process.pid);
          return;
        }
        await winner;
      }

      await assertDualReadBootstrapCommitted(caseRoot);
      await expect(lstat(lockPath)).rejects.toThrow();
    },
  );

  it('does not reclaim an expired lock while its owner process is alive', async () => {
    const caseRoot = path.join(root, 'bootstrap-live-lock');
    await mkdir(caseRoot, { recursive: true });
    await writeLegacyFixture(caseRoot);
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: DUAL_READ_BOOTSTRAP_OPERATION,
          crashAfter: 'prepared',
        },
        () => stageLegacyMigration({ projectRoot: caseRoot }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    const state = await readDualReadBootstrapState(caseRoot);
    const lockPath = dualReadBootstrapLockPath(caseRoot);
    const expired = '2020-01-01T00:00:00.000Z';
    await mkdir(lockPath);
    await writeFile(
      path.join(lockPath, 'owner.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          operationId: state.operationId,
          processId: process.pid,
          acquiredAt: expired,
          leaseExpiresAt: expired,
          statePath: path.relative(
            caseRoot,
            dualReadBootstrapStatePath(caseRoot),
          ),
          stagingDirectory: path.relative(
            caseRoot,
            dualReadBootstrapStagingPath(caseRoot, state.operationId),
          ),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await utimes(lockPath, new Date(expired), new Date(expired));

    try {
      await expect(
        stageLegacyMigration({ projectRoot: caseRoot }),
      ).rejects.toThrow('MANCODE_MIGRATION_BOOTSTRAP_LOCK_HELD');
      await expect(lstat(lockPath)).resolves.toBeDefined();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'replaced'])(
    'does not steal or delete a lock with a %s owner during initialization',
    async (scenario) => {
      await expect(
        withOperationCrashInjectionForTesting(
          {
            operationType: DUAL_READ_BOOTSTRAP_OPERATION,
            crashAfter: 'prepared',
          },
          () => stageLegacyMigration({ projectRoot: root }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
      const state = await readDualReadBootstrapState(root);
      const lockPath = dualReadBootstrapLockPath(root);
      const pause = createOperationLockPauseForTesting({
        operationId: state.operationId,
        pauseAfter: 'bootstrap_lock_created',
      });
      const pending = pause.run(() =>
        stageLegacyMigration({ projectRoot: root }),
      );
      void pending.catch(() => undefined);
      try {
        await pause.reached;
        await utimes(lockPath, new Date(0), new Date(0));
        if (scenario === 'replaced') {
          await writeFile(
            path.join(lockPath, 'owner.json'),
            'unverified owner',
          );
        }
        await expect(
          stageLegacyMigration({ projectRoot: root }),
        ).rejects.toThrow('MANCODE_MIGRATION_BOOTSTRAP_LOCK_STALE_UNVERIFIED');
      } finally {
        pause.release();
        await pending.catch(() => undefined);
      }
      if (scenario === 'missing') {
        await pending;
        await assertDualReadBootstrapCommitted(root);
      } else {
        await expect(pending).rejects.toThrow();
        await expect(
          readFile(path.join(lockPath, 'owner.json'), 'utf8'),
        ).resolves.toBe('unverified owner');
      }
    },
  );

  it('serializes concurrent bootstrap initialization through one lock owner', async () => {
    const caseRoot = path.join(root, 'bootstrap-concurrent');
    await mkdir(caseRoot, { recursive: true });
    await writeLegacyFixture(caseRoot);
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: DUAL_READ_BOOTSTRAP_OPERATION,
          crashAfter: 'prepared',
        },
        () => stageLegacyMigration({ projectRoot: caseRoot }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    const state = await readDualReadBootstrapState(caseRoot);
    const pause = createOperationLockPauseForTesting({
      operationId: state.operationId,
      pauseAfter: 'bootstrap_lock_held',
    });
    const winner = pause.run(() =>
      stageLegacyMigration({ projectRoot: caseRoot }),
    );
    void winner.catch(() => undefined);
    await pause.reached;

    await expect(
      stageLegacyMigration({ projectRoot: caseRoot }),
    ).rejects.toThrow('MANCODE_MIGRATION_BOOTSTRAP_LOCK_HELD');
    pause.release();
    await winner;
    await assertDualReadBootstrapCommitted(caseRoot);
  });

  it('writes only a dual-read shell and local quarantine, then rebuilds a candidate after explicit resolution', async () => {
    const before = await readLegacyAuthorityBytes(root);
    const staged = await stageLegacyMigration({
      projectRoot: root,
      now: new Date('2026-07-17T12:00:00.000Z'),
    });
    const blocked = staged.tasks[0];
    expect(blocked).toMatchObject({
      legacyTaskId: LEGACY_TASK_ID,
      state: 'blocked',
      blockers: ['MANCODE_MIGRATION_OWNER_REQUIRED'],
    });
    expect(await readLegacyAuthorityBytes(root)).toEqual(before);
    expect(
      parseSchemaManifest(
        JSON.parse(
          await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
        ),
      ).activationState,
    ).toBe('dual_read');
    await expect(
      readFile(migrationStagePath(root, staged.stageId), 'utf8'),
    ).resolves.toContain(LEGACY_TASK_ID);
    await expect(
      readFile(
        path.join(
          root,
          '.mancode',
          'local',
          'quarantine',
          blocked?.quarantineId ?? '',
          'candidate.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('legacy_migration');

    const resolved = await resolveLegacyMigration({
      projectRoot: root,
      stageId: staged.stageId,
      legacyTaskId: LEGACY_TASK_ID,
      expectedStageRevision: staged.revision,
      ownerActorId: OWNER_ID,
      now: new Date('2026-07-17T12:01:00.000Z'),
    });

    expect(resolved.revision).toBe(staged.revision + 1);
    expect(resolved.tasks[0]).toMatchObject({
      legacyTaskId: LEGACY_TASK_ID,
      state: 'ready',
      blockers: [],
      privacyStatus: 'passed',
    });
    expect(await readLegacyAuthorityBytes(root)).toEqual(before);
  });

  it('activates a clean local stage through a durable operation without changing legacy authority', async () => {
    const legacyModePath = path.join(
      root,
      '.agents',
      'skills',
      'man',
      'SKILL.md',
    );
    await mkdir(path.dirname(legacyModePath), { recursive: true });
    await writeFile(
      legacyModePath,
      [
        '---',
        'name: man',
        '---',
        '<!-- Managed by mancode:codex-skill. Do not edit this file manually. -->',
        'Read and write `.mancode/state.json`.',
      ].join('\n'),
      'utf8',
    );
    const legacyAliasPath = path.join(
      root,
      '.agents',
      'skills',
      'mamba',
      'SKILL.md',
    );
    await mkdir(path.dirname(legacyAliasPath), { recursive: true });
    await writeFile(
      legacyAliasPath,
      '<!-- Managed by mancode:codex-skill. Do not edit this file manually. -->\nRead and write `.mancode/state.json`.\n',
      'utf8',
    );
    await writeFile(
      path.join(root, 'AGENTS.md'),
      [
        '# User instructions',
        '<!-- mancode:start -->',
        'Legacy mancode instructions read `.mancode/state.json`.',
        '<!-- mancode:end -->',
        '<!-- mancode:zcode:start -->',
        'Legacy ZCode mancode instructions.',
        '<!-- mancode:zcode:end -->',
      ].join('\n'),
      'utf8',
    );
    await mkdir(path.join(root, '.claude', 'skills', 'solo'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.claude', 'skills', 'solo', 'SKILL.md'),
      '<!-- Managed by mancode:claude-skill. Do not edit this marker. -->\nRead `.mancode/state.json`.\n',
      'utf8',
    );
    await writeFile(
      path.join(root, '.claude', 'settings.json'),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'node ".mancode/hooks/session-start.mjs"',
                  },
                  { type: 'command', command: 'node user-hook.mjs' },
                ],
              },
            ],
          },
          permissions: { allow: ['Read'] },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
    await writeFile(
      path.join(root, '.cursor', 'rules', 'mancode-context.mdc'),
      '<!-- Managed by mancode:cursor-rule. Do not edit this marker. -->\nRead `.mancode/state.json`.\n',
      'utf8',
    );
    const before = await readLegacyAuthorityBytes(root);
    const staged = await stageLegacyMigration({ projectRoot: root });
    const resolved = await resolveLegacyMigration({
      projectRoot: root,
      stageId: staged.stageId,
      legacyTaskId: LEGACY_TASK_ID,
      expectedStageRevision: staged.revision,
      ownerActorId: OWNER_ID,
    });
    const actor = await createLocalActor(root, {
      actorId: OWNER_ID,
      displayName: 'Migration owner',
    });
    await publishSharedActorProfile(root, createSharedActorProfile(actor));
    const session = await createSession(root, {
      actorId: actor.actorId,
      client: 'test',
      identitySource: 'explicit',
    });

    const activated = await activateLegacyMigration({
      projectRoot: root,
      stageId: resolved.stageId,
      expectedStageRevision: resolved.revision,
      sessionId: session.sessionId,
      explicitConfirmation: true,
      sharedPrivacyConfirmed: false,
    });

    expect(activated.manifest.activationState).toBe('v3_active');
    expect(activated.stage.state).toBe('activated');
    expect(activated.operation.state).toBe('committed');
    await expect(
      readFile(
        path.join(
          root,
          '.mancode',
          'local',
          'workflows',
          resolved.tasks[0]?.taskRef.taskId ?? '',
          'metadata.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('legacy_migration');
    const migratedMode = await readFile(legacyModePath, 'utf8');
    expect(migratedMode).toContain('# mancode mode: man');
    expect(migratedMode).toContain('mancode workflow create man');
    expect(migratedMode).not.toContain('.mancode/state.json');
    const migratedAlias = await readFile(legacyAliasPath, 'utf8');
    expect(migratedAlias).toContain('# mancode mode compatibility alias');
    expect(migratedAlias).toContain('public mancode mode `manba`');
    expect(migratedAlias).not.toContain('.mancode/state.json');
    const migratedAgents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(migratedAgents).toContain('# User instructions');
    expect(migratedAgents).not.toContain('Legacy mancode instructions');
    expect(migratedAgents).not.toContain('Legacy ZCode mancode instructions');
    expect(migratedAgents).toContain('mancode:continuity:codex:start');
    expect(migratedAgents).toContain('mancode:continuity:zcode:start');
    const migratedClaudeSettings = await readFile(
      path.join(root, '.claude', 'settings.json'),
      'utf8',
    );
    expect(migratedClaudeSettings).not.toContain('session-start.mjs');
    expect(migratedClaudeSettings).toContain('node user-hook.mjs');
    expect(migratedClaudeSettings).toContain('"permissions"');
    await expect(
      readFile(
        path.join(root, '.claude', 'skills', 'solo', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toContain('# mancode mode compatibility alias');
    const retiredCursorRule = await readFile(
      path.join(root, '.cursor', 'rules', 'mancode-context.mdc'),
      'utf8',
    );
    expect(retiredCursorRule).toContain('alwaysApply: false');
    expect(retiredCursorRule).not.toContain('.mancode/state.json');
    expect(await readLegacyAuthorityBytes(root)).toEqual(before);
  });

  it('rolls back only an untouched activation', async () => {
    const legacyModePath = path.join(
      root,
      '.agents',
      'skills',
      'man',
      'SKILL.md',
    );
    const legacyModeContent =
      '<!-- Managed by mancode:codex-skill. Do not edit this file manually. -->\nRead `.mancode/state.json`.\n';
    await mkdir(path.dirname(legacyModePath), { recursive: true });
    await writeFile(legacyModePath, legacyModeContent, 'utf8');
    const staged = await stageLegacyMigration({ projectRoot: root });
    const resolved = await resolveLegacyMigration({
      projectRoot: root,
      stageId: staged.stageId,
      legacyTaskId: LEGACY_TASK_ID,
      expectedStageRevision: staged.revision,
      ownerActorId: OWNER_ID,
    });
    const actor = await createLocalActor(root, {
      actorId: OWNER_ID,
      displayName: 'Migration owner',
    });
    await publishSharedActorProfile(root, createSharedActorProfile(actor));
    const session = await createSession(root, {
      actorId: actor.actorId,
      client: 'test',
      identitySource: 'explicit',
    });
    const activated = await activateLegacyMigration({
      projectRoot: root,
      stageId: resolved.stageId,
      expectedStageRevision: resolved.revision,
      sessionId: session.sessionId,
      explicitConfirmation: true,
      sharedPrivacyConfirmed: false,
    });

    const rolledBack = await rollbackLegacyMigration({
      projectRoot: root,
      operationId: activated.operation.operationId,
      sessionId: session.sessionId,
      explicitConfirmation: true,
    });

    expect(rolledBack.manifest.activationState).toBe('dual_read');
    expect(rolledBack.stage.state).toBe('rolled_back');
    await expect(
      readFile(
        path.join(
          root,
          '.mancode',
          'local',
          'workflows',
          resolved.tasks[0]?.taskRef.taskId ?? '',
          'metadata.json',
        ),
      ),
    ).rejects.toThrow();
    await expect(readFile(legacyModePath, 'utf8')).resolves.toBe(
      legacyModeContent,
    );
  });

  it('refuses rollback after any migrated authority drift', async () => {
    const staged = await stageLegacyMigration({ projectRoot: root });
    const resolved = await resolveLegacyMigration({
      projectRoot: root,
      stageId: staged.stageId,
      legacyTaskId: LEGACY_TASK_ID,
      expectedStageRevision: staged.revision,
      ownerActorId: OWNER_ID,
    });
    const actor = await createLocalActor(root, {
      actorId: OWNER_ID,
      displayName: 'Migration owner',
    });
    await publishSharedActorProfile(root, createSharedActorProfile(actor));
    const session = await createSession(root, {
      actorId: actor.actorId,
      client: 'test',
      identitySource: 'explicit',
    });
    const activated = await activateLegacyMigration({
      projectRoot: root,
      stageId: resolved.stageId,
      expectedStageRevision: resolved.revision,
      sessionId: session.sessionId,
      explicitConfirmation: true,
      sharedPrivacyConfirmed: false,
    });
    await writeFile(
      path.join(
        root,
        '.mancode',
        'local',
        'workflows',
        resolved.tasks[0]?.taskRef.taskId ?? '',
        'plan.md',
      ),
      'unexpected V3 write\n',
      { encoding: 'utf8', flag: 'w' },
    );

    await expect(
      rollbackLegacyMigration({
        projectRoot: root,
        operationId: activated.operation.operationId,
        sessionId: session.sessionId,
        explicitConfirmation: true,
      }),
    ).rejects.toThrow('MANCODE_MIGRATION_ROLLBACK_FORBIDDEN');
  });

  it.each(['absent', 'preexisting', 'user-file'])(
    'preserves directory ownership on rollback and allows retry: %s',
    async (scenario) => {
      const platformRoot = path.join(root, '.claude');
      if (scenario === 'preexisting') {
        await mkdir(path.join(platformRoot, 'skills', 'man'), {
          recursive: true,
        });
      }
      const prepared = await prepareActivationCase(root);
      const activated = await activateLegacyMigration({
        projectRoot: root,
        stageId: prepared.stageId,
        expectedStageRevision: prepared.stageRevision,
        sessionId: prepared.sessionId,
        explicitConfirmation: true,
      });
      if (scenario === 'user-file') {
        await writeFile(
          path.join(platformRoot, 'skills', 'man', 'user.txt'),
          'keep me',
        );
      }
      await rollbackLegacyMigration({
        projectRoot: root,
        operationId: activated.operation.operationId,
        sessionId: prepared.sessionId,
        explicitConfirmation: true,
      });
      if (scenario === 'user-file') {
        await expect(
          readFile(
            path.join(platformRoot, 'skills', 'man', 'user.txt'),
            'utf8',
          ),
        ).resolves.toBe('keep me');
        return;
      }
      if (scenario === 'absent') {
        await expect(lstat(platformRoot)).rejects.toThrow();
      } else {
        await expect(
          lstat(path.join(platformRoot, 'skills', 'man')),
        ).resolves.toBeDefined();
      }
      const retry = await stageLegacyMigration({ projectRoot: root });
      expect(retry.state).toBe('staged');
      expect((await readDualReadBootstrapState(root)).state).toBe('committed');
    },
  );

  it
    .skipIf(process.platform === 'win32')
    .each(['mark-manifest-activating', 'replace-managed-adapters'])(
    'recovers and rolls back shared adapter links after %s',
    async (crashAfter) => {
      const prepared = await prepareActivationCase(root, true);
      await expect(
        withOperationCrashInjectionForTesting(
          {
            operationType: 'v3_activate',
            crashAfter,
            expectedRecovery: 'forward_repair',
          },
          () =>
            activateLegacyMigration({
              projectRoot: root,
              stageId: prepared.stageId,
              expectedStageRevision: prepared.stageRevision,
              sessionId: prepared.sessionId,
              explicitConfirmation: true,
              sharedPrivacyConfirmed: false,
              operationId: ACTIVATION_OPERATION_ID,
            }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
      const recovered = await executeOperationRecovery({
        projectRoot: root,
        operationId: ACTIVATION_OPERATION_ID,
        actorId: OWNER_ID,
        sessionId: prepared.sessionId,
        mode: 'repair',
      });
      expect(recovered.state).toBe('repaired');
      const content = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
      expect(content).toContain(
        '# User instructions\r\nKeep this text unchanged.\r\n',
      );
      for (const platform of ['codex', 'claude']) {
        expect(
          content.split(`<!-- mancode:continuity:${platform}:start -->`),
        ).toHaveLength(2);
      }
      await expect(readlink(path.join(root, 'CLAUDE.md'))).resolves.toBe(
        'AGENTS.md',
      );
      const rolledBack = await rollbackLegacyMigration({
        projectRoot: root,
        operationId: ACTIVATION_OPERATION_ID,
        sessionId: prepared.sessionId,
        explicitConfirmation: true,
      });
      expect(rolledBack.stage.state).toBe('rolled_back');
      await expect(
        readFile(path.join(root, 'AGENTS.md'), 'utf8'),
      ).resolves.toBe(SHARED_ADAPTER_CONTENT);
      await expect(readlink(path.join(root, 'CLAUDE.md'))).resolves.toBe(
        'AGENTS.md',
      );
      expect((await stageLegacyMigration({ projectRoot: root })).state).toBe(
        'staged',
      );
    },
  );

  it('runs the real V3 activation and recovery at every declared crash point', async () => {
    for (const [
      index,
      fixture,
    ] of OPERATION_CRASH_FIXTURES.v3_activate.entries()) {
      const caseRoot = path.join(root, `activation-case-${index}`);
      const prepared = await prepareActivationCase(caseRoot);

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          activateLegacyMigration({
            projectRoot: caseRoot,
            stageId: prepared.stageId,
            expectedStageRevision: prepared.stageRevision,
            sessionId: prepared.sessionId,
            explicitConfirmation: true,
            sharedPrivacyConfirmed: false,
            operationId: ACTIVATION_OPERATION_ID,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      const recovered = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId: ACTIVATION_OPERATION_ID,
        actorId: OWNER_ID,
        sessionId: prepared.sessionId,
        mode: fixture.expectedRecovery === 'safe_abort' ? 'abort' : 'repair',
      });
      if (fixture.expectedRecovery === 'safe_abort') {
        expect(recovered).toMatchObject({
          state: 'aborted',
          journal: { state: 'aborted' },
        });
      } else if (fixture.crashAfter === 'commit') {
        expect(recovered).toMatchObject({
          state: 'already_terminal',
          journal: { state: 'committed' },
        });
      } else {
        expect(recovered).toMatchObject({
          state: 'repaired',
          journal: { state: 'committed' },
        });
      }

      const terminal = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId: ACTIVATION_OPERATION_ID,
        actorId: OWNER_ID,
        sessionId: prepared.sessionId,
      });
      expect(terminal).toMatchObject({
        state: 'already_terminal',
        journal: {
          state:
            fixture.expectedRecovery === 'safe_abort' ? 'aborted' : 'committed',
        },
      });
      expect(
        parseSchemaManifest(
          JSON.parse(
            await readFile(
              path.join(caseRoot, '.mancode', 'schema.json'),
              'utf8',
            ),
          ),
        ).activationState,
      ).toBe(
        fixture.expectedRecovery === 'safe_abort' ? 'dual_read' : 'v3_active',
      );
      expect(
        JSON.parse(
          await readFile(
            migrationStagePath(caseRoot, prepared.stageId),
            'utf8',
          ),
        ).state,
      ).toBe(
        fixture.expectedRecovery === 'safe_abort' ? 'staged' : 'activated',
      );
    }
  }, 20_000);
});

async function prepareActivationCase(
  projectRoot: string,
  sharedAdapter = false,
): Promise<{
  stageId: string;
  stageRevision: number;
  sessionId: string;
}> {
  await mkdir(projectRoot, { recursive: true });
  await writeLegacyFixture(projectRoot);
  if (sharedAdapter) {
    await writeFile(
      path.join(projectRoot, 'AGENTS.md'),
      SHARED_ADAPTER_CONTENT,
    );
    await symlink('AGENTS.md', path.join(projectRoot, 'CLAUDE.md'));
  }
  const staged = await stageLegacyMigration({ projectRoot });
  const resolved = await resolveLegacyMigration({
    projectRoot,
    stageId: staged.stageId,
    legacyTaskId: LEGACY_TASK_ID,
    expectedStageRevision: staged.revision,
    ownerActorId: OWNER_ID,
  });
  const actor = await createLocalActor(projectRoot, {
    actorId: OWNER_ID,
    displayName: 'Migration crash owner',
  });
  await publishSharedActorProfile(projectRoot, createSharedActorProfile(actor));
  const session = await createSession(projectRoot, {
    actorId: actor.actorId,
    client: 'crash-test',
    identitySource: 'explicit',
  });
  return {
    stageId: resolved.stageId,
    stageRevision: resolved.revision,
    sessionId: session.sessionId,
  };
}

async function writeLegacyFixture(root: string): Promise<void> {
  const workflowRoot = path.join(root, '.mancode', 'workflows', LEGACY_TASK_ID);
  await mkdir(path.join(workflowRoot, 'reports'), { recursive: true });
  await writeFile(
    path.join(root, '.mancode', 'state.json'),
    `${JSON.stringify(
      {
        version: '0.3.9',
        currentMode: 'man',
        lastMode: 'solo',
        platform: 'claude-code',
        initializedAt: '2026-07-17T09:00:00.000Z',
        techStack: 'TypeScript',
        uiLibrary: 'None',
        currentTask: LEGACY_TASK_ID,
        currentWorkflowMode: 'man',
        skippedSteps: [],
        activeSoloPlan: null,
        teamModeAutoDetected: false,
        contributors: 1,
        projectMode: 'detected',
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(workflowRoot, 'metadata.json'),
    `${JSON.stringify(
      {
        taskId: LEGACY_TASK_ID,
        task: 'Add login rate limits.',
        mode: 'man',
        currentStep: 9,
        skippedSteps: [],
        startedAt: '2026-07-17T10:00:00.000Z',
        updatedAt: '2026-07-17T11:00:00.000Z',
        status: 'in_progress',
        planVersion: 2,
        planningPolicyVersion: 2,
        reviewPolicyVersion: 1,
        verificationPolicyVersion: 1,
        requirementsStatus: 'ready',
        requirementsDigest:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        planDecision: 'governed_execution',
        verificationStatus: 'passed',
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(workflowRoot, 'requirements.json'),
    `${JSON.stringify(
      {
        version: 1,
        goal: 'Protect the login endpoint from repeated failed attempts.',
        confirmedScope: ['Protect the login endpoint.'],
        excludedScope: ['Change account recovery.'],
        technicalDecisions: ['Use the existing Redis client.'],
        defaults: ['Use the project test runner.'],
        blockingUnknowns: [],
        coverage: [
          'platform',
          'core_scope',
          'technical_stack',
          'data_and_persistence',
          'performance',
          'compatibility',
          'security',
        ].map((dimension) => ({
          dimension,
          status: 'confirmed',
          rationale: `${dimension} is covered.`,
        })),
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Repeated failures receive a rate-limit response.',
            required: true,
            method: 'hybrid',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(workflowRoot, 'review-ledger.json'),
    `${JSON.stringify(
      {
        version: '1.0',
        depth: 'full',
        requiredDomains: ['quality', 'security'],
        completedDomains: ['quality', 'security'],
        reports: {
          quality: 'reports/quality.md',
          security: 'reports/security.md',
        },
        blockers: [],
        remediationRounds: 0,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(workflowRoot, 'reports', 'quality.md'),
    '# Quality\n',
  );
  await writeFile(
    path.join(workflowRoot, 'reports', 'security.md'),
    '# Security\n',
  );
  await writeFile(
    path.join(workflowRoot, 'reports', 'evidence.md'),
    '# Evidence\n',
  );
  await writeFile(
    path.join(workflowRoot, 'verification-ledger.json'),
    `${JSON.stringify(
      {
        version: 1,
        planVersion: 2,
        requirementsDigest:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        remediationRound: 0,
        status: 'passed',
        checks: [
          {
            acceptanceId: 'AC-1',
            required: true,
            automated: {
              status: 'passed',
              evidence: 'Automated checks passed.',
              updatedAt: '2026-07-17T11:00:00.000Z',
              command: 'npm test',
              exitCode: 0,
              evidenceFile: 'reports/evidence.md',
            },
            manual: {
              status: 'passed',
              evidence: 'A legacy reviewer confirmed the behavior.',
              updatedAt: '2026-07-17T11:00:00.000Z',
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

async function readDualReadBootstrapState(root: string) {
  return parseDualReadBootstrapState(
    JSON.parse(await readFile(dualReadBootstrapStatePath(root), 'utf8')),
  );
}

async function assertDualReadBootstrapCommitted(root: string): Promise<void> {
  const state = await readDualReadBootstrapState(root);
  expect(state.state).toBe('committed');
  expect(state.targets.every((target) => target.state === 'published')).toBe(
    true,
  );
  for (const target of state.targets) {
    await expect(
      readFile(path.join(root, ...target.relativePath.split('/')), 'utf8'),
    ).resolves.toBe(target.targetContent);
  }
  await expect(lstat(dualReadBootstrapLockPath(root))).rejects.toThrow();
  await expect(
    lstat(dualReadBootstrapStagingPath(root, state.operationId)),
  ).rejects.toThrow();
}

async function readLegacyAuthorityBytes(
  root: string,
): Promise<Record<string, string>> {
  const taskRoot = path.join(root, '.mancode', 'workflows', LEGACY_TASK_ID);
  const files = [
    path.join(root, '.mancode', 'state.json'),
    path.join(taskRoot, 'metadata.json'),
    path.join(taskRoot, 'requirements.json'),
    path.join(taskRoot, 'review-ledger.json'),
    path.join(taskRoot, 'verification-ledger.json'),
    path.join(taskRoot, 'reports', 'quality.md'),
    path.join(taskRoot, 'reports', 'security.md'),
    path.join(taskRoot, 'reports', 'evidence.md'),
  ];
  const entries = await Promise.all(
    files.map(
      async (file) =>
        [path.relative(root, file), await readFile(file, 'utf8')] as const,
    ),
  );
  return Object.fromEntries(entries);
}

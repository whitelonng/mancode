import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({
  activate: vi.fn(),
  dryRun: vi.fn(),
  list: vi.fn(),
  resolve: vi.fn(),
  rollback: vi.fn(),
  stage: vi.fn(),
}));

vi.mock('../src/context/migrate.js', () => ({
  activateLegacyMigration: engine.activate,
  dryRunLegacyMigration: engine.dryRun,
  listMigrationStages: engine.list,
  resolveLegacyMigration: engine.resolve,
  rollbackLegacyMigration: engine.rollback,
  stageLegacyMigration: engine.stage,
}));

import { createCliProgram } from '../src/cli.js';
import {
  EXIT_INVALID_ARG,
  EXIT_MIGRATION_BLOCKED,
  EXIT_OK,
  migrateContext,
  migrateContextResolve,
} from '../src/commands/migrate.js';

const STAGE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const OWNER_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';

describe('migration command contract', () => {
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = path.join(
      tmpdir(),
      `mancode-migrate-command-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    engine.dryRun.mockResolvedValue({ schemaVersion: 1, tasks: [] });
    engine.stage.mockResolvedValue(stage('staged', 1));
    engine.list.mockResolvedValue([stage('staged', 1)]);
    engine.activate.mockResolvedValue({
      manifest: { activationState: 'v3_active' },
      stage: stage('activated', 2),
      operation: { operationId: OPERATION_ID, state: 'committed' },
    });
    engine.rollback.mockResolvedValue({
      manifest: { activationState: 'dual_read' },
      stage: stage('rolled_back', 3),
    });
    engine.resolve.mockResolvedValue(stage('staged', 2));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns stable JSON errors for invalid operation and resolution inputs', async () => {
    await expectJson(
      () => migrateContext(root, { json: true }),
      EXIT_INVALID_ARG,
      'MANCODE_MIGRATION_ARGUMENT_INVALID',
    );
    await expectJson(
      () =>
        migrateContext(root, {
          dryRun: true,
          status: true,
          json: true,
        }),
      EXIT_INVALID_ARG,
      'MANCODE_MIGRATION_ARGUMENT_INVALID',
    );
    await expectJson(
      () => migrateContext(root, { activate: true, json: true }),
      EXIT_MIGRATION_BLOCKED,
      'MANCODE_SESSION_REQUIRED',
    );
    await expectJson(
      () =>
        migrateContext(root, {
          activate: true,
          session: SESSION_ID,
          expectedStageRevision: '0',
          json: true,
        }),
      EXIT_MIGRATION_BLOCKED,
      'MANCODE_MIGRATION_STAGE_REVISION_INVALID',
    );
    await expectJson(
      () =>
        migrateContextResolve(root, 'legacy-task', {
          stageId: STAGE_ID,
          expectedStageRevision: '1',
          scopeFile: '../outside.json',
          json: true,
        }),
      EXIT_MIGRATION_BLOCKED,
      'MANCODE_MIGRATION_SCOPE_FILE_INVALID',
    );
    engine.list.mockResolvedValueOnce([]);
    await expectJson(
      () =>
        migrateContext(root, {
          activate: true,
          session: SESSION_ID,
          expectedStageRevision: '1',
          json: true,
        }),
      EXIT_MIGRATION_BLOCKED,
      'MANCODE_MIGRATION_STAGE_NOT_FOUND',
    );
  });

  it('routes dry-run, stage, status, activation, rollback, and resolution', async () => {
    await expect(
      captureJson(() => migrateContext(root, { dryRun: true, json: true })),
    ).resolves.toMatchObject({ exitCode: EXIT_OK, value: { tasks: [] } });
    expect(engine.dryRun).toHaveBeenCalledWith(root);

    await expect(
      captureJson(() => migrateContext(root, { stage: true, json: true })),
    ).resolves.toMatchObject({
      exitCode: EXIT_OK,
      value: { stageId: STAGE_ID, state: 'staged' },
    });
    expect(engine.stage).toHaveBeenCalledWith({ projectRoot: root });

    await expect(
      captureJson(() => migrateContext(root, { status: true, json: true })),
    ).resolves.toMatchObject({
      exitCode: EXIT_OK,
      value: { schemaVersion: 1, stages: [{ stageId: STAGE_ID }] },
    });

    await expect(
      captureJson(() =>
        migrateContext(root, {
          activate: true,
          expectedStageRevision: '1',
          session: SESSION_ID,
          confirm: true,
          confirmShared: true,
          json: true,
        }),
      ),
    ).resolves.toMatchObject({
      exitCode: EXIT_OK,
      value: { manifest: { activationState: 'v3_active' } },
    });
    expect(engine.activate).toHaveBeenCalledWith({
      projectRoot: root,
      stageId: STAGE_ID,
      expectedStageRevision: 1,
      sessionId: SESSION_ID,
      explicitConfirmation: true,
      sharedPrivacyConfirmed: true,
    });

    await expect(
      captureJson(() =>
        migrateContext(root, {
          rollback: OPERATION_ID,
          session: SESSION_ID,
          confirm: true,
          json: true,
        }),
      ),
    ).resolves.toMatchObject({
      exitCode: EXIT_OK,
      value: { manifest: { activationState: 'dual_read' } },
    });
    expect(engine.rollback).toHaveBeenCalledWith({
      projectRoot: root,
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      explicitConfirmation: true,
    });

    await writeFile(
      path.join(root, 'scope.json'),
      JSON.stringify({
        include: ['src/**'],
        exclude: [],
        modules: ['runtime'],
      }),
    );
    await expect(
      captureJson(() =>
        migrateContextResolve(root, 'legacy-task', {
          stageId: STAGE_ID,
          expectedStageRevision: '1',
          owner: OWNER_ID,
          scopeFile: 'scope.json',
          json: true,
        }),
      ),
    ).resolves.toMatchObject({
      exitCode: EXIT_OK,
      value: { stageId: STAGE_ID, revision: 2 },
    });
    expect(engine.resolve).toHaveBeenCalledWith({
      projectRoot: root,
      stageId: STAGE_ID,
      legacyTaskId: 'legacy-task',
      expectedStageRevision: 1,
      ownerActorId: OWNER_ID,
      implementationScope: {
        include: ['src/**'],
        exclude: [],
        modules: ['runtime'],
      },
    });
  });

  it('normalizes engine failures into the documented error envelope', async () => {
    engine.dryRun.mockRejectedValueOnce(
      new Error('MANCODE_MIGRATION_LEGACY_PATH_UNSAFE:details'),
    );
    await expectJson(
      () => migrateContext(root, { dryRun: true, json: true }),
      EXIT_MIGRATION_BLOCKED,
      'MANCODE_MIGRATION_LEGACY_PATH_UNSAFE',
    );
    engine.resolve.mockRejectedValueOnce(new Error('unexpected failure'));
    await expectJson(
      () =>
        migrateContextResolve(root, 'legacy-task', {
          stageId: STAGE_ID,
          expectedStageRevision: '1',
          json: true,
        }),
      EXIT_MIGRATION_BLOCKED,
      'MANCODE_MIGRATION_FAILED',
    );
  });

  describe.each(['dryRun', 'stage'] as const)(
    '%s platform selection',
    (operation) => {
      it.each([
        [
          'codex,cursor',
          { codex: 'legacy-unmanaged', cursor: 'legacy-unmanaged' },
        ],
        [' Codex, codex ', { codex: 'legacy-unmanaged' }],
        ['none', {}],
        [' NONE ', {}],
        [
          'all',
          {
            'claude-code': 'legacy-unmanaged',
            cursor: 'legacy-unmanaged',
            codex: 'legacy-unmanaged',
            copilot: 'legacy-unmanaged',
            zcode: 'legacy-unmanaged',
            'kimi-code': 'legacy-unmanaged',
            qoder: 'legacy-unmanaged',
            dsh: 'legacy-unmanaged',
          },
        ],
      ])(
        'passes %s as an explicit inventory',
        async (platform, managedAdapters) => {
          await expect(
            captureJson(() =>
              migrateContext(root, { [operation]: true, platform, json: true }),
            ),
          ).resolves.toMatchObject({ exitCode: EXIT_OK });
          if (operation === 'dryRun') {
            expect(engine.dryRun).toHaveBeenCalledExactlyOnceWith(
              root,
              managedAdapters,
            );
          } else {
            expect(engine.stage).toHaveBeenCalledExactlyOnceWith({
              projectRoot: root,
              managedAdapters,
            });
          }
        },
      );

      it.each([
        'unknown',
        'codex,unknown',
        'none,codex',
        'all,codex',
        '',
        ' , ',
      ])(
        'rejects invalid selection %j before invoking the engine',
        async (platform) => {
          await expectJson(
            () =>
              migrateContext(root, { [operation]: true, platform, json: true }),
            EXIT_INVALID_ARG,
            'MANCODE_MIGRATION_ARGUMENT_INVALID',
          );
          for (const method of Object.values(engine)) {
            expect(method).not.toHaveBeenCalled();
          }
        },
      );
    },
  );

  it.each([{ status: true }, { activate: true }, { rollback: OPERATION_ID }])(
    'rejects platform selection for %j before invoking the engine',
    async (operation) => {
      await expectJson(
        () =>
          migrateContext(root, { ...operation, platform: 'none', json: true }),
        EXIT_INVALID_ARG,
        'MANCODE_MIGRATION_ARGUMENT_INVALID',
      );
      for (const method of Object.values(engine)) {
        expect(method).not.toHaveBeenCalled();
      }
    },
  );

  it('passes an explicit stage ID without adding an omitted inventory', async () => {
    await expect(
      captureJson(() =>
        migrateContext(root, { stage: true, stageId: STAGE_ID, json: true }),
      ),
    ).resolves.toMatchObject({ exitCode: EXIT_OK });
    expect(engine.stage).toHaveBeenCalledExactlyOnceWith({
      projectRoot: root,
      stageId: STAGE_ID,
    });
  });

  it.each(['--dry-run', '--stage'])(
    'exposes --platform through the %s CLI entry',
    async (operation) => {
      const previousExitCode = process.exitCode;
      try {
        await expect(
          captureJson(async () => {
            await createCliProgram()
              .exitOverride()
              .parseAsync(
                [
                  'migrate',
                  'context',
                  operation,
                  '--platform',
                  'codex,cursor',
                  ...(operation === '--stage' ? ['--stage-id', STAGE_ID] : []),
                  '--json',
                ],
                { from: 'user' },
              );
            return Number(process.exitCode);
          }),
        ).resolves.toMatchObject({ exitCode: EXIT_OK });
        const managedAdapters = {
          codex: 'legacy-unmanaged',
          cursor: 'legacy-unmanaged',
        };
        if (operation === '--dry-run') {
          expect(engine.dryRun).toHaveBeenCalledExactlyOnceWith(
            process.cwd(),
            managedAdapters,
          );
        } else {
          expect(engine.stage).toHaveBeenCalledExactlyOnceWith({
            projectRoot: process.cwd(),
            stageId: STAGE_ID,
            managedAdapters,
          });
        }
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  it('forwards resolution options consumed by the parent to the child service', async () => {
    const previousExitCode = process.exitCode;
    try {
      const output = await captureJson(async () => {
        await createCliProgram()
          .exitOverride()
          .parseAsync(
            [
              'migrate',
              'context',
              'resolve',
              'legacy-task',
              '--stage-id',
              STAGE_ID,
              '--expected-stage-revision',
              '1',
              '--owner',
              OWNER_ID,
              '--json',
            ],
            { from: 'user' },
          );
        return Number(process.exitCode);
      });
      expect(output.exitCode).toBe(EXIT_OK);
      expect(engine.resolve).toHaveBeenCalledExactlyOnceWith({
        projectRoot: process.cwd(),
        stageId: STAGE_ID,
        legacyTaskId: 'legacy-task',
        expectedStageRevision: 1,
        ownerActorId: OWNER_ID,
        implementationScope: undefined,
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('still rejects resolution without a revision through the CLI', async () => {
    const previousExitCode = process.exitCode;
    try {
      const output = await captureJson(async () => {
        await createCliProgram().parseAsync(
          [
            'migrate',
            'context',
            'resolve',
            'legacy-task',
            '--stage-id',
            STAGE_ID,
            '--owner',
            OWNER_ID,
            '--json',
          ],
          { from: 'user' },
        );
        return Number(process.exitCode);
      });
      expect(output).toMatchObject({
        exitCode: EXIT_MIGRATION_BLOCKED,
        value: { error: { code: 'MANCODE_MIGRATION_STAGE_REVISION_INVALID' } },
      });
      expect(engine.resolve).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

function stage(state: string, revision: number) {
  return {
    schemaVersion: 1,
    stageId: STAGE_ID,
    revision,
    state,
    tasks: [],
  };
}

async function expectJson(
  operation: () => Promise<number>,
  exitCode: number,
  errorCode: string,
): Promise<void> {
  await expect(captureJson(operation)).resolves.toMatchObject({
    exitCode,
    value: { schemaVersion: 1, error: { code: errorCode } },
  });
}

async function captureJson(operation: () => Promise<number>): Promise<{
  exitCode: number;
  value: unknown;
}> {
  const output: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => {
    output.push(String(value));
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const exitCode = await operation();
    const serialized = output.at(-1);
    if (serialized === undefined)
      throw new Error('missing migration JSON output');
    return { exitCode, value: JSON.parse(serialized) };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

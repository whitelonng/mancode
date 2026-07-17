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

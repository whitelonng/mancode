import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUlid } from '../context/ids.js';
import {
  type MigrationScopeResolutionV1,
  activateLegacyMigration,
  dryRunLegacyMigration,
  listMigrationStages,
  resolveLegacyMigration,
  rollbackLegacyMigration,
  stageLegacyMigration,
} from '../context/migrate.js';

export const EXIT_OK = 0;
export const EXIT_INVALID_ARG = 2;
export const EXIT_MIGRATION_BLOCKED = 3;

export interface MigrateContextOptions {
  dryRun?: boolean;
  stage?: boolean;
  status?: boolean;
  activate?: boolean;
  rollback?: string;
  stageId?: string;
  expectedStageRevision?: string;
  session?: string;
  confirm?: boolean;
  confirmShared?: boolean;
  json?: boolean;
}

export interface MigrateResolveOptions {
  stageId?: string;
  expectedStageRevision?: string;
  owner?: string;
  scopeFile?: string;
  json?: boolean;
}

/** Implements `mancode migrate context --dry-run|--stage|--status|--activate`. */
export async function migrateContext(
  rootDir: string,
  options: MigrateContextOptions,
): Promise<number> {
  const selected = [
    options.dryRun === true,
    options.stage === true,
    options.status === true,
    options.activate === true,
    options.rollback !== undefined,
  ].filter(Boolean).length;
  if (selected !== 1) {
    return printError(
      options.json,
      'MANCODE_MIGRATION_ARGUMENT_INVALID',
      'Choose exactly one migration operation.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    if (options.dryRun) {
      return printResult(options.json, await dryRunLegacyMigration(rootDir));
    }
    if (options.stage) {
      return printResult(
        options.json,
        await stageLegacyMigration({ projectRoot: rootDir }),
      );
    }
    if (options.status) {
      return printResult(options.json, {
        schemaVersion: 1,
        stages: await listMigrationStages(rootDir),
      });
    }
    if (options.session === undefined) {
      throw new Error('MANCODE_SESSION_REQUIRED');
    }
    assertUlid(options.session, 'migration activation session');
    if (options.rollback !== undefined) {
      assertUlid(options.rollback, 'migration rollback operation');
      return printResult(
        options.json,
        await rollbackLegacyMigration({
          projectRoot: rootDir,
          operationId: options.rollback,
          sessionId: options.session,
          explicitConfirmation: options.confirm === true,
        }),
      );
    }
    const stageId = await selectStageId(rootDir, options.stageId);
    return printResult(
      options.json,
      await activateLegacyMigration({
        projectRoot: rootDir,
        stageId,
        expectedStageRevision: parseRevision(options.expectedStageRevision),
        sessionId: options.session,
        explicitConfirmation: options.confirm === true,
        sharedPrivacyConfirmed: options.confirmShared === true,
      }),
    );
  } catch (error) {
    return printError(
      options.json,
      errorCode(error),
      error instanceof Error ? error.message : 'Migration failed.',
      EXIT_MIGRATION_BLOCKED,
    );
  }
}

/** Implements `mancode migrate context resolve <legacyTaskId> ...`. */
export async function migrateContextResolve(
  rootDir: string,
  legacyTaskId: string,
  options: MigrateResolveOptions,
): Promise<number> {
  try {
    const stageId = await selectStageId(rootDir, options.stageId);
    const expectedStageRevision = parseRevision(options.expectedStageRevision);
    const owner =
      options.owner === undefined ? undefined : parseActorId(options.owner);
    const implementationScope =
      options.scopeFile === undefined
        ? undefined
        : await readScopeFile(rootDir, options.scopeFile);
    const result = await resolveLegacyMigration({
      projectRoot: rootDir,
      stageId,
      legacyTaskId,
      expectedStageRevision,
      ownerActorId: owner,
      implementationScope,
    });
    return printResult(options.json, result);
  } catch (error) {
    return printError(
      options.json,
      errorCode(error),
      error instanceof Error ? error.message : 'Migration resolution failed.',
      EXIT_MIGRATION_BLOCKED,
    );
  }
}

async function selectStageId(
  rootDir: string,
  provided: string | undefined,
): Promise<string> {
  if (provided !== undefined) {
    assertUlid(provided, 'migration stageId');
    return provided;
  }
  const mutable = (await listMigrationStages(rootDir)).filter(
    (stage) => stage.state === 'staged',
  );
  if (mutable.length === 0)
    throw new Error('MANCODE_MIGRATION_STAGE_NOT_FOUND');
  if (mutable.length > 1) throw new Error('MANCODE_MIGRATION_STAGE_AMBIGUOUS');
  const stage = mutable[0];
  if (stage === undefined) throw new Error('MANCODE_MIGRATION_STAGE_NOT_FOUND');
  return stage.stageId;
}

function parseRevision(value: string | undefined): number {
  if (
    value === undefined ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error('MANCODE_MIGRATION_STAGE_REVISION_INVALID');
  }
  return Number(value);
}

function parseActorId(value: string): string {
  assertUlid(value, 'migration resolution owner');
  return value;
}

async function readScopeFile(
  rootDir: string,
  file: string,
): Promise<MigrationScopeResolutionV1> {
  if (!file.trim() || file.includes('\0')) {
    throw new Error('MANCODE_MIGRATION_SCOPE_FILE_INVALID');
  }
  const resolved = path.resolve(rootDir, file);
  const relative = path.relative(path.resolve(rootDir), resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('MANCODE_MIGRATION_SCOPE_FILE_INVALID');
  }
  try {
    return JSON.parse(
      await readFile(resolved, 'utf8'),
    ) as MigrationScopeResolutionV1;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_MIGRATION_SCOPE_FILE_INVALID');
    }
    throw error;
  }
}

function printResult(json: boolean | undefined, result: unknown): number {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return EXIT_OK;
}

function printError(
  json: boolean | undefined,
  code: string,
  message: string,
  exitCode: number,
): number {
  const result = { schemaVersion: 1, error: { code, message } };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`✗  ${code}`);
    console.error(`   ${message}`);
  }
  return exitCode;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('MANCODE_')) {
    return error.message.split(':', 1)[0] ?? 'MANCODE_MIGRATION_FAILED';
  }
  return 'MANCODE_MIGRATION_FAILED';
}

import { assertUlid } from '../context/ids.js';
import {
  executeOperationRecovery,
  inspectOperationRecovery,
} from '../runtime/operation-recovery-executor.js';
import {
  EXIT_V3_INVALID_ARGUMENT,
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  v3ErrorCode,
} from './v3-support.js';

export interface OperationShowOptions {
  json?: boolean;
}

export interface OperationMutationOptions extends OperationShowOptions {
  session?: string;
  client?: string;
}

export async function operationShow(
  rootDir: string,
  operationId: string | undefined,
  options: OperationShowOptions,
): Promise<number> {
  if (operationId === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_OPERATION_ID_REQUIRED',
      'operation show requires an operation ULID.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    assertUlid(operationId, 'operationId');
    const project = await readV3CommandProject(rootDir);
    const result = await inspectOperationRecovery(
      project.projectRoot,
      operationId,
    );
    return printV3Result(options.json, { schemaVersion: 1, ...result });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_OPERATION_SHOW_FAILED'),
      error instanceof Error ? error.message : 'Unable to inspect operation.',
    );
  }
}

export async function operationRepair(
  rootDir: string,
  operationId: string | undefined,
  options: OperationMutationOptions,
): Promise<number> {
  return runOperationMutation(rootDir, operationId, options, 'repair');
}

export async function operationAbort(
  rootDir: string,
  operationId: string | undefined,
  options: OperationMutationOptions,
): Promise<number> {
  return runOperationMutation(rootDir, operationId, options, 'abort');
}

async function runOperationMutation(
  rootDir: string,
  operationId: string | undefined,
  options: OperationMutationOptions,
  mode: 'repair' | 'abort',
): Promise<number> {
  if (operationId === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_OPERATION_ID_REQUIRED',
      `operation ${mode} requires an operation ULID.`,
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    assertUlid(operationId, 'operationId');
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const result = await executeOperationRecovery({
      projectRoot: project.projectRoot,
      operationId,
      actorId: session.actorId,
      sessionId: session.sessionId,
      mode,
    });
    return printV3Result(options.json, { schemaVersion: 1, ...result });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(
        error,
        mode === 'repair'
          ? 'MANCODE_OPERATION_REPAIR_FAILED'
          : 'MANCODE_OPERATION_ABORT_FAILED',
      ),
      error instanceof Error ? error.message : 'Unable to recover operation.',
    );
  }
}

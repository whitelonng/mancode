import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import {
  type AuthorizationBasisV1,
  parseAuthorizationBasis,
} from '../team/authorization.js';
import { digestCanonicalJson } from './canonical.js';
import {
  type ConfirmedDecision,
  type ConfirmedDecisionV2,
  DECISION_RELATIONS_CAPABILITY,
  assertDecisionRelationsPublishable,
  parseDecisionDetails,
} from './decision-record.js';
import { type Ulid, assertUlid } from './ids.js';
import { withSharedPrivacyWrite } from './privacy-guard.js';
import { assertSharedTextSafe } from './privacy.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

/** One privacy-reviewed, immutable decision that may inform shared planning. */
export interface ConfirmedDecisionV1 {
  schemaVersion: 1;
  decisionId: Ulid;
  title: string;
  statement: string;
  taskRef: TaskRef | null;
  confirmedByActorId: Ulid;
  confirmedAt: string;
  operationId: Ulid;
  authorization: AuthorizationBasisV1;
}

export interface CreateConfirmedDecisionInput {
  decisionId: Ulid;
  title: string;
  statement: string;
  taskRef?: TaskRef | null;
  actorId: Ulid;
  operationId: Ulid;
  authorization: AuthorizationBasisV1;
  now?: Date;
}

const DECISION_FILENAME = /^[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}\.json$/;

export function createConfirmedDecision(
  input: CreateConfirmedDecisionInput,
): ConfirmedDecisionV1 {
  assertUlid(input.decisionId, 'confirmed decision decisionId');
  assertUlid(input.actorId, 'confirmed decision actorId');
  assertUlid(input.operationId, 'confirmed decision operationId');
  const authorization = parseAuthorizationBasis(input.authorization);
  if (
    authorization.action !== 'confirmed_decision_publish' ||
    authorization.actorId !== input.actorId
  ) {
    throw new Error('MANCODE_CONFIRMED_DECISION_AUTHORIZATION_INVALID');
  }
  return parseConfirmedDecisionV1({
    schemaVersion: 1,
    decisionId: input.decisionId,
    title: parseDecisionText(input.title, 'confirmed decision title', 256),
    statement: parseDecisionText(
      input.statement,
      'confirmed decision statement',
      12_000,
    ),
    taskRef: input.taskRef === undefined ? null : input.taskRef,
    confirmedByActorId: input.actorId,
    confirmedAt: (input.now ?? new Date()).toISOString(),
    operationId: input.operationId,
    authorization,
  });
}

function parseConfirmedDecisionV1(value: unknown): ConfirmedDecisionV1 {
  assertRecord(value, 'confirmed decision');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'decisionId',
      'title',
      'statement',
      'taskRef',
      'confirmedByActorId',
      'confirmedAt',
      'operationId',
      'authorization',
    ],
    'confirmed decision',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('confirmed decision schemaVersion must be 1');
  }
  assertUlid(value.decisionId, 'confirmed decision decisionId');
  assertUlid(value.confirmedByActorId, 'confirmed decision confirmedByActorId');
  assertUlid(value.operationId, 'confirmed decision operationId');
  const authorization = parseAuthorizationBasis(value.authorization);
  if (
    authorization.action !== 'confirmed_decision_publish' ||
    authorization.actorId !== value.confirmedByActorId
  ) {
    throw new Error('MANCODE_CONFIRMED_DECISION_AUTHORIZATION_INVALID');
  }
  const taskRef =
    value.taskRef === null ? null : parseTaskRefValue(value.taskRef);
  if (taskRef?.namespace === 'local') {
    throw new Error('MANCODE_CONFIRMED_DECISION_LOCAL_TASK_FORBIDDEN');
  }
  return {
    schemaVersion: 1,
    decisionId: value.decisionId,
    title: parseDecisionText(value.title, 'confirmed decision title', 256),
    statement: parseDecisionText(
      value.statement,
      'confirmed decision statement',
      12_000,
    ),
    taskRef,
    confirmedByActorId: value.confirmedByActorId,
    confirmedAt: parseTimestamp(
      value.confirmedAt,
      'confirmed decision confirmedAt',
    ),
    operationId: value.operationId,
    authorization,
  };
}

export function parseConfirmedDecision(value: unknown): ConfirmedDecision {
  assertRecord(value, 'confirmed decision');
  if (value.schemaVersion === 1) return parseConfirmedDecisionV1(value);
  if (value.schemaVersion !== 2)
    throw new Error('MANCODE_DECISION_SCHEMA_UNSUPPORTED');
  const { details, schemaVersion: _version, ...base } = value;
  const checked = parseConfirmedDecisionV1({ ...base, schemaVersion: 1 });
  return {
    ...checked,
    schemaVersion: 2,
    details: parseDecisionDetails(details),
  };
}

export function createStructuredDecision(
  input: CreateConfirmedDecisionInput,
  details: unknown,
): ConfirmedDecisionV2 {
  return {
    ...createConfirmedDecision(input),
    schemaVersion: 2,
    details: parseDecisionDetails(details),
  };
}

export function confirmedDecisionDigest(decision: ConfirmedDecision): string {
  return digestCanonicalJson(parseConfirmedDecision(decision));
}

export function confirmedDecisionDirectory(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'shared',
    'memory',
    'decisions',
  );
}

export function confirmedDecisionPath(
  projectRoot: string,
  decisionId: string,
): string {
  assertUlid(decisionId, 'confirmed decision decisionId');
  return path.join(
    confirmedDecisionDirectory(projectRoot),
    `${decisionId}.json`,
  );
}

/**
 * Immutable publication is the decision commit point. An audit event may be
 * emitted afterwards and retried, but it never rolls this authority back.
 */
export async function publishConfirmedDecision(
  projectRoot: string,
  decision: ConfirmedDecision,
  options: {
    confirmFormatUpgrade?: boolean;
    writerCapabilities?: readonly string[];
  } = {},
): Promise<ConfirmedDecision> {
  const parsed = parseConfirmedDecision(decision);
  if (
    parsed.schemaVersion === 2 &&
    (!options.confirmFormatUpgrade ||
      !options.writerCapabilities?.includes(DECISION_RELATIONS_CAPABILITY))
  )
    throw new Error('MANCODE_DECISION_FORMAT_UPGRADE_REQUIRED');
  if (parsed.schemaVersion === 2) await readProjectRuntimeContext(projectRoot);
  const committed = await withSharedPrivacyWrite(
    projectRoot,
    parsed.operationId,
    parsed,
    async () => {
      const existing = await readConfirmedDecision(
        projectRoot,
        parsed.decisionId,
      );
      if (existing) {
        if (
          confirmedDecisionDigest(existing) === confirmedDecisionDigest(parsed)
        )
          return existing;
        throw new Error('MANCODE_CONFIRMED_DECISION_ID_CONFLICT');
      }
      if (parsed.schemaVersion === 2)
        assertDecisionRelationsPublishable(
          await listConfirmedDecisions(projectRoot),
          parsed,
        );
      await (
        await import('../runtime/project-progress-events.js')
      ).markProgressCommitPending(projectRoot, parsed.operationId);
      return publishConfirmedDecisionUnlocked(projectRoot, parsed);
    },
  );
  try {
    const { notifyCommittedProgress } = await import(
      '../runtime/project-progress-events.js'
    );
    await notifyCommittedProgress(
      projectRoot,
      { project: true },
      undefined,
      parsed.operationId,
    );
  } catch {
    console.error(
      'Project progress update pending (MANCODE_PROGRESS_UPDATE_FAILED); run mancode progress refresh.',
    );
  }
  return committed;
}

async function publishConfirmedDecisionUnlocked(
  projectRoot: string,
  decision: ConfirmedDecision,
): Promise<ConfirmedDecision> {
  const parsed = parseConfirmedDecision(decision);
  const directory = confirmedDecisionDirectory(projectRoot);
  await ensureSafeDirectory(projectRoot, directory);
  const target = confirmedDecisionPath(projectRoot, parsed.decisionId);
  try {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await link(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return parsed;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readConfirmedDecision(
      projectRoot,
      parsed.decisionId,
    );
    if (
      existing !== null &&
      confirmedDecisionDigest(existing) === confirmedDecisionDigest(parsed)
    ) {
      return existing;
    }
    throw new Error('MANCODE_CONFIRMED_DECISION_ID_CONFLICT');
  }
}

export async function readConfirmedDecision(
  projectRoot: string,
  decisionId: string,
): Promise<ConfirmedDecision | null> {
  assertUlid(decisionId, 'confirmed decision decisionId');
  try {
    const decision = parseConfirmedDecision(
      JSON.parse(
        await readSafeText(
          confirmedDecisionDirectory(projectRoot),
          `${decisionId}.json`,
        ),
      ),
    );
    if (decision.decisionId !== decisionId)
      throw new Error('MANCODE_CONFIRMED_DECISION_ID_MISMATCH');
    return decision;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_CONFIRMED_DECISION_CORRUPT');
    }
    throw error;
  }
}

export async function listConfirmedDecisions(
  projectRoot: string,
): Promise<ConfirmedDecision[]> {
  const directory = confirmedDecisionDirectory(projectRoot);
  let entries: string[];
  try {
    await assertSafeDirectory(directory);
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const decisions: ConfirmedDecision[] = [];
  for (const entry of entries.sort(compareUtf8)) {
    if (!entry.endsWith('.json')) continue;
    if (!DECISION_FILENAME.test(entry)) {
      throw new Error('MANCODE_CONTEXT_COLLECTION_ENTRY_INVALID');
    }
    const decision = await readConfirmedDecision(
      projectRoot,
      entry.slice(0, -'.json'.length),
    );
    if (decision === null) {
      throw new Error('MANCODE_CONTEXT_COLLECTION_CHANGED_DURING_READ');
    }
    decisions.push(decision);
  }
  return decisions.sort((left, right) =>
    compareUtf8(left.decisionId, right.decisionId),
  );
}

function parseDecisionText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.length > maxLength
  ) {
    throw new Error(`${label} is invalid`);
  }
  assertSharedTextSafe(value, label);
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

async function ensureSafeDirectory(
  projectRoot: string,
  directory: string,
): Promise<void> {
  const root = path.resolve(projectRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((segment) => segment === '..')
  ) {
    throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
  }
  await assertSafeDirectory(root);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertSafeDirectory(current);
  }
}

async function assertSafeDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
  }
}

async function readSafeText(
  directory: string,
  filename: string,
): Promise<string> {
  await assertSafeDirectory(directory);
  const target = path.join(directory, filename);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
  }
  const content = await readFile(target, 'utf8');
  await assertSafeDirectory(directory);
  const after = await lstat(target);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
  }
  return content;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

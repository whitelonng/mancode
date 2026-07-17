import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { throwIfOperationCrashInjected } from '../runtime/operation-crash-injection.js';
import {
  type ProjectConfigV1,
  type TeamPolicyV1,
  assertConfigPolicyConsistency,
  parseProjectConfig,
  parseTeamPolicy,
} from '../team/policy.js';
import { digestCanonicalJson } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import { assertGreenfieldInitializationPreflight } from './layout.js';
import {
  type ManagedAdapter,
  type SchemaManifestV1,
  assertSchemaManifestTransition,
  parseSchemaManifest,
} from './manifest.js';
import {
  type ProjectFactsV1,
  parseProjectFacts,
  unknownProjectFacts,
} from './project-facts.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type GreenfieldInitializationState =
  | 'staged'
  | 'published'
  | 'repair_required'
  | 'activated'
  | 'aborted';

export interface GreenfieldInitializationJournalV1 {
  schemaVersion: 1;
  operationId: Ulid;
  workspaceId: Ulid;
  state: GreenfieldInitializationState;
  stagingDirectoryName: string;
  targetDirectoryName: '.mancode';
  manifestDigest: string;
  configDigest: string;
  policyDigest: string;
  projectFactsDigest: string;
  bindingRegistered: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GreenfieldInitializationInput {
  projectRoot: string;
  operationId: Ulid;
  workspaceId: Ulid;
  schemaEpoch: Ulid;
  minReaderVersion: string;
  minWriterVersion: string;
  managedAdapters: Record<ManagedAdapter, string>;
  projectConfig: ProjectConfigV1;
  teamPolicy: TeamPolicyV1;
  /** Optional detected facts; omitted inputs receive a safe unknown record. */
  projectFacts?: ProjectFactsV1;
  now?: Date;
}

export interface GreenfieldPublicationInput {
  projectRoot: string;
  operationId: Ulid;
  /** Registration must be idempotent because crash recovery can run it again. */
  registerWorkspaceBinding: () => Promise<void>;
  now?: Date;
}

export type GreenfieldRecoveryResult =
  | 'safe_abort_available'
  | 'forward_repaired'
  | 'already_activated';

const JOURNAL_RELATIVE_DIRECTORY = path.join(
  'local',
  'runtime',
  'initialization',
);
const V3_IGNORE = [
  'local/',
  'runtime/',
  '**/*.raw.log',
  '**/artifacts/private/',
];

/**
 * Creates a V3 root next to, rather than inside, .mancode.  No legacy path is
 * touched.  The only rollback-safe state is this named staging directory.
 */
export async function stageGreenfieldInitialization(
  input: GreenfieldInitializationInput,
): Promise<GreenfieldInitializationJournalV1> {
  const normalized = normalizeInput(input);
  await assertGreenfieldInitializationPreflight(normalized.projectRoot);
  throwIfOperationCrashInjected(
    'greenfield_initialize',
    'verify-no-legacy-authority',
  );
  const stagingRoot = greenfieldStagingPath(
    normalized.projectRoot,
    normalized.operationId,
  );
  try {
    await mkdir(stagingRoot);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error('MANCODE_GREENFIELD_STAGING_EXISTS');
    }
    throw error;
  }

  const now = (normalized.now ?? new Date()).toISOString();
  const manifest = initializationManifest(normalized, now);
  const config = initializationConfig(
    normalized.projectConfig,
    normalized,
    now,
  );
  const policy = initializationPolicy(normalized.teamPolicy, normalized, now);
  const projectFacts = initializationProjectFacts(normalized, now);
  const journal: GreenfieldInitializationJournalV1 = {
    schemaVersion: 1,
    operationId: normalized.operationId,
    workspaceId: normalized.workspaceId,
    state: 'staged',
    stagingDirectoryName: path.basename(stagingRoot),
    targetDirectoryName: '.mancode',
    manifestDigest: digestCanonicalJson(manifest),
    configDigest: digestCanonicalJson(config),
    policyDigest: digestCanonicalJson(policy),
    projectFactsDigest: digestCanonicalJson(projectFacts),
    bindingRegistered: false,
    createdAt: now,
    updatedAt: now,
  };
  await writeGreenfieldLayout(
    stagingRoot,
    manifest,
    config,
    policy,
    projectFacts,
    journal,
  );
  throwIfOperationCrashInjected('greenfield_initialize', 'prepared');
  throwIfOperationCrashInjected(
    'greenfield_initialize',
    'write-initializing-staging-root',
  );
  throwIfOperationCrashInjected(
    'greenfield_initialize',
    'write-v3-config-policy-adapters',
  );
  return journal;
}

/**
 * Publishes the complete staging root atomically, registers its workspace,
 * then activates the manifest.  A failure after rename is repair-only.
 */
export async function publishGreenfieldInitialization(
  input: GreenfieldPublicationInput,
): Promise<GreenfieldInitializationJournalV1> {
  const root = path.resolve(input.projectRoot);
  assertUlid(input.operationId, 'greenfield operationId');
  const stagingRoot = greenfieldStagingPath(root, input.operationId);
  const targetRoot = greenfieldTargetPath(root);
  const journal = await readGreenfieldJournal(stagingRoot, input.operationId);
  if (journal.state !== 'staged') {
    throw new Error('MANCODE_GREENFIELD_STAGING_STATE_INVALID');
  }
  await assertStageMatchesJournal(stagingRoot, journal);
  if ((await lstatOrNull(targetRoot)) !== null) {
    throw new Error('MANCODE_V3_TARGET_EXISTS');
  }
  await rename(stagingRoot, targetRoot);
  throwIfOperationCrashInjected('greenfield_initialize', 'publish-v3-root');
  return finishPublishedInitialization(
    { ...input, projectRoot: root },
    journal,
  );
}

export async function initializeGreenfield(
  input: GreenfieldInitializationInput,
  publication: Omit<GreenfieldPublicationInput, 'projectRoot' | 'operationId'>,
): Promise<GreenfieldInitializationJournalV1> {
  await stageGreenfieldInitialization(input);
  return publishGreenfieldInitialization({
    ...publication,
    projectRoot: input.projectRoot,
    operationId: input.operationId,
  });
}

/**
 * Recovery makes no guesses: pre-publish staging is only abortable, while a
 * published root is only completed forward after validation.
 */
export async function recoverGreenfieldInitialization(
  input: GreenfieldPublicationInput,
): Promise<GreenfieldRecoveryResult> {
  const root = path.resolve(input.projectRoot);
  assertUlid(input.operationId, 'greenfield operationId');
  const stagingRoot = greenfieldStagingPath(root, input.operationId);
  const targetRoot = greenfieldTargetPath(root);
  const [stagingStat, targetStat] = await Promise.all([
    lstatOrNull(stagingRoot),
    lstatOrNull(targetRoot),
  ]);
  if (stagingStat !== null && targetStat !== null) {
    throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
  }
  if (stagingStat !== null) {
    const journal = await readGreenfieldJournal(stagingRoot, input.operationId);
    if (journal.state !== 'staged') {
      throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
    }
    await assertStageMatchesJournal(stagingRoot, journal);
    return 'safe_abort_available';
  }
  if (targetStat === null) {
    throw new Error('MANCODE_GREENFIELD_INITIALIZATION_NOT_FOUND');
  }
  const journal = await readGreenfieldJournal(targetRoot, input.operationId);
  const manifest = await readManifest(targetRoot);
  if (
    journal.state === 'activated' &&
    manifest.activationState === 'v3_active'
  ) {
    return 'already_activated';
  }
  if (
    manifest.activationState !== 'initializing' &&
    manifest.activationState !== 'v3_active'
  ) {
    throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
  }
  if (manifest.activationState === 'v3_active') {
    await assertPublishedConfigPolicyMatchesJournal(targetRoot, journal);
    if (manifest.lastOperationId !== journal.operationId) {
      throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
    }
    const reconciled = await writeJournalAt(targetRoot, {
      ...journal,
      state: 'activated',
      bindingRegistered: true,
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    return reconciled.state === 'activated'
      ? 'forward_repaired'
      : 'already_activated';
  }
  await assertStageMatchesJournal(targetRoot, journal);
  await finishPublishedInitialization({ ...input, projectRoot: root }, journal);
  return 'forward_repaired';
}

/**
 * Deletes only a verified pre-publish staging directory.  A published V3
 * root is never rolled back by this helper.
 */
export async function abortStagedGreenfieldInitialization(
  projectRoot: string,
  operationId: Ulid,
): Promise<void> {
  const root = path.resolve(projectRoot);
  assertUlid(operationId, 'greenfield operationId');
  const stagingRoot = greenfieldStagingPath(root, operationId);
  if ((await lstatOrNull(greenfieldTargetPath(root))) !== null) {
    throw new Error('MANCODE_GREENFIELD_ROLLBACK_FORBIDDEN');
  }
  const journal = await readGreenfieldJournal(stagingRoot, operationId);
  if (
    journal.state !== 'staged' ||
    journal.stagingDirectoryName !== path.basename(stagingRoot)
  ) {
    throw new Error('MANCODE_GREENFIELD_ROLLBACK_FORBIDDEN');
  }
  await assertStageMatchesJournal(stagingRoot, journal);
  await rm(stagingRoot, { recursive: true, force: false });
}

export function greenfieldStagingPath(
  projectRoot: string,
  operationId: Ulid,
): string {
  assertUlid(operationId, 'greenfield operationId');
  return path.join(path.resolve(projectRoot), `.mancode.init-${operationId}`);
}

export function greenfieldTargetPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.mancode');
}

export function parseGreenfieldInitializationJournal(
  value: unknown,
): GreenfieldInitializationJournalV1 {
  assertRecord(value, 'greenfield initialization journal');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'workspaceId',
      'state',
      'stagingDirectoryName',
      'targetDirectoryName',
      'manifestDigest',
      'configDigest',
      'policyDigest',
      'projectFactsDigest',
      'bindingRegistered',
      'createdAt',
      'updatedAt',
    ],
    'greenfield initialization journal',
  );
  if (value.schemaVersion !== 1) {
    throw new Error(
      'greenfield initialization journal schemaVersion must be 1',
    );
  }
  assertUlid(
    value.operationId,
    'greenfield initialization journal operationId',
  );
  assertUlid(
    value.workspaceId,
    'greenfield initialization journal workspaceId',
  );
  if (!isState(value.state)) {
    throw new Error('greenfield initialization journal state is invalid');
  }
  if (
    typeof value.stagingDirectoryName !== 'string' ||
    !/^\.mancode\.init-[0-9A-HJKMNP-TV-Z]{26}$/.test(value.stagingDirectoryName)
  ) {
    throw new Error(
      'greenfield initialization journal stagingDirectoryName is invalid',
    );
  }
  if (value.targetDirectoryName !== '.mancode') {
    throw new Error(
      'greenfield initialization journal targetDirectoryName is invalid',
    );
  }
  if (typeof value.bindingRegistered !== 'boolean') {
    throw new Error(
      'greenfield initialization journal bindingRegistered is invalid',
    );
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    workspaceId: value.workspaceId,
    state: value.state,
    stagingDirectoryName: value.stagingDirectoryName,
    targetDirectoryName: '.mancode',
    manifestDigest: parseDigest(value.manifestDigest, 'manifestDigest'),
    configDigest: parseDigest(value.configDigest, 'configDigest'),
    policyDigest: parseDigest(value.policyDigest, 'policyDigest'),
    projectFactsDigest: parseDigest(
      value.projectFactsDigest,
      'projectFactsDigest',
    ),
    bindingRegistered: value.bindingRegistered,
    createdAt: parseTimestamp(value.createdAt, 'createdAt'),
    updatedAt: parseTimestamp(value.updatedAt, 'updatedAt'),
  };
}

async function finishPublishedInitialization(
  input: GreenfieldPublicationInput,
  stagedJournal: GreenfieldInitializationJournalV1,
): Promise<GreenfieldInitializationJournalV1> {
  const targetRoot = greenfieldTargetPath(input.projectRoot);
  const published = await writeJournalAt(targetRoot, {
    ...stagedJournal,
    state: 'published',
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
  try {
    await input.registerWorkspaceBinding();
  } catch (error) {
    await writeJournalAt(targetRoot, {
      ...published,
      state: 'repair_required',
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    throw new Error('MANCODE_GREENFIELD_BINDING_REGISTRATION_FAILED', {
      cause: error,
    });
  }
  throwIfOperationCrashInjected(
    'greenfield_initialize',
    'register-workspace-binding',
  );
  const manifest = await readManifest(targetRoot);
  const activeManifest: SchemaManifestV1 = {
    ...manifest,
    activationState: 'v3_active',
    activatedAt: (input.now ?? new Date()).toISOString(),
  };
  assertSchemaManifestTransition(manifest, activeManifest);
  await writeJson(path.join(targetRoot, 'schema.json'), activeManifest);
  throwIfOperationCrashInjected(
    'greenfield_initialize',
    'activate-v3-manifest',
  );
  const activated = await writeJournalAt(targetRoot, {
    ...published,
    state: 'activated',
    bindingRegistered: true,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
  throwIfOperationCrashInjected('greenfield_initialize', 'commit');
  return activated;
}

async function writeGreenfieldLayout(
  stagingRoot: string,
  manifest: SchemaManifestV1,
  config: ProjectConfigV1,
  policy: TeamPolicyV1,
  projectFacts: ProjectFactsV1,
  journal: GreenfieldInitializationJournalV1,
): Promise<void> {
  await Promise.all([
    mkdir(path.join(stagingRoot, 'shared', 'context'), { recursive: true }),
    mkdir(path.join(stagingRoot, 'shared', 'memory', 'decisions'), {
      recursive: true,
    }),
    mkdir(path.join(stagingRoot, 'shared', 'team', 'actors'), {
      recursive: true,
    }),
    mkdir(path.join(stagingRoot, 'shared', 'team', 'handoffs'), {
      recursive: true,
    }),
    mkdir(path.join(stagingRoot, 'shared', 'team', 'events'), {
      recursive: true,
    }),
    mkdir(path.join(stagingRoot, 'shared', 'team', 'transport'), {
      recursive: true,
    }),
    mkdir(path.join(stagingRoot, 'local', 'sessions'), { recursive: true }),
    mkdir(path.join(stagingRoot, JOURNAL_RELATIVE_DIRECTORY), {
      recursive: true,
    }),
    mkdir(path.join(stagingRoot, 'local', 'workflows'), { recursive: true }),
    mkdir(path.join(stagingRoot, 'local', 'overlays'), { recursive: true }),
    mkdir(path.join(stagingRoot, 'local', 'quarantine'), { recursive: true }),
    mkdir(path.join(stagingRoot, 'local', 'publish'), { recursive: true }),
    mkdir(path.join(stagingRoot, 'local', 'cache'), { recursive: true }),
    mkdir(path.join(stagingRoot, 'runtime', 'non-git', journal.workspaceId), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeJson(path.join(stagingRoot, 'schema.json'), manifest),
    writeJson(path.join(stagingRoot, 'shared', 'config.json'), config),
    writeJson(path.join(stagingRoot, 'shared', 'team', 'policy.json'), policy),
    writeJson(
      path.join(stagingRoot, 'shared', 'context', 'project.json'),
      projectFacts,
    ),
    writeJson(journalPath(stagingRoot, journal.operationId), journal),
    writeFile(
      path.join(stagingRoot, '.gitignore'),
      `${V3_IGNORE.join('\n')}\n`,
      { encoding: 'utf8', flag: 'wx' },
    ),
  ]);
}

async function readGreenfieldJournal(
  root: string,
  operationId: Ulid,
): Promise<GreenfieldInitializationJournalV1> {
  try {
    const raw = await readFile(journalPath(root, operationId), 'utf8');
    const journal = parseGreenfieldInitializationJournal(JSON.parse(raw));
    if (journal.operationId !== operationId) {
      throw new Error('MANCODE_GREENFIELD_JOURNAL_CORRUPT');
    }
    return journal;
  } catch (error) {
    if (error instanceof SyntaxError || isNotFound(error)) {
      throw new Error('MANCODE_GREENFIELD_JOURNAL_CORRUPT');
    }
    throw error;
  }
}

async function readManifest(root: string): Promise<SchemaManifestV1> {
  try {
    return parseSchemaManifest(
      JSON.parse(await readFile(path.join(root, 'schema.json'), 'utf8')),
    );
  } catch (error) {
    if (error instanceof SyntaxError || isNotFound(error)) {
      throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
    }
    throw error;
  }
}

async function assertStageMatchesJournal(
  root: string,
  journal: GreenfieldInitializationJournalV1,
): Promise<void> {
  const [manifest, config, policy, projectFacts] = await Promise.all([
    readManifest(root),
    readConfig(root),
    readPolicy(root),
    readProjectFactsAt(root),
  ]);
  if (
    manifest.activationState !== 'initializing' ||
    manifest.legacyBaseline !== null ||
    manifest.lastOperationId !== journal.operationId ||
    digestCanonicalJson(manifest) !== journal.manifestDigest
  ) {
    throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
  }
  assertConfigPolicyMatchesJournal(config, policy, journal);
  assertProjectFactsMatchesJournal(projectFacts, journal);
}

async function assertPublishedConfigPolicyMatchesJournal(
  root: string,
  journal: GreenfieldInitializationJournalV1,
): Promise<void> {
  const [config, policy, projectFacts] = await Promise.all([
    readConfig(root),
    readPolicy(root),
    readProjectFactsAt(root),
  ]);
  assertConfigPolicyMatchesJournal(config, policy, journal);
  assertProjectFactsMatchesJournal(projectFacts, journal);
}

function assertConfigPolicyMatchesJournal(
  config: ProjectConfigV1,
  policy: TeamPolicyV1,
  journal: GreenfieldInitializationJournalV1,
): void {
  if (
    config.workspaceId !== journal.workspaceId ||
    policy.workspaceId !== journal.workspaceId ||
    digestCanonicalJson(config) !== journal.configDigest ||
    digestCanonicalJson(policy) !== journal.policyDigest
  ) {
    throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
  }
  assertConfigPolicyConsistency(config, policy);
}

function assertProjectFactsMatchesJournal(
  facts: ProjectFactsV1,
  journal: GreenfieldInitializationJournalV1,
): void {
  if (digestCanonicalJson(facts) !== journal.projectFactsDigest) {
    throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
  }
}

async function readConfig(root: string): Promise<ProjectConfigV1> {
  let config: ProjectConfigV1;
  try {
    config = parseProjectConfig(
      JSON.parse(
        await readFile(path.join(root, 'shared', 'config.json'), 'utf8'),
      ),
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
    }
    throw error;
  }
  return config;
}

async function readPolicy(root: string): Promise<TeamPolicyV1> {
  let policy: TeamPolicyV1;
  try {
    policy = parseTeamPolicy(
      JSON.parse(
        await readFile(
          path.join(root, 'shared', 'team', 'policy.json'),
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
    }
    throw error;
  }
  return policy;
}

async function readProjectFactsAt(root: string): Promise<ProjectFactsV1> {
  try {
    return parseProjectFacts(
      JSON.parse(
        await readFile(
          path.join(root, 'shared', 'context', 'project.json'),
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if (error instanceof SyntaxError || isNotFound(error)) {
      throw new Error('MANCODE_GREENFIELD_REPAIR_REQUIRED');
    }
    throw error;
  }
}

async function writeJournalAt(
  root: string,
  journal: GreenfieldInitializationJournalV1,
): Promise<GreenfieldInitializationJournalV1> {
  const parsed = parseGreenfieldInitializationJournal(journal);
  await writeJson(journalPath(root, parsed.operationId), parsed);
  return parsed;
}

function normalizeInput(
  input: GreenfieldInitializationInput,
): GreenfieldInitializationInput {
  assertUlid(input.operationId, 'greenfield operationId');
  assertUlid(input.workspaceId, 'greenfield workspaceId');
  assertUlid(input.schemaEpoch, 'greenfield schemaEpoch');
  if (typeof input.projectRoot !== 'string' || !input.projectRoot.trim()) {
    throw new Error('greenfield projectRoot is required');
  }
  const config = parseProjectConfig(input.projectConfig);
  const policy = parseTeamPolicy(input.teamPolicy);
  if (
    config.workspaceId !== input.workspaceId ||
    policy.workspaceId !== input.workspaceId
  ) {
    throw new Error(
      'greenfield config and policy must use the requested workspaceId',
    );
  }
  assertConfigPolicyConsistency(config, policy);
  const manifest = initializationManifest(
    input,
    (input.now ?? new Date()).toISOString(),
  );
  parseSchemaManifest(manifest);
  return {
    ...input,
    projectRoot: path.resolve(input.projectRoot),
    projectConfig: config,
    teamPolicy: policy,
    projectFacts:
      input.projectFacts === undefined
        ? undefined
        : parseProjectFacts(input.projectFacts),
  };
}

function initializationManifest(
  input: GreenfieldInitializationInput,
  _now: string,
): SchemaManifestV1 {
  return parseSchemaManifest({
    manifestVersion: 1,
    layoutVersion: 3,
    epoch: input.schemaEpoch,
    activationState: 'initializing',
    minReaderVersion: input.minReaderVersion,
    minWriterVersion: input.minWriterVersion,
    activatedAt: null,
    legacyBaseline: null,
    managedAdapters: input.managedAdapters,
    lastOperationId: input.operationId,
  });
}

function initializationConfig(
  config: ProjectConfigV1,
  input: GreenfieldInitializationInput,
  now: string,
): ProjectConfigV1 {
  return parseProjectConfig({
    ...config,
    workspaceId: input.workspaceId,
    lastOperationId: input.operationId,
    updatedAt: now,
  });
}

function initializationPolicy(
  policy: TeamPolicyV1,
  input: GreenfieldInitializationInput,
  now: string,
): TeamPolicyV1 {
  return parseTeamPolicy({
    ...policy,
    workspaceId: input.workspaceId,
    lastOperationId: input.operationId,
    updatedAt: now,
  });
}

function initializationProjectFacts(
  input: GreenfieldInitializationInput,
  now: string,
): ProjectFactsV1 {
  const source =
    input.projectFacts ??
    unknownProjectFacts({
      now: new Date(now),
      operationId: input.operationId,
    });
  return parseProjectFacts({
    ...source,
    detectedAt: now,
    lastOperationId: input.operationId,
  });
}

function journalPath(root: string, operationId: Ulid): string {
  assertUlid(operationId, 'greenfield operationId');
  return path.join(root, JOURNAL_RELATIVE_DIRECTORY, `${operationId}.json`);
}

async function writeJson(target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporary, target);
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`greenfield initialization journal ${label} is invalid`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`greenfield initialization journal ${label} is invalid`);
  }
  return value;
}

function isState(value: unknown): value is GreenfieldInitializationState {
  return (
    value === 'staged' ||
    value === 'published' ||
    value === 'repair_required' ||
    value === 'activated' ||
    value === 'aborted'
  );
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

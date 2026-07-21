import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type EntityHomeStore,
  claimDirectory,
  handoffDirectory,
  operationDirectory,
  reservationDirectory,
  taskHeadDirectory,
} from '../runtime/entity-home-store.js';
import { listUnfinishedGitRefWorkflowRepairs } from '../runtime/git-ref-workflow-repair-store.js';
import {
  type OperationJournalV1,
  parseOperationJournal,
} from '../runtime/operation-journal.js';
import { parseOperationReservation } from '../runtime/operation-reservation.js';
import {
  type TaskHeadFenceV1,
  parseTaskHeadFence,
} from '../runtime/task-head-fence.js';
import { type CheckpointV1, parseCheckpoint } from '../team/checkpoints.js';
import { type ClaimV1, parseClaim } from '../team/claims.js';
import { type HandoffV1, parseHandoff } from '../team/handoff.js';
import {
  type ProjectConfigV1,
  type TeamPolicyV1,
  parseProjectConfig,
  parseTeamPolicy,
} from '../team/policy.js';
import {
  type TaskAggregateInput,
  type TaskAggregateManifestV1,
  buildTaskAggregateManifest,
  taskAggregateDigest,
} from './aggregate.js';
import type { ArtifactRef } from './artifact-ref.js';
import { digestCanonicalJson } from './canonical.js';
import {
  type ConfirmedDecisionV1,
  listConfirmedDecisions,
} from './confirmed-decision.js';
import { assertUlid } from './ids.js';
import { type SchemaManifest, parseSchemaManifest } from './manifest.js';
import {
  type ParentSnapshotSource,
  parentSnapshotStaleReasons,
} from './parent-snapshot.js';
import { type ProjectFactsV1, parseProjectFacts } from './project-facts.js';
import {
  type RequirementsLedgerV1,
  parseRequirementsLedger,
} from './requirements-ledger.js';
import { type ReviewLedgerV1, parseReviewLedger } from './review-ledger.js';
import { type TaskLocation, locateTask, taskRootPath } from './task-locator.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import {
  type VerificationLedgerV1,
  parseVerificationLedger,
} from './verification-ledger.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
} from './workflow-metadata.js';

export interface StoredArtifactText {
  artifactRef: ArtifactRef;
  content: string;
  digest: string;
}

/**
 * Parsed task entities from one filesystem read pass. `aggregate` is nullable
 * because the resolver must be able to return a deliberately partial repair
 * envelope when a journal has left otherwise valid individual entities out of
 * sync.
 */
export interface StoredTaskSnapshot {
  location: TaskLocation;
  metadata: WorkflowMetadataV3;
  requirements: RequirementsLedgerV1;
  review: ReviewLedgerV1;
  verification: VerificationLedgerV1;
  plan: StoredArtifactText | null;
  latestCheckpoint: CheckpointV1 | null;
  aggregate: TaskAggregateManifestV1 | null;
  aggregateError: string | null;
  fingerprint: string;
}

export interface StoredProjectSnapshot {
  manifest: SchemaManifest;
  config: ProjectConfigV1;
  policy: TeamPolicyV1;
  projectFacts: ProjectFactsV1 | null;
  confirmedDecisions: ConfirmedDecisionV1[];
  fingerprint: string;
}

export interface PendingOperationRecord {
  source:
    | 'primary_journal'
    | 'secondary_reservation'
    | 'git_ref_workflow_repair';
  operationId: string;
  state:
    | OperationJournalV1['state']
    | 'awaiting_remote'
    | 'applying'
    | 'repair_required'
    | null;
  entityKeys: string[];
}

export interface StoredCoordinationSnapshot {
  homeStore: EntityHomeStore;
  taskHeadFence: TaskHeadFenceV1 | null;
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  pendingOperations: PendingOperationRecord[];
  fingerprint: string;
}

export interface StoredParentSnapshot {
  metadata: WorkflowMetadataV3;
  staleReasons: ReturnType<typeof parentSnapshotStaleReasons>;
  fingerprint: string;
}

const JSON_SUFFIX = '.json';

/**
 * File-backed V3 authority reader. Every authority path is fixed by schema;
 * this class never accepts an arbitrary task-relative path from callers.
 */
export class V3ContextStore {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
      throw new Error('context store projectRoot is required');
    }
    this.projectRoot = path.resolve(projectRoot);
  }

  async locateTask(requested: TaskRef | string): Promise<TaskLocation> {
    const location = await locateTask(this.projectRoot, requested);
    await assertSafeDirectoryWithin(
      this.projectRoot,
      path.relative(this.projectRoot, location.taskRoot),
    );
    return location;
  }

  async readTaskSnapshot(taskRef: TaskRef): Promise<StoredTaskSnapshot> {
    const location = await this.locateTask(taskRef);
    const expectedTaskRef = parseTaskRefValue(taskRef);
    if (!sameTaskRef(location.taskRef, expectedTaskRef)) {
      throw new Error('MANCODE_CONTEXT_TASK_LOCATION_MISMATCH');
    }
    const taskRoot = location.taskRoot;
    const [metadata, requirements, review, verification, plan] =
      await Promise.all([
        this.readRequiredJson(taskRoot, 'metadata.json', parseWorkflowMetadata),
        this.readRequiredJson(
          taskRoot,
          'requirements.json',
          parseRequirementsLedger,
        ),
        this.readRequiredJson(
          taskRoot,
          'review-ledger.json',
          parseReviewLedger,
        ),
        this.readRequiredJson(
          taskRoot,
          'verification-ledger.json',
          parseVerificationLedger,
        ),
        this.readOptionalPlan(expectedTaskRef, taskRoot),
      ]);
    assertSnapshotTaskRefs(expectedTaskRef, {
      metadata,
      requirements,
      review,
      verification,
    });
    const latestCheckpoint = await this.readLatestCheckpoint(
      metadata,
      taskRoot,
    );
    const aggregateResult = tryBuildAggregate({
      metadata,
      requirements,
      review,
      verification,
      planDigest: plan?.digest ?? null,
      latestCheckpoint,
    });
    const fingerprint = digestCanonicalJson({
      taskRef: expectedTaskRef,
      metadata,
      requirements,
      review,
      verification,
      planDigest: plan?.digest ?? null,
      latestCheckpoint,
    });
    return {
      location,
      metadata,
      requirements,
      review,
      verification,
      plan,
      latestCheckpoint,
      aggregate: aggregateResult.aggregate,
      aggregateError: aggregateResult.error,
      fingerprint,
    };
  }

  async readProjectSnapshot(): Promise<StoredProjectSnapshot> {
    const [manifest, config, policy, projectFacts, confirmedDecisions] =
      await Promise.all([
        this.readRequiredJson(
          this.mancodeRoot(),
          'schema.json',
          parseSchemaManifest,
        ),
        this.readRequiredJson(
          this.mancodeRoot(),
          path.join('shared', 'config.json'),
          parseProjectConfig,
        ),
        this.readRequiredJson(
          this.mancodeRoot(),
          path.join('shared', 'team', 'policy.json'),
          parseTeamPolicy,
        ),
        readOptionalJsonWithin(
          this.mancodeRoot(),
          path.join('shared', 'context', 'project.json'),
          parseProjectFacts,
        ),
        listConfirmedDecisions(this.projectRoot),
      ]);
    return {
      manifest,
      config,
      policy,
      projectFacts,
      confirmedDecisions,
      fingerprint: digestCanonicalJson({
        manifest,
        config,
        policy,
        projectFacts,
        confirmedDecisions,
      }),
    };
  }

  async readParentSnapshot(
    child: WorkflowMetadataV3,
  ): Promise<StoredParentSnapshot | null> {
    if (child.parent === null) return null;
    const parentRef = child.parent.taskRef;
    const parentRoot = taskRootPath(this.projectRoot, parentRef);
    await assertSafeDirectoryWithin(
      this.projectRoot,
      path.relative(this.projectRoot, parentRoot),
    );
    const metadata = await this.readRequiredJson(
      parentRoot,
      'metadata.json',
      parseWorkflowMetadata,
    );
    const source: ParentSnapshotSource = {
      taskRef: metadata.taskRef,
      revision: metadata.revision,
      planVersion: metadata.governance.planVersion,
      requirementsDigest: metadata.governance.requirementsDigest,
      implementationScopeDigest: metadata.implementationScope.digest,
      visibility: metadata.visibility,
      coordination: metadata.coordination,
    };
    return {
      metadata,
      staleReasons: parentSnapshotStaleReasons(child.parent, source),
      fingerprint: digestCanonicalJson({ metadata }),
    };
  }

  async readCoordinationSnapshot(
    taskRef: TaskRef,
    homeStore: EntityHomeStore,
  ): Promise<StoredCoordinationSnapshot> {
    const normalizedTaskRef = parseTaskRefValue(taskRef);
    if (normalizedTaskRef.namespace === 'local') {
      const pendingOperations = await this.readPendingOperations(
        normalizedTaskRef,
        homeStore,
      );
      return {
        homeStore,
        taskHeadFence: null,
        claims: [],
        handoffs: [],
        pendingOperations,
        fingerprint: digestCanonicalJson({
          homeStore: homeStore.storeId,
          pendingOperations,
        }),
      };
    }
    const [taskHeadFence, claims, handoffs, pendingOperations] =
      await Promise.all([
        this.readTaskHeadFence(homeStore, normalizedTaskRef),
        this.readClaims(homeStore, normalizedTaskRef),
        this.readHandoffs(homeStore, normalizedTaskRef),
        this.readPendingOperations(normalizedTaskRef, homeStore),
      ]);
    return {
      homeStore,
      taskHeadFence,
      claims,
      handoffs,
      pendingOperations,
      fingerprint: digestCanonicalJson({
        homeStore: homeStore.storeId,
        taskHeadFence,
        claims,
        handoffs,
        pendingOperations,
      }),
    };
  }

  /** Lists every canonical V3 workflow without relying on a session pointer. */
  async listWorkflowMetadata(): Promise<WorkflowMetadataV3[]> {
    const workflows: WorkflowMetadataV3[] = [];
    for (const namespace of ['local', 'shared'] as const) {
      const directory = path.join('.mancode', namespace, 'workflows');
      const entries = await readDirectoryEntriesWithin(
        this.projectRoot,
        directory,
      );
      for (const taskId of entries.sort(compareUtf8)) {
        try {
          assertUlid(taskId, 'workflow directory');
        } catch {
          throw new Error('MANCODE_CONTEXT_COLLECTION_ENTRY_INVALID');
        }
        const taskRef: TaskRef = { namespace, taskId };
        const taskRoot = taskRootPath(this.projectRoot, taskRef);
        await assertSafeDirectoryWithin(
          this.projectRoot,
          path.relative(this.projectRoot, taskRoot),
        );
        const metadata = await this.readRequiredJson(
          taskRoot,
          'metadata.json',
          parseWorkflowMetadata,
        );
        if (!sameTaskRef(metadata.taskRef, taskRef)) {
          throw new Error('MANCODE_CONTEXT_TASK_LOCATION_MISMATCH');
        }
        workflows.push(metadata);
      }
    }
    return workflows.sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        compareUtf8(left.taskRef.namespace, right.taskRef.namespace) ||
        compareUtf8(left.taskRef.taskId, right.taskRef.taskId),
    );
  }

  /**
   * Lists non-terminal children from canonical metadata only. Callers that
   * need a completion gate must hold the parent task lock while invoking it;
   * V3 child creation takes that same parent lock before publishing.
   */
  async listActiveChildTaskRefs(parentTaskRef: TaskRef): Promise<TaskRef[]> {
    const parent = parseTaskRefValue(parentTaskRef);
    return (await this.listWorkflowMetadata())
      .filter(
        (metadata) =>
          metadata.parent !== null &&
          sameTaskRef(metadata.parent.taskRef, parent) &&
          !isTerminalWorkflowStatus(metadata.status),
      )
      .map((metadata) => metadata.taskRef)
      .sort(
        (left, right) =>
          compareUtf8(left.namespace, right.namespace) ||
          compareUtf8(left.taskId, right.taskId),
      );
  }

  private mancodeRoot(): string {
    return path.join(this.projectRoot, '.mancode');
  }

  private async readOptionalPlan(
    taskRef: TaskRef,
    taskRoot: string,
  ): Promise<StoredArtifactText | null> {
    const content = await readOptionalTextWithin(taskRoot, 'plan.md');
    if (content === null) return null;
    const artifactRef: ArtifactRef = { taskRef, kind: 'plan' };
    return {
      artifactRef,
      content,
      digest: digestCanonicalJson({ artifactRef, content }),
    };
  }

  private async readLatestCheckpoint(
    metadata: WorkflowMetadataV3,
    taskRoot: string,
  ): Promise<CheckpointV1 | null> {
    const ref = metadata.latestCheckpointRef;
    if (ref === null) return null;
    if (ref.kind !== 'checkpoint' || ref.artifactId === undefined) {
      throw new Error('MANCODE_CONTEXT_CHECKPOINT_REFERENCE_INVALID');
    }
    const checkpoint = await this.readRequiredJson(
      taskRoot,
      path.join('checkpoints', `${ref.artifactId}.json`),
      parseCheckpoint,
    );
    if (!sameTaskRef(checkpoint.taskRef, metadata.taskRef)) {
      throw new Error('MANCODE_CONTEXT_CHECKPOINT_TASK_MISMATCH');
    }
    return checkpoint;
  }

  private async readTaskHeadFence(
    homeStore: EntityHomeStore,
    taskRef: TaskRef,
  ): Promise<TaskHeadFenceV1 | null> {
    const value = await readOptionalJsonWithin(
      homeStore.root,
      path.join(
        path.relative(homeStore.root, taskHeadDirectory(homeStore)),
        `${taskRef.taskId}.json`,
      ),
      parseTaskHeadFence,
    );
    if (value === null) return null;
    if (!sameTaskRef(value.taskRef, taskRef)) {
      throw new Error('MANCODE_CONTEXT_TASK_HEAD_TASK_MISMATCH');
    }
    return value;
  }

  private async readClaims(
    homeStore: EntityHomeStore,
    taskRef: TaskRef,
  ): Promise<ClaimV1[]> {
    const directory = path.relative(homeStore.root, claimDirectory(homeStore));
    const claims = await readJsonCollectionWithin(
      homeStore.root,
      directory,
      parseClaim,
    );
    return claims
      .filter((claim) => sameTaskRef(claim.taskRef, taskRef))
      .sort((left, right) => compareUtf8(left.claimId, right.claimId));
  }

  private async readHandoffs(
    homeStore: EntityHomeStore,
    taskRef: TaskRef,
  ): Promise<HandoffV1[]> {
    const directory = path.relative(
      homeStore.root,
      handoffDirectory(homeStore),
    );
    const handoffs = await readJsonCollectionWithin(
      homeStore.root,
      directory,
      parseHandoff,
    );
    return handoffs
      .filter((handoff) => sameTaskRef(handoff.taskRef, taskRef))
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          compareUtf8(left.handoffId, right.handoffId),
      );
  }

  private async readPendingOperations(
    taskRef: TaskRef,
    homeStore: EntityHomeStore,
  ): Promise<PendingOperationRecord[]> {
    const taskKey = `task:${taskRef.namespace}:${taskRef.taskId}`;
    const [journals, reservations, gitRefWorkflowRepairs] = await Promise.all([
      readJsonCollectionWithin(
        homeStore.root,
        path.relative(homeStore.root, operationDirectory(homeStore)),
        parseOperationJournal,
      ),
      readJsonCollectionWithin(
        homeStore.root,
        path.relative(homeStore.root, reservationDirectory(homeStore)),
        parseOperationReservation,
      ),
      listUnfinishedGitRefWorkflowRepairs(this.projectRoot),
    ]);
    const primary = journals
      .filter(
        (journal) =>
          journal.state !== 'committed' &&
          journal.state !== 'aborted' &&
          journal.entityLocks.includes(taskKey),
      )
      .map<PendingOperationRecord>((journal) => ({
        source: 'primary_journal',
        operationId: journal.operationId,
        state: journal.state,
        entityKeys: journal.entityLocks,
      }));
    const secondary = reservations
      .filter((reservation) => reservation.entityKeys.includes(taskKey))
      .map<PendingOperationRecord>((reservation) => ({
        source: 'secondary_reservation',
        operationId: reservation.operationId,
        state: null,
        entityKeys: reservation.entityKeys,
      }));
    const gitRefWorkflow = gitRefWorkflowRepairs
      .filter((journal) => sameTaskRef(journal.taskRef, taskRef))
      .map<PendingOperationRecord>((journal) => ({
        source: 'git_ref_workflow_repair',
        operationId: journal.operationId,
        state: journal.state,
        entityKeys: [taskKey],
      }));
    return [...primary, ...secondary, ...gitRefWorkflow].sort(
      (left, right) =>
        compareUtf8(left.operationId, right.operationId) ||
        left.source.localeCompare(right.source, 'en'),
    );
  }

  private async readRequiredJson<T>(
    root: string,
    relativePath: string,
    parser: (value: unknown) => T,
  ): Promise<T> {
    try {
      return parser(JSON.parse(await readTextWithin(root, relativePath)));
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error(`MANCODE_CONTEXT_ENTITY_UNAVAILABLE: ${relativePath}`);
      }
      if (error instanceof SyntaxError) {
        throw new Error(`MANCODE_CONTEXT_ENTITY_CORRUPT: ${relativePath}`);
      }
      throw error;
    }
  }
}

function tryBuildAggregate(input: TaskAggregateInput): {
  aggregate: TaskAggregateManifestV1 | null;
  error: string | null;
} {
  try {
    return { aggregate: buildTaskAggregateManifest(input), error: null };
  } catch (error) {
    return {
      aggregate: null,
      error:
        error instanceof Error
          ? error.message
          : 'MANCODE_CONTEXT_AGGREGATE_INVALID',
    };
  }
}

function assertSnapshotTaskRefs(
  expected: TaskRef,
  input: Pick<
    TaskAggregateInput,
    'metadata' | 'requirements' | 'review' | 'verification'
  >,
): void {
  const refs = [
    input.metadata.taskRef,
    input.requirements.taskRef,
    input.review.taskRef,
    input.verification.taskRef,
  ];
  if (refs.some((ref) => !sameTaskRef(ref, expected))) {
    throw new Error('MANCODE_CONTEXT_TASK_REFERENCE_MISMATCH');
  }
}

async function readOptionalJsonWithin<T>(
  root: string,
  relativePath: string,
  parser: (value: unknown) => T,
): Promise<T | null> {
  try {
    return parser(JSON.parse(await readTextWithin(root, relativePath)));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error(`MANCODE_CONTEXT_ENTITY_CORRUPT: ${relativePath}`);
    }
    throw error;
  }
}

async function readJsonCollectionWithin<T>(
  root: string,
  relativeDirectory: string,
  parser: (value: unknown) => T,
): Promise<T[]> {
  const entries = await readDirectoryEntriesWithin(root, relativeDirectory);
  const jsonEntries = entries.filter((entry) => entry.endsWith(JSON_SUFFIX));
  const values: T[] = [];
  for (const entry of jsonEntries.sort(compareUtf8)) {
    const stem = entry.slice(0, -JSON_SUFFIX.length);
    if (!/^[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/.test(stem)) {
      throw new Error('MANCODE_CONTEXT_COLLECTION_ENTRY_INVALID');
    }
    const value = await readOptionalJsonWithin(
      root,
      path.join(relativeDirectory, entry),
      parser,
    );
    if (value === null) {
      throw new Error('MANCODE_CONTEXT_COLLECTION_CHANGED_DURING_READ');
    }
    values.push(value);
  }
  return values;
}

async function readOptionalTextWithin(
  root: string,
  relativePath: string,
): Promise<string | null> {
  try {
    return await readTextWithin(root, relativePath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Uses lstat before and after the read and verifies every ancestor. This
 * rejects links at every V3 authority boundary and detects replacement races
 * that would otherwise let a resolver read outside its intended root.
 */
async function readTextWithin(
  root: string,
  relativePath: string,
): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const segments = safeRelativeSegments(relativePath);
  await assertSafeDirectoryWithin(absoluteRoot, '.');
  const parentSegments = segments.slice(0, -1);
  let current = absoluteRoot;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    await assertSafeDirectoryAt(current);
  }
  const target = path.join(absoluteRoot, ...segments);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
  }
  const content = await readFile(target, 'utf8');
  await assertSafeDirectoryWithin(
    absoluteRoot,
    parentSegments.length === 0 ? '.' : path.join(...parentSegments),
  );
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

async function readDirectoryEntriesWithin(
  root: string,
  relativeDirectory: string,
): Promise<string[]> {
  try {
    const directory = await assertSafeDirectoryWithin(root, relativeDirectory);
    return await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function assertSafeDirectoryWithin(
  root: string,
  relativeDirectory: string,
): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const segments =
    relativeDirectory === '.' ? [] : safeRelativeSegments(relativeDirectory);
  await assertSafeDirectoryAt(absoluteRoot);
  let current = absoluteRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    await assertSafeDirectoryAt(current);
  }
  return current;
}

async function assertSafeDirectoryAt(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
  }
}

function safeRelativeSegments(relativePath: string): string[] {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
  }
  const segments = relativePath.split(path.sep);
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('MANCODE_CONTEXT_PATH_UNSAFE');
  }
  return segments;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isTerminalWorkflowStatus(
  status: WorkflowMetadataV3['status'],
): boolean {
  return (
    status === 'completed' || status === 'abandoned' || status === 'superseded'
  );
}

export function storedTaskAggregateDigest(
  snapshot: StoredTaskSnapshot,
): string | null {
  return snapshot.aggregate === null
    ? null
    : taskAggregateDigest(snapshot.aggregate);
}

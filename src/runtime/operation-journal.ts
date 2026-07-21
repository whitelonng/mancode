import {
  digestCanonicalJson,
  sortUtf8StringSet,
} from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  type AuthorizationBasisV1,
  parseAuthorizationBasis,
} from '../team/authorization.js';

export type OperationType =
  | 'workflow_create'
  | 'workflow_update'
  | 'requirements_finalize'
  | 'plan_revision'
  | 'review_remediation'
  | 'verification_record'
  | 'task_complete'
  | 'publish_promote'
  | 'handoff_transition'
  | 'handoff_accept'
  | 'scope_change_reclaim'
  | 'claim_create'
  | 'claim_renew_release'
  | 'claim_transfer'
  | 'claim_reclaim'
  | 'claim_revalidation'
  | 'checkpoint_create'
  | 'solo_handoff'
  | 'reframe'
  | 'child_result_merge'
  | 'task_head_reconcile'
  | 'transport_migrate'
  | 'greenfield_initialize'
  | 'adapter_upgrade'
  | 'project_policy_upgrade'
  | 'v3_activate';

export type OperationState =
  | 'prepared'
  | 'applying'
  | 'committed'
  | 'repair_required'
  | 'aborted';

export type OperationStepState = 'pending' | 'completed';

export interface OperationStep {
  id: string;
  state: OperationStepState;
}

export interface SecondaryReservation {
  storeId: string;
  entityKeys: string[];
  journalDigest: string;
}

export interface OperationJournalV1 {
  schemaVersion: 1;
  operationId: Ulid;
  type: OperationType;
  state: OperationState;
  primaryStoreId: string;
  checkoutId: Ulid;
  secondaryReservations: SecondaryReservation[];
  actorId: Ulid;
  sessionId: Ulid;
  authorizationBasis: AuthorizationBasisV1;
  /** Digest binding this immutable journal to its exact forward-repair targets. */
  recoveryPayloadDigest?: string;
  entityLocks: string[];
  expectedRevisions: Record<string, number>;
  steps: OperationStep[];
  startedAt: string;
  updatedAt: string;
}

export interface OperationTransitionOptions {
  /** True only before any external write, or after verified compensation. */
  canAbort: boolean;
}

const OPERATION_TYPES = new Set<OperationType>([
  'workflow_create',
  'workflow_update',
  'requirements_finalize',
  'plan_revision',
  'review_remediation',
  'verification_record',
  'task_complete',
  'publish_promote',
  'handoff_transition',
  'handoff_accept',
  'scope_change_reclaim',
  'claim_create',
  'claim_renew_release',
  'claim_transfer',
  'claim_reclaim',
  'claim_revalidation',
  'checkpoint_create',
  'solo_handoff',
  'reframe',
  'child_result_merge',
  'task_head_reconcile',
  'transport_migrate',
  'greenfield_initialize',
  'adapter_upgrade',
  'project_policy_upgrade',
  'v3_activate',
]);
const OPERATION_STATES = new Set<OperationState>([
  'prepared',
  'applying',
  'committed',
  'repair_required',
  'aborted',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ENTITY_KEY_PATTERN = /^[a-z][a-z0-9_-]*:[^\0]+$/;

export function parseOperationJournal(value: unknown): OperationJournalV1 {
  assertRecord(value, 'operation journal');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'operationId',
      'type',
      'state',
      'primaryStoreId',
      'checkoutId',
      'secondaryReservations',
      'actorId',
      'sessionId',
      'authorizationBasis',
      'recoveryPayloadDigest',
      'entityLocks',
      'expectedRevisions',
      'steps',
      'startedAt',
      'updatedAt',
    ],
    'operation journal',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('operation journal schemaVersion must be 1');
  }
  assertUlid(value.operationId, 'operationId');
  assertUlid(value.checkoutId, 'operation checkoutId');
  assertUlid(value.actorId, 'operation actorId');
  assertUlid(value.sessionId, 'operation sessionId');
  if (
    typeof value.type !== 'string' ||
    !OPERATION_TYPES.has(value.type as OperationType)
  ) {
    throw new Error('operation journal type is invalid');
  }
  if (
    typeof value.state !== 'string' ||
    !OPERATION_STATES.has(value.state as OperationState)
  ) {
    throw new Error('operation journal state is invalid');
  }
  const authorizationBasis = parseAuthorizationBasis(value.authorizationBasis);
  if (
    authorizationBasis.actorId !== value.actorId ||
    authorizationBasis.sessionId !== value.sessionId
  ) {
    throw new Error(
      'operation journal authorization basis must match actorId and sessionId',
    );
  }
  const journal: OperationJournalV1 = {
    schemaVersion: 1,
    operationId: value.operationId,
    type: value.type as OperationType,
    state: value.state as OperationState,
    primaryStoreId: parseStoreId(value.primaryStoreId, 'primaryStoreId'),
    checkoutId: value.checkoutId,
    secondaryReservations: parseSecondaryReservations(
      value.secondaryReservations,
    ),
    actorId: value.actorId,
    sessionId: value.sessionId,
    authorizationBasis,
    recoveryPayloadDigest:
      value.recoveryPayloadDigest === undefined
        ? undefined
        : parseDigest(value.recoveryPayloadDigest, 'recoveryPayloadDigest'),
    entityLocks: parseEntityKeySet(value.entityLocks, 'entityLocks'),
    expectedRevisions: parseExpectedRevisions(value.expectedRevisions),
    steps: parseSteps(value.steps),
    startedAt: parseTimestamp(value.startedAt, 'startedAt'),
    updatedAt: parseTimestamp(value.updatedAt, 'updatedAt'),
  };
  assertStepCompletionOrder(journal.steps);
  if (
    journal.state === 'prepared' &&
    journal.steps.some((step) => step.state !== 'pending')
  ) {
    throw new Error('prepared operation journals cannot have completed steps');
  }
  if (
    journal.state === 'committed' &&
    journal.steps.some((step) => step.state !== 'completed')
  ) {
    throw new Error(
      'committed operation journals require every step to be completed',
    );
  }
  return journal;
}

export function assertOperationJournalTransition(
  previous: OperationJournalV1,
  next: OperationJournalV1,
  options: OperationTransitionOptions,
): void {
  assertJournalIdentityIsStable(previous, next);
  assertStepProgresses(previous.steps, next.steps);
  if (previous.state === next.state) return;
  if (!allowedOperationTransitions(previous.state).has(next.state)) {
    throw new Error(
      `invalid operation state transition: ${previous.state} -> ${next.state}`,
    );
  }
  if (
    next.state === 'committed' &&
    next.steps.some((step) => step.state !== 'completed')
  ) {
    throw new Error(
      'committed operation journals require every step to be completed',
    );
  }
  if (next.state === 'aborted' && !options.canAbort) {
    throw new Error('operation journal cannot abort after an external write');
  }
}

/** Digest of the complete current journal, useful for durable integrity checks. */
export function operationJournalDigest(journal: OperationJournalV1): string {
  return digestCanonicalJson(journal);
}

/**
 * A secondary reservation cannot hash the complete journal because the
 * journal embeds that reservation's digest. This stable identity projection
 * deliberately covers only immutable journal fields and reservation targets.
 */
export function operationReservationJournalDigest(
  journal: OperationJournalV1,
): string {
  const identity: Record<string, unknown> = {
    schemaVersion: journal.schemaVersion,
    operationId: journal.operationId,
    type: journal.type,
    primaryStoreId: journal.primaryStoreId,
    checkoutId: journal.checkoutId,
    actorId: journal.actorId,
    sessionId: journal.sessionId,
    authorizationBasis: journal.authorizationBasis,
    entityLocks: sortUtf8StringSet(journal.entityLocks),
    expectedRevisions: journal.expectedRevisions,
    secondaryReservationTargets: journal.secondaryReservations
      .map((reservation) => ({
        storeId: reservation.storeId,
        entityKeys: sortUtf8StringSet(reservation.entityKeys),
      }))
      .sort((left, right) => compareUtf8(left.storeId, right.storeId)),
    startedAt: journal.startedAt,
  };
  // Legacy reservation records were created before recovery payloads existed.
  // Leaving this field absent preserves their historical identity digest.
  if (journal.recoveryPayloadDigest !== undefined) {
    identity.recoveryPayloadDigest = journal.recoveryPayloadDigest;
  }
  return digestCanonicalJson(identity);
}

export function assertOperationReservationTopology(
  journal: OperationJournalV1,
): void {
  const expectedDigest = operationReservationJournalDigest(journal);
  for (const reservation of journal.secondaryReservations) {
    if (reservation.storeId === journal.primaryStoreId) {
      throw new Error(
        'operation secondary reservation cannot target primaryStoreId',
      );
    }
    if (reservation.journalDigest !== expectedDigest) {
      throw new Error(
        'operation secondary reservation journalDigest does not match the prepared journal identity',
      );
    }
  }
}

export function withOperationReservationDigests(
  journal: OperationJournalV1,
): OperationJournalV1 {
  const journalDigest = operationReservationJournalDigest(journal);
  return {
    ...journal,
    secondaryReservations: journal.secondaryReservations.map((reservation) => ({
      ...reservation,
      journalDigest,
    })),
  };
}

function parseSecondaryReservations(value: unknown): SecondaryReservation[] {
  if (!Array.isArray(value)) {
    throw new Error('operation secondaryReservations must be an array');
  }
  const storeIds = new Set<string>();
  return value.map((reservation) => {
    assertRecord(reservation, 'operation secondary reservation');
    assertKnownKeys(
      reservation,
      ['storeId', 'entityKeys', 'journalDigest'],
      'operation secondary reservation',
    );
    const storeId = parseStoreId(
      reservation.storeId,
      'secondary reservation storeId',
    );
    if (storeIds.has(storeId)) {
      throw new Error(
        'operation secondaryReservations must not repeat a store',
      );
    }
    storeIds.add(storeId);
    if (
      typeof reservation.journalDigest !== 'string' ||
      !DIGEST_PATTERN.test(reservation.journalDigest)
    ) {
      throw new Error(
        'operation secondary reservation journalDigest is invalid',
      );
    }
    return {
      storeId,
      entityKeys: parseEntityKeySet(
        reservation.entityKeys,
        'secondary reservation entityKeys',
      ),
      journalDigest: reservation.journalDigest,
    };
  });
}

function parseExpectedRevisions(value: unknown): Record<string, number> {
  assertRecord(value, 'operation expectedRevisions');
  const parsed: Record<string, number> = {};
  for (const [entityKey, revision] of Object.entries(value)) {
    assertEntityKey(entityKey, 'operation expected revision key');
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    ) {
      throw new Error(
        'operation expected revisions must be non-negative integers',
      );
    }
    parsed[entityKey] = revision;
  }
  return parsed;
}

function parseSteps(value: unknown): OperationStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('operation steps must be a non-empty array');
  }
  const ids = new Set<string>();
  return value.map((step) => {
    assertRecord(step, 'operation step');
    assertKnownKeys(step, ['id', 'state'], 'operation step');
    if (typeof step.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(step.id)) {
      throw new Error('operation step id is invalid');
    }
    if (ids.has(step.id))
      throw new Error('operation steps must not repeat an id');
    ids.add(step.id);
    if (step.state !== 'pending' && step.state !== 'completed') {
      throw new Error('operation step state is invalid');
    }
    return { id: step.id, state: step.state };
  });
}

function parseEntityKeySet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const keys = new Set<string>();
  for (const entityKey of value) {
    if (typeof entityKey !== 'string')
      throw new Error(`${label} must contain strings`);
    assertEntityKey(entityKey, label);
    if (keys.has(entityKey))
      throw new Error(`${label} must not contain duplicates`);
    keys.add(entityKey);
  }
  return [...value] as string[];
}

function parseStoreId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]*:[^\0]+$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`operation ${label} must be a sha256 digest`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`operation ${label} must be an ISO timestamp`);
  }
  return value;
}

function assertJournalIdentityIsStable(
  previous: OperationJournalV1,
  next: OperationJournalV1,
): void {
  if (
    previous.operationId !== next.operationId ||
    previous.type !== next.type ||
    previous.primaryStoreId !== next.primaryStoreId ||
    previous.checkoutId !== next.checkoutId ||
    previous.actorId !== next.actorId ||
    previous.sessionId !== next.sessionId ||
    JSON.stringify(previous.authorizationBasis) !==
      JSON.stringify(next.authorizationBasis) ||
    previous.recoveryPayloadDigest !== next.recoveryPayloadDigest ||
    previous.startedAt !== next.startedAt ||
    JSON.stringify(previous.secondaryReservations) !==
      JSON.stringify(next.secondaryReservations) ||
    JSON.stringify(previous.entityLocks) !== JSON.stringify(next.entityLocks) ||
    JSON.stringify(previous.expectedRevisions) !==
      JSON.stringify(next.expectedRevisions)
  ) {
    throw new Error('operation journal identity fields are immutable');
  }
}

function assertStepProgresses(
  previous: OperationStep[],
  next: OperationStep[],
): void {
  if (previous.length !== next.length) {
    throw new Error('operation journal steps are immutable');
  }
  for (const [index, previousStep] of previous.entries()) {
    const nextStep = next[index];
    if (!nextStep || previousStep.id !== nextStep.id) {
      throw new Error('operation journal steps are immutable');
    }
    if (previousStep.state === 'completed' && nextStep.state !== 'completed') {
      throw new Error('completed operation steps cannot become pending');
    }
  }
}

function assertStepCompletionOrder(steps: OperationStep[]): void {
  let pendingSeen = false;
  for (const step of steps) {
    if (step.state === 'pending') {
      pendingSeen = true;
      continue;
    }
    if (pendingSeen) {
      throw new Error(
        'operation journal completed steps must form a contiguous prefix',
      );
    }
  }
}

function assertEntityKey(value: string, label: string): void {
  if (!ENTITY_KEY_PATTERN.test(value) || value.includes('..')) {
    throw new Error(`${label} is invalid`);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function allowedOperationTransitions(
  from: OperationState,
): Set<OperationState> {
  switch (from) {
    case 'prepared':
      return new Set(['applying', 'aborted']);
    case 'applying':
      return new Set(['committed', 'repair_required', 'aborted']);
    case 'repair_required':
      return new Set(['committed']);
    case 'committed':
    case 'aborted':
      return new Set();
  }
}

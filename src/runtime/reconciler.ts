import { type Ulid, assertUlid } from '../context/ids.js';
import { assertRepairUsesOriginalAuthorization } from '../team/authorization.js';
import {
  OPERATION_CRASH_FIXTURES,
  OPERATION_DEFINITIONS,
  type OperationCrashFixture,
  type OperationStepDefinition,
  assertOperationJournalMatchesDefinition,
  getOperationDefinition,
} from './operation-definition.js';
import {
  type OperationJournalV1,
  assertOperationReservationTopology,
  operationReservationJournalDigest,
  parseOperationJournal,
} from './operation-journal.js';
import {
  type OperationReservationV1,
  parseOperationReservation,
} from './operation-reservation.js';

export type ProjectionAvailability =
  | 'present'
  | 'missing'
  | 'not_applicable'
  | 'conflict';
export type OperationRecoveryAction =
  | 'none'
  | 'safe_abort'
  | 'forward_repair'
  | 'projection_retry'
  | 'projection_repair_required';

export interface OperationProjectionState {
  auditEvent: ProjectionAvailability;
  sessionPointer: ProjectionAvailability;
  cache: ProjectionAvailability;
}

export interface OperationRecoveryInput {
  journal: OperationJournalV1;
  reservations?: OperationReservationV1[];
  projections?: Partial<OperationProjectionState>;
}

export interface OperationRecoveryPlan {
  action: OperationRecoveryAction;
  nextJournalState: 'aborted' | 'repair_required' | 'committed' | null;
  reason:
    | 'terminal'
    | 'no_external_write'
    | 'reservation_incomplete'
    | 'business_write_visible'
    | 'journal_marked_repair_required'
    | 'projection_missing'
    | 'projection_conflict';
  pendingEntityLocks: string[];
  remainingStepIds: string[];
  retryProjections: Array<'auditEvent' | 'sessionPointer' | 'cache'>;
  authorization: OperationJournalV1['authorizationBasis'];
}

/**
 * Converts durable journal state into a side-effect-free repair decision. The
 * executor applies this plan under the existing canonical locks; this planner
 * never infers a successor owner or substitutes a new actor/session.
 */
export function planOperationRecovery(
  input: OperationRecoveryInput,
): OperationRecoveryPlan {
  const journal = parseOperationJournal(input.journal);
  assertOperationJournalMatchesDefinition(journal);
  assertOperationReservationTopology(journal);
  const definition = getOperationDefinition(journal.type);
  const reservationsConsistent =
    input.reservations === undefined ||
    reservationsMatchJournal(journal, input.reservations);
  const remainingStepIds = journal.steps
    .filter((step) => step.state === 'pending')
    .map((step) => step.id);
  const pendingEntityLocks =
    journal.state === 'committed' || journal.state === 'aborted'
      ? []
      : [...journal.entityLocks];

  if (journal.state === 'aborted') {
    return recoveryPlan(journal, 'none', null, 'terminal', [], []);
  }
  if (journal.state === 'committed') {
    return planCommittedProjectionRecovery(journal, input.projections ?? {});
  }
  if (journal.state === 'repair_required') {
    return recoveryPlan(
      journal,
      'forward_repair',
      'repair_required',
      reservationsConsistent
        ? 'journal_marked_repair_required'
        : 'reservation_incomplete',
      pendingEntityLocks,
      remainingStepIds,
    );
  }
  const externalWriteVisible = hasCompletedExternalWrite(
    journal,
    definition.steps,
  );
  if (externalWriteVisible) {
    return recoveryPlan(
      journal,
      'forward_repair',
      'repair_required',
      reservationsConsistent
        ? 'business_write_visible'
        : 'reservation_incomplete',
      pendingEntityLocks,
      remainingStepIds,
    );
  }
  // A missing reservation before the first business write is still safe to
  // abort: no task state has become externally visible and reservations can be
  // removed as compensation. After a write, the branch above repairs forward.
  return recoveryPlan(
    journal,
    'safe_abort',
    'aborted',
    reservationsConsistent ? 'no_external_write' : 'reservation_incomplete',
    pendingEntityLocks,
    remainingStepIds,
  );
}

/** Enforces that a repair executor cannot swap in its own actor or session. */
export function assertRecoveryActor(
  plan: OperationRecoveryPlan,
  actorId: Ulid,
  sessionId: Ulid,
): void {
  assertUlid(actorId, 'recovery actorId');
  assertUlid(sessionId, 'recovery sessionId');
  assertRepairUsesOriginalAuthorization(plan.authorization, actorId, sessionId);
}

/** Makes every declared crash fixture executable and rejects definition drift. */
export function assertOperationCrashFixtureCoverage(): void {
  for (const definition of Object.values(OPERATION_DEFINITIONS)) {
    const fixtures = OPERATION_CRASH_FIXTURES[definition.type];
    if (fixtures.length !== definition.steps.length + 1) {
      throw new Error(
        `operation ${definition.type} has incomplete crash fixture coverage`,
      );
    }
    for (const fixture of fixtures) {
      if (fixture.operationType !== definition.type) {
        throw new Error(
          'operation crash fixture type does not match definition',
        );
      }
      if (fixture.expectedRecovery !== crashRecoveryForFixture(fixture)) {
        throw new Error('operation crash fixture recovery does not match step');
      }
    }
  }
}

export function crashRecoveryForFixture(
  fixture: OperationCrashFixture,
): OperationCrashFixture['expectedRecovery'] {
  if (fixture.crashAfter === 'prepared') return 'safe_abort';
  const step = getOperationDefinition(fixture.operationType).steps.find(
    (candidate) => candidate.id === fixture.crashAfter,
  );
  if (step === undefined) {
    throw new Error('operation crash fixture references an unknown step');
  }
  return step.crashRecovery;
}

function planCommittedProjectionRecovery(
  journal: OperationJournalV1,
  partial: Partial<OperationProjectionState>,
): OperationRecoveryPlan {
  const projections: OperationProjectionState = {
    auditEvent: partial.auditEvent ?? 'missing',
    sessionPointer: partial.sessionPointer ?? 'not_applicable',
    cache: partial.cache ?? 'not_applicable',
  };
  for (const value of Object.values(projections)) {
    if (
      value !== 'present' &&
      value !== 'missing' &&
      value !== 'not_applicable' &&
      value !== 'conflict'
    ) {
      throw new Error('operation projection availability is invalid');
    }
  }
  const retryProjections = (
    Object.entries(projections) as Array<
      ['auditEvent' | 'sessionPointer' | 'cache', ProjectionAvailability]
    >
  )
    .filter(([, value]) => value === 'missing')
    .map(([key]) => key);
  if (Object.values(projections).includes('conflict')) {
    return recoveryPlan(
      journal,
      'projection_repair_required',
      'committed',
      'projection_conflict',
      [],
      [],
      retryProjections,
    );
  }
  if (retryProjections.length > 0) {
    return recoveryPlan(
      journal,
      'projection_retry',
      'committed',
      'projection_missing',
      [],
      [],
      retryProjections,
    );
  }
  return recoveryPlan(journal, 'none', null, 'terminal', [], []);
}

function recoveryPlan(
  journal: OperationJournalV1,
  action: OperationRecoveryAction,
  nextJournalState: OperationRecoveryPlan['nextJournalState'],
  reason: OperationRecoveryPlan['reason'],
  pendingEntityLocks: string[],
  remainingStepIds: string[],
  retryProjections: OperationRecoveryPlan['retryProjections'] = [],
): OperationRecoveryPlan {
  return {
    action,
    nextJournalState,
    reason,
    pendingEntityLocks,
    remainingStepIds,
    retryProjections,
    authorization: journal.authorizationBasis,
  };
}

function hasCompletedExternalWrite(
  journal: OperationJournalV1,
  definitions: OperationStepDefinition[],
): boolean {
  return journal.steps.some((step, index) => {
    const definition = definitions[index];
    if (definition === undefined) {
      throw new Error('operation journal step definition is missing');
    }
    return (
      step.state === 'completed' &&
      (definition.visibility === 'business_write' ||
        definition.visibility === 'commit')
    );
  });
}

function reservationsMatchJournal(
  journal: OperationJournalV1,
  reservations: OperationReservationV1[],
): boolean {
  const expectedDigest = operationReservationJournalDigest(journal);
  const expected = [...journal.secondaryReservations];
  if (reservations.length !== expected.length) return false;
  for (const rawReservation of reservations) {
    let reservation: OperationReservationV1;
    try {
      reservation = parseOperationReservation(rawReservation);
    } catch {
      return false;
    }
    const matchIndex = expected.findIndex(
      (candidate) =>
        candidate.entityKeys.length === reservation.entityKeys.length &&
        candidate.entityKeys.every((key) =>
          reservation.entityKeys.includes(key),
        ),
    );
    if (
      matchIndex < 0 ||
      reservation.operationId !== journal.operationId ||
      reservation.primaryStoreId !== journal.primaryStoreId ||
      reservation.journalDigest !== expectedDigest
    ) {
      return false;
    }
    expected.splice(matchIndex, 1);
  }
  return expected.length === 0;
}

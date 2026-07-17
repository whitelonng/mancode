import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_MATRIX,
  type AuthorizationRequest,
  assertAuthorized,
  assertRepairUsesOriginalAuthorization,
  createAuthorizationBasis,
  evaluateAuthorization,
} from '../src/team/authorization.js';

const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const OTHER_ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';

describe('cooperative authorization matrix', () => {
  it('freezes all documented mutating actor rules and keeps the trust boundary explicit', () => {
    expect(AUTHORIZATION_MATRIX).toHaveLength(15);
    const decision = evaluateAuthorization(baseRequest());
    expect(decision).toEqual({
      allowed: true,
      failures: [],
      trustBoundary: 'repo-collaborators',
    });
  });

  it('requires the correct task/claim/handoff actor and fresh authority facts', () => {
    expect(() =>
      assertAuthorized({
        ...baseRequest(),
        action: 'handoff_accept_reject',
        handoff: {
          fromActorId: OTHER_ACTOR_ID,
          toActorId: OTHER_ACTOR_ID,
          intent: 'accept',
        },
      }),
    ).toThrow('MANCODE_HANDOFF_ACTOR_MISMATCH');
    expect(() =>
      assertAuthorized({
        ...baseRequest(),
        action: 'claim_create',
        conditions: {
          ...baseRequest().conditions,
          implementationScopeContainsClaim: false,
        },
      }),
    ).toThrow('MANCODE_SCOPE_OUTSIDE_IMPLEMENTATION_SCOPE');
  });

  it('forbids P0 waivers and binds repair to the original actor/session authorization', () => {
    const waiver = {
      ...baseRequest(),
      action: 'review_skip_or_waiver' as const,
      conditions: {
        ...baseRequest().conditions,
        reviewAction: 'waiver' as const,
        reviewSeverity: 'p0' as const,
      },
    };
    expect(() => assertAuthorized(waiver)).toThrow('MANCODE_WAIVER_FORBIDDEN');

    const basis = createAuthorizationBasis(
      baseRequest(),
      new Date('2026-07-17T10:00:00.000Z'),
    );
    expect(() =>
      assertRepairUsesOriginalAuthorization(basis, ACTOR_ID, SESSION_ID),
    ).not.toThrow();
    expect(() =>
      assertRepairUsesOriginalAuthorization(basis, OTHER_ACTOR_ID, SESSION_ID),
    ).toThrow('MANCODE_REPAIR_AUTHORIZATION_MISMATCH');
  });
});

function baseRequest(): AuthorizationRequest {
  return {
    action: 'shared_metadata_plan_mutation',
    actorId: ACTOR_ID,
    session: { sessionId: SESSION_ID, actorId: ACTOR_ID, status: 'active' },
    joined: true,
    sharedWriteGuard: 'advisory',
    task: {
      ownerActorId: ACTOR_ID,
      participantActorIds: [ACTOR_ID, OTHER_ACTOR_ID],
    },
    claim: { ownerActorId: ACTOR_ID, transferTargetActorId: null },
    handoff: {
      fromActorId: ACTOR_ID,
      toActorId: OTHER_ACTOR_ID,
      intent: 'offer',
    },
    evidence: { assignedToActor: true, restrictsWriteToAssignedItem: true },
    profileActorId: ACTOR_ID,
    conditions: {
      expectedRevisionMatches: true,
      ownershipEpochFresh: true,
      privacyConfirmed: true,
      explicitConfirmation: true,
      taskContextAvailable: true,
      transportFresh: true,
      gitSourceConfirmed: true,
      completionGateSatisfied: true,
      claimHandoffConsistent: true,
      implementationScopeContainsClaim: true,
      coordinationStoreFresh: true,
      reason: 'The previous owner explicitly requested re-claim.',
    },
  };
}

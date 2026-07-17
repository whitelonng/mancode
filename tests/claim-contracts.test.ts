import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  type ClaimV1,
  assertClaimTransition,
  parseClaim,
} from '../src/team/claims.js';

const CLAIM_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('claim contract', () => {
  it('binds a shared claim to a canonical scope digest and never persists runtime stale states', () => {
    const parsed = parseClaim(claim());
    expect(parsed.scope.paths).toEqual(['src/auth/**', 'tests/auth/**']);
    expect(() =>
      parseClaim({ ...claim(), state: 'needs_revalidation' }),
    ).toThrow(/claim state/);
    expect(() =>
      parseClaim({
        ...claim(),
        taskRef: { namespace: 'local', taskId: TASK_ID },
      }),
    ).toThrow(/shared TaskRefs/);
    expect(() => parseClaim({ ...claim(), scopeDigest: DIGEST })).toThrow(
      /does not match/,
    );
  });

  it('allows only the stable pending/active/terminal claim state machine', () => {
    const pending = parseClaim({ ...claim(), state: 'pending', revision: 1 });
    const active = parseClaim({ ...pending, state: 'active', revision: 2 });
    const released = parseClaim({ ...active, state: 'released', revision: 3 });
    expect(() => assertClaimTransition(pending, active)).not.toThrow();
    expect(() => assertClaimTransition(active, released)).not.toThrow();
    expect(() =>
      assertClaimTransition(released, {
        ...released,
        state: 'active',
        revision: 4,
      }),
    ).toThrow(/invalid claim state transition/);
  });

  it('requires a new claim identity for a scope change or expired re-claim', () => {
    const active = parseClaim({ ...claim(), state: 'active', revision: 1 });
    const changedScope = parseClaim({
      ...active,
      revision: 2,
      scope: { ...active.scope, paths: ['src/billing/**'] },
      scopeDigest: digestCanonicalJson({
        ...active.scope,
        paths: ['src/billing/**'],
      }),
    });
    expect(() => assertClaimTransition(active, changedScope)).toThrow(
      /scope are immutable/,
    );
    const expired = parseClaim({ ...active, state: 'expired', revision: 2 });
    expect(() =>
      assertClaimTransition(expired, {
        ...expired,
        state: 'active',
        revision: 3,
      }),
    ).toThrow(/invalid claim state transition/);
  });

  it('blocks sensitive values before they can enter a shared claim scope', () => {
    const scope = { ...claim().scope, paths: ['/Users/alice/private/**'] };
    expect(() =>
      parseClaim({
        ...claim(),
        scope,
        scopeDigest: digestCanonicalJson(scope),
      }),
    ).toThrow(/MANCODE_PRIVACY_BLOCKED/);
  });

  it('accepts only repository-relative claim path globs', () => {
    for (const paths of [
      ['src/../auth/**'],
      ['src//auth/**'],
      ['src\\auth\\**'],
    ]) {
      const scope = { ...claim().scope, paths };
      expect(() =>
        parseClaim({
          ...claim(),
          scope,
          scopeDigest: digestCanonicalJson(scope),
        }),
      ).toThrow(/safe repository-relative/);
    }
  });
});

function claim(): ClaimV1 {
  const scope = {
    paths: ['tests/auth/**', 'src/auth/**'],
    modules: ['auth-api'],
    apis: [],
    schemas: [],
  };
  return {
    schemaVersion: 1,
    claimId: CLAIM_ID,
    workspaceId: CLAIM_ID,
    coordinationDomainId: `local:${CLAIM_ID}:${CLAIM_ID}`,
    authority: { mode: 'local', remoteRevision: null },
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    taskRevisionAtAcquire: 7,
    lastValidatedTaskRevision: 7,
    implementationScopeDigest: DIGEST,
    ownershipEpochAtAcquire: 3,
    ownerActorId: ACTOR_ID,
    state: 'active',
    revision: 1,
    scope,
    scopeDigest: digestCanonicalJson({
      paths: ['src/auth/**', 'tests/auth/**'],
      modules: ['auth-api'],
      apis: [],
      schemas: [],
    }),
    codeRefAtAcquire: { branch: 'feature/login', head: 'abc1234' },
    lastValidatedCodeRef: { branch: 'feature/login', head: 'abc1234' },
    acquisitionEnforcement: 'enforced',
    writeGuard: 'advisory',
    expiresAt: '2026-07-18T10:00:00.000Z',
    predecessorClaimId: null,
    successorClaimId: null,
    lastOperationId: null,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

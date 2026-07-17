import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { type ClaimV1, parseClaim } from '../src/team/claims.js';
import {
  assertClaimScopeSubset,
  assessClaimConflicts,
  deriveClaimValidity,
} from '../src/team/conflicts.js';

const CLAIM_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const OTHER_CLAIM_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('claim validity and conflict contract', () => {
  it('requires an explicit implementation scope proof before claim acquisition', () => {
    expect(() =>
      assertClaimScopeSubset(claim().scope, {
        source: 'explicit',
        include: ['src/**'],
        exclude: ['src/private/**'],
        modules: ['auth-api'],
        apis: [],
        schemas: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertClaimScopeSubset(claim().scope, {
        source: 'legacy_unspecified',
        include: [],
        exclude: [],
        modules: [],
      }),
    ).toThrow('MANCODE_SCOPE_CONFIRMATION_REQUIRED');
  });

  it('derives revalidation and re-claim states instead of persisting them', () => {
    const active = parseClaim(claim());
    expect(
      deriveClaimValidity(active, validationContext({ taskRevision: 8 })),
    ).toBe('needs_revalidation');
    expect(
      deriveClaimValidity(
        active,
        validationContext({
          implementationScopeDigest: `sha256:${'b'.repeat(64)}`,
        }),
      ),
    ).toBe('reclaim_required');
  });

  it('never says a stale transport has no conflict and blocks fresh shared schema conflicts', () => {
    const existing = parseClaim({
      ...claim(),
      claimId: OTHER_CLAIM_ID,
      scope: { ...claim().scope, schemas: ['public.User'] },
      scopeDigest: digestCanonicalJson({
        ...claim().scope,
        schemas: ['public.User'],
      }),
    });
    const candidate = { ...claim().scope, schemas: ['public.User'] };
    expect(
      assessClaimConflicts(candidate, [existing], {
        transportFreshness: 'fresh',
        claimAcquisition: 'enforced',
      }),
    ).toMatchObject({ level: 'blocker', acquisition: 'reject' });
    expect(
      assessClaimConflicts(candidate, [existing], {
        transportFreshness: 'stale',
        claimAcquisition: 'enforced',
      }),
    ).toMatchObject({ level: 'unknown', acquisition: 'sync_or_confirm' });
  });

  it('treats identical globs as an overlap rather than silently downgrading them to info', () => {
    const existing = parseClaim(claim());
    expect(
      assessClaimConflicts(existing.scope, [existing], {
        transportFreshness: 'fresh',
        claimAcquisition: 'enforced',
      }),
    ).toMatchObject({ level: 'warning', acquisition: 'confirm_or_narrow' });
  });
});

function validationContext(
  overrides: Partial<{
    taskRevision: number;
    implementationScopeDigest: string;
  }> = {},
) {
  return {
    taskRef: { namespace: 'shared' as const, taskId: TASK_ID },
    taskRevision: overrides.taskRevision ?? 7,
    implementationScopeDigest: overrides.implementationScopeDigest ?? DIGEST,
    ownershipEpoch: 3,
    codeRefHead: 'abc1234',
    now: new Date('2026-07-17T10:00:00.000Z'),
    transportFreshness: 'fresh' as const,
  };
}

function claim(): ClaimV1 {
  const scope = {
    paths: ['src/auth/**'],
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
    scopeDigest: digestCanonicalJson(scope),
    codeRefAtAcquire: { branch: 'feature/auth', head: 'abc1234' },
    lastValidatedCodeRef: { branch: 'feature/auth', head: 'abc1234' },
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

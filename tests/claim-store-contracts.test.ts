import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import type { Ulid } from '../src/context/ids.js';
import {
  claimPath,
  createClaim,
  listClaims,
  readClaim,
  updateClaim,
} from '../src/runtime/claim-store.js';
import type { EntityHomeStore } from '../src/runtime/entity-home-store.js';
import type { ClaimV1 } from '../src/team/claims.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H' as Ulid;
const CLAIM_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J' as Ulid;
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K' as Ulid;
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M' as Ulid;

describe('claim authority store', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-claim-store-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates immutable claim IDs and performs revision-CAS transitions', async () => {
    const store = homeStore(root);
    const active = claim();
    await expect(createClaim(store, active)).resolves.toEqual(active);
    await expect(createClaim(store, active)).resolves.toEqual(active);
    await expect(readClaim(store, CLAIM_ID)).resolves.toEqual(active);
    await expect(listClaims(store, active.taskRef)).resolves.toEqual([active]);

    const released: ClaimV1 = {
      ...active,
      state: 'released',
      revision: 2,
      lastOperationId: CLAIM_ID,
      updatedAt: '2026-07-17T10:01:00.000Z',
    };
    await expect(updateClaim(store, released, 1)).resolves.toEqual(released);
    await expect(updateClaim(store, released, 1)).rejects.toThrow(
      'MANCODE_EXPECTED_REVISION_CONFLICT',
    );
  });

  it('refuses to reinterpret a claim ID as a different immutable snapshot', async () => {
    const store = homeStore(root);
    const active = claim();
    await createClaim(store, active);
    await expect(
      createClaim(store, { ...active, ownerActorId: WORKSPACE_ID }),
    ).rejects.toThrow('MANCODE_CLAIM_ID_CONFLICT');
    expect(claimPath(store, CLAIM_ID)).toContain(`${CLAIM_ID}.json`);
  });
});

function homeStore(root: string): EntityHomeStore {
  return {
    kind: 'non_git_shared',
    storeId: `non-git:${WORKSPACE_ID}`,
    root,
    workspaceId: WORKSPACE_ID,
    checkoutId: null,
    repositoryBindingId: null,
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
    workspaceId: WORKSPACE_ID,
    coordinationDomainId: `local:${WORKSPACE_ID}:${WORKSPACE_ID}`,
    authority: { mode: 'local', remoteRevision: null },
    taskRef: { namespace: 'shared', taskId: TASK_ID },
    taskRevisionAtAcquire: 1,
    lastValidatedTaskRevision: 1,
    implementationScopeDigest: `sha256:${'a'.repeat(64)}`,
    ownershipEpochAtAcquire: 1,
    ownerActorId: ACTOR_ID,
    state: 'active',
    revision: 1,
    scope,
    scopeDigest: digestCanonicalJson(scope),
    codeRefAtAcquire: { branch: 'main', head: 'abc123' },
    lastValidatedCodeRef: { branch: 'main', head: 'abc123' },
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

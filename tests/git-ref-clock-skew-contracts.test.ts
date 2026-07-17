import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { V3ContextStore } from '../src/context/store.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import type { WorkflowMetadataV3 } from '../src/context/workflow-metadata.js';
import { createSession } from '../src/runtime/session.js';
import { gitRefCoordinationDomainId } from '../src/runtime/workspace-binding.js';
import {
  type SharedActorProfileV1,
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';
import type { ClaimV1 } from '../src/team/claims.js';
import {
  assessClaimConflicts,
  deriveClaimValidity,
} from '../src/team/conflicts.js';
import { createGitRefTaskBundle } from '../src/team/git-ref-bundle.js';
import {
  type PreparedGitRefCoordinationMutation,
  prepareGitRefCoordinationMutation,
} from '../src/team/git-ref-coordination.js';
import {
  type GitRefTaskBundleV1,
  type GitRefTeamManifestStore,
  type GitRefTeamManifestV1,
  GitRefTeamManifestStore as ManifestStore,
  resolveGitRefRemoteIdentityHash,
} from '../src/team/git-ref-transport.js';

const execFile = promisify(execFileCallback);
const TASK_REF: TaskRef = { namespace: 'shared', taskId: id(1) };
const WORKSPACE_ID = id(2);
const OWNER_ID = id(3);
const PARTICIPANT_ID = id(4);
const CLAIM_ID = id(5);
const SCHEMA_EPOCH = id(6);
const OWNER_SESSION_ID = id(7);
const NOW = new Date('2026-07-18T10:00:00.000Z');
const EXPIRES_AT = new Date('2026-07-18T10:01:00.000Z');
const SKEWED_NOW = new Date('2026-07-18T10:02:00.000Z');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('git-ref clock-skew coordination contract', () => {
  it('requires explicit reclaim plus claim/revision CAS before an expiry candidate changes remote state', async () => {
    const fixture = await createFixture();
    let clock = NOW;
    const storeA = store(fixture.cloneA, () => clock);
    const storeB = store(fixture.cloneB, () => clock);
    const remoteIdentityHash = await resolveGitRefRemoteIdentityHash(
      fixture.cloneA,
      'origin',
    );
    const coordinationDomainId = gitRefCoordinationDomainId(
      remoteIdentityHash,
      WORKSPACE_ID,
      1,
    );
    const { metadata, taskBundle } = await createTaskBundle(
      fixture.cloneA,
      fixture.head,
    );
    const claim = activeClaim(coordinationDomainId, metadata, taskBundle);
    const establishOperationId = id(10);

    await storeA.establishCoordinationAuthority({
      operationId: establishOperationId,
      actorId: OWNER_ID,
      expectedRemoteRevision: 0,
      expectedPriorTransportEpoch: null,
      targetTransportEpoch: 1,
      actorProfiles: [
        actorProfile(OWNER_ID, 'Owner'),
        actorProfile(PARTICIPANT_ID, 'Participant'),
      ],
      ownershipFences: [
        {
          schemaVersion: 1,
          taskRef: TASK_REF,
          ownerActorId: OWNER_ID,
          ownershipEpoch: 1,
          taskRevision: taskBundle.taskRevision,
          aggregateDigest: taskBundle.aggregateDigest,
          remoteRevision: 1,
          lastOperationId: establishOperationId,
          updatedAt: NOW.toISOString(),
        },
      ],
      claims: [{ ...claim, lastOperationId: establishOperationId }],
      handoffs: [],
      taskBundles: [taskBundle],
    });

    const snapshotA = await requireManifest(storeA);
    const snapshotB = await requireManifest(storeB);
    const unchangedSnapshot = structuredClone(snapshotA);
    clock = SKEWED_NOW;

    expect(
      deriveClaimValidity(snapshotA.claims[0] as ClaimV1, {
        taskRef: TASK_REF,
        taskRevision: taskBundle.taskRevision,
        implementationScopeDigest: metadata.implementationScope.digest,
        ownershipEpoch: taskBundle.ownershipEpoch,
        codeRefHead: taskBundle.codeRef.head,
        now: SKEWED_NOW,
        transportFreshness: 'fresh',
      }),
    ).toBe('expiry_candidate');
    expect(
      assessClaimConflicts(scope(), snapshotA.claims, {
        transportFreshness: 'fresh',
        claimAcquisition: 'enforced',
      }),
    ).toMatchObject({
      level: 'blocker',
      acquisition: 'reject',
      conflictingClaimIds: [CLAIM_ID],
    });

    expect(() =>
      prepareGitRefCoordinationMutation(snapshotA, {
        kind: 'claim_acquire',
        operationId: id(20),
        actorId: PARTICIPANT_ID,
        taskRef: TASK_REF,
        expectedRemoteRevision: 1,
        expectedOwnershipEpoch: 1,
        claim: pendingClaim(coordinationDomainId, metadata, taskBundle, id(21)),
        now: SKEWED_NOW,
      }),
    ).toThrow('MANCODE_CLAIM_REVALIDATION_REQUIRED');
    expect(snapshotA).toEqual(unchangedSnapshot);
    await expect(requireManifest(storeA)).resolves.toEqual(unchangedSnapshot);

    expect(() =>
      prepareReclaim(snapshotA, {
        operationId: id(22),
        expectedRemoteRevision: 1,
        expectedClaimRevision: 2,
      }),
    ).toThrow('MANCODE_EXPECTED_REVISION_CONFLICT');
    expect(() =>
      prepareReclaim(snapshotA, {
        operationId: id(23),
        expectedRemoteRevision: 0,
        expectedClaimRevision: 1,
      }),
    ).toThrow('MANCODE_TRANSPORT_REVISION_CONFLICT');
    await expect(requireManifest(storeB)).resolves.toEqual(unchangedSnapshot);

    const reclaimA = prepareReclaim(snapshotA, {
      operationId: id(30),
      expectedRemoteRevision: 1,
      expectedClaimRevision: 1,
    });
    const reclaimB = prepareReclaim(snapshotB, {
      operationId: id(31),
      expectedRemoteRevision: 1,
      expectedClaimRevision: 1,
    });
    const results = await Promise.allSettled([
      storeA.mutateCoordination(reclaimA),
      storeB.mutateCoordination(reclaimB),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toMatch(
      /MANCODE_TRANSPORT_(CAS|REVISION)_CONFLICT/,
    );
    await expect(storeB.mutateCoordination(reclaimB)).rejects.toThrow(
      'MANCODE_TRANSPORT_REVISION_CONFLICT',
    );

    const committed = await requireManifest(storeA);
    expect(committed).toMatchObject({
      revision: 2,
      claims: [
        {
          claimId: CLAIM_ID,
          state: 'expired',
          revision: 2,
          authority: { mode: 'git-ref', remoteRevision: '2' },
        },
      ],
    });
    expect([id(30), id(31)]).toContain(committed.lastOperationId);
  }, 20_000);
});

function prepareReclaim(
  manifest: GitRefTeamManifestV1,
  input: {
    operationId: string;
    expectedRemoteRevision: number;
    expectedClaimRevision: number;
  },
): PreparedGitRefCoordinationMutation {
  return prepareGitRefCoordinationMutation(manifest, {
    kind: 'claim_reclaim',
    operationId: input.operationId,
    actorId: OWNER_ID,
    taskRef: TASK_REF,
    expectedRemoteRevision: input.expectedRemoteRevision,
    expectedOwnershipEpoch: 1,
    claimId: CLAIM_ID,
    expectedClaimRevision: input.expectedClaimRevision,
    reason: 'The freshly pulled remote claim is an expiry candidate.',
    now: SKEWED_NOW,
  });
}

function activeClaim(
  coordinationDomainId: string,
  metadata: WorkflowMetadataV3,
  taskBundle: GitRefTaskBundleV1,
): ClaimV1 {
  return {
    ...pendingClaim(coordinationDomainId, metadata, taskBundle, CLAIM_ID),
    authority: { mode: 'git-ref', remoteRevision: '1' },
    state: 'active',
    expiresAt: EXPIRES_AT.toISOString(),
  };
}

function pendingClaim(
  coordinationDomainId: string,
  metadata: WorkflowMetadataV3,
  taskBundle: GitRefTaskBundleV1,
  claimId: string,
): ClaimV1 {
  const claimScope = scope();
  return {
    schemaVersion: 1,
    claimId,
    workspaceId: WORKSPACE_ID,
    coordinationDomainId,
    authority: { mode: 'git-ref', remoteRevision: null },
    taskRef: TASK_REF,
    taskRevisionAtAcquire: taskBundle.taskRevision,
    lastValidatedTaskRevision: taskBundle.taskRevision,
    implementationScopeDigest: metadata.implementationScope.digest,
    ownershipEpochAtAcquire: taskBundle.ownershipEpoch,
    ownerActorId: claimId === CLAIM_ID ? OWNER_ID : PARTICIPANT_ID,
    state: 'pending',
    revision: 1,
    scope: claimScope,
    scopeDigest: digestCanonicalJson(claimScope),
    codeRefAtAcquire: taskBundle.codeRef,
    lastValidatedCodeRef: taskBundle.codeRef,
    acquisitionEnforcement: 'enforced',
    writeGuard: 'advisory',
    expiresAt: new Date(SKEWED_NOW.getTime() + 60_000).toISOString(),
    predecessorClaimId: null,
    successorClaimId: null,
    lastOperationId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function scope() {
  return {
    paths: ['src/auth/token.ts'],
    modules: ['auth'],
    apis: [],
    schemas: [],
  };
}

function actorProfile(
  actorId: string,
  displayName: string,
): SharedActorProfileV1 {
  return {
    schemaVersion: 1,
    actorId,
    displayName,
    joinedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function store(projectRoot: string, now: () => Date): GitRefTeamManifestStore {
  return new ManifestStore({
    projectRoot,
    remote: 'origin',
    workspaceId: WORKSPACE_ID,
    schemaEpoch: SCHEMA_EPOCH,
    now,
  });
}

async function createTaskBundle(
  projectRoot: string,
  head: string,
): Promise<{
  metadata: WorkflowMetadataV3;
  taskBundle: GitRefTaskBundleV1;
}> {
  await initializeV3Project({
    projectRoot,
    operationId: id(40),
    workspaceId: WORKSPACE_ID,
    schemaEpoch: SCHEMA_EPOCH,
    now: NOW,
  });
  const owner = await createLocalActor(projectRoot, {
    actorId: OWNER_ID,
    displayName: 'Owner',
    now: NOW,
  });
  await Promise.all([
    publishSharedActorProfile(
      projectRoot,
      createSharedActorProfile(owner, NOW),
    ),
    publishSharedActorProfile(
      projectRoot,
      actorProfile(PARTICIPANT_ID, 'Participant'),
    ),
  ]);
  await createSession(projectRoot, {
    actorId: OWNER_ID,
    sessionId: OWNER_SESSION_ID,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  const workflow = await createV3Workflow({
    projectRoot,
    task: 'Keep remote claim authority stable across local clock skew.',
    workflowMode: 'manteam',
    sessionId: OWNER_SESSION_ID,
    client: 'vitest',
    sharedPrivacyConfirmed: true,
    participantActorIds: [PARTICIPANT_ID],
    implementationScope: { include: ['src/auth/**'], modules: ['auth'] },
    taskId: TASK_REF.taskId,
    operationId: id(41),
    now: NOW,
  });
  const task = await new V3ContextStore(projectRoot).readTaskSnapshot(
    workflow.taskRef,
  );
  return {
    metadata: task.metadata,
    taskBundle: createGitRefTaskBundle({
      task,
      codeRef: { branch: 'main', head },
      now: NOW,
    }),
  };
}

async function requireManifest(
  store: GitRefTeamManifestStore,
): Promise<GitRefTeamManifestV1> {
  const manifest = (await store.pull()).manifest;
  if (manifest === null) throw new Error('missing git-ref manifest');
  return manifest;
}

async function createFixture(): Promise<{
  cloneA: string;
  cloneB: string;
  head: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-clock-skew-'));
  temporaryRoots.push(root);
  const remote = path.join(root, 'remote.git');
  const cloneA = path.join(root, 'clone-a');
  const cloneB = path.join(root, 'clone-b');
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['clone', remote, cloneA]);
  await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
    cwd: cloneA,
  });
  await execFile('git', ['config', 'user.name', 'Vitest'], { cwd: cloneA });
  await writeFile(path.join(cloneA, 'README.md'), '# clock skew fixture\n');
  await execFile('git', ['add', 'README.md'], { cwd: cloneA });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: cloneA });
  await execFile('git', ['branch', '-M', 'main'], { cwd: cloneA });
  await execFile('git', ['push', '-u', 'origin', 'main'], { cwd: cloneA });
  await execFile('git', ['clone', '--branch', 'main', remote, cloneB]);
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
    cwd: cloneA,
  });
  return { cloneA, cloneB, head: stdout.trim() };
}

function id(value: number): string {
  return `01JZ4B6W5Z0A1B2C3D4E5F${value.toString().padStart(4, '0')}`;
}

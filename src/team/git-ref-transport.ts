import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type TaskAggregateManifestV1,
  parseTaskAggregateManifest,
  taskAggregateDigest,
} from '../context/aggregate.js';
import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import {
  assertSafeSharedRelativePath,
  assertSharedTextSafe,
} from '../context/privacy.js';
import {
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from '../context/requirements-ledger.js';
import {
  parseReviewLedger,
  reviewLedgerDigest,
} from '../context/review-ledger.js';
import {
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import {
  parseVerificationLedger,
  verificationLedgerDigest,
} from '../context/verification-ledger.js';
import {
  type WorkflowMetadataV3,
  parseWorkflowMetadata,
  workflowMetadataDigest,
} from '../context/workflow-metadata.js';
import { gitRefCoordinationDomainId } from '../runtime/workspace-binding.js';
import { type SharedActorProfileV1, parseSharedActorProfile } from './actor.js';
import { checkpointDigest, parseCheckpoint } from './checkpoints.js';
import { type ClaimV1, assertClaimTransition, parseClaim } from './claims.js';
import {
  type HandoffV1,
  assertHandoffTransition,
  parseHandoff,
} from './handoff.js';
import type { CoordinationCapabilitiesV1 } from './transport.js';

const execFile = promisify(execFileCallback);
const TEAM_REF = 'refs/mancode/team';
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_ACTOR_PROFILES = 256;
const MAX_OWNERSHIP_FENCES = 512;
const MAX_CLAIMS = 2_048;
const MAX_HANDOFFS = 1_024;
const MAX_TASK_BUNDLES = 128;
const MAX_RECEIPTS = 256;
const MAX_BUNDLE_ARTIFACTS = 16;
const MAX_BUNDLE_ARTIFACT_BYTES = 256_000;
const MAX_JSON_DEPTH = 64;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/;

export interface GitRefOwnershipFenceV1 {
  schemaVersion: 1;
  taskRef: TaskRef;
  ownerActorId: Ulid;
  ownershipEpoch: number;
  taskRevision: number;
  aggregateDigest: string;
  remoteRevision: number;
  lastOperationId: Ulid;
  updatedAt: string;
}

export type GitRefTaskBundleArtifactKind =
  | 'metadata'
  | 'checkpoint'
  | 'requirements'
  | 'review'
  | 'verification'
  | 'plan'
  | 'summary';

/** Runtime parsing narrows this to JSON; callers may pass typed domain values. */
export type GitRefJsonValue = unknown;

export interface GitRefTaskBundleArtifactV1 {
  kind: GitRefTaskBundleArtifactKind;
  relativePath: string;
  content: GitRefJsonValue;
  contentDigest: string;
}

export interface GitRefTaskBundleV1 {
  schemaVersion: 1;
  taskRef: TaskRef;
  taskRevision: number;
  ownershipEpoch: number;
  aggregate: TaskAggregateManifestV1;
  aggregateDigest: string;
  codeRef: {
    branch: string;
    head: string;
  };
  artifacts: GitRefTaskBundleArtifactV1[];
  bundleDigest: string;
  createdAt: string;
}

export interface GitRefRemoteMutationReceiptV1 {
  schemaVersion: 1;
  kind:
    | 'actor_profile'
    | 'coordination'
    | 'authority_establish'
    | 'authority_freeze'
    | 'authority_unfreeze'
    | 'authority_tombstone';
  operationId: Ulid;
  actorId: Ulid;
  taskRef: TaskRef | null;
  remoteRevision: number;
  ownershipEpoch: number | null;
  entityDigests: {
    actorProfiles: string;
    ownershipFence: string | null;
    claims: string;
    handoffs: string;
    taskBundle: string | null;
  };
  committedAt: string;
}

export interface GitRefAuthorityTombstoneV1 {
  schemaVersion: 1;
  successorMode: 'local' | 'git-ref';
  successorEpoch: number;
  operationId: Ulid;
  tombstonedAt: string;
}

export interface GitRefAuthorityFreezeV1 {
  schemaVersion: 1;
  successorMode: 'local' | 'git-ref';
  successorEpoch: number;
  operationId: Ulid;
  frozenAt: string;
}

export interface GitRefTeamManifestV1 {
  schemaVersion: 1;
  workspaceId: Ulid;
  schemaEpoch: Ulid;
  minReaderVersion: string;
  minWriterVersion: string;
  transportEpoch: number;
  configRevision: number;
  configDigest: string;
  authorityState: 'active' | 'frozen' | 'tombstoned';
  authorityFreeze: GitRefAuthorityFreezeV1 | null;
  authorityTombstone: GitRefAuthorityTombstoneV1 | null;
  revision: number;
  lastOperationId: Ulid;
  actorProfiles: SharedActorProfileV1[];
  ownershipFences: GitRefOwnershipFenceV1[];
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  taskBundles: GitRefTaskBundleV1[];
  receipts: GitRefRemoteMutationReceiptV1[];
  lastMutation: GitRefRemoteMutationReceiptV1 | null;
  updatedAt: string;
}

export interface GitRefTeamManifestSnapshot {
  manifest: GitRefTeamManifestV1 | null;
  commit: string | null;
  receipt: string | null;
  fetchedAt: string;
}

export interface GitRefTeamManifestStoreOptions {
  projectRoot: string;
  remote: string;
  workspaceId: Ulid;
  schemaEpoch?: Ulid;
  minReaderVersion?: string;
  minWriterVersion?: string;
  transportEpoch?: number;
  configRevision?: number;
  configDigest?: string;
  now?: () => Date;
}

export interface PublishGitRefActorProfileInput {
  operationId: Ulid;
  expectedRemoteRevision: number;
  profile: SharedActorProfileV1;
}

export interface MutateGitRefCoordinationInput {
  operationId: Ulid;
  actorId: Ulid;
  taskRef: TaskRef;
  expectedRemoteRevision: number;
  expectedOwnershipEpoch: number;
  ownershipFence: GitRefOwnershipFenceV1;
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  taskBundle: GitRefTaskBundleV1 | null;
}

export interface EstablishGitRefCoordinationAuthorityInput {
  action: 'establish';
  operationId: Ulid;
  actorId: Ulid;
  expectedRemoteRevision: number;
  expectedRemoteTransportEpoch?: number | null;
  expectedPriorTransportEpoch: number | null;
  targetTransportEpoch: number;
  actorProfiles: SharedActorProfileV1[];
  ownershipFences: GitRefOwnershipFenceV1[];
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  taskBundles: GitRefTaskBundleV1[];
}

export interface TombstoneGitRefCoordinationAuthorityInput {
  action: 'tombstone';
  operationId: Ulid;
  actorId: Ulid;
  expectedRemoteRevision: number;
  expectedPriorTransportEpoch: number;
  successorMode: 'local' | 'git-ref';
  successorEpoch: number;
}

export interface FreezeGitRefCoordinationAuthorityInput {
  action: 'freeze';
  operationId: Ulid;
  actorId: Ulid;
  expectedRemoteRevision: number;
  expectedPriorTransportEpoch: number;
  successorMode: 'local' | 'git-ref';
  successorEpoch: number;
}

export interface UnfreezeGitRefCoordinationAuthorityInput {
  action: 'unfreeze';
  operationId: Ulid;
  actorId: Ulid;
  expectedRemoteRevision: number;
  expectedPriorTransportEpoch: number;
  freezeOperationId?: Ulid;
}

export type MutateGitRefCoordinationAuthorityInput =
  | EstablishGitRefCoordinationAuthorityInput
  | FreezeGitRefCoordinationAuthorityInput
  | UnfreezeGitRefCoordinationAuthorityInput
  | TombstoneGitRefCoordinationAuthorityInput;

interface ManifestHeader {
  workspaceId: Ulid;
  schemaEpoch: Ulid;
  minReaderVersion: string;
  minWriterVersion: string;
  transportEpoch: number;
  configRevision: number;
  configDigest: string;
}

/** Stable, credential-free identity for a configured remote, not its local alias. */
export async function resolveGitRefRemoteIdentityHash(
  projectRoot: string,
  remote: string,
): Promise<string> {
  if (!projectRoot.trim() || !remote.trim() || remote.includes('\0')) {
    throw new Error('MANCODE_TRANSPORT_REMOTE_INVALID');
  }
  let configured = remote;
  try {
    const output = await runGit(path.resolve(projectRoot), [
      'remote',
      'get-url',
      '--all',
      remote,
    ]);
    if (output.trim()) configured = output;
  } catch (error) {
    if (!isGitFailure(error)) throw error;
  }
  const identities = [
    ...new Set(
      configured
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => normalizeRemoteIdentity(projectRoot, value)),
    ),
  ].sort(compareUtf8);
  if (identities.length === 0) {
    throw new Error('MANCODE_TRANSPORT_REMOTE_INVALID');
  }
  return digestCanonicalJson({ remoteIdentities: identities });
}

/** Git plumbing and the single-ref CAS boundary for remote coordination. */
export class GitRefTeamManifestStore {
  private readonly projectRoot: string;
  private readonly remote: string;
  private readonly workspaceId: Ulid;
  private readonly expectedHeader: Partial<Omit<ManifestHeader, 'workspaceId'>>;
  private readonly initialHeader: ManifestHeader;
  private readonly now: () => Date;
  private remoteIdentityHashPromise: Promise<string> | null = null;

  constructor(options: GitRefTeamManifestStoreOptions) {
    if (!options.projectRoot.trim()) {
      throw new Error('MANCODE_TRANSPORT_PROJECT_ROOT_INVALID');
    }
    if (!options.remote.trim() || options.remote.includes('\0')) {
      throw new Error('MANCODE_TRANSPORT_REMOTE_INVALID');
    }
    assertUlid(options.workspaceId, 'git-ref workspaceId');
    if (options.schemaEpoch !== undefined) {
      assertUlid(options.schemaEpoch, 'git-ref schemaEpoch');
    }
    parseOptionalVersion(options.minReaderVersion, 'git-ref minReaderVersion');
    parseOptionalVersion(options.minWriterVersion, 'git-ref minWriterVersion');
    parseOptionalPositiveInteger(
      options.transportEpoch,
      'git-ref transportEpoch',
    );
    parseOptionalPositiveInteger(
      options.configRevision,
      'git-ref configRevision',
    );
    parseOptionalDigest(options.configDigest, 'git-ref configDigest');
    this.projectRoot = path.resolve(options.projectRoot);
    this.remote = options.remote;
    this.workspaceId = options.workspaceId;
    this.expectedHeader = {
      ...(options.schemaEpoch === undefined
        ? {}
        : { schemaEpoch: options.schemaEpoch }),
      ...(options.minReaderVersion === undefined
        ? {}
        : { minReaderVersion: options.minReaderVersion }),
      ...(options.minWriterVersion === undefined
        ? {}
        : { minWriterVersion: options.minWriterVersion }),
      ...(options.transportEpoch === undefined
        ? {}
        : { transportEpoch: options.transportEpoch }),
      ...(options.configRevision === undefined
        ? {}
        : { configRevision: options.configRevision }),
      ...(options.configDigest === undefined
        ? {}
        : { configDigest: options.configDigest }),
    };
    this.initialHeader = compatibilityHeader(options);
    this.now = options.now ?? (() => new Date());
  }

  async pull(): Promise<GitRefTeamManifestSnapshot> {
    return this.pullManifest(true);
  }

  private async pullManifest(
    validateExpectedHeader: boolean,
  ): Promise<GitRefTeamManifestSnapshot> {
    const remoteCommit = await readRemoteCommit(this.projectRoot, this.remote);
    const fetchedAt = this.now().toISOString();
    if (remoteCommit === null) {
      return { manifest: null, commit: null, receipt: null, fetchedAt };
    }
    await runGit(this.projectRoot, [
      'fetch',
      '--no-tags',
      this.remote,
      TEAM_REF,
    ]);
    const content = await gitShow(
      this.projectRoot,
      `${remoteCommit}:manifest.json`,
    );
    if (Buffer.byteLength(content, 'utf8') > MAX_MANIFEST_BYTES) {
      throw new Error('MANCODE_TRANSPORT_MANIFEST_TOO_LARGE');
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error('MANCODE_TRANSPORT_MANIFEST_INVALID');
    }
    const manifest = parseGitRefTeamManifest(value);
    if (manifest.workspaceId !== this.workspaceId) {
      throw new Error('MANCODE_TRANSPORT_WORKSPACE_MISMATCH');
    }
    if (validateExpectedHeader) {
      assertExpectedHeader(manifest, this.expectedHeader);
    }
    assertManifestCoordinationDomain(
      manifest,
      gitRefCoordinationDomainId(
        await this.remoteIdentityHash(),
        manifest.workspaceId,
        manifest.transportEpoch,
      ),
    );
    return {
      manifest,
      commit: remoteCommit,
      receipt: receiptFor(remoteCommit, manifest),
      fetchedAt,
    };
  }

  async capabilities(): Promise<CoordinationCapabilitiesV1> {
    const snapshot = await this.pull();
    return {
      claimAcquisition:
        snapshot.manifest?.authorityState === 'active'
          ? 'enforced'
          : 'unavailable',
      writeGuard: 'advisory',
      transport: 'git-ref',
      transportFreshness: 'fresh',
      lastSuccessfulSyncAt: snapshot.fetchedAt,
      remoteRevision: snapshot.manifest?.revision ?? 0,
    };
  }

  async publishActorProfile(
    input: PublishGitRefActorProfileInput,
  ): Promise<{ receipt: string; remoteRevision: number }> {
    assertUlid(input.operationId, 'git-ref operationId');
    const expectedRevision = parseExpectedRevision(
      input.expectedRemoteRevision,
    );
    const profile = parseSharedActorProfile(input.profile);
    const current = await this.pull();
    assertActiveAuthority(current.manifest);
    const currentRevision = current.manifest?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new Error('MANCODE_TRANSPORT_REVISION_CONFLICT');
    }
    const timestamp = this.now().toISOString();
    const actorProfiles = upsertActorProfile(
      current.manifest?.actorProfiles ?? [],
      profile,
    );
    const base = current.manifest ?? emptyManifest(this.initialHeader);
    const receipt = createMutationReceipt({
      kind: 'actor_profile',
      operationId: input.operationId,
      actorId: profile.actorId,
      taskRef: null,
      remoteRevision: currentRevision + 1,
      ownershipEpoch: null,
      actorProfiles,
      ownershipFence: null,
      claims: [],
      handoffs: [],
      taskBundle: null,
      committedAt: timestamp,
    });
    const receipts = appendReceipt(base.receipts, receipt);
    const next = parseGitRefTeamManifest({
      ...base,
      revision: currentRevision + 1,
      lastOperationId: input.operationId,
      actorProfiles,
      receipts,
      lastMutation: receipt,
      updatedAt: timestamp,
    });
    return this.commitMutation(current, next);
  }

  async mutateCoordination(input: MutateGitRefCoordinationInput): Promise<{
    receipt: string;
    remoteRevision: number;
    ownershipEpoch: number;
  }> {
    assertUlid(input.operationId, 'git-ref coordination operationId');
    assertUlid(input.actorId, 'git-ref coordination actorId');
    const taskRef = parseSharedTaskRef(
      input.taskRef,
      'git-ref coordination taskRef',
    );
    const expectedRevision = parseExpectedRevision(
      input.expectedRemoteRevision,
    );
    const expectedOwnershipEpoch = parseNonNegativeInteger(
      input.expectedOwnershipEpoch,
      'git-ref coordination expectedOwnershipEpoch',
    );
    const current = await this.pull();
    assertActiveAuthority(current.manifest);
    const currentRevision = current.manifest?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new Error('MANCODE_TRANSPORT_REVISION_CONFLICT');
    }
    const base = current.manifest ?? emptyManifest(this.initialHeader);
    const previousFence = base.ownershipFences.find((candidate) =>
      sameTaskRef(candidate.taskRef, taskRef),
    );
    if (
      !base.actorProfiles.some((profile) => profile.actorId === input.actorId)
    ) {
      throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_JOINED');
    }
    if ((previousFence?.ownershipEpoch ?? 0) !== expectedOwnershipEpoch) {
      throw new Error('MANCODE_TRANSPORT_OWNERSHIP_EPOCH_CONFLICT');
    }
    const nextRevision = currentRevision + 1;
    const fence = parseGitRefOwnershipFence(input.ownershipFence);
    const claims = parseReplacementClaims(
      input.claims,
      taskRef,
      base.workspaceId,
      gitRefCoordinationDomainId(
        await this.remoteIdentityHash(),
        base.workspaceId,
        base.transportEpoch,
      ),
    );
    const handoffs = parseReplacementHandoffs(input.handoffs, taskRef);
    const taskBundle =
      input.taskBundle === null
        ? null
        : parseGitRefTaskBundle(input.taskBundle);
    assertCoordinationMutation({
      operationId: input.operationId,
      actorId: input.actorId,
      taskRef,
      previousFence,
      previousClaims: base.claims.filter((claim) =>
        sameTaskRef(claim.taskRef, taskRef),
      ),
      previousHandoffs: base.handoffs.filter((handoff) =>
        sameTaskRef(handoff.taskRef, taskRef),
      ),
      previousTaskBundle: base.taskBundles.find((bundle) =>
        sameTaskRef(bundle.taskRef, taskRef),
      ),
      expectedOwnershipEpoch,
      nextRevision,
      fence,
      claims,
      handoffs,
      taskBundle,
    });
    const timestamp = this.now().toISOString();
    const ownershipFences = replaceTaskEntity(
      base.ownershipFences,
      taskRef,
      [fence],
      (value) => value.taskRef,
    ).sort(compareByTaskRef);
    const nextClaims = replaceTaskEntity(
      base.claims,
      taskRef,
      claims,
      (value) => value.taskRef,
    ).sort(compareClaims);
    const nextHandoffs = replaceTaskEntity(
      base.handoffs,
      taskRef,
      handoffs,
      (value) => value.taskRef,
    ).sort(compareHandoffs);
    const taskBundles = replaceTaskEntity(
      base.taskBundles,
      taskRef,
      taskBundle === null ? [] : [taskBundle],
      (value) => value.taskRef,
    ).sort(compareByTaskRef);
    const receipt = createMutationReceipt({
      kind: 'coordination',
      operationId: input.operationId,
      actorId: input.actorId,
      taskRef,
      remoteRevision: nextRevision,
      ownershipEpoch: fence.ownershipEpoch,
      actorProfiles: base.actorProfiles,
      ownershipFence: fence,
      claims,
      handoffs,
      taskBundle,
      committedAt: timestamp,
    });
    const next = parseGitRefTeamManifest({
      ...base,
      revision: nextRevision,
      lastOperationId: input.operationId,
      ownershipFences,
      claims: nextClaims,
      handoffs: nextHandoffs,
      taskBundles,
      receipts: appendReceipt(base.receipts, receipt),
      lastMutation: receipt,
      updatedAt: timestamp,
    });
    const result = await this.commitMutation(current, next);
    return { ...result, ownershipEpoch: fence.ownershipEpoch };
  }

  async mutateCoordinationAuthority(
    input: MutateGitRefCoordinationAuthorityInput,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    assertUlid(input.operationId, 'git-ref authority operationId');
    assertUlid(input.actorId, 'git-ref authority actorId');
    const expectedRevision = parseExpectedRevision(
      input.expectedRemoteRevision,
    );
    const current = await this.pullManifest(false);
    const currentRevision = current.manifest?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      const committed = committedAuthorityMutation(current, input);
      if (committed !== null) return committed;
      throw new Error('MANCODE_TRANSPORT_REVISION_CONFLICT');
    }
    switch (input.action) {
      case 'establish':
        return this.establishAuthority(current, input);
      case 'freeze':
        return this.freezeAuthority(current, input);
      case 'unfreeze':
        return this.unfreezeAuthority(current, input);
      case 'tombstone':
        return this.tombstoneAuthority(current, input);
    }
  }

  async establishCoordinationAuthority(
    input: Omit<EstablishGitRefCoordinationAuthorityInput, 'action'>,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    return this.mutateCoordinationAuthority({ ...input, action: 'establish' });
  }

  async tombstoneCoordinationAuthority(
    input: Omit<TombstoneGitRefCoordinationAuthorityInput, 'action'>,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    return this.mutateCoordinationAuthority({ ...input, action: 'tombstone' });
  }

  async freezeCoordinationAuthority(
    input: Omit<FreezeGitRefCoordinationAuthorityInput, 'action'>,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    return this.mutateCoordinationAuthority({ ...input, action: 'freeze' });
  }

  async unfreezeCoordinationAuthority(
    input: Omit<UnfreezeGitRefCoordinationAuthorityInput, 'action'>,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    return this.mutateCoordinationAuthority({ ...input, action: 'unfreeze' });
  }

  private async establishAuthority(
    current: GitRefTeamManifestSnapshot,
    input: EstablishGitRefCoordinationAuthorityInput,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    const expectedPriorEpoch = parsePositiveIntegerOrNull(
      input.expectedPriorTransportEpoch,
      'git-ref authority expectedPriorTransportEpoch',
    );
    const remoteEpoch = current.manifest?.transportEpoch ?? null;
    const expectedRemoteEpoch =
      input.expectedRemoteTransportEpoch === undefined
        ? expectedPriorEpoch
        : parsePositiveIntegerOrNull(
            input.expectedRemoteTransportEpoch,
            'git-ref authority expectedRemoteTransportEpoch',
          );
    if (remoteEpoch !== expectedRemoteEpoch) {
      throw new Error('MANCODE_TRANSPORT_EPOCH_CONFLICT');
    }
    const targetEpoch = parsePositiveInteger(
      input.targetTransportEpoch,
      'git-ref authority targetTransportEpoch',
    );
    if (expectedPriorEpoch !== null && targetEpoch <= expectedPriorEpoch) {
      throw new Error('MANCODE_TRANSPORT_EPOCH_CONFLICT');
    }
    if (this.initialHeader.transportEpoch !== targetEpoch) {
      throw new Error('MANCODE_TRANSPORT_TRANSPORT_EPOCH_MISMATCH');
    }
    if (
      current.manifest !== null &&
      (current.manifest.schemaEpoch !== this.initialHeader.schemaEpoch ||
        this.initialHeader.configRevision <= current.manifest.configRevision)
    ) {
      throw new Error('MANCODE_TRANSPORT_HEADER_TRANSITION_INVALID');
    }
    if (
      current.manifest !== null &&
      current.manifest.authorityState !== 'tombstoned'
    ) {
      throw new Error('MANCODE_TRANSPORT_AUTHORITY_NOT_TOMBSTONED');
    }
    if (current.manifest?.authorityState === 'tombstoned') {
      const predecessor = current.manifest.authorityTombstone;
      const directGitRefSuccessor =
        predecessor?.successorMode === 'git-ref' &&
        predecessor.successorEpoch === targetEpoch &&
        expectedPriorEpoch === remoteEpoch;
      const returnedFromLocalSuccessor =
        predecessor?.successorMode === 'local' &&
        predecessor.successorEpoch === expectedPriorEpoch &&
        expectedPriorEpoch !== null &&
        targetEpoch > expectedPriorEpoch;
      if (!directGitRefSuccessor && !returnedFromLocalSuccessor) {
        throw new Error('MANCODE_TRANSPORT_TOMBSTONE_SUCCESSOR_MISMATCH');
      }
    }
    const nextRevision =
      current.manifest === null ? 1 : current.manifest.revision + 1;
    const timestamp = this.now().toISOString();
    const actorProfiles = parseBoundedArray(
      input.actorProfiles,
      MAX_ACTOR_PROFILES,
      'git-ref authority actorProfiles',
      parseSharedActorProfile,
    ).sort(compareActorProfiles);
    assertUnique(
      actorProfiles,
      (profile) => profile.actorId,
      'git-ref authority actorProfiles',
    );
    if (!actorProfiles.some((profile) => profile.actorId === input.actorId)) {
      throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_JOINED');
    }
    const ownershipFences = parseBoundedArray(
      input.ownershipFences,
      MAX_OWNERSHIP_FENCES,
      'git-ref authority ownershipFences',
      parseGitRefOwnershipFence,
    ).sort(compareByTaskRef);
    const claims = parseBoundedArray(
      input.claims,
      MAX_CLAIMS,
      'git-ref authority claims',
      parseClaim,
    ).sort(compareClaims);
    const coordinationDomainId = gitRefCoordinationDomainId(
      await this.remoteIdentityHash(),
      this.workspaceId,
      targetEpoch,
    );
    const handoffs = parseBoundedArray(
      input.handoffs,
      MAX_HANDOFFS,
      'git-ref authority handoffs',
      parseHandoff,
    ).sort(compareHandoffs);
    const taskBundles = parseBoundedArray(
      input.taskBundles,
      MAX_TASK_BUNDLES,
      'git-ref authority taskBundles',
      parseGitRefTaskBundle,
    ).sort(compareByTaskRef);
    for (const fence of ownershipFences) {
      if (
        fence.remoteRevision !== nextRevision ||
        fence.lastOperationId !== input.operationId
      ) {
        throw new Error('MANCODE_TRANSPORT_FENCE_REVISION_INVALID');
      }
    }
    for (const claim of claims) {
      if (
        claim.workspaceId !== this.workspaceId ||
        claim.authority.mode !== 'git-ref' ||
        claim.coordinationDomainId !== coordinationDomainId ||
        claim.state !== 'active' ||
        claim.lastOperationId !== input.operationId ||
        claim.authority.remoteRevision !== String(nextRevision)
      ) {
        throw new Error('MANCODE_TRANSPORT_CLAIM_AUTHORITY_MISMATCH');
      }
    }
    for (const handoff of handoffs) {
      if (handoff.transport.mode !== 'git-ref') {
        throw new Error('MANCODE_TRANSPORT_HANDOFF_AUTHORITY_MISMATCH');
      }
    }
    const receipt = createMutationReceipt({
      kind: 'authority_establish',
      operationId: input.operationId,
      actorId: input.actorId,
      taskRef: null,
      remoteRevision: nextRevision,
      ownershipEpoch: null,
      actorProfiles,
      ownershipFence: ownershipFences,
      claims,
      handoffs,
      taskBundle: taskBundles,
      committedAt: timestamp,
    });
    const next = parseGitRefTeamManifest({
      schemaVersion: 1,
      ...this.initialHeader,
      transportEpoch: targetEpoch,
      authorityState: 'active',
      authorityFreeze: null,
      authorityTombstone: null,
      revision: nextRevision,
      lastOperationId: input.operationId,
      actorProfiles,
      ownershipFences,
      claims,
      handoffs,
      taskBundles,
      receipts: appendReceipt(current.manifest?.receipts ?? [], receipt),
      lastMutation: receipt,
      updatedAt: timestamp,
    });
    assertExpectedHeader(next, {
      ...this.expectedHeader,
      transportEpoch: targetEpoch,
    });
    const result = await this.commitMutation(current, next);
    return { ...result, transportEpoch: targetEpoch };
  }

  private async freezeAuthority(
    current: GitRefTeamManifestSnapshot,
    input: FreezeGitRefCoordinationAuthorityInput,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    const manifest = requireAuthorityState(
      current,
      'active',
      input.expectedPriorTransportEpoch,
    );
    assertExpectedHeader(manifest, this.expectedHeader);
    assertAuthorityActorJoined(manifest, input.actorId);
    const successorEpoch = parsePositiveInteger(
      input.successorEpoch,
      'git-ref authority successorEpoch',
    );
    if (successorEpoch <= manifest.transportEpoch) {
      throw new Error('MANCODE_TRANSPORT_EPOCH_CONFLICT');
    }
    const nextRevision = manifest.revision + 1;
    const timestamp = this.now().toISOString();
    const receipt = authoritySnapshotReceipt(
      manifest,
      'authority_freeze',
      input.operationId,
      input.actorId,
      nextRevision,
      timestamp,
    );
    const next = parseGitRefTeamManifest({
      ...manifest,
      authorityState: 'frozen',
      authorityFreeze: {
        schemaVersion: 1,
        successorMode: input.successorMode,
        successorEpoch,
        operationId: input.operationId,
        frozenAt: timestamp,
      },
      authorityTombstone: null,
      revision: nextRevision,
      lastOperationId: input.operationId,
      receipts: appendReceipt(manifest.receipts, receipt),
      lastMutation: receipt,
      updatedAt: timestamp,
    });
    const result = await this.commitMutation(current, next);
    return { ...result, transportEpoch: next.transportEpoch };
  }

  private async unfreezeAuthority(
    current: GitRefTeamManifestSnapshot,
    input: UnfreezeGitRefCoordinationAuthorityInput,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    const freezeOperationId = input.freezeOperationId ?? input.operationId;
    assertUlid(freezeOperationId, 'git-ref authority freezeOperationId');
    const manifest = requireAuthorityState(
      current,
      'frozen',
      input.expectedPriorTransportEpoch,
    );
    assertExpectedHeader(manifest, this.expectedHeader);
    assertAuthorityActorJoined(manifest, input.actorId);
    if (manifest.authorityFreeze?.operationId !== freezeOperationId) {
      throw new Error('MANCODE_TRANSPORT_FREEZE_OPERATION_MISMATCH');
    }
    const nextRevision = manifest.revision + 1;
    const timestamp = this.now().toISOString();
    const receipt = authoritySnapshotReceipt(
      manifest,
      'authority_unfreeze',
      input.operationId,
      input.actorId,
      nextRevision,
      timestamp,
    );
    const next = parseGitRefTeamManifest({
      ...manifest,
      authorityState: 'active',
      authorityFreeze: null,
      authorityTombstone: null,
      revision: nextRevision,
      lastOperationId: input.operationId,
      receipts: appendReceipt(manifest.receipts, receipt),
      lastMutation: receipt,
      updatedAt: timestamp,
    });
    const result = await this.commitMutation(current, next);
    return { ...result, transportEpoch: next.transportEpoch };
  }

  private async tombstoneAuthority(
    current: GitRefTeamManifestSnapshot,
    input: TombstoneGitRefCoordinationAuthorityInput,
  ): Promise<{
    receipt: string;
    remoteRevision: number;
    transportEpoch: number;
  }> {
    const manifest = requireAuthorityState(
      current,
      'frozen',
      input.expectedPriorTransportEpoch,
    );
    assertExpectedHeader(manifest, this.expectedHeader);
    assertAuthorityActorJoined(manifest, input.actorId);
    const successorEpoch = parsePositiveInteger(
      input.successorEpoch,
      'git-ref authority successorEpoch',
    );
    if (
      successorEpoch <= manifest.transportEpoch ||
      manifest.authorityFreeze?.operationId !== input.operationId ||
      manifest.authorityFreeze.successorMode !== input.successorMode ||
      manifest.authorityFreeze.successorEpoch !== successorEpoch
    ) {
      throw new Error('MANCODE_TRANSPORT_EPOCH_CONFLICT');
    }
    const nextRevision = manifest.revision + 1;
    const timestamp = this.now().toISOString();
    const receipt = authoritySnapshotReceipt(
      manifest,
      'authority_tombstone',
      input.operationId,
      input.actorId,
      nextRevision,
      timestamp,
    );
    const next = parseGitRefTeamManifest({
      ...manifest,
      authorityState: 'tombstoned',
      authorityTombstone: {
        schemaVersion: 1,
        successorMode: input.successorMode,
        successorEpoch,
        operationId: input.operationId,
        tombstonedAt: timestamp,
      },
      revision: nextRevision,
      lastOperationId: input.operationId,
      receipts: appendReceipt(manifest.receipts, receipt),
      lastMutation: receipt,
      updatedAt: timestamp,
    });
    const result = await this.commitMutation(current, next);
    return { ...result, transportEpoch: next.transportEpoch };
  }

  private remoteIdentityHash(): Promise<string> {
    this.remoteIdentityHashPromise ??= resolveGitRefRemoteIdentityHash(
      this.projectRoot,
      this.remote,
    );
    return this.remoteIdentityHashPromise;
  }

  private async commitMutation(
    current: GitRefTeamManifestSnapshot,
    next: GitRefTeamManifestV1,
  ): Promise<{ receipt: string; remoteRevision: number }> {
    const commit = await writeManifestCommit(
      this.projectRoot,
      current.commit,
      next,
      this.now(),
    );
    await pushWithLease(this.projectRoot, this.remote, current.commit, commit);
    return { receipt: receiptFor(commit, next), remoteRevision: next.revision };
  }
}

function committedAuthorityMutation(
  snapshot: GitRefTeamManifestSnapshot,
  input: MutateGitRefCoordinationAuthorityInput,
): { receipt: string; remoteRevision: number; transportEpoch: number } | null {
  const manifest = snapshot.manifest;
  if (manifest === null) return null;
  const lastMutation = manifest.lastMutation;
  if (
    lastMutation === null ||
    snapshot.receipt === null ||
    lastMutation.operationId !== input.operationId ||
    lastMutation.actorId !== input.actorId
  ) {
    return null;
  }
  const committed = (() => {
    switch (input.action) {
      case 'establish':
        return (
          manifest.authorityState === 'active' &&
          manifest.transportEpoch === input.targetTransportEpoch &&
          lastMutation.kind === 'authority_establish'
        );
      case 'freeze':
        return (
          manifest.authorityState === 'frozen' &&
          lastMutation.kind === 'authority_freeze' &&
          manifest.authorityFreeze?.successorMode === input.successorMode &&
          manifest.authorityFreeze.successorEpoch === input.successorEpoch
        );
      case 'unfreeze':
        return (
          manifest.authorityState === 'active' &&
          manifest.transportEpoch === input.expectedPriorTransportEpoch &&
          lastMutation.kind === 'authority_unfreeze'
        );
      case 'tombstone':
        return (
          manifest.authorityState === 'tombstoned' &&
          lastMutation.kind === 'authority_tombstone' &&
          manifest.authorityTombstone?.successorMode === input.successorMode &&
          manifest.authorityTombstone.successorEpoch === input.successorEpoch
        );
    }
  })();
  return committed
    ? {
        receipt: snapshot.receipt,
        remoteRevision: manifest.revision,
        transportEpoch: manifest.transportEpoch,
      }
    : null;
}

function requireAuthorityState(
  current: GitRefTeamManifestSnapshot,
  state: GitRefTeamManifestV1['authorityState'],
  expectedTransportEpoch: number,
): GitRefTeamManifestV1 {
  const manifest = current.manifest;
  if (
    manifest === null ||
    manifest.authorityState !== state ||
    manifest.transportEpoch !== expectedTransportEpoch
  ) {
    throw new Error('MANCODE_TRANSPORT_AUTHORITY_STATE_CONFLICT');
  }
  return manifest;
}

function assertAuthorityActorJoined(
  manifest: GitRefTeamManifestV1,
  actorId: Ulid,
): void {
  if (!manifest.actorProfiles.some((profile) => profile.actorId === actorId)) {
    throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_JOINED');
  }
}

function authoritySnapshotReceipt(
  manifest: GitRefTeamManifestV1,
  kind: Extract<
    GitRefRemoteMutationReceiptV1['kind'],
    'authority_freeze' | 'authority_unfreeze' | 'authority_tombstone'
  >,
  operationId: Ulid,
  actorId: Ulid,
  remoteRevision: number,
  committedAt: string,
): GitRefRemoteMutationReceiptV1 {
  return createMutationReceipt({
    kind,
    operationId,
    actorId,
    taskRef: null,
    remoteRevision,
    ownershipEpoch: null,
    actorProfiles: manifest.actorProfiles,
    ownershipFence: manifest.ownershipFences,
    claims: manifest.claims,
    handoffs: manifest.handoffs,
    taskBundle: manifest.taskBundles,
    committedAt,
  });
}

export function parseGitRefTeamManifest(value: unknown): GitRefTeamManifestV1 {
  assertManifestSize(value);
  assertRecord(value, 'git-ref team manifest');
  const legacyProfileManifest = isLegacyProfileManifest(value);
  const normalized = legacyProfileManifest
    ? normalizeLegacyProfileManifest(value)
    : value;
  assertKnownKeys(
    normalized,
    [
      'schemaVersion',
      'workspaceId',
      'schemaEpoch',
      'minReaderVersion',
      'minWriterVersion',
      'transportEpoch',
      'configRevision',
      'configDigest',
      'authorityState',
      'authorityFreeze',
      'authorityTombstone',
      'revision',
      'lastOperationId',
      'actorProfiles',
      'ownershipFences',
      'claims',
      'handoffs',
      'taskBundles',
      'receipts',
      'lastMutation',
      'updatedAt',
    ],
    'git-ref team manifest',
  );
  if (normalized.schemaVersion !== 1) {
    throw new Error('git-ref team manifest schemaVersion is invalid');
  }
  assertUlid(normalized.workspaceId, 'git-ref team manifest workspaceId');
  assertUlid(normalized.schemaEpoch, 'git-ref team manifest schemaEpoch');
  assertUlid(
    normalized.lastOperationId,
    'git-ref team manifest lastOperationId',
  );
  const revision = parsePositiveInteger(
    normalized.revision,
    'git-ref team manifest revision',
  );
  const manifest: GitRefTeamManifestV1 = {
    schemaVersion: 1,
    workspaceId: normalized.workspaceId,
    schemaEpoch: normalized.schemaEpoch,
    minReaderVersion: parseVersion(
      normalized.minReaderVersion,
      'git-ref team manifest minReaderVersion',
    ),
    minWriterVersion: parseVersion(
      normalized.minWriterVersion,
      'git-ref team manifest minWriterVersion',
    ),
    transportEpoch: parsePositiveInteger(
      normalized.transportEpoch,
      'git-ref team manifest transportEpoch',
    ),
    configRevision: parsePositiveInteger(
      normalized.configRevision,
      'git-ref team manifest configRevision',
    ),
    configDigest: parseDigest(
      normalized.configDigest,
      'git-ref team manifest configDigest',
    ),
    authorityState: parseAuthorityState(normalized.authorityState),
    authorityFreeze:
      normalized.authorityFreeze === null
        ? null
        : parseGitRefAuthorityFreeze(normalized.authorityFreeze),
    authorityTombstone:
      normalized.authorityTombstone === null
        ? null
        : parseGitRefAuthorityTombstone(normalized.authorityTombstone),
    revision,
    lastOperationId: normalized.lastOperationId,
    actorProfiles: parseBoundedArray(
      normalized.actorProfiles,
      MAX_ACTOR_PROFILES,
      'git-ref team manifest actorProfiles',
      parseSharedActorProfile,
    ).sort(compareActorProfiles),
    ownershipFences: parseBoundedArray(
      normalized.ownershipFences,
      MAX_OWNERSHIP_FENCES,
      'git-ref team manifest ownershipFences',
      parseGitRefOwnershipFence,
    ).sort(compareByTaskRef),
    claims: parseBoundedArray(
      normalized.claims,
      MAX_CLAIMS,
      'git-ref team manifest claims',
      parseClaim,
    ).sort(compareClaims),
    handoffs: parseBoundedArray(
      normalized.handoffs,
      MAX_HANDOFFS,
      'git-ref team manifest handoffs',
      parseHandoff,
    ).sort(compareHandoffs),
    taskBundles: parseBoundedArray(
      normalized.taskBundles,
      MAX_TASK_BUNDLES,
      'git-ref team manifest taskBundles',
      parseGitRefTaskBundle,
    ).sort(compareByTaskRef),
    receipts: parseBoundedArray(
      normalized.receipts,
      MAX_RECEIPTS,
      'git-ref team manifest receipts',
      parseGitRefRemoteMutationReceipt,
    ).sort(compareReceipts),
    lastMutation:
      normalized.lastMutation === null
        ? null
        : parseGitRefRemoteMutationReceipt(normalized.lastMutation),
    updatedAt: parseTimestamp(
      normalized.updatedAt,
      'git-ref team manifest updatedAt',
    ),
  };
  assertManifestUniqueness(manifest);
  assertManifestCrossEntityConsistency(manifest, legacyProfileManifest);
  return manifest;
}

export function parseGitRefOwnershipFence(
  value: unknown,
): GitRefOwnershipFenceV1 {
  assertRecord(value, 'git-ref ownership fence');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'taskRef',
      'ownerActorId',
      'ownershipEpoch',
      'taskRevision',
      'aggregateDigest',
      'remoteRevision',
      'lastOperationId',
      'updatedAt',
    ],
    'git-ref ownership fence',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('git-ref ownership fence schemaVersion must be 1');
  }
  assertUlid(value.ownerActorId, 'git-ref ownership fence ownerActorId');
  assertUlid(value.lastOperationId, 'git-ref ownership fence lastOperationId');
  return {
    schemaVersion: 1,
    taskRef: parseSharedTaskRef(
      value.taskRef,
      'git-ref ownership fence taskRef',
    ),
    ownerActorId: value.ownerActorId,
    ownershipEpoch: parseNonNegativeInteger(
      value.ownershipEpoch,
      'git-ref ownership fence ownershipEpoch',
    ),
    taskRevision: parsePositiveInteger(
      value.taskRevision,
      'git-ref ownership fence taskRevision',
    ),
    aggregateDigest: parseDigest(
      value.aggregateDigest,
      'git-ref ownership fence aggregateDigest',
    ),
    remoteRevision: parsePositiveInteger(
      value.remoteRevision,
      'git-ref ownership fence remoteRevision',
    ),
    lastOperationId: value.lastOperationId,
    updatedAt: parseTimestamp(
      value.updatedAt,
      'git-ref ownership fence updatedAt',
    ),
  };
}

export function gitRefTaskBundleDigest(
  bundle: Omit<GitRefTaskBundleV1, 'bundleDigest'>,
): string {
  return digestCanonicalJson(bundle);
}

export function parseGitRefTaskBundle(value: unknown): GitRefTaskBundleV1 {
  assertRecord(value, 'git-ref task bundle');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'taskRef',
      'taskRevision',
      'ownershipEpoch',
      'aggregate',
      'aggregateDigest',
      'codeRef',
      'artifacts',
      'bundleDigest',
      'createdAt',
    ],
    'git-ref task bundle',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('git-ref task bundle schemaVersion must be 1');
  }
  const taskRef = parseSharedTaskRef(
    value.taskRef,
    'git-ref task bundle taskRef',
  );
  const aggregate = parseTaskAggregateManifest(value.aggregate);
  const artifacts = parseBoundedArray(
    value.artifacts,
    MAX_BUNDLE_ARTIFACTS,
    'git-ref task bundle artifacts',
    parseGitRefTaskBundleArtifact,
  );
  const bundle: GitRefTaskBundleV1 = {
    schemaVersion: 1,
    taskRef,
    taskRevision: parsePositiveInteger(
      value.taskRevision,
      'git-ref task bundle taskRevision',
    ),
    ownershipEpoch: parseNonNegativeInteger(
      value.ownershipEpoch,
      'git-ref task bundle ownershipEpoch',
    ),
    aggregate,
    aggregateDigest: parseDigest(
      value.aggregateDigest,
      'git-ref task bundle aggregateDigest',
    ),
    codeRef: parseBundleCodeRef(value.codeRef),
    artifacts: artifacts.sort(compareBundleArtifacts),
    bundleDigest: parseDigest(
      value.bundleDigest,
      'git-ref task bundle bundleDigest',
    ),
    createdAt: parseTimestamp(value.createdAt, 'git-ref task bundle createdAt'),
  };
  assertTaskBundleConsistency(bundle);
  const { bundleDigest: _digest, ...body } = bundle;
  if (bundle.bundleDigest !== gitRefTaskBundleDigest(body)) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_DIGEST_MISMATCH');
  }
  return bundle;
}

export function parseGitRefRemoteMutationReceipt(
  value: unknown,
): GitRefRemoteMutationReceiptV1 {
  assertRecord(value, 'git-ref mutation receipt');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'operationId',
      'actorId',
      'taskRef',
      'remoteRevision',
      'ownershipEpoch',
      'entityDigests',
      'committedAt',
    ],
    'git-ref mutation receipt',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('git-ref mutation receipt schemaVersion must be 1');
  }
  if (
    value.kind !== 'actor_profile' &&
    value.kind !== 'coordination' &&
    value.kind !== 'authority_establish' &&
    value.kind !== 'authority_freeze' &&
    value.kind !== 'authority_unfreeze' &&
    value.kind !== 'authority_tombstone'
  ) {
    throw new Error('git-ref mutation receipt kind is invalid');
  }
  assertUlid(value.operationId, 'git-ref mutation receipt operationId');
  assertUlid(value.actorId, 'git-ref mutation receipt actorId');
  const taskRef =
    value.taskRef === null
      ? null
      : parseSharedTaskRef(value.taskRef, 'git-ref mutation receipt taskRef');
  const ownershipEpoch =
    value.ownershipEpoch === null
      ? null
      : parseNonNegativeInteger(
          value.ownershipEpoch,
          'git-ref mutation receipt ownershipEpoch',
        );
  if (
    (value.kind !== 'coordination' &&
      (taskRef !== null || ownershipEpoch !== null)) ||
    (value.kind === 'coordination' &&
      (taskRef === null || ownershipEpoch === null))
  ) {
    throw new Error(
      'git-ref mutation receipt kind does not match task fencing',
    );
  }
  return {
    schemaVersion: 1,
    kind: value.kind,
    operationId: value.operationId,
    actorId: value.actorId,
    taskRef,
    remoteRevision: parsePositiveInteger(
      value.remoteRevision,
      'git-ref mutation receipt remoteRevision',
    ),
    ownershipEpoch,
    entityDigests: parseReceiptEntityDigests(value.entityDigests),
    committedAt: parseTimestamp(
      value.committedAt,
      'git-ref mutation receipt committedAt',
    ),
  };
}

export function parseGitRefAuthorityTombstone(
  value: unknown,
): GitRefAuthorityTombstoneV1 {
  assertRecord(value, 'git-ref authority tombstone');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'successorMode',
      'successorEpoch',
      'operationId',
      'tombstonedAt',
    ],
    'git-ref authority tombstone',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('git-ref authority tombstone schemaVersion must be 1');
  }
  if (value.successorMode !== 'local' && value.successorMode !== 'git-ref') {
    throw new Error('git-ref authority tombstone successorMode is invalid');
  }
  assertUlid(value.operationId, 'git-ref authority tombstone operationId');
  return {
    schemaVersion: 1,
    successorMode: value.successorMode,
    successorEpoch: parsePositiveInteger(
      value.successorEpoch,
      'git-ref authority tombstone successorEpoch',
    ),
    operationId: value.operationId,
    tombstonedAt: parseTimestamp(
      value.tombstonedAt,
      'git-ref authority tombstone tombstonedAt',
    ),
  };
}

export function parseGitRefAuthorityFreeze(
  value: unknown,
): GitRefAuthorityFreezeV1 {
  assertRecord(value, 'git-ref authority freeze');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'successorMode',
      'successorEpoch',
      'operationId',
      'frozenAt',
    ],
    'git-ref authority freeze',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('git-ref authority freeze schemaVersion must be 1');
  }
  if (value.successorMode !== 'local' && value.successorMode !== 'git-ref') {
    throw new Error('git-ref authority freeze successorMode is invalid');
  }
  assertUlid(value.operationId, 'git-ref authority freeze operationId');
  return {
    schemaVersion: 1,
    successorMode: value.successorMode,
    successorEpoch: parsePositiveInteger(
      value.successorEpoch,
      'git-ref authority freeze successorEpoch',
    ),
    operationId: value.operationId,
    frozenAt: parseTimestamp(
      value.frozenAt,
      'git-ref authority freeze frozenAt',
    ),
  };
}

function assertCoordinationMutation(input: {
  operationId: Ulid;
  actorId: Ulid;
  taskRef: TaskRef;
  previousFence: GitRefOwnershipFenceV1 | undefined;
  previousClaims: ClaimV1[];
  previousHandoffs: HandoffV1[];
  previousTaskBundle: GitRefTaskBundleV1 | undefined;
  expectedOwnershipEpoch: number;
  nextRevision: number;
  fence: GitRefOwnershipFenceV1;
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  taskBundle: GitRefTaskBundleV1 | null;
}): void {
  const {
    operationId,
    actorId,
    taskRef,
    previousFence,
    previousClaims,
    previousHandoffs,
    previousTaskBundle,
    expectedOwnershipEpoch,
    nextRevision,
    fence,
    claims,
    handoffs,
    taskBundle,
  } = input;
  if (!sameTaskRef(fence.taskRef, taskRef)) {
    throw new Error('MANCODE_TRANSPORT_TASK_MISMATCH');
  }
  if (
    fence.remoteRevision !== nextRevision ||
    fence.lastOperationId !== operationId
  ) {
    throw new Error('MANCODE_TRANSPORT_FENCE_REVISION_INVALID');
  }
  const changes = assertEntityReplacementTransitions({
    operationId,
    actorId,
    nextRevision,
    previousClaims,
    claims,
    previousHandoffs,
    handoffs,
  });
  if (previousTaskBundle !== undefined && taskBundle === null) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_REMOVAL_FORBIDDEN');
  }
  const metadata =
    taskBundle === null ? null : metadataFromTaskBundle(taskBundle);
  if (
    metadata !== null &&
    (metadata.ownerActorId !== fence.ownerActorId ||
      metadata.ownershipEpoch !== fence.ownershipEpoch)
  ) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_FENCE_MISMATCH');
  }
  if (previousFence === undefined) {
    if (
      expectedOwnershipEpoch !== 0 ||
      fence.ownershipEpoch !== 0 ||
      fence.ownerActorId !== actorId
    ) {
      throw new Error('MANCODE_TRANSPORT_OWNERSHIP_FENCE_BOOTSTRAP_INVALID');
    }
  } else {
    if (fence.taskRevision < previousFence.taskRevision) {
      throw new Error('MANCODE_TRANSPORT_TASK_REVISION_REGRESSION');
    }
    if (fence.ownerActorId === previousFence.ownerActorId) {
      if (fence.ownershipEpoch !== previousFence.ownershipEpoch) {
        throw new Error('MANCODE_TRANSPORT_OWNER_MISMATCH');
      }
      assertSameOwnerMutationAuthorized({
        actorId,
        taskOwnerActorId: previousFence.ownerActorId,
        previousFence,
        fence,
        previousTaskBundle,
        taskBundle,
        metadata,
        changes,
        previousClaims,
        claims,
      });
    } else {
      const acceptedHandoff = handoffs.find(
        (handoff) =>
          handoff.state === 'accepted' &&
          handoff.fromActorId === previousFence.ownerActorId &&
          handoff.toActorId === fence.ownerActorId &&
          handoff.ownershipEpochAtOffer === previousFence.ownershipEpoch &&
          handoff.lastOperationId === operationId &&
          handoff.resolution?.actorId === actorId,
      );
      if (
        actorId !== fence.ownerActorId ||
        fence.ownershipEpoch !== previousFence.ownershipEpoch + 1 ||
        acceptedHandoff === undefined
      ) {
        throw new Error('MANCODE_TRANSPORT_OWNERSHIP_TRANSFER_INVALID');
      }
      assertOwnershipTransferEntities({
        actorId,
        acceptedHandoff,
        changes,
        previousClaims,
        claims,
        previousHandoffs,
      });
    }
  }
  for (const claim of claims) {
    if (
      claim.lastOperationId === operationId &&
      (claim.authority.mode !== 'git-ref' ||
        claim.authority.remoteRevision !== String(nextRevision))
    ) {
      throw new Error('MANCODE_TRANSPORT_CLAIM_REVISION_INVALID');
    }
  }
  for (const handoff of handoffs) {
    if (
      handoff.lastOperationId === operationId &&
      (handoff.transport.mode !== 'git-ref' ||
        handoff.transport.state !== 'published' ||
        handoff.transport.transportRevision !== nextRevision ||
        handoff.transport.receipt !==
          `git-ref-revision:${nextRevision}:${operationId}`)
    ) {
      throw new Error('MANCODE_TRANSPORT_HANDOFF_REVISION_INVALID');
    }
  }
  if (taskBundle !== null) {
    if (
      !sameTaskRef(taskBundle.taskRef, taskRef) ||
      taskBundle.taskRevision !== fence.taskRevision ||
      taskBundle.ownershipEpoch !== fence.ownershipEpoch ||
      taskBundle.aggregateDigest !== fence.aggregateDigest
    ) {
      throw new Error('MANCODE_TRANSPORT_BUNDLE_FENCE_MISMATCH');
    }
  }
  const offered = handoffs.find((handoff) => handoff.state === 'offered');
  if (
    offered !== undefined &&
    (taskBundle === null ||
      offered.transport.taskBundleDigest !== taskBundle.bundleDigest)
  ) {
    throw new Error('MANCODE_TRANSPORT_HANDOFF_BUNDLE_MISMATCH');
  }
}

interface MutationEntityChanges {
  claims: Array<{ previous: ClaimV1 | null; next: ClaimV1 }>;
  handoffs: Array<{ previous: HandoffV1 | null; next: HandoffV1 }>;
}

function assertEntityReplacementTransitions(input: {
  operationId: Ulid;
  actorId: Ulid;
  nextRevision: number;
  previousClaims: ClaimV1[];
  claims: ClaimV1[];
  previousHandoffs: HandoffV1[];
  handoffs: HandoffV1[];
}): MutationEntityChanges {
  const previousClaims = new Map(
    input.previousClaims.map((claim) => [claim.claimId, claim]),
  );
  const claims = new Map(input.claims.map((claim) => [claim.claimId, claim]));
  const previousHandoffs = new Map(
    input.previousHandoffs.map((handoff) => [handoff.handoffId, handoff]),
  );
  const handoffs = new Map(
    input.handoffs.map((handoff) => [handoff.handoffId, handoff]),
  );
  for (const claimId of previousClaims.keys()) {
    if (!claims.has(claimId)) {
      throw new Error('MANCODE_TRANSPORT_CLAIM_REMOVAL_FORBIDDEN');
    }
  }
  for (const handoffId of previousHandoffs.keys()) {
    if (!handoffs.has(handoffId)) {
      throw new Error('MANCODE_TRANSPORT_HANDOFF_REMOVAL_FORBIDDEN');
    }
  }
  const claimChanges: MutationEntityChanges['claims'] = [];
  for (const claim of input.claims) {
    const previous = previousClaims.get(claim.claimId) ?? null;
    if (
      previous !== null &&
      digestCanonicalJson(previous) === digestCanonicalJson(claim)
    ) {
      continue;
    }
    if (
      claim.lastOperationId !== input.operationId ||
      claim.authority.mode !== 'git-ref' ||
      claim.authority.remoteRevision !== String(input.nextRevision)
    ) {
      throw new Error('MANCODE_TRANSPORT_CLAIM_REVISION_INVALID');
    }
    if (previous === null) {
      if (claim.revision !== 1) {
        throw new Error('MANCODE_TRANSPORT_CLAIM_TRANSITION_INVALID');
      }
    } else {
      assertClaimTransition(previous, claim);
    }
    claimChanges.push({ previous, next: claim });
  }
  const handoffChanges: MutationEntityChanges['handoffs'] = [];
  for (const handoff of input.handoffs) {
    const previous = previousHandoffs.get(handoff.handoffId) ?? null;
    if (
      previous !== null &&
      digestCanonicalJson(previous) === digestCanonicalJson(handoff)
    ) {
      continue;
    }
    if (
      handoff.lastOperationId !== input.operationId ||
      handoff.transport.mode !== 'git-ref' ||
      handoff.transport.state !== 'published' ||
      handoff.transport.transportRevision !== input.nextRevision ||
      handoff.transport.receipt !==
        `git-ref-revision:${input.nextRevision}:${input.operationId}`
    ) {
      throw new Error('MANCODE_TRANSPORT_HANDOFF_REVISION_INVALID');
    }
    if (previous === null) {
      if (handoff.revision !== 1) {
        throw new Error('MANCODE_TRANSPORT_HANDOFF_TRANSITION_INVALID');
      }
    } else {
      assertHandoffTransition(previous, handoff, input.actorId);
    }
    handoffChanges.push({ previous, next: handoff });
  }
  return { claims: claimChanges, handoffs: handoffChanges };
}

function assertSameOwnerMutationAuthorized(input: {
  actorId: Ulid;
  taskOwnerActorId: Ulid;
  previousFence: GitRefOwnershipFenceV1;
  fence: GitRefOwnershipFenceV1;
  previousTaskBundle: GitRefTaskBundleV1 | undefined;
  taskBundle: GitRefTaskBundleV1 | null;
  metadata: WorkflowMetadataV3 | null;
  changes: MutationEntityChanges;
  previousClaims: ClaimV1[];
  claims: ClaimV1[];
}): void {
  if (input.actorId === input.taskOwnerActorId) return;
  if (
    input.metadata === null ||
    input.previousTaskBundle === undefined ||
    input.taskBundle === null ||
    input.previousTaskBundle.bundleDigest !== input.taskBundle.bundleDigest ||
    input.previousFence.taskRevision !== input.fence.taskRevision ||
    input.previousFence.aggregateDigest !== input.fence.aggregateDigest ||
    !input.metadata.participants.includes(input.actorId) ||
    (input.changes.claims.length === 0 && input.changes.handoffs.length === 0)
  ) {
    throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_AUTHORIZED');
  }
  const previousClaims = new Map(
    input.previousClaims.map((claim) => [claim.claimId, claim]),
  );
  const claims = new Map(input.claims.map((claim) => [claim.claimId, claim]));
  for (const change of input.changes.claims) {
    if (change.previous !== null) {
      if (change.previous.ownerActorId !== input.actorId) {
        throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_AUTHORIZED');
      }
      continue;
    }
    if (change.next.ownerActorId === input.actorId) continue;
    const predecessorId = change.next.predecessorClaimId;
    const previous =
      predecessorId === null ? undefined : previousClaims.get(predecessorId);
    const transferred =
      predecessorId === null ? undefined : claims.get(predecessorId);
    if (
      previous === undefined ||
      previous.ownerActorId !== input.actorId ||
      transferred?.state !== 'transferred' ||
      transferred.successorClaimId !== change.next.claimId ||
      !input.metadata.participants.includes(change.next.ownerActorId)
    ) {
      throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_AUTHORIZED');
    }
  }
  for (const change of input.changes.handoffs) {
    if (
      change.previous === null ||
      change.previous.toActorId !== input.actorId ||
      change.next.state !== 'rejected'
    ) {
      throw new Error('MANCODE_TRANSPORT_ACTOR_NOT_AUTHORIZED');
    }
  }
}

function assertOwnershipTransferEntities(input: {
  actorId: Ulid;
  acceptedHandoff: HandoffV1;
  changes: MutationEntityChanges;
  previousClaims: ClaimV1[];
  claims: ClaimV1[];
  previousHandoffs: HandoffV1[];
}): void {
  if (
    input.changes.handoffs.length !== 1 ||
    input.changes.handoffs[0]?.previous?.handoffId !==
      input.acceptedHandoff.handoffId ||
    input.changes.handoffs[0]?.next.state !== 'accepted'
  ) {
    throw new Error('MANCODE_TRANSPORT_OWNERSHIP_TRANSFER_INVALID');
  }
  const acceptedClaimIds = new Set(input.acceptedHandoff.claimIds);
  const nextClaims = new Map(
    input.claims.map((claim) => [claim.claimId, claim]),
  );
  for (const change of input.changes.claims) {
    if (change.previous !== null) {
      if (
        !acceptedClaimIds.has(change.previous.claimId) ||
        change.next.state !== 'transferred' ||
        change.next.successorClaimId === null
      ) {
        throw new Error('MANCODE_TRANSPORT_OWNERSHIP_TRANSFER_INVALID');
      }
      continue;
    }
    const predecessorId = change.next.predecessorClaimId;
    const predecessor =
      predecessorId === null
        ? undefined
        : input.previousClaims.find((claim) => claim.claimId === predecessorId);
    const transferred =
      predecessorId === null ? undefined : nextClaims.get(predecessorId);
    if (
      predecessor === undefined ||
      !acceptedClaimIds.has(predecessor.claimId) ||
      transferred?.successorClaimId !== change.next.claimId ||
      change.next.ownerActorId !== input.actorId
    ) {
      throw new Error('MANCODE_TRANSPORT_OWNERSHIP_TRANSFER_INVALID');
    }
  }
  if (
    input.previousHandoffs.every(
      (handoff) => handoff.handoffId !== input.acceptedHandoff.handoffId,
    )
  ) {
    throw new Error('MANCODE_TRANSPORT_OWNERSHIP_TRANSFER_INVALID');
  }
}

function metadataFromTaskBundle(
  bundle: GitRefTaskBundleV1,
): WorkflowMetadataV3 {
  const artifact = bundle.artifacts.find(
    (candidate) => candidate.kind === 'metadata',
  );
  if (artifact === undefined) {
    throw new Error('git-ref task bundle requires metadata');
  }
  return parseWorkflowMetadata(artifact.content);
}

function parseReplacementClaims(
  value: unknown,
  taskRef: TaskRef,
  workspaceId: Ulid,
  coordinationDomainId: string,
): ClaimV1[] {
  const claims = parseBoundedArray(
    value,
    MAX_CLAIMS,
    'git-ref coordination claims',
    parseClaim,
  );
  assertUnique(claims, (claim) => claim.claimId, 'git-ref coordination claims');
  for (const claim of claims) {
    if (
      !sameTaskRef(claim.taskRef, taskRef) ||
      claim.workspaceId !== workspaceId ||
      claim.authority.mode !== 'git-ref' ||
      claim.coordinationDomainId !== coordinationDomainId
    ) {
      throw new Error('MANCODE_TRANSPORT_CLAIM_AUTHORITY_MISMATCH');
    }
  }
  return claims.sort(compareClaims);
}

function assertManifestCoordinationDomain(
  manifest: GitRefTeamManifestV1,
  coordinationDomainId: string,
): void {
  if (
    manifest.claims.some(
      (claim) => claim.coordinationDomainId !== coordinationDomainId,
    )
  ) {
    throw new Error('MANCODE_COORDINATION_DOMAIN_MISMATCH');
  }
}

function parseReplacementHandoffs(
  value: unknown,
  taskRef: TaskRef,
): HandoffV1[] {
  const handoffs = parseBoundedArray(
    value,
    MAX_HANDOFFS,
    'git-ref coordination handoffs',
    parseHandoff,
  );
  assertUnique(
    handoffs,
    (handoff) => handoff.handoffId,
    'git-ref coordination handoffs',
  );
  for (const handoff of handoffs) {
    if (!sameTaskRef(handoff.taskRef, taskRef)) {
      throw new Error('MANCODE_TRANSPORT_HANDOFF_TASK_MISMATCH');
    }
  }
  return handoffs.sort(compareHandoffs);
}

function assertManifestUniqueness(manifest: GitRefTeamManifestV1): void {
  assertUnique(
    manifest.actorProfiles,
    (profile) => profile.actorId,
    'git-ref team manifest actorProfiles',
  );
  assertUnique(
    manifest.ownershipFences,
    (fence) => taskKey(fence.taskRef),
    'git-ref team manifest ownershipFences',
  );
  assertUnique(
    manifest.claims,
    (claim) => claim.claimId,
    'git-ref team manifest claims',
  );
  assertUnique(
    manifest.handoffs,
    (handoff) => handoff.handoffId,
    'git-ref team manifest handoffs',
  );
  assertUnique(
    manifest.taskBundles,
    (bundle) => taskKey(bundle.taskRef),
    'git-ref team manifest taskBundles',
  );
  assertUnique(
    manifest.receipts,
    (receipt) => String(receipt.remoteRevision),
    'git-ref team manifest receipts',
  );
}

function assertManifestCrossEntityConsistency(
  manifest: GitRefTeamManifestV1,
  allowLegacyNoReceipt: boolean,
): void {
  if (
    (manifest.authorityState === 'active' &&
      (manifest.authorityFreeze !== null ||
        manifest.authorityTombstone !== null)) ||
    (manifest.authorityState === 'frozen' &&
      (manifest.authorityFreeze === null ||
        manifest.authorityTombstone !== null ||
        manifest.authorityFreeze.successorEpoch <= manifest.transportEpoch ||
        manifest.authorityFreeze.operationId !== manifest.lastOperationId)) ||
    (manifest.authorityState === 'tombstoned' &&
      (manifest.authorityFreeze === null ||
        manifest.authorityTombstone === null ||
        manifest.authorityFreeze.successorMode !==
          manifest.authorityTombstone.successorMode ||
        manifest.authorityFreeze.successorEpoch !==
          manifest.authorityTombstone.successorEpoch ||
        manifest.authorityFreeze.operationId !==
          manifest.authorityTombstone.operationId ||
        manifest.authorityTombstone.successorEpoch <= manifest.transportEpoch ||
        manifest.authorityTombstone.operationId !== manifest.lastOperationId))
  ) {
    throw new Error('git-ref manifest authority state is inconsistent');
  }
  for (const fence of manifest.ownershipFences) {
    if (fence.remoteRevision > manifest.revision) {
      throw new Error(
        'git-ref ownership fence remoteRevision is in the future',
      );
    }
  }
  for (const claim of manifest.claims) {
    if (
      claim.workspaceId !== manifest.workspaceId ||
      claim.authority.mode !== 'git-ref'
    ) {
      throw new Error('git-ref manifest claim authority is invalid');
    }
    const revision = parseRemoteEntityRevision(claim.authority.remoteRevision);
    if (revision !== null && revision > manifest.revision) {
      throw new Error('git-ref manifest claim remoteRevision is in the future');
    }
  }
  for (const handoff of manifest.handoffs) {
    if (handoff.transport.mode !== 'git-ref') {
      throw new Error('git-ref manifest handoff transport is invalid');
    }
    if (
      handoff.transport.transportRevision !== null &&
      handoff.transport.transportRevision > manifest.revision
    ) {
      throw new Error(
        'git-ref manifest handoff transportRevision is in the future',
      );
    }
    if (handoff.state === 'offered') {
      const bundle = manifest.taskBundles.find((candidate) =>
        sameTaskRef(candidate.taskRef, handoff.taskRef),
      );
      if (
        bundle === undefined ||
        handoff.transport.taskBundleDigest !== bundle.bundleDigest
      ) {
        throw new Error('MANCODE_TRANSPORT_HANDOFF_BUNDLE_MISMATCH');
      }
    }
  }
  for (const bundle of manifest.taskBundles) {
    const fence = manifest.ownershipFences.find((candidate) =>
      sameTaskRef(candidate.taskRef, bundle.taskRef),
    );
    if (
      fence === undefined ||
      fence.taskRevision !== bundle.taskRevision ||
      fence.ownershipEpoch !== bundle.ownershipEpoch ||
      fence.aggregateDigest !== bundle.aggregateDigest
    ) {
      throw new Error('MANCODE_TRANSPORT_BUNDLE_FENCE_MISMATCH');
    }
  }
  for (const receipt of manifest.receipts) {
    if (receipt.remoteRevision > manifest.revision) {
      throw new Error('git-ref mutation receipt revision is in the future');
    }
  }
  if (manifest.lastMutation === null) {
    if (manifest.receipts.length > 0 || !allowLegacyNoReceipt) {
      throw new Error('git-ref manifest receipts require lastMutation');
    }
    return;
  }
  const latest = manifest.receipts.at(-1);
  if (
    latest === undefined ||
    digestCanonicalJson(latest) !==
      digestCanonicalJson(manifest.lastMutation) ||
    manifest.lastMutation.operationId !== manifest.lastOperationId ||
    manifest.lastMutation.remoteRevision !== manifest.revision
  ) {
    throw new Error('git-ref manifest lastMutation is inconsistent');
  }
  assertLastMutationEntityDigests(manifest, manifest.lastMutation);
}

function assertLastMutationEntityDigests(
  manifest: GitRefTeamManifestV1,
  receipt: GitRefRemoteMutationReceiptV1,
): void {
  let ownershipFence: GitRefOwnershipFenceV1 | GitRefOwnershipFenceV1[] | null;
  let claims: ClaimV1[];
  let handoffs: HandoffV1[];
  let taskBundle: GitRefTaskBundleV1 | GitRefTaskBundleV1[] | null;
  if (receipt.kind === 'coordination') {
    const taskRef = receipt.taskRef;
    if (taskRef === null) {
      throw new Error('git-ref coordination receipt requires taskRef');
    }
    ownershipFence =
      manifest.ownershipFences.find((value) =>
        sameTaskRef(value.taskRef, taskRef),
      ) ?? null;
    claims = manifest.claims.filter((value) =>
      sameTaskRef(value.taskRef, taskRef),
    );
    handoffs = manifest.handoffs.filter((value) =>
      sameTaskRef(value.taskRef, taskRef),
    );
    taskBundle =
      manifest.taskBundles.find((value) =>
        sameTaskRef(value.taskRef, taskRef),
      ) ?? null;
  } else if (
    receipt.kind === 'authority_establish' ||
    receipt.kind === 'authority_freeze' ||
    receipt.kind === 'authority_unfreeze' ||
    receipt.kind === 'authority_tombstone'
  ) {
    ownershipFence = manifest.ownershipFences;
    claims = manifest.claims;
    handoffs = manifest.handoffs;
    taskBundle = manifest.taskBundles;
  } else {
    ownershipFence = null;
    claims = [];
    handoffs = [];
    taskBundle = null;
  }
  const expected = {
    actorProfiles: digestCanonicalJson(manifest.actorProfiles),
    ownershipFence:
      ownershipFence === null ? null : digestCanonicalJson(ownershipFence),
    claims: digestCanonicalJson(claims),
    handoffs: digestCanonicalJson(handoffs),
    taskBundle: taskBundle === null ? null : digestCanonicalJson(taskBundle),
  };
  if (
    digestCanonicalJson(expected) !== digestCanonicalJson(receipt.entityDigests)
  ) {
    throw new Error('MANCODE_TRANSPORT_RECEIPT_DIGEST_MISMATCH');
  }
}

function assertTaskBundleConsistency(bundle: GitRefTaskBundleV1): void {
  if (
    !sameTaskRef(bundle.aggregate.taskRef, bundle.taskRef) ||
    bundle.aggregate.taskRevision !== bundle.taskRevision ||
    bundle.aggregate.ownershipEpoch !== bundle.ownershipEpoch ||
    bundle.aggregateDigest !== taskAggregateDigest(bundle.aggregate)
  ) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_AGGREGATE_MISMATCH');
  }
  assertUnique(
    bundle.artifacts,
    (artifact) => artifact.kind,
    'git-ref task bundle artifact kinds',
  );
  assertUnique(
    bundle.artifacts,
    (artifact) => artifact.relativePath,
    'git-ref task bundle artifact paths',
  );
  const byKind = new Map(
    bundle.artifacts.map((artifact) => [artifact.kind, artifact]),
  );
  for (const artifact of bundle.artifacts) {
    assertBundleArtifactPath(artifact);
  }
  for (const required of [
    'metadata',
    'requirements',
    'review',
    'verification',
  ] as const) {
    if (!byKind.has(required)) {
      throw new Error(`git-ref task bundle requires ${required}`);
    }
  }
  if (!byKind.has('plan') && !byKind.has('summary')) {
    throw new Error('git-ref task bundle requires plan or summary');
  }
  const metadata = parseWorkflowMetadata(byKind.get('metadata')?.content);
  const requirements = parseRequirementsLedger(
    byKind.get('requirements')?.content,
  );
  const review = parseReviewLedger(byKind.get('review')?.content);
  const verification = parseVerificationLedger(
    byKind.get('verification')?.content,
  );
  assertBundleEntityTask(
    bundle,
    metadata.taskRef,
    metadata.revision,
    'metadata',
  );
  assertBundleEntityTask(bundle, requirements.taskRef, null, 'requirements');
  assertBundleEntityTask(bundle, review.taskRef, null, 'review');
  assertBundleEntityTask(bundle, verification.taskRef, null, 'verification');
  if (
    metadata.ownershipEpoch !== bundle.ownershipEpoch ||
    workflowMetadataDigest(metadata) !== bundle.aggregate.metadataDigest ||
    requirementsLedgerDigest(requirements) !==
      bundle.aggregate.requirementsDigest ||
    reviewLedgerDigest(review) !== bundle.aggregate.reviewDigest ||
    verificationLedgerDigest(verification) !==
      bundle.aggregate.verificationDigest
  ) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_ENTITY_DIGEST_MISMATCH');
  }
  const checkpointArtifact = byKind.get('checkpoint');
  if (bundle.aggregate.latestCheckpointId === null) {
    if (checkpointArtifact !== undefined) {
      throw new Error(
        'git-ref task bundle must not include an unreferenced checkpoint',
      );
    }
  } else {
    if (checkpointArtifact === undefined) {
      throw new Error('git-ref task bundle requires checkpoint');
    }
    const checkpoint = parseCheckpoint(checkpointArtifact.content);
    if (
      checkpointArtifact.relativePath !==
      `checkpoints/${checkpoint.checkpointId}.json`
    ) {
      throw new Error('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_PATH_MISMATCH');
    }
    assertBundleEntityTask(bundle, checkpoint.taskRef, null, 'checkpoint');
    if (
      checkpoint.taskRevision > bundle.taskRevision ||
      checkpoint.ownershipEpochAtOffer > bundle.ownershipEpoch ||
      checkpointDigest(checkpoint) !==
        bundle.aggregate.latestCheckpointDigest ||
      checkpoint.checkpointId !== bundle.aggregate.latestCheckpointId
    ) {
      throw new Error('MANCODE_TRANSPORT_BUNDLE_ENTITY_DIGEST_MISMATCH');
    }
  }
  const plan = byKind.get('plan');
  if (
    bundle.aggregate.planDigest !== null &&
    (plan === undefined ||
      digestCanonicalJson({
        artifactRef: { taskRef: bundle.taskRef, kind: 'plan' },
        content: plan.content,
      }) !== bundle.aggregate.planDigest)
  ) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_PLAN_DIGEST_MISMATCH');
  }
}

function assertBundleArtifactPath(artifact: GitRefTaskBundleArtifactV1): void {
  const fixedPaths: Partial<Record<GitRefTaskBundleArtifactKind, string>> = {
    metadata: 'metadata.json',
    requirements: 'requirements.json',
    review: 'review-ledger.json',
    verification: 'verification-ledger.json',
    plan: 'plan.md',
    summary: 'summary.md',
  };
  const fixedPath = fixedPaths[artifact.kind];
  if (
    (fixedPath !== undefined && artifact.relativePath !== fixedPath) ||
    (artifact.kind === 'checkpoint' &&
      !/^checkpoints\/[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}\.json$/.test(
        artifact.relativePath,
      ))
  ) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_PATH_MISMATCH');
  }
}

function assertBundleEntityTask(
  bundle: GitRefTaskBundleV1,
  taskRef: TaskRef,
  taskRevision: number | null,
  label: string,
): void {
  if (
    !sameTaskRef(bundle.taskRef, taskRef) ||
    (taskRevision !== null && taskRevision !== bundle.taskRevision)
  ) {
    throw new Error(
      `git-ref task bundle ${label} does not match the bundle task`,
    );
  }
}

function parseGitRefTaskBundleArtifact(
  value: unknown,
): GitRefTaskBundleArtifactV1 {
  assertRecord(value, 'git-ref task bundle artifact');
  assertKnownKeys(
    value,
    ['kind', 'relativePath', 'content', 'contentDigest'],
    'git-ref task bundle artifact',
  );
  if (!isBundleArtifactKind(value.kind)) {
    throw new Error('git-ref task bundle artifact kind is invalid');
  }
  const relativePath = assertSafeSharedRelativePath(
    value.relativePath as string,
  );
  const content = parseJsonValue(
    value.content,
    'git-ref task bundle artifact content',
  );
  const serialized = JSON.stringify(content);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BUNDLE_ARTIFACT_BYTES) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_TOO_LARGE');
  }
  const contentDigest = parseDigest(
    value.contentDigest,
    'git-ref task bundle artifact contentDigest',
  );
  if (contentDigest !== digestCanonicalJson(content)) {
    throw new Error('MANCODE_TRANSPORT_BUNDLE_ARTIFACT_DIGEST_MISMATCH');
  }
  return { kind: value.kind, relativePath, content, contentDigest };
}

function parseJsonValue(
  value: unknown,
  label: string,
  depth = 0,
): GitRefJsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`${label} exceeds the maximum nesting depth`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertSharedTextSafe(value, label);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(`${label} numbers must be safe integers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => parseJsonValue(item, label, depth + 1));
  }
  assertRecord(value, label);
  const result: { [key: string]: unknown } = {};
  for (const [key, item] of Object.entries(value)) {
    assertSharedTextSafe(key, `${label} key`);
    result[key] = parseJsonValue(item, label, depth + 1);
  }
  return result;
}

function createMutationReceipt(input: {
  kind: GitRefRemoteMutationReceiptV1['kind'];
  operationId: Ulid;
  actorId: Ulid;
  taskRef: TaskRef | null;
  remoteRevision: number;
  ownershipEpoch: number | null;
  actorProfiles: SharedActorProfileV1[];
  ownershipFence: GitRefOwnershipFenceV1 | GitRefOwnershipFenceV1[] | null;
  claims: ClaimV1[];
  handoffs: HandoffV1[];
  taskBundle: GitRefTaskBundleV1 | GitRefTaskBundleV1[] | null;
  committedAt: string;
}): GitRefRemoteMutationReceiptV1 {
  return parseGitRefRemoteMutationReceipt({
    schemaVersion: 1,
    kind: input.kind,
    operationId: input.operationId,
    actorId: input.actorId,
    taskRef: input.taskRef,
    remoteRevision: input.remoteRevision,
    ownershipEpoch: input.ownershipEpoch,
    entityDigests: {
      actorProfiles: digestCanonicalJson(input.actorProfiles),
      ownershipFence:
        input.ownershipFence === null
          ? null
          : digestCanonicalJson(input.ownershipFence),
      claims: digestCanonicalJson(input.claims),
      handoffs: digestCanonicalJson(input.handoffs),
      taskBundle:
        input.taskBundle === null
          ? null
          : digestCanonicalJson(input.taskBundle),
    },
    committedAt: input.committedAt,
  });
}

function parseReceiptEntityDigests(
  value: unknown,
): GitRefRemoteMutationReceiptV1['entityDigests'] {
  assertRecord(value, 'git-ref mutation receipt entityDigests');
  assertKnownKeys(
    value,
    ['actorProfiles', 'ownershipFence', 'claims', 'handoffs', 'taskBundle'],
    'git-ref mutation receipt entityDigests',
  );
  return {
    actorProfiles: parseDigest(
      value.actorProfiles,
      'receipt actorProfiles digest',
    ),
    ownershipFence:
      value.ownershipFence === null
        ? null
        : parseDigest(value.ownershipFence, 'receipt ownershipFence digest'),
    claims: parseDigest(value.claims, 'receipt claims digest'),
    handoffs: parseDigest(value.handoffs, 'receipt handoffs digest'),
    taskBundle:
      value.taskBundle === null
        ? null
        : parseDigest(value.taskBundle, 'receipt taskBundle digest'),
  };
}

function emptyManifest(header: ManifestHeader): GitRefTeamManifestV1 {
  return {
    schemaVersion: 1,
    ...header,
    authorityState: 'active',
    authorityFreeze: null,
    authorityTombstone: null,
    revision: 0,
    lastOperationId: header.workspaceId,
    actorProfiles: [],
    ownershipFences: [],
    claims: [],
    handoffs: [],
    taskBundles: [],
    receipts: [],
    lastMutation: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function compatibilityHeader(
  options: GitRefTeamManifestStoreOptions,
): ManifestHeader {
  const schemaEpoch = options.schemaEpoch ?? options.workspaceId;
  const minReaderVersion = options.minReaderVersion ?? '0.0.0';
  const minWriterVersion = options.minWriterVersion ?? '0.0.0';
  const transportEpoch = options.transportEpoch ?? 1;
  const configRevision = options.configRevision ?? 1;
  const configDigest =
    options.configDigest ??
    compatibilityConfigDigest({
      workspaceId: options.workspaceId,
      schemaEpoch,
      transportEpoch,
      configRevision,
    });
  return {
    workspaceId: options.workspaceId,
    schemaEpoch,
    minReaderVersion,
    minWriterVersion,
    transportEpoch,
    configRevision,
    configDigest,
  };
}

function compatibilityConfigDigest(input: {
  workspaceId: Ulid;
  schemaEpoch: Ulid;
  transportEpoch: number;
  configRevision: number;
}): string {
  return digestCanonicalJson({ compatibility: true, ...input });
}

function isLegacyProfileManifest(value: Record<string, unknown>): boolean {
  const legacyKeys = new Set([
    'schemaVersion',
    'workspaceId',
    'revision',
    'lastOperationId',
    'actorProfiles',
    'updatedAt',
  ]);
  return (
    !Object.hasOwn(value, 'schemaEpoch') &&
    Object.keys(value).every((key) => legacyKeys.has(key))
  );
}

function normalizeLegacyProfileManifest(
  value: Record<string, unknown>,
): Record<string, unknown> {
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'workspaceId',
      'revision',
      'lastOperationId',
      'actorProfiles',
      'updatedAt',
    ],
    'legacy git-ref profile manifest',
  );
  assertUlid(value.workspaceId, 'legacy git-ref manifest workspaceId');
  return {
    ...value,
    schemaEpoch: value.workspaceId,
    minReaderVersion: '0.0.0',
    minWriterVersion: '0.0.0',
    transportEpoch: 1,
    configRevision: 1,
    configDigest: compatibilityConfigDigest({
      workspaceId: value.workspaceId,
      schemaEpoch: value.workspaceId,
      transportEpoch: 1,
      configRevision: 1,
    }),
    authorityState: 'active',
    authorityFreeze: null,
    authorityTombstone: null,
    ownershipFences: [],
    claims: [],
    handoffs: [],
    taskBundles: [],
    receipts: [],
    lastMutation: null,
  };
}

function assertExpectedHeader(
  manifest: GitRefTeamManifestV1,
  expected: Partial<Omit<ManifestHeader, 'workspaceId'>>,
): void {
  for (const key of [
    'schemaEpoch',
    'minReaderVersion',
    'minWriterVersion',
    'transportEpoch',
    'configRevision',
    'configDigest',
  ] as const) {
    if (expected[key] !== undefined && manifest[key] !== expected[key]) {
      throw new Error(`MANCODE_TRANSPORT_${headerErrorName(key)}_MISMATCH`);
    }
  }
}

function assertActiveAuthority(manifest: GitRefTeamManifestV1 | null): void {
  if (manifest !== null && manifest.authorityState !== 'active') {
    throw new Error('MANCODE_TRANSPORT_AUTHORITY_NOT_ACTIVE');
  }
}

function headerErrorName(
  key: keyof Omit<ManifestHeader, 'workspaceId'>,
): string {
  return key.replace(/[A-Z]/g, (match) => `_${match}`).toUpperCase();
}

function appendReceipt(
  receipts: GitRefRemoteMutationReceiptV1[],
  receipt: GitRefRemoteMutationReceiptV1,
): GitRefRemoteMutationReceiptV1[] {
  return [...receipts.slice(-(MAX_RECEIPTS - 1)), receipt].sort(
    compareReceipts,
  );
}

function upsertActorProfile(
  profiles: SharedActorProfileV1[],
  profile: SharedActorProfileV1,
): SharedActorProfileV1[] {
  const existing = profiles.find(
    (candidate) => candidate.actorId === profile.actorId,
  );
  if (
    existing !== undefined &&
    (existing.displayName !== profile.displayName ||
      existing.joinedAt !== profile.joinedAt)
  ) {
    throw new Error('MANCODE_ACTOR_PROFILE_CONFLICT');
  }
  return [
    ...profiles.filter((candidate) => candidate.actorId !== profile.actorId),
    profile,
  ]
    .map(parseSharedActorProfile)
    .sort(compareActorProfiles);
}

async function writeManifestCommit(
  projectRoot: string,
  parent: string | null,
  manifest: GitRefTeamManifestV1,
  now: Date,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'mancode-git-ref-'),
  );
  const manifestPath = path.join(temporaryDirectory, 'manifest.json');
  const indexPath = path.join(temporaryDirectory, 'index');
  try {
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) {
      throw new Error('MANCODE_TRANSPORT_MANIFEST_TOO_LARGE');
    }
    await writeFile(manifestPath, serialized);
    const blob = (
      await runGit(projectRoot, ['hash-object', '-w', manifestPath])
    ).trim();
    const environment = { ...process.env, GIT_INDEX_FILE: indexPath };
    await runGit(projectRoot, ['read-tree', '--empty'], environment);
    await runGit(
      projectRoot,
      ['update-index', '--add', '--cacheinfo', `100644,${blob},manifest.json`],
      environment,
    );
    const tree = (
      await runGit(projectRoot, ['write-tree'], environment)
    ).trim();
    const timestamp = Math.floor(now.getTime() / 1_000);
    const commitEnvironment = {
      ...process.env,
      GIT_AUTHOR_NAME: 'mancode transport',
      GIT_AUTHOR_EMAIL: 'transport@mancode.invalid',
      GIT_AUTHOR_DATE: `${timestamp} +0000`,
      GIT_COMMITTER_NAME: 'mancode transport',
      GIT_COMMITTER_EMAIL: 'transport@mancode.invalid',
      GIT_COMMITTER_DATE: `${timestamp} +0000`,
    };
    return (
      await runGit(
        projectRoot,
        [
          'commit-tree',
          tree,
          ...(parent === null ? [] : ['-p', parent]),
          '-m',
          'mancode team transport',
        ],
        commitEnvironment,
      )
    ).trim();
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function pushWithLease(
  projectRoot: string,
  remote: string,
  expectedCommit: string | null,
  commit: string,
): Promise<void> {
  try {
    await runGit(projectRoot, [
      'push',
      `--force-with-lease=${TEAM_REF}:${expectedCommit ?? ''}`,
      remote,
      `${commit}:${TEAM_REF}`,
    ]);
  } catch (error) {
    if (isGitFailure(error)) {
      const stderr =
        'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr
          : error.message;
      if (/\b(?:rejected|stale info|fetch first)\b/i.test(stderr)) {
        throw new Error('MANCODE_TRANSPORT_CAS_CONFLICT');
      }
      throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
    }
    throw error;
  }
}

async function gitShow(projectRoot: string, revision: string): Promise<string> {
  try {
    return await runGit(projectRoot, ['show', revision]);
  } catch (error) {
    if (isGitFailure(error))
      throw new Error('MANCODE_TRANSPORT_MANIFEST_INVALID');
    throw error;
  }
}

async function runGit(
  projectRoot: string,
  arguments_: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await execFile('git', arguments_, {
    cwd: projectRoot,
    env,
    windowsHide: true,
    maxBuffer: MAX_MANIFEST_BYTES * 2,
  });
  return result.stdout;
}

async function readRemoteCommit(
  projectRoot: string,
  remote: string,
): Promise<string | null> {
  try {
    const output = await runGit(projectRoot, ['ls-remote', remote, TEAM_REF]);
    const value = output.trim();
    if (!value) return null;
    const commit = value.split(/\s+/)[0];
    if (commit === undefined || !GIT_OBJECT_PATTERN.test(commit)) {
      throw new Error('MANCODE_TRANSPORT_MANIFEST_INVALID');
    }
    return commit;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MANCODE_'))
      throw error;
    throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  }
}

function receiptFor(commit: string, manifest: GitRefTeamManifestV1): string {
  return `git-ref:${commit}:${digestCanonicalJson(manifest)}`;
}

function normalizeRemoteIdentity(projectRoot: string, value: string): string {
  if (!value || value.includes('\0')) {
    throw new Error('MANCODE_TRANSPORT_REMOTE_INVALID');
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  if (
    scp !== null &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) &&
    !/^[A-Za-z]:[\\/]/.test(value)
  ) {
    const host = scp[1];
    const remotePath = scp[2];
    if (host === undefined || remotePath === undefined || !remotePath.trim()) {
      throw new Error('MANCODE_TRANSPORT_REMOTE_INVALID');
    }
    return `ssh://${host.toLowerCase()}/${remotePath.replace(/^\/+|\/+$/g, '')}`;
  }
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/g, '');
    return url.toString();
  } catch {
    return path.resolve(projectRoot, value).replaceAll('\\', '/');
  }
}

function parseBundleCodeRef(value: unknown): GitRefTaskBundleV1['codeRef'] {
  assertRecord(value, 'git-ref task bundle codeRef');
  assertKnownKeys(value, ['branch', 'head'], 'git-ref task bundle codeRef');
  if (
    typeof value.branch !== 'string' ||
    !value.branch.trim() ||
    value.branch.includes('\0') ||
    typeof value.head !== 'string' ||
    !GIT_OBJECT_PATTERN.test(value.head)
  ) {
    throw new Error('git-ref task bundle codeRef is invalid');
  }
  assertSharedTextSafe(value.branch, 'git-ref task bundle codeRef branch');
  return { branch: value.branch, head: value.head };
}

function parseSharedTaskRef(value: unknown, label: string): TaskRef {
  const taskRef = parseTaskRefValue(value);
  if (taskRef.namespace !== 'shared') {
    throw new Error(`${label} must use the shared namespace`);
  }
  return taskRef;
}

function parseBoundedArray<T>(
  value: unknown,
  maximum: number,
  label: string,
  parse: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum)
    throw new Error(`${label} exceeds the entity limit`);
  return value.map(parse);
}

function assertUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const itemKey = key(value);
    if (seen.has(itemKey)) throw new Error(`${label} has duplicates`);
    seen.add(itemKey);
  }
}

function replaceTaskEntity<T>(
  existing: readonly T[],
  taskRef: TaskRef,
  replacement: readonly T[],
  getTaskRef: (value: T) => TaskRef,
): T[] {
  return [
    ...existing.filter((value) => !sameTaskRef(getTaskRef(value), taskRef)),
    ...replacement,
  ];
}

function parseExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('MANCODE_TRANSPORT_REVISION_INVALID');
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parsePositiveIntegerOrNull(
  value: unknown,
  label: string,
): number | null {
  return value === null ? null : parsePositiveInteger(value, label);
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be a semantic version`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseAuthorityState(
  value: unknown,
): 'active' | 'frozen' | 'tombstoned' {
  if (value !== 'active' && value !== 'frozen' && value !== 'tombstoned') {
    throw new Error('git-ref team manifest authorityState is invalid');
  }
  return value;
}

function parseOptionalPositiveInteger(value: unknown, label: string): void {
  if (value !== undefined) parsePositiveInteger(value, label);
}

function parseOptionalVersion(value: unknown, label: string): void {
  if (value !== undefined) parseVersion(value, label);
}

function parseOptionalDigest(value: unknown, label: string): void {
  if (value !== undefined) parseDigest(value, label);
}

function parseRemoteEntityRevision(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('git-ref entity remoteRevision must be a decimal revision');
  }
  return parsePositiveInteger(Number(value), 'git-ref entity remoteRevision');
}

function assertManifestSize(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('MANCODE_TRANSPORT_MANIFEST_INVALID');
  }
  if (serialized === undefined) {
    throw new Error('MANCODE_TRANSPORT_MANIFEST_INVALID');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('MANCODE_TRANSPORT_MANIFEST_TOO_LARGE');
  }
}

function isBundleArtifactKind(
  value: unknown,
): value is GitRefTaskBundleArtifactKind {
  return (
    value === 'metadata' ||
    value === 'checkpoint' ||
    value === 'requirements' ||
    value === 'review' ||
    value === 'verification' ||
    value === 'plan' ||
    value === 'summary'
  );
}

function taskKey(taskRef: TaskRef): string {
  return `${taskRef.namespace}:${taskRef.taskId}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function compareActorProfiles(
  left: SharedActorProfileV1,
  right: SharedActorProfileV1,
): number {
  return compareUtf8(left.actorId, right.actorId);
}

function compareByTaskRef<T extends { taskRef: TaskRef }>(
  left: T,
  right: T,
): number {
  return compareUtf8(taskKey(left.taskRef), taskKey(right.taskRef));
}

function compareClaims(left: ClaimV1, right: ClaimV1): number {
  return compareUtf8(left.claimId, right.claimId);
}

function compareHandoffs(left: HandoffV1, right: HandoffV1): number {
  return compareUtf8(left.handoffId, right.handoffId);
}

function compareReceipts(
  left: GitRefRemoteMutationReceiptV1,
  right: GitRefRemoteMutationReceiptV1,
): number {
  return left.remoteRevision - right.remoteRevision;
}

function compareBundleArtifacts(
  left: GitRefTaskBundleArtifactV1,
  right: GitRefTaskBundleArtifactV1,
): number {
  return compareUtf8(left.kind, right.kind);
}

function isGitFailure(
  error: unknown,
): error is Error & { code: unknown; stderr?: unknown } {
  return error instanceof Error && 'code' in error;
}

import { digestCanonicalJson } from '../context/canonical.js';
import { type Ulid, assertUlid, createUlid } from '../context/ids.js';
import { assertManteamPlanContent } from '../context/manteam-plan.js';
import { assertTaskCodeHeadUnchanged } from '../context/task-mutation.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import { createClaim } from '../runtime/claim-store.js';
import { recordLocalDiagnostic } from '../runtime/diagnostics.js';
import type { OperationJournalV1 } from '../runtime/operation-journal.js';
import { createClaimRecoveryAction } from '../runtime/operation-recovery-payload.js';
import { readCheckoutBranch } from '../runtime/project-runtime.js';
import {
  advanceTaskOperation,
  commitTaskOperation,
  createTaskOperationJournal,
  handleTaskOperationFailure,
  openV3TaskOperation,
  taskEntityKey,
} from '../runtime/task-operation.js';
import { localCoordinationDomainId } from '../runtime/workspace-binding.js';
import {
  type ClaimScope,
  type ClaimV1,
  normalizeClaimScope,
  parseClaim,
} from './claims.js';
import {
  assertClaimScopeSubset,
  assessClaimConflicts,
  deriveClaimValidity,
} from './conflicts.js';
import { capabilitiesFromProjectConfig } from './transport.js';

export const DEFAULT_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_CLAIM_TTL_MS = 60 * 1000;
export const MAX_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AcquireV3ClaimInput {
  projectRoot: string;
  taskRef: TaskRef;
  sessionId: Ulid;
  expectedTaskRevision: number;
  scope: unknown;
  ttlMs?: number;
  claimId?: Ulid;
  operationId?: Ulid;
  now?: Date;
}

export interface AcquiredV3Claim {
  claim: ClaimV1;
  operation: OperationJournalV1;
  conflict: ReturnType<typeof assessClaimConflicts>;
}

/**
 * Acquires an active local-coordination claim under the shared task lock. It
 * binds scope, task revision, ownership epoch, and the current code head in
 * the claim's immutable acquisition snapshot.
 */
export async function acquireV3Claim(
  input: AcquireV3ClaimInput,
): Promise<AcquiredV3Claim> {
  const taskRef = parseTaskRefValue(input.taskRef);
  if (taskRef.namespace !== 'shared') {
    throw new Error('MANCODE_CLAIM_REQUIRES_SHARED_TASK');
  }
  const scope = normalizeClaimScope(input.scope);
  const ttlMs = parseClaimTtl(input.ttlMs);
  const now = input.now ?? new Date();
  const claimId = input.claimId ?? createUlid(now.getTime());
  const operationId = input.operationId ?? createUlid(now.getTime());
  assertUlid(claimId, 'claimId');
  assertUlid(operationId, 'claim operationId');
  const context = await openV3TaskOperation({
    projectRoot: input.projectRoot,
    taskRef,
    sessionId: input.sessionId,
    expectedTaskRevision: input.expectedTaskRevision,
    operationId,
    extraEntityLocks: [`claim:${claimId}`],
    now,
  });
  let journal: OperationJournalV1 | null = null;
  try {
    assertClaimTaskEligible(
      context.task.metadata,
      context.task.plan?.content ?? null,
    );
    if (context.project.config.transport.mode !== 'local') {
      throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
    }
    assertClaimScopeSubset(scope, {
      source: context.task.metadata.implementationScope.source,
      include: context.task.metadata.implementationScope.include,
      exclude: context.task.metadata.implementationScope.exclude,
      modules: context.task.metadata.implementationScope.modules,
    });
    const capabilities = capabilitiesFromProjectConfig(context.project.config);
    const codeHead = context.codeHead;
    if (codeHead === null) {
      throw new Error('MANCODE_TASK_HEAD_CODE_REF_UNAVAILABLE');
    }
    const staleClaims = context.coordination.claims.filter(
      (claim) =>
        claim.state === 'active' &&
        deriveClaimValidity(claim, {
          taskRef,
          taskRevision: context.task.metadata.revision,
          implementationScopeDigest:
            context.task.metadata.implementationScope.digest,
          ownershipEpoch: context.task.metadata.ownershipEpoch,
          codeRefHead: codeHead,
          now: context.now,
          transportFreshness: 'fresh',
        }) !== 'fresh',
    );
    if (staleClaims.length > 0) {
      throw new Error('MANCODE_CLAIM_REVALIDATION_REQUIRED');
    }
    const conflict = assessClaimConflicts(scope, context.coordination.claims, {
      // `unavailable` describes cross-clone visibility for local transport;
      // the common-dir store read under this lock is nevertheless fresh.
      transportFreshness: 'fresh',
      claimAcquisition: capabilities.claimAcquisition,
    });
    if (conflict.acquisition !== 'allow') {
      throw new Error('MANCODE_SCOPE_CONFLICT');
    }
    const timestamp = context.now.toISOString();
    const branch = (await readCheckoutBranch(context.projectRoot)) ?? 'HEAD';
    const claim = parseClaim({
      schemaVersion: 1,
      claimId,
      workspaceId: context.runtime.workspaceId,
      coordinationDomainId: coordinationDomainId(context),
      authority: { mode: 'local', remoteRevision: null },
      taskRef,
      taskRevisionAtAcquire: context.task.metadata.revision,
      lastValidatedTaskRevision: context.task.metadata.revision,
      implementationScopeDigest:
        context.task.metadata.implementationScope.digest,
      ownershipEpochAtAcquire: context.task.metadata.ownershipEpoch,
      ownerActorId: context.session.actorId,
      state: 'active',
      revision: 1,
      scope,
      scopeDigest: digestCanonicalJson(scope),
      codeRefAtAcquire: { branch, head: codeHead },
      lastValidatedCodeRef: { branch, head: codeHead },
      acquisitionEnforcement: capabilities.claimAcquisition,
      writeGuard: capabilities.writeGuard,
      expiresAt: new Date(context.now.getTime() + ttlMs).toISOString(),
      predecessorClaimId: null,
      successorClaimId: null,
      lastOperationId: context.operationId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    journal = await createTaskOperationJournal(context, {
      type: 'claim_create',
      action: 'claim_create',
      expectedRevisions: {
        [taskEntityKey(taskRef)]: context.task.metadata.revision,
        [`claim:${claimId}`]: 0,
      },
      conditions: { implementationScopeContainsClaim: true },
      recovery: {
        actions: [
          createClaimRecoveryAction({
            stepId: 'create-active-claim',
            before: null,
            claim,
          }),
        ],
      },
    });
    journal = await advanceTaskOperation(context, journal, 'validate', true);
    journal = await advanceTaskOperation(
      context,
      journal,
      'create-active-claim',
      false,
    );
    await assertTaskCodeHeadUnchanged(context.projectRoot, context.codeHead);
    await createClaim(context.homeStore, claim);
    const operation = await commitTaskOperation(context, journal);
    return { claim, operation, conflict };
  } catch (error) {
    if (error instanceof Error && error.message === 'MANCODE_SCOPE_CONFLICT') {
      await recordLocalDiagnostic(input.projectRoot, {
        kind: 'claim_conflict',
        level: 'blocker',
      }).catch(() => undefined);
    }
    if (journal !== null) {
      try {
        await handleTaskOperationFailure(context, journal);
      } catch {
        // A durable journal blocks overlapping mutations until repair.
      }
    }
    throw error;
  } finally {
    await context.release();
  }
}

function assertClaimTaskEligible(
  metadata: {
    workflowMode: string;
    status: string;
    currentStep: number;
    governance: { planDecision: string | null };
    implementationScope: { source: string };
  },
  plan: string | null,
): void {
  if (metadata.workflowMode !== 'manteam') {
    throw new Error('MANCODE_CLAIM_WORKFLOW_MODE_INVALID');
  }
  if (metadata.status !== 'in_progress') {
    throw new Error('MANCODE_CLAIM_WORKFLOW_NOT_ACTIVE');
  }
  if (metadata.implementationScope.source === 'legacy_unspecified') {
    throw new Error('MANCODE_SCOPE_CONFIRMATION_REQUIRED');
  }
  if (
    metadata.governance.planDecision !== 'governed_execution' ||
    metadata.currentStep < 5 ||
    plan === null
  ) {
    throw new Error('MANCODE_MANTEAM_PLAN_CONFIRMATION_REQUIRED');
  }
  assertManteamPlanContent(plan);
}

function coordinationDomainId(
  context: Awaited<ReturnType<typeof openV3TaskOperation>>,
): string {
  if (context.runtime.repositoryBindingId !== null) {
    return localCoordinationDomainId(
      context.runtime.repositoryBindingId,
      context.runtime.workspaceId,
    );
  }
  // Non-Git local coordination has no repository binding. Its workspace ID is
  // still a stable authority boundary and cannot collide with Git bindings.
  return `local:non-git:${context.runtime.workspaceId}`;
}

export function parseClaimTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_CLAIM_TTL_MS;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < MIN_CLAIM_TTL_MS ||
    ttl > MAX_CLAIM_TTL_MS
  ) {
    throw new Error('MANCODE_CLAIM_TTL_INVALID');
  }
  return ttl;
}

export type { ClaimScope };

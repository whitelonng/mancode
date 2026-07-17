import { type TaskRef, sameTaskRef } from '../context/task-ref.js';
import type { WorkflowMetadataV3 } from '../context/workflow-metadata.js';
import type { CapabilityLevel, Freshness } from './capabilities.js';
import type { ClaimScope, ClaimV1 } from './claims.js';

export type ClaimValidity =
  | 'inactive'
  | 'reclaim_required'
  | 'needs_revalidation'
  | 'code_ref_stale'
  | 'expired'
  | 'expiry_candidate'
  | 'fresh';
export type ClaimConflictLevel =
  | 'none'
  | 'info'
  | 'warning'
  | 'blocker'
  | 'unknown';
export type ClaimAcquisitionDecision =
  | 'allow'
  | 'confirm_or_narrow'
  | 'reject'
  | 'sync_or_confirm'
  | 'unavailable';

export interface ClaimValidationContext {
  taskRef: TaskRef;
  taskRevision: number;
  implementationScopeDigest: string;
  ownershipEpoch: number;
  codeRefHead: string;
  now?: Date;
  transportFreshness: Freshness;
}

export interface ClaimScopeBoundary {
  source: WorkflowMetadataV3['implementationScope']['source'];
  include: string[];
  exclude: string[];
  modules: string[];
  apis?: string[];
  schemas?: string[];
}

export interface ClaimScopeSubsetResult {
  allowed: boolean;
  reasons: Array<
    | 'scope_confirmation_required'
    | 'path_outside_include'
    | 'path_overlaps_exclude'
    | 'module_outside_scope'
    | 'api_unverifiable'
    | 'api_outside_scope'
    | 'schema_unverifiable'
    | 'schema_outside_scope'
  >;
}

export interface ClaimConflictAssessment {
  level: ClaimConflictLevel;
  acquisition: ClaimAcquisitionDecision;
  conflictingClaimIds: string[];
  reasons: string[];
}

/**
 * Derives, rather than persists, stale claim state. Scope/owner drift can
 * never be repaired by renew: callers must terminate and re-claim with a new
 * identity. A git-ref expiry is only a candidate until remote CAS decides it.
 */
export function deriveClaimValidity(
  claim: ClaimV1,
  context: ClaimValidationContext,
): ClaimValidity {
  assertClaimValidationContext(context);
  if (claim.state !== 'active') return 'inactive';
  if (!sameTaskRef(claim.taskRef, context.taskRef)) return 'reclaim_required';
  if (
    claim.implementationScopeDigest !== context.implementationScopeDigest ||
    claim.ownershipEpochAtAcquire !== context.ownershipEpoch
  ) {
    return 'reclaim_required';
  }
  if (claim.lastValidatedTaskRevision < context.taskRevision) {
    return 'needs_revalidation';
  }
  if (claim.lastValidatedCodeRef.head !== context.codeRefHead) {
    return 'code_ref_stale';
  }
  const now = context.now ?? new Date();
  if (Date.parse(claim.expiresAt) <= now.getTime()) {
    return claim.authority.mode === 'git-ref' ? 'expiry_candidate' : 'expired';
  }
  return 'fresh';
}

/** Conservative scope proof; unknown API/schema boundaries are never assumed safe. */
export function evaluateClaimScopeSubset(
  scope: ClaimScope,
  boundary: ClaimScopeBoundary,
): ClaimScopeSubsetResult {
  const reasons: ClaimScopeSubsetResult['reasons'] = [];
  if (boundary.source === 'legacy_unspecified') {
    reasons.push('scope_confirmation_required');
    return { allowed: false, reasons };
  }
  for (const claimPath of scope.paths) {
    if (
      !boundary.include.some((include) => isPathSubsetOf(claimPath, include))
    ) {
      reasons.push('path_outside_include');
      continue;
    }
    if (
      boundary.exclude.some((exclude) =>
        globPatternsMayOverlap(claimPath, exclude),
      )
    ) {
      reasons.push('path_overlaps_exclude');
    }
  }
  for (const module of scope.modules) {
    if (!boundary.modules.includes(module))
      reasons.push('module_outside_scope');
  }
  evaluateNamedScopeSubset(scope.apis, boundary.apis, 'api', reasons);
  evaluateNamedScopeSubset(scope.schemas, boundary.schemas, 'schema', reasons);
  return { allowed: reasons.length === 0, reasons: unique(reasons) };
}

export function assertClaimScopeSubset(
  scope: ClaimScope,
  boundary: ClaimScopeBoundary,
): void {
  const result = evaluateClaimScopeSubset(scope, boundary);
  if (result.allowed) return;
  if (result.reasons.includes('scope_confirmation_required')) {
    throw new Error('MANCODE_SCOPE_CONFIRMATION_REQUIRED');
  }
  throw new Error(
    `MANCODE_SCOPE_OUTSIDE_IMPLEMENTATION_SCOPE: ${result.reasons.join(',')}`,
  );
}

/**
 * Computes conflict policy without mutating any claim. Only a fresh authority
 * can claim a blocker; stale/unknown remote state deliberately becomes
 * unknown rather than a false "no conflict" assertion.
 */
export function assessClaimConflicts(
  candidateScope: ClaimScope,
  activeClaims: readonly ClaimV1[],
  options: {
    transportFreshness: Freshness;
    claimAcquisition: CapabilityLevel;
  },
): ClaimConflictAssessment {
  if (
    options.claimAcquisition === 'unavailable' ||
    options.transportFreshness === 'unavailable'
  ) {
    return emptyAssessment('unknown', 'unavailable', [
      'claim acquisition unavailable',
    ]);
  }
  if (
    options.transportFreshness === 'stale' ||
    options.transportFreshness === 'unknown'
  ) {
    return emptyAssessment('unknown', 'sync_or_confirm', [
      'coordination freshness is not proven',
    ]);
  }
  let level: ClaimConflictLevel = 'none';
  const claimIds: string[] = [];
  const reasons: string[] = [];
  for (const claim of activeClaims) {
    if (claim.state !== 'active') continue;
    const relation = compareClaimScopes(candidateScope, claim.scope);
    if (relation === 'none') continue;
    claimIds.push(claim.claimId);
    reasons.push(`${claim.claimId}:${relation}`);
    level = strongestLevel(level, relation);
  }
  const acquisition = acquisitionFor(level, options.claimAcquisition);
  return {
    level,
    acquisition,
    conflictingClaimIds: [...new Set(claimIds)].sort(),
    reasons: [...new Set(reasons)].sort(),
  };
}

function evaluateNamedScopeSubset(
  values: string[],
  boundaryValues: string[] | undefined,
  kind: 'api' | 'schema',
  reasons: ClaimScopeSubsetResult['reasons'],
): void {
  if (values.length === 0) return;
  if (boundaryValues === undefined) {
    reasons.push(kind === 'api' ? 'api_unverifiable' : 'schema_unverifiable');
    return;
  }
  for (const value of values) {
    if (!boundaryValues.includes(value)) {
      reasons.push(
        kind === 'api' ? 'api_outside_scope' : 'schema_outside_scope',
      );
    }
  }
}

function compareClaimScopes(
  candidate: ClaimScope,
  existing: ClaimScope,
): ClaimConflictLevel {
  if (hasIntersection(candidate.schemas, existing.schemas)) return 'blocker';
  if (hasExactPathIntersection(candidate.paths, existing.paths))
    return 'blocker';
  if (hasPotentialPathIntersection(candidate.paths, existing.paths))
    return 'warning';
  if (
    hasIntersection(candidate.modules, existing.modules) ||
    hasIntersection(candidate.apis, existing.apis)
  ) {
    return 'info';
  }
  return 'none';
}

function hasExactPathIntersection(left: string[], right: string[]): boolean {
  return left.some(
    (value) => !containsGlob(value) && right.some((other) => other === value),
  );
}

function hasPotentialPathIntersection(
  left: string[],
  right: string[],
): boolean {
  return left.some((value) =>
    right.some(
      (other) =>
        globPatternsMayOverlap(value, other) &&
        (value !== other || containsGlob(value) || containsGlob(other)),
    ),
  );
}

function isPathSubsetOf(candidate: string, boundary: string): boolean {
  if (candidate === boundary) return true;
  const candidatePrefix = staticPathPrefix(candidate);
  const boundaryPrefix = staticPathPrefix(boundary);
  if (!candidatePrefix.startsWith(boundaryPrefix)) return false;
  if (!containsGlob(boundary)) return candidate === boundary;
  return boundary.endsWith('/**') || boundary.endsWith('*');
}

function globPatternsMayOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftPrefix = staticPathPrefix(left);
  const rightPrefix = staticPathPrefix(right);
  return (
    leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix)
  );
}

function staticPathPrefix(value: string): string {
  const wildcard = value.search(/[*!?\[]/);
  const prefix = wildcard === -1 ? value : value.slice(0, wildcard);
  return prefix.endsWith('/')
    ? prefix
    : prefix.slice(0, prefix.lastIndexOf('/') + 1);
}

function containsGlob(value: string): boolean {
  return /[*!?\[]/.test(value);
}

function hasIntersection(left: string[], right: string[]): boolean {
  return left.some((value) => right.includes(value));
}

function strongestLevel(
  left: ClaimConflictLevel,
  right: ClaimConflictLevel,
): ClaimConflictLevel {
  const priority: Record<ClaimConflictLevel, number> = {
    none: 0,
    info: 1,
    warning: 2,
    blocker: 3,
    unknown: 4,
  };
  return priority[right] > priority[left] ? right : left;
}

function acquisitionFor(
  level: ClaimConflictLevel,
  enforcement: CapabilityLevel,
): ClaimAcquisitionDecision {
  if (enforcement === 'unavailable') return 'unavailable';
  switch (level) {
    case 'none':
    case 'info':
      return 'allow';
    case 'warning':
      return 'confirm_or_narrow';
    case 'blocker':
      return enforcement === 'enforced' ? 'reject' : 'confirm_or_narrow';
    case 'unknown':
      return 'sync_or_confirm';
  }
}

function emptyAssessment(
  level: ClaimConflictLevel,
  acquisition: ClaimAcquisitionDecision,
  reasons: string[],
): ClaimConflictAssessment {
  return { level, acquisition, conflictingClaimIds: [], reasons };
}

function assertClaimValidationContext(context: ClaimValidationContext): void {
  if (!Number.isSafeInteger(context.taskRevision) || context.taskRevision < 1) {
    throw new Error('claim validation taskRevision must be a positive integer');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(context.implementationScopeDigest)) {
    throw new Error('claim validation implementationScopeDigest is invalid');
  }
  if (
    !Number.isSafeInteger(context.ownershipEpoch) ||
    context.ownershipEpoch < 0
  ) {
    throw new Error('claim validation ownershipEpoch must be non-negative');
  }
  if (typeof context.codeRefHead !== 'string' || !context.codeRefHead.trim()) {
    throw new Error('claim validation codeRefHead is required');
  }
  if (
    context.transportFreshness !== 'fresh' &&
    context.transportFreshness !== 'stale' &&
    context.transportFreshness !== 'unknown' &&
    context.transportFreshness !== 'unavailable'
  ) {
    throw new Error('claim validation transportFreshness is invalid');
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

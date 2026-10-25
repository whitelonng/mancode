import type { UnattendedWaiverPolicy } from '../team/policy.js';
import type { Ulid } from './ids.js';
import { parseManDeliveryPlan } from './man-delivery-plan.js';
import { assertSharedTextSafe } from './privacy.js';
import type { RequirementsLedgerV1 } from './requirements-ledger.js';
import type { StoredTaskSnapshot } from './store.js';
import {
  type PlanApprovalRecord,
  type PlanApprovalSource,
  type PlanPresentationRecord,
  type WorkflowMetadataV3,
  isPlanGated,
} from './workflow-metadata.js';

/**
 * Planning policy 4 plan gate: a plan must be presented in full before it can
 * be approved, and the approval is bound to the exact plan/scope/requirements
 * it was given for. The CLI cannot prove that the operator wrote the reply; the
 * gate leaves an auditable record and removes the one-call self-approval paths.
 */
export const PLAN_OPERATOR_REPLY_MAX_LENGTH = 2000;
export const PLAN_PRESENT_INSTRUCTION =
  'Show this plan to the operator and wait for their reply before running plan confirm.';

export type PlanApprovalDecision = PlanApprovalRecord['decision'];

export interface PlanApprovalInput {
  operatorReply?: string;
  unattendedWaiver?: boolean;
}

export interface PlanPresentationSummary {
  planVersion: number;
  planFile: string | null;
  goal: string;
  scope: { include: string[]; exclude: string[]; modules: string[] };
  acceptanceCriteria: Array<{
    id: string;
    statement: string;
    required: boolean;
  }>;
}

export function planGateTupleOf(
  metadata: WorkflowMetadataV3,
  planDigest: string,
): Omit<
  PlanPresentationRecord,
  'presentedAt' | 'actorId' | 'sessionId' | 'operationId'
> {
  return {
    planVersion: metadata.governance.planVersion,
    planDigest,
    scopeDigest: metadata.implementationScope.digest,
    requirementsDigest: metadata.governance.requirementsDigest,
  };
}

export function planPresentationMatches(
  presentation: PlanPresentationRecord,
  metadata: WorkflowMetadataV3,
  planDigest: string | null,
): boolean {
  if (planDigest === null) return false;
  const tuple = planGateTupleOf(metadata, planDigest);
  return (
    presentation.planVersion === tuple.planVersion &&
    presentation.planDigest === tuple.planDigest &&
    presentation.scopeDigest === tuple.scopeDigest &&
    presentation.requirementsDigest === tuple.requirementsDigest
  );
}

/** A presentation that already backed an approval cannot back a second one. */
export function planPresentationConsumed(
  metadata: WorkflowMetadataV3,
  presentation: PlanPresentationRecord,
): boolean {
  return (
    metadata.governance.planApproval?.presentationOperationId ===
    presentation.operationId
  );
}

export function buildPlanPresentationSummary(
  task: Pick<StoredTaskSnapshot, 'metadata' | 'requirements' | 'plan'>,
): PlanPresentationSummary {
  const { metadata, requirements, plan } = task;
  let planFile: string | null = null;
  if (plan !== null) {
    try {
      planFile = parseManDeliveryPlan(plan.content)?.source.path ?? null;
    } catch {
      planFile = null;
    }
    planFile ??= `.mancode/${metadata.taskRef.namespace}/workflows/${metadata.taskRef.taskId}/plan.md`;
  }
  return {
    planVersion: metadata.governance.planVersion,
    planFile,
    goal: requirements.goal,
    scope: {
      include: metadata.implementationScope.include,
      exclude: metadata.implementationScope.exclude,
      modules: metadata.implementationScope.modules,
    },
    acceptanceCriteria: requirements.acceptanceCriteria.map((item) => ({
      id: item.displayId,
      statement: item.statement,
      required: item.required,
    })),
  };
}

/** Rejects approval inputs where no plan decision is being recorded. */
export function assertPlanApprovalInputAbsent(
  metadata: WorkflowMetadataV3,
  input: PlanApprovalInput,
): void {
  if (input.operatorReply === undefined && input.unattendedWaiver !== true) {
    return;
  }
  if (isPlanGated(metadata)) {
    throw new Error(
      'MANCODE_PLAN_APPROVAL_INPUT_UNEXPECTED: --operator-reply and --unattended-waiver apply only when confirming a presented plan',
    );
  }
  throw new Error(
    `MANCODE_PLAN_GATE_NOT_ENABLED: planning policy ${String(metadata.governance.policyVersions.planning)} tasks confirm without --operator-reply or --unattended-waiver`,
  );
}

export function assertPlanGatePolicy(metadata: WorkflowMetadataV3): void {
  if (!isPlanGated(metadata)) {
    throw new Error(
      `MANCODE_PLAN_GATE_NOT_ENABLED: planning policy ${String(metadata.governance.policyVersions.planning)} tasks have no plan presentation step; use plan confirm directly`,
    );
  }
}

/** Case, whitespace and trailing punctuation never make a copied text "new". */
export function normalizeReplyText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?,;:\u3002\uff01\uff1f\uff0c\uff1b\uff1a]+$/u, '')
    .trim();
}

/** Only human-authored task text; never enums, ids or digests. */
function recordedTexts(input: {
  requirements: RequirementsLedgerV1;
  decisionTexts: string[];
}): Set<string> {
  const { requirements } = input;
  const texts = [
    requirements.goal,
    ...requirements.functionalScope.inScope,
    ...requirements.functionalScope.outOfScope,
    ...requirements.requirements.map((item) => item.statement),
    ...requirements.acceptanceCriteria.map((item) => item.statement),
    ...requirements.technicalDecisions.map((item) => item.statement),
    ...requirements.defaults.map((item) => item.statement),
    ...input.decisionTexts,
  ];
  return new Set(texts.map(normalizeReplyText));
}

export interface ResolvePlanApprovalInput {
  metadata: WorkflowMetadataV3;
  requirements: RequirementsLedgerV1;
  planDigest: string | null;
  decision: PlanApprovalDecision;
  approval: PlanApprovalInput;
  decisionTexts: string[];
  /** Project config `unattendedWaiver`; undefined applies the task-kind default. */
  unattendedWaiverPolicy?: UnattendedWaiverPolicy;
  actorId: Ulid;
  sessionId: Ulid;
  confirmedAt: string;
}

/**
 * Verifies the present record and the operator-reply / waiver input for a
 * planning policy 4 approval and returns the record to persist.
 */
export function resolvePlanApproval(
  input: ResolvePlanApprovalInput,
): PlanApprovalRecord {
  const { metadata, approval } = input;
  const presentation = metadata.governance.planPresentation;
  if (presentation === undefined) {
    throw new Error(
      'MANCODE_PLAN_PRESENTATION_REQUIRED: run workflow plan present, show the plan to the operator, and wait for their reply before confirming',
    );
  }
  if (!planPresentationMatches(presentation, metadata, input.planDigest)) {
    throw new Error(
      'MANCODE_PLAN_PRESENTATION_STALE: the plan, scope or requirements changed after the last present; run workflow plan present again',
    );
  }
  if (planPresentationConsumed(metadata, presentation)) {
    throw new Error(
      'MANCODE_PLAN_PRESENTATION_CONSUMED: the last present already backed an approval; run workflow plan present again and wait for a new operator reply',
    );
  }
  const waiver = approval.unattendedWaiver === true;
  if (waiver && approval.operatorReply !== undefined) {
    throw new Error(
      'MANCODE_PLAN_APPROVAL_INPUT_CONFLICT: use either --operator-reply or --unattended-waiver, not both',
    );
  }
  let source: PlanApprovalSource;
  let operatorReply: string | undefined;
  if (waiver) {
    assertUnattendedWaiverAllowed(metadata, input.unattendedWaiverPolicy);
    source = 'unattended_waiver';
  } else {
    operatorReply = parseOperatorReply(approval.operatorReply);
    if (metadata.visibility === 'shared') {
      assertSharedTextSafe(operatorReply, 'operatorReply');
    }
    const known = recordedTexts(input);
    if (known.has(normalizeReplyText(operatorReply))) {
      throw new Error(
        "MANCODE_PLAN_OPERATOR_REPLY_REUSED: the reply repeats text already recorded for this task (goal, scope, acceptance or decisions); pass the operator's actual reply to the presented plan",
      );
    }
    source = 'operator_reply';
  }
  return {
    approvalSource: source,
    ...(operatorReply === undefined ? {} : { operatorReply }),
    decision: input.decision,
    planVersion: presentation.planVersion,
    planDigest: presentation.planDigest,
    scopeDigest: presentation.scopeDigest,
    requirementsDigest: presentation.requirementsDigest,
    presentedAt: presentation.presentedAt,
    presentationOperationId: presentation.operationId,
    confirmedAt: input.confirmedAt,
    actorId: input.actorId,
    sessionId: input.sessionId,
  };
}

export const UNATTENDED_WAIVER_GUIDANCE =
  'Use it only when this session genuinely has no operator present (for example a headless or CI run), never in place of asking an available operator, and never by inventing an operator reply.';

function assertUnattendedWaiverAllowed(
  metadata: WorkflowMetadataV3,
  configured: UnattendedWaiverPolicy | undefined,
): void {
  const localSingle =
    metadata.visibility === 'local' && metadata.coordination === 'single';
  const effective = configured ?? (localSingle ? 'allowed' : 'forbidden');
  if (effective === 'forbidden') {
    throw new Error(
      `MANCODE_UNATTENDED_WAIVER_FORBIDDEN: the project ${configured === undefined ? 'forbids unattended waivers for shared and team tasks by default' : 'config sets unattendedWaiver to forbidden'}; ask the operator to review the presented plan and pass their reply with --operator-reply`,
    );
  }
}

function parseOperatorReply(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      'MANCODE_PLAN_OPERATOR_REPLY_REQUIRED: pass --operator-reply "<the operator reply to the presented plan>" (or --unattended-waiver only when this session has no operator at all, such as a headless or CI run)',
    );
  }
  const reply = value.trim();
  if (normalizeReplyText(reply) === '') {
    throw new Error(
      'MANCODE_PLAN_OPERATOR_REPLY_REQUIRED: the reply must contain more than punctuation',
    );
  }
  if (reply.length > PLAN_OPERATOR_REPLY_MAX_LENGTH || reply.includes('\0')) {
    throw new Error(
      `MANCODE_PLAN_OPERATOR_REPLY_INVALID: the reply must be at most ${PLAN_OPERATOR_REPLY_MAX_LENGTH} characters without NUL`,
    );
  }
  return reply;
}

export function decisionTextsOf(
  decisions: ReadonlyArray<{ title: string; statement: string }>,
): string[] {
  return decisions.flatMap((item) => [item.title, item.statement]);
}

/** Compact audit view of the approval; absent for tasks below planning policy 4. */
export function planApprovalSummary(metadata: WorkflowMetadataV3):
  | {
      approvalSource: PlanApprovalSource;
      decision: PlanApprovalDecision;
      planVersion: number;
      presentedAt: string;
      confirmedAt: string;
    }
  | undefined {
  const approval = metadata.governance.planApproval;
  if (approval === undefined) return undefined;
  return {
    approvalSource: approval.approvalSource,
    decision: approval.decision,
    planVersion: approval.planVersion,
    presentedAt: approval.presentedAt,
    confirmedAt: approval.confirmedAt,
  };
}

const APPROVAL_WARNING_TEXT = {
  UNATTENDED_WAIVER:
    'this plan was approved without an operator reply; confirm with the operator before relying on it',
  PLAN_APPROVAL_SCOPE_CHANGED:
    'the implementation scope changed after this plan was approved; the approval covers the earlier scope',
} as const;

/** Warning codes shown wherever the approval is surfaced. */
export function planApprovalWarningCodes(
  metadata: WorkflowMetadataV3,
): Array<keyof typeof APPROVAL_WARNING_TEXT> {
  const approval = metadata.governance.planApproval;
  if (approval === undefined) return [];
  return [
    ...(approval.approvalSource === 'unattended_waiver'
      ? (['UNATTENDED_WAIVER'] as const)
      : []),
    ...(approval.scopeDigest !== metadata.implementationScope.digest
      ? (['PLAN_APPROVAL_SCOPE_CHANGED'] as const)
      : []),
  ];
}

export function planApprovalWarnings(metadata: WorkflowMetadataV3): string[] {
  return planApprovalWarningCodes(metadata).map(
    (code) => `${code}: ${APPROVAL_WARNING_TEXT[code]}`,
  );
}

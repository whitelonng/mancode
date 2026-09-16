import path from 'node:path';
import { executionCommandDigest } from '../runtime/execution-runner.js';
import type { OpenedV3TaskOperation } from '../runtime/task-operation.js';
import { packagedVitestReporterPath } from '../system/tdd-evidence.js';
import { digestCanonicalJson } from './canonical.js';
import { type ExecutionAction, reduceExecution } from './execution-ledger.js';
import { createUlid } from './ids.js';
import type { ManEvidenceSubject } from './man-delivery-evidence.js';
import {
  type VerificationComponentEvidence,
  type VerificationLedgerV2,
  deriveVerificationLedgerStatus,
  verificationLedgerDigest,
} from './verification-ledger.js';
import {
  type RecordV3VerificationInput,
  recordV3Execution,
} from './verification-record.js';
import {
  assertSoloHandoffSession,
  isActiveSoloHandoff,
} from './workflow-metadata.js';

export type MutateV3ExecutionInput = Omit<
  RecordV3VerificationInput,
  'verification'
> & { action: ExecutionAction };
export function mutateV3Execution(input: MutateV3ExecutionInput) {
  return recordV3Execution(input);
}

/** Reused before cancellation: authority must be checked before touching processes. */
export function assertExecutionActionAuthority(
  context: OpenedV3TaskOperation,
  action?: ExecutionAction,
): void {
  if (
    context.task.verification.schemaVersion !== 2 ||
    context.task.metadata.governance.policyVersions.verification !== 2
  )
    throw new Error('MANCODE_EXECUTION_POLICY_REQUIRED');
  assertSoloHandoffSession(context.task.metadata, context.session);
  if (
    action &&
    ['run.reserve', 'attempt.reserve'].includes(action.type) &&
    context.task.metadata.status === 'blocked'
  )
    throw new Error('MANCODE_EXECUTION_TASK_BLOCKED');
  if (
    action &&
    [
      'budget.extend',
      'contract.revise',
      'exception.decide',
      'problem.merge',
      'run.reconcile',
    ].includes(action.type) &&
    context.task.metadata.ownerActorId !== context.session.actorId
  )
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  if (
    !isActiveSoloHandoff(context.task.metadata) &&
    context.task.metadata.ownerActorId !== context.session.actorId
  )
    throw new Error('MANCODE_TASK_OWNER_REQUIRED');
  if (
    context.task.metadata.status !== 'in_progress' &&
    context.task.metadata.status !== 'blocked'
  )
    throw new Error('MANCODE_EXECUTION_TASK_NOT_ACTIVE');
  if (
    !isActiveSoloHandoff(context.task.metadata) &&
    (context.task.metadata.governance.planDecision !== 'governed_execution' ||
      context.task.metadata.currentStep < 5)
  )
    throw new Error('MANCODE_EXECUTION_PLAN_REQUIRED');
}

export function buildExecutionVerification(
  context: OpenedV3TaskOperation,
  action: ExecutionAction,
  subject: ManEvidenceSubject,
): VerificationLedgerV2 {
  assertExecutionActionAuthority(context, action);
  const previous = context.task.verification;
  if (previous.schemaVersion !== 2)
    throw new Error('MANCODE_EXECUTION_POLICY_REQUIRED');
  if (
    action.type === 'run.reserve' &&
    action.runnerArgv !== undefined &&
    digestCanonicalJson(action.runnerArgv) !== digestCanonicalJson(action.argv)
  ) {
    if (
      !['tdd_red', 'tdd_green', 'regression_replay'].includes(action.purpose) ||
      digestCanonicalJson(action.runnerArgv) !==
        digestCanonicalJson([
          ...action.argv,
          '--reporter',
          packagedVitestReporterPath(),
        ])
    )
      throw new Error('MANCODE_EXECUTION_RUNNER_ARGV_INVALID');
  }
  if (action.type === 'run.start' || action.type === 'run.finish') {
    const run = previous.execution.runs.find(
      (item) => item.runId === action.runId,
    );
    const identity =
      action.type === 'run.start' ? action.identity : action.result.identity;
    if (
      run &&
      identity &&
      (identity.commandDigest !==
        executionCommandDigest(
          path.resolve(context.projectRoot, run.cwd),
          run.runnerArgv,
          run.timeoutMs,
        ) ||
        run.checkoutId !== context.runtime.checkoutId)
    )
      throw new Error('MANCODE_EXECUTION_COMMAND_IDENTITY_MISMATCH');
  }
  const authority = {
    actorId: context.session.actorId,
    checkoutId: context.runtime.checkoutId,
    requirementsDigest: context.task.requirements.contentDigest,
    planVersion: context.task.metadata.governance.planVersion,
    subject,
    now: context.now.toISOString(),
  };
  const execution = reduceExecution(previous.execution, action, authority);
  const empty = (): VerificationComponentEvidence => ({
    evidenceId: createUlid(),
    status: 'pending',
    summary: null,
    command: null,
    exitCode: null,
    artifactRef: null,
    confirmedByActorId: null,
    confirmationSource: null,
    updatedAt: null,
  });
  const fresh = (slot: VerificationComponentEvidence | null | undefined) =>
    slot?.subject?.contentDigest === subject.contentDigest &&
    slot.subject.environment === subject.environment &&
    previous.requirementsDigest === authority.requirementsDigest &&
    previous.planVersion === authority.planVersion &&
    previous.remediationRound === context.task.review.remediationRound
      ? slot
      : empty();
  const checks = context.task.requirements.acceptanceCriteria.map(
    (criterion) => {
      const old = previous.checks.find(
        (item) => item.criterionId === criterion.criterionId,
      );
      return {
        displayId: criterion.displayId,
        legacyId: criterion.legacyId,
        checkId: old?.checkId ?? createUlid(),
        criterionId: criterion.criterionId,
        required: criterion.required,
        verificationRequirement: criterion.verificationRequirement,
        automated:
          criterion.verificationRequirement === 'manual'
            ? null
            : fresh(old?.automated),
        manual:
          criterion.verificationRequirement === 'automated'
            ? null
            : fresh(old?.manual),
      };
    },
  );
  if (action.type === 'contract.revise')
    for (const check of checks) {
      if (check.automated) check.automated = empty();
      if (check.manual) check.manual = empty();
    }
  if (action.type === 'run.finish') {
    const run = execution.runs.find((item) => item.runId === action.runId);
    if (
      run?.applicable &&
      (run.purpose === 'verification' || run.purpose === 'tdd_green')
    ) {
      const definition = execution.policy.checks.find(
        (item) => item.id === run.checkId,
      );
      if (!definition) throw new Error('MANCODE_EXECUTION_CHECK_UNKNOWN');
      for (const check of checks.filter((item) =>
        definition?.acceptanceIds.includes(item.displayId),
      )) {
        if (check.automated === null)
          throw new Error('MANCODE_EXECUTION_AUTOMATED_SLOT_REQUIRED');
        const surface = context.task.requirements.acceptanceCriteria.find(
          (item) => item.criterionId === check.criterionId,
        )?.verificationSurfaces?.automated;
        if (surface !== definition?.surface)
          throw new Error('MANCODE_EXECUTION_SURFACE_MISMATCH');
        const passed = run.state === 'succeeded';
        check.automated = {
          ...empty(),
          status: passed
            ? 'passed'
            : run.state === 'failed' &&
                run.result?.exitCode !== null &&
                run.result?.exitCode !== 0
              ? 'failed'
              : 'blocked',
          subject,
          surface: definition.surface,
          command: JSON.stringify(run.argv),
          exitCode: passed ? 0 : (run.result?.exitCode ?? null),
          summary: run.result?.summary ?? `Run ${run.runId}: ${run.state}`,
          artifactRef: run.result?.outputArtifactRef ?? null,
          updatedAt: authority.now,
        };
      }
    }
  }
  if (action.type === 'manual.confirm') {
    if (
      action.confirmed !== true ||
      !action.acceptanceIds.length ||
      !action.summary.trim()
    )
      throw new Error('MANCODE_EXECUTION_MANUAL_CONFIRMATION_REQUIRED');
    for (const acceptanceId of action.acceptanceIds) {
      const check = checks.find((item) => item.displayId === acceptanceId);
      const criterion = context.task.requirements.acceptanceCriteria.find(
        (item) => item.displayId === acceptanceId,
      );
      if (
        !check?.manual ||
        criterion?.verificationSurfaces?.manual !== action.surface
      )
        throw new Error('MANCODE_EXECUTION_MANUAL_SURFACE_MISMATCH');
      check.manual = {
        ...empty(),
        status: 'passed',
        subject,
        surface: action.surface,
        summary: action.summary,
        confirmedByActorId: context.session.actorId,
        confirmationSource: 'actor',
        updatedAt: authority.now,
      };
    }
  }
  const draft: VerificationLedgerV2 = {
    ...previous,
    requirementsDigest: authority.requirementsDigest,
    planVersion: authority.planVersion,
    remediationRound: context.task.review.remediationRound,
    execution,
    checks,
    status: 'pending',
  };
  draft.status = deriveVerificationLedgerStatus(draft);
  draft.contentDigest = verificationLedgerDigest(draft);
  return draft;
}

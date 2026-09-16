import { assertCiObserverInvocation } from '../system/ci-observer.js';
import { digestCanonicalJson } from './canonical.js';
import {
  type ExecutionRun,
  type ExecutionScenario,
  canonicalProblem,
  executionBudget,
} from './execution-ledger.js';
import type { ManEvidenceSubject } from './man-delivery-evidence.js';
import type { RequirementsLedgerV1 } from './requirements-ledger.js';
import type { VerificationLedger } from './verification-ledger.js';
import type { WorkflowMetadataV3 } from './workflow-metadata.js';

export interface ExecutionGateBlocker {
  code: string;
  reference: string | null;
  missingEvidence: string;
  nextAction: string;
  allowedActions: string[];
}
export interface ExecutionGateResult {
  status: 'passed' | 'passed_with_exceptions' | 'incomplete';
  blockers: ExecutionGateBlocker[];
  exceptions: string[];
}
export interface ExecutionGateInput {
  verification: VerificationLedger;
  requirements: RequirementsLedgerV1;
  metadata: WorkflowMetadataV3;
  currentSubject: ManEvidenceSubject;
  candidateSha?: string;
  now?: Date;
}
function same(left: unknown, right: unknown) {
  return digestCanonicalJson(left) === digestCanonicalJson(right);
}
function validTargets(
  run: ExecutionRun,
  scenario: ExecutionScenario,
  red: boolean,
) {
  const assessment = run.vitest;
  if (
    !assessment ||
    assessment.collectionErrors !== 0 ||
    assessment.unhandledErrors !== 0 ||
    assessment.targets.length !== scenario.targets.length ||
    assessment.targets.length === 0
  )
    return false;
  if (assessment.assessment !== (red ? 'assertion_failure' : 'passed'))
    return false;
  if (
    scenario.targets.some(
      (target) =>
        !assessment.targets.some(
          (actual) =>
            actual.file === target.file && actual.name === target.name,
        ),
    )
  )
    return false;
  if (!red)
    return assessment.targets.every((target) => target.status === 'passed');
  return (
    assessment.targets.some((target) => target.status === 'failed') &&
    assessment.targets.every(
      (target) =>
        target.status === 'passed' ||
        (target.status === 'failed' &&
          target.errorNames.length > 0 &&
          target.errorNames.every((name) => name === 'AssertionError')),
    )
  );
}

/** Pure evidence decision, shared by inspection and every V2 completion path. */
export function evaluateExecutionGate(
  input: ExecutionGateInput,
): ExecutionGateResult {
  const { verification, metadata, requirements, currentSubject } = input;
  if (verification.schemaVersion !== 2)
    return { status: 'passed', blockers: [], exceptions: [] };
  const state = verification.execution;
  const blockers: ExecutionGateBlocker[] = [];
  const exceptions: string[] = [];
  const block = (
    code: string,
    reference: string | null,
    missingEvidence: string,
    nextAction: string,
  ) =>
    blockers.push({
      code,
      reference,
      missingEvidence,
      nextAction,
      allowedActions: [
        'inspect',
        'cancel',
        'recover',
        'approved_decision',
        'abandon',
      ],
    });
  const current = (run: ExecutionRun) =>
    run.applicable &&
    run.requirementsDigest === requirements.contentDigest &&
    run.planVersion === metadata.governance.planVersion &&
    run.policyDigest === state.policyDigest &&
    same(run.subject, currentSubject);
  if (metadata.governance.policyVersions.verification !== 2)
    block(
      'MANCODE_EXECUTION_POLICY_LEDGER_MISMATCH',
      null,
      'Matching task verification policy',
      'Use a compatible reader; do not rewrite policy.',
    );
  for (const run of state.runs) {
    const reconciled = state.decisions.findLast(
      (item) => item.kind === 'run_reconciliation' && item.runId === run.runId,
    );
    if (run.state === 'interrupted' && reconciled) {
      exceptions.push(reconciled.decisionId);
      continue;
    }
    if (
      run.state === 'reserved' ||
      run.state === 'running' ||
      run.state === 'interrupted'
    )
      block(
        'MANCODE_RUN_INTERRUPTED',
        run.runId,
        'Settled, cleaned execution',
        'Inspect the original receipt and recover without rerunning the command.',
      );
  }
  for (const check of state.policy.checks) {
    if (
      check.acceptanceIds.some(
        (id) =>
          !requirements.acceptanceCriteria.some(
            (criterion) => criterion.displayId === id,
          ),
      )
    )
      block(
        'MANCODE_EXECUTION_CHECK_CONTRACT_MISMATCH',
        check.id,
        'A current acceptance mapping',
        'Approve the corrected check contract.',
      );
    const latest = state.runs.findLast(
      (run) =>
        run.checkId === check.id &&
        (run.purpose === 'verification' || run.purpose === 'tdd_green'),
    );
    if (!latest || latest.state !== 'succeeded' || !current(latest))
      block(
        'MANCODE_REQUIRED_CHECK_FAILED',
        check.id,
        'Latest current successful approved check',
        'Run the required check against the current subject.',
      );
  }
  for (const criterion of requirements.acceptanceCriteria.filter(
    (item) => item.required && item.verificationRequirement !== 'manual',
  )) {
    if (
      !state.policy.checks.some((check) =>
        check.acceptanceIds.includes(criterion.displayId),
      )
    )
      block(
        'MANCODE_EXECUTION_CHECK_CONTRACT_MISMATCH',
        criterion.displayId,
        'Approved executable check',
        'Approve a check for the required automated criterion.',
      );
  }
  const now = input.now?.getTime() ?? Date.now();
  for (const scenario of state.policy.scenarios) {
    const exception = state.decisions.findLast(
      (decision) =>
        decision.kind === 'scenario_exception' &&
        decision.scenarioId === scenario.id &&
        decision.requirementsDigest === requirements.contentDigest &&
        decision.policyDigest === state.policyDigest &&
        (decision.expiresAt === null || Date.parse(decision.expiresAt) > now),
    );
    if (exception) {
      exceptions.push(exception.decisionId);
      continue;
    }
    if (scenario.mode !== 'required') continue;
    const green = state.runs.findLast(
      (run) => run.scenarioId === scenario.id && run.purpose === 'tdd_green',
    );
    const red =
      green &&
      state.runs
        .slice(0, state.runs.indexOf(green))
        .findLast(
          (run) => run.scenarioId === scenario.id && run.purpose === 'tdd_red',
        );
    if (
      !red ||
      !green ||
      !red.result ||
      !green.result ||
      red.state !== 'failed' ||
      green.state !== 'succeeded' ||
      !red.result.started ||
      red.result.exitCode === 0 ||
      red.result.signal !== null ||
      red.result.outputTruncated ||
      !red.result.cleanupConfirmed ||
      !validTargets(red, scenario, true) ||
      !validTargets(green, scenario, false)
    ) {
      block(
        'MANCODE_TDD_EVIDENCE_MISSING',
        scenario.id,
        'A real target assertion Red followed by Green',
        'Capture the target failure and corresponding successful test; replay is not historical test-first.',
      );
      continue;
    }
    if (
      !current(green) ||
      red.requirementsDigest !== green.requirementsDigest ||
      red.planVersion !== green.planVersion ||
      red.policyDigest !== green.policyDigest ||
      red.testIdentity !== green.testIdentity ||
      red.configurationIdentity !== green.configurationIdentity ||
      red.subject.contentDigest === green.subject.contentDigest ||
      Date.parse(red.result.finishedAt) > Date.parse(green.reservedAt)
    )
      block(
        'MANCODE_TDD_PAIR_STALE',
        scenario.id,
        'Current Green with unchanged test/configuration and ordered implementation change',
        'Re-establish the scenario pair or record an approved alternative.',
      );
  }
  const problems = new Set(
    state.attempts.map((attempt) => canonicalProblem(state, attempt.problemId)),
  );
  for (const problemId of problems) {
    const attempts = state.attempts.filter(
      (attempt) =>
        canonicalProblem(state, attempt.problemId) === problemId &&
        attempt.state !== 'cancelled',
    );
    if (
      attempts.some(
        (attempt) =>
          attempt.state === 'reserved' || attempt.state === 'interrupted',
      ) ||
      attempts.at(-1)?.state === 'failed'
    )
      block(
        'MANCODE_REPAIR_UNRESOLVED',
        problemId,
        'A resolved repair with current verification',
        'Diagnose within remaining budget, recover the attempt or obtain an explicit extension.',
      );
  }
  if (state.policy.delivery === 'remote_required') {
    const latest = state.ciObservations.at(-1);
    let valid =
      latest !== undefined &&
      latest.policyDigest === state.policyDigest &&
      latest.target.candidateSha === input.candidateSha &&
      latest.observation.candidateSha === input.candidateSha &&
      latest.observation.status === 'passed' &&
      latest.observation.repository === state.policy.ci?.repository &&
      latest.observation.event === state.policy.ci.event &&
      latest.target.testedBinding === 'approved_workflow_head' &&
      latest.observation.event === 'push' &&
      latest.target.testedSha === input.candidateSha &&
      latest.observation.testedSha === input.candidateSha;
    if (valid && latest && state.policy.ci) {
      const run = state.runs.find((item) => item.runId === latest.runId);
      valid =
        run !== undefined &&
        run.purpose === 'ci_observation' &&
        current(run) &&
        run.state === 'succeeded' &&
        latest.observation.runs.length === state.policy.ci.workflows.length;
      if (valid && run) {
        try {
          assertCiObserverInvocation(run, latest.target);
        } catch {
          valid = false;
        }
      }
      for (const workflow of state.policy.ci.workflows) {
        const matches = latest.observation.runs.filter(
          (run) =>
            run.workflowId === workflow.id &&
            run.workflowPath === workflow.path &&
            run.configurationSha === workflow.configurationSha &&
            run.headSha === input.candidateSha,
        );
        const observed = matches[0];
        if (
          matches.length !== 1 ||
          !observed ||
          observed.status !== 'completed' ||
          observed.conclusion !== 'success' ||
          workflow.requiredJobs.some(
            (name) =>
              observed.jobs.filter(
                (job) =>
                  job.name === name &&
                  job.status === 'completed' &&
                  job.conclusion === 'success',
              ).length !== 1,
          )
        )
          valid = false;
      }
    }
    if (!valid)
      block(
        'MANCODE_CI_UNVERIFIED',
        latest?.observationId ?? null,
        'Exact candidate and trusted complete required CI set',
        'Observe the current candidate without triggering remote execution.',
      );
  }
  // Exhaustion restricts new work, never a fully verified last legal success.
  const budget = executionBudget(state);
  if (
    blockers.length &&
    (budget.runs >= budget.maxRuns ||
      budget.executionMs >= budget.maxExecutionMs ||
      (blockers.some((item) => item.code === 'MANCODE_REPAIR_UNRESOLVED') &&
        budget.repairAttempts >= budget.maxRepairAttempts))
  )
    block(
      'MANCODE_EXECUTION_BUDGET_EXHAUSTED',
      null,
      'Allowance for outstanding execution',
      'Recover existing results or record an approved additive extension.',
    );
  return {
    status: blockers.length
      ? 'incomplete'
      : exceptions.length
        ? 'passed_with_exceptions'
        : 'passed',
    blockers,
    exceptions,
  };
}

import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { evaluateExecutionGate } from '../src/context/execution-gate.js';
import {
  type ExecutionAuthority,
  type ExecutionPolicy,
  type ExecutionState,
  initialExecutionState,
  reduceExecution,
} from '../src/context/execution-ledger.js';
import { createUlid } from '../src/context/ids.js';
import type { RequirementsLedgerV1 } from '../src/context/requirements-ledger.js';
import type { VerificationLedgerV2 } from '../src/context/verification-ledger.js';
import type { WorkflowMetadataV3 } from '../src/context/workflow-metadata.js';
import { buildCiObserverArgv } from '../src/system/ci-observer.js';

const digest = digestCanonicalJson('gate fixture');
const subject = { contentDigest: digest, environment: 'fixture' };
const authority: ExecutionAuthority = {
  actorId: createUlid(),
  checkoutId: 'fixture',
  requirementsDigest: digest,
  planVersion: 1,
  subject,
  now: '2026-09-16T00:00:00.000Z',
};
const policy: ExecutionPolicy = {
  version: 1,
  budget: {
    maxRuns: 1,
    maxExecutionMs: 1000,
    maxRepairAttempts: 0,
    commandTimeoutMs: 1000,
    ciTimeoutMs: 1000,
  },
  checks: [
    {
      id: 'unit',
      acceptanceIds: ['AC-1'],
      argv: ['node', 'test.js'],
      cwd: '.',
      surface: 'component',
    },
  ],
  scenarios: [],
  delivery: 'local',
  ci: null,
};
// The pure evaluator only consumes these fields; complete schema round-trips are tested by execution-mutation.
const requirements = {
  contentDigest: digest,
  acceptanceCriteria: [
    { displayId: 'AC-1', required: true, verificationRequirement: 'automated' },
  ],
} as RequirementsLedgerV1;
const metadata = {
  governance: { planVersion: 1, policyVersions: { verification: 2 } },
} as WorkflowMetadataV3;
function inspect(execution: ExecutionState, currentSubject = subject) {
  return evaluateExecutionGate({
    verification: { schemaVersion: 2, execution } as VerificationLedgerV2,
    requirements,
    metadata,
    currentSubject,
  });
}
function pass(initial: ExecutionState) {
  const runId = createUlid();
  const state = reduceExecution(
    initial,
    {
      type: 'run.reserve',
      runId,
      purpose: 'verification',
      checkId: 'unit',
      argv: ['node', 'test.js'],
      cwd: '.',
    },
    authority,
  );
  const identity = {
    protocolVersion: 1 as const,
    runId,
    executorId: createUlid(),
    commandDigest: digest,
    startedAt: authority.now,
    pid: 42,
    platform: 'fixture',
  };
  return reduceExecution(
    state,
    {
      type: 'run.finish',
      runId,
      result: {
        identity,
        status: 'succeeded',
        started: true,
        exitCode: 0,
        signal: null,
        reason: null,
        startedAt: authority.now,
        finishedAt: authority.now,
        durationMs: 1000,
        outputTruncated: false,
        cleanupConfirmed: true,
        outputArtifactRef: null,
        summary: 'passed',
      },
    },
    authority,
  );
}
describe('execution completion gate', () => {
  it('allows the final legal successful run even when run and elapsed budgets are exactly exhausted', () => {
    const state = pass(initialExecutionState(policy));
    expect(inspect(state).status).toBe('passed');
    expect(() =>
      reduceExecution(
        state,
        {
          type: 'run.reserve',
          purpose: 'verification',
          checkId: 'unit',
          argv: ['node', 'test.js'],
          cwd: '.',
        },
        authority,
      ),
    ).toThrow('BUDGET_EXHAUSTED');
    expect(
      inspect(state, {
        ...subject,
        contentDigest: digestCanonicalJson('edited'),
      }).status,
    ).toBe('incomplete');
  });
  it('fails closed for an unfinished command and never substitutes generic green checks for TDD', () => {
    const scenario = {
      id: 'S1',
      acceptanceId: 'AC-1',
      mode: 'required' as const,
      rationale: 'behavior change',
      alternativeCheckIds: [],
      testInputs: ['a.test.ts'],
      configInputs: [],
      targets: [{ file: 'a.test.ts', name: 'behavior' }],
    };
    const state = pass(
      initialExecutionState({ ...policy, scenarios: [scenario] }),
    );
    expect(inspect(state).blockers.map((b) => b.code)).toContain(
      'MANCODE_TDD_EVIDENCE_MISSING',
    );
    const approved = reduceExecution(
      state,
      {
        type: 'exception.decide',
        scenarioId: 'S1',
        approval: {
          confirmed: true,
          source: 'operator',
          reason: 'legacy code audited with alternative coverage',
          evidence: 'approved scope',
        },
      },
      authority,
    );
    expect(inspect(approved).status).toBe('passed_with_exceptions');
  });
  it('does not accept a prior SHA or an unobserved remote contract', () => {
    const state = pass(
      initialExecutionState({
        ...policy,
        delivery: 'remote_required',
        ci: {
          repository: 'acme/example',
          event: 'push',
          testedBinding: 'approved_workflow_head',
          workflows: [
            {
              id: 10,
              path: '.github/workflows/quality.yml',
              configurationSha: 'a'.repeat(40),
              requiredJobs: ['test'],
            },
          ],
        },
      }),
    );
    expect(inspect(state).blockers.map((b) => b.code)).toContain(
      'MANCODE_CI_UNVERIFIED',
    );
  });
  it('rejects historical CI records produced by a generic command while retaining legitimate observer evidence', () => {
    const sha = 'c'.repeat(40);
    const ci = {
      repository: 'acme/example',
      event: 'push' as const,
      testedBinding: 'approved_workflow_head' as const,
      workflows: [
        {
          id: 10,
          path: '.github/workflows/quality.yml',
          configurationSha: 'a'.repeat(40),
          requiredJobs: ['test'],
        },
      ],
    };
    const state = pass(
      initialExecutionState({ ...policy, delivery: 'remote_required', ci }),
    );
    const target = { ...ci, candidateSha: sha, testedSha: sha };
    const first = state.runs[0];
    if (!first) throw new Error('fixture run missing');
    const run = {
      ...structuredClone(first),
      runId: createUlid(),
      purpose: 'ci_observation' as const,
      checkId: null,
      argv: buildCiObserverArgv(target, 1000, 20),
      runnerArgv: buildCiObserverArgv(target, 1000, 20),
    };
    state.runs.push(run);
    state.ciObservations.push({
      observationId: createUlid(),
      runId: run.runId,
      policyDigest: state.policyDigest,
      targetDigest: digestCanonicalJson(target),
      target,
      observation: {
        provider: 'github',
        repository: ci.repository,
        candidateSha: sha,
        testedSha: sha,
        event: 'push',
        observedAt: authority.now,
        status: 'passed',
        reasons: [],
        runs: [
          {
            runId: 20,
            attempt: 1,
            workflowId: 10,
            workflowPath: ci.workflows[0]?.path ?? '',
            configurationSha: 'a'.repeat(40),
            headSha: sha,
            status: 'completed',
            conclusion: 'success',
            jobs: [
              {
                id: 30,
                name: 'test',
                status: 'completed',
                conclusion: 'success',
              },
            ],
          },
        ],
      },
    });
    const evaluate = () =>
      evaluateExecutionGate({
        verification: {
          schemaVersion: 2,
          execution: state,
        } as VerificationLedgerV2,
        requirements,
        metadata,
        currentSubject: subject,
        candidateSha: sha,
      });
    expect(evaluate().status).toBe('passed');
    run.argv = ['node', '-e', 'console.log("passed")', JSON.stringify(target)];
    run.runnerArgv = run.argv;
    expect(evaluate().blockers.map((item) => item.code)).toContain(
      'MANCODE_CI_UNVERIFIED',
    );
    expect(state.ciObservations).toHaveLength(1);
  });
  it('accepts an ordered assertion Red/Green with stable tests and rejects changed test identity', () => {
    const scenario = {
      id: 'S1',
      acceptanceId: 'AC-1',
      mode: 'required' as const,
      rationale: 'behavior',
      alternativeCheckIds: [],
      testInputs: ['a.test.ts'],
      configInputs: [],
      targets: [{ file: 'a.test.ts', name: 'behavior' }],
    };
    let state = initialExecutionState({
      ...policy,
      budget: { ...policy.budget, maxRuns: 2, maxExecutionMs: 2000 },
      scenarios: [scenario],
    });
    for (const red of [true, false]) {
      const auth = {
        ...authority,
        subject: red
          ? { ...subject, contentDigest: digestCanonicalJson('broken') }
          : subject,
      };
      const runId = createUlid();
      state = reduceExecution(
        state,
        {
          type: 'run.reserve',
          runId,
          purpose: red ? 'tdd_red' : 'tdd_green',
          checkId: 'unit',
          scenarioId: 'S1',
          argv: ['node', 'test.js'],
          cwd: '.',
          testIdentity: digest,
          configurationIdentity: digest,
        },
        auth,
      );
      const identity = {
        protocolVersion: 1 as const,
        runId,
        executorId: createUlid(),
        commandDigest: digest,
        startedAt: authority.now,
        pid: 42,
        platform: 'fixture',
      };
      state = reduceExecution(
        state,
        {
          type: 'run.finish',
          runId,
          result: {
            identity,
            status: red ? 'failed' : 'succeeded',
            started: true,
            exitCode: red ? 1 : 0,
            signal: null,
            reason: null,
            startedAt: authority.now,
            finishedAt: authority.now,
            durationMs: 10,
            outputTruncated: false,
            cleanupConfirmed: true,
            outputArtifactRef: null,
            summary: 'target result',
          },
          vitest: {
            adapter: 'vitest',
            adapterVersion: 1,
            runId,
            executorId: identity.executorId,
            testIdentity: digest,
            configurationIdentity: digest,
            assessment: red ? 'assertion_failure' : 'passed',
            targets: [
              {
                file: 'a.test.ts',
                name: 'behavior',
                status: red ? 'failed' : 'passed',
                errorNames: red ? ['AssertionError'] : [],
              },
            ],
            collectionErrors: 0,
            unhandledErrors: 0,
            reasons: [],
          },
        },
        auth,
      );
    }
    expect(inspect(state).status).toBe('passed');
    const green = state.runs[1];
    if (!green) throw new Error('missing green');
    green.testIdentity = digestCanonicalJson('weakened test');
    expect(inspect(state).blockers.map((b) => b.code)).toContain(
      'MANCODE_TDD_PAIR_STALE',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  type ExecutionAuthority,
  type ExecutionPolicy,
  executionBudget,
  initialExecutionState,
  parseExecutionState,
  reduceExecution,
} from '../src/context/execution-ledger.js';
import { createUlid } from '../src/context/ids.js';

const digest = digestCanonicalJson('fixture');
const policy: ExecutionPolicy = {
  version: 1,
  budget: {
    maxRuns: 3,
    maxExecutionMs: 3000,
    maxRepairAttempts: 3,
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
const authority: ExecutionAuthority = {
  actorId: createUlid(),
  checkoutId: 'fixture',
  requirementsDigest: digest,
  planVersion: 1,
  subject: { contentDigest: digest, environment: 'fixture' },
  now: '2026-09-16T00:00:00.000Z',
};
const approval = {
  confirmed: true as const,
  source: 'operator request',
  reason: 'new evidence',
  evidence: 'trace',
};

describe('execution ledger authority', () => {
  it('reserves finite budget once per stable run ID and rejects changed intent', () => {
    const action = {
      type: 'run.reserve' as const,
      runId: createUlid(),
      purpose: 'verification' as const,
      checkId: 'unit',
      argv: ['node', 'test.js'],
      cwd: '.',
    };
    const state = reduceExecution(
      initialExecutionState(policy),
      action,
      authority,
    );
    expect(executionBudget(state)).toMatchObject({
      runs: 1,
      executionMs: 1000,
    });
    expect(reduceExecution(state, action, authority)).toBe(state);
    expect(() =>
      reduceExecution(
        state,
        { ...action, argv: ['node', 'wrong.js'] },
        authority,
      ),
    ).toThrow('RUN_ID_REUSED');
  });

  it('counts active reservations before permitting another run', () => {
    let state = initialExecutionState({
      ...policy,
      budget: { ...policy.budget, maxRuns: 1 },
    });
    state = reduceExecution(
      state,
      {
        type: 'run.reserve',
        purpose: 'diagnosis',
        argv: ['node', 'repro.js'],
        cwd: '.',
      },
      authority,
    );
    expect(() =>
      reduceExecution(
        state,
        {
          type: 'run.reserve',
          purpose: 'diagnosis',
          argv: ['node', 'repro.js'],
          cwd: '.',
        },
        authority,
      ),
    ).toThrow('BUDGET_EXHAUSTED');
  });

  it('retains failed repair consumption across sessions and explicitly extends without resetting', () => {
    let state = initialExecutionState(policy);
    for (let i = 0; i < 2; i++) {
      const attemptId = createUlid();
      state = reduceExecution(
        state,
        {
          type: 'attempt.reserve',
          attemptId,
          problemId: 'P1',
          classification: 'implementation',
          hypothesis: `hypothesis ${i}`,
          evidence: 'failing behavior',
        },
        authority,
      );
      state = reduceExecution(
        state,
        {
          type: 'attempt.finish',
          attemptId,
          state: 'failed',
          runIds: [],
          summary: 'hypothesis disproved',
        },
        authority,
      );
    }
    const reserve = {
      type: 'attempt.reserve' as const,
      problemId: 'P1',
      classification: 'implementation' as const,
      hypothesis: 'new evidence',
      evidence: 'trace',
    };
    expect(() =>
      reduceExecution(state, reserve, { ...authority, actorId: createUlid() }),
    ).toThrow('REPAIR_BUDGET_EXHAUSTED');
    state = reduceExecution(
      state,
      {
        type: 'budget.extend',
        problemId: 'P1',
        delta: {
          runs: 0,
          executionMs: 0,
          repairAttempts: 1,
          problemFailures: 1,
        },
        approval,
      },
      authority,
    );
    state = reduceExecution(state, reserve, authority);
    expect(state.attempts).toHaveLength(3);
    expect(
      state.attempts.slice(0, 2).every((attempt) => attempt.state === 'failed'),
    ).toBe(true);
  });

  it('rejects claimed approval, unknown schema fields and infinite execution budgets', () => {
    expect(() =>
      initialExecutionState({
        ...policy,
        budget: { ...policy.budget, commandTimeoutMs: 0 },
      }),
    ).toThrow();
    expect(() =>
      parseExecutionState({ ...initialExecutionState(policy), bypass: true }),
    ).toThrow();
    expect(() =>
      reduceExecution(
        initialExecutionState(policy),
        {
          type: 'budget.extend',
          delta: {
            runs: 1,
            executionMs: 0,
            repairAttempts: 0,
            problemFailures: 0,
          },
          approval: { ...approval, confirmed: false as true },
        },
        authority,
      ),
    ).toThrow('APPROVAL_REQUIRED');
  });

  it('merging problems preserves their spent failed attempts', () => {
    let state = initialExecutionState(policy);
    for (const problemId of ['old', 'other']) {
      const attemptId = createUlid();
      state = reduceExecution(
        state,
        {
          type: 'attempt.reserve',
          attemptId,
          problemId,
          classification: 'unknown',
          hypothesis: 'trace',
          evidence: 'observed',
        },
        authority,
      );
      state = reduceExecution(
        state,
        {
          type: 'attempt.finish',
          attemptId,
          state: 'failed',
          runIds: [],
          summary: 'not fixed',
        },
        authority,
      );
    }
    state = reduceExecution(
      state,
      {
        type: 'problem.merge',
        problemId: 'root',
        sourceProblemIds: ['old', 'other'],
        approval,
      },
      authority,
    );
    expect(() =>
      reduceExecution(
        state,
        {
          type: 'attempt.reserve',
          problemId: 'old',
          classification: 'unknown',
          hypothesis: 'retry',
          evidence: 'trace',
        },
        authority,
      ),
    ).toThrow('REPAIR_BUDGET_EXHAUSTED');
    expect(executionBudget(state).repairAttempts).toBe(2);
  });
  it('recovers an interrupted receipt in place and retains interruption history', () => {
    const runId = createUlid();
    let state = reduceExecution(
      initialExecutionState(policy),
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
      platform: 'test',
    };
    state = reduceExecution(
      state,
      { type: 'run.start', runId, identity },
      authority,
    );
    const result = {
      identity,
      status: 'interrupted' as const,
      started: true,
      exitCode: null,
      signal: null,
      reason: 'receipt_missing',
      startedAt: authority.now,
      finishedAt: authority.now,
      durationMs: 1000,
      outputTruncated: false,
      cleanupConfirmed: false,
      outputArtifactRef: null,
      summary: 'interrupted',
    };
    state = reduceExecution(
      state,
      { type: 'run.finish', runId, result },
      authority,
    );
    const recovered = {
      ...result,
      status: 'succeeded' as const,
      exitCode: 0,
      reason: null,
      durationMs: 50,
      cleanupConfirmed: true,
      summary: 'receipt recovered',
    };
    state = reduceExecution(
      state,
      { type: 'run.finish', runId, result: recovered },
      authority,
    );
    expect(state.runs[0]?.interruptions).toEqual([result]);
    expect(executionBudget(state)).toMatchObject({ runs: 1, executionMs: 50 });
    expect(
      reduceExecution(
        state,
        { type: 'run.finish', runId, result: recovered },
        authority,
      ),
    ).toBe(state);
    expect(() =>
      reduceExecution(
        state,
        {
          type: 'run.finish',
          runId,
          result: { ...recovered, exitCode: 1, status: 'failed' },
        },
        authority,
      ),
    ).toThrow('ALREADY_RECORDED');
  });
  it('requires diagnosed infrastructure evidence before granting the single retry', () => {
    let state = initialExecutionState(policy);
    const runId = createUlid();
    state = reduceExecution(
      state,
      {
        type: 'run.reserve',
        runId,
        purpose: 'diagnosis',
        argv: ['node', 'repro.js'],
        cwd: '.',
      },
      authority,
    );
    state = reduceExecution(
      state,
      {
        type: 'run.finish',
        runId,
        result: {
          identity: null,
          status: 'failed',
          started: false,
          exitCode: null,
          signal: null,
          reason: 'spawn',
          startedAt: null,
          finishedAt: authority.now,
          durationMs: 0,
          outputTruncated: false,
          cleanupConfirmed: true,
          outputArtifactRef: null,
          summary: 'spawn failure',
        },
      },
      authority,
    );
    const retry = {
      type: 'run.reserve' as const,
      purpose: 'diagnosis' as const,
      argv: ['node', 'repro.js'],
      cwd: '.',
      infrastructureRetryOf: runId,
      problemId: 'P1',
      hypothesis: 'executable is now installed',
    };
    expect(() => reduceExecution(state, retry, authority)).toThrow(
      'INFRASTRUCTURE_EVIDENCE_REQUIRED',
    );
    const attemptId = createUlid();
    state = reduceExecution(
      state,
      {
        type: 'attempt.reserve',
        attemptId,
        problemId: 'P1',
        classification: 'infrastructure',
        hypothesis: 'missing runtime',
        evidence: 'ENOENT',
      },
      authority,
    );
    state = reduceExecution(state, { ...retry, attemptId }, authority);
    expect(() =>
      reduceExecution(state, { ...retry, attemptId }, authority),
    ).toThrow('RETRY_EXHAUSTED');
  });
  it('rejects timeouts unsupported by the bounded executor before reservation', () => {
    expect(() =>
      initialExecutionState({
        ...policy,
        budget: {
          ...policy.budget,
          maxExecutionMs: 3_000_000_000,
          commandTimeoutMs: 2_147_480_001,
        },
      }),
    ).toThrow('TIMEOUT_UNSUPPORTED');
  });
  it('cannot omit the retry link to get a third infrastructure run', () => {
    let state = initialExecutionState(policy);
    const attemptId = createUlid();
    state = reduceExecution(
      state,
      {
        type: 'attempt.reserve',
        attemptId,
        problemId: 'infra',
        classification: 'infrastructure',
        hypothesis: 'runtime unavailable',
        evidence: 'connection failure',
      },
      authority,
    );
    const action = {
      type: 'run.reserve' as const,
      purpose: 'diagnosis' as const,
      attemptId,
      problemId: 'infra',
      hypothesis: 'retry after repair',
      argv: ['node', 'probe.js'],
      cwd: '.',
    };
    for (let i = 0; i < 2; i++) {
      const runId = createUlid();
      state = reduceExecution(state, { ...action, runId }, authority);
      state = reduceExecution(
        state,
        {
          type: 'run.finish',
          runId,
          result: {
            identity: null,
            status: 'failed',
            started: false,
            exitCode: null,
            signal: null,
            reason: 'spawn',
            startedAt: null,
            finishedAt: authority.now,
            durationMs: 0,
            outputTruncated: false,
            cleanupConfirmed: true,
            outputArtifactRef: null,
            summary: 'spawn failed',
          },
        },
        authority,
      );
    }
    expect(state.runs[1]?.infrastructureRetryOf).toBe(state.runs[0]?.runId);
    expect(() => reduceExecution(state, action, authority)).toThrow(
      'INFRASTRUCTURE_RETRY_EXHAUSTED',
    );
  });
  it('reconciles only interrupted uncertainty without refunding unknown consumption', () => {
    const runId = createUlid();
    let state = reduceExecution(
      initialExecutionState(policy),
      {
        type: 'run.reserve',
        runId,
        purpose: 'diagnosis',
        argv: ['node', 'probe.js'],
        cwd: '.',
      },
      authority,
    );
    expect(() =>
      reduceExecution(
        state,
        { type: 'run.reconcile', runId, approval },
        authority,
      ),
    ).toThrow('REQUIRES_INTERRUPTED_RUN');
    state = reduceExecution(
      state,
      {
        type: 'run.finish',
        runId,
        result: {
          identity: null,
          status: 'interrupted',
          started: false,
          exitCode: null,
          signal: null,
          reason: 'receipt_missing',
          startedAt: null,
          finishedAt: authority.now,
          durationMs: 1000,
          outputTruncated: false,
          cleanupConfirmed: false,
          outputArtifactRef: null,
          summary: 'unknown',
        },
      },
      authority,
    );
    const before = executionBudget(state);
    state = reduceExecution(
      state,
      { type: 'run.reconcile', runId, approval },
      authority,
    );
    expect(executionBudget(state)).toEqual(before);
    expect(state.runs[0]?.state).toBe('interrupted');
    expect(state.decisions.at(-1)).toMatchObject({
      kind: 'run_reconciliation',
      runId,
    });
  });
});

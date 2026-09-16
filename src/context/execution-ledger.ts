import type {
  BoundedRunResult,
  CIObservation,
  CiContract,
  ExecutionIdentity,
  VitestAssessment,
  VitestScenarioInput,
} from '../runtime/execution-protocol.js';
import { type ArtifactRef, parseArtifactRef } from './artifact-ref.js';
import { digestCanonicalJson } from './canonical.js';
import { assertUlid, createUlid } from './ids.js';
import {
  type ManEvidenceSubject,
  type ManVerificationSurface,
  parseManEvidenceSubject,
  parseManVerificationSurface,
} from './man-delivery-evidence.js';
import { assertSharedTextSafe } from './privacy.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export const EXECUTION_CAPABILITY = 'execution-gates:1' as const;
export interface ExecutionCheck {
  id: string;
  acceptanceIds: string[];
  argv: string[];
  cwd: string;
  surface: ManVerificationSurface;
}
export interface ExecutionScenario extends VitestScenarioInput {
  acceptanceId: string;
  mode: 'required' | 'alternative' | 'not_applicable';
  rationale: string;
  alternativeCheckIds: string[];
}
export type ExecutionCiPolicy = Omit<
  CiContract,
  'candidateSha' | 'testedSha' | 'pr' | 'workflows'
> & {
  workflows: Array<Omit<CiContract['workflows'][number], 'runId'>>;
};
export interface ExecutionPolicy {
  version: 1;
  budget: {
    maxRuns: number;
    maxExecutionMs: number;
    maxRepairAttempts: number;
    commandTimeoutMs: number;
    ciTimeoutMs: number;
  };
  checks: ExecutionCheck[];
  scenarios: ExecutionScenario[];
  delivery: 'local' | 'remote_required';
  ci: ExecutionCiPolicy | null;
}
export type ExecutionPurpose =
  | 'verification'
  | 'tdd_red'
  | 'tdd_green'
  | 'regression_replay'
  | 'diagnosis'
  | 'ci_observation';
export type PersistedRunResult = Omit<BoundedRunResult, 'stdout' | 'stderr'> & {
  outputArtifactRef: ArtifactRef | null;
  summary: string | null;
};
export interface ExecutionRun {
  runId: string;
  purpose: ExecutionPurpose;
  checkId: string | null;
  scenarioId: string | null;
  problemId: string | null;
  attemptId: string | null;
  infrastructureRetryOf: string | null;
  hypothesis: string | null;
  argv: string[];
  runnerArgv: string[];
  cwd: string;
  timeoutMs: number;
  subject: ManEvidenceSubject;
  testIdentity: string | null;
  configurationIdentity: string | null;
  requirementsDigest: string;
  planVersion: number;
  policyDigest: string;
  actorId: string;
  checkoutId: string;
  reservedAt: string;
  state: 'reserved' | 'running' | BoundedRunResult['status'];
  identity: ExecutionIdentity | null;
  result: PersistedRunResult | null;
  interruptions: PersistedRunResult[];
  vitest: VitestAssessment | null;
  applicable: boolean;
}
export type FailureClassification =
  | 'implementation'
  | 'test_or_ci'
  | 'infrastructure'
  | 'flaky'
  | 'pre_existing'
  | 'contract_conflict'
  | 'unknown';
export interface RepairAttempt {
  attemptId: string;
  problemId: string;
  classification: FailureClassification;
  hypothesis: string;
  evidence: string;
  subject: ManEvidenceSubject;
  reservedAt: string;
  finishedAt: string | null;
  state: 'reserved' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
  runIds: string[];
  summary: string | null;
  interruptions: Array<{
    finishedAt: string;
    runIds: string[];
    summary: string;
  }>;
}
export interface ExecutionApproval {
  confirmed: true;
  source: string;
  reason: string;
  evidence: string;
}
export interface ExecutionDecision {
  decisionId: string;
  kind:
    | 'budget_extension'
    | 'scenario_exception'
    | 'contract_revision'
    | 'problem_merge'
    | 'run_reconciliation';
  actorId: string;
  createdAt: string;
  approval: ExecutionApproval;
  problemId: string | null;
  sourceProblemIds: string[];
  scenarioId: string | null;
  runId: string | null;
  requirementsDigest: string;
  policyDigest: string;
  expiresAt: string | null;
  delta: {
    runs: number;
    executionMs: number;
    repairAttempts: number;
    problemFailures: number;
  } | null;
  previousPolicy: ExecutionPolicy | null;
}
export interface StoredCIObservation {
  observationId: string;
  runId: string;
  policyDigest: string;
  targetDigest: string;
  target: CiContract;
  observation: CIObservation;
}
export interface ExecutionState {
  policy: ExecutionPolicy;
  policyDigest: string;
  runs: ExecutionRun[];
  attempts: RepairAttempt[];
  decisions: ExecutionDecision[];
  ciObservations: StoredCIObservation[];
}
export interface ExecutionAuthority {
  actorId: string;
  checkoutId: string;
  requirementsDigest: string;
  planVersion: number;
  subject: ManEvidenceSubject;
  now: string;
}
export type ExecutionAction =
  | {
      type: 'run.reserve';
      runId?: string;
      purpose: ExecutionPurpose;
      checkId?: string;
      scenarioId?: string;
      problemId?: string;
      attemptId?: string;
      infrastructureRetryOf?: string;
      hypothesis?: string;
      argv: string[];
      runnerArgv?: string[];
      cwd: string;
      timeoutMs?: number;
      testIdentity?: string;
      configurationIdentity?: string;
    }
  | {
      type: 'run.reconcile';
      runId: string;
      decisionId?: string;
      approval: ExecutionApproval;
    }
  | { type: 'run.start'; runId: string; identity: ExecutionIdentity }
  | {
      type: 'run.finish';
      runId: string;
      result: PersistedRunResult;
      vitest?: VitestAssessment;
    }
  | {
      type: 'attempt.reserve';
      attemptId?: string;
      problemId: string;
      classification: FailureClassification;
      hypothesis: string;
      evidence: string;
    }
  | {
      type: 'attempt.finish';
      attemptId: string;
      state: 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
      runIds: string[];
      summary: string;
    }
  | {
      type: 'budget.extend';
      decisionId?: string;
      problemId?: string;
      delta: NonNullable<ExecutionDecision['delta']>;
      approval: ExecutionApproval;
    }
  | {
      type: 'exception.decide';
      decisionId?: string;
      scenarioId: string;
      expiresAt?: string;
      approval: ExecutionApproval;
    }
  | {
      type: 'contract.revise';
      decisionId?: string;
      policy: ExecutionPolicy;
      approval: ExecutionApproval;
    }
  | {
      type: 'problem.merge';
      decisionId?: string;
      problemId: string;
      sourceProblemIds: string[];
      approval: ExecutionApproval;
    }
  | {
      type: 'ci.observe';
      observationId?: string;
      runId: string;
      target: CiContract;
      observation: CIObservation;
    }
  | {
      type: 'manual.confirm';
      acceptanceIds: string[];
      surface: ManVerificationSurface;
      summary: string;
      confirmed: true;
    };

export function executionError(code: string): never {
  throw new Error(`MANCODE_${code}`);
}
export function executionText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.length > 16000
  )
    executionError(`EXECUTION_${label}_INVALID`);
  // Executable arguments may legitimately contain an absolute local Node path.
  // The existing task privacy guard still screens shared authority writes.
  if (label !== 'ARGV') assertSharedTextSafe(value, `execution ${label}`);
  return value;
}
function record(
  value: unknown,
  allowed: string[],
  label: string,
): asserts value is Record<string, unknown> {
  assertRecord(value, label);
  assertKnownKeys(value, allowed, label);
}
function number(value: unknown, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0))
    executionError('EXECUTION_BUDGET_INVALID');
  return value as number;
}
function texts(value: unknown, label: string, nonempty = false): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    (nonempty && value.length === 0)
  )
    executionError(`EXECUTION_${label}_INVALID`);
  return value.map((item) => executionText(item, label));
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length)
    executionError('EXECUTION_DUPLICATE_ID');
  return items;
}
function relative(value: unknown): string {
  const text = executionText(value, 'PATH');
  if (text === '.') return text;
  if (
    text.startsWith('/') ||
    /^[A-Za-z]:/.test(text) ||
    text.includes('\\') ||
    text.split('/').some((part) => part === '..' || part === '')
  )
    executionError('EXECUTION_PATH_INVALID');
  return text;
}
function timestamp(value: unknown): string {
  const text = executionText(value, 'TIMESTAMP');
  if (!Number.isFinite(Date.parse(text)))
    executionError('EXECUTION_TIMESTAMP_INVALID');
  return text;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    executionError('EXECUTION_DIGEST_INVALID');
  return value;
}
function id(value: unknown): string {
  assertUlid(value, 'execution ID');
  return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 10000)
    executionError('EXECUTION_RECORDS_INVALID');
  return value.map(parse);
}
function nullable<T>(value: unknown, parse: (item: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function enumValue<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T))
    executionError('EXECUTION_ENUM_INVALID');
  return value as T;
}

export function parseExecutionPolicy(value: unknown): ExecutionPolicy {
  record(
    value,
    ['version', 'budget', 'checks', 'scenarios', 'delivery', 'ci'],
    'execution policy',
  );
  if (value.version !== 1) executionError('EXECUTION_POLICY_UNSUPPORTED');
  record(
    value.budget,
    [
      'maxRuns',
      'maxExecutionMs',
      'maxRepairAttempts',
      'commandTimeoutMs',
      'ciTimeoutMs',
    ],
    'execution budget',
  );
  const budget = {
    maxRuns: number(value.budget.maxRuns, true),
    maxExecutionMs: number(value.budget.maxExecutionMs, true),
    maxRepairAttempts: number(value.budget.maxRepairAttempts),
    commandTimeoutMs: timeout(value.budget.commandTimeoutMs),
    ciTimeoutMs: timeout(value.budget.ciTimeoutMs),
  };
  if (
    budget.commandTimeoutMs > budget.maxExecutionMs ||
    budget.ciTimeoutMs > budget.maxExecutionMs
  )
    executionError('EXECUTION_TIMEOUT_EXCEEDS_BUDGET');
  const checks = unique(
    list(value.checks, (item) => {
      record(
        item,
        ['id', 'acceptanceIds', 'argv', 'cwd', 'surface'],
        'execution check',
      );
      return {
        id: executionText(item.id, 'CHECK_ID'),
        acceptanceIds: unique(
          texts(item.acceptanceIds, 'ACCEPTANCE', true),
          (v) => v,
        ),
        argv: texts(item.argv, 'ARGV', true),
        cwd: relative(item.cwd),
        surface: parseManVerificationSurface(item.surface),
      };
    }),
    (item) => item.id,
  );
  const scenarios = unique(
    list(value.scenarios, (item) => {
      record(
        item,
        [
          'id',
          'acceptanceId',
          'mode',
          'rationale',
          'alternativeCheckIds',
          'testInputs',
          'configInputs',
          'targets',
        ],
        'execution scenario',
      );
      const scenario: ExecutionScenario = {
        id: executionText(item.id, 'SCENARIO_ID'),
        acceptanceId: executionText(item.acceptanceId, 'ACCEPTANCE'),
        mode: enumValue(item.mode, [
          'required',
          'alternative',
          'not_applicable',
        ]),
        rationale: executionText(item.rationale, 'RATIONALE'),
        alternativeCheckIds: texts(item.alternativeCheckIds, 'ALTERNATIVE'),
        testInputs: texts(item.testInputs, 'TEST_INPUT').map(relative),
        configInputs: texts(item.configInputs, 'CONFIG_INPUT').map(relative),
        targets: unique(
          list(item.targets, (target) => {
            record(target, ['file', 'name'], 'test target');
            return {
              file: relative(target.file),
              name: executionText(target.name, 'TEST_NAME'),
            };
          }),
          (target) => JSON.stringify(target),
        ),
      };
      if (
        scenario.mode === 'required' &&
        (!scenario.targets.length ||
          scenario.targets.some(
            (target) => !scenario.testInputs.includes(target.file),
          ))
      )
        executionError('EXECUTION_TDD_TARGET_REQUIRED');
      if (
        scenario.mode === 'alternative' &&
        !scenario.alternativeCheckIds.length
      )
        executionError('EXECUTION_ALTERNATIVE_REQUIRED');
      if (
        scenario.alternativeCheckIds.some(
          (checkId) => !checks.some((check) => check.id === checkId),
        )
      )
        executionError('EXECUTION_CHECK_UNKNOWN');
      return scenario;
    }),
    (item) => item.id,
  );
  const delivery = enumValue(value.delivery, ['local', 'remote_required']);
  const ci = nullable(value.ci, parseCiPolicy);
  if ((delivery === 'remote_required') !== (ci !== null))
    executionError('EXECUTION_CI_CONTRACT_REQUIRED');
  return { version: 1, budget, checks, scenarios, delivery, ci };
}

function parseCiPolicy(value: unknown): ExecutionCiPolicy {
  record(
    value,
    ['repository', 'event', 'testedBinding', 'workflows'],
    'CI policy',
  );
  const repository = executionText(value.repository, 'REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    executionError('EXECUTION_REPOSITORY_INVALID');
  const workflows = unique(
    list(value.workflows, (item) => {
      record(
        item,
        ['id', 'path', 'configurationSha', 'requiredJobs'],
        'CI workflow',
      );
      return {
        id: number(item.id, true),
        path: relative(item.path),
        configurationSha: sha(item.configurationSha),
        requiredJobs: unique(
          texts(item.requiredJobs, 'CI_JOB', true),
          (v) => v,
        ),
      };
    }),
    (item) => String(item.id),
  );
  if (!workflows.length) executionError('EXECUTION_CI_WORKFLOWS_REQUIRED');
  return {
    repository,
    event: enumValue(value.event, ['push', 'pull_request']),
    testedBinding: enumValue(value.testedBinding, [
      'approved_workflow_head',
      'unverified',
    ]),
    workflows,
  };
}
function sha(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  )
    executionError('EXECUTION_SHA_INVALID');
  return value;
}

function timeout(value: unknown): number {
  const milliseconds = number(value, true);
  if (milliseconds > 2_147_480_000)
    executionError('EXECUTION_TIMEOUT_UNSUPPORTED');
  return milliseconds;
}

export function initialExecutionState(policy: unknown): ExecutionState {
  const parsed = parseExecutionPolicy(policy);
  return {
    policy: parsed,
    policyDigest: digestCanonicalJson(parsed),
    runs: [],
    attempts: [],
    decisions: [],
    ciObservations: [],
  };
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') executionError('EXECUTION_BOOLEAN_INVALID');
  return value;
}
export function parseExecutionIdentity(value: unknown): ExecutionIdentity {
  record(
    value,
    [
      'protocolVersion',
      'runId',
      'executorId',
      'commandDigest',
      'startedAt',
      'pid',
      'platform',
    ],
    'executor identity',
  );
  if (value.protocolVersion !== 1)
    executionError('EXECUTION_PROTOCOL_UNSUPPORTED');
  return {
    protocolVersion: 1,
    runId: id(value.runId),
    executorId: id(value.executorId),
    commandDigest: digest(value.commandDigest),
    startedAt: timestamp(value.startedAt),
    pid: number(value.pid, true),
    platform: executionText(value.platform, 'PLATFORM'),
  };
}
export function parsePersistedRunResult(value: unknown): PersistedRunResult {
  record(
    value,
    [
      'identity',
      'status',
      'started',
      'exitCode',
      'signal',
      'reason',
      'startedAt',
      'finishedAt',
      'durationMs',
      'outputTruncated',
      'cleanupConfirmed',
      'outputArtifactRef',
      'summary',
    ],
    'run result',
  );
  const result: PersistedRunResult = {
    identity: nullable(value.identity, parseExecutionIdentity),
    status: enumValue(value.status, [
      'succeeded',
      'failed',
      'timed_out',
      'cancelled',
      'interrupted',
    ]),
    started: boolean(value.started),
    exitCode: nullable(value.exitCode, (item) => {
      if (!Number.isSafeInteger(item))
        executionError('EXECUTION_EXIT_CODE_INVALID');
      return item as number;
    }),
    signal: nullable(value.signal, (item) => executionText(item, 'SIGNAL')),
    reason: nullable(value.reason, (item) => executionText(item, 'REASON')),
    startedAt: nullable(value.startedAt, timestamp),
    finishedAt: timestamp(value.finishedAt),
    durationMs: number(value.durationMs),
    outputTruncated: boolean(value.outputTruncated),
    cleanupConfirmed: boolean(value.cleanupConfirmed),
    outputArtifactRef: nullable(value.outputArtifactRef, parseArtifactRef),
    summary: nullable(value.summary, (item) => executionText(item, 'SUMMARY')),
  };
  if (result.started && (result.identity === null || result.startedAt === null))
    executionError('EXECUTION_IDENTITY_REQUIRED');
  if (!result.cleanupConfirmed && result.status !== 'interrupted')
    executionError('EXECUTION_CLEANUP_UNCONFIRMED');
  if (
    result.status === 'succeeded' &&
    (!result.started ||
      result.exitCode !== 0 ||
      result.signal !== null ||
      result.outputTruncated)
  )
    executionError('EXECUTION_SUCCESS_INVALID');
  if (
    result.startedAt !== null &&
    Date.parse(result.finishedAt) < Date.parse(result.startedAt)
  )
    executionError('EXECUTION_TIME_REVERSED');
  return result;
}
export function parseVitestAssessment(value: unknown): VitestAssessment {
  record(
    value,
    [
      'adapter',
      'adapterVersion',
      'runId',
      'executorId',
      'testIdentity',
      'configurationIdentity',
      'assessment',
      'targets',
      'collectionErrors',
      'unhandledErrors',
      'reasons',
    ],
    'Vitest evidence',
  );
  if (value.adapter !== 'vitest' || value.adapterVersion !== 1)
    executionError('EXECUTION_TEST_ADAPTER_UNSUPPORTED');
  return {
    adapter: 'vitest',
    adapterVersion: 1,
    runId: id(value.runId),
    executorId: id(value.executorId),
    testIdentity: digest(value.testIdentity),
    configurationIdentity: digest(value.configurationIdentity),
    assessment: enumValue(value.assessment, [
      'assertion_failure',
      'passed',
      'unverified',
    ]),
    targets: unique(
      list(value.targets, (item) => {
        record(item, ['file', 'name', 'status', 'errorNames'], 'Vitest target');
        return {
          file: relative(item.file),
          name: executionText(item.name, 'TEST_NAME'),
          status: enumValue(item.status, [
            'passed',
            'failed',
            'skipped',
            'pending',
          ]),
          errorNames: texts(item.errorNames, 'ERROR_NAME'),
        };
      }),
      (item) => JSON.stringify([item.file, item.name]),
    ),
    collectionErrors: number(value.collectionErrors),
    unhandledErrors: number(value.unhandledErrors),
    reasons: texts(value.reasons, 'REASON'),
  };
}
export function parseCiContract(value: unknown): CiContract {
  record(
    value,
    [
      'repository',
      'event',
      'candidateSha',
      'testedSha',
      'testedBinding',
      'workflows',
      'pr',
    ],
    'CI target',
  );
  const workflows = list(value.workflows, (item) => {
    record(
      item,
      ['id', 'path', 'configurationSha', 'requiredJobs', 'runId'],
      'CI target workflow',
    );
    return {
      id: number(item.id, true),
      path: relative(item.path),
      configurationSha: sha(item.configurationSha),
      requiredJobs: texts(item.requiredJobs, 'CI_JOB', true),
      ...(item.runId === undefined ? {} : { runId: number(item.runId, true) }),
    };
  });
  const policy = parseCiPolicy({
    repository: value.repository,
    event: value.event,
    testedBinding: value.testedBinding,
    workflows: workflows.map(({ runId: _runId, ...workflow }) => workflow),
  });
  let pr: CiContract['pr'];
  if (value.pr !== undefined) {
    record(value.pr, ['number', 'headSha', 'baseSha', 'mergeSha'], 'PR target');
    pr = {
      number: number(value.pr.number, true),
      headSha: sha(value.pr.headSha),
      baseSha: sha(value.pr.baseSha),
      mergeSha: sha(value.pr.mergeSha),
    };
  }
  return {
    ...policy,
    workflows,
    candidateSha: sha(value.candidateSha),
    testedSha: nullable(value.testedSha, sha),
    ...(pr === undefined ? {} : { pr }),
  };
}
export function parseCIObservation(value: unknown): CIObservation {
  record(
    value,
    [
      'provider',
      'repository',
      'candidateSha',
      'testedSha',
      'event',
      'observedAt',
      'status',
      'runs',
      'reasons',
    ],
    'CI observation',
  );
  if (value.provider !== 'github')
    executionError('EXECUTION_CI_PROVIDER_UNSUPPORTED');
  return {
    provider: 'github',
    repository: executionText(value.repository, 'REPOSITORY'),
    candidateSha: sha(value.candidateSha),
    testedSha: nullable(value.testedSha, sha),
    event: executionText(value.event, 'CI_EVENT'),
    observedAt: timestamp(value.observedAt),
    status: enumValue(value.status, [
      'passed',
      'failed',
      'pending',
      'unverified',
    ]),
    reasons: texts(value.reasons, 'REASON'),
    runs: list(value.runs, (item) => {
      record(
        item,
        [
          'runId',
          'attempt',
          'workflowId',
          'workflowPath',
          'configurationSha',
          'headSha',
          'status',
          'conclusion',
          'jobs',
        ],
        'CI run',
      );
      return {
        runId: number(item.runId, true),
        attempt: number(item.attempt, true),
        workflowId: number(item.workflowId, true),
        workflowPath: relative(item.workflowPath),
        configurationSha: sha(item.configurationSha),
        headSha: sha(item.headSha),
        status: executionText(item.status, 'CI_STATUS'),
        conclusion: nullable(item.conclusion, (v) =>
          executionText(v, 'CI_CONCLUSION'),
        ),
        jobs: list(item.jobs, (job) => {
          record(job, ['id', 'name', 'status', 'conclusion'], 'CI job');
          return {
            id: number(job.id, true),
            name: executionText(job.name, 'CI_JOB'),
            status: executionText(job.status, 'CI_STATUS'),
            conclusion: nullable(job.conclusion, (v) =>
              executionText(v, 'CI_CONCLUSION'),
            ),
          };
        }),
      };
    }),
  };
}
function parseApproval(value: unknown): ExecutionApproval {
  record(
    value,
    ['confirmed', 'source', 'reason', 'evidence'],
    'execution approval',
  );
  if (value.confirmed !== true) executionError('EXECUTION_APPROVAL_REQUIRED');
  return {
    confirmed: true,
    source: executionText(value.source, 'APPROVAL_SOURCE'),
    reason: executionText(value.reason, 'REASON'),
    evidence: executionText(value.evidence, 'EVIDENCE'),
  };
}
function parseDecision(value: unknown): ExecutionDecision {
  record(
    value,
    [
      'decisionId',
      'kind',
      'actorId',
      'createdAt',
      'approval',
      'problemId',
      'sourceProblemIds',
      'scenarioId',
      'runId',
      'requirementsDigest',
      'policyDigest',
      'expiresAt',
      'delta',
      'previousPolicy',
    ],
    'execution decision',
  );
  const delta = nullable(value.delta, (item) => {
    record(
      item,
      ['runs', 'executionMs', 'repairAttempts', 'problemFailures'],
      'budget extension',
    );
    return {
      runs: number(item.runs),
      executionMs: number(item.executionMs),
      repairAttempts: number(item.repairAttempts),
      problemFailures: number(item.problemFailures),
    };
  });
  return {
    decisionId: id(value.decisionId),
    kind: enumValue(value.kind, [
      'budget_extension',
      'scenario_exception',
      'contract_revision',
      'problem_merge',
      'run_reconciliation',
    ]),
    actorId: id(value.actorId),
    createdAt: timestamp(value.createdAt),
    approval: parseApproval(value.approval),
    problemId: nullable(value.problemId, (v) => executionText(v, 'PROBLEM')),
    sourceProblemIds: texts(value.sourceProblemIds, 'PROBLEM'),
    scenarioId: nullable(value.scenarioId, (v) => executionText(v, 'SCENARIO')),
    runId: nullable(value.runId, id),
    requirementsDigest: digest(value.requirementsDigest),
    policyDigest: digest(value.policyDigest),
    expiresAt: nullable(value.expiresAt, timestamp),
    delta,
    previousPolicy: nullable(value.previousPolicy, parseExecutionPolicy),
  };
}
function parseRun(value: unknown): ExecutionRun {
  record(
    value,
    [
      'runId',
      'purpose',
      'checkId',
      'scenarioId',
      'problemId',
      'attemptId',
      'infrastructureRetryOf',
      'hypothesis',
      'argv',
      'runnerArgv',
      'cwd',
      'timeoutMs',
      'subject',
      'testIdentity',
      'configurationIdentity',
      'requirementsDigest',
      'planVersion',
      'policyDigest',
      'actorId',
      'checkoutId',
      'reservedAt',
      'state',
      'identity',
      'result',
      'interruptions',
      'vitest',
      'applicable',
    ],
    'execution run',
  );
  const run: ExecutionRun = {
    runId: id(value.runId),
    purpose: enumValue(value.purpose, [
      'verification',
      'tdd_red',
      'tdd_green',
      'regression_replay',
      'diagnosis',
      'ci_observation',
    ]),
    checkId: nullable(value.checkId, (v) => executionText(v, 'CHECK_ID')),
    scenarioId: nullable(value.scenarioId, (v) => executionText(v, 'SCENARIO')),
    problemId: nullable(value.problemId, (v) => executionText(v, 'PROBLEM')),
    attemptId: nullable(value.attemptId, id),
    infrastructureRetryOf: nullable(value.infrastructureRetryOf, id),
    hypothesis: nullable(value.hypothesis, (v) =>
      executionText(v, 'HYPOTHESIS'),
    ),
    argv: texts(value.argv, 'ARGV', true),
    runnerArgv: texts(value.runnerArgv, 'ARGV', true),
    cwd: relative(value.cwd),
    timeoutMs: timeout(value.timeoutMs),
    subject: parseManEvidenceSubject(value.subject),
    testIdentity: nullable(value.testIdentity, digest),
    configurationIdentity: nullable(value.configurationIdentity, digest),
    requirementsDigest: digest(value.requirementsDigest),
    planVersion: number(value.planVersion, true),
    policyDigest: digest(value.policyDigest),
    actorId: id(value.actorId),
    checkoutId: executionText(value.checkoutId, 'CHECKOUT'),
    reservedAt: timestamp(value.reservedAt),
    state: enumValue(value.state, [
      'reserved',
      'running',
      'succeeded',
      'failed',
      'timed_out',
      'cancelled',
      'interrupted',
    ]),
    identity: nullable(value.identity, parseExecutionIdentity),
    result: nullable(value.result, parsePersistedRunResult),
    interruptions: list(value.interruptions, parsePersistedRunResult),
    vitest: nullable(value.vitest, parseVitestAssessment),
    applicable: boolean(value.applicable),
  };
  if (run.identity !== null && run.identity.runId !== run.runId)
    executionError('EXECUTION_IDENTITY_MISMATCH');
  if (
    (run.state === 'reserved' || run.state === 'running') !==
    (run.result === null)
  )
    executionError('EXECUTION_RUN_STATE_INVALID');
  if (run.state === 'running' && run.identity === null)
    executionError('EXECUTION_IDENTITY_REQUIRED');
  if (
    run.result &&
    (run.state !== run.result.status ||
      (run.result.identity &&
        digestCanonicalJson(run.result.identity) !==
          digestCanonicalJson(run.identity)))
  )
    executionError('EXECUTION_RESULT_MISMATCH');
  if (
    run.vitest &&
    (run.vitest.runId !== run.runId ||
      run.vitest.executorId !== run.identity?.executorId ||
      run.vitest.testIdentity !== run.testIdentity ||
      run.vitest.configurationIdentity !== run.configurationIdentity)
  )
    executionError('EXECUTION_TDD_IDENTITY_MISMATCH');
  return run;
}
function parseAttempt(value: unknown): RepairAttempt {
  record(
    value,
    [
      'attemptId',
      'problemId',
      'classification',
      'hypothesis',
      'evidence',
      'subject',
      'reservedAt',
      'finishedAt',
      'state',
      'runIds',
      'summary',
      'interruptions',
    ],
    'repair attempt',
  );
  return {
    attemptId: id(value.attemptId),
    problemId: executionText(value.problemId, 'PROBLEM'),
    classification: enumValue(value.classification, [
      'implementation',
      'test_or_ci',
      'infrastructure',
      'flaky',
      'pre_existing',
      'contract_conflict',
      'unknown',
    ]),
    hypothesis: executionText(value.hypothesis, 'HYPOTHESIS'),
    evidence: executionText(value.evidence, 'EVIDENCE'),
    subject: parseManEvidenceSubject(value.subject),
    reservedAt: timestamp(value.reservedAt),
    finishedAt: nullable(value.finishedAt, timestamp),
    state: enumValue(value.state, [
      'reserved',
      'succeeded',
      'failed',
      'interrupted',
      'cancelled',
    ]),
    runIds: texts(value.runIds, 'RUN_ID').map(id),
    summary: nullable(value.summary, (v) => executionText(v, 'SUMMARY')),
    interruptions: list(value.interruptions, (item) => {
      record(item, ['finishedAt', 'runIds', 'summary'], 'attempt interruption');
      return {
        finishedAt: timestamp(item.finishedAt),
        runIds: texts(item.runIds, 'RUN_ID').map(id),
        summary: executionText(item.summary, 'SUMMARY'),
      };
    }),
  };
}
export function parseExecutionState(value: unknown): ExecutionState {
  record(
    value,
    [
      'policy',
      'policyDigest',
      'runs',
      'attempts',
      'decisions',
      'ciObservations',
    ],
    'execution state',
  );
  const state: ExecutionState = {
    policy: parseExecutionPolicy(value.policy),
    policyDigest: digest(value.policyDigest),
    runs: unique(list(value.runs, parseRun), (run) => run.runId),
    attempts: unique(
      list(value.attempts, parseAttempt),
      (attempt) => attempt.attemptId,
    ),
    decisions: unique(
      list(value.decisions, parseDecision),
      (decision) => decision.decisionId,
    ),
    ciObservations: unique(
      list(value.ciObservations, (item) => {
        record(
          item,
          [
            'observationId',
            'runId',
            'policyDigest',
            'targetDigest',
            'target',
            'observation',
          ],
          'stored CI observation',
        );
        const target = parseCiContract(item.target);
        const targetDigest = digest(item.targetDigest);
        if (targetDigest !== digestCanonicalJson(target))
          executionError('EXECUTION_CI_TARGET_DIGEST_MISMATCH');
        return {
          observationId: id(item.observationId),
          runId: id(item.runId),
          policyDigest: digest(item.policyDigest),
          targetDigest,
          target,
          observation: parseCIObservation(item.observation),
        };
      }),
      (observation) => observation.observationId,
    ),
  };
  if (state.policyDigest !== digestCanonicalJson(state.policy))
    executionError('EXECUTION_POLICY_DIGEST_MISMATCH');
  for (const run of state.runs) {
    if (
      run.attemptId &&
      !state.attempts.some((attempt) => attempt.attemptId === run.attemptId)
    )
      executionError('EXECUTION_ATTEMPT_UNKNOWN');
    if (
      run.infrastructureRetryOf &&
      !state.runs.some((other) => other.runId === run.infrastructureRetryOf)
    )
      executionError('EXECUTION_RUN_UNKNOWN');
  }
  for (const attempt of state.attempts)
    if (
      attempt.runIds.some(
        (runId) =>
          !state.runs.some(
            (run) => run.runId === runId && run.attemptId === attempt.attemptId,
          ),
      )
    )
      executionError('EXECUTION_ATTEMPT_RUN_MISMATCH');
  for (const observation of state.ciObservations)
    if (
      !state.runs.some(
        (run) =>
          run.runId === observation.runId && run.purpose === 'ci_observation',
      )
    )
      executionError('EXECUTION_CI_RUN_UNKNOWN');
  return state;
}

export function canonicalProblem(
  state: ExecutionState,
  problemId: string,
): string {
  let current = problemId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) executionError('EXECUTION_PROBLEM_MERGE_CYCLE');
    seen.add(current);
    const merge = state.decisions.findLast(
      (decision) =>
        decision.kind === 'problem_merge' &&
        decision.sourceProblemIds.includes(current),
    );
    if (!merge?.problemId) return current;
    current = merge.problemId;
  }
}
export function executionBudget(state: ExecutionState) {
  const extensions = state.decisions.filter(
    (decision) => decision.kind === 'budget_extension',
  );
  const refunded = (run: ExecutionRun) =>
    run.result !== null &&
    !run.result.started &&
    run.result.cleanupConfirmed &&
    run.state !== 'interrupted';
  return {
    maxRuns:
      state.policy.budget.maxRuns +
      extensions.reduce((sum, item) => sum + (item.delta?.runs ?? 0), 0),
    maxExecutionMs:
      state.policy.budget.maxExecutionMs +
      extensions.reduce((sum, item) => sum + (item.delta?.executionMs ?? 0), 0),
    maxRepairAttempts:
      state.policy.budget.maxRepairAttempts +
      extensions.reduce(
        (sum, item) => sum + (item.delta?.repairAttempts ?? 0),
        0,
      ),
    runs: state.runs.filter((run) => !refunded(run)).length,
    executionMs: state.runs.reduce(
      (sum, run) =>
        sum +
        (refunded(run)
          ? 0
          : run.result?.cleanupConfirmed
            ? run.result.durationMs
            : run.timeoutMs),
      0,
    ),
    repairAttempts: state.attempts.filter(
      (attempt) => attempt.state !== 'cancelled',
    ).length,
  };
}
export function problemFailureLimit(
  state: ExecutionState,
  problemId: string,
): number {
  const root = canonicalProblem(state, problemId);
  return (
    2 +
    state.decisions
      .filter(
        (decision) =>
          decision.kind === 'budget_extension' &&
          decision.problemId !== null &&
          canonicalProblem(state, decision.problemId) === root,
      )
      .reduce(
        (sum, decision) => sum + (decision.delta?.problemFailures ?? 0),
        0,
      )
  );
}
function same(left: unknown, right: unknown): boolean {
  return digestCanonicalJson(left) === digestCanonicalJson(right);
}
function decisionBase(
  action: { decisionId?: string; approval: ExecutionApproval },
  authority: ExecutionAuthority,
  state: ExecutionState,
): Omit<ExecutionDecision, 'kind'> {
  return {
    decisionId: action.decisionId ?? createUlid(),
    actorId: authority.actorId,
    createdAt: authority.now,
    approval: parseApproval(action.approval),
    problemId: null,
    sourceProblemIds: [],
    scenarioId: null,
    runId: null,
    requirementsDigest: authority.requirementsDigest,
    policyDigest: state.policyDigest,
    expiresAt: null,
    delta: null,
    previousPolicy: null,
  };
}

/** Pure reducer; callers persist it under the existing task CAS and journal. */
export function reduceExecution(
  stateValue: ExecutionState,
  action: ExecutionAction,
  authority: ExecutionAuthority,
): ExecutionState {
  const state = structuredClone(stateValue);
  const runFor = (runId: string) => {
    const run = state.runs.find((item) => item.runId === runId);
    if (!run) executionError('EXECUTION_RUN_UNKNOWN');
    return run;
  };
  switch (action.type) {
    case 'run.reserve': {
      const timeoutMs =
        action.timeoutMs ??
        (action.purpose === 'ci_observation'
          ? state.policy.budget.ciTimeoutMs
          : state.policy.budget.commandTimeoutMs);
      if (
        timeoutMs >
        (action.purpose === 'ci_observation'
          ? state.policy.budget.ciTimeoutMs
          : state.policy.budget.commandTimeoutMs)
      )
        executionError('EXECUTION_TIMEOUT_EXCEEDS_POLICY');
      const run: ExecutionRun = {
        runId: action.runId ?? createUlid(),
        purpose: action.purpose,
        checkId: action.checkId ?? null,
        scenarioId: action.scenarioId ?? null,
        problemId: action.problemId
          ? canonicalProblem(state, action.problemId)
          : null,
        attemptId: action.attemptId ?? null,
        infrastructureRetryOf: action.infrastructureRetryOf ?? null,
        hypothesis: action.hypothesis ?? null,
        argv: [...action.argv],
        runnerArgv: [...(action.runnerArgv ?? action.argv)],
        cwd: action.cwd,
        timeoutMs,
        subject: authority.subject,
        testIdentity: action.testIdentity ?? null,
        configurationIdentity: action.configurationIdentity ?? null,
        requirementsDigest: authority.requirementsDigest,
        planVersion: authority.planVersion,
        policyDigest: state.policyDigest,
        actorId: authority.actorId,
        checkoutId: authority.checkoutId,
        reservedAt: authority.now,
        state: 'reserved',
        identity: null,
        result: null,
        interruptions: [],
        vitest: null,
        applicable: true,
      };
      const previous = state.runs.find((item) => item.runId === run.runId);
      if (previous) {
        for (const key of [
          'purpose',
          'checkId',
          'scenarioId',
          'problemId',
          'attemptId',
          'infrastructureRetryOf',
          'argv',
          'runnerArgv',
          'cwd',
          'timeoutMs',
          'testIdentity',
          'configurationIdentity',
        ] as const)
          if (!same(previous[key], run[key]))
            executionError('EXECUTION_RUN_ID_REUSED');
        return stateValue;
      }
      if (run.attemptId) {
        const attempt = state.attempts.find(
          (item) => item.attemptId === run.attemptId,
        );
        if (!attempt || attempt.state !== 'reserved')
          executionError('EXECUTION_ATTEMPT_NOT_ACTIVE');
        if (run.problemId !== canonicalProblem(state, attempt.problemId))
          executionError('EXECUTION_ATTEMPT_PROBLEM_MISMATCH');
      }
      if (
        run.purpose === 'verification' ||
        run.purpose === 'tdd_red' ||
        run.purpose === 'tdd_green' ||
        run.purpose === 'regression_replay'
      ) {
        const check = state.policy.checks.find(
          (item) => item.id === run.checkId,
        );
        if (!check || !same(check.argv, run.argv) || check.cwd !== run.cwd)
          executionError('EXECUTION_CHECK_CONTRACT_MISMATCH');
      }
      if (
        run.purpose.startsWith('tdd_') ||
        run.purpose === 'regression_replay'
      ) {
        const scenario = state.policy.scenarios.find(
          (item) => item.id === run.scenarioId,
        );
        if (
          !scenario ||
          scenario.mode !== 'required' ||
          !run.testIdentity ||
          !run.configurationIdentity
        )
          executionError('EXECUTION_TDD_SCENARIO_REQUIRED');
      }
      const infrastructureAttempt = state.attempts.find(
        (item) =>
          item.attemptId === run.attemptId &&
          item.classification === 'infrastructure',
      );
      if (infrastructureAttempt && run.problemId) {
        const chain = state.runs.filter(
          (item) =>
            item.problemId !== null &&
            canonicalProblem(state, item.problemId) === run.problemId &&
            same(item.argv, run.argv) &&
            item.cwd === run.cwd,
        );
        if (chain.length >= 2)
          executionError('EXECUTION_INFRASTRUCTURE_RETRY_EXHAUSTED');
        if (chain.length === 1 && run.infrastructureRetryOf === null)
          run.infrastructureRetryOf = chain[0]?.runId ?? null;
      }
      if (run.infrastructureRetryOf) {
        const prior = runFor(run.infrastructureRetryOf);
        const diagnosis = state.attempts.find(
          (item) => item.attemptId === run.attemptId,
        );
        if (
          !diagnosis ||
          diagnosis.classification !== 'infrastructure' ||
          !diagnosis.evidence ||
          canonicalProblem(state, diagnosis.problemId) !== run.problemId
        )
          executionError('EXECUTION_INFRASTRUCTURE_EVIDENCE_REQUIRED');
        if (
          prior.infrastructureRetryOf ||
          !prior.result ||
          prior.state === 'succeeded' ||
          !run.hypothesis ||
          !run.problemId ||
          !same(prior.argv, run.argv) ||
          prior.cwd !== run.cwd ||
          state.runs.some((item) => item.infrastructureRetryOf === prior.runId)
        )
          executionError('EXECUTION_INFRASTRUCTURE_RETRY_EXHAUSTED');
      }
      const budget = executionBudget(state);
      if (
        budget.runs >= budget.maxRuns ||
        budget.executionMs + timeoutMs > budget.maxExecutionMs
      )
        executionError('EXECUTION_BUDGET_EXHAUSTED');
      state.runs.push(parseRun(run));
      break;
    }
    case 'run.reconcile': {
      const run = runFor(action.runId);
      if (run.state !== 'interrupted')
        executionError('EXECUTION_RECONCILIATION_REQUIRES_INTERRUPTED_RUN');
      if (
        state.decisions.some(
          (item) =>
            item.kind === 'run_reconciliation' && item.runId === run.runId,
        )
      )
        return stateValue;
      state.decisions.push(
        parseDecision({
          ...decisionBase(action, authority, state),
          kind: 'run_reconciliation',
          runId: run.runId,
        }),
      );
      break;
    }
    case 'run.start': {
      const run = runFor(action.runId);
      const identity = parseExecutionIdentity(action.identity);
      if (identity.runId !== run.runId)
        executionError('EXECUTION_IDENTITY_MISMATCH');
      if (run.identity) {
        if (!same(run.identity, identity))
          executionError('EXECUTION_IDENTITY_MISMATCH');
        return stateValue;
      }
      if (
        run.state !== 'reserved' ||
        Date.parse(identity.startedAt) < Date.parse(run.reservedAt)
      )
        executionError('EXECUTION_RUN_STATE_INVALID');
      run.identity = identity;
      run.state = 'running';
      break;
    }
    case 'run.finish': {
      const run = runFor(action.runId);
      const result = parsePersistedRunResult(action.result);
      const vitest = action.vitest
        ? parseVitestAssessment(action.vitest)
        : null;
      if (run.result) {
        if (same(run.result, result)) {
          if (run.vitest && vitest && !same(run.vitest, vitest))
            executionError('EXECUTION_RESULT_ALREADY_RECORDED');
          if (!run.vitest && vitest) {
            run.vitest = vitest;
            break;
          }
          return stateValue;
        }
        if (
          run.state !== 'interrupted' ||
          result.status === 'interrupted' ||
          !result.cleanupConfirmed ||
          !result.identity
        )
          executionError('EXECUTION_RESULT_ALREADY_RECORDED');
        run.interruptions.push(run.result);
      }
      if (result.identity && result.identity.runId !== run.runId)
        executionError('EXECUTION_IDENTITY_MISMATCH');
      if (run.identity && !same(run.identity, result.identity))
        executionError('EXECUTION_IDENTITY_MISMATCH');
      if (Date.parse(result.finishedAt) < Date.parse(run.reservedAt))
        executionError('EXECUTION_TIME_REVERSED');
      run.identity = result.identity;
      run.result = result;
      run.state = result.status;
      run.vitest = vitest;
      run.applicable =
        run.requirementsDigest === authority.requirementsDigest &&
        run.planVersion === authority.planVersion &&
        run.policyDigest === state.policyDigest &&
        same(run.subject, authority.subject);
      break;
    }
    case 'attempt.reserve': {
      const attemptId = action.attemptId ?? createUlid();
      const problemId = canonicalProblem(
        state,
        executionText(action.problemId, 'PROBLEM'),
      );
      const previous = state.attempts.find(
        (item) => item.attemptId === attemptId,
      );
      if (previous) {
        if (
          canonicalProblem(state, previous.problemId) !== problemId ||
          previous.hypothesis !== action.hypothesis ||
          previous.classification !== action.classification
        )
          executionError('EXECUTION_ATTEMPT_ID_REUSED');
        return stateValue;
      }
      const problemAttempts = state.attempts.filter(
        (item) => canonicalProblem(state, item.problemId) === problemId,
      );
      if (
        problemAttempts.filter(
          (item) =>
            item.state === 'failed' ||
            item.state === 'interrupted' ||
            item.state === 'reserved',
        ).length >= problemFailureLimit(state, problemId)
      )
        executionError('REPAIR_BUDGET_EXHAUSTED');
      const budget = executionBudget(state);
      if (budget.repairAttempts >= budget.maxRepairAttempts)
        executionError('REPAIR_BUDGET_EXHAUSTED');
      state.attempts.push(
        parseAttempt({
          attemptId,
          problemId,
          classification: action.classification,
          hypothesis: action.hypothesis,
          evidence: action.evidence,
          subject: authority.subject,
          reservedAt: authority.now,
          finishedAt: null,
          state: 'reserved',
          runIds: [],
          summary: null,
          interruptions: [],
        }),
      );
      break;
    }
    case 'attempt.finish': {
      const attempt = state.attempts.find(
        (item) => item.attemptId === action.attemptId,
      );
      if (!attempt) executionError('EXECUTION_ATTEMPT_UNKNOWN');
      if (attempt.state !== 'reserved' && attempt.state !== 'interrupted') {
        if (
          attempt.state !== action.state ||
          !same(attempt.runIds, action.runIds) ||
          attempt.summary !== action.summary
        )
          executionError('EXECUTION_ATTEMPT_ALREADY_FINISHED');
        return stateValue;
      }
      const runs = action.runIds.map(runFor);
      if (
        runs.some(
          (run) => run.attemptId !== attempt.attemptId || run.result === null,
        )
      )
        executionError('EXECUTION_ATTEMPT_RUN_MISMATCH');
      if (
        action.state === 'succeeded' &&
        (!runs.length ||
          runs.some(
            (run) =>
              run.state !== 'succeeded' ||
              !run.applicable ||
              !same(run.subject, authority.subject),
          ))
      )
        executionError('EXECUTION_ATTEMPT_SUCCESS_UNPROVEN');
      if (
        action.state === 'cancelled' &&
        !same(attempt.subject, authority.subject)
      )
        executionError('EXECUTION_ATTEMPT_CANCEL_UNPROVEN');
      if (
        action.state === 'cancelled' &&
        state.runs.some(
          (run) =>
            run.attemptId === attempt.attemptId &&
            (run.result === null ||
              run.result.started ||
              !run.result.cleanupConfirmed),
        )
      )
        executionError('EXECUTION_ATTEMPT_CANCEL_UNPROVEN');
      if (attempt.state === 'interrupted') {
        if (
          !attempt.finishedAt ||
          !attempt.summary ||
          action.state === 'cancelled'
        )
          executionError('EXECUTION_ATTEMPT_RECOVERY_UNPROVEN');
        attempt.interruptions.push({
          finishedAt: attempt.finishedAt,
          runIds: [...attempt.runIds],
          summary: attempt.summary,
        });
      }
      attempt.state = action.state;
      attempt.runIds = [...action.runIds];
      attempt.summary = executionText(action.summary, 'SUMMARY');
      attempt.finishedAt = authority.now;
      break;
    }
    case 'budget.extend': {
      if (
        !Object.values(action.delta).some((value) => value > 0) ||
        (action.delta.problemFailures > 0 && !action.problemId)
      )
        executionError('EXECUTION_BUDGET_EXTENSION_INVALID');
      state.decisions.push(
        parseDecision({
          ...decisionBase(action, authority, state),
          kind: 'budget_extension',
          problemId: action.problemId
            ? canonicalProblem(state, action.problemId)
            : null,
          delta: action.delta,
        }),
      );
      break;
    }
    case 'exception.decide': {
      if (!state.policy.scenarios.some((item) => item.id === action.scenarioId))
        executionError('EXECUTION_SCENARIO_UNKNOWN');
      if (
        action.expiresAt &&
        Date.parse(action.expiresAt) <= Date.parse(authority.now)
      )
        executionError('EXECUTION_EXCEPTION_EXPIRED');
      state.decisions.push(
        parseDecision({
          ...decisionBase(action, authority, state),
          kind: 'scenario_exception',
          scenarioId: action.scenarioId,
          expiresAt: action.expiresAt ?? null,
        }),
      );
      break;
    }
    case 'contract.revise': {
      const policy = parseExecutionPolicy(action.policy);
      if (
        state.policy.delivery === 'remote_required' &&
        policy.delivery !== 'remote_required'
      )
        executionError('EXECUTION_REMOTE_DOWNGRADE_UNSUPPORTED');
      if (
        state.runs.some(
          (run) => run.state === 'reserved' || run.state === 'running',
        )
      )
        executionError('EXECUTION_ACTIVE_RUN');
      state.decisions.push(
        parseDecision({
          ...decisionBase(action, authority, state),
          kind: 'contract_revision',
          previousPolicy: state.policy,
        }),
      );
      state.policy = policy;
      state.policyDigest = digestCanonicalJson(policy);
      break;
    }
    case 'problem.merge': {
      const problemId = canonicalProblem(state, action.problemId);
      const sources = unique(
        action.sourceProblemIds.map((item) => canonicalProblem(state, item)),
        (item) => item,
      );
      if (!sources.length || sources.includes(problemId))
        executionError('EXECUTION_PROBLEM_MERGE_INVALID');
      state.decisions.push(
        parseDecision({
          ...decisionBase(action, authority, state),
          kind: 'problem_merge',
          problemId,
          sourceProblemIds: sources,
        }),
      );
      break;
    }
    case 'ci.observe': {
      const run = runFor(action.runId);
      if (
        run.purpose !== 'ci_observation' ||
        run.state !== 'succeeded' ||
        !run.applicable
      )
        executionError('EXECUTION_CI_RUN_REQUIRED');
      const target = parseCiContract(action.target);
      const {
        candidateSha: _candidate,
        testedSha: _tested,
        pr: _pr,
        ...contract
      } = target;
      const policyPart = {
        ...contract,
        workflows: target.workflows.map(
          ({ runId: _run, ...workflow }) => workflow,
        ),
      };
      if (!same(state.policy.ci, policyPart))
        executionError('EXECUTION_CI_CONTRACT_MISMATCH');
      const observation = parseCIObservation(action.observation);
      if (
        observation.repository !== target.repository ||
        observation.candidateSha !== target.candidateSha ||
        observation.event !== target.event
      )
        executionError('EXECUTION_CI_TARGET_MISMATCH');
      const previous = state.ciObservations.find(
        (item) => item.runId === run.runId,
      );
      if (previous) {
        if (
          !same(previous.target, target) ||
          !same(previous.observation, observation)
        )
          executionError('EXECUTION_CI_ALREADY_RECORDED');
        return stateValue;
      }
      state.ciObservations.push({
        observationId: action.observationId ?? createUlid(),
        runId: run.runId,
        policyDigest: state.policyDigest,
        targetDigest: digestCanonicalJson(target),
        target,
        observation,
      });
      break;
    }
    case 'manual.confirm':
      break;
  }
  return parseExecutionState(state);
}

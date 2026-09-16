/** Local executor DTOs. Tokens and raw output are not shared task authority. */
export interface ExecutionIdentity {
  protocolVersion: 1;
  runId: string;
  executorId: string;
  commandDigest: string;
  startedAt: string;
  /** The supervisor PID, never sufficient authorization to kill a process. */
  pid: number;
  platform: string;
}

export interface BoundedRunResult {
  identity: ExecutionIdentity | null;
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted';
  started: boolean;
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  startedAt: string | null;
  finishedAt: string;
  durationMs: number;
  outputTruncated: boolean;
  cleanupConfirmed: boolean;
  stdout: string;
  stderr: string;
}

export interface VitestScenarioInput {
  id: string;
  targets: Array<{ file: string; name: string }>;
  testInputs: string[];
  configInputs: string[];
}

export interface VitestAssessment {
  adapter: 'vitest';
  adapterVersion: 1;
  runId: string;
  executorId: string;
  testIdentity: string;
  configurationIdentity: string;
  assessment: 'assertion_failure' | 'passed' | 'unverified';
  targets: Array<{
    file: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    errorNames: string[];
  }>;
  collectionErrors: number;
  unhandledErrors: number;
  reasons: string[];
}

export interface CiContract {
  repository: string;
  event: 'push' | 'pull_request';
  candidateSha: string;
  testedSha: string | null;
  testedBinding: 'approved_workflow_head' | 'unverified';
  workflows: Array<{
    id: number;
    path: string;
    configurationSha: string;
    requiredJobs: string[];
    runId?: number;
  }>;
  pr?: { number: number; headSha: string; baseSha: string; mergeSha: string };
}

export interface CIObservation {
  provider: 'github';
  repository: string;
  candidateSha: string;
  testedSha: string | null;
  event: string;
  observedAt: string;
  status: 'passed' | 'failed' | 'pending' | 'unverified';
  runs: Array<{
    runId: number;
    attempt: number;
    workflowId: number;
    workflowPath: string;
    configurationSha: string;
    headSha: string;
    status: string;
    conclusion: string | null;
    jobs: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
    }>;
  }>;
  reasons: string[];
}

export interface ExecutionRequest {
  protocolVersion: 1;
  runId: string;
  executorId: string;
  commandDigest: string;
  projectRoot: string;
  argv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  token: string;
  env?: Record<string, string>;
}

export interface ExecutionControl {
  identity: ExecutionIdentity;
  port: number;
  token: string;
}

export interface VitestRunReport {
  protocolVersion: 1;
  runId: string;
  executorId: string;
  reason: string;
  collectionErrors: number;
  unhandledErrors: number;
  tests: Array<{
    file: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    errorNames: string[];
    assertionErrors: number;
    retryCount: number;
    expectedFailure: boolean;
  }>;
}

import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digestCanonicalJson } from '../context/canonical.js';
import type {
  CIObservation,
  CiContract,
} from '../runtime/execution-protocol.js';

const execFile = promisify(execFileCallback);
export function packagedCiObserverPath(): string {
  const current = fileURLToPath(import.meta.url);
  return current.endsWith('.ts')
    ? path.resolve(path.dirname(current), '../../dist/execution/ci-observer.js')
    : fileURLToPath(new URL('./execution/ci-observer.js', import.meta.url));
}
/** At most 1,000 GETs, including complete-set refreshes and bounded job pagination.
 * Each workflow costs six non-job requests plus at least ten job pages; declared
 * larger matrices receive their known page count. Unsupported sizes fail before launch.
 */
export function ciObserverRequestBudget(contract: CiContract): number {
  const minimum =
    2 +
    contract.workflows.reduce(
      (sum, workflow) =>
        sum + 6 + Math.max(1, Math.ceil(workflow.requiredJobs.length / 100)),
      0,
    );
  if (minimum > 1000) throw new Error('MANCODE_CI_REQUEST_CONTRACT_TOO_LARGE');
  return Math.min(
    1000,
    Math.max(
      20,
      2 +
        contract.workflows.reduce(
          (sum, workflow) =>
            sum +
            6 +
            Math.max(10, Math.ceil(workflow.requiredJobs.length / 100)),
          0,
        ),
    ),
  );
}

/** Only the packaged observer may produce CI evidence. Older bounded invocations
 * remain recoverable, but arbitrary scripts, runner overrides and cwd changes do not.
 */
export function assertCiObserverInvocation(
  input: {
    argv: string[];
    runnerArgv?: string[];
    cwd: string;
    timeoutMs: number;
  },
  target: CiContract,
): void {
  const requests = Number(input.argv[5]);
  const expected = buildCiObserverArgv(target, input.timeoutMs, requests);
  // JSON object ordering is not command identity. Preserve the exact receipt argv
  // for executor digest checks, while comparing the embedded contract canonically.
  expected[3] = input.argv[3] ?? '';
  if (
    input.cwd !== '.' ||
    !Number.isSafeInteger(requests) ||
    requests < 1 ||
    requests > ciObserverRequestBudget(target) ||
    JSON.stringify(input.argv) !== JSON.stringify(expected) ||
    digestCanonicalJson(JSON.parse(input.argv[3] ?? 'null')) !==
      digestCanonicalJson(target) ||
    (input.runnerArgv !== undefined &&
      JSON.stringify(input.runnerArgv) !== JSON.stringify(input.argv))
  )
    throw new Error('MANCODE_EXECUTION_CI_OBSERVER_REQUIRED');
}

export function buildCiObserverArgv(
  contract: CiContract,
  timeoutMs: number,
  maxRequests: number = ciObserverRequestBudget(contract),
): string[] {
  return [
    process.execPath,
    packagedCiObserverPath(),
    '--observe',
    JSON.stringify(contract),
    String(timeoutMs),
    String(maxRequests),
  ];
}
type JsonObject = Record<string, unknown>;
export interface CiObservationOptions {
  timeoutMs: number;
  maxRequests: number;
  /** Tests inject provider responses; production always uses authenticated gh GET. */
  get?: (endpoint: string, timeoutMs: number) => Promise<unknown>;
}

async function githubGet(
  endpoint: string,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const result = await execFile(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        '-H',
        'Accept: application/vnd.github+json',
        endpoint,
      ],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_DEBUG: '',
          GH_FORCE_TTY: '',
        },
      },
    );
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('GITHUB_QUERY_UNAVAILABLE');
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('GITHUB_RESPONSE_INVALID');
  return value as JsonObject;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('GITHUB_RESPONSE_INVALID');
  return value;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error('GITHUB_RESPONSE_INVALID');
  return value as number;
}
function items(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('GITHUB_RESPONSE_INVALID');
  return value.map(object);
}

/** One bounded observation batch. Pending observations require an explicit later call. */
export async function observeGitHubCi(
  contract: CiContract,
  options: CiObservationOptions,
): Promise<CIObservation> {
  const observation: CIObservation = {
    provider: 'github',
    repository: contract.repository,
    candidateSha: contract.candidateSha,
    testedSha: null,
    event: contract.event,
    observedAt: new Date().toISOString(),
    status: 'unverified',
    runs: [],
    reasons: [],
  };
  const deadline = performance.now() + options.timeoutMs;
  let requests = 0;
  const get = async (endpoint: string) => {
    if (++requests > options.maxRequests)
      throw new Error('GITHUB_REQUEST_BUDGET_EXHAUSTED');
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error('GITHUB_OBSERVATION_DEADLINE');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (options.get ?? githubGet)(endpoint, remaining),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('GITHUB_OBSERVATION_DEADLINE')),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(contract.repository) ||
      !/^[a-f0-9]{40}$/.test(contract.candidateSha) ||
      !['push', 'pull_request'].includes(contract.event) ||
      !contract.workflows.length ||
      new Set(contract.workflows.map((workflow) => workflow.id)).size !==
        contract.workflows.length ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_480_000 ||
      !Number.isSafeInteger(options.maxRequests) ||
      options.maxRequests < 1
    )
      throw new Error('CI_CONTRACT_INVALID');
    const prefix = `repos/${contract.repository}`;
    const repository = object(await get(prefix));
    const repositoryId = number(repository.id);
    if (
      text(repository.full_name).toLowerCase() !==
      contract.repository.toLowerCase()
    )
      throw new Error('CI_REPOSITORY_MISMATCH');
    if (contract.event === 'pull_request') {
      if (!contract.pr) throw new Error('CI_PR_TARGET_REQUIRED');
      const pr = object(await get(`${prefix}/pulls/${contract.pr.number}`));
      if (
        object(pr.head).sha !== contract.pr.headSha ||
        object(pr.base).sha !== contract.pr.baseSha ||
        pr.merge_commit_sha !== contract.pr.mergeSha
      )
        throw new Error('CI_PR_TARGET_CHANGED');
      observation.reasons.push('CI_PR_TESTED_OBJECT_UNVERIFIED');
    } else if (
      contract.testedBinding !== 'approved_workflow_head' ||
      contract.testedSha !== contract.candidateSha
    )
      observation.reasons.push('CI_CHECKOUT_CONTRACT_UNVERIFIED');
    else observation.testedSha = contract.testedSha;
    let failed = false;
    let pending = false;
    const snapshots: Array<{
      endpoint: string;
      signature: string;
      run: JsonObject;
    }> = [];
    const runSetSignature = (listing: JsonObject) =>
      JSON.stringify({
        count: listing.total_count,
        runs: items(listing.workflow_runs)
          .map((run) => ({
            id: run.id,
            number: run.run_number,
            attempt: run.run_attempt,
          }))
          .sort((a, b) => number(a.id) - number(b.id)),
      });
    for (const workflow of contract.workflows) {
      if (
        !Number.isSafeInteger(workflow.id) ||
        workflow.id < 1 ||
        !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow.path) ||
        !/^[a-f0-9]{40}$/.test(workflow.configurationSha) ||
        !workflow.requiredJobs.length ||
        new Set(workflow.requiredJobs).size !== workflow.requiredJobs.length ||
        workflow.requiredJobs.some(
          (name) => typeof name !== 'string' || !name.trim(),
        )
      )
        throw new Error('CI_WORKFLOW_CONTRACT_INVALID');
      const listingEndpoint = `${prefix}/actions/workflows/${workflow.id}/runs?head_sha=${contract.candidateSha}&event=${contract.event}&per_page=100`;
      const listing = object(await get(listingEndpoint));
      const candidates = items(listing.workflow_runs);
      if (listing.total_count !== candidates.length)
        throw new Error('CI_RUN_LIST_INCOMPLETE');
      if (!candidates.length) {
        observation.reasons.push('CI_RUN_MISSING');
        continue;
      }
      const selected =
        workflow.runId === undefined
          ? candidates.length === 1
            ? candidates[0]
            : undefined
          : candidates.find((run) => run.id === workflow.runId);
      if (
        !selected ||
        candidates.some(
          (run) => number(run.run_number) > number(selected.run_number),
        )
      )
        throw new Error('CI_RUN_SELECTION_AMBIGUOUS_OR_STALE');
      const runId = number(selected.id);
      const run = object(await get(`${prefix}/actions/runs/${runId}`));
      const attempt = number(run.run_attempt);
      snapshots.push({
        endpoint: listingEndpoint,
        signature: runSetSignature(listing),
        run,
      });
      if (
        run.id !== runId ||
        run.workflow_id !== workflow.id ||
        text(run.path).split('@')[0] !== workflow.path ||
        run.head_sha !== contract.candidateSha ||
        run.event !== contract.event ||
        object(run.repository).id !== repositoryId
      )
        throw new Error('CI_RUN_IDENTITY_MISMATCH');
      const configuration = object(
        await get(
          `${prefix}/contents/${workflow.path}?ref=${contract.candidateSha}`,
        ),
      );
      if (configuration.sha !== workflow.configurationSha)
        throw new Error('CI_WORKFLOW_CONFIGURATION_CHANGED');
      const jobs: JsonObject[] = [];
      let total = 0;
      for (let page = 1; ; page++) {
        const batch = object(
          await get(
            `${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
          ),
        );
        if (
          !Number.isSafeInteger(batch.total_count) ||
          (batch.total_count as number) < 0
        )
          throw new Error('GITHUB_RESPONSE_INVALID');
        if (page > 1 && total !== batch.total_count)
          throw new Error('CI_JOBS_CHANGED_DURING_OBSERVATION');
        total = batch.total_count as number;
        const entries = items(batch.jobs);
        jobs.push(...entries);
        if (jobs.length >= total) break;
        if (!entries.length) throw new Error('CI_JOBS_INCOMPLETE');
      }
      if (
        jobs.length !== total ||
        new Set(jobs.map((job) => job.id)).size !== jobs.length
      )
        throw new Error('CI_JOBS_INCOMPLETE');
      for (const job of jobs)
        if (
          job.run_id !== runId ||
          job.head_sha !== contract.candidateSha ||
          (job.run_attempt !== undefined && job.run_attempt !== attempt)
        )
          throw new Error('CI_JOB_IDENTITY_MISMATCH');
      const result: CIObservation['runs'][number] = {
        runId,
        attempt,
        workflowId: workflow.id,
        workflowPath: workflow.path,
        configurationSha: workflow.configurationSha,
        headSha: contract.candidateSha,
        status: text(run.status),
        conclusion: run.conclusion === null ? null : text(run.conclusion),
        jobs: jobs.map((job) => ({
          id: number(job.id),
          name: text(job.name),
          status: text(job.status),
          conclusion: job.conclusion === null ? null : text(job.conclusion),
        })),
      };
      observation.runs.push(result);
      for (const name of workflow.requiredJobs) {
        const matching = result.jobs.filter((job) => job.name === name);
        if (matching.length !== 1) {
          observation.reasons.push('CI_REQUIRED_JOB_MISSING_OR_AMBIGUOUS');
          continue;
        }
        const job = matching[0];
        if (job?.status !== 'completed') pending = true;
        else if (
          [
            'failure',
            'timed_out',
            'cancelled',
            'action_required',
            'startup_failure',
            'stale',
          ].includes(job.conclusion ?? '')
        )
          failed = true;
        else if (job.conclusion !== 'success')
          observation.reasons.push('CI_REQUIRED_JOB_NOT_PASSED');
      }
      if (result.status !== 'completed') pending = true;
      else if (result.conclusion !== 'success') failed = true;
      const refreshed = object(await get(`${prefix}/actions/runs/${runId}`));
      if (
        refreshed.run_attempt !== attempt ||
        refreshed.status !== run.status ||
        refreshed.conclusion !== run.conclusion ||
        refreshed.head_sha !== run.head_sha
      )
        throw new Error('CI_RUN_CHANGED_DURING_OBSERVATION');
    }
    // Revalidate every target after collecting all workflows, not just the
    // first workflow before later queries may observe a newly queued run.
    for (const snapshot of snapshots) {
      if (
        runSetSignature(object(await get(snapshot.endpoint))) !==
        snapshot.signature
      )
        throw new Error('CI_RUN_SET_CHANGED_DURING_OBSERVATION');
      const refreshed = object(
        await get(`${prefix}/actions/runs/${number(snapshot.run.id)}`),
      );
      if (
        ['run_attempt', 'status', 'conclusion', 'head_sha'].some(
          (key) => refreshed[key] !== snapshot.run[key],
        )
      )
        throw new Error('CI_RUN_CHANGED_DURING_OBSERVATION');
    }
    observation.status = observation.reasons.length
      ? 'unverified'
      : failed
        ? 'failed'
        : pending
          ? 'pending'
          : observation.runs.length === contract.workflows.length
            ? 'passed'
            : 'unverified';
    if (observation.status === 'unverified') observation.testedSha = null;
  } catch (error) {
    observation.status = 'unverified';
    observation.testedSha = null;
    observation.reasons.push(
      error instanceof Error ? error.message : 'CI_OBSERVATION_UNAVAILABLE',
    );
  }
  observation.observedAt = new Date().toISOString();
  return observation;
}

if (
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    path.resolve(process.argv[1]) === packagedCiObserverPath()) &&
  process.argv[2] === '--observe'
) {
  void (async () => {
    const raw = process.argv[3] ?? '';
    const contract = JSON.parse(raw) as CiContract;
    const observation = await observeGitHubCi(contract, {
      timeoutMs: Number(process.argv[4]),
      maxRequests: Number(process.argv[5]),
    });
    console.log(JSON.stringify(observation));
  })().catch(() => {
    console.error('MANCODE_CI_OBSERVER_INPUT_INVALID');
    process.exitCode = 1;
  });
}

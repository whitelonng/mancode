import { describe, expect, it } from 'vitest';
import type { CiContract } from '../src/runtime/execution-protocol.js';
import {
  assertCiObserverInvocation,
  buildCiObserverArgv,
  ciObserverRequestBudget,
  observeGitHubCi,
} from '../src/system/ci-observer.js';

const sha = 'a'.repeat(40);
const configSha = 'b'.repeat(40);
const contract: CiContract = {
  repository: 'owner/project',
  candidateSha: sha,
  testedSha: sha,
  event: 'push',
  testedBinding: 'approved_workflow_head',
  workflows: [
    {
      id: 7,
      path: '.github/workflows/quality.yml',
      configurationSha: configSha,
      requiredJobs: ['quality (22)', 'quality (24)'],
    },
  ],
};
function fixture(
  change: (
    route: string,
    value: Record<string, unknown>,
    call: number,
  ) => void = () => {},
) {
  const calls: string[] = [];
  const run = {
    id: 11,
    run_number: 3,
    run_attempt: 2,
    workflow_id: 7,
    path: '.github/workflows/quality.yml',
    head_sha: sha,
    event: 'push',
    repository: { id: 5 },
    status: 'completed',
    conclusion: 'success',
  };
  const get = async (route: string) => {
    calls.push(route);
    let value: Record<string, unknown>;
    if (route === 'repos/owner/project')
      value = { id: 5, full_name: 'owner/project' };
    else if (route.includes('/workflows/7/runs?'))
      value = { total_count: 1, workflow_runs: [run] };
    else if (route.endsWith('/runs/11')) value = run;
    else if (route.includes('/contents/')) value = { sha: configSha };
    else if (route.includes('/attempts/2/jobs?'))
      value = {
        total_count: 2,
        jobs: [22, 24].map((node) => ({
          id: node,
          run_id: 11,
          run_attempt: 2,
          head_sha: sha,
          name: `quality (${node})`,
          status: 'completed',
          conclusion: 'success',
        })),
      };
    else throw new Error('unexpected endpoint');
    value = structuredClone(value);
    change(route, value, calls.filter((entry) => entry === route).length);
    return value;
  };
  return { calls, get };
}

describe('bounded GitHub observation', () => {
  it('binds repository, workflow, exact commit, latest attempt, configuration and complete matrix', async () => {
    const provider = fixture();
    const result = await observeGitHubCi(contract, {
      timeoutMs: 1000,
      maxRequests: 20,
      get: provider.get,
    });
    expect(result).toMatchObject({
      status: 'passed',
      testedSha: sha,
      runs: [
        {
          runId: 11,
          attempt: 2,
          jobs: [{ name: 'quality (22)' }, { name: 'quality (24)' }],
        },
      ],
    });
    expect(provider.calls).toContain(
      'repos/owner/project/actions/runs/11/attempts/2/jobs?per_page=100&page=1',
    );
    expect(buildCiObserverArgv(contract, 1000, 20).slice(2)).toEqual([
      '--observe',
      JSON.stringify(contract),
      '1000',
      '20',
    ]);
  });

  it.each([
    'wrong_sha',
    'wrong_event',
    'wrong_workflow',
    'wrong_repository',
    'configuration_changed',
    'missing_matrix',
    'wrong_job_run',
    'old_attempt',
    'new_attempt',
    'skipped',
    'neutral',
    'empty',
    'ambiguous',
  ])('does not accept %s as remote evidence', async (failure) => {
    const provider = fixture((route, value, call) => {
      if (route.endsWith('/runs/11')) {
        if (failure === 'wrong_sha') value.head_sha = 'c'.repeat(40);
        if (failure === 'wrong_event') value.event = 'workflow_dispatch';
        if (failure === 'wrong_workflow') value.workflow_id = 99;
        if (failure === 'wrong_repository') value.repository = { id: 99 };
        if (failure === 'new_attempt' && call > 1) value.run_attempt = 3;
      }
      if (route.includes('/contents/') && failure === 'configuration_changed')
        value.sha = 'c'.repeat(40);
      if (route.includes('/jobs?')) {
        const jobs = value.jobs as Array<Record<string, unknown>>;
        if (failure === 'missing_matrix') {
          jobs.pop();
          value.total_count = 1;
        }
        if (failure === 'wrong_job_run' && jobs[0]) jobs[0].run_id = 10;
        if (failure === 'old_attempt' && jobs[0]) jobs[0].run_attempt = 1;
        if (['skipped', 'neutral'].includes(failure) && jobs[0])
          jobs[0].conclusion = failure;
      }
      if (route.includes('/workflows/7/runs?')) {
        if (failure === 'empty') {
          value.workflow_runs = [];
          value.total_count = 0;
        }
        if (failure === 'ambiguous') {
          value.workflow_runs = [
            ...(value.workflow_runs as unknown[]),
            ...(value.workflow_runs as unknown[]),
          ];
          value.total_count = 2;
        }
      }
    });
    const result = await observeGitHubCi(contract, {
      timeoutMs: 1000,
      maxRequests: 20,
      get: provider.get,
    });
    expect(result.status).toBe('unverified');
    expect(result.testedSha).toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('accepts the explicitly selected latest same-SHA run but never an older selection', async () => {
    const provider = fixture((route, value) => {
      if (route.includes('/workflows/7/runs?')) {
        const current = (
          value.workflow_runs as Array<Record<string, unknown>>
        )[0];
        value.workflow_runs = [current, { ...current, id: 10, run_number: 2 }];
        value.total_count = 2;
      }
    });
    for (const runId of [11, 10, undefined]) {
      const target = {
        ...contract,
        workflows: contract.workflows.map((workflow) => ({
          ...workflow,
          ...(runId === undefined ? {} : { runId }),
        })),
      };
      const result = await observeGitHubCi(target, {
        timeoutMs: 1000,
        maxRequests: 20,
        get: provider.get,
      });
      expect(result.status).toBe(runId === 11 ? 'passed' : 'unverified');
      if (runId !== 11)
        expect(result.reasons).toContain('CI_RUN_SELECTION_AMBIGUOUS_OR_STALE');
    }
  });

  it('rejects a newer same-target run appearing before observation finishes', async () => {
    const provider = fixture((route, value, call) => {
      if (route.includes('/workflows/7/runs?') && call > 1) {
        const prior = (
          value.workflow_runs as Array<Record<string, unknown>>
        )[0];
        value.workflow_runs = [prior, { ...prior, id: 12, run_number: 4 }];
        value.total_count = 2;
      }
    });
    const result = await observeGitHubCi(
      {
        ...contract,
        workflows: contract.workflows.map((workflow) => ({
          ...workflow,
          runId: 11,
        })),
      },
      {
        timeoutMs: 1000,
        maxRequests: 20,
        get: provider.get,
      },
    );
    expect(result.status).toBe('unverified');
    expect(result.reasons).toContain('CI_RUN_SET_CHANGED_DURING_OBSERVATION');
  });

  it('distinguishes verified failure and pending from unavailable evidence', async () => {
    for (const conclusion of ['failure', null]) {
      const provider = fixture((route, value) => {
        if (route.includes('/jobs?'))
          for (const job of value.jobs as Array<Record<string, unknown>>) {
            job.conclusion = conclusion;
            job.status = conclusion ? 'completed' : 'in_progress';
          }
      });
      expect(
        (
          await observeGitHubCi(contract, {
            timeoutMs: 1000,
            maxRequests: 20,
            get: provider.get,
          })
        ).status,
      ).toBe(conclusion ? 'failed' : 'pending');
    }
    expect(
      (
        await observeGitHubCi(contract, {
          timeoutMs: 1000,
          maxRequests: 20,
          get: async () => {
            throw new Error('permission denied');
          },
        })
      ).status,
    ).toBe('unverified');
  });

  it('never substitutes a PR run head SHA for a verified merge checkout', async () => {
    for (const drift of [false, true]) {
      const provider = fixture((route, value) => {
        if (route.endsWith('/runs/11')) value.event = 'pull_request';
      });
      const result = await observeGitHubCi(
        {
          ...contract,
          event: 'pull_request',
          pr: {
            number: 1,
            headSha: sha,
            baseSha: 'c'.repeat(40),
            mergeSha: 'd'.repeat(40),
          },
        },
        {
          timeoutMs: 1000,
          maxRequests: 20,
          get: async (route) =>
            route.includes('/pulls/')
              ? {
                  head: { sha: drift ? 'e'.repeat(40) : sha },
                  base: { sha: 'c'.repeat(40) },
                  merge_commit_sha: 'd'.repeat(40),
                }
              : provider.get(route),
        },
      );
      expect(result.status).toBe('unverified');
      expect(result.testedSha).toBeNull();
      expect(result.reasons).toContain(
        drift ? 'CI_PR_TARGET_CHANGED' : 'CI_PR_TESTED_OBJECT_UNVERIFIED',
      );
    }
  });

  it('bounds request count and time and refuses unproven checkout contracts', async () => {
    expect(
      (
        await observeGitHubCi(contract, {
          timeoutMs: 1000,
          maxRequests: 1,
          get: fixture().get,
        })
      ).reasons,
    ).toContain('GITHUB_REQUEST_BUDGET_EXHAUSTED');
    expect(
      (
        await observeGitHubCi(contract, {
          timeoutMs: 20,
          maxRequests: 20,
          get: () => new Promise(() => {}),
        })
      ).reasons,
    ).toContain('GITHUB_OBSERVATION_DEADLINE');
    expect(
      (
        await observeGitHubCi(
          { ...contract, testedBinding: 'unverified' },
          { timeoutMs: 1000, maxRequests: 20, get: fixture().get },
        )
      ).status,
    ).toBe('unverified');
    expect(
      (
        await observeGitHubCi(
          { ...contract, workflows: [] },
          { timeoutMs: 1000, maxRequests: 20, get: fixture().get },
        )
      ).status,
    ).toBe('unverified');
  });
});

it('allocates a bounded production request budget for three workflows and paginated jobs', async () => {
  const workflows = [1, 2, 3].map((id) => ({
    id,
    path: `.github/workflows/test${id}.yml`,
    configurationSha: configSha,
    requiredJobs: ['job-1', 'job-101'],
  }));
  const target = { ...contract, workflows };
  // Production callers use the builder default, not a hand-expanded test allowance.
  const argv = buildCiObserverArgv(target, 2000);
  let calls = 0;
  const get = async (route: string) => {
    calls++;
    if (route === 'repos/owner/project')
      return { id: 5, full_name: 'owner/project' };
    const run = (id: number) => ({
      id: id * 10,
      run_number: 1,
      run_attempt: 1,
      workflow_id: id,
      path: `.github/workflows/test${id}.yml`,
      head_sha: sha,
      event: 'push',
      repository: { id: 5 },
      status: 'completed',
      conclusion: 'success',
    });
    const list = route.match(/workflows\/(\d+)\/runs/);
    if (list) return { total_count: 1, workflow_runs: [run(Number(list[1]))] };
    const jobs = route.match(/runs\/(\d+)\/attempts\/1\/jobs.*page=(\d+)/);
    if (jobs)
      return {
        total_count: 101,
        jobs: Array.from({ length: jobs[2] === '1' ? 100 : 1 }, (_, i) => {
          const id = i + (jobs[2] === '1' ? 1 : 101);
          return {
            id,
            run_id: Number(jobs[1]),
            run_attempt: 1,
            head_sha: sha,
            name: `job-${id}`,
            status: 'completed',
            conclusion: 'success',
          };
        }),
      };
    const detail = route.match(/runs\/(\d+)$/);
    if (detail) return run(Number(detail[1]) / 10);
    if (route.includes('/contents/')) return { sha: configSha };
    throw new Error(route);
  };
  const observed = await observeGitHubCi(target, {
    timeoutMs: 2000,
    maxRequests: Number(argv[5]),
    get,
  });
  expect(observed.status, observed.reasons.join(',')).toBe('passed');
  expect(calls).toBe(25);
  expect(Number(argv[5])).toBeLessThanOrEqual(1000);
});

it('keeps legacy bounded observer receipts valid across target key order, and rejects substitutions', () => {
  const argv = buildCiObserverArgv(contract, 2000, 20);
  argv[3] = JSON.stringify(
    Object.fromEntries(Object.entries(contract).reverse()),
  );
  const run = { argv, runnerArgv: argv, cwd: '.', timeoutMs: 2000 };
  expect(() => assertCiObserverInvocation(run, contract)).not.toThrow();
  expect(() =>
    assertCiObserverInvocation(
      { ...run, argv: ['node', '-e', 'console.log("passed")', argv[3] ?? ''] },
      contract,
    ),
  ).toThrow('CI_OBSERVER_REQUIRED');
  expect(() =>
    assertCiObserverInvocation(
      { ...run, runnerArgv: ['node', 'custom.js'] },
      contract,
    ),
  ).toThrow('CI_OBSERVER_REQUIRED');
  expect(() =>
    assertCiObserverInvocation(run, {
      ...contract,
      candidateSha: 'c'.repeat(40),
    }),
  ).toThrow('CI_OBSERVER_REQUIRED');
  expect(() =>
    assertCiObserverInvocation({ ...run, cwd: 'nested' }, contract),
  ).toThrow('CI_OBSERVER_REQUIRED');
  expect(() =>
    ciObserverRequestBudget({
      ...contract,
      workflows: Array.from({ length: 143 }, (_, index) => ({
        path: '.github/workflows/quality.yml',
        configurationSha: configSha,
        requiredJobs: ['test'],
        id: index + 1,
      })),
    }),
  ).toThrow('CI_REQUEST_CONTRACT_TOO_LARGE');
});

import { describe, expect, it } from 'vitest';
import type { CiContract } from '../src/runtime/execution-protocol.js';
import {
  buildCiObserverArgv,
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
    const result = await observeGitHubCi(contract, {
      timeoutMs: 1000,
      maxRequests: 20,
      get: provider.get,
    });
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

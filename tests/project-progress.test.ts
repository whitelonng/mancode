import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import type { ConfirmedDecisionV2 } from '../src/context/decision-record.js';
import {
  ProjectProgressController,
  projectProgressData,
  projectProgressTask,
} from '../src/context/project-progress.js';
import type {
  StoredProjectSnapshot,
  StoredTaskSnapshot,
  V3ContextStore,
} from '../src/context/store.js';
import { renderProjectProgressHtml } from '../src/templates/project-progress.js';

function task(namespace: 'local' | 'shared' = 'local'): StoredTaskSnapshot {
  return {
    metadata: {
      taskRef: { namespace, taskId: '01JZ4B6W5Z0A1B2C3D4E5F6G7H' },
      task: namespace === 'local' ? 'PRIVATE local work' : 'Shared work',
      status: 'in_progress',
      currentStep: 5,
      ownerActorId: null,
      revision: 1,
      implementationScope: { modules: ['runtime'] },
      governance: {
        planDecision: 'governed_execution',
        planVersion: 1,
        requirementsDigest: 'requirements',
        reviewStatus: 'pending',
        verificationStatus: 'pending',
      },
      blockingReason: null,
      transitionState: 'stable',
      updatedAt: '2026-09-15T00:00:00.000Z',
    },
    requirements: { contentDigest: 'requirements', acceptanceCriteria: [] },
    verification: {
      checks: [],
      planVersion: 1,
      requirementsDigest: 'requirements',
    },
    aggregate: {},
    latestCheckpoint: null,
    fingerprint: 'task-1',
  } as unknown as StoredTaskSnapshot;
}
const project = {
  config: { transport: { mode: 'local' } },
  confirmedDecisions: [],
  privacy: null,
  fingerprint: 'project-1',
} as unknown as StoredProjectSnapshot;
const identity = {
  workspaceId: 'workspace',
  checkoutId: 'checkout',
  projectName: 'Example',
};

describe('project progress projection', () => {
  it('separates lifecycle, verification and failure reasons without inventing completion', () => {
    const value = task();
    value.metadata.governance.verificationStatus = 'passed';
    expect(projectProgressTask(value)).toMatchObject({
      state: '进行中',
      issue: 'evidence_stale',
    });
    value.metadata.status = 'completed';
    expect(projectProgressTask(value)).toMatchObject({
      state: '已完成',
      issue: 'evidence_stale',
    });
    value.metadata.status = 'blocked';
    expect(projectProgressTask(value)).toMatchObject({
      state: '已暂停',
      issue: 'business_blocker',
    });
    value.metadata.status = 'in_progress';
    value.metadata.governance.verificationStatus = 'failed';
    expect(projectProgressTask(value).issue).toBe('test_failed');
  });
  it('distinguishes a plan-only decision from an ordinary planned task', () => {
    const value = task();
    value.metadata.status = 'planned';
    expect(projectProgressTask(value).state).toBe('未开始');
    value.metadata.governance.planDecision = 'plan_only';
    expect(projectProgressTask(value).state).toBe('仅规划');
    value.metadata.status = 'blocked';
    value.metadata.blockingReason = 'External dependency';
    expect(projectProgressTask(value)).toMatchObject({
      state: '已暂停',
      issue: 'business_blocker',
      publication: 'unobserved',
    });
    value.metadata.status = 'completed';
    expect(projectProgressTask(value).state).toBe('已完成');
  });
  it('keeps publication unobserved for completed tasks and older cached rows', () => {
    const value = task();
    value.metadata.status = 'completed';
    expect(projectProgressTask(value).publication).toBe('unobserved');
    const data = projectProgressData(
      { project, tasks: [value], ...identity },
      'local-preview',
      'now',
    );
    data.tasks[0].publication = undefined;
    expect(renderProjectProgressHtml(data, false)).toContain(
      '发布状态：暂无可验证的本地发布记录',
    );
  });
  it('filters local titles, counts, modules and timeline before producing a shared snapshot', () => {
    const data = projectProgressData(
      { project, tasks: [task(), task('shared')], ...identity },
      'shared-snapshot',
      'now',
    );
    expect(data.totals.registered).toBe(1);
    expect(data.checkoutId).toBeNull();
    expect(JSON.stringify(data)).not.toContain('PRIVATE');
    expect(JSON.stringify(data)).not.toContain('local:');
    const html = renderProjectProgressHtml(data, false);
    expect(html).toContain('mancode:project-progress:2');
    expect(html).toContain('离线共享快照');
    expect(html).not.toContain('https://');
  });
  it('renders partial decisions using only their remaining active clauses', () => {
    const a = {
      schemaVersion: 2,
      decisionId: '01JZ4B6W5Z0A1B2C3D4E5F6G71',
      title: 'Rule',
      statement: 'STALE ORIGINAL SUMMARY',
      taskRef: null,
      confirmedAt: '2026-09-15T00:00:00.000Z',
      details: {
        capability: 'decision-relations:1',
        recordKind: 'decision',
        applicability: { modules: ['runtime'], paths: [] },
        rationale: 'Reason',
        alternatives: [],
        tradeoffs: [],
        revisitWhen: [],
        clauses: [
          { id: 'old', statement: 'Retired clause' },
          { id: 'active', statement: 'Remaining clause' },
        ],
        relations: [],
      },
    } as unknown as ConfirmedDecisionV2;
    const b = {
      ...a,
      decisionId: '01JZ4B6W5Z0A1B2C3D4E5F6G72',
      statement: 'Replacement',
      details: {
        ...a.details,
        relations: [
          {
            action: 'supersede' as const,
            targetId: a.decisionId,
            targetDigest: digestCanonicalJson(a),
            clauses: ['old'],
          },
        ],
      },
    };
    const data = projectProgressData(
      {
        ...identity,
        tasks: [],
        project: { ...project, confirmedDecisions: [a, b] },
      },
      'local-preview',
      'now',
    );
    const partial = data.decisions.find((item) => item.id === a.decisionId);
    expect(partial).toMatchObject({
      state: 'partial',
      statement: 'Remaining clause',
    });
    expect(JSON.stringify(partial)).not.toContain('STALE ORIGINAL SUMMARY');
    expect(JSON.stringify(partial)).not.toContain('Retired clause');
  });
  it('escapes inert JSON and never embeds project strings as executable markup', () => {
    const value = task();
    value.metadata.task = '</script><script>alert(1)</script>';
    const html = renderProjectProgressHtml(
      projectProgressData(
        { project, tasks: [value], ...identity },
        'local-preview',
        'now',
      ),
      true,
    );
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('\\u003c/script\\u003e');
  });
  it.each([10, 1000, 10000])(
    'does no authority IO on idle version polls with %i tasks',
    async (count) => {
      let list = 0;
      let reads = 0;
      let projects = 0;
      const values = Array.from({ length: count }, (_, i) => ({
        ...task(),
        metadata: {
          ...task().metadata,
          taskRef: { namespace: 'local', taskId: String(i).padStart(26, '0') },
        },
      }));
      const store = {
        readProjectSnapshot: async () => {
          projects++;
          return project;
        },
        listWorkflowMetadata: async () => {
          list++;
          return values.map((value) => value.metadata);
        },
        readTaskSnapshot: async (ref: { taskId: string }) => {
          reads++;
          return values[Number(ref.taskId)];
        },
      } as unknown as V3ContextStore;
      const controller = new ProjectProgressController(store, identity);
      await controller.refresh();
      const baseline = { list, reads, projects };
      for (let i = 0; i < 100; i++) controller.version();
      await controller.refresh();
      expect({ list, reads, projects }).toEqual(baseline);
      controller.invalidate({ taskRefs: [values[0].metadata.taskRef] });
      await controller.refresh();
      expect(list).toBe(baseline.list);
      expect(projects).toBe(baseline.projects);
      expect(reads).toBe(baseline.reads + 2);
    },
  );
});

it('does not label an optional failed criterion as accepted when required checks passed', () => {
  const value = task();
  const subject = { contentDigest: 'current', environment: 'local' };
  value.metadata.governance.verificationStatus = 'passed';
  value.requirements.acceptanceCriteria = [
    {
      criterionId: 'required',
      displayId: 'AC-1',
      statement: 'Required criterion',
    },
    {
      criterionId: 'optional',
      displayId: 'AC-2',
      statement: 'Optional criterion',
    },
  ] as never;
  value.verification.checks = [
    {
      criterionId: 'required',
      required: true,
      verificationRequirement: 'automated',
      automated: { status: 'passed', subject },
    },
    {
      criterionId: 'optional',
      required: false,
      verificationRequirement: 'automated',
      automated: { status: 'failed', subject },
    },
  ] as never;
  const result = projectProgressTask(value, subject as never);
  expect(result.state).toBe('已验收');
  expect(result.acceptance.find((item) => item.id === 'AC-2')?.state).toBe(
    '失败',
  );
});

it('keeps an optional pending criterion pending despite required acceptance', () => {
  const value = task();
  const subject = { contentDigest: 'current', environment: 'local' };
  value.metadata.governance.verificationStatus = 'passed';
  value.requirements.acceptanceCriteria = [
    {
      criterionId: 'pending',
      displayId: 'AC-2',
      statement: 'Pending optional',
    },
  ] as never;
  value.verification.checks = [
    {
      criterionId: 'required',
      required: true,
      verificationRequirement: 'automated',
      automated: { status: 'passed', subject },
    },
    {
      criterionId: 'pending',
      required: false,
      verificationRequirement: 'manual',
      manual: { status: 'pending' },
    },
  ] as never;
  expect(projectProgressTask(value, subject).acceptance[0].state).toBe(
    '待验证',
  );
});

it('does not retain an old observed content subject through an unqualified full refresh', async () => {
  const value = task();
  const subject = { contentDigest: 'previous-source', environment: 'local' };
  value.metadata.governance.verificationStatus = 'passed';
  value.verification.checks = [
    {
      criterionId: 'required',
      required: true,
      verificationRequirement: 'automated',
      automated: { status: 'passed', subject },
    },
  ] as never;
  const store = {
    readProjectSnapshot: async () => project,
    listWorkflowMetadata: async () => [value.metadata],
    readTaskSnapshot: async () => value,
  } as unknown as V3ContextStore;
  const controller = new ProjectProgressController(store, identity);
  controller.invalidate({
    currentSubjects: {
      [`local:${value.metadata.taskRef.taskId}`]: subject as never,
    },
  });
  await controller.refresh();
  expect(controller.data().tasks[0]?.state).toBe('已验收');
  // The observer supplies no fresh source subject at this new full reconciliation.
  controller.invalidate({ full: true, reason: 'notification_gap' });
  await controller.refresh();
  expect(controller.data().tasks[0]?.issue).toBe('evidence_stale');
});

import { describe, expect, it } from 'vitest';
import { resolveWorkflowCreation } from '../src/context/creation-resolution.js';
import { assessTeam } from '../src/team/assessment.js';

const PARENT_TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';

describe('team assessment and workflow creation resolution', () => {
  it('requires both recent collaborators and a coordination path for auto team', () => {
    const single = assessTeam({
      policy: 'auto',
      signals: {
        isGitRepository: true,
        remoteCount: 1,
        contributorsAllTime: 4,
        contributorsRecent: 1,
        hasTrackedUpstream: true,
        hasCodeowners: true,
        hasPullRequestTemplate: true,
      },
      evaluatedAt: '2026-07-17T12:00:00.000Z',
    });
    expect(single.recommendation).toBe('single');
    expect(single.reasons).toContain(
      'historical contributors do not trigger team mode alone',
    );

    const team = assessTeam({
      policy: 'auto',
      signals: {
        isGitRepository: true,
        remoteCount: 1,
        contributorsAllTime: 4,
        contributorsRecent: 2,
        hasTrackedUpstream: true,
        hasCodeowners: false,
        hasPullRequestTemplate: false,
      },
      evaluatedAt: '2026-07-17T12:00:00.000Z',
    });
    expect(team).toMatchObject({
      recommendation: 'team',
      source: 'auto',
      confidence: 'high',
    });
  });

  it('returns assessment without letting it silently change a man workflow', () => {
    const assessment = assessTeam({
      policy: 'on',
      signals: null,
      evaluatedAt: '2026-07-17T12:00:00.000Z',
    });
    const resolution = resolveWorkflowCreation({
      workflowMode: 'man',
      parent: null,
      policy: { defaultVisibility: 'shared' },
      assessment,
    });
    expect(resolution.descriptor).toEqual({
      workflowMode: 'man',
      visibility: 'shared',
      coordination: 'single',
      parent: null,
    });
    expect(resolution.dimensions.visibility.source).toBe('policy_default');
    expect(resolution.dimensions.coordination.source).toBe('mode_constraint');
    expect(resolution.sharedPrivacyConfirmationRequired).toBe(true);
    expect(resolution.assessment?.recommendation).toBe('team');
  });

  it('makes child dimensions inherit from the parent and rejects conflicts', () => {
    const resolution = resolveWorkflowCreation({
      workflowMode: 'manba',
      parent: {
        taskRef: { namespace: 'shared', taskId: PARENT_TASK_ID },
        workflowMode: 'manteam',
        visibility: 'shared',
        coordination: 'team',
      },
      policy: { defaultVisibility: 'local' },
      assessment: null,
    });
    expect(resolution.descriptor).toMatchObject({
      visibility: 'shared',
      coordination: 'team',
    });
    expect(resolution.dimensions.visibility.source).toBe('parent');

    expect(() =>
      resolveWorkflowCreation({
        workflowMode: 'manba',
        parent: {
          taskRef: { namespace: 'shared', taskId: PARENT_TASK_ID },
          workflowMode: 'manteam',
          visibility: 'shared',
          coordination: 'team',
        },
        visibility: 'local',
        policy: null,
        assessment: null,
      }),
    ).toThrow(/inherit/);
  });

  it('enforces the standalone and manteam mode boundaries', () => {
    expect(() =>
      resolveWorkflowCreation({
        workflowMode: 'manba',
        parent: null,
        visibility: 'shared',
        policy: null,
        assessment: null,
      }),
    ).toThrow(/standalone manba/);
    expect(() =>
      resolveWorkflowCreation({
        workflowMode: 'manteam',
        parent: null,
        coordination: 'single',
        policy: null,
        assessment: null,
      }),
    ).toThrow(/manteam coordination/);
  });
});

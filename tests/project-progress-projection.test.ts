import { expect, it } from 'vitest';
import {
  buildProgressViews,
  updateProgressViews,
} from '../src/context/project-progress-projection.js';
import type {
  ProgressAuthority,
  ProgressTask,
} from '../src/context/project-progress.js';
const authority = {
  workspaceId: 'workspace',
  checkoutId: 'checkout',
  projectName: 'Example',
  tasks: [],
  project: {
    config: { transport: { mode: 'local' } },
    confirmedDecisions: [],
    privacy: null,
  },
} as unknown as ProgressAuthority;
const row = (id: string): ProgressTask => ({
  id,
  source: id,
  title: id,
  namespace: 'local',
  revision: 1,
  state: '进行中',
  phase: 1,
  owner: null,
  modules: ['core'],
  reason: null,
  issue: null,
  next: null,
  updatedAt: '2026-01-01T00:00:00Z',
  acceptance: [],
});
it('updates only one projected row and keeps shared data unchanged', () => {
  const tasks = Array.from({ length: 10000 }, (_, i) =>
    row(`local:${i.toString().padStart(26, '0')}`),
  );
  const initial = buildProgressViews(authority, tasks, '2026-01-01T00:00:00Z');
  const after = {
    ...tasks[0],
    state: '已暂停',
    issue: 'business_blocker',
    revision: 2,
  } as ProgressTask;
  const next = updateProgressViews(
    initial,
    tasks[0],
    after,
    '2026-01-02T00:00:00Z',
  );
  expect(next?.['local-preview'].totals.blocked).toBe(1);
  expect(next?.['local-preview'].tasks).toHaveLength(100);
  expect(next?.['shared-snapshot']).toEqual(initial['shared-snapshot']);
  expect(next?.['local-preview'].modules[0].registered).toBe(10000);
});
it('requests safe-index refill if a visible row is removed from a truncated window', () => {
  const tasks = Array.from({ length: 101 }, (_, i) =>
    row(String(i).padStart(5, '0')),
  );
  expect(
    updateProgressViews(
      buildProgressViews(authority, tasks, 'now'),
      tasks[0],
      null,
      'later',
    ),
  ).toBeNull();
});

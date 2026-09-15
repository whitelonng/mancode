import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  saveProgressProjectionCache,
  updateProgressProjectionCache,
} from '../src/context/project-progress-cache.js';
import { ProjectProgressController } from '../src/context/project-progress.js';
import * as progress from '../src/context/project-progress.js';
import type {
  StoredProjectSnapshot,
  StoredTaskSnapshot,
  V3ContextStore,
} from '../src/context/store.js';
function fixtureTask(index: number): StoredTaskSnapshot {
  return {
    metadata: {
      taskRef: { namespace: 'local', taskId: String(index).padStart(26, '0') },
      task: `Performance task ${index}`,
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
    fingerprint: `task-${index}-1`,
  } as unknown as StoredTaskSnapshot;
}

it('updates only one bucket and bounded head with 10000 tasks, without restoring all authority', async () => {
  const values = Array.from({ length: 10000 }, (_, i) => fixtureTask(i));
  const project = {
    config: { transport: { mode: 'local' } },
    confirmedDecisions: [],
    privacy: null,
    fingerprint: 'p',
  } as unknown as StoredProjectSnapshot;
  const counts = { enumerations: 0, projects: 0, tasks: 0 };
  const store = {
    readProjectSnapshot: async () => {
      counts.projects++;
      return project;
    },
    listWorkflowMetadata: async () => {
      counts.enumerations++;
      return values.map((v) => v.metadata);
    },
    readTaskSnapshot: async (ref: { taskId: string }) => {
      counts.tasks++;
      return values[Number(ref.taskId)];
    },
  } as unknown as V3ContextStore;
  const identity = {
    workspaceId: 'workspace',
    checkoutId: 'checkout',
    projectName: 'Example',
  };
  const controller = new ProjectProgressController(store, identity);
  await controller.refresh();
  const root = await mkdtemp(path.join(tmpdir(), 'progress-cache-io-'));
  const reads: string[] = [];
  const writes: string[] = [];
  let readBytes = 0;
  let writeBytes = 0;
  const io = {
    read: async (name: string) => {
      reads.push(name);
      const value = await readFile(path.join(root, name), 'utf8').catch(
        (error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      readBytes += Buffer.byteLength(value ?? '');
      return value;
    },
    write: async (name: string, value: unknown) => {
      writes.push(name);
      const text = JSON.stringify(value);
      writeBytes += Buffer.byteLength(text);
      await writeFile(path.join(root, name), text);
    },
  };
  await saveProgressProjectionCache(io, root, identity, 1, controller);
  reads.length = 0;
  writes.length = 0;
  readBytes = 0;
  writeBytes = 0;
  counts.enumerations = 0;
  counts.projects = 0;
  counts.tasks = 0;
  const screen = vi.spyOn(progress, 'screenProgressTask');
  const changed = fixtureTask(0);
  changed.metadata.status = 'blocked';
  changed.metadata.blockingReason = 'Fixture blocker';
  changed.fingerprint = 'new';
  values[0] = changed;
  const start = performance.now();
  const next = await updateProgressProjectionCache(
    io,
    root,
    identity,
    1,
    2,
    store,
    { taskRefs: [changed.metadata.taskRef] },
  );
  const elapsedMs = performance.now() - start;
  expect(counts).toEqual({ enumerations: 0, projects: 0, tasks: 2 });
  expect(reads.filter((name) => name.startsWith('rows-'))).toHaveLength(1);
  expect(writes.filter((name) => name.startsWith('rows-'))).toHaveLength(1);
  expect(screen).toHaveBeenCalledTimes(1);
  expect(next.data().totals.blocked).toBe(1);
  expect(readBytes).toBeLessThan(250000);
  expect(writeBytes).toBeLessThan(250000);
  console.log(
    JSON.stringify({
      count: 10000,
      elapsedMs,
      readBytes,
      writeBytes,
      reads: reads.length,
      writes: writes.length,
      reprojectedTasks: screen.mock.calls.length,
      ...counts,
    }),
  );
  reads.length = 0;
  writes.length = 0;
  screen.mockClear();
  const moved = fixtureTask(0);
  moved.metadata.implementationScope.modules = ['other'];
  moved.fingerprint = 'moved';
  values[0] = moved;
  const boundary = await updateProgressProjectionCache(
    io,
    root,
    identity,
    2,
    3,
    store,
    { taskRefs: [moved.metadata.taskRef] },
  );
  expect(screen).toHaveBeenCalledTimes(1);
  expect(
    boundary.data().modules.find((module) => module.name === 'runtime')
      ?.registered,
  ).toBe(9999);
  expect(
    boundary.data().modules.find((module) => module.name === 'other')
      ?.registered,
  ).toBe(1);
  expect(boundary.data().totals.registered).toBe(10000);
  const bucket = reads.find((name) => name.startsWith('rows-'));
  if (!bucket) throw new Error('bucket was not read');
  await writeFile(path.join(root, bucket), 'broken');
  await expect(
    updateProgressProjectionCache(io, root, identity, 3, 4, store, {
      taskRefs: [moved.metadata.taskRef],
    }),
  ).rejects.toThrow();
  screen.mockRestore();
  await rm(root, { recursive: true, force: true });
});

it('does not reread the entire decision corpus for an unrelated task-only event', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'progress-decision-head-'));
  try {
    const value = fixtureTask(0);
    const decisions = Array.from({ length: 10000 }, (_, i) => ({
      schemaVersion: 1,
      decisionId: String(i).padStart(26, '0'),
      title: `Decision ${i}`,
      statement: 'Rule '.repeat(200),
      taskRef: null,
      confirmedAt: '2026-09-15T00:00:00.000Z',
    }));
    const project = {
      config: { transport: { mode: 'local' } },
      confirmedDecisions: decisions,
      privacy: null,
      fingerprint: 'p',
    } as unknown as StoredProjectSnapshot;
    let projectReads = 0;
    const store = {
      readProjectSnapshot: async () => {
        projectReads++;
        return project;
      },
      listWorkflowMetadata: async () => [value.metadata],
      readTaskSnapshot: async () => value,
    } as unknown as V3ContextStore;
    const identity = {
      workspaceId: 'workspace',
      checkoutId: 'checkout',
      projectName: 'Example',
    };
    const controller = new ProjectProgressController(store, identity);
    await controller.refresh();
    let readBytes = 0;
    let writeBytes = 0;
    const io = {
      read: async (name: string) => {
        const raw = await readFile(path.join(root, name), 'utf8');
        readBytes += Buffer.byteLength(raw);
        return raw;
      },
      write: async (name: string, value: unknown) => {
        const raw = JSON.stringify(value);
        writeBytes += Buffer.byteLength(raw);
        await writeFile(path.join(root, name), raw);
      },
    };
    await saveProgressProjectionCache(io, root, identity, 1, controller);
    readBytes = 0;
    writeBytes = 0;
    projectReads = 0;
    value.metadata.status = 'blocked';
    value.metadata.blockingReason = 'New blocker';
    value.fingerprint = 'changed';
    const next = await updateProgressProjectionCache(
      io,
      root,
      identity,
      1,
      2,
      store,
      { taskRefs: [value.metadata.taskRef] },
    );
    console.log(
      JSON.stringify({ decisions: 10000, tasks: 1, readBytes, writeBytes }),
    );
    expect(readBytes).toBeLessThan(1000000);
    expect(writeBytes).toBeLessThan(1000000);
    expect(projectReads).toBe(0);
    const raw = await readFile(path.join(root, 'cache.json'), 'utf8');
    const head = JSON.parse(raw);
    expect(head.schemaVersion).toBe(3);
    expect(head.project).toBeUndefined();
    expect(raw).not.toContain('confirmedDecisions');
    expect(next.data().decisions).toHaveLength(100);
    expect(next.data().omissions.decisions).toBe(9900);
    value.metadata.implementationScope.modules = ['other'];
    value.fingerprint = 'module-change';
    const refilled = await updateProgressProjectionCache(
      io,
      root,
      identity,
      2,
      3,
      store,
      { taskRefs: [value.metadata.taskRef] },
    );
    expect(refilled.data().decisions).toEqual(next.data().decisions);
    expect(refilled.data().omissions.decisions).toBe(9900);
    expect(
      refilled.data().timeline.length + refilled.data().omissions.timeline,
    ).toBe(10001);
    expect(refilled.data().modules[0].name).toBe('other');
    expect(projectReads).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { startProjectProgressPreview } from '../src/context/project-progress-server.js';
import {
  bindProjectProgress,
  writeProjectProgressSnapshot,
} from '../src/context/project-progress-storage.js';
import { ProjectProgressController } from '../src/context/project-progress.js';
import type {
  StoredProjectSnapshot,
  StoredTaskSnapshot,
  V3ContextStore,
} from '../src/context/store.js';
import * as atomicFile from '../src/runtime/atomic-file.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';

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

it.each([10, 1000, 10000])(
  'measures projection IO and elapsed work with %i registered tasks',
  async (count) => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'mancode-progress-performance-'),
    );
    let preview:
      | Awaited<ReturnType<typeof startProjectProgressPreview>>
      | undefined;
    try {
      await initializeV3Project({ projectRoot: root });
      await bindProjectProgress(root);
      const runtime = await readProjectRuntimeContext(root);
      const identity = {
        workspaceId: runtime.workspaceId,
        checkoutId: runtime.checkoutId,
        projectName: 'Performance fixture',
      };
      const counters = {
        taskEnumerations: 0,
        projectReads: 0,
        taskReads: 0,
        htmlWrites: 0,
        notificationReads: 0,
      };
      const values = Array.from({ length: count }, (_, index) =>
        fixtureTask(index),
      );
      const project = {
        config: { transport: { mode: 'local' } },
        confirmedDecisions: [],
        privacy: null,
        fingerprint: 'project-1',
      } as unknown as StoredProjectSnapshot;
      const store = {
        readProjectSnapshot: async () => {
          counters.projectReads++;
          return project;
        },
        listWorkflowMetadata: async () => {
          counters.taskEnumerations++;
          return values.map((value) => value.metadata);
        },
        readTaskSnapshot: async (ref: { taskId: string }) => {
          counters.taskReads++;
          return values[Number(ref.taskId)];
        },
      } as unknown as V3ContextStore;
      const controller = new ProjectProgressController(store, identity);
      const replace = atomicFile.replaceFileAtomically;
      vi.spyOn(atomicFile, 'replaceFileAtomically').mockImplementation(
        async (source, target) => {
          if (target === path.join(root, '项目进度.html'))
            counters.htmlWrites++;
          return replace(source, target);
        },
      );
      const mark = () => ({
        started: performance.now(),
        counters: { ...counters },
      });
      const measure = (before: ReturnType<typeof mark>) => ({
        elapsedMs: Number((performance.now() - before.started).toFixed(2)),
        ...Object.fromEntries(
          Object.entries(counters).map(([key, value]) => [
            key,
            value - before.counters[key as keyof typeof counters],
          ]),
        ),
      });
      const initialStart = mark();
      await controller.refresh();
      const initialSnapshot = await writeProjectProgressSnapshot(
        root,
        controller,
        null,
      );
      const initial = measure(initialStart);
      const signal = path.join(root, 'signal.json');
      await writeFile(signal, JSON.stringify({ revision: 1, change: {} }));
      preview = await startProjectProgressPreview(controller, {
        readNotification: async () => {
          counters.notificationReads++;
          return JSON.parse(await readFile(signal, 'utf8'));
        },
      });
      const baselineStart = mark();
      await fetch(`${preview.url}/api/version`);
      const previewBaseline = measure(baselineStart);
      const beforeHtml = await stat(path.join(root, '项目进度.html'));
      const idleStart = mark();
      for (let i = 0; i < 25; i++) {
        const status = await fetch(`${preview.url}/api/version`).then(
          (response) => response.json(),
        );
        expect(status.stale).toBe(false);
      }
      const idle25 = measure(idleStart);
      expect(counters.taskReads).toBe(4 * count);
      expect((await stat(path.join(root, '项目进度.html'))).mtimeMs).toBe(
        beforeHtml.mtimeMs,
      );
      const changed = fixtureTask(0);
      changed.metadata.revision = 2;
      changed.metadata.status = 'blocked';
      changed.metadata.blockingReason = 'Performance fixture dependency';
      changed.fingerprint = 'task-0-2';
      values[0] = changed;
      await writeFile(
        signal,
        JSON.stringify({
          revision: 2,
          change: { taskRefs: [changed.metadata.taskRef] },
        }),
      );
      const eventStart = mark();
      const version = await fetch(`${preview.url}/api/version`).then(
        (response) => response.json(),
      );
      expect(version.stale).toBe(false);
      await writeProjectProgressSnapshot(
        root,
        controller,
        initialSnapshot.version,
      );
      const taskEvent = measure(eventStart);
      expect(taskEvent).toMatchObject({
        taskEnumerations: 0,
        projectReads: 0,
        taskReads: 2,
        htmlWrites: 1,
      });
      const serializeStart = performance.now();
      const serialized = JSON.stringify(controller.exportAuthority());
      const serializeMs = performance.now() - serializeStart;
      const restoreStart = performance.now();
      const restored = new ProjectProgressController(store, identity);
      restored.restoreAuthority(
        JSON.parse(serialized),
        new Date().toISOString(),
      );
      const parseAndReprojectMs = performance.now() - restoreStart;
      console.log(
        JSON.stringify({
          count,
          initial,
          previewBaseline,
          idle25,
          taskEvent,
          authorityRoundtrip: {
            bytes: Buffer.byteLength(serialized),
            serializeMs: Number(serializeMs.toFixed(2)),
            parseAndReprojectMs: Number(parseAndReprojectMs.toFixed(2)),
          },
          scope:
            'In-memory authority fixture, real HTTP/signal reads/HTML atomic publication. Authority roundtrip excludes production cache schema validation and CLI startup. Event updates one task projection and bounded views. Authority roundtrip is a full-repair diagnostic, not the incremental cache path.',
        }),
      );
    } finally {
      await preview?.close();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

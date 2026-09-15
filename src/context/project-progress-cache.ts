import { randomUUID } from 'node:crypto';
import { digestCanonicalJson } from './canonical.js';
import {
  type ProgressViews,
  buildProgressViews,
  updateProgressViews,
} from './project-progress-projection.js';
import {
  type ProgressInvalidation,
  type ProgressTask,
  ProjectProgressController,
  type ProjectProgressData,
  screenProgressTask,
} from './project-progress.js';
import type { StoredProjectSnapshot, V3ContextStore } from './store.js';
import { formatTaskRef } from './task-ref.js';

export interface ProgressCacheIO {
  read(name: string): Promise<string | null>;
  write(name: string, value: unknown): Promise<void>;
  prune?(generation: string): Promise<void>;
}
interface Identity {
  workspaceId: string;
  checkoutId: string;
  projectName: string;
}
interface CacheHead {
  schemaVersion: 3;
  revision: number;
  root: string;
  identity: Identity;
  generation: string;
  screening: ReturnType<ProjectProgressController['exportScreening']>;
  projectView: ProjectProgressData;
  views: ProgressViews;
  buckets: Record<string, string>;
  digest: string;
}
const bucketFor = (id: string) => digestCanonicalJson(id).slice(7, 9);
function verify<T extends { digest: string }>(value: T): T {
  const { digest, ...payload } = value;
  if (digest !== digestCanonicalJson(payload))
    throw new Error('MANCODE_PROGRESS_CACHE_INVALID');
  return value;
}
const checked = (value: unknown): ProgressTask => {
  const row = value as ProgressTask;
  if (
    !row ||
    typeof row !== 'object' ||
    !/^local:[0-9A-Z]{26}$|^shared:[0-9A-Z]{26}$/.test(row.id) ||
    row.source !== row.id ||
    !['local', 'shared'].includes(row.namespace) ||
    !row.id.startsWith(`${row.namespace}:`) ||
    typeof row.title !== 'string' ||
    !Number.isSafeInteger(row.revision) ||
    !Array.isArray(row.modules) ||
    !row.modules.every((item) => typeof item === 'string') ||
    !Array.isArray(row.acceptance) ||
    typeof row.updatedAt !== 'string' ||
    ![
      '未开始',
      '仅规划',
      '进行中',
      '待审核',
      '已验收',
      '已完成',
      '已暂停',
      '已放弃',
      '已替代',
      '需核对',
    ].includes(row.state)
  )
    throw new Error('MANCODE_PROGRESS_CACHE_INVALID');
  return row;
};
async function readHead(
  io: ProgressCacheIO,
  root: string,
  identity: Identity,
  revision: number,
): Promise<CacheHead> {
  const raw = await io.read('cache.json');
  if (raw === null) throw new Error('MANCODE_PROGRESS_CACHE_MISSING');
  const head = verify(JSON.parse(raw) as CacheHead);
  if (
    head.schemaVersion !== 3 ||
    head.root !== root ||
    head.revision !== revision ||
    JSON.stringify(head.identity) !== JSON.stringify(identity) ||
    !/^[-a-f0-9]{36}$/.test(head.generation) ||
    !head.buckets ||
    Object.keys(head.buckets).some((key) => !/^[a-f0-9]{2}$/.test(key)) ||
    !head.screening ||
    !head.projectView ||
    !head.views
  )
    throw new Error('MANCODE_PROGRESS_CACHE_INVALID');
  for (const mode of [
    'local-preview',
    'local-snapshot',
    'shared-snapshot',
  ] as const) {
    for (const view of [
      head.views[mode],
      {
        ...head.projectView,
        visibility: mode,
        checkoutId: mode === 'shared-snapshot' ? null : identity.checkoutId,
      },
    ]) {
      if (
        view.schemaVersion !== 2 ||
        view.visibility !== mode ||
        view.workspaceId !== identity.workspaceId ||
        view.checkoutId !==
          (mode === 'shared-snapshot' ? null : identity.checkoutId) ||
        view.tasks.length > 100 ||
        view.modules.length > 100 ||
        view.timeline.length > 100 ||
        view.decisions.length > 100 ||
        view.pitfalls.length > 100 ||
        !Number.isFinite(Date.parse(view.generatedAt))
      )
        throw new Error('MANCODE_PROGRESS_CACHE_INVALID');
    }
  }
  if (
    head.projectView.tasks.length ||
    head.projectView.modules.length ||
    head.projectView.totals.registered !== 0
  )
    throw new Error('MANCODE_PROGRESS_CACHE_INVALID');
  return head;
}
async function rowsIn(
  io: ProgressCacheIO,
  head: CacheHead,
  bucket: string,
): Promise<ProgressTask[]> {
  const digest = head.buckets[bucket];
  if (!digest) return [];
  const raw = await io.read(`rows-${head.generation}-${bucket}.json`);
  if (raw === null) throw new Error('MANCODE_PROGRESS_CACHE_MISSING');
  const rows = JSON.parse(raw) as unknown[];
  if (!Array.isArray(rows) || digest !== digestCanonicalJson(rows))
    throw new Error('MANCODE_PROGRESS_CACHE_INVALID');
  const result = rows.map(checked);
  if (result.some((row) => bucketFor(row.id) !== bucket))
    throw new Error('MANCODE_PROGRESS_CACHE_INVALID');
  return result;
}
async function saveHead(
  io: ProgressCacheIO,
  head: Omit<CacheHead, 'digest'>,
): Promise<void> {
  await io.write('cache.json', { ...head, digest: digestCanonicalJson(head) });
}

/** Full rebuild is disposable and generation-bound; old buckets are never used by a new head. */
export async function saveProgressProjectionCache(
  io: ProgressCacheIO,
  root: string,
  identity: Identity,
  revision: number,
  controller: ProjectProgressController,
): Promise<void> {
  const generation = randomUUID();
  const buckets: Record<string, string> = {};
  const groups = new Map<string, ProgressTask[]>();
  for (const row of controller.exportRows()) {
    const key = bucketFor(row.id);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const [key, rows] of groups) {
    buckets[key] = digestCanonicalJson(rows);
    await io.write(`rows-${generation}-${key}.json`, rows);
  }
  await saveHead(io, {
    schemaVersion: 3,
    revision,
    root,
    identity,
    generation,
    screening: controller.exportScreening(),
    projectView: controller.exportProjectView(),
    views: controller.exportViews(),
    buckets,
  });
  await io.prune?.(generation);
}

/** Only target buckets are parsed/written. Boundary refill scans safe projections, never authority. */
export async function updateProgressProjectionCache(
  io: ProgressCacheIO,
  root: string,
  identity: Identity,
  previousRevision: number,
  revision: number,
  store: V3ContextStore,
  change: ProgressInvalidation,
): Promise<ProjectProgressController> {
  if (change.full || change.project)
    throw new Error('MANCODE_PROGRESS_CACHE_REBUILD');
  const head = await readHead(io, root, identity, previousRevision);
  // This object supplies screening/configuration only; raw project authority is never cached here.
  const project = {
    privacy: head.screening.privacy,
    config: { transport: { mode: head.screening.transport } },
    confirmedDecisions: [],
  } as unknown as StoredProjectSnapshot;
  const changed = new Map<string, ProgressTask[]>();
  const refs = new Map(
    (change.taskRefs ?? []).map((ref) => [formatTaskRef(ref), ref]),
  );
  for (const [id, ref] of refs) {
    const key = bucketFor(id);
    const rows = changed.get(key) ?? (await rowsIn(io, head, key));
    const old = rows.find((row) => row.id === id) ?? null;
    const first = await store.readTaskSnapshot(ref);
    const task = await store.readTaskSnapshot(ref);
    if (first.fingerprint !== task.fingerprint)
      throw new Error('MANCODE_PROGRESS_SNAPSHOT_CHANGED');
    const row = screenProgressTask(project, task, change.currentSubjects?.[id]);
    const updated = rows.filter((item) => item.id !== id);
    if (row) updated.push(row);
    changed.set(key, updated);
    const views = updateProgressViews(
      head.views,
      old,
      row,
      new Date().toISOString(),
    );
    if (views) head.views = views;
    else {
      const all: ProgressTask[] = [];
      for (const bucket of new Set([
        ...Object.keys(head.buckets),
        ...changed.keys(),
      ]))
        all.push(...(changed.get(bucket) ?? (await rowsIn(io, head, bucket))));
      head.views = buildProgressViews(
        { ...identity, project, tasks: [] },
        all,
        new Date().toISOString(),
        head.projectView,
      );
    }
  }
  const controller = new ProjectProgressController(store, identity);
  controller.restoreViews(project, head.views);
  for (const [key, rows] of changed) {
    head.buckets[key] = digestCanonicalJson(rows);
    await io.write(`rows-${head.generation}-${key}.json`, rows);
  }
  const { digest: _digest, ...payload } = head;
  await saveHead(io, { ...payload, revision });
  return controller;
}

import { digestCanonicalJson } from './canonical.js';
import {
  type ProgressAuthority,
  type ProgressTask,
  type ProgressVisibility,
  type ProjectProgressData,
  projectProgressData,
} from './project-progress.js';

export type ProgressViews = Record<ProgressVisibility, ProjectProgressData>;
const modes = ['local-preview', 'local-snapshot', 'shared-snapshot'] as const;
const compare = (a: ProgressTask, b: ProgressTask) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
const visible = (row: ProgressTask | null, mode: ProgressVisibility) =>
  row && (mode !== 'shared-snapshot' || row.namespace === 'shared')
    ? row
    : null;
const event = (row: ProgressTask) => ({
  id: row.id,
  title: `${row.title} · ${row.state}`,
  time: row.updatedAt,
  source: row.source,
});
const contributions = (row: ProgressTask) => ({
  registered: 1,
  completed: Number(row.state === '已完成'),
  accepted: Number(row.state === '已验收'),
  blocked: Number(row.issue === 'business_blocker'),
});
function seal(
  data: ProjectProgressData,
  source: unknown,
  now: string,
): ProjectProgressData {
  const { version: _version, generatedAt: _generatedAt, ...body } = data;
  return {
    ...body,
    version: digestCanonicalJson({ body, source }),
    generatedAt: now,
  };
}

/** Full reconciliation derives project data once and aggregates already-screened task rows. */
export function buildProgressViews(
  authority: ProgressAuthority,
  rows: ProgressTask[],
  now: string,
  projectData?: ProjectProgressData,
): ProgressViews {
  const result = {} as ProgressViews;
  const sorted = [...rows].sort(compare);
  for (const mode of modes) {
    const data = projectProgressData({ ...authority, tasks: [] }, mode, now);
    if (projectData) {
      data.decisions = structuredClone(projectData.decisions);
      data.timeline = structuredClone(projectData.timeline);
      data.pitfalls = structuredClone(projectData.pitfalls);
      data.omissions = { ...projectData.omissions, tasks: 0 };
      data.diagnostics = [...projectData.diagnostics];
    }
    const selected = sorted.filter((row) => visible(row, mode));
    const modules = new Map<string, string[]>();
    for (const row of selected) {
      const count = contributions(row);
      for (const key of Object.keys(count) as Array<keyof typeof count>)
        data.totals[key] += count[key];
      for (const name of row.modules) {
        const ids = modules.get(name) ?? [];
        ids.push(row.id);
        modules.set(name, ids);
      }
    }
    data.tasks = selected.slice(0, 100);
    data.modules = [...modules]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 100)
      .map(([name, tasks]) => ({
        name,
        tasks: tasks.slice(0, 100),
        registered: tasks.length,
      }));
    const timeline = [...data.timeline, ...selected.map(event)].sort(
      (a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id),
    );
    data.timeline = timeline.slice(0, 100);
    data.omissions.tasks = Math.max(0, selected.length - 100);
    data.omissions.timeline =
      Math.max(0, timeline.length - 100) + data.omissions.timeline;
    result[mode] = seal(
      data,
      selected.map((row) => digestCanonicalJson(row)),
      now,
    );
  }
  return result;
}

/** Returns null only when a bounded page needs a candidate outside its current window. */
export function updateProgressViews(
  current: ProgressViews,
  before: ProgressTask | null,
  after: ProgressTask | null,
  now: string,
): ProgressViews | null {
  const next = structuredClone(current);
  for (const mode of modes) {
    const old = visible(before, mode);
    const row = visible(after, mode);
    if (JSON.stringify(old) === JSON.stringify(row)) continue;
    const data = next[mode];
    for (const [value, sign] of [
      [old, -1],
      [row, 1],
    ] as const)
      if (value) {
        const count = contributions(value);
        for (const key of Object.keys(count) as Array<keyof typeof count>)
          data.totals[key] += sign * count[key];
      }
    const wasListed = old && data.tasks.some((item) => item.id === old.id);
    if (
      wasListed &&
      (!row || compare(row, old) > 0) &&
      data.omissions.tasks > 0
    )
      return null;
    data.tasks = data.tasks.filter(
      (item) => item.id !== old?.id && item.id !== row?.id,
    );
    if (row) data.tasks.push(row);
    data.tasks.sort(compare);
    data.tasks = data.tasks.slice(0, 100);
    data.omissions.tasks = Math.max(
      0,
      data.totals.registered - data.tasks.length,
    );
    const oldModules = new Set(old?.modules ?? []);
    const newModules = new Set(row?.modules ?? []);
    for (const name of new Set([...oldModules, ...newModules])) {
      const module = data.modules.find((item) => item.name === name);
      if (oldModules.has(name) && newModules.has(name)) continue;
      if (oldModules.has(name) && module) {
        if (
          (module.registered ?? module.tasks.length) > module.tasks.length &&
          module.tasks.includes(old?.id ?? '')
        )
          return null;
        module.registered = (module.registered ?? module.tasks.length) - 1;
        module.tasks = module.tasks.filter((id) => id !== old?.id);
        if (module.registered === 0) return null;
      }
      if (newModules.has(name) && row) {
        if (!module) return null;
        module.registered = (module.registered ?? module.tasks.length) + 1;
        module.tasks = [
          row.id,
          ...module.tasks.filter((id) => id !== row.id),
        ].slice(0, 100);
      }
    }
    const timelineListed =
      old && data.timeline.some((item) => item.id === old.id);
    if (
      timelineListed &&
      (!row || compare(row, old) > 0) &&
      data.omissions.timeline > 0
    )
      return null;
    data.timeline = data.timeline.filter(
      (item) => item.id !== old?.id && item.id !== row?.id,
    );
    if (row) data.timeline.push(event(row));
    const totalTimeline =
      data.timeline.length +
      data.omissions.timeline +
      (timelineListed ? 0 : old ? -1 : 0);
    data.timeline.sort(
      (a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id),
    );
    data.timeline = data.timeline.slice(0, 100);
    data.omissions.timeline = Math.max(0, totalTimeline - data.timeline.length);
    next[mode] = seal(
      data,
      { previous: current[mode].version, before: old, after: row },
      now,
    );
  }
  return next;
}

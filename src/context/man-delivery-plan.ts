import path from 'node:path';
import { assertKnownKeys, assertRecord } from './validation.js';

export interface ManPlanSource {
  version: 1;
  path: string;
  baseHead: string | null;
}

const SOURCE_PREFIX = '<!-- mancode:delivery-plan ';
const MARKERS = [
  '<!-- mancode:plan-baseline:start -->',
  '<!-- mancode:plan-baseline:end -->',
  '<!-- mancode:delivery-record:start -->',
  '<!-- mancode:delivery-record:end -->',
] as const;

/** Only unfenced, full-line markers define authority; examples are ordinary text. */
export function parseManPlanDocument(document: string): {
  baseline: string;
  record: string;
  recordStart: number;
  recordEnd: number;
} {
  const markers = unfencedLines(document).filter((line) =>
    (MARKERS as readonly string[]).includes(line.marker),
  );
  if (
    markers.length !== 4 ||
    markers.some((value, index) => value.marker !== MARKERS[index])
  ) {
    throw new Error('MANCODE_MAN_PLAN_MARKERS_INVALID');
  }
  const [baselineStart, baselineEnd, recordStart, recordEnd] = markers;
  if (!baselineStart || !baselineEnd || !recordStart || !recordEnd) {
    throw new Error('MANCODE_MAN_PLAN_MARKERS_INVALID');
  }
  const baseline = document.slice(baselineStart.end, baselineEnd.start).trim();
  if (!baseline) throw new Error('MANCODE_MAN_PLAN_BASELINE_REQUIRED');
  return {
    baseline,
    record: document.slice(recordStart.end, recordEnd.start).trim(),
    recordStart: recordStart.end,
    recordEnd: recordEnd.start,
  };
}

export function manProgressTaskId(baseline: string): string | null {
  const bindings = unfencedLines(baseline)
    .map(
      (line) =>
        /^<!-- mancode:progress-task ([a-zA-Z0-9:_-]+) -->$/.exec(
          line.marker,
        )?.[1],
    )
    .filter((id): id is string => id !== undefined);
  if (bindings.length > 1)
    throw new Error('ambiguous plan progress task binding');
  return bindings[0] ?? null;
}

function unfencedLines(
  document: string,
): Array<{ marker: string; start: number; end: number }> {
  let offset = 0;
  let fence: { character: string; length: number } | null = null;
  const markers: Array<{ marker: string; start: number; end: number }> = [];
  for (const line of document.match(/[^\n]*(?:\n|$)/g) ?? []) {
    const text = line.replace(/\r?\n$/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence !== null) {
      if (
        delimiter &&
        delimiter[1]?.[0] === fence.character &&
        delimiter[1].length >= fence.length &&
        delimiter[2]?.trim() === ''
      )
        fence = null;
    } else if (delimiter?.[1]) {
      fence = {
        character: delimiter[1][0] as string,
        length: delimiter[1].length,
      };
    } else {
      markers.push({ marker: text, start: offset, end: offset + line.length });
    }
    offset += line.length;
  }
  return markers;
}

export function replaceManDeliveryRecord(
  document: string,
  record: string,
): string {
  const parsed = parseManPlanDocument(document);
  const next = `${document.slice(0, parsed.recordStart)}${record.trim()}\n${document.slice(parsed.recordEnd)}`;
  const checked = parseManPlanDocument(next);
  if (checked.baseline !== parsed.baseline)
    throw new Error('MANCODE_MAN_PLAN_BASELINE_CHANGED');
  return next;
}

export function assertManPlanPath(file: string): void {
  if (
    !file ||
    path.posix.isAbsolute(file) ||
    /[\\\r\n\0<>:]/.test(file) ||
    file.split('/').some((part) => !part || part === '.' || part === '..') ||
    /^(?:\.git|\.mancode|架构|项目接口)(?:\/|$)/.test(file) ||
    !file.endsWith('.md') ||
    !file.includes('/')
  )
    throw new Error('MANCODE_MAN_PLAN_PATH_INVALID');
}

function parseSource(value: unknown): ManPlanSource {
  assertRecord(value, 'man plan source');
  assertKnownKeys(value, ['version', 'path', 'baseHead'], 'man plan source');
  if (value.version !== 1 || typeof value.path !== 'string') {
    throw new Error('MANCODE_MAN_PLAN_SOURCE_INVALID');
  }
  assertManPlanPath(value.path);
  if (
    value.baseHead !== null &&
    (typeof value.baseHead !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(value.baseHead))
  ) {
    throw new Error('MANCODE_MAN_PLAN_BASE_INVALID');
  }
  return { version: 1, path: value.path, baseHead: value.baseHead };
}

/** Store the source binding in the existing canonical plan artifact, not a second state file. */
export function compileManDeliveryPlan(
  source: ManPlanSource,
  document: string,
): string {
  return `${SOURCE_PREFIX}${JSON.stringify(parseSource(source))} -->\n${parseManPlanDocument(document).baseline}`;
}

export function parseManDeliveryPlan(
  plan: string,
): { source: ManPlanSource; baseline: string } | null {
  if (!plan.startsWith(SOURCE_PREFIX)) return null;
  const end = plan.indexOf(' -->\n');
  if (end < 0) throw new Error('MANCODE_MAN_PLAN_SOURCE_INVALID');
  const source = parseSource(JSON.parse(plan.slice(SOURCE_PREFIX.length, end)));
  const baseline = plan.slice(end + ' -->\n'.length);
  if (!baseline.trim()) throw new Error('MANCODE_MAN_PLAN_BASELINE_REQUIRED');
  return { source, baseline };
}

import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFileAtomically } from '../runtime/atomic-file.js';

export type ManProgressStatus =
  | '未完成'
  | '进行中'
  | '待审核'
  | '已完成'
  | '阻塞';
export interface ManProgressResult {
  status: 'synced' | 'absent' | 'manual_sync';
  reason?: string;
}
const START = '<script type="application/json" id="mancode-progress-data">';
const END = '</script>';

/** Only this exact, documented data contract is writable; this is not an HTML editor. */
export function updateManProgressHtml(
  html: string,
  taskId: string,
  status: ManProgressStatus,
  reason: string | null,
): string {
  if (
    html.split(START).length !== 2 ||
    [...html.matchAll(/\bid\s*=\s*["']mancode-progress-data["']/gi)].length !==
      1
  )
    throw new Error('progress data block is missing or ambiguous');
  // Skip comments and entire raw-text elements, including JavaScript strings
  // containing a sample block. Unknown/malformed markup is never repaired here.
  const tokens = [
    ...html.matchAll(
      /<!--[\s\S]*?-->|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|<(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi,
    ),
  ];
  if (
    !tokens.some(
      (token) =>
        token.index === html.indexOf(START) && token[0].startsWith(START),
    )
  )
    throw new Error('progress data must be an active standalone script block');
  const start = html.indexOf(START) + START.length;
  const end = html.indexOf(END, start);
  if (end < start) throw new Error('progress data block is unterminated');
  const data: unknown = JSON.parse(html.slice(start, end));
  if (
    !data ||
    typeof data !== 'object' ||
    !('schemaVersion' in data) ||
    data.schemaVersion !== 1 ||
    !('tasks' in data) ||
    !Array.isArray(data.tasks)
  )
    throw new Error('unsupported progress data');
  const matches = data.tasks.filter(
    (item) => item && typeof item === 'object' && item.taskId === taskId,
  );
  if (matches.length !== 1)
    throw new Error('progress taskId is missing or ambiguous');
  Object.assign(matches[0], { status, reason });
  return `${html.slice(0, start)}\n${JSON.stringify(data).replaceAll('<', '\\u003c')}\n${html.slice(end)}`;
}

export async function syncManProgressPage(
  root: string,
  taskId: string,
  status: ManProgressStatus,
  reason: string | null,
  allowed: boolean,
): Promise<ManProgressResult> {
  const target = path.join(root, '项目进度.html');
  let temporary: string | undefined;
  try {
    const stat = await lstat(target);
    if (!allowed)
      return {
        status: 'manual_sync',
        reason: 'progress page is outside the approved write scope',
      };
    if (
      !stat.isFile() ||
      (await realpath(target)) !==
        path.join(await realpath(root), '项目进度.html')
    )
      return {
        status: 'manual_sync',
        reason: 'progress page must be a regular project file',
      };
    const previous = await readFile(target, 'utf8');
    const next = updateManProgressHtml(previous, taskId, status, reason);
    if (next !== previous) {
      temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, next, { flag: 'wx', mode: stat.mode });
      if ((await readFile(target, 'utf8')) !== previous)
        throw new Error('progress page changed during sync');
      await replaceFileAtomically(temporary, target);
    }
    return { status: 'synced' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !temporary)
      return { status: 'absent' };
    // A local view must not roll back valid authority; expose the actual diagnostic.
    return {
      status: 'manual_sync',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }
}

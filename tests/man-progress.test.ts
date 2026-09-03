import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manProgressTaskId } from '../src/context/man-delivery-plan.js';
import {
  syncManProgressPage,
  updateManProgressHtml,
} from '../src/context/man-progress.js';

const page =
  '<h1>Keep me</h1>\n<script type="application/json" id="mancode-progress-data">{"schemaVersion":1,"tasks":[{"taskId":"export","status":"未完成","reason":null,"label":"Export"},{"taskId":"later","status":"未完成","reason":null}]}</script>\n<script>keepApplication()</script>';
describe('optional man progress view', () => {
  it('ignores example bindings inside Markdown fences', () => {
    expect(
      manProgressTaskId(
        '```html\n<!-- mancode:progress-task example -->\n```\n<!-- mancode:progress-task actual -->',
      ),
    ).toBe('actual');
    expect(() =>
      manProgressTaskId(
        '<!-- mancode:progress-task a -->\n<!-- mancode:progress-task b -->',
      ),
    ).toThrow('ambiguous');
  });
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-progress-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('updates only the mapped data, escapes script terminators and preserves other tasks and HTML', () => {
    const next = updateManProgressHtml(
      page,
      'export',
      '阻塞',
      'Need user decision: </script><script>bad()</script>',
    );
    expect(next.startsWith('<h1>Keep me</h1>\n')).toBe(true);
    expect(next.endsWith('\n<script>keepApplication()</script>')).toBe(true);
    expect(next).toContain('\\u003c/script>');
    expect(next).toContain('"taskId":"later","status":"未完成","reason":null');
    expect(next).toContain('"label":"Export"');
    expect(
      updateManProgressHtml(
        next,
        'export',
        '阻塞',
        'Need user decision: </script><script>bad()</script>',
      ),
    ).toBe(next);
  });
  it('never guesses a missing, duplicate, malformed or unmapped contract', () => {
    for (const html of [
      '<p>unstructured</p>',
      page + page,
      page.replace('"schemaVersion":1', '"schemaVersion":2'),
      page.replace('"tasks":', '"tasks":broken'),
      page.replace('"taskId":"later"', '"taskId":"export"'),
    ]) {
      expect(() =>
        updateManProgressHtml(html, 'export', '进行中', null),
      ).toThrow();
    }
    expect(() =>
      updateManProgressHtml(page, 'unknown', '进行中', null),
    ).toThrow();
    expect(() =>
      updateManProgressHtml(`<!--${page}-->`, 'export', '进行中', null),
    ).toThrow();
    expect(() =>
      updateManProgressHtml(
        `<script>const sample = '${page}'</script>`,
        'export',
        '进行中',
        null,
      ),
    ).toThrow();
    expect(() =>
      updateManProgressHtml(
        `${page}<div id='mancode-progress-data'></div>`,
        'export',
        '进行中',
        null,
      ),
    ).toThrow();
  });
  it('degrades absent, invalid or out-of-scope pages without creating or changing them', async () => {
    expect(
      await syncManProgressPage(root, 'export', '进行中', null, true),
    ).toEqual({ status: 'absent' });
    const file = path.join(root, '项目进度.html');
    await writeFile(file, page);
    expect(
      await syncManProgressPage(root, 'export', '进行中', null, false),
    ).toMatchObject({ status: 'manual_sync' });
    expect(await readFile(file, 'utf8')).toBe(page);
    expect(
      await syncManProgressPage(root, 'export', '进行中', null, true),
    ).toEqual({ status: 'synced' });
    await writeFile(file, '<p>unstructured</p>');
    expect(
      await syncManProgressPage(root, 'export', '进行中', null, true),
    ).toMatchObject({ status: 'manual_sync' });
    expect(await readFile(file, 'utf8')).toBe('<p>unstructured</p>');
  });
  it('does not follow a symlink to any other file', async () => {
    await writeFile(path.join(root, 'other.html'), page);
    await symlink(
      path.join(root, 'other.html'),
      path.join(root, '项目进度.html'),
    );
    expect(
      await syncManProgressPage(root, 'export', '进行中', null, true),
    ).toMatchObject({ status: 'manual_sync' });
    expect(await readFile(path.join(root, 'other.html'), 'utf8')).toBe(page);
  });
});

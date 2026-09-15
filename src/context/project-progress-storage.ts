import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  lstat,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { resolveLocalEntityHomeStore } from '../runtime/entity-home-store.js';
import { acquireLocalLock } from '../runtime/local-lock.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { renderProjectProgressHtml } from '../templates/project-progress.js';
import { createUlid } from './ids.js';
import type {
  ProjectProgressController,
  ProjectProgressData,
} from './project-progress.js';

const git = promisify(execFile);
export const PROJECT_PROGRESS_FILE = '项目进度.html';
export const PROJECT_PROGRESS_MARKER = '<!-- mancode:project-progress:2 -->';
export interface ProjectProgressBinding {
  schemaVersion: 1;
  workspaceId: string;
  checkoutId: string;
  output: typeof PROJECT_PROGRESS_FILE;
  visibility: 'local-snapshot' | 'shared-snapshot';
}
const bindingRelative = '.mancode/local/project-progress.json';

async function regular(
  root: string,
  file: string,
  optional = false,
): Promise<string | null> {
  try {
    const target = path.join(root, file);
    const stat = await lstat(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await realpath(target)) !== path.join(await realpath(root), file)
    )
      throw new Error('MANCODE_PROGRESS_PATH_UNSAFE');
    return await readFile(target, 'utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    throw error;
  }
}
async function gitState(
  root: string,
): Promise<{ tracked: boolean; git: boolean }> {
  try {
    await git('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  } catch (error) {
    if (
      String((error as { stderr?: unknown }).stderr).includes(
        'not a git repository',
      )
    )
      return { tracked: false, git: false };
    throw new Error('MANCODE_PROGRESS_GIT_STATE_UNAVAILABLE');
  }
  try {
    await git(
      'git',
      ['ls-files', '--error-unmatch', '--', PROJECT_PROGRESS_FILE],
      { cwd: root },
    );
    return { tracked: true, git: true };
  } catch (error) {
    if ((error as { code?: unknown }).code === 1)
      return { tracked: false, git: true };
    throw new Error('MANCODE_PROGRESS_GIT_STATE_UNAVAILABLE');
  }
}
/** Hold Git's writer lock through rename so tracking cannot change after validation. */
async function withGitIndexLock<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!(await gitState(root)).git) return work();
  const result = await git('git', ['rev-parse', '--git-path', 'index'], {
    cwd: root,
  });
  const file = `${path.resolve(root, result.stdout.trim())}.lock`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch {
    throw new Error('MANCODE_PROGRESS_GIT_INDEX_BUSY');
  }
  try {
    return await work();
  } finally {
    await handle.close();
    await rm(file);
  }
}
function parseBinding(value: unknown): ProjectProgressBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('MANCODE_PROGRESS_BINDING_INVALID');
  const binding = value as ProjectProgressBinding;
  if (
    binding.schemaVersion !== 1 ||
    binding.output !== PROJECT_PROGRESS_FILE ||
    !['local-snapshot', 'shared-snapshot'].includes(binding.visibility) ||
    typeof binding.workspaceId !== 'string' ||
    typeof binding.checkoutId !== 'string' ||
    Object.keys(binding).some(
      (key) =>
        ![
          'schemaVersion',
          'workspaceId',
          'checkoutId',
          'output',
          'visibility',
        ].includes(key),
    )
  )
    throw new Error('MANCODE_PROGRESS_BINDING_INVALID');
  return binding;
}
export async function readProjectProgressBinding(
  root: string,
): Promise<ProjectProgressBinding | null> {
  const content = await regular(root, bindingRelative, true);
  if (content === null) return null;
  const binding = parseBinding(JSON.parse(content));
  const runtime = await readProjectRuntimeContext(root);
  if (
    binding.workspaceId !== runtime.workspaceId ||
    binding.checkoutId !== runtime.checkoutId
  )
    throw new Error('MANCODE_PROGRESS_BINDING_MISMATCH');
  return binding;
}
async function lock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const runtime = await readProjectRuntimeContext(root);
  const handle = await acquireLocalLock(
    resolveLocalEntityHomeStore(runtime.entityHomeStoreContext),
    { operationId: createUlid(), entityLockKey: 'projection:project-progress' },
  );
  try {
    return await work();
  } finally {
    await handle.release();
  }
}
async function atomic(
  root: string,
  file: string,
  content: string,
  previous: string | null,
  beforePublish?: () => Promise<void>,
): Promise<void> {
  const target = path.join(root, file);
  if (
    (await realpath(path.dirname(target))) !==
    path.join(await realpath(root), path.dirname(file))
  )
    throw new Error('MANCODE_PROGRESS_PATH_UNSAFE');
  const temporaryFolder = path.join(root, '.mancode/local');
  if (
    (await realpath(temporaryFolder)) !==
      path.join(await realpath(root), '.mancode/local') ||
    (await lstat(temporaryFolder)).dev !==
      (await lstat(path.dirname(target))).dev
  )
    throw new Error('MANCODE_PROGRESS_PATH_UNSAFE');
  const temporary = path.join(temporaryFolder, `.progress-${randomUUID()}.tmp`);
  if ((await gitState(root)).git)
    await git(
      'git',
      ['check-ignore', '-q', '--', path.relative(root, temporary)],
      { cwd: root },
    );
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    if ((await regular(root, file, true)) !== previous)
      throw new Error('MANCODE_PROGRESS_OUTPUT_CHANGED');
    await beforePublish?.();
    await replaceFileAtomically(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function excludeLocal(root: string): Promise<void> {
  const result = await git('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: root,
  });
  const file = path.resolve(root, result.stdout.trim());
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('MANCODE_PROGRESS_GIT_EXCLUDE_UNSAFE');
  const content = await readFile(file, 'utf8');
  if (!content.split(/\r?\n/).includes(`/${PROJECT_PROGRESS_FILE}`))
    await appendFile(
      file,
      `${content.endsWith('\n') ? '' : '\n'}/${PROJECT_PROGRESS_FILE}\n`,
    );
  await git('git', ['check-ignore', '-q', '--', PROJECT_PROGRESS_FILE], {
    cwd: root,
  });
}

/** Explicit opt-in. Custom pages and legacy data contracts are never overwritten. */
export async function bindProjectProgress(
  root: string,
): Promise<ProjectProgressBinding> {
  return lock(root, async () => {
    const existing = await readProjectProgressBinding(root);
    if (existing) return existing;
    const page = await regular(root, PROJECT_PROGRESS_FILE, true);
    if (
      page !== null &&
      !page.startsWith(`<!doctype html>\n${PROJECT_PROGRESS_MARKER}`)
    )
      throw new Error('MANCODE_PROGRESS_MANUAL_SYNC_REQUIRED');
    const runtime = await readProjectRuntimeContext(root);
    const state = await gitState(root);
    if (!state.tracked && state.git) await excludeLocal(root);
    const binding: ProjectProgressBinding = {
      schemaVersion: 1,
      workspaceId: runtime.workspaceId,
      checkoutId: runtime.checkoutId,
      output: PROJECT_PROGRESS_FILE,
      visibility: state.tracked ? 'shared-snapshot' : 'local-snapshot',
    };
    await atomic(root, bindingRelative, `${JSON.stringify(binding)}\n`, null);
    return binding;
  });
}

function htmlVersion(html: string | null): string | null {
  if (html === null) return null;
  const match =
    /<script type="application\/json" id="mancode-progress-data">([\s\S]*?)<\/script>/.exec(
      html,
    );
  if (!match?.[1]) throw new Error('MANCODE_PROGRESS_MANUAL_SYNC_REQUIRED');
  const parsed = JSON.parse(match[1]) as {
    schemaVersion?: unknown;
    version?: unknown;
  };
  if (parsed.schemaVersion !== 2 || typeof parsed.version !== 'string')
    throw new Error('MANCODE_PROGRESS_MANUAL_SYNC_REQUIRED');
  return parsed.version;
}
export async function readProjectProgressSnapshotVersion(
  root: string,
): Promise<string | null> {
  return htmlVersion(await regular(root, PROJECT_PROGRESS_FILE, true));
}

export async function writeProjectProgressSnapshot(
  root: string,
  controller: ProjectProgressController,
  expectedPreviousVersion: string | null,
): Promise<{ status: 'updated' | 'unchanged'; file: string; version: string }> {
  return lock(root, () =>
    withGitIndexLock(root, async () => {
      const binding = await readProjectProgressBinding(root);
      if (!binding) throw new Error('MANCODE_PROGRESS_NOT_BOUND');
      const before = await regular(root, PROJECT_PROGRESS_FILE, true);
      if (htmlVersion(before) !== expectedPreviousVersion)
        throw new Error('MANCODE_PROGRESS_PUBLICATION_STALE');
      if (
        before !== null &&
        !before.startsWith(`<!doctype html>\n${PROJECT_PROGRESS_MARKER}`)
      )
        throw new Error('MANCODE_PROGRESS_MANUAL_SYNC_REQUIRED');
      const state = await gitState(root);
      if (binding.visibility === 'local-snapshot' && state.tracked)
        throw new Error('MANCODE_PROGRESS_SHARED_REBUILD_REQUIRED');
      if (binding.visibility === 'local-snapshot' && state.git)
        await git('git', ['check-ignore', '-q', '--', PROJECT_PROGRESS_FILE], {
          cwd: root,
        });
      if (controller.version().stale) throw new Error('MANCODE_PROGRESS_STALE');
      const data = controller.data(binding.visibility);
      const html = renderProjectProgressHtml(data, false);
      if (before === html)
        return {
          status: 'unchanged',
          file: PROJECT_PROGRESS_FILE,
          version: data.version,
        };
      const finalState = await gitState(root);
      if (binding.visibility === 'local-snapshot' && finalState.tracked)
        throw new Error('MANCODE_PROGRESS_SHARED_REBUILD_REQUIRED');
      if (
        JSON.stringify(await readProjectProgressBinding(root)) !==
        JSON.stringify(binding)
      )
        throw new Error('MANCODE_PROGRESS_BINDING_CHANGED');
      await atomic(root, PROJECT_PROGRESS_FILE, html, before, async () => {
        const latest = await gitState(root);
        if (binding.visibility === 'local-snapshot' && latest.tracked)
          throw new Error('MANCODE_PROGRESS_SHARED_REBUILD_REQUIRED');
        if (
          controller.version().stale ||
          controller.data(binding.visibility).version !== data.version
        )
          throw new Error('MANCODE_PROGRESS_PUBLICATION_STALE');
      });
      return {
        status: 'updated',
        file: PROJECT_PROGRESS_FILE,
        version: data.version,
      };
    }),
  );
}

/** Explicit safe rebuild of a managed page after the user makes it tracked. */
export async function rebuildSharedProjectProgress(
  root: string,
  controller: ProjectProgressController,
  expectedPreviousVersion: string | null,
): Promise<void> {
  await lock(root, async () => {
    const binding = await readProjectProgressBinding(root);
    if (!binding) throw new Error('MANCODE_PROGRESS_NOT_BOUND');
    const existing = await regular(root, PROJECT_PROGRESS_FILE, true);
    if (htmlVersion(existing) !== expectedPreviousVersion)
      throw new Error('MANCODE_PROGRESS_PUBLICATION_STALE');
    if (
      existing !== null &&
      !existing.startsWith(`<!doctype html>\n${PROJECT_PROGRESS_MARKER}`)
    )
      throw new Error('MANCODE_PROGRESS_MANUAL_SYNC_REQUIRED');
    if (controller.version().stale) throw new Error('MANCODE_PROGRESS_STALE');
    const data = controller.data('shared-snapshot');
    await atomic(
      root,
      PROJECT_PROGRESS_FILE,
      renderProjectProgressHtml(data, false),
      existing,
      async () => {
        if (
          controller.version().stale ||
          controller.data('shared-snapshot').version !== data.version
        )
          throw new Error('MANCODE_PROGRESS_PUBLICATION_STALE');
      },
    );
    await atomic(
      root,
      bindingRelative,
      `${JSON.stringify({ ...binding, visibility: 'shared-snapshot' })}\n`,
      await regular(root, bindingRelative),
    );
  });
}

export function validateProgressData(
  value: ProjectProgressData,
): ProjectProgressData {
  if (value.schemaVersion !== 2 || !value.version.startsWith('sha256:'))
    throw new Error('MANCODE_PROGRESS_DATA_INVALID');
  return value;
}

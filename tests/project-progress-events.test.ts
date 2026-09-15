import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { createUlid } from '../src/context/ids.js';
import { bindProjectProgress } from '../src/context/project-progress-storage.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import {
  notifyCommittedProgress,
  readProgressNotification,
} from '../src/runtime/project-progress-events.js';
import { createSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-progress-events-'));
  roots.push(root);
  await initializeV3Project({ projectRoot: root });
  await bindProjectProgress(root);
  return root;
}
describe('committed progress notifications', () => {
  it('exposes the commit-notification crash window and repairs terminal operations', async () => {
    const root = await fixture();
    await notifyCommittedProgress(root, { full: true });
    const actorId = createUlid();
    const sessionId = createUlid();
    const operationId = createUlid();
    await createLocalActor(root, { actorId, displayName: 'Fixture' });
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
    });
    const crash = OPERATION_CRASH_FIXTURES.workflow_create.find(
      (item) => item.crashAfter === 'commit',
    );
    if (!crash) throw new Error('Missing crash fixture');
    await expect(
      withOperationCrashInjectionForTesting(crash, () =>
        createV3Workflow({
          projectRoot: root,
          task: 'Committed before notification',
          workflowMode: 'man',
          sessionId,
          client: 'vitest',
          operationId,
        }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    await expect(readProgressNotification(root)).rejects.toThrow(
      'MANCODE_PROGRESS_COMMIT_PENDING',
    );
    const result = await executeOperationRecovery({
      projectRoot: root,
      actorId,
      sessionId,
      operationId,
    });
    expect(result.state).toBe('already_terminal');
    await expect(readProgressNotification(root)).resolves.toHaveProperty(
      'revision',
      2,
    );
    expect(await readFile(path.join(root, '项目进度.html'), 'utf8')).toContain(
      'Committed before notification',
    );
  });

  it('does not roll back authority when the disposable pending marker is damaged', async () => {
    const root = await fixture();
    await notifyCommittedProgress(root, { full: true });
    await writeFile(
      path.join(root, '.mancode/local/project-progress/pending.json'),
      'broken',
    );
    const actorId = createUlid();
    const sessionId = createUlid();
    await createLocalActor(root, { actorId, displayName: 'Fixture' });
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Committed despite projection failure',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
    });
    expect(created.operation.state).toBe('committed');
  });
  it('keeps idle polls small and preserves unchanged HTML without reading authority', async () => {
    const root = await fixture();
    expect(await notifyCommittedProgress(root, { full: true })).toEqual({
      status: 'updated',
    });
    const html = path.join(root, '项目进度.html');
    const before = await stat(html);
    const list = vi.spyOn(V3ContextStore.prototype, 'listWorkflowMetadata');
    const project = vi.spyOn(V3ContextStore.prototype, 'readProjectSnapshot');
    for (let i = 0; i < 25; i++)
      expect((await readProgressNotification(root))?.revision).toBe(1);
    expect(list).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    await notifyCommittedProgress(root, {});
    expect(list).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect((await stat(html)).mtimeMs).toBe(before.mtimeMs);
  });

  it('updates the offline page after a public task creation and only rereads that task', async () => {
    const root = await fixture();
    await notifyCommittedProgress(root, { full: true });
    const actorId = createUlid();
    const sessionId = createUlid();
    await createLocalActor(root, { actorId, displayName: 'Fixture' });
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
    });
    const list = vi.spyOn(V3ContextStore.prototype, 'listWorkflowMetadata');
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Track a committed task',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
    });
    expect(created.operation.state).toBe('committed');
    expect((await readProgressNotification(root))?.revision).toBe(2);
    expect(await readFile(path.join(root, '项目进度.html'), 'utf8')).toContain(
      'Track a committed task',
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('rebuilds a damaged cache and serializes concurrent notifications', async () => {
    const root = await fixture();
    await notifyCommittedProgress(root, { full: true });
    await writeFile(
      path.join(root, '.mancode/local/project-progress/cache.json'),
      'broken',
    );
    const list = vi.spyOn(V3ContextStore.prototype, 'listWorkflowMetadata');
    expect(await notifyCommittedProgress(root, {})).toEqual({
      status: 'updated',
    });
    expect(list).toHaveBeenCalled();
    const results = await Promise.all([
      notifyCommittedProgress(root, {}),
      notifyCommittedProgress(root, {}),
    ]);
    expect(results.every((r) => r.status === 'updated')).toBe(true);
    expect((await readProgressNotification(root))?.revision).toBe(4);
  });

  it('keeps committed work successful when HTML becomes user-owned and exposes repair', async () => {
    const root = await fixture();
    await notifyCommittedProgress(root, { full: true });
    const html = path.join(root, '项目进度.html');
    const original = await readFile(html, 'utf8');
    await writeFile(html, '<h1>User page</h1>');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await notifyCommittedProgress(root, {})).status).toBe('pending');
    await expect(readProgressNotification(root)).rejects.toThrow(
      'MANCODE_PROGRESS_REPAIR_REQUIRED',
    );
    expect(await readFile(html, 'utf8')).toBe('<h1>User page</h1>');
    await writeFile(html, original);
    expect((await notifyCommittedProgress(root, { full: true })).status).toBe(
      'updated',
    );
    await expect(readProgressNotification(root)).resolves.toHaveProperty(
      'revision',
    );
  });
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  locateTask,
  readTaskArtifact,
  resolveArtifactLocation,
  taskRootPath,
} from '../src/context/task-locator.js';

const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const REPORT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('TaskLocator and ArtifactRef resolver', () => {
  it('requires an explicit namespace when a bare task ID is ambiguous', async () => {
    const root = await temporaryProjectRoot();
    await mkdir(taskRootPath(root, { namespace: 'local', taskId: TASK_ID }), {
      recursive: true,
    });
    await expect(locateTask(root, TASK_ID)).resolves.toMatchObject({
      taskRef: { namespace: 'local', taskId: TASK_ID },
    });

    await mkdir(taskRootPath(root, { namespace: 'shared', taskId: TASK_ID }), {
      recursive: true,
    });
    await expect(locateTask(root, TASK_ID)).rejects.toThrow(
      'MANCODE_TASK_AMBIGUOUS',
    );
    await expect(locateTask(root, `shared:${TASK_ID}`)).resolves.toMatchObject({
      taskRef: { namespace: 'shared', taskId: TASK_ID },
    });
  });

  it('maps typed artifacts to fixed paths and rejects symlinked content', async () => {
    const root = await temporaryProjectRoot();
    const taskRef = { namespace: 'shared' as const, taskId: TASK_ID };
    const taskRoot = taskRootPath(root, taskRef);
    await mkdir(taskRoot, { recursive: true });
    await writeFile(
      path.join(taskRoot, 'requirements.json'),
      '{"goal":"safe"}\n',
    );

    const requirements = { taskRef, kind: 'requirements' as const };
    expect(resolveArtifactLocation(root, requirements).path).toBe(
      path.join(taskRoot, 'requirements.json'),
    );
    await expect(readTaskArtifact(root, requirements)).resolves.toBe(
      '{"goal":"safe"}\n',
    );
    expect(() =>
      resolveArtifactLocation(root, {
        ...requirements,
        artifactId: REPORT_ID,
      }),
    ).toThrow('MANCODE_ARTIFACT_PATH_UNSAFE');

    const outside = path.join(root, 'outside.md');
    await writeFile(outside, 'private data\n');
    const report = {
      taskRef,
      kind: 'review_report' as const,
      artifactId: REPORT_ID,
    };
    const reportPath = resolveArtifactLocation(root, report).path;
    await mkdir(path.dirname(reportPath), { recursive: true });
    await symlink(outside, reportPath);
    await expect(readTaskArtifact(root, report)).rejects.toThrow(
      'MANCODE_ARTIFACT_PATH_UNSAFE',
    );
  });
});

async function temporaryProjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-task-locator-'));
  roots.push(root);
  return root;
}

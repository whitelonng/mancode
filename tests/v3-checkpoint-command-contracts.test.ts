import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamCheckpoint } from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
} from '../src/team/actor.js';

const execFile = promisify(execFileCallback);
const NOW = new Date('2026-07-17T12:00:00.000Z');

describe('V3 team checkpoint command', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-checkpoint-command-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await execFile('git', ['init'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'vitest@example.test'], {
      cwd: root,
    });
    await execFile('git', ['config', 'user.name', 'Vitest'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), '# fixture\n');
    await execFile('git', ['add', 'README.md'], { cwd: root });
    await execFile('git', ['commit', '-m', 'fixture'], { cwd: root });
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('routes a shared checkpoint through the session, revision, and journal gates', async () => {
    const actorId = id(4);
    const sessionId = id(5);
    await createLocalActor(root, {
      actorId,
      displayName: 'Checkpoint User',
      now: NOW,
    });
    const actor = await readLocalActor(root);
    if (actor === null) throw new Error('missing local actor');
    await publishSharedActorProfile(root, createSharedActorProfile(actor, NOW));
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now: NOW,
    });
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Create a checkpoint through the V3 command.',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      taskId: id(6),
      operationId: id(7),
      now: NOW,
    });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await teamCheckpoint(root, {
          task: `shared:${created.taskRef.taskId}`,
          expectedTaskRevision: '1',
          kind: 'diagnostic_started',
          summary: 'Captured shared state before diagnosis.',
          session: sessionId,
          client: 'vitest',
          json: true,
        }),
      ).toBe(0);
      const payload = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        checkpoint: { taskRef: { namespace: string }; operationId: string };
        metadata: { revision: number; latestCheckpointRef: { kind: string } };
        operation: { type: string; state: string };
      };
      expect(payload).toMatchObject({
        checkpoint: {
          taskRef: { namespace: 'shared' },
        },
        metadata: { revision: 3, latestCheckpointRef: { kind: 'checkpoint' } },
        operation: { type: 'checkpoint_create', state: 'committed' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });
});

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { status } from '../src/commands/status.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import {
  dryRunProjectPolicyUpgrade,
  upgradeProjectPolicy,
} from '../src/context/project-policy-upgrade.js';
import { taskRootPath } from '../src/context/task-locator.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { parseWorkflowMetadata } from '../src/context/workflow-metadata.js';
import { updateV3Workflow } from '../src/context/workflow-update.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import {
  executeOperationRecovery,
  listUnfinishedOperationRecoveries,
} from '../src/runtime/operation-recovery-executor.js';
import { createSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';

const NOW = new Date('2026-07-21T10:00:00.000Z');

describe('project Policy 2 upgrade', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-project-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('dry-runs without writes, commits V1 to V2, and preserves old workflow provenance', async () => {
    const { actorId, sessionId } = await bootstrap(root, 0);
    const oldWorkflow = await createV3Workflow({
      projectRoot: root,
      task: 'Preserve the Policy 1 workflow.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(10),
      operationId: id(11),
      now: NOW,
    });
    expect(oldWorkflow.metadata.governance.policyVersions.planning).toBe(1);
    const schemaPath = path.join(root, '.mancode', 'schema.json');
    const oldMetadataPath = path.join(
      taskRootPath(root, oldWorkflow.taskRef),
      'metadata.json',
    );
    const [schemaBefore, oldMetadataBefore] = await Promise.all([
      readFile(schemaPath, 'utf8'),
      readFile(oldMetadataPath, 'utf8'),
    ]);

    const preview = await dryRunProjectPolicyUpgrade({
      projectRoot: root,
      policyVersion: 2,
      operationId: id(12),
      now: NOW,
    });
    expect(preview).toMatchObject({
      policy: 2,
      currentManifestVersion: 1,
      willUpgrade: true,
      blockers: [],
      operationId: id(12),
      minReaderVersion: '0.4.0',
      minWriterVersion: '0.4.0',
    });
    await expect(readFile(schemaPath, 'utf8')).resolves.toBe(schemaBefore);

    const upgraded = await upgradeProjectPolicy({
      projectRoot: root,
      policyVersion: 2,
      sessionId,
      operationId: id(12),
      now: NOW,
    });
    expect(upgraded).toMatchObject({
      state: 'committed',
      manifest: {
        manifestVersion: 2,
        workflowPolicyDefaults: { planning: 2 },
        lastOperationId: id(12),
      },
      operation: { type: 'project_policy_upgrade', state: 'committed' },
    });
    expect(digestCanonicalJson(upgraded.manifest)).toBe(preview.afterDigest);
    await expect(readFile(oldMetadataPath, 'utf8')).resolves.toBe(
      oldMetadataBefore,
    );

    const newWorkflow = await createV3Workflow({
      projectRoot: root,
      task: 'Use the upgraded planning policy.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(14),
      operationId: id(15),
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(newWorkflow.metadata.governance.policyVersions).toEqual({
      planning: 2,
      review: 1,
      verification: 1,
    });
    const oldMetadata = parseWorkflowMetadata(
      JSON.parse(await readFile(oldMetadataPath, 'utf8')),
    );
    expect(oldMetadata.governance.policyVersions.planning).toBe(1);
  });

  it('repairs or safely aborts every declared project-upgrade crash point', async () => {
    for (const [
      index,
      fixture,
    ] of OPERATION_CRASH_FIXTURES.project_policy_upgrade.entries()) {
      const caseRoot = path.join(root, `crash-${index}`);
      await mkdir(caseRoot, { recursive: true });
      const { actorId, sessionId } = await bootstrap(caseRoot, index + 20);
      const operationId = id(index + 100);

      await dryRunProjectPolicyUpgrade({
        projectRoot: caseRoot,
        policyVersion: 2,
        operationId,
        now: NOW,
      });

      await expect(
        withOperationCrashInjectionForTesting(fixture, () =>
          upgradeProjectPolicy({
            projectRoot: caseRoot,
            policyVersion: 2,
            sessionId,
            operationId,
            now: NOW,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

      const recovered = await executeOperationRecovery({
        projectRoot: caseRoot,
        operationId,
        actorId,
        sessionId,
        now: NOW,
      });
      const manifest = JSON.parse(
        await readFile(path.join(caseRoot, '.mancode', 'schema.json'), 'utf8'),
      ) as { manifestVersion: number };
      if (fixture.expectedRecovery === 'safe_abort') {
        expect(recovered.journal.state).toBe('aborted');
        expect(manifest.manifestVersion).toBe(1);
      } else {
        expect(recovered.journal.state).toBe('committed');
        expect(manifest.manifestVersion).toBe(2);
      }
    }
  });

  it('blocks ordinary writes after a visible upgrade crash and repairs on retry', async () => {
    const { sessionId } = await bootstrap(root, 40);
    const existing = await createV3Workflow({
      projectRoot: root,
      task: 'Keep an existing Policy 1 workflow stable during repair.',
      workflowMode: 'man',
      sessionId,
      client: 'vitest',
      taskId: id(50),
      operationId: id(51),
      now: NOW,
    });
    const operationId = id(52);
    await dryRunProjectPolicyUpgrade({
      projectRoot: root,
      policyVersion: 2,
      operationId,
      now: NOW,
    });

    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: 'project_policy_upgrade',
          crashAfter: 'write-manifest',
        },
        () =>
          upgradeProjectPolicy({
            projectRoot: root,
            policyVersion: 2,
            sessionId,
            operationId,
            now: NOW,
          }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
    await expect(
      listUnfinishedOperationRecoveries(root),
    ).resolves.toMatchObject([
      { journal: { operationId, state: 'repair_required' } },
    ]);

    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(status(root, { brief: true, json: true })).resolves.toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        state: 'unavailable',
        ready: false,
        blockers: expect.arrayContaining(['MANCODE_OPERATION_REPAIR_REQUIRED']),
      });
    } finally {
      logs.mockRestore();
    }

    await expect(
      createV3Workflow({
        projectRoot: root,
        task: 'Do not create authority while project repair is required.',
        workflowMode: 'man',
        sessionId,
        client: 'vitest',
        taskId: id(53),
        operationId: id(54),
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).rejects.toThrow('MANCODE_OPERATION_REPAIR_REQUIRED');
    await expect(
      updateV3Workflow({
        projectRoot: root,
        taskRef: existing.taskRef,
        sessionId,
        expectedTaskRevision: existing.metadata.revision,
        status: 'blocked',
        blockingReason: 'Project policy repair must finish first.',
        operationId: id(55),
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).rejects.toThrow('MANCODE_OPERATION_REPAIR_REQUIRED');

    await expect(
      upgradeProjectPolicy({
        projectRoot: root,
        policyVersion: 2,
        sessionId,
        operationId,
        now: new Date(NOW.getTime() + 2_000),
      }),
    ).resolves.toMatchObject({
      state: 'committed',
      operation: { operationId, state: 'committed' },
      manifest: { manifestVersion: 2 },
    });
    await expect(listUnfinishedOperationRecoveries(root)).resolves.toEqual([]);
  });
});

async function bootstrap(
  projectRoot: string,
  offset: number,
): Promise<{ actorId: Ulid; sessionId: Ulid }> {
  await initializeV3Project({
    projectRoot,
    operationId: id(offset + 1),
    workspaceId: id(offset + 2),
    schemaEpoch: id(offset + 3),
    now: NOW,
  });
  const schemaPath = path.join(projectRoot, '.mancode', 'schema.json');
  const historical = JSON.parse(await readFile(schemaPath, 'utf8')) as Record<
    string,
    unknown
  >;
  historical.manifestVersion = 1;
  historical.workflowPolicyDefaults = undefined;
  await writeFile(schemaPath, `${JSON.stringify(historical, null, 2)}\n`);
  const actorId = id(offset + 4);
  const sessionId = id(offset + 5);
  await createLocalActor(projectRoot, {
    actorId,
    displayName: 'Policy Upgrade User',
    now: NOW,
  });
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  return { actorId, sessionId };
}

function id(offset: number): Ulid {
  return createUlid(
    Date.parse('2026-07-21T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

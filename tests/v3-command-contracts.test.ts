import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contextClose,
  contextDoctor,
  contextReconcileTaskHead,
  contextResume,
  contextSessionNew,
  contextSessionShow,
  contextSessionSpike,
  contextShow,
  contextWorktreeRegister,
} from '../src/commands/context.js';
import { operationRepair, operationShow } from '../src/commands/operation.js';
import {
  teamConflicts,
  teamDecisionPublish,
  teamIdentityCreate,
  teamJoin,
  teamStatus,
} from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import {
  readV3CommandProject,
  resolveV3CommandSession,
} from '../src/commands/v3-support.js';
import { workflow } from '../src/commands/workflow.js';
import { createUlid } from '../src/context/ids.js';
import {
  REQUIREMENT_DIMENSIONS,
  type RequirementsLedgerV1,
  requirementsLedgerDigest,
} from '../src/context/requirements-ledger.js';
import { V3ContextStore } from '../src/context/store.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { readSession } from '../src/runtime/session.js';
import { readLocalActor } from '../src/team/actor.js';

const NOW = new Date('2026-07-17T11:00:00.000Z');

describe('V3 CLI command contracts', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-command-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
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

  it('requires a local identity before bootstrap and exposes an explicit session handoff', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await contextSessionNew(root, { client: 'fixture', json: true }),
      ).toBe(3);
      expect(logs.mock.calls.flat().join(' ')).toContain(
        'MANCODE_LOCAL_ACTOR_REQUIRED',
      );

      expect(
        await teamIdentityCreate(root, { name: 'Fixture User', json: true }),
      ).toBe(0);
      const actor = await readLocalActor(root);
      expect(actor?.displayName).toBe('Fixture User');

      expect(
        await contextSessionNew(root, { client: 'fixture', json: true }),
      ).toBe(0);
      const payload = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        session: { sessionId: string };
        environment: { MANCODE_SESSION_ID: string };
      };
      expect(payload.environment.MANCODE_SESSION_ID).toBe(
        payload.session.sessionId,
      );
      expect(await readSession(root, payload.session.sessionId)).toMatchObject({
        client: 'fixture',
        status: 'active',
      });

      expect(
        await contextSessionShow(root, {
          session: payload.session.sessionId,
          client: 'fixture',
          json: true,
        }),
      ).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        session: {
          sessionId: payload.session.sessionId,
          client: 'fixture',
          activeTaskRef: null,
          activeMode: null,
          lastSeenRevision: null,
        },
      });

      expect(
        await contextSessionShow(root, {
          session: payload.session.sessionId,
          client: 'other-client',
          json: true,
        }),
      ).toBe(3);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_SESSION_NOT_FOUND' },
      });

      expect(
        await contextSessionShow(root, {
          session: 'not-a-session-id',
          json: true,
        }),
      ).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_SESSION_INVALID' },
      });
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it('requires an operator-attested child-command result instead of inferring propagation', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('MANCODE_SPIKE_HOST_SESSION_KEY', 'codex-window-a-private-key');
    vi.stubEnv(
      'MANCODE_SPIKE_SECOND_WINDOW_HOST_SESSION_KEY',
      'codex-window-b-private-key',
    );
    try {
      expect(
        await contextSessionSpike(root, {
          platform: 'codex',
          hostSessionSource: 'api',
          subagentInheritance: 'proven',
          hostVersion: 'fixture-host-1.0.0',
          releaseCandidate: '5c40d6b',
          json: true,
        }),
      ).toBe(3);
      expect(logs.mock.calls.flat().join(' ')).toContain(
        'MANCODE_PLATFORM_SPIKE_COMMAND_PROPAGATION_REQUIRED',
      );
    } finally {
      vi.unstubAllEnvs();
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it('records host-session evidence without persisting host keys and only then resolves a host session', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('MANCODE_SPIKE_HOST_SESSION_KEY', 'codex-window-a-private-key');
    vi.stubEnv(
      'MANCODE_SPIKE_SECOND_WINDOW_HOST_SESSION_KEY',
      'codex-window-b-private-key',
    );
    try {
      expect(
        await contextSessionSpike(root, {
          platform: 'codex',
          hostSessionSource: 'api',
          commandPropagation: 'proven',
          subagentInheritance: 'proven',
          hostVersion: 'fixture-host-1.0.0',
          releaseCandidate: '5c40d6b',
          json: true,
        }),
      ).toBe(0);
      const evidence = String(logs.mock.calls.at(-1)?.[0]);
      expect(evidence).toContain('host_verified');
      expect(evidence).not.toContain('private-key');
      const persisted = await readFile(
        path.join(
          root,
          '.mancode',
          'local',
          'evidence',
          'platform-session',
          'codex.json',
        ),
        'utf8',
      );
      expect(persisted).not.toContain('private-key');

      await teamIdentityCreate(root, { name: 'Fixture User', json: true });
      vi.stubEnv('MANCODE_HOST_SESSION_KEY', 'codex-window-a-private-key');
      const session = await resolveV3CommandSession(
        await readV3CommandProject(root),
        { client: 'codex' },
      );
      expect(session).toMatchObject({
        client: 'codex',
        identitySource: 'host',
      });
      expect(JSON.stringify(session)).not.toContain('private-key');
    } finally {
      vi.unstubAllEnvs();
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it('keeps checkout runtime registration explicit and idempotent', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await contextWorktreeRegister(root, { json: true })).toBe(0);
      const result = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        workspaceId: string;
        checkoutId: string;
      };
      expect(result.workspaceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(result.checkoutId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('lists and shows V3 workflows without deleting durable authority', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await workflow(root, 'list', [], { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        schemaVersion: 1,
        workflows: [],
      });

      await teamIdentityCreate(root, { name: 'Fixture User', json: true });
      await contextSessionNew(root, { client: 'fixture', json: true });
      const sessionId = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;
      await workflow(root, 'create', ['man', 'Discover this V3 task.'], {
        session: sessionId,
        client: 'fixture',
        json: true,
      });
      const created = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        taskRef: { namespace: string; taskId: string };
      };
      const task = `${created.taskRef.namespace}:${created.taskRef.taskId}`;

      expect(await workflow(root, 'list', [], { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        workflows: [
          {
            taskRef: created.taskRef,
            workflowMode: 'man',
            status: 'in_progress',
          },
        ],
      });
      expect(await workflow(root, 'show', [task], { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        taskRef: created.taskRef,
        metadata: {
          task: 'Discover this V3 task.',
          revision: 1,
        },
        activeChildren: [],
      });

      expect(await workflow(root, 'clean', [], { json: true })).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_V3_WORKFLOW_CLEAN_UNSUPPORTED' },
      });
      await expect(
        new V3ContextStore(root).readTaskSnapshot(created.taskRef as TaskRef),
      ).resolves.toMatchObject({
        metadata: { task: 'Discover this V3 task.' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('reports an empty local coordination view and rejects local conflict queries', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await teamConflicts(root, { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        claims: [],
        handoffs: [],
        capabilities: { transport: 'local' },
      });

      expect(
        await teamConflicts(root, { task: `local:${id(11)}`, json: true }),
      ).toBe(3);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_CLAIM_REQUIRES_SHARED_TASK' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('requires explicit Git confirmation and a positive fence revision for reconciliation', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await contextReconcileTaskHead(root, undefined, { json: true }),
      ).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_TASK_REQUIRED' },
      });

      expect(
        await contextReconcileTaskHead(root, `shared:${id(10)}`, {
          expectedFenceRevision: '0',
          fromGit: true,
          json: true,
        }),
      ).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_EXPECTED_REVISION_REQUIRED' },
      });

      expect(
        await contextReconcileTaskHead(root, `shared:${id(10)}`, {
          expectedFenceRevision: '1',
          json: true,
        }),
      ).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_GIT_SOURCE_CONFIRMATION_REQUIRED' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('exposes journal inspection, terminal repair, and doctor diagnostics', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamIdentityCreate(root, { name: 'Fixture User', json: true });
      await contextSessionNew(root, { client: 'fixture', json: true });
      const sessionId = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;
      await workflow(
        root,
        'create',
        ['man', 'Inspect V3 operation recovery.'],
        {
          session: sessionId,
          client: 'fixture',
          json: true,
        },
      );
      const createResult = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        operation: { operationId: string; state: string };
      };
      const operationId = createResult.operation.operationId;

      expect(await operationShow(root, operationId, { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        journal: { operationId, state: 'committed' },
        payloadBound: true,
      });
      expect(
        await operationRepair(root, operationId, {
          session: sessionId,
          client: 'fixture',
          json: true,
        }),
      ).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        state: 'already_terminal',
      });
      expect(await contextDoctor(root, { json: true })).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        operations: [],
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('routes workflow create, context resume/show, and join through V3 authority', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamIdentityCreate(root, { name: 'Fixture User', json: true });
      await contextSessionNew(root, { client: 'fixture', json: true });
      const sessionId = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;

      expect(
        await workflow(root, 'create', ['man', 'Create from the V3 command.'], {
          session: sessionId,
          client: 'fixture',
          json: true,
        }),
      ).toBe(0);
      const createPayload = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        taskRef: { namespace: string; taskId: string };
      };
      expect(createPayload.taskRef.namespace).toBe('local');
      const task = `${createPayload.taskRef.namespace}:${createPayload.taskRef.taskId}`;

      expect(
        await contextResume(root, task, {
          session: sessionId,
          client: 'fixture',
          json: true,
        }),
      ).toBe(0);
      expect(
        await contextShow(root, {
          task,
          session: sessionId,
          client: 'fixture',
          purpose: 'orient',
          level: 'task',
          json: true,
        }),
      ).toBe(0);

      expect(
        await contextShow(root, {
          task,
          client: 'fixture',
          purpose: 'orient',
          level: 'task',
          json: true,
        }),
      ).toBe(0);
      const anonymousRead = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        mutatingAllowed: boolean;
        writeBlockers: Array<{ code: string }>;
        pack: { session: { sessionId: string | null; actorId: string | null } };
      };
      expect(anonymousRead.mutatingAllowed).toBe(false);
      expect(anonymousRead.writeBlockers).toContainEqual({
        code: 'MANCODE_SESSION_REQUIRED',
        operationIds: [],
      });
      expect(anonymousRead.pack.session).toMatchObject({
        sessionId: null,
        actorId: null,
      });

      expect(
        await teamJoin(root, {
          name: 'Fixture User',
          session: sessionId,
          client: 'fixture',
          json: true,
        }),
      ).toBe(0);
      const policyPath = path.join(
        root,
        '.mancode',
        'shared',
        'team',
        'policy.json',
      );
      const policy = JSON.parse(await readFile(policyPath, 'utf8')) as Record<
        string,
        unknown
      >;
      await writeFile(
        policyPath,
        `${JSON.stringify(
          { ...policy, revision: 2, shareConfirmedDecisions: true },
          null,
          2,
        )}\n`,
      );
      expect(
        await teamDecisionPublish(root, {
          title: 'Use the V3 resolver',
          statement: 'Shared planning reads one stable Context Pack.',
          session: sessionId,
          client: 'fixture',
          json: true,
        }),
      ).toBe(2);
      expect(logs.mock.calls.flat().join(' ')).toContain(
        'MANCODE_EXPLICIT_CONFIRMATION_REQUIRED',
      );
      expect(
        await teamDecisionPublish(root, {
          title: 'Use the V3 resolver',
          statement: 'Shared planning reads one stable Context Pack.',
          session: sessionId,
          client: 'fixture',
          confirm: true,
          json: true,
        }),
      ).toBe(0);
      const decisionPayload = JSON.parse(
        String(logs.mock.calls.at(-1)?.[0]),
      ) as {
        decision: { decisionId: string; statement: string };
        event: { eventType: string };
      };
      expect(decisionPayload).toMatchObject({
        decision: {
          statement: 'Shared planning reads one stable Context Pack.',
        },
        event: { eventType: 'confirmed_decision_published' },
      });
      expect(
        (await new V3ContextStore(root).readProjectSnapshot())
          .confirmedDecisions,
      ).toMatchObject([{ decisionId: decisionPayload.decision.decisionId }]);

      expect(
        await contextShow(root, {
          task,
          session: sessionId,
          client: 'fixture',
          purpose: 'plan',
          level: 'task',
          json: true,
        }),
      ).toBe(0);
      const planPack = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        pack: { project: { confirmedDecisions: Array<{ title: string }> } };
      };
      expect(planPack.pack.project.confirmedDecisions).toMatchObject([
        { title: 'Use the V3 resolver' },
      ]);
      expect(await teamStatus(root, { json: true })).toBe(0);
      const sessionFiles = await readdir(
        path.join(root, '.mancode', 'local', 'sessions'),
      );
      expect(
        sessionFiles.filter((name) => name.endsWith('.json')),
      ).toHaveLength(1);
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('keeps supported CLI sessions isolated while they resume the same TaskRef', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamIdentityCreate(root, { name: 'Cross CLI User', json: true });
      await contextSessionNew(root, { client: 'codex', json: true });
      const codexSession = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;
      await contextSessionNew(root, { client: 'claude-code', json: true });
      const claudeSession = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;
      expect(codexSession).not.toBe(claudeSession);

      expect(
        await workflow(root, 'create', ['man', 'Resume across CLI clients.'], {
          session: codexSession,
          client: 'codex',
          json: true,
        }),
      ).toBe(0);
      const created = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        taskRef: { namespace: string; taskId: string };
      };
      const task = `${created.taskRef.namespace}:${created.taskRef.taskId}`;

      expect(
        await contextResume(root, task, {
          session: claudeSession,
          client: 'claude-code',
          json: true,
        }),
      ).toBe(0);
      const resumed = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        taskRevision: number;
        pack: {
          snapshot: {
            taskRevision: number;
            requirementsDigest: string;
            reviewDigest: string;
            verificationDigest: string;
          };
        };
      };
      expect(resumed.taskRevision).toBe(1);
      expect(resumed.pack.snapshot.taskRevision).toBe(1);
      expect(resumed.pack.snapshot.requirementsDigest).toMatch(/^sha256:/);
      expect(resumed.pack.snapshot.reviewDigest).toMatch(/^sha256:/);
      expect(resumed.pack.snapshot.verificationDigest).toMatch(/^sha256:/);

      expect(
        await contextClose(root, { session: codexSession, json: true }),
      ).toBe(0);
      await expect(readSession(root, claudeSession)).resolves.toMatchObject({
        status: 'active',
        activeTaskRef: created.taskRef,
      });

      expect(
        await workflow(root, 'create', ['man', 'Missing identity must fail.'], {
          client: 'cursor',
          json: true,
        }),
      ).toBe(3);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_SESSION_REQUIRED' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('routes requirements finalization through the V3 session and revision gate', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamIdentityCreate(root, { name: 'Fixture User', json: true });
      await contextSessionNew(root, { client: 'fixture', json: true });
      const sessionId = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;
      await workflow(root, 'create', ['man', 'Finalize V3 requirements.'], {
        session: sessionId,
        client: 'fixture',
        json: true,
      });
      const createPayload = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        taskRef: { namespace: 'local' | 'shared'; taskId: string };
      };
      const task = `${createPayload.taskRef.namespace}:${createPayload.taskRef.taskId}`;
      const snapshot = await new V3ContextStore(root).readTaskSnapshot(
        createPayload.taskRef,
      );
      const requirementsPath = path.join(root, 'requirements.json');
      await writeFile(
        requirementsPath,
        `${JSON.stringify(finalizedRequirements(snapshot.requirements), null, 2)}\n`,
      );

      expect(
        await workflow(root, 'requirements', [task, 'finalize'], {
          session: sessionId,
          client: 'fixture',
          file: requirementsPath,
          json: true,
        }),
      ).toBe(2);
      expect(logs.mock.calls.flat().join(' ')).toContain(
        'MANCODE_EXPECTED_REVISION_REQUIRED',
      );

      expect(
        await workflow(root, 'requirements', [task, 'finalize'], {
          session: sessionId,
          client: 'fixture',
          expectedRevision: '1',
          file: requirementsPath,
          json: true,
        }),
      ).toBe(0);
      const result = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        metadata: {
          revision: number;
          governance: { requirementsStatus: string };
        };
        operation: { type: string; state: string };
      };
      expect(result.metadata).toMatchObject({
        revision: 2,
        governance: { requirementsStatus: 'ready' },
      });
      expect(result.operation).toMatchObject({
        type: 'requirements_finalize',
        state: 'committed',
      });

      const planPath = path.join(root, 'plan.md');
      await writeFile(planPath, '# V3 plan\n\n1. Commit the operation.\n');
      expect(
        await workflow(root, 'plan', [task, 'revise'], {
          session: sessionId,
          client: 'fixture',
          expectedRevision: '2',
          planDecision: 'governed_execution',
          file: planPath,
          json: true,
        }),
      ).toBe(0);
      const planResult = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        metadata: {
          revision: number;
          currentStep: number;
          governance: { planDecision: string; planVersion: number };
        };
        operation: { type: string; state: string };
      };
      expect(planResult.metadata).toMatchObject({
        revision: 3,
        currentStep: 5,
        governance: { planDecision: 'governed_execution', planVersion: 2 },
      });
      expect(planResult.operation).toMatchObject({
        type: 'plan_revision',
        state: 'committed',
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('requires reframe concurrency inputs and returns the committed JSON contract', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamIdentityCreate(root, { name: 'Fixture User', json: true });
      await contextSessionNew(root, { client: 'fixture', json: true });
      const sessionId = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;
      await workflow(root, 'create', ['man', 'Reframe through the CLI.'], {
        session: sessionId,
        client: 'fixture',
        json: true,
      });
      const created = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        taskRef: TaskRef;
      };
      const task = `${created.taskRef.namespace}:${created.taskRef.taskId}`;
      const checkpointId = id(60);

      expect(
        await workflow(root, 'reframe', [task], {
          session: sessionId,
          client: 'fixture',
          checkpointId,
          json: true,
        }),
      ).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_EXPECTED_REVISION_REQUIRED' },
      });

      expect(
        await workflow(root, 'reframe', [task], {
          session: sessionId,
          client: 'fixture',
          expectedRevision: '1',
          json: true,
        }),
      ).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'MANCODE_REFRAME_CHECKPOINT_REQUIRED' },
      });

      const snapshot = await new V3ContextStore(root).readTaskSnapshot(
        created.taskRef,
      );
      const requirementsPath = path.join(root, 'reframe-requirements.json');
      await writeFile(
        requirementsPath,
        `${JSON.stringify(finalizedRequirements(snapshot.requirements), null, 2)}\n`,
      );
      expect(
        await workflow(root, 'requirements', [task, 'finalize'], {
          session: sessionId,
          client: 'fixture',
          expectedRevision: '1',
          file: requirementsPath,
          json: true,
        }),
      ).toBe(0);

      const reframeCode = await workflow(root, 'reframe', [task], {
        session: sessionId,
        client: 'fixture',
        expectedRevision: '2',
        checkpointId,
        summary: 'New evidence changes the requirements.',
        nextAction: 'Clarify the replacement requirements.',
        json: true,
      });
      const reframeOutput = String(logs.mock.calls.at(-1)?.[0]);
      expect(reframeCode, reframeOutput).toBe(0);
      const result = JSON.parse(reframeOutput) as {
        schemaVersion: number;
        metadata: { revision: number; currentStep: number };
        requirements: { revision: number; status: string };
        checkpoint: { checkpointId: string; kind: string };
        archive: { archiveId: string; sourceTaskRevision: number };
        operation: { operationId: string; type: string; state: string };
      };
      expect(result).toMatchObject({
        schemaVersion: 1,
        metadata: { revision: 4, currentStep: 2 },
        requirements: { revision: 3, status: 'draft' },
        checkpoint: { checkpointId, kind: 'requirements_reframed' },
        archive: { sourceTaskRevision: 2 },
        operation: { type: 'reframe', state: 'committed' },
      });
      expect(result.archive.archiveId).toBe(result.operation.operationId);
      await expect(
        new V3ContextStore(root).readTaskSnapshot(created.taskRef),
      ).resolves.toMatchObject({
        metadata: { revision: 4, currentStep: 2 },
        requirements: { revision: 3, status: 'draft' },
      });
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('accepts the documented semantic requirements format and allocates V3 identities', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamIdentityCreate(root, { name: 'Fixture User', json: true });
      await contextSessionNew(root, { client: 'fixture', json: true });
      const sessionId = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;
      await workflow(root, 'create', ['man', 'Use semantic requirements.'], {
        session: sessionId,
        client: 'fixture',
        json: true,
      });
      const created = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        taskRef: { namespace: 'local' | 'shared'; taskId: string };
      };
      const task = `${created.taskRef.namespace}:${created.taskRef.taskId}`;
      const inputPath = path.join(root, 'semantic-requirements.json');
      await writeFile(
        inputPath,
        `${JSON.stringify(
          {
            version: 1,
            goal: 'Use a human-authored requirements file.',
            confirmedScope: ['Accept semantic requirements input'],
            excludedScope: ['Require internal ULIDs in the input file'],
            technicalDecisions: ['Use the existing TypeScript stack'],
            defaults: [],
            blockingUnknowns: [],
            coverage: REQUIREMENT_DIMENSIONS.map((dimension) => ({
              dimension,
              status:
                dimension === 'technical_stack' ? 'confirmed' : 'defaulted',
              rationale: `Considered ${dimension}.`,
            })),
            acceptanceCriteria: [
              {
                id: 'AC-1',
                description: 'The semantic file is converted and committed.',
                required: true,
                method: 'automated',
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      expect(
        await workflow(root, 'requirements', [task, 'finalize'], {
          session: sessionId,
          client: 'fixture',
          expectedRevision: '1',
          file: inputPath,
          json: true,
        }),
      ).toBe(0);
      const result = JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
        requirements: RequirementsLedgerV1;
      };
      expect(result.requirements).toMatchObject({
        status: 'confirmed',
        goal: 'Use a human-authored requirements file.',
        functionalScope: {
          inScope: ['Accept semantic requirements input'],
          outOfScope: ['Require internal ULIDs in the input file'],
        },
      });
      expect(result.requirements.requirements).toEqual([]);
      expect(result.requirements.acceptanceCriteria[0]).toMatchObject({
        displayId: 'AC-1',
        legacyId: 'AC-1',
        required: true,
        verificationRequirement: 'automated',
      });
      expect(result.requirements.acceptanceCriteria[0]?.criterionId).toMatch(
        /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
      );
      expect(result.requirements.contentDigest).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });
});

function finalizedRequirements(
  previous: RequirementsLedgerV1,
): RequirementsLedgerV1 {
  const requirementId = id(50);
  const draft: RequirementsLedgerV1 = {
    ...previous,
    revision: 99,
    status: 'confirmed',
    goal: 'Finalize the V3 command contract.',
    functionalScope: { inScope: ['V3 command'], outOfScope: ['Legacy write'] },
    technicalDecisions: [],
    defaults: [],
    coverage: REQUIREMENT_DIMENSIONS.map((dimension, index) => ({
      coverageId: id(30 + index),
      dimension,
      status: dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
      rationale: `Confirmed ${dimension}.`,
    })),
    requirements: [
      {
        displayId: 'REQ-1',
        legacyId: null,
        requirementId,
        statement: 'The command must use V3 authority.',
        priority: 'must',
      },
    ],
    acceptanceCriteria: [
      {
        displayId: 'AC-1',
        legacyId: null,
        criterionId: id(51),
        requirementIds: [requirementId],
        statement: 'The V3 journal commits the requirements mutation.',
        required: true,
        verificationRequirement: 'automated',
      },
    ],
    blockingUnknowns: [],
    contentDigest: '',
    lastOperationId: id(52),
    updatedAt: NOW.toISOString(),
  };
  return {
    ...draft,
    contentDigest: requirementsLedgerDigest(draft),
  };
}

function id(offset: number): string {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

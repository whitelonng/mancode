import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextDoctor } from '../src/commands/context.js';
import { normalizeRequirementsInput } from '../src/commands/requirements-input.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { workflow } from '../src/commands/workflow.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { renderManDeliveryRecord } from '../src/context/man-delivery-runtime.js';
import { planApprovalWarningCodes } from '../src/context/plan-gate.js';
import { presentV3Plan } from '../src/context/plan-present.js';
import { reviseV3Plan } from '../src/context/plan-revision.js';
import { projectProgressTask } from '../src/context/project-progress.js';
import { reframeV3Workflow } from '../src/context/reframe.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import { REQUIREMENT_DIMENSIONS } from '../src/context/requirements-ledger.js';
import { startV3SoloHandoff } from '../src/context/solo-handoff.js';
import { V3ContextStore } from '../src/context/store.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { parseWorkflowMetadata } from '../src/context/workflow-metadata.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
} from '../src/team/actor.js';
import { parseProjectConfig } from '../src/team/policy.js';
import { confirmManteamPlan } from './helpers/manteam-plan.js';
import { confirmPlanForTest } from './helpers/plan-gate.js';

const roots: string[] = [];
const GOAL = 'Callable export returns 2';
const plan =
  '<!-- mancode:plan-baseline:start -->\n# Approved module\nImplement app.cjs, then verify AC-1.\n<!-- mancode:plan-baseline:end -->\n<!-- mancode:delivery-record:start -->\nPlanning only.\n<!-- mancode:delivery-record:end -->\n';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function requirementsInput(goal: string, taskRef: TaskRef) {
  return normalizeRequirementsInput(
    {
      version: 1,
      goal,
      confirmedScope: [goal],
      excludedScope: ['UI'],
      technicalDecisions: [],
      defaults: [],
      blockingUnknowns: [],
      coverage: REQUIREMENT_DIMENSIONS.map((dimension) => ({
        dimension,
        status:
          dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
        rationale: 'Existing local module contract.',
      })),
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: goal,
          required: true,
          method: 'automated',
          verificationSurfaces: { automated: 'component' },
        },
      ],
    },
    taskRef,
  );
}

const plan2 = plan.replace('verify AC-1', 'verify AC-1 twice');
const SCOPE = {
  include: ['app.cjs', 'docs/plan.md'],
  exclude: [],
  modules: [],
};

/** A local man delivery task (planning 4) revised to Step 4 but not decided. */
async function fixture(options: { planning3?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-plan-gate-'));
  roots.push(root);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.test'],
  ]) {
    execFileSync('git', args, { cwd: root });
  }
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, '.gitignore'), '.mancode/\n');
  await writeFile(path.join(root, 'app.cjs'), 'exports.run=()=>1;\n');
  await writeFile(path.join(root, 'docs/plan.md'), plan);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  await initializeV3Project({ projectRoot: root });
  const actorId = createUlid();
  await createLocalActor(root, { actorId, displayName: 'Fixture' });
  const session = await createSession(root, {
    actorId,
    client: 'vitest',
    identitySource: 'explicit',
  });
  const sessionId = session.sessionId;
  const created = await createV3Workflow({
    projectRoot: root,
    task: 'Gate the approved module',
    workflowMode: 'man',
    delivery: true,
    sessionId,
    client: 'vitest',
  });
  const taskRef = created.taskRef;
  const ref = `${taskRef.namespace}:${taskRef.taskId}`;
  const metadataPath = path.join(
    root,
    '.mancode/local/workflows',
    taskRef.taskId,
    'metadata.json',
  );
  if (options.planning3) {
    // A pre-gate task: same shape, planning policy 3.
    const raw = JSON.parse(await readFile(metadataPath, 'utf8'));
    raw.governance.policyVersions.planning = 3;
    await writeFile(metadataPath, `${JSON.stringify(raw, null, 2)}\n`);
  }
  const store = new V3ContextStore(root);
  const snapshot = () => store.readTaskSnapshot(taskRef);
  const ready = await finalizeV3Requirements({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: (await snapshot()).metadata.revision,
    requirements: requirementsInput(GOAL, taskRef),
  });
  await reviseV3Plan({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: ready.metadata.revision,
    plan,
    planSource: 'docs/plan.md',
    implementationScope: SCOPE,
  });
  const revision = async () => (await snapshot()).metadata.revision;
  const base = { projectRoot: root, taskRef, sessionId };
  return {
    root,
    actorId,
    sessionId,
    taskRef,
    ref,
    store,
    snapshot,
    revision,
    metadataPath,
    present: async () =>
      presentV3Plan({ ...base, expectedTaskRevision: await revision() }),
    confirm: async (
      extra: {
        planDecision?: 'plan_only' | 'governed_execution';
        operatorReply?: string;
        unattendedWaiver?: boolean;
      } = {},
    ) =>
      reviseV3Plan({
        ...base,
        expectedTaskRevision: await revision(),
        plan: (await snapshot()).plan?.content as string,
        planDecision: 'governed_execution',
        ...extra,
      }),
  };
}

async function setConfig(root: string, unattendedWaiver: string | undefined) {
  const file = path.join(root, '.mancode/shared/config.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (unattendedWaiver === undefined) raw.unattendedWaiver = undefined;
  else raw.unattendedWaiver = unattendedWaiver;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
}

async function capture(command: () => Promise<number>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await command();
    return {
      code,
      output: [...log.mock.calls, ...error.mock.calls]
        .map((call) => String(call[0]))
        .join('\n'),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('planning policy 4 plan gate', () => {
  it('creates new delivery tasks on planning policy 4', async () => {
    const f = await fixture();
    expect(
      (await f.snapshot()).metadata.governance.policyVersions.planning,
    ).toBe(4);
  });

  it('rejects confirm without a present record', async () => {
    const f = await fixture();
    await expect(
      f.confirm({ operatorReply: 'Looks good, go.' }),
    ).rejects.toThrow('MANCODE_PLAN_PRESENTATION_REQUIRED');
    expect((await f.snapshot()).metadata.governance.planDecision).toBeNull();
  });

  it('invalidates a present after a scope-only revise', async () => {
    const f = await fixture();
    await f.present();
    await reviseV3Plan({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: await f.revision(),
      plan,
      planSource: 'docs/plan.md',
      implementationScope: {
        ...SCOPE,
        include: [...SCOPE.include, 'extra.cjs'],
      },
    });
    await expect(
      f.confirm({ operatorReply: 'Looks good, go.' }),
    ).rejects.toThrow('MANCODE_PLAN_PRESENTATION_STALE');
  });

  it('invalidates a present after a plan revise', async () => {
    const f = await fixture();
    await f.present();
    await writeFile(path.join(f.root, 'docs/plan.md'), plan2);
    await reviseV3Plan({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: await f.revision(),
      plan: plan2,
      planSource: 'docs/plan.md',
    });
    await expect(
      f.confirm({ operatorReply: 'Looks good, go.' }),
    ).rejects.toThrow('MANCODE_PLAN_PRESENTATION_STALE');
  });

  it('requires exactly one valid operator reply or waiver', async () => {
    const f = await fixture();
    await f.present();
    await expect(f.confirm()).rejects.toThrow(
      'MANCODE_PLAN_OPERATOR_REPLY_REQUIRED',
    );
    await expect(f.confirm({ operatorReply: '   ' })).rejects.toThrow(
      'MANCODE_PLAN_OPERATOR_REPLY_REQUIRED',
    );
    await expect(
      f.confirm({ operatorReply: 'x'.repeat(2001) }),
    ).rejects.toThrow('MANCODE_PLAN_OPERATOR_REPLY_INVALID');
    await expect(f.confirm({ operatorReply: GOAL })).rejects.toThrow(
      'MANCODE_PLAN_OPERATOR_REPLY_REUSED',
    );
    await expect(
      f.confirm({ operatorReply: 'ok', unattendedWaiver: true }),
    ).rejects.toThrow('MANCODE_PLAN_APPROVAL_INPUT_CONFLICT');
    expect((await f.snapshot()).metadata.governance.planDecision).toBeNull();
  });

  it('records an operator reply approval bound to the presented plan', async () => {
    const f = await fixture();
    const presented = await f.present();
    expect(presented.instruction).toBe(
      'Show this plan to the operator and wait for their reply before running plan confirm.',
    );
    expect(presented.summary).toMatchObject({
      planFile: 'docs/plan.md',
      scope: SCOPE,
      acceptanceCriteria: [{ id: 'AC-1', statement: GOAL, required: true }],
    });
    const confirmed = await f.confirm({
      operatorReply: '  Yes, implement it as shown.  ',
    });
    const governance = confirmed.metadata.governance;
    expect(governance.planDecision).toBe('governed_execution');
    expect(governance.planApproval).toMatchObject({
      approvalSource: 'operator_reply',
      operatorReply: 'Yes, implement it as shown.',
      decision: 'governed_execution',
      planVersion: governance.planVersion,
      presentedAt: presented.presentation.presentedAt,
      presentationOperationId: presented.presentation.operationId,
    });
  });

  it('records an unattended waiver and flags it on delivery inspect and check', async () => {
    const f = await fixture();
    await f.present();
    const confirmed = await f.confirm({ unattendedWaiver: true });
    expect(confirmed.metadata.governance.planApproval).toMatchObject({
      approvalSource: 'unattended_waiver',
    });
    expect(
      confirmed.metadata.governance.planApproval?.operatorReply,
    ).toBeUndefined();
    const inspected = await capture(() =>
      workflow(f.root, 'delivery', [f.ref, 'inspect'], { json: true }),
    );
    expect(inspected.output).toContain('"approvalSource":"unattended_waiver"');
    expect(inspected.output).toContain('UNATTENDED_WAIVER');
  });

  it('keeps a consumed present from approving twice', async () => {
    const f = await fixture();
    await f.present();
    await f.confirm({
      planDecision: 'plan_only',
      operatorReply: 'Plan only for now.',
    });
    await expect(
      f.confirm({ operatorReply: 'Now implement it.' }),
    ).rejects.toThrow('MANCODE_PLAN_PRESENTATION_CONSUMED');
  });

  it('gates plan_only to governed_execution resumption on a fresh present and reply', async () => {
    const f = await fixture();
    await f.present();
    await f.confirm({
      planDecision: 'plan_only',
      operatorReply: 'Plan only for now.',
    });
    await expect(f.confirm()).rejects.toThrow(
      'MANCODE_PLAN_PRESENTATION_CONSUMED',
    );
    await f.present();
    await expect(f.confirm()).rejects.toThrow(
      'MANCODE_PLAN_OPERATOR_REPLY_REQUIRED',
    );
    const resumed = await f.confirm({ operatorReply: 'Approved: implement.' });
    expect(resumed.metadata.governance).toMatchObject({
      planDecision: 'governed_execution',
      planApproval: { operatorReply: 'Approved: implement.' },
    });
  });

  it('rejects a plan decision on revise under policy 4 (library and CLI)', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'docs/plan.md'), plan2);
    await expect(
      reviseV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: await f.revision(),
        plan: plan2,
        planSource: 'docs/plan.md',
        planDecision: 'governed_execution',
        operatorReply: 'Go.',
      }),
    ).rejects.toThrow('MANCODE_PLAN_DECISION_ON_REVISE_REJECTED');
    const cli = await capture(async () =>
      workflow(f.root, 'plan', [f.ref, 'revise'], {
        session: f.sessionId,
        client: 'vitest',
        json: true,
        file: 'docs/plan.md',
        expectedRevision: String(await f.revision()),
        planDecision: 'governed_execution',
      }),
    );
    expect(cli.code).not.toBe(0);
    expect(cli.output).toContain('MANCODE_PLAN_DECISION_ON_REVISE_REJECTED');
    expect((await f.snapshot()).metadata.governance.planDecision).toBeNull();
  });

  it('gates solo handoff on present and a reply or waiver', async () => {
    const f = await fixture();
    const start = async (
      extra: { operatorReply?: string; unattendedWaiver?: boolean } = {},
    ) =>
      startV3SoloHandoff({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: await f.revision(),
        ...extra,
      });
    await expect(start({ operatorReply: 'Hand it off.' })).rejects.toThrow(
      'MANCODE_PLAN_PRESENTATION_REQUIRED',
    );
    await f.present();
    await expect(start()).rejects.toThrow(
      'MANCODE_PLAN_OPERATOR_REPLY_REQUIRED',
    );
    const started = await start({ operatorReply: 'Hand it off to solo.' });
    expect(started.metadata.governance).toMatchObject({
      planDecision: 'solo_handoff',
      planApproval: {
        approvalSource: 'operator_reply',
        decision: 'solo_handoff',
      },
    });
  });

  it('requires a fresh present and approval after reframe', async () => {
    const f = await fixture();
    await f.present();
    await f.confirm({ operatorReply: 'Approved: implement.' });
    const reframed = await reframeV3Workflow({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: await f.revision(),
      checkpointId: createUlid(),
      summary: 'Requirements changed.',
      nextAction: 'Clarify requirements.',
    });
    expect(reframed.metadata.governance.planDecision).toBeNull();
    expect(reframed.metadata.governance.planApproval).toBeUndefined();
    expect(reframed.metadata.governance.planPresentation).toBeUndefined();
    const ready = await finalizeV3Requirements({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: await f.revision(),
      requirements: requirementsInput('Callable export returns 3', f.taskRef),
    });
    expect(ready.metadata.governance.planDecision).toBeNull();
    await writeFile(path.join(f.root, 'docs/plan.md'), plan2);
    await reviseV3Plan({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: ready.metadata.revision,
      plan: plan2,
      planSource: 'docs/plan.md',
      implementationScope: SCOPE,
    });
    await expect(
      f.confirm({ operatorReply: 'Approved again.' }),
    ).rejects.toThrow('MANCODE_PLAN_PRESENTATION_REQUIRED');
  });

  it('is idempotent for an unchanged tuple and re-presents after any change', async () => {
    const f = await fixture();
    const first = await f.present();
    expect(first.idempotent).toBe(false);
    const revision = await f.revision();
    const again = await f.present();
    expect(again.idempotent).toBe(true);
    expect(again.presentation).toEqual(first.presentation);
    expect(await f.revision()).toBe(revision);
    expect(again.operation).toBeNull();
  });

  it('serves present through the CLI with the summary and instruction', async () => {
    const f = await fixture();
    const result = await capture(async () =>
      workflow(f.root, 'plan', [f.ref, 'present'], {
        session: f.sessionId,
        client: 'vitest',
        json: true,
        expectedRevision: String(await f.revision()),
      }),
    );
    expect(result.code, result.output).toBe(0);
    const body = JSON.parse(result.output);
    expect(body.instruction).toContain('wait for their reply');
    expect(body.summary.planFile).toBe('docs/plan.md');
    expect(body.summary.acceptanceCriteria[0].id).toBe('AC-1');
    const confirmed = await capture(async () =>
      workflow(f.root, 'plan', [f.ref, 'confirm'], {
        session: f.sessionId,
        client: 'vitest',
        json: true,
        expectedRevision: String(await f.revision()),
        planDecision: 'governed_execution',
        operatorReply: 'Yes, proceed with the plan.',
      }),
    );
    expect(confirmed.code, confirmed.output).toBe(0);
  });

  it('recovers plan_present at every crash point', async () => {
    for (const crash of OPERATION_CRASH_FIXTURES.plan_present) {
      const f = await fixture();
      const before = await f.snapshot();
      const operationId = createUlid();
      await expect(
        withOperationCrashInjectionForTesting(crash, () =>
          presentV3Plan({
            projectRoot: f.root,
            taskRef: f.taskRef,
            sessionId: f.sessionId,
            expectedTaskRevision: before.metadata.revision,
            operationId,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
      const recovered = await capture(() =>
        contextDoctor(f.root, {
          session: f.sessionId,
          client: 'vitest',
          json: true,
          repair: operationId,
        }),
      );
      expect(recovered.code, recovered.output).toBe(0);
      const after = await f.snapshot();
      if (['prepared', 'validate'].includes(crash.crashAfter)) {
        expect(after.metadata).toEqual(before.metadata);
      } else {
        expect(after.metadata.governance.planPresentation).toMatchObject({
          operationId,
        });
      }
      expect(after.aggregateError).toBeNull();
    }
  });
});

describe('unattended waiver policy', () => {
  async function waiverOutcome(f: Awaited<ReturnType<typeof fixture>>) {
    await f.present();
    return f.confirm({ unattendedWaiver: true });
  }

  it('is allowed by default for a local single task', async () => {
    const f = await fixture();
    await expect(waiverOutcome(f)).resolves.toMatchObject({
      metadata: {
        governance: { planApproval: { approvalSource: 'unattended_waiver' } },
      },
    });
  });

  it('can be forbidden explicitly on a local task with the specific error', async () => {
    const f = await fixture();
    await setConfig(f.root, 'forbidden');
    await f.present();
    const error = await f.confirm({ unattendedWaiver: true }).catch((e) => e);
    expect(String(error)).toContain('MANCODE_UNATTENDED_WAIVER_FORBIDDEN');
    expect(String(error)).toContain('--operator-reply');
    // An operator reply still works.
    await expect(
      f.confirm({ operatorReply: 'Approved: implement.' }),
    ).resolves.toBeDefined();
  });

  it('applies the same policy to solo handoff and plan_only resumption', async () => {
    const f = await fixture();
    await setConfig(f.root, 'forbidden');
    await f.present();
    await expect(
      startV3SoloHandoff({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: await f.revision(),
        unattendedWaiver: true,
      }),
    ).rejects.toThrow('MANCODE_UNATTENDED_WAIVER_FORBIDDEN');
    await f.confirm({
      planDecision: 'plan_only',
      operatorReply: 'Plan only for now.',
    });
    await f.present();
    await expect(f.confirm({ unattendedWaiver: true })).rejects.toThrow(
      'MANCODE_UNATTENDED_WAIVER_FORBIDDEN',
    );
  });

  it('rejects an invalid configured value and keeps absent as the default', async () => {
    const f = await fixture();
    const raw = JSON.parse(
      await readFile(path.join(f.root, '.mancode/shared/config.json'), 'utf8'),
    );
    expect(() =>
      parseProjectConfig({ ...raw, unattendedWaiver: 'maybe' }),
    ).toThrow('unattendedWaiver is invalid');
    expect(parseProjectConfig(raw).unattendedWaiver).toBeUndefined();
    expect(
      parseProjectConfig({ ...raw, unattendedWaiver: 'allowed' })
        .unattendedWaiver,
    ).toBe('allowed');
  });
});

async function sharedFixtureForOwner() {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-plan-gate-team-'));
  roots.push(root);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.test'],
  ]) {
    execFileSync('git', args, { cwd: root });
  }
  await writeFile(path.join(root, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  await initializeV3Project({ projectRoot: root });
  const ownerActorId = createUlid();
  await createLocalActor(root, {
    actorId: ownerActorId,
    displayName: 'Owner',
  });
  const owner = await readLocalActor(root);
  if (owner === null) throw new Error('missing owner');
  const now = new Date();
  await publishSharedActorProfile(root, createSharedActorProfile(owner, now));
  const participantActorId = createUlid();
  await publishSharedActorProfile(root, {
    schemaVersion: 1,
    actorId: participantActorId,
    displayName: 'Participant',
    joinedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const ownerSession = (
    await createSession(root, {
      actorId: ownerActorId,
      client: 'owner',
      identitySource: 'explicit',
    })
  ).sessionId;
  const participantSession = (
    await createSession(root, {
      actorId: participantActorId,
      client: 'participant',
      identitySource: 'explicit',
    })
  ).sessionId;
  const created = await createV3Workflow({
    projectRoot: root,
    task: 'Shared gated plan',
    workflowMode: 'manteam',
    sessionId: ownerSession,
    client: 'vitest',
    sharedPrivacyConfirmed: true,
    implementationScope: { include: ['src/**'], modules: ['auth'] },
    participantActorIds: [participantActorId],
  });
  await confirmManteamPlan({
    projectRoot: root,
    taskRef: created.taskRef,
    sessionId: ownerSession,
    requirements: created.requirements,
    now,
    confirm: false,
  });
  const store = new V3ContextStore(root);
  const revision = async () =>
    (await store.readTaskSnapshot(created.taskRef)).metadata.revision;
  return {
    root,
    taskRef: created.taskRef,
    ownerSession: ownerSession as Ulid,
    participantSession: participantSession as Ulid,
    store,
    revision,
  };
}

describe('shared manteam plan gate', () => {
  it('creates manteam tasks on planning policy 4 and limits present/confirm to the owner', async () => {
    const f = await sharedFixtureForOwner();
    const snapshot = await f.store.readTaskSnapshot(f.taskRef);
    expect(snapshot.metadata.governance.policyVersions.planning).toBe(4);
    await expect(
      presentV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.participantSession,
        expectedTaskRevision: await f.revision(),
      }),
    ).rejects.toThrow('MANCODE_TASK_OWNER_REQUIRED');
    await presentV3Plan({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.ownerSession,
      expectedTaskRevision: await f.revision(),
    });
    await expect(
      reviseV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.participantSession,
        expectedTaskRevision: await f.revision(),
        plan: snapshot.plan?.content as string,
        planDecision: 'governed_execution',
        operatorReply: 'Participant tries to approve.',
      }),
    ).rejects.toThrow('MANCODE_TASK_OWNER_REQUIRED');
  });

  it('forbids the waiver by default, screens replies, and honors an explicit allow', async () => {
    const f = await sharedFixtureForOwner();
    const plan = (await f.store.readTaskSnapshot(f.taskRef)).plan
      ?.content as string;
    const confirm = async (extra: {
      operatorReply?: string;
      unattendedWaiver?: boolean;
    }) =>
      reviseV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.ownerSession,
        expectedTaskRevision: await f.revision(),
        plan,
        planDecision: 'governed_execution',
        ...extra,
      });
    await presentV3Plan({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.ownerSession,
      expectedTaskRevision: await f.revision(),
    });
    await expect(confirm({ unattendedWaiver: true })).rejects.toThrow(
      'MANCODE_UNATTENDED_WAIVER_FORBIDDEN',
    );
    await expect(
      confirm({
        operatorReply:
          'Contact me at secret@example.com or sk-live-1234567890abcdef.',
      }),
    ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
    await setConfig(f.root, 'allowed');
    const confirmed = await confirm({ unattendedWaiver: true });
    expect(confirmed.metadata.governance.planApproval).toMatchObject({
      approvalSource: 'unattended_waiver',
    });
  });
});

describe('policy 1-3 tasks keep the original confirm semantics', () => {
  it('confirms directly, rejects gate inputs and present, and allows revise with a decision', async () => {
    const f = await fixture({ planning3: true });
    const snapshot = await f.snapshot();
    expect(snapshot.metadata.governance.policyVersions.planning).toBe(3);
    await expect(f.present()).rejects.toThrow('MANCODE_PLAN_GATE_NOT_ENABLED');
    await expect(f.confirm({ operatorReply: 'Go.' })).rejects.toThrow(
      'MANCODE_PLAN_GATE_NOT_ENABLED',
    );
    await expect(f.confirm({ unattendedWaiver: true })).rejects.toThrow(
      'MANCODE_PLAN_GATE_NOT_ENABLED',
    );
    // Revise-with-decision in one call is unchanged for planning 3.
    await writeFile(path.join(f.root, 'docs/plan.md'), plan2);
    const revised = await reviseV3Plan({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: await f.revision(),
      plan: plan2,
      planSource: 'docs/plan.md',
      planDecision: 'governed_execution',
    });
    expect(revised.metadata.governance.planDecision).toBe('governed_execution');
    expect(revised.metadata.governance.planApproval).toBeUndefined();
    expect(revised.metadata.governance.planPresentation).toBeUndefined();
  });

  it('keeps policy 3 confirm and solo handoff working without any gate record', async () => {
    const f = await fixture({ planning3: true });
    const started = await startV3SoloHandoff({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: await f.revision(),
    });
    expect(started.metadata.governance.planDecision).toBe('solo_handoff');
    expect(started.metadata.governance.planApproval).toBeUndefined();
    const g = await fixture({ planning3: true });
    const confirmed = await confirmPlanForTest({
      projectRoot: g.root,
      taskRef: g.taskRef,
      sessionId: g.sessionId,
      decision: 'governed_execution',
    });
    expect(confirmed.metadata.governance.planDecision).toBe(
      'governed_execution',
    );
  });

  it('round-trips metadata byte-identically without gate fields and rejects them below policy 4', async () => {
    const f = await fixture({ planning3: true });
    const raw = JSON.parse(await readFile(f.metadataPath, 'utf8'));
    expect('planApproval' in raw.governance).toBe(false);
    expect('planPresentation' in raw.governance).toBe(false);
    expect(JSON.stringify(parseWorkflowMetadata(raw))).toBe(
      JSON.stringify(raw),
    );
    const g = await fixture();
    await g.present();
    const gated = JSON.parse(await readFile(g.metadataPath, 'utf8'));
    expect(JSON.stringify(parseWorkflowMetadata(gated))).toBe(
      JSON.stringify(gated),
    );
    gated.governance.policyVersions.planning = 3;
    expect(() => parseWorkflowMetadata(gated)).toThrow(
      'MANCODE_PLAN_GATE_POLICY_REQUIRED',
    );
  });
});

describe('plan gate review fixes', () => {
  it('requires a matching approval record for a decided planning-4 task', async () => {
    const f = await fixture();
    await f.present();
    await f.confirm({ operatorReply: 'Approved: implement.' });
    const raw = JSON.parse(await readFile(f.metadataPath, 'utf8'));
    expect(() => parseWorkflowMetadata(raw)).not.toThrow();
    const missing = structuredClone(raw);
    missing.governance.planApproval = undefined;
    expect(() => parseWorkflowMetadata(missing)).toThrow(
      'MANCODE_PLAN_APPROVAL_RECORD_REQUIRED',
    );
    const mismatch = structuredClone(raw);
    mismatch.governance.planApproval.decision = 'plan_only';
    expect(() => parseWorkflowMetadata(mismatch)).toThrow('decision mismatch');
  });

  it('accepts honest short replies and repeated replies, but not normalised copies', async () => {
    for (const reply of ['confirmed', 'automated', 'component', 'Approved.']) {
      const f = await fixture();
      await f.present();
      await expect(f.confirm({ operatorReply: reply })).resolves.toBeDefined();
    }
    const f = await fixture();
    await f.present();
    await f.confirm({
      planDecision: 'plan_only',
      operatorReply: 'Approved.',
    });
    await f.present();
    await expect(
      f.confirm({ operatorReply: 'Approved.' }),
    ).resolves.toBeDefined();
    const g = await fixture();
    await g.present();
    for (const copy of [
      `${GOAL}.`,
      `  ${GOAL.toUpperCase()}!!  `,
      GOAL.replace(/ /g, '   '),
      'ui',
    ]) {
      // 'ui' is a human-authored excluded-scope item, so it counts as a copy.
      await expect(g.confirm({ operatorReply: copy })).rejects.toThrow(
        'MANCODE_PLAN_OPERATOR_REPLY_REUSED',
      );
    }
    await expect(g.confirm({ operatorReply: '...' })).rejects.toThrow(
      'MANCODE_PLAN_OPERATOR_REPLY_REQUIRED',
    );
  });

  it('refuses to present a drifted bound plan without burning a revision', async () => {
    const f = await fixture();
    const revision = await f.revision();
    await writeFile(path.join(f.root, 'docs/plan.md'), plan2);
    await expect(f.present()).rejects.toThrow('MANCODE_MAN_PLAN');
    expect(await f.revision()).toBe(revision);
    expect(
      (await f.snapshot()).metadata.governance.planPresentation,
    ).toBeUndefined();
  });

  it('flags a changed scope after approval on inspect, check and progress', async () => {
    const f = await fixture();
    await f.present();
    await f.confirm({ unattendedWaiver: true });
    const approved = await f.snapshot();
    expect(planApprovalWarningCodes(approved.metadata)).toEqual([
      'UNATTENDED_WAIVER',
    ]);
    expect(projectProgressTask(approved).approvalWarnings).toEqual([
      'UNATTENDED_WAIVER',
    ]);
    const raw = JSON.parse(await readFile(f.metadataPath, 'utf8'));
    const scope = {
      source: raw.implementationScope.source,
      include: [...raw.implementationScope.include, 'extra.cjs'],
      exclude: raw.implementationScope.exclude,
      modules: raw.implementationScope.modules,
    };
    raw.implementationScope = { ...scope, digest: digestCanonicalJson(scope) };
    await writeFile(f.metadataPath, `${JSON.stringify(raw, null, 2)}\n`);
    const changed = await f.snapshot();
    expect(planApprovalWarningCodes(changed.metadata)).toEqual([
      'UNATTENDED_WAIVER',
      'PLAN_APPROVAL_SCOPE_CHANGED',
    ]);
    expect(projectProgressTask(changed).approvalWarnings).toContain(
      'PLAN_APPROVAL_SCOPE_CHANGED',
    );
    const inspected = await capture(() =>
      workflow(f.root, 'delivery', [f.ref, 'inspect'], { json: true }),
    );
    expect(inspected.output).toContain('PLAN_APPROVAL_SCOPE_CHANGED');
    expect(renderManDeliveryRecord(changed)).toContain(
      'Plan approval warning: PLAN_APPROVAL_SCOPE_CHANGED',
    );
  });

  it('lets only the owner present, even when an identical presentation exists', async () => {
    const f = await sharedFixtureForOwner();
    await presentV3Plan({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.ownerSession,
      expectedTaskRevision: await f.revision(),
    });
    await expect(
      presentV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.participantSession,
        expectedTaskRevision: await f.revision(),
      }),
    ).rejects.toThrow('MANCODE_TASK_OWNER_REQUIRED');
  });

  it('gates the solo handoff CLI on --operator-reply', async () => {
    const f = await fixture();
    const run = (extra: Record<string, unknown>) =>
      capture(async () =>
        workflow(f.root, 'handoff', [f.ref], {
          session: f.sessionId,
          client: 'vitest',
          json: true,
          to: 'solo',
          expectedRevision: String(await f.revision()),
          ...extra,
        }),
      );
    const blocked = await run({ operatorReply: 'Hand it off.' });
    expect(blocked.code).not.toBe(0);
    expect(blocked.output).toContain('MANCODE_PLAN_PRESENTATION_REQUIRED');
    await f.present();
    const started = await run({ operatorReply: 'Yes, hand it to solo.' });
    expect(started.code, started.output).toBe(0);
    expect((await f.snapshot()).metadata.governance).toMatchObject({
      planDecision: 'solo_handoff',
      planApproval: { approvalSource: 'operator_reply' },
    });
  });
});

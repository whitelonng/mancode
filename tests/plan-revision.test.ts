import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextDoctor, contextResume } from '../src/commands/context.js';
import { operationShow } from '../src/commands/operation.js';
import { normalizeRequirementsInput } from '../src/commands/requirements-input.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { workflow } from '../src/commands/workflow.js';
import { createUlid } from '../src/context/ids.js';
import { reviseV3Plan } from '../src/context/plan-revision.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import { REQUIREMENT_DIMENSIONS } from '../src/context/requirements-ledger.js';
import { V3ContextStore } from '../src/context/store.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { updateV3Workflow } from '../src/context/workflow-update.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import {
  enqueueCacheInvalidationProjection,
  enqueueSessionPointerProjection,
  inspectOperationProjectionState,
  listProjectionIntents,
  projectionCachePath,
  reconcileProjectionIntents,
} from '../src/runtime/projection-outbox.js';
import * as sessionModule from '../src/runtime/session.js';
import {
  closeSession,
  createSession,
  readSession,
  resumeSession,
} from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';

const roots: string[] = [];
const plan =
  '<!-- mancode:plan-baseline:start -->\n# Approved module\nImplement app.cjs, then verify AC-1.\n<!-- mancode:plan-baseline:end -->\n<!-- mancode:delivery-record:start -->\nPlanning only.\n<!-- mancode:delivery-record:end -->\n';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    delivery?: boolean;
    missingScope?: boolean;
    pendingClear?: boolean;
    pendingCreate?: boolean;
    sharedMode?: 'man' | 'manteam';
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-plan-resume-'));
  roots.push(root);
  const delivery = options.delivery ?? options.sharedMode === undefined;
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
  const actor = await createLocalActor(root, {
    actorId,
    displayName: 'Fixture',
  });
  if (options.sharedMode)
    await publishSharedActorProfile(
      root,
      createSharedActorProfile(actor, new Date()),
    );
  const session = await createSession(root, {
    actorId,
    client: 'vitest',
    identitySource: 'explicit',
  });
  const sessionId = session.sessionId;
  const sessionLock = path.join(
    root,
    '.mancode/local/sessions',
    `.${sessionId}.lock`,
  );
  if (options.pendingCreate) await mkdir(sessionLock);
  const created = await createV3Workflow({
    projectRoot: root,
    task: 'Resume the approved module',
    workflowMode: options.sharedMode ?? 'man',
    delivery,
    sessionId,
    client: 'vitest',
    ...(options.sharedMode
      ? ({
          visibility: 'shared',
          coordination: options.sharedMode === 'man' ? 'single' : 'team',
          sharedPrivacyConfirmed: true,
        } as const)
      : {}),
  });
  if (options.pendingCreate) await rm(sessionLock, { recursive: true });
  const taskRef = created.taskRef;
  const ref = `${taskRef.namespace}:${taskRef.taskId}`;
  const ready = await finalizeV3Requirements({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: created.metadata.revision,
    requirements: normalizeRequirementsInput(
      {
        version: 1,
        goal: 'Callable export returns 2',
        confirmedScope: ['Callable export returns 2'],
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
            description: 'Callable export returns 2',
            required: true,
            method: 'automated',
            verificationSurfaces: { automated: 'component' },
          },
        ],
      },
      taskRef,
    ),
  });
  const revised = await reviseV3Plan({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: ready.metadata.revision,
    plan,
    ...(delivery ? { planSource: 'docs/plan.md' } : {}),
    ...(options.missingScope
      ? {}
      : {
          implementationScope: {
            include: ['app.cjs', 'docs/plan.md'],
            exclude: [],
            modules: [],
          },
        }),
  });
  const store = new V3ContextStore(root);
  const current = await store.readTaskSnapshot(taskRef);
  if (current.plan === null) throw new Error('Fixture plan missing');
  const planContent = current.plan.content;
  if (options.pendingClear) await mkdir(sessionLock);
  const planned = await reviseV3Plan({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: revised.metadata.revision,
    plan: planContent,
    planDecision: 'plan_only',
  });
  if (options.pendingClear) await rm(sessionLock, { recursive: true });
  return {
    root,
    actorId,
    sessionId,
    taskRef,
    ref,
    store,
    created,
    planned,
    planContent,
    snapshot: () => store.readTaskSnapshot(taskRef),
  };
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

describe('explicit plan-only execution resumption', () => {
  it.each([true, false])(
    'resumes the same task and unchanged authority through public confirmation (delivery=%s)',
    async (delivery) => {
      const f = await fixture({ delivery });
      const before = await f.snapshot();
      const nextSession = await createSession(f.root, {
        actorId: f.actorId,
        client: 'vitest',
        identitySource: 'explicit',
      });
      const options = {
        session: nextSession.sessionId,
        client: 'vitest',
        json: true,
      };
      expect(
        (await capture(() => contextResume(f.root, f.ref, options))).code,
      ).toBe(0);
      expect((await f.snapshot()).metadata).toEqual(before.metadata);
      if (delivery)
        await writeFile(
          path.join(f.root, 'docs/plan.md'),
          plan.replace(
            'Planning only.',
            'Planning complete; operator approved execution.',
          ),
        );
      const confirmed = await capture(() =>
        workflow(f.root, 'plan', [f.ref, 'confirm'], {
          ...options,
          expectedRevision: String(before.metadata.revision),
          planDecision: 'governed_execution',
        }),
      );
      expect(confirmed.code, confirmed.output).toBe(0);
      const after = await f.snapshot();
      expect(after.metadata).toMatchObject({
        taskRef: before.metadata.taskRef,
        status: 'in_progress',
        currentStep: 5,
        revision: before.metadata.revision + 1,
        implementationScope: before.metadata.implementationScope,
        governance: {
          planDecision: 'governed_execution',
          planVersion: before.metadata.governance.planVersion,
          policyVersions: before.metadata.governance.policyVersions,
        },
      });
      expect(after.plan).toEqual(before.plan);
      expect(after.requirements).toEqual(before.requirements);
      expect(after.review).toEqual(before.review);
      expect(after.verification).toEqual(before.verification);
      expect(after.aggregateError).toBeNull();
      expect(await readSession(f.root, nextSession.sessionId)).toMatchObject({
        activeTaskRef: f.taskRef,
        lastSeenRevision: after.metadata.revision,
      });
      expect(
        await inspectOperationProjectionState(
          f.root,
          f.planned.operation.operationId,
        ),
      ).toMatchObject({ sessionPointer: 'not_applicable' });
      expect(
        (
          await reconcileProjectionIntents(
            f.root,
            f.planned.operation.operationId,
          )
        ).state,
      ).toBe('converged');
      expect(
        (
          await capture(() =>
            workflow(f.root, 'complete', [f.ref], {
              ...options,
              expectedRevision: String(after.metadata.revision),
            }),
          )
        ).code,
      ).not.toBe(0);
    },
  );

  it('allows lifecycle reactivation but requires a separate explicit unchanged-plan decision', async () => {
    const f = await fixture();
    const active = await updateV3Workflow({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: f.planned.metadata.revision,
      status: 'in_progress',
    });
    expect(active.metadata.governance.planDecision).toBe('plan_only');
    const input = {
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: active.metadata.revision,
      plan: f.planContent,
    };
    await expect(reviseV3Plan(input)).rejects.toThrow(
      'MANCODE_PLAN_REQUIREMENTS_OR_DECISION_INVALID',
    );
    await expect(
      reviseV3Plan({ ...input, planDecision: 'governed_execution' }),
    ).resolves.toMatchObject({
      metadata: {
        currentStep: 5,
        governance: { planDecision: 'governed_execution' },
      },
    });
  });

  it.each(['clear', 'resume'] as const)(
    'does not reopen a completed %s intent after another session terminates the resumed task',
    async (action) => {
      const f = await fixture();
      await resumeSession(f.root, f.sessionId, {
        taskRef: f.taskRef,
        workflowMode: 'man',
        taskRevision: f.planned.metadata.revision,
      });
      const next = await createSession(f.root, {
        actorId: f.actorId,
        client: 'vitest',
        identitySource: 'explicit',
      });
      const continued = await reviseV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: next.sessionId,
        expectedTaskRevision: f.planned.metadata.revision,
        plan: f.planContent,
        planDecision: 'governed_execution',
      });
      await updateV3Workflow({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: next.sessionId,
        expectedTaskRevision: continued.metadata.revision,
        status: 'abandoned',
      });
      const operationId =
        action === 'clear'
          ? f.planned.operation.operationId
          : f.created.operation.operationId;
      expect(
        await listProjectionIntents(f.root, {
          operationId,
          includeTerminal: true,
        }),
      ).toMatchObject([{ state: 'completed', target: { action } }]);
      const beforeTask = await f.snapshot();
      const beforeSession = await readSession(f.root, f.sessionId);
      expect(beforeSession?.activeTaskRef).toEqual(f.taskRef);
      const shown = await capture(() =>
        operationShow(f.root, operationId, { json: true }),
      );
      expect(shown.code, shown.output).toBe(0);
      expect(JSON.parse(shown.output)).toMatchObject({
        journal: { state: 'committed' },
        recoveryAction: 'none',
        recoveryReason: 'terminal',
      });
      expect(
        (await reconcileProjectionIntents(f.root, operationId)).state,
      ).toBe('converged');
      expect(await readSession(f.root, f.sessionId)).toEqual(beforeSession);
      expect(await f.snapshot()).toEqual(beforeTask);

      // Finishing the session side effect must not hide other work on this operation.
      const cache = await enqueueCacheInvalidationProjection(f.root, {
        operationId,
        cacheKind: 'context_pack',
        taskRef: f.taskRef,
      });
      if (cache.target.kind !== 'cache_invalidation')
        throw new Error('Expected cache projection');
      const cachePath = projectionCachePath(f.root, cache.target);
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, 'stale cache');
      expect(
        await inspectOperationProjectionState(f.root, operationId),
      ).toMatchObject({ sessionPointer: 'not_applicable', cache: 'missing' });
      await reconcileProjectionIntents(f.root, operationId);
      expect(
        await inspectOperationProjectionState(f.root, operationId),
      ).toMatchObject({ sessionPointer: 'not_applicable', cache: 'present' });
      expect(await readSession(f.root, f.sessionId)).toEqual(beforeSession);
      expect(await f.snapshot()).toEqual(beforeTask);
    },
  );

  it.each([false, true])(
    'does not let the old clear erase a same-session rebind (pending=%s)',
    async (pendingClear) => {
      const f = await fixture({ pendingClear });
      await resumeSession(f.root, f.sessionId, {
        taskRef: f.taskRef,
        workflowMode: 'man',
        taskRevision: f.planned.metadata.revision,
      });
      expect(
        await inspectOperationProjectionState(
          f.root,
          f.planned.operation.operationId,
        ),
      ).toMatchObject({ sessionPointer: 'not_applicable' });
      expect(
        (
          await reconcileProjectionIntents(
            f.root,
            f.planned.operation.operationId,
          )
        ).state,
      ).toBe('converged');
      expect(await readSession(f.root, f.sessionId)).toMatchObject({
        activeTaskRef: f.taskRef,
        lastSeenRevision: f.planned.metadata.revision,
      });
      const continued = await reviseV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: f.planned.metadata.revision,
        plan: f.planContent,
        planDecision: 'governed_execution',
      });
      await reconcileProjectionIntents(f.root, f.planned.operation.operationId);
      expect(await readSession(f.root, f.sessionId)).toMatchObject({
        activeTaskRef: f.taskRef,
        lastSeenRevision: continued.metadata.revision,
      });
      expect(await listProjectionIntents(f.root)).toEqual([]);
    },
  );

  it.each([
    'owner',
    'session',
    'closed session',
    'client',
    'revision',
    'scope',
    'baseline',
    'missing scope',
  ] as const)(
    'rejects a resumption with invalid %s without changing authority',
    async (invalid) => {
      const f = await fixture({ missingScope: invalid === 'missing scope' });
      const before = await f.snapshot();
      let sessionId = f.sessionId;
      if (invalid === 'owner') {
        sessionId = (
          await createSession(f.root, {
            actorId: createUlid(),
            client: 'vitest',
            identitySource: 'explicit',
          })
        ).sessionId;
        expect(await readSession(f.root, sessionId)).toMatchObject({
          status: 'active',
          client: 'vitest',
        });
      }
      if (invalid === 'session') sessionId = createUlid();
      if (invalid === 'closed session') await closeSession(f.root, f.sessionId);
      if (invalid === 'baseline') {
        await writeFile(
          path.join(f.root, 'docs/plan.md'),
          plan.replace('Implement app.cjs', 'Expand to a new API'),
        );
      }
      if (invalid === 'client') {
        const result = await capture(() =>
          workflow(f.root, 'plan', [f.ref, 'confirm'], {
            session: f.sessionId,
            client: 'another-client',
            json: true,
            expectedRevision: String(before.metadata.revision),
            planDecision: 'governed_execution',
          }),
        );
        expect(result.code).not.toBe(0);
        expect(result.output).toContain('MANCODE_SESSION_NOT_FOUND');
      } else {
        const error = {
          owner: 'MANCODE_TASK_OWNER_REQUIRED',
          session: 'MANCODE_SESSION_NOT_FOUND',
          'closed session': 'MANCODE_SESSION_NOT_FOUND',
          revision: 'MANCODE_EXPECTED_REVISION_CONFLICT',
          scope: 'MANCODE_PLAN_RESUME_AUTHORITY_CHANGED',
          baseline: 'MANCODE_MAN_PLAN_BASELINE_CHANGED',
          'missing scope': 'MANCODE_IMPLEMENTATION_SCOPE_REQUIRED',
        }[invalid];
        await expect(
          reviseV3Plan({
            projectRoot: f.root,
            taskRef: f.taskRef,
            sessionId,
            expectedTaskRevision:
              before.metadata.revision - (invalid === 'revision' ? 1 : 0),
            plan: f.planContent,
            planDecision: 'governed_execution',
            ...(invalid === 'scope'
              ? {
                  implementationScope: {
                    include: ['app.cjs', 'docs/plan.md', 'new-api.cjs'],
                    exclude: [],
                    modules: [],
                  },
                }
              : {}),
          }),
        ).rejects.toThrow(error);
      }
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it.each(['man', 'manteam'] as const)(
    'does not expand resumption to shared %s work',
    async (sharedMode) => {
      const f = await fixture({ sharedMode });
      const before = await f.snapshot();
      expect(before.metadata).toMatchObject({
        taskRef: { namespace: 'shared' },
        coordination: sharedMode === 'man' ? 'single' : 'team',
      });
      await expect(
        reviseV3Plan({
          projectRoot: f.root,
          taskRef: f.taskRef,
          sessionId: f.sessionId,
          expectedTaskRevision: before.metadata.revision,
          plan: f.planContent,
          planDecision: 'governed_execution',
        }),
      ).rejects.toThrow('MANCODE_PLAN_RESUME_LOCAL_MAN_ONLY');
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it.each([
    'requirements status',
    'requirements digest',
    'step',
    'plan version',
  ] as const)('fails closed on damaged %s authority', async (invalid) => {
    const f = await fixture();
    const metadata = structuredClone(f.planned.metadata);
    if (invalid === 'requirements status')
      metadata.governance.requirementsStatus = 'needs_clarification';
    if (invalid === 'requirements digest')
      metadata.governance.requirementsDigest = `sha256:${'0'.repeat(64)}`;
    if (invalid === 'step') metadata.currentStep = 3;
    if (invalid === 'plan version') metadata.governance.planVersion = 0;
    const metadataPath = path.join(
      f.root,
      '.mancode/local/workflows',
      f.taskRef.taskId,
      'metadata.json',
    );
    const damaged = `${JSON.stringify(metadata, null, 2)}\n`;
    await writeFile(metadataPath, damaged);
    const expectedError = invalid.startsWith('requirements')
      ? 'MANCODE_OPERATION_REPAIR_REQUIRED'
      : invalid === 'plan version'
        ? /planVersion.*positive integer/
        : 'MANCODE_PLAN_RESUME_NOT_ELIGIBLE';
    await expect(
      reviseV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: metadata.revision,
        plan: f.planContent,
        planDecision: 'governed_execution',
      }),
    ).rejects.toThrow(expectedError);
    expect(await readFile(metadataPath, 'utf8')).toBe(damaged);
    expect(await listProjectionIntents(f.root)).toEqual([]);
  });

  it('rejects an unapproved plan replacement through revise and keeps the approved version', async () => {
    const f = await fixture({ delivery: false });
    const before = await f.snapshot();
    await expect(
      reviseV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: before.metadata.revision,
        plan: `${f.planContent}\nUnapproved new behavior.\n`,
        planDecision: 'governed_execution',
      }),
    ).rejects.toThrow('MANCODE_PLAN_RESUME_AUTHORITY_CHANGED');
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['blocked', 'abandoned'] as const)(
    'does not silently reactivate a %s task',
    async (status) => {
      const f = await fixture();
      const predecessor =
        status === 'blocked'
          ? await updateV3Workflow({
              projectRoot: f.root,
              taskRef: f.taskRef,
              sessionId: f.sessionId,
              expectedTaskRevision: f.planned.metadata.revision,
              status: 'in_progress',
            })
          : f.planned;
      const changed = await updateV3Workflow({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: predecessor.metadata.revision,
        status,
        ...(status === 'blocked'
          ? { blockingReason: 'External decision still outstanding.' }
          : {}),
      });
      const input = {
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: changed.metadata.revision,
        plan: f.planContent,
        planDecision: 'governed_execution' as const,
      };
      await expect(reviseV3Plan(input)).rejects.toThrow(
        'MANCODE_PLAN_RESUME_NOT_ELIGIBLE',
      );
      expect((await f.snapshot()).metadata).toEqual(changed.metadata);
      if (status === 'blocked') {
        const unblocked = await updateV3Workflow({
          projectRoot: f.root,
          taskRef: f.taskRef,
          sessionId: f.sessionId,
          expectedTaskRevision: changed.metadata.revision,
          status: 'in_progress',
        });
        await expect(
          reviseV3Plan({
            ...input,
            expectedTaskRevision: unblocked.metadata.revision,
          }),
        ).resolves.toMatchObject({
          metadata: { currentStep: 5, blockingReason: null },
        });
      }
    },
  );

  it('does not reconfirm an already executing plan', async () => {
    const f = await fixture();
    const input = {
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: f.planned.metadata.revision,
      plan: f.planContent,
      planDecision: 'governed_execution' as const,
    };
    const started = await reviseV3Plan(input);
    const before = await f.snapshot();
    await expect(
      reviseV3Plan({
        ...input,
        expectedTaskRevision: started.metadata.revision,
      }),
    ).rejects.toThrow('MANCODE_EXECUTION_SCOPE_ALREADY_BOUND');
    expect(await f.snapshot()).toEqual(before);
  });

  it('rechecks obsolete clear authority after inspect and before apply', async () => {
    const f = await fixture({ pendingClear: true });
    const originalRead = V3ContextStore.prototype.readTaskSnapshot;
    let reads = 0;
    let resumedRevision: number | undefined;
    vi.spyOn(V3ContextStore.prototype, 'readTaskSnapshot').mockImplementation(
      async function (taskRef) {
        const snapshot = await originalRead.call(this, taskRef);
        if (taskRef.taskId === f.taskRef.taskId && ++reads === 2) {
          const continued = await reviseV3Plan({
            projectRoot: f.root,
            taskRef: f.taskRef,
            sessionId: f.sessionId,
            expectedTaskRevision: f.planned.metadata.revision,
            plan: f.planContent,
            planDecision: 'governed_execution',
          });
          resumedRevision = continued.metadata.revision;
        }
        return snapshot;
      },
    );
    expect(
      (
        await reconcileProjectionIntents(
          f.root,
          f.planned.operation.operationId,
        )
      ).state,
    ).toBe('converged');
    expect(resumedRevision).toBe(f.planned.metadata.revision + 1);
    expect(await readSession(f.root, f.sessionId)).toMatchObject({
      activeTaskRef: f.taskRef,
      lastSeenRevision: resumedRevision,
    });
  });

  it.each(['clear', 'resume'] as const)(
    'rechecks a same-session rebind inside the clear mutation lock for an old %s intent',
    async (action) => {
      const f = await fixture({
        pendingClear: action === 'clear',
        pendingCreate: action === 'resume',
      });
      if (action === 'resume') {
        await resumeSession(f.root, f.sessionId, {
          taskRef: f.taskRef,
          workflowMode: 'man',
          taskRevision: f.created.metadata.revision,
        });
      }
      const operationId = (action === 'clear' ? f.planned : f.created).operation
        .operationId;
      const originalClear = sessionModule.clearSessionTaskPointer;
      vi.spyOn(sessionModule, 'clearSessionTaskPointer').mockImplementationOnce(
        async (...args) => {
          await resumeSession(f.root, f.sessionId, {
            taskRef: f.taskRef,
            workflowMode: 'man',
            taskRevision: f.planned.metadata.revision,
          });
          return originalClear(...args);
        },
      );
      expect(
        (await reconcileProjectionIntents(f.root, operationId)).state,
      ).toBe('converged');
      expect(await readSession(f.root, f.sessionId)).toMatchObject({
        activeTaskRef: f.taskRef,
        lastSeenRevision: f.planned.metadata.revision,
      });
    },
  );

  it('does not let a pending workflow-create resume clear a later explicit plan-only rebind', async () => {
    const f = await fixture({ pendingCreate: true });
    const restored = await capture(() =>
      contextResume(f.root, f.ref, {
        session: f.sessionId,
        client: 'vitest',
        json: true,
      }),
    );
    expect(restored.code, restored.output).toBe(0);
    expect(
      await inspectOperationProjectionState(
        f.root,
        f.created.operation.operationId,
      ),
    ).toMatchObject({ sessionPointer: 'not_applicable' });
    expect(
      (
        await capture(() =>
          contextDoctor(f.root, {
            repair: f.created.operation.operationId,
            session: f.sessionId,
            client: 'vitest',
            json: true,
          }),
        )
      ).code,
    ).toBe(0);
    expect(await readSession(f.root, f.sessionId)).toMatchObject({
      activeTaskRef: f.taskRef,
      lastSeenRevision: f.planned.metadata.revision,
    });
    expect((await f.snapshot()).metadata).toEqual(f.planned.metadata);
    expect(await listProjectionIntents(f.root)).toEqual([]);
  });

  it('still clears an older binding when replaying a pre-plan workflow-create resume', async () => {
    const f = await fixture({ pendingCreate: true });
    await resumeSession(f.root, f.sessionId, {
      taskRef: f.taskRef,
      workflowMode: 'man',
      taskRevision: f.created.metadata.revision,
    });
    expect(
      await inspectOperationProjectionState(
        f.root,
        f.created.operation.operationId,
      ),
    ).toMatchObject({ sessionPointer: 'missing' });
    expect(
      (
        await reconcileProjectionIntents(
          f.root,
          f.created.operation.operationId,
        )
      ).state,
    ).toBe('converged');
    expect(await readSession(f.root, f.sessionId)).toMatchObject({
      activeTaskRef: null,
    });
    expect((await f.snapshot()).metadata).toEqual(f.planned.metadata);
  });

  it.each(['future revision', 'wrong mode', 'unproven clear'] as const)(
    'keeps %s projection evidence fail closed',
    async (invalid) => {
      const f = await fixture();
      const started = await reviseV3Plan({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: f.planned.metadata.revision,
        plan: f.planContent,
        planDecision: 'governed_execution',
      });
      const operationId = createUlid();
      await enqueueSessionPointerProjection(f.root, {
        operationId,
        action: 'clear',
        sessionId: f.sessionId,
        expectedPreviousTaskRef: f.taskRef,
        taskRef: f.taskRef,
        workflowMode: invalid === 'wrong mode' ? 'manba' : 'man',
        taskRevision:
          started.metadata.revision + (invalid === 'future revision' ? 1 : 0),
      });
      expect(
        await inspectOperationProjectionState(f.root, operationId),
      ).toMatchObject({ sessionPointer: 'conflict' });
      expect(
        (await reconcileProjectionIntents(f.root, operationId)).state,
      ).toBe('repair_required');
      expect(await readSession(f.root, f.sessionId)).toMatchObject({
        activeTaskRef: f.taskRef,
        lastSeenRevision: started.metadata.revision,
      });
    },
  );

  it.each(OPERATION_CRASH_FIXTURES.plan_revision)(
    'recovers the resumed decision and its pointer at $crashAfter',
    async (crash) => {
      const f = await fixture({ pendingClear: true });
      const before = await f.snapshot();
      const operationId = createUlid();
      await expect(
        withOperationCrashInjectionForTesting(crash, () =>
          reviseV3Plan({
            projectRoot: f.root,
            taskRef: f.taskRef,
            sessionId: f.sessionId,
            expectedTaskRevision: before.metadata.revision,
            plan: f.planContent,
            planDecision: 'governed_execution',
            operationId,
          }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
      const options = { session: f.sessionId, client: 'vitest', json: true };
      const recovered = await capture(() =>
        contextDoctor(f.root, { ...options, repair: operationId }),
      );
      expect(recovered.code, recovered.output).toBe(0);
      expect(
        (
          await capture(() =>
            contextDoctor(f.root, {
              ...options,
              repair: f.planned.operation.operationId,
            }),
          )
        ).code,
      ).toBe(0);
      const after = await f.snapshot();
      expect(after.plan).toEqual(before.plan);
      expect(after.requirements).toEqual(before.requirements);
      expect(after.review).toEqual(before.review);
      expect(after.verification).toEqual(before.verification);
      expect(after.metadata.implementationScope).toEqual(
        before.metadata.implementationScope,
      );
      expect(after.metadata.governance.planVersion).toBe(
        before.metadata.governance.planVersion,
      );
      // An unchanged plan has no write-plan effect; metadata is the first authority write.
      if (['prepared', 'validate', 'write-plan'].includes(crash.crashAfter)) {
        expect(after.metadata).toEqual(before.metadata);
        expect(await readSession(f.root, f.sessionId)).toMatchObject({
          activeTaskRef: null,
        });
      } else {
        expect(after.metadata).toMatchObject({
          status: 'in_progress',
          currentStep: 5,
          governance: { planDecision: 'governed_execution' },
        });
        expect(await readSession(f.root, f.sessionId)).toMatchObject({
          activeTaskRef: f.taskRef,
          lastSeenRevision: after.metadata.revision,
        });
      }
      expect(after.aggregateError).toBeNull();
      expect(await listProjectionIntents(f.root)).toEqual([]);
    },
  );
});

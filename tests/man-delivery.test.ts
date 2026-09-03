import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRequirementsInput } from '../src/commands/requirements-input.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { workflow } from '../src/commands/workflow.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import {
  captureManSubject,
  renderManDeliveryRecord,
  syncManDeliveryRecord,
} from '../src/context/man-delivery-runtime.js';
import { reviseV3Plan } from '../src/context/plan-revision.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import { REQUIREMENT_DIMENSIONS } from '../src/context/requirements-ledger.js';
import { reviewLedgerDigest } from '../src/context/review-ledger.js';
import { applyV3ReviewLedger } from '../src/context/review-remediation.js';
import { V3ContextStore } from '../src/context/store.js';
import type { TaskRef } from '../src/context/task-ref.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { createSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';

const execFile = promisify(execFileCallback);
const plan =
  '<!-- mancode:plan-baseline:start -->\n# Export\nAC-1, AC-2: callable export returns 2. AC-3: operator accepts behavior.\n<!-- mancode:progress-task export -->\n<!-- mancode:plan-baseline:end -->\n<!-- mancode:delivery-record:start -->\nNot started.\n<!-- mancode:delivery-record:end -->\n';
describe('opted-in man module delivery through the public workflow command', () => {
  let root: string;
  let sessionId: Ulid;
  let taskRef: TaskRef;
  let store: V3ContextStore;
  const logs = () => vi.spyOn(console, 'log').mockImplementation(() => {});
  const snapshot = () => store.readTaskSnapshot(taskRef);
  const git = (args: string[]) => execFile('git', args, { cwd: root });
  async function command(action: string, input?: unknown, acceptance?: string) {
    if (input)
      await writeFile(
        path.join(root, '.mancode/local/drafts/input.json'),
        JSON.stringify(input),
      );
    const output = logs();
    try {
      const code = await workflow(
        root,
        'delivery',
        [`${taskRef.namespace}:${taskRef.taskId}`, action],
        {
          json: true,
          session: sessionId,
          client: 'vitest',
          expectedRevision: String((await snapshot()).metadata.revision),
          ...(input ? { file: '.mancode/local/drafts/input.json' } : {}),
          acceptance,
        },
      );
      return {
        code,
        output: output.mock.calls.map((call) => String(call[0])).join('\n'),
      };
    } finally {
      output.mockRestore();
    }
  }
  const verify = (id = 'AC-1') =>
    command(
      'verify',
      {
        surface: 'component',
        argv: [
          process.execPath,
          '-e',
          "require('node:assert').equal(require('./app.cjs').run(),2)",
        ],
      },
      id,
    );
  async function review(extra: Record<string, unknown> = {}) {
    return command('review', {
      subject: await captureManSubject(root, await snapshot()),
      reviewer: 'self',
      direction:
        'AC-1/2 reach app.cjs run; diff only implements the approved export.',
      correctness:
        'The real entry returns 2; automated checks and operator observation cover the required boundary.',
      proportionality:
        'No speculative guards or abstractions; existing output contract reused.',
      nextAction:
        'Stop after this authorized module; no subsequent module authorized.',
      coverage: ['AC-1', 'AC-2', 'AC-3'].map((acceptanceId) => ({
        acceptanceId,
        status: 'met',
        evidence:
          'app.cjs run plus captured check/explicit operator observation',
      })),
      findings: [],
      resolved: [],
      ...extra,
    });
  }
  async function finishEvidence() {
    const first = await verify('AC-1,AC-2');
    expect(first.code, first.output).toBe(0);
    expect(
      (
        await command(
          'confirm',
          {
            confirmed: true,
            surface: 'manual_observation',
            summary:
              'Fixture operator explicitly confirms the required behavior in the local Node environment.',
          },
          'AC-3',
        )
      ).code,
    ).toBe(0);
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-module-'));
    await git(['init', '-q']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.test']);
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, '.gitignore'), '.mancode/\n');
    await writeFile(path.join(root, 'app.cjs'), 'exports.run=()=>2;');
    await writeFile(path.join(root, 'docs/export.md'), plan);
    await writeFile(
      path.join(root, '项目进度.html'),
      '<h1>keep</h1><script type="application/json" id="mancode-progress-data">{"schemaVersion":1,"tasks":[{"taskId":"export","status":"未完成","reason":null}]}</script><footer>keep</footer>',
    );
    await git(['add', '.']);
    await git(['commit', '-qm', 'fixture baseline']);
    await initializeV3Project({ projectRoot: root });
    const actorId = createUlid();
    await createLocalActor(root, { actorId, displayName: 'Fixture' });
    const session = await createSession(root, {
      actorId,
      client: 'vitest',
      identitySource: 'explicit',
    });
    sessionId = session.sessionId;
    const created = await createV3Workflow({
      projectRoot: root,
      task: 'Export module',
      workflowMode: 'man',
      delivery: true,
      sessionId,
      client: 'vitest',
    });
    taskRef = created.taskRef;
    store = new V3ContextStore(root);
    const requirements = normalizeRequirementsInput(
      {
        version: 1,
        goal: 'Export module',
        confirmedScope: ['Callable export returns 2'],
        excludedScope: ['UI'],
        technicalDecisions: [],
        defaults: [],
        blockingUnknowns: [],
        coverage: REQUIREMENT_DIMENSIONS.map((dimension) => ({
          dimension,
          status:
            dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
          rationale: 'Bounded local fixture.',
        })),
        acceptanceCriteria: ['AC-1', 'AC-2', 'AC-3'].map((id) => ({
          id,
          description:
            id === 'AC-3'
              ? 'Operator accepts result'
              : 'Callable export returns 2',
          required: true,
          method: id === 'AC-3' ? 'manual' : 'automated',
        })),
      },
      taskRef,
    );
    const ready = await finalizeV3Requirements({
      projectRoot: root,
      taskRef,
      sessionId,
      expectedTaskRevision: created.metadata.revision,
      requirements,
    });
    await reviseV3Plan({
      projectRoot: root,
      taskRef,
      sessionId,
      expectedTaskRevision: ready.metadata.revision,
      plan,
      planSource: 'docs/export.md',
      implementationScope: {
        include: ['app.cjs', 'docs/export.md', '项目进度.html'],
        exclude: [],
        modules: [],
      },
      planDecision: 'governed_execution',
    });
    await mkdir(path.join(root, '.mancode/local/drafts'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('requires a module review, accepts zero findings, preserves tests, commits then completes without an upstream', async () => {
    const initial = await snapshot();
    expect(initial.metadata.governance.policyVersions.planning).toBe(3);
    expect((await command('sync')).code).toBe(0);
    expect(await readFile(path.join(root, '项目进度.html'), 'utf8')).toContain(
      '进行中',
    );
    const initialCheck = await command('check');
    expect(initialCheck.code).not.toBe(0);
    expect(initialCheck.output).toContain('VERIFICATION_INCOMPLETE');
    await finishEvidence();
    const awaitingReview = await command('inspect');
    expect(JSON.parse(awaitingReview.output).finalization).toMatchObject({
      status: 'incomplete',
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'review_incomplete',
          status: 'stale',
        }),
      ]),
    });
    expect((await command('check')).output).toContain('REVIEW_INCOMPLETE');
    expect(await readFile(path.join(root, '项目进度.html'), 'utf8')).toContain(
      '待审核',
    );
    expect(await readFile(path.join(root, 'docs/export.md'), 'utf8')).toContain(
      'surface=component',
    );
    expect(await readFile(path.join(root, 'docs/export.md'), 'utf8')).toContain(
      'surface=manual_observation',
    );
    const evidence = (await snapshot()).verification.checks;
    expect((await review()).code).toBe(0);
    const reviewed = await snapshot();
    const differentEnvironment = {
      ...(await captureManSubject(root, reviewed)),
      environment: 'another host environment',
    };
    expect(renderManDeliveryRecord(reviewed, differentEnvironment)).toContain(
      'Review: stale',
    );
    expect(renderManDeliveryRecord(reviewed, differentEnvironment)).toContain(
      'Verification: stale',
    );
    expect(reviewed.verification.status).toBe('passed');
    expect(reviewed.verification.checks).toEqual(evidence);
    expect(reviewed.metadata.governance.planVersion).toBe(
      initial.metadata.governance.planVersion,
    );
    expect(await readFile(path.join(root, '项目进度.html'), 'utf8')).toContain(
      '已完成',
    );
    const uncommitted = await command('inspect');
    expect(JSON.parse(uncommitted.output).finalization).toMatchObject({
      status: 'incomplete',
      blockers: [expect.objectContaining({ code: 'uncommitted_changes' })],
    });
    expect((await command('check')).output).toContain('UNCOMMITTED');
    await git(['add', 'docs/export.md', '项目进度.html']);
    await git(['commit', '-qm', 'module delivery']);
    expect((await command('check')).code).toBe(0);
    const ready = JSON.parse((await command('inspect')).output);
    expect(ready.publication).toBe('unpublished');
    expect(ready.finalization).toEqual({ status: 'ready', blockers: [] });
    const output = logs();
    expect(
      await workflow(
        root,
        'complete',
        [`${taskRef.namespace}:${taskRef.taskId}`],
        {
          json: true,
          session: sessionId,
          client: 'vitest',
          expectedRevision: String((await snapshot()).metadata.revision),
        },
      ),
    ).toBe(0);
    output.mockRestore();
    expect((await snapshot()).metadata.status).toBe('completed');
  });

  it('records command failures and rejects stale evidence after same-HEAD changes, then resets other stale slots', async () => {
    await finishEvidence();
    expect((await review()).code).toBe(0);
    await writeFile(path.join(root, 'app.cjs'), 'exports.run=()=>3;');
    expect((await command('check')).output).toContain(
      'VERIFICATION_INCOMPLETE',
    );
    const failed = await verify();
    expect(failed.code).toBe(0); // The recording operation succeeded, the check did not.
    expect(failed.output).toContain('exitCode');
    expect((await snapshot()).verification.status).toBe('failed');
    expect((await snapshot()).verification.checks[1]?.automated?.status).toBe(
      'pending',
    );
    await writeFile(
      path.join(root, 'app.cjs'),
      'exports.run=()=>2; // repaired\n',
    );
    await finishEvidence();
    expect((await review()).code).toBe(0);
    expect((await snapshot()).verification.status).toBe('passed');
  });

  it('does not accept missing goal coverage or unknown acceptance IDs and keeps repairs out of business blocked state', async () => {
    await finishEvidence();
    expect(
      (
        await review({
          coverage: [
            {
              acceptanceId: 'AC-1',
              status: 'missing',
              evidence:
                'Required entry is absent; helper-only code is not delivery.',
            },
          ],
        })
      ).code,
    ).toBe(0);
    expect((await snapshot()).review.status).toBe('blocked');
    expect((await snapshot()).metadata.status).not.toBe('blocked');
    expect(await readFile(path.join(root, '项目进度.html'), 'utf8')).toContain(
      '进行中',
    );
    expect((await command('check')).code).not.toBe(0);
    expect(
      (
        await review({
          coverage: [
            {
              acceptanceId: 'AC-999',
              status: 'missing',
              evidence: 'Unknown target',
            },
          ],
        })
      ).output,
    ).toContain('UNKNOWN_ACCEPTANCE');
    expect((await review()).code).toBe(0);
  });

  it('records required repairs, preserves tested repairs across resolution and reports committed scope expansion', async () => {
    await finishEvidence();
    expect(
      (
        await review({
          findings: [
            {
              id: 'R-1',
              domain: 'quality',
              severity: 'p1',
              summary: 'Required entry needs the documented result.',
            },
          ],
        })
      ).code,
    ).toBe(0);
    const blocked = await snapshot();
    const erased = { ...blocked.review, blockers: [] };
    await expect(
      applyV3ReviewLedger({
        projectRoot: root,
        taskRef,
        sessionId,
        expectedTaskRevision: blocked.metadata.revision,
        review: { ...erased, contentDigest: reviewLedgerDigest(erased) },
      }),
    ).rejects.toThrow('FINDING_DROPPED');
    await writeFile(
      path.join(root, 'app.cjs'),
      'exports.run=()=>2; // verified repair\n',
    );
    await finishEvidence();
    expect((await review({ resolved: ['R-1'] })).code).toBe(0);
    expect((await snapshot()).verification.status).toBe('passed');
    await writeFile(
      path.join(root, 'unrelated.cjs'),
      'exports.unrelated=true;',
    );
    // Unrelated code added before a new check is not silently attributed to the module.
    await finishEvidence();
    expect((await review()).code).toBe(0);
    await git(['add', '.']);
    await git(['commit', '-qm', 'mixed scope']);
    expect((await command('check')).output).toContain('OUTSIDE_SCOPE');
  });

  it('never records successful evidence when the command changes the tested code', async () => {
    const before = (await snapshot()).metadata.revision;
    const result = await command(
      'verify',
      {
        surface: 'component',
        argv: [
          process.execPath,
          '-e',
          "require('node:fs').writeFileSync('app.cjs','exports.run=()=>3;')",
        ],
      },
      'AC-1',
    );
    expect(result.output).toContain('CHANGED_DURING_RUN');
    expect((await snapshot()).metadata.revision).toBe(before);
  });

  it('runs one relevant command once for multiple explicitly covered acceptance criteria', async () => {
    const result = await command(
      'verify',
      {
        surface: 'component',
        argv: [
          process.execPath,
          '-e',
          "require('node:assert').equal(require('./app.cjs').run(),2);require('node:fs').appendFileSync('.mancode/local/drafts/runs','run\\n')",
        ],
      },
      'AC-1,AC-2',
    );
    expect(result.code, result.output).toBe(0);
    expect(
      await readFile(path.join(root, '.mancode/local/drafts/runs'), 'utf8'),
    ).toBe('run\n');
    const task = await snapshot();
    expect(
      task.verification.checks
        .slice(0, 2)
        .map((check) => check.automated?.status),
    ).toEqual(['passed', 'passed']);
    expect(task.verification.checks[2]?.manual?.status).toBe('pending');
  });

  it('requires an explicit verification surface and returns the next finalization state with the mutation receipt', async () => {
    const before = (await snapshot()).metadata.revision;
    const missing = await command(
      'verify',
      {
        argv: [process.execPath, '-e', 'process.exit(0)'],
      },
      'AC-1',
    );
    expect(missing.output).toContain('VERIFICATION_SURFACE_INVALID');
    expect((await snapshot()).metadata.revision).toBe(before);

    const verified = await verify();
    expect(verified.code, verified.output).toBe(0);
    expect(JSON.parse(verified.output)).toMatchObject({
      revision: before + 1,
      finalization: {
        status: 'incomplete',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'verification_incomplete' }),
          expect.objectContaining({ code: 'review_incomplete' }),
        ]),
      },
    });
    expect((await snapshot()).verification.checks[0]?.automated?.surface).toBe(
      'component',
    );
  });

  it('reports the exact plan path needed by implementation scope', async () => {
    const current = await snapshot();
    await expect(
      syncManDeliveryRecord(root, {
        ...current,
        metadata: {
          ...current.metadata,
          implementationScope: {
            ...current.metadata.implementationScope,
            include: ['app.cjs'],
          },
        },
      }),
    ).rejects.toThrow(
      'MANCODE_MAN_PLAN_OUTSIDE_SCOPE: docs/export.md is not covered by implementationScope.include; add that exact repo-relative path or a covering glob',
    );
  });

  it('rejects the delivery opt-in for other workflow modes before any mutation', async () => {
    const before = (await snapshot()).metadata.revision;
    for (const workflowMode of ['manba', 'manteam'] as const) {
      await expect(
        createV3Workflow({
          projectRoot: root,
          task: 'Not a man delivery',
          workflowMode,
          delivery: true,
          sessionId,
          client: 'vitest',
        }),
      ).rejects.toThrow('MANCODE_MAN_DELIVERY_MODE_REQUIRED');
    }
    expect((await snapshot()).metadata.revision).toBe(before);
  });
});

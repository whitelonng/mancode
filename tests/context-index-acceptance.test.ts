import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextIndexQuery, contextShow } from '../src/commands/context.js';
import { normalizeRequirementsInput } from '../src/commands/requirements-input.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import {
  confirmedDecisionDigest,
  createStructuredDecision,
  publishConfirmedDecision,
} from '../src/context/confirmed-decision.js';
import {
  type ContextIndexResponse,
  loadContextIndexSnapshot,
} from '../src/context/context-index.js';
import { contextPackTokenCounter } from '../src/context/context-pack.js';
import { createUlid } from '../src/context/ids.js';
import { reviseV3Plan } from '../src/context/plan-revision.js';
import { finalizeV3Requirements } from '../src/context/requirements-finalize.js';
import { REQUIREMENT_DIMENSIONS } from '../src/context/requirements-ledger.js';
import { V3ContextStore } from '../src/context/store.js';
import { taskRootPath } from '../src/context/task-locator.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { updateV3Workflow } from '../src/context/workflow-update.js';
import { createSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';
import { createAuthorizationBasis } from '../src/team/authorization.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// A concrete persistence task, based on the existing public workflow fixture.
// The plan has no repeated padding; all of it belongs to the acceptance set.
const plan = `# Approved durable retry implementation
Goal: persist the last successful checkpoint before acknowledging an operation.

## Scope
Change app.cjs and its tests only. Do not introduce background model calls.
Preserve the existing synchronous command interface and the existing JSON keys.
Do not change shared schema or require a new actor for ordinary local work.

## Implementation
1. Validate the operation identifier before opening a state file.
2. Read the current revision and reject a caller holding an older revision.
3. Acquire the existing per-task lock before changing the authoritative record.
4. Write the complete replacement to a temporary file in the same directory.
5. Flush the file, then rename it over the old checkpoint while holding the lock.
6. Publish the completion notification after the authoritative commit succeeds.
7. If notification fails, retain a repair marker and preserve the committed state.
8. Repeated repair must be idempotent and must never replay a completed mutation.
9. Never interpret a missing cached projection as permission to create authority.
10. Release the lock in a finally block, including validation and write failures.

## Conditions and exceptions
Only retry operations that explicitly declare idempotency. An unknown declaration
must stop with a recoverable error. Do not automatically retry a non-idempotent
operation, even when its previous response was lost. Preserve the original
operation identifier across an allowed retry so it cannot commit twice.
Keep user-provided HTML intact if its ownership marker does not match this tool.
A local preview is optional and exits when its foreground process terminates.
The offline snapshot must retain the last committed state after preview exits.

## Acceptance
AC-1: a restart after commit returns the same operation result without a second write.
AC-2: a stale caller receives a revision conflict and leaves all authority unchanged.
AC-3: an interrupted notification becomes repairable without running a model.
Verify the normal path, crash before commit, crash after commit, concurrent stale
caller, notification failure, and non-idempotent exception. Inspect the task-owned
diff and report any untested failure boundary before requesting completion.
`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-index-acceptance-'));
  roots.push(root);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.test'],
  ])
    execFileSync('git', args, { cwd: root });
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, '.gitignore'), '.mancode/\n');
  await writeFile(path.join(root, 'app.cjs'), 'exports.run=()=>1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  await initializeV3Project({ projectRoot: root });
  const actorId = createUlid();
  await createLocalActor(root, { actorId, displayName: 'Fixture' });
  const { sessionId } = await createSession(root, {
    actorId,
    client: 'vitest',
    identitySource: 'explicit',
  });
  const created = await createV3Workflow({
    projectRoot: root,
    task: 'Persist durable retry checkpoints',
    workflowMode: 'man',
    delivery: false,
    sessionId,
    client: 'vitest',
  });
  const taskRef = created.taskRef;
  const ready = await finalizeV3Requirements({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: created.metadata.revision,
    requirements: normalizeRequirementsInput(
      {
        version: 1,
        goal: 'Persist durable retry checkpoints',
        confirmedScope: ['Commit the checkpoint before acknowledging a retry'],
        excludedScope: ['No background model calls'],
        technicalDecisions: [],
        defaults: [],
        blockingUnknowns: [],
        coverage: REQUIREMENT_DIMENSIONS.map((dimension) => ({
          dimension,
          status:
            dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
          rationale: 'Existing local command and persistence contract.',
        })),
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description:
              'Restart returns the same result without a second commit',
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
    implementationScope: {
      include: ['app.cjs'],
      exclude: [],
      modules: ['runtime'],
    },
  });
  const approved = await reviseV3Plan({
    projectRoot: root,
    taskRef,
    sessionId,
    expectedTaskRevision: revised.metadata.revision,
    plan,
    planDecision: 'governed_execution',
  });
  const authorization = createAuthorizationBasis(
    {
      action: 'confirmed_decision_publish',
      actorId,
      session: { sessionId, actorId, status: 'active' },
      joined: true,
      sharedWriteGuard: 'advisory',
      task: null,
      claim: null,
      handoff: null,
      evidence: null,
      profileActorId: null,
      conditions: {
        confirmedDecisionSharingEnabled: true,
        privacyConfirmed: true,
        explicitConfirmation: true,
      },
    },
    new Date(),
  );
  const publish = async (module: string, title: string, statement: string) => {
    const decision = createStructuredDecision(
      {
        decisionId: createUlid(),
        title,
        statement,
        actorId,
        operationId: createUlid(),
        authorization,
        now: new Date(),
      },
      {
        capability: 'decision-relations:1',
        recordKind: 'decision',
        rationale:
          'Keep each module contract explicit and independently reviewable.',
        alternatives: [
          {
            option: 'Implicit module conventions',
            reasonNotChosen:
              'Recovery must not depend on remembered conventions.',
          },
        ],
        tradeoffs: ['Validation adds a small amount of local I/O.'],
        revisitWhen: ['The module changes its public contract.'],
        applicability: { modules: [module], paths: [] },
        clauses: [{ id: 'rule', statement }],
        relations: [],
      },
    );
    await publishConfirmedDecision(root, decision, {
      confirmFormatUpgrade: true,
      writerCapabilities: ['decision-relations:1'],
    });
    return decision;
  };
  const relevant = await publish(
    'runtime',
    'Durable retry safety',
    'A retry must preserve its operation identifier. Never replay non-idempotent work after an unknown commit result.',
  );
  // Six ordinary unrelated module decisions, not an exponential size benchmark.
  for (const [module, title, statement] of [
    [
      'renderer',
      'Accessible navigation',
      'All navigation controls expose an accessible name and keyboard focus. Hide decorative graphics from assistive technology.',
    ],
    [
      'billing',
      'Invoice arithmetic',
      'Calculate invoice totals in integer minor currency units. Round only at the published tax boundary and preserve the source line amounts.',
    ],
    [
      'search',
      'Search ranking',
      'Rank exact identifiers ahead of fuzzy title matches. A missing index is rebuilt from source records and never treated as an empty project.',
    ],
    [
      'export',
      'Portable exports',
      'Exports retain stable column names and UTF-8 encoding. Escape formula-leading spreadsheet values and report unsupported fields explicitly.',
    ],
    [
      'auth',
      'Session expiry',
      'Expired sessions cannot authorize a write. Renew through the normal session flow while retaining audit references to the previous session.',
    ],
    [
      'transport',
      'Transport backoff',
      'Use bounded exponential backoff for transient transport errors. An explicit rejection remains terminal until the caller changes the request.',
    ],
  ])
    await publish(module, title, statement);
  return {
    root,
    taskRef,
    ref: `${taskRef.namespace}:${taskRef.taskId}`,
    sessionId,
    approved,
    relevant,
    store: new V3ContextStore(root),
  };
}

type Sample = {
  label: string;
  tokens: number;
  milliseconds: number;
  text: string;
};
async function capture(
  label: string,
  command: () => Promise<number>,
): Promise<Sample> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const start = performance.now();
  try {
    const code = await command();
    const milliseconds = performance.now() - start;
    const text = [...log.mock.calls, ...error.mock.calls]
      .map((call) => String(call[0]))
      .join('\n');
    expect([0, 3], text).toContain(code);
    return {
      label,
      tokens: contextPackTokenCounter().count(text),
      milliseconds,
      text,
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('same-authority context retrieval acceptance', () => {
  it('measures complete V2 and index-first retrieval at implementation and review entry', async () => {
    const f = await fixture();
    const results = [];
    for (const purpose of ['implement', 'review'] as const) {
      const baseline = await loadContextIndexSnapshot(
        f.store,
        f.taskRef,
        purpose,
        'acceptance-checkout',
      );
      const required = baseline.records.filter((record) => record.required);
      expect(required.map((r) => r.ref)).toContain(`${f.ref}/plan`);
      const old: Sample[] = [];
      const fresh: Sample[] = [];
      const options = { task: f.ref, purpose, json: true };
      old.push(
        await capture('context show --level task', () =>
          contextShow(f.root, { ...options, level: 'task' }),
        ),
      );
      const taskPack = JSON.parse(old[0].text);
      const missingRelevantDecision = !old[0].text.includes(
        f.relevant.statement,
      );
      if (missingRelevantDecision)
        old.push(
          await capture(
            'context show --purpose plan --level task (required project decisions)',
            () =>
              contextShow(f.root, {
                ...options,
                purpose: 'plan',
                level: 'task',
              }),
          ),
        );
      // V2 exposes an artifact reference, not plan text; count its real file read.
      const start = performance.now();
      const planText = await readFile(
        path.join(taskRootPath(f.root, f.taskRef), 'plan.md'),
        'utf8',
      );
      old.push({
        label: 'read approved plan artifact',
        tokens: contextPackTokenCounter().count(planText),
        milliseconds: performance.now() - start,
        text: planText,
      });
      expect(planText).toBe(plan);
      const requiredRefs = new Map<string, { ref: string; version: string }>();
      let cursor: string | undefined;
      do {
        const sample = await capture('context index', () =>
          contextIndexQuery(f.root, 'index', undefined, { ...options, cursor }),
        );
        fresh.push(sample);
        expect(sample.tokens).toBeLessThanOrEqual(1600);
        const page: ContextIndexResponse = JSON.parse(sample.text);
        expect(
          page.gaps.filter(
            (gap) =>
              ![
                'undeclared_dependencies_not_covered',
                'read_before_action',
                'document_applicability_not_declared',
                'undeclared_document_dependencies_not_covered',
              ].includes(gap),
          ),
        ).toEqual([]);
        for (const entry of page.entries)
          if (entry.required)
            requiredRefs.set(entry.ref, {
              ref: entry.ref,
              version: entry.version,
            });
        cursor = page.next ?? undefined;
        expect(fresh.length).toBeLessThan(50);
      } while (cursor);
      expect([...requiredRefs.keys()].sort()).toEqual(
        required.map((r) => r.ref).sort(),
      );
      const contents = new Map<string, string>();
      const requests = [...requiredRefs.values()];
      for (let offset = 0; offset < requests.length; offset += 8) {
        const file = path.join(f.root, 'requests.json');
        await writeFile(
          file,
          JSON.stringify(requests.slice(offset, offset + 8)),
        );
        do {
          const sample = await capture('context read-batch', () =>
            contextIndexQuery(f.root, 'read-batch', undefined, {
              ...options,
              file,
              cursor,
            }),
          );
          fresh.push(sample);
          expect(sample.tokens).toBeLessThanOrEqual(2400);
          const page: ContextIndexResponse = JSON.parse(sample.text);
          expect(
            page.gaps.filter(
              (gap) =>
                ![
                  'undeclared_dependencies_not_covered',
                  'read_before_action',
                  'document_applicability_not_declared',
                  'undeclared_document_dependencies_not_covered',
                ].includes(gap),
            ),
          ).toEqual([]);
          for (const item of page.items ?? []) {
            expect(item.status).not.toBe('stale');
            expect(item.status).not.toBe('unavailable');
            expect(item.unit?.start).toBe(
              Array.from(contents.get(item.ref) ?? '').length,
            );
            contents.set(
              item.ref,
              (contents.get(item.ref) ?? '') + (item.content ?? ''),
            );
          }
          cursor = page.next ?? undefined;
          expect(fresh.length).toBeLessThan(50);
        } while (cursor);
      }
      // Byte-complete required bodies, including the tail exceptions, not summaries.
      for (const record of required)
        expect(contents.get(record.ref), record.ref).toBe(record.content);
      const oldText = old.map((s) => s.text).join('\n');
      const oldPacks = old
        .slice(0, -1)
        .map((sample) => JSON.parse(sample.text).pack);
      for (const record of required) {
        if (record.kind === 'plan') expect(planText).toBe(record.content);
        else {
          const values = oldPacks.flatMap((pack) => [
            pack.activeTask?.implementationScope,
            pack.governance?.requirements,
            pack.governance?.review,
            ...(pack.project?.confirmedDecisions ?? []),
          ]);
          expect(values, record.ref).toContainEqual(JSON.parse(record.content));
        }
      }
      for (const rule of [
        f.relevant.statement,
        'governed_execution',
        'app.cjs',
        'No background model calls',
        'Restart returns the same result without a second commit',
      ]) {
        expect(oldText).toContain(rule);
        expect(fresh.map((s) => s.text).join('\n')).toContain(rule);
      }
      results.push({
        purpose,
        revision: baseline.task?.revision,
        stage: baseline.task?.stage,
        requiredRefs: [...requiredRefs.keys()],
        requiredBodiesComplete: true,
        oldTaskPackMissingRelevantDecision: missingRelevantDecision,
        oldTaskPackOmissions: taskPack.pack.omissions,
        old: summarize(old),
        // A knowledgeable caller may start with the plan-purpose pack. Show
        // that complete lower-cost path too, instead of inflating savings.
        oldKnownPlanEntry:
          purpose === 'implement' ? summarize(old.slice(1)) : null,
        index: summarize(fresh),
      });
    }
    console.log(`CONTEXT_ACCEPTANCE_MEASUREMENTS ${JSON.stringify(results)}`);
  }, 60_000);

  it('rejects superseded decision versions and a stale mutation revision after reading the approved plan', async () => {
    const f = await fixture();
    const options = { task: f.ref, purpose: 'implement', json: true };
    const initial = JSON.parse(
      (
        await capture('index', () =>
          contextIndexQuery(f.root, 'index', undefined, options),
        )
      ).text,
    ) as ContextIndexResponse;
    const planEntry = initial.entries.find(
      (entry) => entry.ref === `${f.ref}/plan`,
    );
    const decisionEntry = initial.entries.find(
      (entry) => entry.ref === `decision:${f.relevant.decisionId}`,
    );
    expect(planEntry).toBeDefined();
    expect(decisionEntry).toBeDefined();
    const originalDecision = JSON.parse(
      (
        await capture('read current decision', () =>
          contextIndexQuery(f.root, 'read', decisionEntry?.ref, {
            ...options,
            version: decisionEntry?.version,
          }),
        )
      ).text,
    ) as ContextIndexResponse;
    expect(originalDecision.status).toBe('complete');
    expect(originalDecision.content).toContain(f.relevant.statement);
    const approvedPlan = JSON.parse(
      (
        await capture('read approved plan', () =>
          contextIndexQuery(f.root, 'read', planEntry?.ref, {
            ...options,
            version: planEntry?.version,
          }),
        )
      ).text,
    ) as ContextIndexResponse;
    expect(approvedPlan.content).toBe(plan);
    expect(approvedPlan.task?.planDecision).toBe('governed_execution');
    expect(approvedPlan.actionReady).toBe(false);
    await updateV3Workflow({
      projectRoot: f.root,
      taskRef: f.taskRef,
      sessionId: f.sessionId,
      expectedTaskRevision: f.approved.metadata.revision,
      status: 'blocked',
      blockingReason: 'External disk quota exhausted',
    });
    await expect(
      updateV3Workflow({
        projectRoot: f.root,
        taskRef: f.taskRef,
        sessionId: f.sessionId,
        expectedTaskRevision: f.approved.metadata.revision,
        status: 'in_progress',
      }),
    ).rejects.toThrow(/REVISION/i);
    const before = await f.store.readTaskSnapshot(f.taskRef);
    expect(before.metadata.status).toBe('blocked');
    const replacement = createStructuredDecision(
      {
        ...f.relevant,
        actorId: f.relevant.confirmedByActorId,
        decisionId: createUlid(),
        operationId: createUlid(),
        title: 'Durable retry with explicit recovery',
        statement:
          'An unknown commit result requires explicit recovery before a retry.',
        now: new Date(),
      },
      {
        ...f.relevant.details,
        clauses: [
          {
            id: 'rule',
            statement:
              'An unknown commit result requires explicit recovery before a retry.',
          },
        ],
        relations: [
          {
            action: 'supersede',
            targetId: f.relevant.decisionId,
            targetDigest: confirmedDecisionDigest(f.relevant),
            clauses: 'all',
          },
        ],
      },
    );
    await publishConfirmedDecision(f.root, replacement, {
      confirmFormatUpgrade: true,
      writerCapabilities: ['decision-relations:1'],
    });
    const stale = JSON.parse(
      (
        await capture('read old decision', () =>
          contextIndexQuery(
            f.root,
            'read',
            `decision:${f.relevant.decisionId}`,
            {
              ...options,
              version: decisionEntry?.version,
            },
          ),
        )
      ).text,
    ) as ContextIndexResponse;
    expect(stale.status).toBe('stale');
    expect(stale.gaps).toContain('version_changed_read_again');
    expect(stale.content).toBeUndefined();
    expect(stale.actionReady).toBe(false);
    const refreshed = JSON.parse(
      (
        await capture('index after replacement', () =>
          contextIndexQuery(f.root, 'index', undefined, options),
        )
      ).text,
    ) as ContextIndexResponse;
    expect(
      refreshed.entries.some((entry) => entry.ref === decisionEntry?.ref),
    ).toBe(false);
    expect(
      refreshed.entries.find(
        (entry) => entry.ref === `decision:${replacement.decisionId}`,
      )?.required,
    ).toBe(true);
    expect((await f.store.readTaskSnapshot(f.taskRef)).metadata.revision).toBe(
      before.metadata.revision,
    );
  }, 60_000);
});

function summarize(samples: Sample[]) {
  return {
    calls: samples.length,
    outputTokens: samples.reduce((n, s) => n + s.tokens, 0),
    milliseconds:
      Math.round(samples.reduce((n, s) => n + s.milliseconds, 0) * 100) / 100,
    callsDetail: samples.map(({ text: _text, ...sample }) => sample),
  };
}

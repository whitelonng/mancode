import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { contextShow } from '../src/commands/context.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  CONTEXT_PACK_BUDGET_ALGORITHM_VERSION,
  CONTEXT_PACK_TOKENIZER_ID,
  type ContextPackBuildInput,
  type ContextPackSectionInput,
  buildContextPack,
  contextPackDigest,
  contextPackTokenCounter,
  parseContextPack,
} from '../src/context/context-pack.js';
import { createUlid } from '../src/context/ids.js';
import { createInitialPrivacyPolicy } from '../src/context/privacy-policy.js';
import { saveV3RequirementsDraft } from '../src/context/requirements-finalize.js';
import {
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from '../src/context/requirements-ledger.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { createSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';

const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';

describe('Context Pack V2 contract', () => {
  it('projects only local paths in semantic exclusions and preserves their surrounding restrictions', () => {
    const value = {
      functionalScope: {
        inScope: ['Tenant-private ticket service'],
        outOfScope: [
          'Deployment and external dependencies.',
          'Work outside /private/tmp/fixture/project; reading sibling trials or evaluator answers.',
        ],
      },
    };
    const before = structuredClone(value);
    const pack = buildContextPack({
      ...buildInput(10_000),
      sections: [
        ...requiredSections(),
        section('/governance/requirements', value, true),
      ],
    });
    expect(pack.governance.requirements).toEqual({
      functionalScope: {
        inScope: value.functionalScope.inScope,
        outOfScope: [
          'Deployment and external dependencies.',
          'Work outside [REDACTED:absolute_path] reading sibling trials or evaluator answers.',
        ],
      },
    });
    expect(value).toEqual(before);
    expect(pack.provenance).toContainEqual(
      expect.objectContaining({
        targetJsonPointer: '/governance/requirements',
        redactions: [
          '/governance/requirements/functionalScope/outOfScope/1:absolute_path',
        ],
      }),
    );
  });

  it.each([
    'Work outside /private/tmp/fixture; token=fixture-secret',
    'Work outside /private/tmp/fixture; contact fixture@example.test',
    'Work outside /private/tmp/fixture; call 13812345678',
  ])('keeps other sensitive semantic exclusions blocked: %s', (text) => {
    expect(() =>
      buildContextPack({
        ...buildInput(10_000),
        privacy: createInitialPrivacyPolicy({
          workspaceId: TASK_ID,
          operationId: TASK_ID,
          now: '2026-07-17T12:00:00.000Z',
        }),
        sections: [
          ...requiredSections(),
          section(
            '/governance/requirements',
            { functionalScope: { outOfScope: [text] } },
            true,
          ),
        ],
      }),
    ).toThrow('MANCODE_CONTEXT_REQUIRED_PRIVACY_BLOCKED');
  });

  it.each(['inScope', 'implementationScope'])(
    'does not mask %s to permit execution',
    (field) => {
      const value = {
        functionalScope: {
          outOfScope: [
            'Work outside /private/tmp/fixture/project is excluded.',
          ],
          ...(field === 'inScope'
            ? { inScope: ['/private/tmp/fixture/project'] }
            : {}),
        },
      };
      expect(() =>
        buildContextPack({
          ...buildInput(10_000),
          sections: [
            ...requiredSections().map((entry) =>
              field === 'implementationScope' &&
              entry.targetJsonPointer === '/activeTask'
                ? {
                    ...entry,
                    value: {
                      taskRef: `local:${TASK_ID}`,
                      implementationScope: {
                        include: ['/private/tmp/fixture/project/**'],
                      },
                    },
                  }
                : entry,
            ),
            section('/governance/requirements', value, true),
          ],
        }),
      ).toThrow('MANCODE_CONTEXT_REQUIRED_PRIVACY_BLOCKED');
    },
  );

  it.each(['requirements', 'verification'] as const)(
    'projects local paths from %s without dropping required governance or changing its source',
    (kind) => {
      // Mirrors the two real-host failures: a pinned CLI in a technical
      // decision and external-oracle paths inside a serialized argv command.
      const command = JSON.stringify([
        'node',
        '-e',
        "require('node:child_process').spawnSync('node',['/private/tmp/fixture/oracle.cjs','/private/tmp/fixture/project'])",
      ]);
      const original =
        kind === 'requirements'
          ? {
              taskRef: `local:${TASK_ID}`,
              revision: 6,
              technicalDecisions: [
                {
                  statement:
                    'Use only node /Users/fixture/code/mancode/dist/cli.js throughout; keep the approved CLI version.',
                },
              ],
            }
          : {
              taskRef: `local:${TASK_ID}`,
              revision: 7,
              status: 'passed',
              checks: [
                {
                  criterionId: 'AC-1',
                  automated: { status: 'passed', command, exitCode: 0 },
                },
              ],
            };
      const value = {
        ...original,
        contentDigest: digestCanonicalJson(original),
      };
      const before = structuredClone(value);
      const target = `/governance/${kind}` as const;
      const input = section(target, value, true);
      input.provenance = input.provenance.map((entry) => ({
        ...entry,
        sourceDigest: value.contentDigest,
      }));
      const pack = buildContextPack({
        ...buildInput(10_000),
        purpose: 'review',
        sections: [...requiredSections(), input],
      });
      expect(value).toEqual(before);
      expect(pack.governance[kind]).toMatchObject({
        taskRef: value.taskRef,
        revision: value.revision,
        contentDigest: value.contentDigest,
      });
      expect(JSON.stringify(pack)).not.toMatch(
        /\/Users\/fixture|\/private\/tmp\/fixture/,
      );
      expect(pack.omissions).not.toContainEqual(
        expect.objectContaining({
          targetJsonPointer: target,
          reason: 'privacy',
        }),
      );
      const provenance = pack.provenance.find(
        (entry) => entry.targetJsonPointer === target,
      );
      expect(provenance?.sourceDigest).toBe(value.contentDigest);
      expect(provenance?.redactions).toContain(
        `${target}/${kind === 'requirements' ? 'technicalDecisions/0/statement' : 'checks/0/automated/command'}:absolute_path`,
      );
      if (kind === 'requirements') {
        expect(pack.governance.requirements).toMatchObject({
          technicalDecisions: [
            {
              statement:
                'Use only node [REDACTED:absolute_path] throughout; keep the approved CLI version.',
            },
          ],
        });
      } else {
        expect(pack.governance.verification).toMatchObject({
          status: 'passed',
          checks: [
            {
              criterionId: 'AC-1',
              automated: {
                status: 'passed',
                command: '[REDACTED:non_executable_command]',
                exitCode: 0,
              },
            },
          ],
        });
        expect(provenance?.redactions).toContain(
          `${target}/checks/0/automated/command:command_omitted_not_executable`,
        );
      }
      expect(pack.packDigest).toBe(contextPackDigest(pack));
      expect(parseContextPack(pack)).toEqual(pack);
      expect(pack.packDigest).not.toBe(
        contextPackDigest({
          ...pack,
          governance: { ...pack.governance, [kind]: value },
        }),
      );
    },
  );

  it.each([
    'token=fixture-secret',
    'Authorization: Bearer fixture-secret',
    'Contact fixture@example.test',
    'See /Users/fixture/project; token=fixture-secret',
  ])('keeps sensitive governance text blocked: %s', (statement) => {
    expect(() =>
      buildContextPack({
        ...buildInput(10_000),
        sections: [
          ...requiredSections(),
          section(
            '/governance/requirements',
            { technicalDecisions: [{ statement }] },
            true,
          ),
        ],
      }),
    ).toThrow('MANCODE_CONTEXT_REQUIRED_PRIVACY_BLOCKED');
  });

  it('does not rewrite identifiers or scope-like fields to make a required section pass', () => {
    expect(() =>
      buildContextPack({
        ...buildInput(10_000),
        sections: [
          ...requiredSections(),
          section(
            '/governance/requirements',
            {
              taskRef: '/Users/fixture/task',
              technicalDecisions: [{ statement: 'Use /Users/fixture/cli.js.' }],
            },
            true,
          ),
        ],
      }),
    ).toThrow('MANCODE_CONTEXT_REQUIRED_PRIVACY_BLOCKED');
  });

  it.each([
    'Contact 13812345678 after running /Users/fixture/cli.js',
    'Use ghp_abcdefghijklmnopqrstuvwx after running /Users/fixture/cli.js',
    '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
  ])(
    'preserves configured secret and PII filtering after supported projection: %s',
    (statement) => {
      expect(() =>
        buildContextPack({
          ...buildInput(10_000),
          privacy: createInitialPrivacyPolicy({
            workspaceId: TASK_ID,
            operationId: TASK_ID,
            now: '2026-07-17T12:00:00.000Z',
          }),
          sections: [
            ...requiredSections(),
            section(
              '/governance/requirements',
              { technicalDecisions: [{ statement }] },
              true,
            ),
          ],
        }),
      ).toThrow('MANCODE_CONTEXT_REQUIRED_PRIVACY_BLOCKED');
    },
  );

  it('projects a local evidence path in review findings with explicit provenance', () => {
    const value = {
      status: 'passed',
      delivery: {
        correctness:
          'External evidence at /private/tmp/fixture/evaluator.json records the prior checks.',
      },
      contentDigest: `sha256:${'f'.repeat(64)}`,
    };
    const before = structuredClone(value);
    const pack = buildContextPack({
      ...buildInput(10_000),
      purpose: 'review',
      sections: [
        ...requiredSections(),
        section('/governance/review', value, true),
      ],
    });
    expect(pack.governance.review).toEqual({
      ...value,
      delivery: {
        correctness:
          'External evidence at [REDACTED:absolute_path] records the prior checks.',
      },
    });
    expect(value).toEqual(before);
    expect(pack.provenance).toContainEqual(
      expect.objectContaining({
        targetJsonPointer: '/governance/review',
        redactions: ['/governance/review/delivery/correctness:absolute_path'],
      }),
    );
  });

  it.each(['13812345678', 'ghp_abcdefghijklmnopqrstuvwx'])(
    'does not hide enhanced-sensitive content %s by omitting a command containing a path',
    (sensitive) => {
      expect(() =>
        buildContextPack({
          ...buildInput(10_000),
          purpose: 'review',
          privacy: createInitialPrivacyPolicy({
            workspaceId: TASK_ID,
            operationId: TASK_ID,
            now: '2026-07-17T12:00:00.000Z',
          }),
          sections: [
            ...requiredSections(),
            section(
              '/governance/verification',
              {
                checks: [
                  {
                    automated: {
                      command: JSON.stringify([
                        'node',
                        '/Users/fixture/check.cjs',
                        sensitive,
                      ]),
                    },
                  },
                ],
              },
              true,
            ),
          ],
        }),
      ).toThrow('MANCODE_CONTEXT_REQUIRED_PRIVACY_BLOCKED');
    },
  );

  it('keeps the public context read and its original ledger bytes separate from the redacted view', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'mancode-context-paths-'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await initializeV3Project({ projectRoot: root });
      const actor = await createLocalActor(root, { displayName: 'Fixture' });
      const session = await createSession(root, {
        actorId: actor.actorId,
        client: 'vitest',
        identitySource: 'explicit',
      });
      const created = await createV3Workflow({
        projectRoot: root,
        task: 'Read local tooling references safely',
        workflowMode: 'man',
        sessionId: session.sessionId,
        client: 'vitest',
      });
      const requirements = {
        ...created.requirements,
        functionalScope: {
          inScope: ['Tenant-private ticket service'],
          outOfScope: [
            'External services are excluded.',
            'Work outside /private/tmp/fixture/project; reading sibling trials is excluded.',
          ],
        },
        technicalDecisions: [
          {
            decisionId: createUlid(),
            displayId: 'TD-1',
            legacyId: null,
            statement:
              'Use only node /Users/fixture/code/mancode/dist/cli.js throughout.',
          },
        ],
        blockingUnknowns: [
          {
            unknownId: createUlid(),
            displayId: 'Q-1',
            legacyId: null,
            statement: 'Confirm the validation surface.',
            status: 'open' as const,
          },
        ],
      };
      requirements.contentDigest = requirementsLedgerDigest(requirements);
      const drafted = await saveV3RequirementsDraft({
        projectRoot: root,
        taskRef: created.taskRef,
        sessionId: session.sessionId,
        expectedTaskRevision: created.metadata.revision,
        requirements,
      });
      const taskRoot = path.join(
        root,
        '.mancode/local/workflows',
        created.taskRef.taskId,
      );
      const paths = [
        'metadata.json',
        'requirements.json',
        'review-ledger.json',
        'verification-ledger.json',
      ].map((file) => path.join(taskRoot, file));
      const before = await Promise.all(
        paths.map((file) => readFile(file, 'utf8')),
      );
      const code = await contextShow(root, {
        task: `local:${created.taskRef.taskId}`,
        purpose: 'plan',
        session: session.sessionId,
        client: 'vitest',
        json: true,
      });
      expect(code).toBe(0);
      const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(result.pack.governance.requirements).toMatchObject({
        contentDigest: drafted.requirements.contentDigest,
        functionalScope: {
          inScope: requirements.functionalScope.inScope,
          outOfScope: [
            'External services are excluded.',
            'Work outside [REDACTED:absolute_path] reading sibling trials is excluded.',
          ],
        },
        technicalDecisions: [
          { statement: 'Use only node [REDACTED:absolute_path] throughout.' },
        ],
      });
      expect(result.pack.snapshot.requirementsDigest).toBe(
        drafted.requirements.contentDigest,
      );
      expect(result.pack.provenance).toContainEqual(
        expect.objectContaining({
          entityKey: 'requirements-ledger',
          sourceDigest: drafted.requirements.contentDigest,
          redactions: [
            '/governance/requirements/functionalScope/outOfScope/1:absolute_path',
            '/governance/requirements/technicalDecisions/0/statement:absolute_path',
          ],
        }),
      );
      expect(result.pack.packDigest).toBe(contextPackDigest(result.pack));
      expect(() =>
        parseRequirementsLedger(result.pack.governance.requirements),
      ).toThrow(/contentDigest/);
      expect(
        await Promise.all(paths.map((file) => readFile(file, 'utf8'))),
      ).toEqual(before);
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the required envelope, trims only complete optional sections, and has a stable digest', () => {
    const full = buildContextPack(buildInput(10_000));
    const limited = buildContextPack(
      buildInput(Math.max(0, full.budget.estimated - 20)),
    );
    const regenerated = buildContextPack({
      ...buildInput(Math.max(0, full.budget.estimated - 20)),
      generatedAt: '2026-07-17T12:01:00.000Z',
    });

    expect(limited.session).toEqual({ sessionId: 'session-1' });
    expect(limited.activeTask).toMatchObject({ taskRef: `local:${TASK_ID}` });
    expect(limited.omissions.some((item) => item.reason === 'budget')).toBe(
      true,
    );
    expect(limited.packDigest).toBe(regenerated.packDigest);
    expect(limited.budget).toMatchObject({
      tokenizerId: CONTEXT_PACK_TOKENIZER_ID,
      algorithmVersion: CONTEXT_PACK_BUDGET_ALGORITHM_VERSION,
    });
    expect(parseContextPack(limited)).toEqual(limited);
  });

  it('records purpose and privacy omissions without leaking raw content', () => {
    const orient = buildContextPack({
      ...buildInput(10_000),
      purpose: 'orient',
      sections: [
        ...requiredSections(),
        section('/project', { privatePlan: 'not shown for orient' }),
      ],
    });
    expect(orient.project).toBeNull();
    expect(orient.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetJsonPointer: '/project',
          reason: 'purpose_excluded',
        }),
      ]),
    );

    const handoff = buildContextPack({
      ...buildInput(10_000),
      purpose: 'handoff',
      sections: [
        ...requiredSections(),
        section('/latestHandoff', {
          summary: 'See /Users/alice/private-log.txt before continuing.',
        }),
      ],
    });
    expect(handoff.latestHandoff).toBeNull();
    expect(JSON.stringify(handoff)).not.toContain('/Users/alice');
    expect(handoff.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetJsonPointer: '/latestHandoff',
          reason: 'privacy',
        }),
      ]),
    );
  });

  it('marks an oversized required envelope instead of removing it', () => {
    const pack = buildContextPack(buildInput(1));
    expect(pack.budget.exceededByRequiredEnvelope).toBe(true);
    expect(pack.session).toEqual({ sessionId: 'session-1' });
    expect(pack.activeTask).not.toBeNull();
  });

  it('uses the fixed cl100k tokenizer and does not let callers bypass level or estimates', () => {
    expect(contextPackTokenCounter().count('hello world')).toBe(2);
    expect(() =>
      buildContextPack({
        ...buildInput(400),
        level: 'bootstrap',
        purpose: 'orient',
        sections: [...requiredSections(), section('/actor', { id: 'actor-1' })],
      }),
    ).toThrow('MANCODE_CONTEXT_LEVEL_EXCLUDED');

    const pack = buildContextPack(buildInput(10_000));
    const tampered = {
      ...pack,
      budget: { ...pack.budget, estimated: pack.budget.estimated + 1 },
      packDigest: '',
    };
    tampered.packDigest = contextPackDigest(tampered);
    expect(() => parseContextPack(tampered)).toThrow(/fixed tokenizer/);
  });

  it('keeps full context artifact-on-demand and records provenance for the snapshot itself', () => {
    expect(() =>
      buildContextPack({
        ...buildInput(10_000),
        level: 'full',
        sections: [
          ...requiredSections(),
          section('/project', { id: 'project' }),
        ],
      }),
    ).toThrow('MANCODE_CONTEXT_FULL_ARTIFACTS_ON_DEMAND');

    const full = buildContextPack({
      ...buildInput(10_000),
      level: 'full',
      sections: requiredSections(),
    });
    expect(full.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetJsonPointer: '/snapshot' }),
      ]),
    );
    expect(parseContextPack(full)).toEqual(full);
  });
});

function buildInput(budgetLimit: number): ContextPackBuildInput {
  return {
    generatedAt: '2026-07-17T12:00:00.000Z',
    level: 'task',
    purpose: 'plan',
    snapshot: {
      schemaEpoch: TASK_ID,
      taskRevision: 3,
      requirementsDigest: `sha256:${'a'.repeat(64)}`,
      reviewDigest: `sha256:${'b'.repeat(64)}`,
      verificationDigest: `sha256:${'c'.repeat(64)}`,
      ownershipEpoch: 1,
      coordinationRevision: 2,
    },
    budgetLimit,
    sections: [
      ...requiredSections(),
      section('/project', { facts: 'x'.repeat(400) }),
      section('/parentFreshness', {
        status: 'fresh',
        details: 'y'.repeat(300),
      }),
      section('/governance/requirements', {
        goal: 'Rate-limit login failures.',
      }),
    ],
  };
}

function requiredSections(): ContextPackSectionInput[] {
  return [
    section('/session', { sessionId: 'session-1' }, true),
    section('/activeTask', { taskRef: `local:${TASK_ID}`, revision: 3 }, true),
    section('/conflicts', [], true),
    section('/capabilities', { claimAcquisition: 'enforced' }, true),
    section('/transportFreshness', { state: 'unavailable' }, true),
  ];
}

function section(
  targetJsonPointer: ContextPackSectionInput['targetJsonPointer'],
  value: unknown,
  required = false,
): ContextPackSectionInput {
  return {
    targetJsonPointer,
    value,
    required,
    provenance: [
      {
        targetJsonPointer,
        sourceKind: 'entity',
        taskRef: { namespace: 'local', taskId: TASK_ID },
        artifactRef: null,
        entityKey: 'fixture',
        sourceRevision: 1,
        sourceDigest: `sha256:${'d'.repeat(64)}`,
        selectedJsonPointers: [''],
        redactions: [],
      },
    ],
  };
}

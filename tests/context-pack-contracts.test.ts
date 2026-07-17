import { describe, expect, it } from 'vitest';
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

const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';

describe('Context Pack V2 contract', () => {
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

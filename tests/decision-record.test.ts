import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  projectContextIndex,
  queryContextIndex,
} from '../src/context/context-index.js';
import {
  type ConfirmedDecisionV2,
  type DecisionDetails,
  assertDecisionRelationsPublishable,
  decisionContextValue,
  decisionMatch,
  decisionMatches,
  parseDecisionDetails,
  projectDecisions,
} from '../src/context/decision-record.js';
import type { PrivacyPolicySnapshot } from '../src/context/privacy-policy.js';
import type { StoredProjectSnapshot } from '../src/context/store.js';

function details(): DecisionDetails {
  return {
    capability: 'decision-relations:1',
    recordKind: 'decision',
    rationale: 'Avoid initialization races.',
    alternatives: [
      {
        option: 'Directory lock',
        reasonNotChosen: 'Initialization creates a race window.',
      },
    ],
    tradeoffs: ['Requires filesystem hard links.'],
    revisitWhen: ['Storage constraints change.'],
    applicability: { modules: ['runtime'], paths: ['src/runtime/**'] },
    clauses: [
      { id: 'atomic', statement: 'Publish atomically.' },
      { id: 'retry', statement: 'Retry only idempotent operations.' },
    ],
    relations: [],
  };
}
function record(id: number): ConfirmedDecisionV2 {
  return {
    schemaVersion: 2,
    decisionId: `01JZ4B6W5Z0A1B2C3D4E5F6G7${id}`,
    title: 'Lock publishing',
    statement: 'Use atomic publication.',
    taskRef: null,
    confirmedByActorId: '01JZ4B6W5Z0A1B2C3D4E5F6G7H',
    confirmedAt: '2026-09-15T00:00:00.000Z',
    operationId: '01JZ4B6W5Z0A1B2C3D4E5F6G7J',
    authorization: {} as ConfirmedDecisionV2['authorization'],
    details: details(),
  };
}
function successor(
  target: ConfirmedDecisionV2,
  id = 2,
  clauses: 'all' | string[] = 'all',
): ConfirmedDecisionV2 {
  return {
    ...record(id),
    details: {
      ...details(),
      relations: [
        {
          action: 'supersede',
          targetId: target.decisionId,
          targetDigest: digestCanonicalJson(target),
          clauses,
        },
      ],
    },
  };
}
describe('structured decision records', () => {
  it('validates the strict details and rejects unsafe paths, partial clauses and secrets', () => {
    expect(parseDecisionDetails(details())).toEqual(details());
    expect(() => parseDecisionDetails({ ...details(), extra: true })).toThrow();
    expect(() =>
      parseDecisionDetails({ ...details(), rationale: 'password=secret' }),
    ).toThrow();
    expect(() =>
      parseDecisionDetails({
        ...details(),
        applicability: { modules: [], paths: ['../outside'] },
      }),
    ).toThrow();
    expect(() =>
      parseDecisionDetails({
        ...details(),
        clauses: [
          { id: 'a', statement: 'A' },
          { id: 'a', statement: 'B' },
        ],
      }),
    ).toThrow();
  });
  it('keeps current decisions effective independently of task lifecycle and matches explicit module/path relations', () => {
    const result = projectDecisions([record(1)]);
    expect(result.entries[0]?.state).toBe('current');
    expect(decisionMatches(record(1), ['runtime'], [])).toBe(true);
    expect(decisionMatches(record(1), [], ['src/runtime/local-lock.ts'])).toBe(
      true,
    );
    expect(decisionMatches(record(1), [], ['src/**'])).toBe(true);
    expect(decisionMatches(record(1), [], ['src/other/file.ts'])).toBe(false);
  });
  it('retires entire predecessors, leaves partial clauses explicit, and never revives ancestors after revocation', () => {
    const a = record(1);
    const b = successor(a);
    expect(
      projectDecisions([a, b]).entries.map((entry) => entry.state),
    ).toEqual(['historical', 'current']);
    const partial = successor(a, 2, ['atomic']);
    expect(projectDecisions([a, partial]).entries[0]).toMatchObject({
      state: 'partial',
      activeClauses: ['retry'],
    });
    const revoke = {
      ...successor(b, 3),
      details: {
        ...details(),
        recordKind: 'revocation' as const,
        clauses: [],
        relations: [
          {
            action: 'revoke' as const,
            targetId: b.decisionId,
            targetDigest: digestCanonicalJson(b),
            clauses: 'all' as const,
          },
        ],
      },
    };
    expect(
      projectDecisions([a, b, revoke]).entries.map((entry) => entry.state),
    ).toEqual(['historical', 'historical', 'historical']);
  });
  it('excludes hidden successors and predecessors from every projected surface without reviving the old rule', () => {
    const a = record(1);
    const b = successor(a);
    const privacy = {
      policy: { enabled: false },
      exclusions: { entries: [{ entityDigest: digestCanonicalJson(b) }] },
    } as PrivacyPolicySnapshot;
    const result = projectDecisions([a, b], privacy);
    expect(result).toEqual({ entries: [], validityUnavailable: true });
    expect(JSON.stringify(result)).not.toContain(b.decisionId);
    privacy.exclusions.entries[0].entityDigest = digestCanonicalJson(a);
    expect(projectDecisions([a, b], privacy).entries).toEqual([]);
  });
  it('selects explicit decision scope without keywords and hides superseded rules from both index and read', () => {
    const a = record(1);
    const b = successor(a);
    const project = {
      confirmedDecisions: [a, b],
      privacy: null,
    } as unknown as StoredProjectSnapshot;
    const snapshot = projectContextIndex(
      project,
      null,
      'snapshot',
      'implement',
      undefined,
      { modules: ['runtime'] },
    );
    const page = queryContextIndex(snapshot, {
      action: 'index',
      purpose: 'implement',
    });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      ref: `decision:${b.decisionId}`,
      required: true,
      reason: 'explicit_scope_match',
    });
    const hidden = {
      policy: { enabled: false },
      exclusions: { entries: [{ entityDigest: digestCanonicalJson(b) }] },
    } as PrivacyPolicySnapshot;
    project.privacy = hidden;
    const screened = projectContextIndex(
      project,
      null,
      'new',
      'implement',
      undefined,
      { modules: ['runtime'] },
    );
    expect(
      queryContextIndex(screened, {
        action: 'index',
        purpose: 'implement',
        history: true,
      }).entries,
    ).toEqual([]);
    expect(
      queryContextIndex(screened, {
        action: 'read',
        purpose: 'implement',
        ref: `decision:${a.decisionId}`,
        version: digestCanonicalJson(a),
      }).status,
    ).toBe('unavailable');
  });
  it('rejects stale publication and exposes concurrent clone conflicts instead of picking the newest', () => {
    const a = record(1);
    const b = successor(a);
    const c = successor(a, 3);
    expect(() => assertDecisionRelationsPublishable([a, b], c)).toThrow(
      'MANCODE_DECISION_RELATION_STALE',
    );
    expect(
      projectDecisions([a, b, c]).entries.map((entry) => entry.state),
    ).toEqual(['historical', 'conflict', 'conflict']);
    const invalid = successor(a);
    invalid.details.relations[0].targetDigest = `sha256:${'0'.repeat(64)}`;
    expect(projectDecisions([a, invalid]).validityUnavailable).toBe(true);
    expect(() => assertDecisionRelationsPublishable([a], invalid)).toThrow();
  });

  it('does not present the retired aggregate statement as a partial current instruction', () => {
    const a = record(1);
    a.statement = 'Publish atomically and retry all operations.';
    const b = successor(a, 2, ['retry']);
    const partial = projectDecisions([a, b]).entries[0];
    if (!partial) throw new Error('missing partial fixture');
    const value = decisionContextValue(partial) as Record<string, unknown>;
    expect(value).not.toHaveProperty('statement');
    expect(value).toHaveProperty('details.clauses', [
      { id: 'atomic', statement: 'Publish atomically.' },
    ]);
    const snapshot = projectContextIndex(
      { confirmedDecisions: [a, b], privacy: null } as StoredProjectSnapshot,
      null,
      'stable',
      'implement',
      undefined,
      { modules: ['runtime'] },
    );
    const item = snapshot.records.find(
      (entry) => entry.ref === `decision:${a.decisionId}`,
    );
    if (!item) throw new Error('missing indexed fixture');
    expect(
      queryContextIndex(snapshot, {
        action: 'read',
        purpose: 'implement',
        ref: item.ref,
        version: item.version,
      }).content,
    ).not.toContain(a.statement);
  });

  it('covers legal task scope globs and labels uncertain glob intersections', () => {
    const a = record(1);
    a.details.applicability = {
      modules: [],
      paths: ['src/context/context-index.ts'],
    };
    expect(decisionMatch(a, [], ['src/**/*.ts'])).toBe('matched');
    expect(decisionMatch(a, [], ['tests/**/*.ts'])).toBe('none');
    a.details.applicability.paths = ['src/context/**'];
    expect(decisionMatch(a, [], ['src/**/*.ts'])).toBe('possible');
    const task = {
      metadata: {
        taskRef: { namespace: 'local', taskId: 'task' },
        status: 'in_progress',
        revision: 1,
        currentStep: 4,
        transitionState: 'stable',
        governance: { planDecision: 'governed_execution' },
        implementationScope: {
          include: ['src/**/*.ts'],
          exclude: [],
          modules: [],
        },
      },
      requirements: {},
      aggregate: {},
      plan: null,
    };
    const snapshot = projectContextIndex(
      { confirmedDecisions: [a], privacy: null } as StoredProjectSnapshot,
      task as never,
      'stable',
      'implement',
    );
    expect(
      snapshot.records.find((entry) => entry.kind === 'decision'),
    ).toMatchObject({ required: true, reason: 'scope_overlap_uncertain' });
    expect(snapshot.gaps).toContain('decision_applicability_uncertain');
  });

  it('resolves complete conflict sets and invalidates the resolution after another clone adds a competitor', () => {
    const a = record(1);
    const b = successor(a, 2);
    const c = successor(a, 3);
    const resolution = (
      targets: ConfirmedDecisionV2[],
      id = 4,
    ): ConfirmedDecisionV2 => ({
      ...record(id),
      details: {
        ...details(),
        relations: targets.map((target) => ({
          action: 'supersede',
          targetId: target.decisionId,
          targetDigest: digestCanonicalJson(target),
          clauses: 'all',
        })),
        resolution: {
          records: targets.map((target) => ({
            decisionId: target.decisionId,
            digest: digestCanonicalJson(target),
          })),
        },
      },
    });
    const d = resolution([b, c]);
    expect(() =>
      assertDecisionRelationsPublishable([a, b, c], d),
    ).not.toThrow();
    expect(
      projectDecisions([a, b, c, d]).entries.map((entry) => entry.state),
    ).toEqual(['historical', 'historical', 'historical', 'current']);
    expect(projectDecisions([d, c, a, b]).validityUnavailable).toBe(false);
    expect(() =>
      assertDecisionRelationsPublishable([a, b, c], resolution([b])),
    ).toThrow();
    const stale = structuredClone(d);
    const staleReference = stale.details.resolution?.records[0];
    if (!staleReference) throw new Error('missing resolution fixture');
    staleReference.digest = `sha256:${'0'.repeat(64)}`;
    expect(() =>
      assertDecisionRelationsPublishable([a, b, c], stale),
    ).toThrow();
    const e = successor(a, 5);
    expect(() => assertDecisionRelationsPublishable([a, b, c, e], d)).toThrow(
      'MANCODE_DECISION_RESOLUTION_STALE',
    );
    expect(
      projectDecisions([a, b, c, d, e]).entries.find(
        (entry) => entry.decision.decisionId === d.decisionId,
      )?.state,
    ).toBe('conflict');
    const refreshed = resolution([b, c, e], 6);
    const staleCollection = [a, b, c, d, e];
    expect(() =>
      assertDecisionRelationsPublishable(staleCollection, refreshed),
    ).not.toThrow();
    const renewedCollection = [...staleCollection, refreshed];
    expect(
      projectDecisions(renewedCollection)
        .entries.filter((entry) =>
          [d.decisionId, refreshed.decisionId].includes(
            entry.decision.decisionId,
          ),
        )
        .map((entry) => entry.state),
    ).toEqual(['conflict', 'conflict']);
    const recovered = resolution([d, refreshed], 7);
    expect(() =>
      assertDecisionRelationsPublishable(renewedCollection, recovered),
    ).not.toThrow();
    const recoveredCollection = [...renewedCollection, recovered];
    const repaired = projectDecisions(recoveredCollection);
    expect(repaired.validityUnavailable).toBe(false);
    expect(repaired.entries.map((entry) => entry.state)).toEqual([
      'historical',
      'historical',
      'historical',
      'historical',
      'historical',
      'historical',
      'current',
    ]);
    expect(
      projectDecisions([...recoveredCollection].reverse()).validityUnavailable,
    ).toBe(false);
    const uninformed = successor(d, 8);
    expect(
      projectDecisions([...staleCollection, uninformed]).entries.at(-1)?.state,
    ).toBe('conflict');
    const laterCompetitor = successor(a, 9);
    expect(
      projectDecisions([...recoveredCollection, laterCompetitor]).entries.find(
        (entry) => entry.decision.decisionId === recovered.decisionId,
      )?.state,
    ).toBe('conflict');
    const competing = resolution([b, c], 6);
    const merged = [a, b, c, d, competing];
    expect(
      projectDecisions(merged)
        .entries.slice(-2)
        .map((entry) => entry.state),
    ).toEqual(['conflict', 'conflict']);
    expect(() =>
      assertDecisionRelationsPublishable(merged, resolution([d, competing], 7)),
    ).not.toThrow();
    const final = resolution([d, competing], 7);
    expect(projectDecisions([...merged, final]).entries.at(-1)?.state).toBe(
      'current',
    );
    expect(
      projectDecisions([...merged, final, e]).entries.find(
        (entry) => entry.decision.decisionId === final.decisionId,
      )?.state,
    ).toBe('conflict');
    const revoked = {
      ...c,
      details: {
        ...c.details,
        recordKind: 'revocation' as const,
        clauses: [],
        relations: c.details.relations.map((relation) => ({
          ...relation,
          action: 'revoke' as const,
        })),
      },
    };
    const revokeResolution = resolution([b, revoked], 8);
    expect(() =>
      assertDecisionRelationsPublishable([a, b, revoked], revokeResolution),
    ).not.toThrow();
    expect(
      projectDecisions([a, b, revoked, revokeResolution]).entries.map(
        (entry) => entry.state,
      ),
    ).toEqual(['historical', 'historical', 'historical', 'current']);
  });
});

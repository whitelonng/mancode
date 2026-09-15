import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  type ContextIndexSnapshot,
  loadContextIndexSnapshot,
  parseContextBatchRequests,
  projectContextIndex,
  queryContextIndex,
  serializeContextIndex,
} from '../src/context/context-index.js';
import { contextPackTokenCounter } from '../src/context/context-pack.js';
import {
  type StoredProjectSnapshot,
  V3ContextStore,
} from '../src/context/store.js';

function fixture(size = 30): ContextIndexSnapshot {
  return {
    identity: 'checkout-1',
    task: null,
    gaps: [],
    records: Array.from({ length: size }, (_, i) => ({
      ref: `record:${i.toString().padStart(5, '0')}`,
      title: `Decision ${i}`,
      kind: 'decision',
      version: `version-${i}`,
      required: i === size - 1,
      state: 'current' as const,
      reason: 'bound_task',
      source: `record:${i}`,
      content: `Rule ${i}. Only retry when idempotent.`,
    })),
  };
}
const request = { action: 'index' as const, purpose: 'implement' as const };

describe('bounded context index', () => {
  it('keeps mode and policy versions in the bounded task envelope', () => {
    const snapshot = fixture(1000);
    snapshot.task = {
      ref: 'local:01JZ4B6W5Z0A1B2C3D4E5F6G7H',
      revision: 99,
      stage: 4,
      status: 'in_progress',
      workflowMode: 'man',
      policyVersions: { planning: 3, review: 1, verification: 1 },
      planDecision: 'governed_execution',
    };
    const result = queryContextIndex(snapshot, request);
    expect(result.task).toMatchObject({
      workflowMode: 'man',
      policyVersions: { planning: 3, review: 1, verification: 1 },
    });
    expect(
      contextPackTokenCounter().count(serializeContextIndex(result)),
    ).toBeLessThanOrEqual(1600);
  });
  it.each([10, 1000, 10000])(
    'prioritizes required records and bounds whole output for %i entries',
    (size) => {
      const result = queryContextIndex(fixture(size), request);
      expect(result.entries[0]?.required).toBe(true);
      expect(result.entries.length).toBeLessThanOrEqual(12);
      expect(
        contextPackTokenCounter().count(serializeContextIndex(result)),
      ).toBeLessThanOrEqual(1600);
      expect(result.actionReady).toBe(false);
      expect(result).not.toHaveProperty('content');
    },
  );
  it('binds pagination to unseen membership, versions, relationships, query, checkout and privacy generation', () => {
    const snapshot = fixture();
    const first = queryContextIndex(snapshot, request);
    expect(first.next).not.toBeNull();
    for (const mutate of [
      (s: ContextIndexSnapshot) =>
        s.records.push({
          ...s.records[0],
          ref: 'new-required',
          required: true,
        }),
      (s: ContextIndexSnapshot) => s.records.pop(),
      (s: ContextIndexSnapshot) => {
        s.records[20].version = 'new';
      },
      (s: ContextIndexSnapshot) => {
        s.records[20].required = true;
      },
      (s: ContextIndexSnapshot) => {
        s.identity = 'changed-policy-or-checkout';
      },
    ]) {
      const changed = structuredClone(snapshot);
      mutate(changed);
      expect(
        queryContextIndex(changed, {
          ...request,
          cursor: first.next ?? undefined,
        }).status,
      ).toBe('stale');
    }
    expect(
      queryContextIndex(snapshot, {
        ...request,
        action: 'search',
        query: 'x',
        cursor: first.next ?? undefined,
      }).status,
    ).toBe('stale');
  });
  it('reads every byte including conditions and exceptions with incomplete fragments', () => {
    const snapshot = fixture(1);
    const record = snapshot.records[0];
    record.content = `${'This is a long rule. '.repeat(4000)}Exception: never retry non-idempotent operations. 你好🙂`;
    const parts: string[] = [];
    let next: string | undefined;
    do {
      const result = queryContextIndex(snapshot, {
        action: 'read',
        purpose: 'implement',
        ref: record.ref,
        version: record.version,
        cursor: next,
      });
      expect(
        contextPackTokenCounter().count(serializeContextIndex(result)),
      ).toBeLessThanOrEqual(2400);
      if (result.next) expect(result.status).toBe('more_required');
      expect(result.unit?.completeInResponse).toBe(false);
      parts.push(result.content ?? '');
      next = result.next ?? undefined;
    } while (next);
    expect(parts.join('')).toBe(record.content);
  });
  it('rejects old versions and explicitly revalidates a completed snapshot', () => {
    const snapshot = fixture(1);
    const initial = queryContextIndex(snapshot, request);
    snapshot.identity = 'new';
    expect(
      queryContextIndex(snapshot, { ...request, snapshot: initial.snapshot })
        .status,
    ).toBe('stale');
    expect(
      queryContextIndex(snapshot, {
        action: 'read',
        purpose: 'implement',
        ref: snapshot.records[0].ref,
        version: 'old',
      }).status,
    ).toBe('stale');
  });
  it('does not leak excluded or sensitive decision titles through indexing or reading', () => {
    const hidden = {
      decisionId: 'hidden',
      title: 'password=super-secret',
      statement: 'private',
    };
    const project = {
      confirmedDecisions: [hidden],
      privacy: {
        policy: { enabled: false },
        exclusions: {
          entries: [{ entityDigest: digestCanonicalJson(hidden) }],
        },
      },
    } as unknown as StoredProjectSnapshot;
    const snapshot = projectContextIndex(project, null, 'id', 'plan');
    expect(snapshot.records).toEqual([]);
    const result = queryContextIndex(snapshot, {
      ...request,
      action: 'read',
      ref: 'decision:hidden',
      version: 'guess',
    });
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });
  it('rejects a changing authority tuple and changed checkout during double-read', async () => {
    const store = new V3ContextStore(process.cwd());
    let generation = 0;
    store.readProjectSnapshot = async () =>
      ({
        confirmedDecisions: [],
        privacy: null,
        manifest: {
          epoch: 'fixture',
          minReaderVersion: '0.0.0',
          minWriterVersion: '0.0.0',
          managedAdapters: {},
          activationState: 'v3_active',
          legacyBaseline: null,
        },
        fingerprint: String(generation++),
      }) as unknown as StoredProjectSnapshot;
    await expect(
      loadContextIndexSnapshot(store, null, 'orient', 'checkout'),
    ).rejects.toThrow('MANCODE_CONTEXT_INDEX_SNAPSHOT_CHANGED');
    store.readProjectSnapshot = async () =>
      ({
        confirmedDecisions: [],
        privacy: null,
        manifest: {
          epoch: 'fixture',
          minReaderVersion: '0.0.0',
          minWriterVersion: '0.0.0',
          managedAdapters: {},
          activationState: 'v3_active',
          legacyBaseline: null,
        },
        fingerprint: 'stable',
      }) as unknown as StoredProjectSnapshot;
    await expect(
      loadContextIndexSnapshot(store, null, 'orient', async () =>
        String(generation++),
      ),
    ).rejects.toThrow('MANCODE_CONTEXT_INDEX_SNAPSHOT_CHANGED');
  });
  it('keeps reference search bounded and includes required records even without a keyword match', () => {
    const result = queryContextIndex(fixture(1000), {
      ...request,
      action: 'search',
      query: 'not-present',
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.required).toBe(true);
    const broad = queryContextIndex(fixture(1000), {
      ...request,
      action: 'search',
      query: 'rule',
    });
    expect(broad.entries.length).toBeLessThanOrEqual(20);
    expect(
      contextPackTokenCounter().count(serializeContextIndex(broad)),
    ).toBeLessThanOrEqual(1600);
  });
  it('only includes historical records when explicitly requested', () => {
    const snapshot = fixture(1);
    snapshot.records[0].state = 'historical';
    expect(queryContextIndex(snapshot, request).entries).toEqual([]);
    expect(
      queryContextIndex(snapshot, { ...request, history: true }).entries,
    ).toHaveLength(1);
  });
  it('reads a batch within one total budget and continues every content unit without omissions', () => {
    const snapshot = fixture(3);
    snapshot.records[0].content = 'Short approved constraint.';
    snapshot.records[1].content = `${'A condition and its consequences. '.repeat(1700)}Exception: preserve the boundary.`;
    snapshot.records[2].content = 'Final scope constraint.';
    const requests = snapshot.records.map(({ ref, version }) => ({
      ref,
      version,
    }));
    const collected = new Map<string, string>();
    let next: string | undefined;
    let pages = 0;
    do {
      const response = queryContextIndex(snapshot, {
        action: 'read-batch',
        purpose: 'implement',
        requests,
        cursor: next,
      });
      expect(
        contextPackTokenCounter().count(serializeContextIndex(response)),
      ).toBeLessThanOrEqual(2400);
      expect(response.actionReady).toBe(false);
      for (const item of response.items ?? []) {
        collected.set(
          item.ref,
          (collected.get(item.ref) ?? '') + (item.content ?? ''),
        );
        if (item.next) {
          expect(item.status).toBe('more_required');
          expect(item.unit?.completeInResponse).toBe(false);
          const single = queryContextIndex(snapshot, {
            action: 'read',
            purpose: 'implement',
            ref: item.ref,
            version: item.version,
            cursor: item.next,
          });
          expect(single.unit?.start).toBe(item.unit?.end);
        }
      }
      next = response.next ?? undefined;
      expect(++pages).toBeLessThan(100);
    } while (next);
    expect(pages).toBeGreaterThan(1);
    for (const record of snapshot.records)
      expect(collected.get(record.ref)).toBe(record.content);
  });
  it('binds batch continuation to all requests and candidate membership and keeps item errors explicit', () => {
    const snapshot = fixture(2);
    snapshot.records[0].content = 'A long instruction. '.repeat(3000);
    const requests = snapshot.records.map(({ ref, version }) => ({
      ref,
      version,
    }));
    const first = queryContextIndex(snapshot, {
      action: 'read-batch',
      purpose: 'implement',
      requests,
    });
    expect(first.next).not.toBeNull();
    for (const changed of [
      [...requests].reverse(),
      requests.map((item, i) => (i ? { ...item, version: 'new' } : item)),
    ]) {
      expect(
        queryContextIndex(snapshot, {
          action: 'read-batch',
          purpose: 'implement',
          requests: changed,
          cursor: first.next ?? undefined,
        }).status,
      ).toBe('stale');
    }
    const changed = structuredClone(snapshot);
    changed.records.push({ ...changed.records[0], ref: 'new-member' });
    expect(
      queryContextIndex(changed, {
        action: 'read-batch',
        purpose: 'implement',
        requests,
        cursor: first.next ?? undefined,
      }).status,
    ).toBe('stale');
    const result = queryContextIndex(snapshot, {
      action: 'read-batch',
      purpose: 'implement',
      requests: [
        { ref: requests[0].ref, version: 'old' },
        { ref: 'missing', version: 'v1' },
      ],
    });
    expect(result.items?.map((item) => item.status)).toEqual([
      'stale',
      'unavailable',
    ]);
    expect(result.items?.[1].gaps).toEqual(['not_found_or_not_visible']);
    snapshot.absenceDisclosure = true;
    expect(
      queryContextIndex(snapshot, {
        action: 'read',
        purpose: 'implement',
        ref: 'missing',
        version: 'v1',
      }).gaps,
    ).toEqual(['not_found']);
    snapshot.gaps.push('privacy_unavailable');
    expect(
      queryContextIndex(snapshot, {
        action: 'read',
        purpose: 'implement',
        ref: 'missing',
        version: 'v1',
      }).gaps,
    ).toEqual(['not_found_or_not_visible']);
  });
  it('rejects unbounded, duplicate and malformed batch request lists', () => {
    const record = { ref: 'decision:fixture', version: 'v1' };
    for (const input of [
      [],
      Array.from({ length: 9 }, (_, i) => ({ ...record, ref: `ref:${i}` })),
      [record, record],
      [{ ...record, ref: 'x'.repeat(513) }],
      [{ ...record, extra: 'untrusted' }],
    ])
      expect(() => parseContextBatchRequests(input)).toThrow(
        'MANCODE_CONTEXT_BATCH_ARGUMENT_INVALID',
      );
    expect(parseContextBatchRequests([record])).toEqual([record]);
  });
});

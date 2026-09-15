import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import {
  loadContextIndexSnapshot,
  queryContextIndex,
  serializeContextIndex,
} from '../src/context/context-index.js';
import { contextPackTokenCounter } from '../src/context/context-pack.js';
import { V3ContextStore } from '../src/context/store.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function document(
  id: string,
  dependsOn: string[] = [],
  body = 'Only retry idempotent operations. Exception: never retry authorization failures.',
) {
  const metadata = {
    schemaVersion: 1,
    id,
    title: id,
    applicability: { modules: [id], paths: [`src/${id}/**`] },
    dependsOn,
    sections: [
      { id: 'global', title: 'Conditions and exceptions', global: true },
      { id: 'behavior', title: 'Current behavior', global: false },
    ],
  };
  return `<!-- mancode:context-document\n${JSON.stringify(metadata)}\n-->\n<!-- mancode:section global -->\n${body}\n<!-- mancode:section behavior -->\nApply atomically.\n`;
}
describe('document references integrated with bounded context', () => {
  it('finds declared cross-module constraints, preserves global navigation and invalidates cached uncommitted content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mancode-doc-index-'));
    roots.push(root);
    await initializeV3Project({ projectRoot: root });
    await mkdir(path.join(root, 'docs'));
    await writeFile(
      path.join(root, 'docs/entry.md'),
      document('entry', ['storage']),
    );
    await writeFile(path.join(root, 'docs/storage.md'), document('storage'));
    const store = new V3ContextStore(root);
    const load = () =>
      loadContextIndexSnapshot(store, null, 'implement', 'checkout-a', {
        modules: ['entry'],
      });
    const first = await load();
    expect(
      first.records.find((r) => r.ref === 'document:storage#global')?.required,
    ).toBe(true);
    const index = queryContextIndex(first, {
      action: 'index',
      purpose: 'implement',
    });
    expect(index.coverage).toBe(
      'explicit_task_decision_and_declared_document_relations_only',
    );
    expect(
      index.entries.some(
        (e) => e.ref === 'document:storage#global' && e.required,
      ),
    ).toBe(true);
    expect(
      contextPackTokenCounter().count(serializeContextIndex(index)),
    ).toBeLessThanOrEqual(1600);
    const behavior = first.records.find(
      (r) => r.ref === 'document:entry#behavior',
    );
    if (!behavior) throw Error('missing fixture');
    const read = queryContextIndex(first, {
      action: 'read',
      purpose: 'implement',
      ref: behavior.ref,
      version: behavior.version,
    });
    expect(read.relatedDocument).toBe('entry');
    expect(read.gaps).toContain('read_related_document_constraints_via_index');
    const batch = queryContextIndex(first, {
      action: 'read-batch',
      purpose: 'implement',
      requests: [{ ref: behavior.ref, version: behavior.version }],
    });
    expect(batch.items?.[0].relatedDocument).toBe('entry');
    expect(
      contextPackTokenCounter().count(serializeContextIndex(batch)),
    ).toBeLessThanOrEqual(2400);
    expect((await load()).identity).toBe(first.identity);
    await writeFile(
      path.join(root, 'docs/entry.md'),
      document(
        'entry',
        ['storage'],
        'Changed condition; never reuse the old version.',
      ),
    );
    const changed = await load();
    expect(changed.identity).not.toBe(first.identity);
    expect(
      queryContextIndex(changed, {
        action: 'read',
        purpose: 'implement',
        ref: behavior.ref,
        version: behavior.version,
      }).status,
    ).toBe('stale');
    expect(
      queryContextIndex(changed, {
        action: 'index',
        purpose: 'implement',
        snapshot: index.snapshot,
      }).status,
    ).toBe('stale');
    await rm(path.join(root, '.mancode/local/cache/context-index'), {
      recursive: true,
    });
    expect((await load()).identity).toBe(changed.identity);
    await rm(path.join(root, 'docs/storage.md'));
    const missing = await load();
    expect(missing.gaps).toContain('document_dependency_unavailable');
    expect(missing.identity).not.toBe(changed.identity);
  });
});

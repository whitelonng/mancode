import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  type ContextDocumentMetadata,
  loadContextDocuments,
  parseContextDocumentMetadata,
} from '../src/context/context-documents.js';
import type { PrivacyPolicySnapshot } from '../src/context/privacy-policy.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-documents-'));
  roots.push(root);
  await mkdir(path.join(root, 'docs'));
  return root;
}

function metadata(id = 'gateway'): ContextDocumentMetadata {
  return {
    schemaVersion: 1,
    id,
    title: `Contract ${id}`,
    applicability: { modules: [id], paths: [`src/${id}/**`] },
    dependsOn: [],
    sections: [
      { id: 'limits', title: 'Global conditions and exceptions', global: true },
      { id: 'behavior', title: 'Behavior', global: false },
      { id: 'other', title: 'Other behavior', global: false },
    ],
  };
}

function document(meta = metadata()): string {
  return `<!-- mancode:context-document\n${JSON.stringify(meta)}\n-->\n<!-- mancode:section limits -->\n# Conditions\nOnly retry idempotent operations.\nException: never retry authorization failures.\n<!-- mancode:section behavior -->\n# Behavior\nPublish atomically.\n<!-- mancode:section other -->\n# Other\nPreserve ordering.\n`;
}

describe('declared repository context documents', () => {
  it('finds a differently named cross-module contract through declarations and includes all global constraints', async () => {
    const root = await fixture();
    const a = metadata();
    a.dependsOn = ['storage'];
    await writeFile(path.join(root, 'docs', 'gateway.md'), document(a));
    await writeFile(
      path.join(root, 'docs', 'storage.md'),
      document(metadata('storage')),
    );
    await writeFile(
      path.join(root, 'docs', 'unrelated.md'),
      document(metadata('unrelated')),
    );
    const result = await loadContextDocuments(root, {
      modules: ['gateway'],
      sectionRefs: ['document:gateway#behavior'],
    });
    const required = result.records
      .filter((record) => record.required)
      .map((record) => record.ref);
    expect(required).toEqual([
      'document:gateway#limits',
      'document:gateway#behavior',
      'document:storage#limits',
      'document:storage#behavior',
      'document:storage#other',
    ]);
    expect(
      result.records.find(
        (record) => record.ref === 'document:gateway#behavior',
      )?.requires,
    ).toContain('document:storage#behavior');
    expect(
      result.records.find((record) => record.ref === 'document:gateway#limits')
        ?.content,
    ).toContain('Exception: never retry authorization failures.');
    expect(result.gaps).toContain(
      'undeclared_document_dependencies_not_covered',
    );
    expect(result.coverage).toBe('declared_docs_markdown_only');
  });

  it('changes collection identity for uncommitted edits, membership, declarations and checkout', async () => {
    const root = await fixture();
    const a = path.join(root, 'docs', 'a.md');
    await writeFile(a, document());
    const read = () => loadContextDocuments(root, { modules: ['gateway'] });
    const initial = await read();
    expect((await read()).fingerprint).toBe(initial.fingerprint);
    await writeFile(
      a,
      document().replace('Publish atomically.', 'Publish with durability.'),
    );
    const edit = await read();
    expect(edit.fingerprint).not.toBe(initial.fingerprint);
    expect(edit.records[0]?.version).not.toBe(initial.records[0]?.version);
    const b = path.join(root, 'docs', 'b.md');
    await writeFile(b, document(metadata('storage')));
    const added = await read();
    expect(added.fingerprint).not.toBe(edit.fingerprint);
    const relation = metadata();
    relation.dependsOn = ['storage'];
    await writeFile(a, document(relation));
    const linked = await read();
    expect(linked.fingerprint).not.toBe(added.fingerprint);
    await rm(b);
    const removed = await read();
    expect(removed.fingerprint).not.toBe(linked.fingerprint);
    expect(removed.gaps).toContain('document_dependency_unavailable');
    const otherRoot = await fixture();
    await writeFile(path.join(otherRoot, 'docs', 'a.md'), document(relation));
    expect((await loadContextDocuments(otherRoot)).fingerprint).not.toBe(
      removed.fingerprint,
    );
  });

  it('does not guess unmarked documents, hidden directories, dependencies or paths outside docs', async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, 'docs', 'ordinary.md'),
      '# spec\nSome undocumented rules.',
    );
    await writeFile(path.join(root, 'outside.md'), document());
    for (const directory of ['.hidden', 'node_modules', 'vendor']) {
      await mkdir(path.join(root, 'docs', directory));
      await writeFile(
        path.join(root, 'docs', directory, 'contract.md'),
        document(),
      );
    }
    const result = await loadContextDocuments(root, {
      modules: ['unknown'],
      paths: ['src/unknown/file.ts'],
    });
    expect(result.records).toEqual([]);
    expect(result.gaps).toContain('document_applicability_not_declared');
  });

  it('rejects duplicate ids, missing sections, undeclared preambles and local references without choosing an authority', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'docs', 'one.md'), document());
    await writeFile(path.join(root, 'docs', 'two.md'), document());
    let result = await loadContextDocuments(root);
    expect(result.records).toEqual([]);
    expect(result.gaps).toContain('document_id_conflict');
    await rm(path.join(root, 'docs', 'two.md'));
    const target = path.join(root, 'docs', 'one.md');
    await writeFile(
      target,
      document().replace('<!-- mancode:section other -->', ''),
    );
    expect((await loadContextDocuments(root)).gaps).toContain(
      'document_corrupt',
    );
    await writeFile(
      target,
      document().replace(
        '\n<!-- mancode:section limits -->',
        '\nForgotten exception\n<!-- mancode:section limits -->',
      ),
    );
    result = await loadContextDocuments(root);
    expect(result.records).toEqual([]);
    expect(result.gaps).toContain('document_corrupt');
    expect(() =>
      parseContextDocumentMetadata({
        ...metadata(),
        dependsOn: ['local:task'],
      }),
    ).toThrow();
    expect(() =>
      parseContextDocumentMetadata({
        ...metadata(),
        applicability: { modules: [], paths: ['../secrets'] },
      }),
    ).toThrow();
  });

  it('keeps fenced section examples as data, and rejects unclosed fenced rules', async () => {
    const root = await fixture();
    const target = path.join(root, 'docs', 'one.md');
    await writeFile(
      target,
      `${document()}\n\`\`\`md\n<!-- mancode:section invented -->\n\`\`\`\n`,
    );
    const result = await loadContextDocuments(root);
    expect(
      result.records.find((record) => record.ref.endsWith('#other'))?.content,
    ).toContain('<!-- mancode:section invented -->');
    await writeFile(target, `${document()}\n\`\`\`md\nexception`);
    expect((await loadContextDocuments(root)).gaps).toContain(
      'document_corrupt',
    );
  });

  it('never opens excluded paths or symlink files and ancestors', async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(path.join(outside, 'secret.md'), document());
    await symlink(
      path.join(outside, 'secret.md'),
      path.join(root, 'docs', 'link.md'),
    );
    await symlink(outside, path.join(root, 'docs', 'linked-dir'));
    await writeFile(path.join(root, 'docs', 'excluded.md'), document());
    const spy = vi.mocked(fs.open);
    spy.mockClear();
    const result = await loadContextDocuments(root, {
      excludedPaths: ['docs/excluded.md'],
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    expect(result.gaps).toContain('document_unsafe_path');
    expect(result.gaps).toContain('document_privacy_unavailable');
  });

  it('screens titles, source and body before returning content and keeps hidden dependency ids out of gaps', async () => {
    const root = await fixture();
    const hidden = document(metadata('private'));
    await writeFile(path.join(root, 'docs', 'private.md'), hidden);
    const a = metadata();
    a.dependsOn = ['private'];
    await writeFile(path.join(root, 'docs', 'a.md'), document(a));
    const privacy = {
      policy: { enabled: false },
      exclusions: { entries: [{ entityDigest: digestCanonicalJson(hidden) }] },
      digest: 'privacy-v1',
    } as PrivacyPolicySnapshot;
    const result = await loadContextDocuments(root, {
      privacy,
      modules: ['gateway'],
    });
    expect(
      result.records.some((record) => record.ref.includes('private')),
    ).toBe(false);
    expect(
      result.records
        .flatMap((record) => record.requires)
        .some((ref) => ref.includes('private')),
    ).toBe(false);
    expect(JSON.stringify(result.gaps)).not.toContain('private');
    expect(result.gaps).toContain('document_dependency_unavailable');
    expect(result.gaps).toContain('document_privacy_unavailable');
    expect(
      (
        await loadContextDocuments(root, {
          privacy: { ...privacy, digest: 'privacy-v2' },
        })
      ).fingerprint,
    ).not.toBe(result.fingerprint);
  });

  it('matches file globs conservatively and exposes unknown section selection', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'docs', 'a.md'), document());
    const concrete = await loadContextDocuments(root, {
      paths: ['src/gateway/main.ts'],
    });
    expect(concrete.records.filter((record) => record.required)).toHaveLength(
      3,
    );
    const uncertain = await loadContextDocuments(root, {
      paths: ['src/**/*.ts'],
    });
    expect(uncertain.gaps).toContain('document_applicability_uncertain');
    expect(uncertain.records.filter((record) => record.required)).toHaveLength(
      3,
    );
    expect(
      (
        await loadContextDocuments(root, {
          sectionRefs: ['document:gateway#missing'],
        })
      ).gaps,
    ).toContain('document_section_not_found');
  });

  it('distinguishes unreadable and oversized documents from an empty result', async () => {
    const root = await fixture();
    const target = path.join(root, 'docs', 'contract.md');
    await writeFile(target, document());
    vi.mocked(fs.open).mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    const unreadable = await loadContextDocuments(root);
    expect(unreadable.records).toEqual([]);
    expect(unreadable.gaps).toContain('document_permission_denied');
    await writeFile(target, 'x'.repeat(2 * 1024 * 1024 + 1));
    const oversized = await loadContextDocuments(root);
    expect(oversized.records).toEqual([]);
    expect(oversized.gaps).toContain('document_size_limit');
  });

  it('screens the decoded metadata as well as the file bytes', async () => {
    const root = await fixture();
    const meta = metadata();
    await writeFile(path.join(root, 'docs', 'contract.md'), document(meta));
    const privacy = {
      policy: { enabled: false },
      exclusions: { entries: [{ entityDigest: digestCanonicalJson(meta) }] },
      digest: 'metadata-excluded',
    } as PrivacyPolicySnapshot;
    const result = await loadContextDocuments(root, { privacy });
    expect(result.records).toEqual([]);
    expect(result.gaps).toContain('document_privacy_unavailable');
  });
});

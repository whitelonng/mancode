import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { digestCanonicalJson } from './canonical.js';
import { assertPrivacyValueAllowed } from './privacy-guard.js';
import type { PrivacyPolicySnapshot } from './privacy-policy.js';
import { redactSharedText } from './privacy.js';
import { assertKnownKeys, assertRecord } from './validation.js';

const HEADER = '<!-- mancode:context-document\n';
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 10_000;

export interface ContextDocumentMetadata {
  schemaVersion: 1;
  id: string;
  title: string;
  applicability: { modules: string[]; paths: string[] };
  dependsOn: string[];
  sections: Array<{ id: string; title: string; global: boolean }>;
}

export interface ContextDocumentRecord {
  ref: string;
  kind: 'document' | 'document_section';
  title: string;
  version: string;
  required: boolean;
  state: 'current';
  reason: string;
  source: string;
  content: string;
  requires: string[];
}

export interface ContextDocumentsOptions {
  privacy?: PrivacyPolicySnapshot | null;
  modules?: string[];
  paths?: string[];
  documentIds?: string[];
  /** Optional narrowing after identifying a document; its global sections remain required. */
  sectionRefs?: string[];
  /** Safe repository-relative paths, screened before opening any document. */
  excludedPaths?: string[];
}

export interface ContextDocumentsSnapshot {
  records: ContextDocumentRecord[];
  fingerprint: string;
  gaps: string[];
  coverage: 'declared_docs_markdown_only';
}

function fail(): never {
  throw new Error('MANCODE_CONTEXT_DOCUMENT_CORRUPT');
}

function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail();
  return value;
}

function identifier(value: unknown): string {
  const result = text(value, 64);
  if (!ID.test(result)) fail();
  return result;
}

function strings(value: unknown, parse: (item: unknown) => string): string[] {
  if (!Array.isArray(value) || value.length > 64) fail();
  const result = value.map(parse);
  if (new Set(result).size !== result.length) fail();
  return result;
}

function safeRelative(value: unknown): string {
  const result = text(value, 256);
  if (
    result.startsWith('/') ||
    result.includes('\\') ||
    result.includes(':') ||
    result
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || part.startsWith('.'),
      )
  )
    fail();
  return result;
}

export function parseContextDocumentMetadata(
  value: unknown,
): ContextDocumentMetadata {
  assertRecord(value, 'context document');
  assertKnownKeys(
    value,
    ['schemaVersion', 'id', 'title', 'applicability', 'dependsOn', 'sections'],
    'context document',
  );
  if (value.schemaVersion !== 1) fail();
  assertRecord(value.applicability, 'context document applicability');
  assertKnownKeys(
    value.applicability,
    ['modules', 'paths'],
    'context document applicability',
  );
  if (
    !Array.isArray(value.sections) ||
    !value.sections.length ||
    value.sections.length > 64
  )
    fail();
  const sections = value.sections.map((section) => {
    assertRecord(section, 'context document section');
    assertKnownKeys(
      section,
      ['id', 'title', 'global'],
      'context document section',
    );
    if (typeof section.global !== 'boolean') fail();
    return {
      id: identifier(section.id),
      title: text(section.title),
      global: section.global,
    };
  });
  if (
    new Set(sections.map((section) => section.id)).size !== sections.length ||
    !sections.some((section) => section.global)
  )
    fail();
  return {
    schemaVersion: 1,
    id: identifier(value.id),
    title: text(value.title),
    applicability: {
      modules: strings(value.applicability.modules, (item) => text(item)),
      paths: strings(value.applicability.paths, safeRelative),
    },
    dependsOn: strings(value.dependsOn, identifier),
    sections,
  };
}

interface ParsedDocument {
  metadata: ContextDocumentMetadata;
  body: string;
  sections: Map<string, string>;
  source: string;
  version: string;
}

/** Only a leading marker opts in. Fenced examples never declare records or sections. */
function parseDocument(raw: string, source: string): ParsedDocument | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(HEADER)) return null;
  const end = normalized.indexOf('\n-->', HEADER.length);
  if (end < 0) fail();
  const metadata = parseContextDocumentMetadata(
    JSON.parse(normalized.slice(HEADER.length, end)),
  );
  const body = normalized.slice(end + 4).trim();
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = () => {
    if (current !== null) sections.set(current, buffer.join('\n').trim());
    else if (buffer.some((line) => line.trim())) fail();
    buffer = [];
  };
  for (const line of body.split('\n')) {
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const delimiter = code?.[1];
    if (delimiter && !fence)
      fence = { char: delimiter.charAt(0), length: delimiter.length };
    else if (
      delimiter &&
      fence &&
      delimiter.charAt(0) === fence.char &&
      delimiter.length >= fence.length &&
      !code?.[2]?.trim()
    )
      fence = null;
    const marker = !fence
      ? /^<!-- mancode:section ([a-z][a-z0-9-]{0,63}) -->$/.exec(line)
      : null;
    const sectionId = marker?.[1];
    if (sectionId) {
      flush();
      if (
        sections.has(sectionId) ||
        !metadata.sections.some((section) => section.id === sectionId)
      )
        fail();
      current = sectionId;
    } else buffer.push(line);
  }
  flush();
  if (
    fence ||
    sections.size !== metadata.sections.length ||
    [...sections.values()].some((content) => !content)
  )
    fail();
  return {
    metadata,
    body,
    sections,
    source,
    version: digestCanonicalJson(raw),
  };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function relativeInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

/** Check all ancestors and the opened object before reading bytes; never follow a symlink. */
async function readDocument(root: string, relative: string): Promise<string> {
  const target = path.join(root, relative);
  let parent = root;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = await lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('unsafe_path');
  }
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const resolved = await realpath(target);
    const [opened, current] = await Promise.all([handle.stat(), lstat(target)]);
    if (
      !relativeInside(root, resolved) ||
      resolved !== target ||
      !opened.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw new Error('unsafe_path');
    if (opened.size > MAX_BYTES) throw new Error('size_limit');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('size_limit');
    const after = await handle.stat();
    if (
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.size !== opened.size
    )
      throw new Error('changed');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

function pathMatch(
  declared: string,
  selected: string,
): 'match' | 'possible' | 'none' {
  const glob = /[*?\[\]{}()!+@]/;
  if (!glob.test(selected))
    return path.matchesGlob(selected, declared) ? 'match' : 'none';
  if (!glob.test(declared))
    return path.matchesGlob(declared, selected) ? 'match' : 'none';
  const a = declared.split(glob)[0] ?? '';
  const b = selected.split(glob)[0] ?? '';
  return a.startsWith(b) || b.startsWith(a) ? 'possible' : 'none';
}

/** Read-only projection. Call twice as part of the enclosing authority snapshot protocol. */
export async function loadContextDocuments(
  rootDir: string,
  options: ContextDocumentsOptions = {},
): Promise<ContextDocumentsSnapshot> {
  const root = await realpath(rootDir);
  const gaps = new Set<string>([
    'undeclared_document_dependencies_not_covered',
  ]);
  const fingerprints: unknown[] = [];
  const documents: ParsedDocument[] = [];
  const excluded = (options.excludedPaths ?? []).map(safeRelative);
  let count = 0;
  const visit = async (relative: string): Promise<void> => {
    if (
      excluded.some(
        (entry) => relative === entry || relative.startsWith(`${entry}/`),
      )
    ) {
      gaps.add('document_privacy_unavailable');
      return;
    }
    try {
      assertPrivacyValueAllowed(options.privacy, relative);
      if (redactSharedText(relative).redactions.length)
        throw new Error('redacted');
    } catch {
      gaps.add('document_privacy_unavailable');
      return;
    }
    try {
      const target = path.join(root, relative);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        gaps.add('document_unsafe_path');
        fingerprints.push([relative, 'symlink']);
        return;
      }
      if (stat.isDirectory()) {
        for (const name of (await readdir(target)).sort()) {
          if (name.startsWith('.') || ['node_modules', 'vendor'].includes(name))
            continue;
          if (++count > MAX_FILES) {
            gaps.add('document_discovery_incomplete');
            break;
          }
          await visit(`${relative}/${name}`);
        }
        return;
      }
      if (!stat.isFile() || !relative.endsWith('.md')) return;
      const raw = await readDocument(root, relative);
      fingerprints.push([relative, digestCanonicalJson(raw)]);
      try {
        assertPrivacyValueAllowed(options.privacy, relative);
        assertPrivacyValueAllowed(options.privacy, raw);
        if (
          redactSharedText(raw).redactions.length ||
          redactSharedText(relative).redactions.length
        )
          throw new Error('redacted');
      } catch {
        gaps.add('document_privacy_unavailable');
        return;
      }
      const document = parseDocument(raw, relative);
      if (document) {
        try {
          assertPrivacyValueAllowed(options.privacy, document.metadata);
          if (
            redactSharedText(JSON.stringify(document.metadata)).redactions
              .length
          )
            throw new Error('redacted');
        } catch {
          gaps.add('document_privacy_unavailable');
          return;
        }
        documents.push(document);
      }
    } catch (error) {
      const reason =
        errorCode(error) === 'ENOENT'
          ? 'document_not_found'
          : ['EACCES', 'EPERM'].includes(errorCode(error) ?? '')
            ? 'document_permission_denied'
            : error instanceof Error && error.message === 'size_limit'
              ? 'document_size_limit'
              : error instanceof Error && error.message === 'changed'
                ? 'document_snapshot_changed'
                : (error instanceof Error && error.message === 'unsafe_path') ||
                    errorCode(error) === 'ELOOP'
                  ? 'document_unsafe_path'
                  : 'document_corrupt';
      gaps.add(reason);
      fingerprints.push([relative, reason]);
    }
  };
  await visit('docs');
  const duplicates = new Set<string>();
  const byId = new Map<string, ParsedDocument>();
  for (const document of documents) {
    if (byId.has(document.metadata.id)) duplicates.add(document.metadata.id);
    byId.set(document.metadata.id, document);
  }
  for (const id of duplicates) byId.delete(id);
  if (duplicates.size) gaps.add('document_id_conflict');
  const selected = new Set(options.documentIds ?? []);
  for (const ref of options.sectionRefs ?? []) {
    const match =
      /^document:([a-z][a-z0-9-]{0,63})#([a-z][a-z0-9-]{0,63})$/.exec(ref);
    const id = match?.[1];
    const section = match?.[2];
    if (!id || !section || !byId.get(id)?.sections.has(section))
      gaps.add('document_section_not_found');
    else selected.add(id);
  }
  const matchedModules = new Set<string>();
  const matchedPaths = new Set<string>();
  for (const document of byId.values()) {
    for (const module of options.modules ?? [])
      if (document.metadata.applicability.modules.includes(module)) {
        selected.add(document.metadata.id);
        matchedModules.add(module);
      }
    for (const selectedPath of options.paths ?? [])
      for (const declared of document.metadata.applicability.paths) {
        const match = pathMatch(declared, selectedPath);
        if (match !== 'none') {
          selected.add(document.metadata.id);
          matchedPaths.add(selectedPath);
          if (match === 'possible')
            gaps.add('document_applicability_uncertain');
        }
      }
  }
  if (
    (options.modules ?? []).some((module) => !matchedModules.has(module)) ||
    (options.paths ?? []).some(
      (selectedPath) => !matchedPaths.has(selectedPath),
    )
  )
    gaps.add('document_applicability_not_declared');
  const dependencyIds = new Set<string>();
  const queue = [...selected];
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const document = byId.get(id);
    if (!document) {
      gaps.add('document_dependency_unavailable');
      continue;
    }
    for (const dependency of document.metadata.dependsOn) {
      dependencyIds.add(dependency);
      selected.add(dependency);
      queue.push(dependency);
    }
  }
  const records: ContextDocumentRecord[] = [];
  for (const [id, document] of [...byId.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const ref = `document:${id}`;
    const globals = document.metadata.sections
      .filter((section) => section.global)
      .map((section) => `${ref}#${section.id}`);
    const dependencies = document.metadata.dependsOn.flatMap(
      (dependency) =>
        byId
          .get(dependency)
          ?.metadata.sections.map(
            (section) => `document:${dependency}#${section.id}`,
          ) ?? [],
    );
    const chosenRefs = (options.sectionRefs ?? []).filter((section) =>
      section.startsWith(`${ref}#`),
    );
    const chosen = document.metadata.sections.filter(
      (section) =>
        !chosenRefs.length ||
        dependencyIds.has(id) ||
        section.global ||
        chosenRefs.includes(`${ref}#${section.id}`),
    );
    const common = {
      version: document.version,
      state: 'current' as const,
      source: document.source,
    };
    records.push({
      ...common,
      ref,
      kind: 'document',
      title: document.metadata.title,
      content: document.body,
      required: false,
      reason: 'declared_document',
      requires: [...globals, ...dependencies],
    });
    for (const section of document.metadata.sections)
      records.push({
        ...common,
        ref: `${ref}#${section.id}`,
        kind: 'document_section',
        title: section.title,
        content: document.sections.get(section.id) ?? '',
        required: selected.has(id) && chosen.includes(section),
        reason: dependencyIds.has(id)
          ? 'declared_document_dependency'
          : section.global
            ? 'document_global_constraint'
            : 'declared_document_section',
        requires: [
          ...globals.filter((global) => global !== `${ref}#${section.id}`),
          ...dependencies,
        ],
      });
  }
  return {
    records,
    fingerprint: digestCanonicalJson([
      root,
      fingerprints,
      options.privacy?.digest ?? null,
      excluded,
      options.modules ?? [],
      options.paths ?? [],
      options.documentIds ?? [],
      options.sectionRefs ?? [],
    ]),
    gaps: [...gaps].sort(),
    coverage: 'declared_docs_markdown_only',
  };
}

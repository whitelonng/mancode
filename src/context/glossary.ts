import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EntityHomeStore } from '../runtime/entity-home-store.js';
import { acquireLocalLock } from '../runtime/local-lock.js';
import { createUlid } from './ids.js';
import { assertSharedTextSafe } from './privacy.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

/** One user-confirmed project term that shared planning may rely on. */
export interface GlossaryEntryV1 {
  term: string;
  definition: string;
  aliases: string[];
  sourceTaskRef: TaskRef | null;
  confirmedAt: string;
}

export interface ProjectGlossaryV1 {
  schemaVersion: 1;
  revision: number;
  entries: GlossaryEntryV1[];
}

export interface GlossaryEntryInput {
  term: string;
  definition: string;
  aliases?: string[];
  sourceTaskRef?: TaskRef | null;
  now?: Date;
}

export interface GlossaryEntryUpdateInput {
  term: string;
  definition?: string;
  aliases?: string[];
  sourceTaskRef?: TaskRef | null;
  now?: Date;
}

export const GLOSSARY_TERM_MAX_LENGTH = 64;
export const GLOSSARY_DEFINITION_MAX_LENGTH = 500;
export const GLOSSARY_MAX_ENTRIES = 200;

const GLOSSARY_LOCK_KEY = 'glossary:project';

export function emptyProjectGlossary(): ProjectGlossaryV1 {
  return { schemaVersion: 1, revision: 0, entries: [] };
}

export function parseProjectGlossary(value: unknown): ProjectGlossaryV1 {
  assertRecord(value, 'project glossary');
  assertKnownKeys(
    value,
    ['schemaVersion', 'revision', 'entries'],
    'project glossary',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('project glossary schemaVersion must be 1');
  }
  const revision = value.revision;
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new Error('project glossary revision must be a non-negative integer');
  }
  if (!Array.isArray(value.entries)) {
    throw new Error('project glossary entries must be an array');
  }
  if (value.entries.length > GLOSSARY_MAX_ENTRIES) {
    throw new Error('MANCODE_GLOSSARY_ENTRY_LIMIT_EXCEEDED');
  }
  const entries = value.entries.map((entry) => parseGlossaryEntry(entry));
  assertGlobalTermUniqueness(entries);
  return { schemaVersion: 1, revision, entries };
}

export function parseGlossaryEntry(value: unknown): GlossaryEntryV1 {
  assertRecord(value, 'glossary entry');
  assertKnownKeys(
    value,
    ['term', 'definition', 'aliases', 'sourceTaskRef', 'confirmedAt'],
    'glossary entry',
  );
  const term = parseGlossaryText(
    value.term,
    'glossary term',
    GLOSSARY_TERM_MAX_LENGTH,
  );
  const definition = parseGlossaryText(
    value.definition,
    'glossary definition',
    GLOSSARY_DEFINITION_MAX_LENGTH,
  );
  if (!Array.isArray(value.aliases)) {
    throw new Error('glossary entry aliases must be an array');
  }
  const aliases = value.aliases.map((alias) =>
    parseGlossaryText(alias, 'glossary alias', GLOSSARY_TERM_MAX_LENGTH),
  );
  const localKeys = new Set<string>([termKey(term)]);
  for (const alias of aliases) {
    const key = termKey(alias);
    if (localKeys.has(key)) {
      throw new Error(`MANCODE_GLOSSARY_TERM_CONFLICT: ${alias}`);
    }
    localKeys.add(key);
  }
  const sourceTaskRef =
    value.sourceTaskRef === null
      ? null
      : parseTaskRefValue(value.sourceTaskRef);
  if (sourceTaskRef?.namespace === 'local') {
    throw new Error('MANCODE_GLOSSARY_LOCAL_TASK_FORBIDDEN');
  }
  return {
    term,
    definition,
    aliases,
    sourceTaskRef,
    confirmedAt: parseTimestamp(value.confirmedAt, 'glossary confirmedAt'),
  };
}

export function projectGlossaryPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'shared',
    'context',
    'glossary.json',
  );
}

/** A missing glossary file reads as the canonical empty revision-0 glossary. */
export async function readProjectGlossary(
  projectRoot: string,
): Promise<ProjectGlossaryV1> {
  try {
    return parseProjectGlossary(
      JSON.parse(await readFile(projectGlossaryPath(projectRoot), 'utf8')),
    );
  } catch (error) {
    if (isNotFound(error)) return emptyProjectGlossary();
    if (error instanceof SyntaxError) {
      throw new Error(
        'MANCODE_CONTEXT_ENTITY_CORRUPT: shared/context/glossary.json',
      );
    }
    throw error;
  }
}

export function findGlossaryEntry(
  glossary: ProjectGlossaryV1,
  term: string,
): GlossaryEntryV1 | null {
  const key = termKey(term);
  return (
    glossary.entries.find(
      (entry) =>
        termKey(entry.term) === key ||
        entry.aliases.some((alias) => termKey(alias) === key),
    ) ?? null
  );
}

export async function addGlossaryEntry(
  projectRoot: string,
  store: EntityHomeStore,
  expectedRevision: number,
  input: GlossaryEntryInput,
): Promise<ProjectGlossaryV1> {
  return mutateProjectGlossary(
    projectRoot,
    store,
    expectedRevision,
    (glossary) => {
      if (findGlossaryEntry(glossary, input.term) !== null) {
        throw new Error(`MANCODE_GLOSSARY_TERM_EXISTS: ${input.term}`);
      }
      if (glossary.entries.length >= GLOSSARY_MAX_ENTRIES) {
        throw new Error('MANCODE_GLOSSARY_ENTRY_LIMIT_EXCEEDED');
      }
      return [
        ...glossary.entries,
        {
          term: input.term,
          definition: input.definition,
          aliases: input.aliases ?? [],
          sourceTaskRef: input.sourceTaskRef ?? null,
          confirmedAt: (input.now ?? new Date()).toISOString(),
        },
      ];
    },
  );
}

export async function updateGlossaryEntry(
  projectRoot: string,
  store: EntityHomeStore,
  expectedRevision: number,
  input: GlossaryEntryUpdateInput,
): Promise<ProjectGlossaryV1> {
  return mutateProjectGlossary(
    projectRoot,
    store,
    expectedRevision,
    (glossary) => {
      const key = termKey(input.term);
      const index = glossary.entries.findIndex(
        (entry) => termKey(entry.term) === key,
      );
      if (index === -1) {
        throw new Error(`MANCODE_GLOSSARY_TERM_NOT_FOUND: ${input.term}`);
      }
      const previous = glossary.entries[index] as GlossaryEntryV1;
      const next: GlossaryEntryV1 = {
        term: previous.term,
        definition: input.definition ?? previous.definition,
        aliases: input.aliases ?? previous.aliases,
        sourceTaskRef:
          input.sourceTaskRef === undefined
            ? previous.sourceTaskRef
            : input.sourceTaskRef,
        confirmedAt: (input.now ?? new Date()).toISOString(),
      };
      return glossary.entries.map((entry, position) =>
        position === index ? next : entry,
      );
    },
  );
}

export async function removeGlossaryEntry(
  projectRoot: string,
  store: EntityHomeStore,
  expectedRevision: number,
  term: string,
): Promise<ProjectGlossaryV1> {
  return mutateProjectGlossary(
    projectRoot,
    store,
    expectedRevision,
    (glossary) => {
      const key = termKey(term);
      const remaining = glossary.entries.filter(
        (entry) => termKey(entry.term) !== key,
      );
      if (remaining.length === glossary.entries.length) {
        throw new Error(`MANCODE_GLOSSARY_TERM_NOT_FOUND: ${term}`);
      }
      return remaining;
    },
  );
}

/**
 * Glossary entries are user-confirmed authority, so a mutation must never
 * lose an update. The whole read-validate-write sequence runs under one
 * store-local lock, and the revision CAS still rejects any writer that read
 * a stale glossary before entering the lock.
 */
async function mutateProjectGlossary(
  projectRoot: string,
  store: EntityHomeStore,
  expectedRevision: number,
  mutate: (glossary: ProjectGlossaryV1) => GlossaryEntryV1[],
): Promise<ProjectGlossaryV1> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error(
      'MANCODE_GLOSSARY_EXPECTED_REVISION_INVALID: expected revision must be a non-negative integer',
    );
  }
  const lock = await acquireLocalLock(store, {
    operationId: createUlid(),
    entityLockKey: GLOSSARY_LOCK_KEY,
  });
  try {
    const current = await readProjectGlossary(projectRoot);
    if (current.revision !== expectedRevision) {
      throw new Error(
        `MANCODE_GLOSSARY_REVISION_CONFLICT: expected ${expectedRevision}, found ${current.revision}`,
      );
    }
    const next = parseProjectGlossary({
      schemaVersion: 1,
      revision: current.revision + 1,
      entries: mutate(current),
    });
    await writeGlossaryFile(projectRoot, next);
    return next;
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function writeGlossaryFile(
  projectRoot: string,
  glossary: ProjectGlossaryV1,
): Promise<void> {
  const target = projectGlossaryPath(projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(glossary, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertGlobalTermUniqueness(entries: GlossaryEntryV1[]): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    for (const candidate of [entry.term, ...entry.aliases]) {
      const key = termKey(candidate);
      if (keys.has(key)) {
        throw new Error(`MANCODE_GLOSSARY_TERM_CONFLICT: ${candidate}`);
      }
      keys.add(key);
    }
  }
}

function termKey(value: string): string {
  return value.trim().toLowerCase();
}

function parseGlossaryText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.length > maxLength
  ) {
    throw new Error(`${label} is invalid`);
  }
  assertSharedTextSafe(value, label);
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

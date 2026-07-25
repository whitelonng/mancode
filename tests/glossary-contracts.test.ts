import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextGlossary, contextSessionNew } from '../src/commands/context.js';
import { teamIdentityCreate } from '../src/commands/team.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { readV3CommandProject } from '../src/commands/v3-support.js';
import {
  addGlossaryEntry,
  emptyProjectGlossary,
  findGlossaryEntry,
  parseProjectGlossary,
  readProjectGlossary,
} from '../src/context/glossary.js';
import { createUlid } from '../src/context/ids.js';
import { resolveCoordinationEntityHomeStore } from '../src/runtime/entity-home-store.js';

const NOW = new Date('2026-07-17T11:00:00.000Z');

describe('project glossary entity contracts', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-glossary-entity-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a glossary and reads a missing file as the empty revision-0 glossary', async () => {
    const glossary = {
      schemaVersion: 1,
      revision: 3,
      entries: [
        {
          term: 'Task Aggregate',
          definition: 'The authoritative task state owned by the ledger.',
          aliases: ['task root'],
          sourceTaskRef: { namespace: 'shared', taskId: id(7) },
          confirmedAt: NOW.toISOString(),
        },
        {
          term: 'Context Pack',
          definition: 'The deterministic context payload handed to agents.',
          aliases: [],
          sourceTaskRef: null,
          confirmedAt: NOW.toISOString(),
        },
      ],
    };
    expect(parseProjectGlossary(JSON.parse(JSON.stringify(glossary)))).toEqual(
      glossary,
    );
    expect(await readProjectGlossary(root)).toEqual(emptyProjectGlossary());
    expect(emptyProjectGlossary()).toEqual({
      schemaVersion: 1,
      revision: 0,
      entries: [],
    });
  });

  it('rejects case-insensitive term and alias collisions across entries', () => {
    expect(() =>
      parseProjectGlossary({
        schemaVersion: 1,
        revision: 1,
        entries: [
          entryFixture('Task Aggregate', []),
          entryFixture('task aggregate', []),
        ],
      }),
    ).toThrow(/MANCODE_GLOSSARY_TERM_CONFLICT/);
    expect(() =>
      parseProjectGlossary({
        schemaVersion: 1,
        revision: 1,
        entries: [
          entryFixture('Task Aggregate', []),
          entryFixture('Ledger', ['TASK AGGREGATE']),
        ],
      }),
    ).toThrow(/MANCODE_GLOSSARY_TERM_CONFLICT/);
  });

  it('rejects local task references and unsafe shared text', () => {
    expect(() =>
      parseProjectGlossary({
        schemaVersion: 1,
        revision: 1,
        entries: [
          {
            ...entryFixture('Task Aggregate', []),
            sourceTaskRef: { namespace: 'local', taskId: id(7) },
          },
        ],
      }),
    ).toThrow(/MANCODE_GLOSSARY_LOCAL_TASK_FORBIDDEN/);
    expect(() =>
      parseProjectGlossary({
        schemaVersion: 1,
        revision: 1,
        entries: [
          {
            ...entryFixture('Task Aggregate', []),
            definition: 'Owned by alice@example.com since 2024.',
          },
        ],
      }),
    ).toThrow(/MANCODE_PRIVACY_BLOCKED/);
  });
});

describe('context glossary CLI contracts', () => {
  let root: string;

  beforeEach(async () => {
    vi.stubEnv('MANCODE_SESSION_ID', undefined);
    root = path.join(
      tmpdir(),
      `mancode-glossary-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('validates arguments, requires a session for mutations, and accepts revision 0 for the first add', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await contextGlossary(root, 'promote', { json: true })).toBe(2);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_GLOSSARY_ACTION_INVALID' },
      });

      expect(
        await contextGlossary(root, 'add', {
          definition: 'x',
          expectedRevision: '0',
          json: true,
        }),
      ).toBe(2);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_GLOSSARY_TERM_REQUIRED' },
      });

      expect(
        await contextGlossary(root, 'add', {
          term: 'Task Aggregate',
          definition: 'x',
          json: true,
        }),
      ).toBe(2);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_GLOSSARY_EXPECTED_REVISION_REQUIRED' },
      });

      expect(
        await contextGlossary(root, 'add', {
          term: 'Task Aggregate',
          expectedRevision: '0',
          json: true,
        }),
      ).toBe(2);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_GLOSSARY_DEFINITION_REQUIRED' },
      });

      expect(
        await contextGlossary(root, 'update', {
          term: 'Task Aggregate',
          expectedRevision: '1',
          json: true,
        }),
      ).toBe(2);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_GLOSSARY_UPDATE_EMPTY' },
      });

      expect(
        await contextGlossary(root, 'add', {
          term: 'Task Aggregate',
          definition: 'The authoritative task state.',
          expectedRevision: '0',
          client: 'fixture',
          json: true,
        }),
      ).toBe(3);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_SESSION_REQUIRED' },
      });

      const session = await openSession(root, logs);
      expect(
        await contextGlossary(root, 'add', {
          term: 'Task Aggregate',
          definition: 'The authoritative task state.',
          alias: ['task root'],
          expectedRevision: '0',
          session,
          client: 'fixture',
          json: true,
        }),
      ).toBe(0);
      expect(lastPayload(logs)).toMatchObject({
        schemaVersion: 1,
        glossary: {
          revision: 1,
          entries: [
            {
              term: 'Task Aggregate',
              aliases: ['task root'],
              sourceTaskRef: null,
            },
          ],
        },
      });

      expect(await contextGlossary(root, 'list', { json: true })).toBe(0);
      expect(lastPayload(logs)).toMatchObject({
        schemaVersion: 1,
        glossary: {
          revision: 1,
          entries: [{ term: 'Task Aggregate' }],
        },
      });
    } finally {
      logs.mockRestore();
    }
  });

  it('covers the update/remove lifecycle and rejects stale revision CAS writes', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const session = await openSession(root, logs);
      const base = {
        session,
        client: 'fixture',
        json: true,
      };
      expect(
        await contextGlossary(root, 'add', {
          ...base,
          term: 'Task Aggregate',
          definition: 'The authoritative task state.',
          expectedRevision: '0',
        }),
      ).toBe(0);

      expect(
        await contextGlossary(root, 'update', {
          ...base,
          term: 'task aggregate',
          alias: ['task root'],
          expectedRevision: '1',
        }),
      ).toBe(0);
      expect(lastPayload(logs)).toMatchObject({
        glossary: {
          revision: 2,
          entries: [{ term: 'Task Aggregate', aliases: ['task root'] }],
        },
      });

      expect(
        await contextGlossary(root, 'add', {
          ...base,
          term: 'Ledger',
          definition: 'Append-only decision record.',
          expectedRevision: '0',
        }),
      ).toBe(3);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_GLOSSARY_REVISION_CONFLICT' },
      });

      expect(
        await contextGlossary(root, 'add', {
          ...base,
          term: 'Task Root',
          definition: 'Duplicate of an existing alias.',
          expectedRevision: '2',
        }),
      ).toBe(3);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_GLOSSARY_TERM_EXISTS' },
      });

      expect(
        await contextGlossary(root, 'remove', {
          ...base,
          term: 'Missing Term',
          expectedRevision: '2',
        }),
      ).toBe(3);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_GLOSSARY_TERM_NOT_FOUND' },
      });

      expect(
        await contextGlossary(root, 'remove', {
          ...base,
          term: 'Task Aggregate',
          expectedRevision: '2',
        }),
      ).toBe(0);
      expect(lastPayload(logs)).toMatchObject({
        glossary: { revision: 3, entries: [] },
      });
    } finally {
      logs.mockRestore();
    }
  });

  it('blocks unsafe shared text through the CLI mutation path', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const session = await openSession(root, logs);
      expect(
        await contextGlossary(root, 'add', {
          term: 'Task Aggregate',
          definition: 'Contact alice@example.com for details.',
          expectedRevision: '0',
          session,
          client: 'fixture',
          json: true,
        }),
      ).toBe(3);
      expect(lastPayload(logs)).toMatchObject({
        error: { code: 'MANCODE_PRIVACY_BLOCKED' },
      });
      expect(await readProjectGlossary(root)).toEqual(emptyProjectGlossary());
    } finally {
      logs.mockRestore();
    }
  });

  it('never lets two interleaved writers silently overwrite each other', async () => {
    const project = await readV3CommandProject(root);
    const store = resolveCoordinationEntityHomeStore(
      project.runtime.entityHomeStoreContext,
    );

    // Sequential interleave: both writers observed revision 0; the second
    // commit must fail on the revision CAS instead of overwriting.
    await addGlossaryEntry(project.projectRoot, store, 0, {
      term: 'Writer B Term',
      definition: 'Committed first.',
    });
    await expect(
      addGlossaryEntry(project.projectRoot, store, 0, {
        term: 'Writer A Term',
        definition: 'Committed from a stale read.',
      }),
    ).rejects.toThrow(/MANCODE_GLOSSARY_REVISION_CONFLICT/);

    // Concurrent race: exactly one writer wins the lock+CAS; the loser gets
    // an explicit MANCODE_* error and the winning entry is never lost.
    const outcomes = await Promise.allSettled([
      addGlossaryEntry(project.projectRoot, store, 1, {
        term: 'Racer One',
        definition: 'Concurrent writer one.',
      }),
      addGlossaryEntry(project.projectRoot, store, 1, {
        term: 'Racer Two',
        definition: 'Concurrent writer two.',
      }),
    ]);
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /MANCODE_/,
    );

    const final = await readProjectGlossary(project.projectRoot);
    expect(final.revision).toBe(2);
    expect(final.entries).toHaveLength(2);
    expect(findGlossaryEntry(final, 'Writer B Term')).not.toBeNull();
    expect(findGlossaryEntry(final, 'Writer A Term')).toBeNull();
  });
});

async function openSession(
  root: string,
  logs: ReturnType<typeof vi.spyOn>,
): Promise<string> {
  expect(
    await teamIdentityCreate(root, { name: 'Fixture User', json: true }),
  ).toBe(0);
  expect(await contextSessionNew(root, { client: 'fixture', json: true })).toBe(
    0,
  );
  const payload = lastPayload(logs) as { session: { sessionId: string } };
  return payload.session.sessionId;
}

function lastPayload(logs: ReturnType<typeof vi.spyOn>): unknown {
  return JSON.parse(String(logs.mock.calls.at(-1)?.[0]));
}

function entryFixture(term: string, aliases: string[]) {
  return {
    term,
    definition: `Definition of ${term}.`,
    aliases,
    sourceTaskRef: null,
    confirmedAt: NOW.toISOString(),
  };
}

function id(offset: number): string {
  return createUlid(
    Date.parse('2026-07-17T00:00:00.000Z') + offset,
    new Uint8Array(10).fill(offset),
  );
}

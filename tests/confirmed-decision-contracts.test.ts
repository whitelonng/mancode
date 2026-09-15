import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import {
  confirmedDecisionDigest,
  createConfirmedDecision,
  createStructuredDecision,
  listConfirmedDecisions,
  parseConfirmedDecision,
  publishConfirmedDecision,
} from '../src/context/confirmed-decision.js';
import { projectDecisions } from '../src/context/decision-record.js';
import { ensureProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import { createAuthorizationBasis } from '../src/team/authorization.js';

const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const DECISION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('confirmed shared decision contract', () => {
  it('publishes one privacy-safe immutable entity and is idempotent by digest', async () => {
    const root = await temporaryRoot();
    const decision = fixture();
    const first = await publishConfirmedDecision(root, decision);
    const retried = await publishConfirmedDecision(root, decision);

    expect(retried).toEqual(first);
    expect(confirmedDecisionDigest(first)).toMatch(/^sha256:/);
    await expect(listConfirmedDecisions(root)).resolves.toEqual([first]);
  });

  it('gates V2 publication explicitly and preserves V1 immutable bytes across full replacement', async () => {
    const root = await temporaryRoot();
    await initializeV3Project({
      projectRoot: root,
      operationId: OPERATION_ID,
      workspaceId: ACTOR_ID,
      schemaEpoch: SESSION_ID,
    });
    const old = fixture();
    await publishConfirmedDecision(root, old);
    const structured = createStructuredDecision(
      { ...fixtureInput(), decisionId: '01JZ4B6W5Z0A1B2C3D4E5F6G7N' },
      {
        capability: 'decision-relations:1',
        recordKind: 'decision',
        rationale: 'Retain a bounded output.',
        alternatives: [],
        tradeoffs: [],
        revisitWhen: [],
        applicability: { modules: ['context'], paths: [] },
        clauses: [{ id: 'bounded', statement: 'Use bounded indexes.' }],
        relations: [
          {
            action: 'supersede',
            targetId: old.decisionId,
            targetDigest: confirmedDecisionDigest(old),
            clauses: 'all',
          },
        ],
      },
    );
    await expect(publishConfirmedDecision(root, structured)).rejects.toThrow(
      'MANCODE_DECISION_FORMAT_UPGRADE_REQUIRED',
    );
    await publishConfirmedDecision(root, structured, {
      confirmFormatUpgrade: true,
      writerCapabilities: ['decision-relations:1'],
    });
    expect(await listConfirmedDecisions(root)).toEqual([old, structured]);
    expect(parseConfirmedDecision(old)).toEqual(old);
    expect(parseConfirmedDecision(structured)).toEqual(structured);
    await expect(
      publishConfirmedDecision(root, structured, {
        confirmFormatUpgrade: true,
        writerCapabilities: ['decision-relations:1'],
      }),
    ).resolves.toEqual(structured);
  });

  it('detects conflicting successors after real Git clone exchange without rewriting shared authority', async () => {
    const root = await temporaryRoot();
    const git = (cwd: string, args: string[]) =>
      promisify(execFile)('git', args, { cwd });
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Fixture']);
    await git(root, ['config', 'user.email', 'fixture@example.test']);
    await initializeV3Project({
      projectRoot: root,
      operationId: OPERATION_ID,
      workspaceId: ACTOR_ID,
      schemaEpoch: SESSION_ID,
    });
    const old = fixture();
    await publishConfirmedDecision(root, old);
    await git(root, ['add', '-f', '.mancode/schema.json', '.mancode/shared']);
    await git(root, ['commit', '-m', 'Initial shared decisions']);
    const clone = await temporaryRoot();
    await git(root, ['clone', '--no-local', root, clone]);
    await git(clone, ['config', 'user.name', 'Fixture']);
    await git(clone, ['config', 'user.email', 'fixture@example.test']);
    await ensureProjectRuntimeContext(clone);
    const details = {
      capability: 'decision-relations:1',
      recordKind: 'decision',
      rationale: 'Bound context.',
      alternatives: [],
      tradeoffs: [],
      revisitWhen: [],
      applicability: { modules: ['context'], paths: [] },
      clauses: [{ id: 'bounded', statement: 'Use bounded indexes.' }],
      relations: [
        {
          action: 'supersede',
          targetId: old.decisionId,
          targetDigest: confirmedDecisionDigest(old),
          clauses: 'all',
        },
      ],
    };
    const options = {
      confirmFormatUpgrade: true,
      writerCapabilities: ['decision-relations:1'],
    };
    for (const [cwd, id] of [
      [root, '01JZ4B6W5Z0A1B2C3D4E5F6G7N'],
      [clone, '01JZ4B6W5Z0A1B2C3D4E5F6G7P'],
    ]) {
      await publishConfirmedDecision(
        cwd,
        createStructuredDecision(
          { ...fixtureInput(), decisionId: id },
          details,
        ),
        options,
      );
      await git(cwd, ['add', '-f', '.mancode/shared/memory/decisions']);
      await git(cwd, ['commit', '-m', 'Confirmed replacement']);
    }
    await git(root, ['fetch', clone, 'HEAD']);
    await git(root, ['merge', '--no-edit', 'FETCH_HEAD']);
    const merged = await listConfirmedDecisions(root);
    expect(merged).toHaveLength(3);
    expect(
      projectDecisions(merged).entries.map((entry) => entry.state),
    ).toEqual(['historical', 'conflict', 'conflict']);
  });

  it('refuses privacy-unsafe text, local task references, and conflicting IDs', async () => {
    expect(() =>
      createConfirmedDecision({ ...fixtureInput(), statement: 'token=secret' }),
    ).toThrow('MANCODE_PRIVACY_BLOCKED');
    expect(() =>
      createConfirmedDecision({
        ...fixtureInput(),
        taskRef: { namespace: 'local', taskId: DECISION_ID },
      }),
    ).toThrow('MANCODE_CONFIRMED_DECISION_LOCAL_TASK_FORBIDDEN');

    const root = await temporaryRoot();
    await publishConfirmedDecision(root, fixture());
    await expect(
      publishConfirmedDecision(
        root,
        createConfirmedDecision({
          ...fixtureInput(),
          statement: 'Choose a different shared policy.',
        }),
      ),
    ).rejects.toThrow('MANCODE_CONFIRMED_DECISION_ID_CONFLICT');
  });
});

function fixture() {
  return createConfirmedDecision(fixtureInput());
}

function fixtureInput() {
  const authorization = createAuthorizationBasis(
    {
      action: 'confirmed_decision_publish',
      actorId: ACTOR_ID,
      session: {
        sessionId: SESSION_ID,
        actorId: ACTOR_ID,
        status: 'active',
      },
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
    new Date('2026-07-17T10:00:00.000Z'),
  );
  return {
    decisionId: DECISION_ID,
    title: 'Keep the V3 context resolver authoritative',
    statement: 'Shared planning reads one stable Context Pack.',
    actorId: ACTOR_ID,
    operationId: OPERATION_ID,
    authorization,
    now: new Date('2026-07-17T10:00:00.000Z'),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'mancode-decision-contract-'),
  );
  roots.push(root);
  return root;
}

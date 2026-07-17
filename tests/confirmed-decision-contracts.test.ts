import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  confirmedDecisionDigest,
  createConfirmedDecision,
  listConfirmedDecisions,
  publishConfirmedDecision,
} from '../src/context/confirmed-decision.js';
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

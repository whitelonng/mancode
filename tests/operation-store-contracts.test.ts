import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveCoordinationEntityHomeStore,
  resolveTaskEntityHomeStore,
} from '../src/runtime/entity-home-store.js';
import {
  type OperationJournalV1,
  assertOperationReservationTopology,
  withOperationReservationDigests,
} from '../src/runtime/operation-journal.js';
import { readOperationReservation } from '../src/runtime/operation-reservation.js';
import {
  listUnfinishedOperationJournals,
  prepareOperationStores,
  readOperationJournal,
  updateOperationJournal,
} from '../src/runtime/operation-store.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const CHECKOUT_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7P';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('operation primary journal and secondary reservation stores', () => {
  it('persists a prepared primary journal before durable secondary reservations', async () => {
    const { primary, secondary } = await stores();
    const journal = preparedJournal(primary.storeId, secondary.storeId);
    const reservations = await prepareOperationStores({
      primaryStore: primary,
      journal,
      secondaryStores: [secondary],
      now: new Date('2026-07-17T10:00:00.000Z'),
    });
    expect(reservations).toHaveLength(1);
    await expect(readOperationJournal(primary, OPERATION_ID)).resolves.toEqual(
      journal,
    );
    await expect(
      readOperationReservation(secondary, OPERATION_ID),
    ).resolves.toMatchObject({
      operationId: OPERATION_ID,
      primaryStoreId: primary.storeId,
      entityKeys: [`task:shared:${TASK_ID}`],
    });

    const applying: OperationJournalV1 = {
      ...journal,
      state: 'applying',
      updatedAt: '2026-07-17T10:01:00.000Z',
    };
    await expect(
      updateOperationJournal(primary, applying, { canAbort: false }),
    ).resolves.toEqual(applying);
    await expect(listUnfinishedOperationJournals(primary)).resolves.toEqual([
      applying,
    ]);
  });

  it('requires each reservation to point to the stable prepared journal identity', async () => {
    const { primary, secondary } = await stores();
    const journal = preparedJournal(primary.storeId, secondary.storeId);
    expect(() => assertOperationReservationTopology(journal)).not.toThrow();
    expect(() =>
      assertOperationReservationTopology({
        ...journal,
        secondaryReservations: journal.secondaryReservations.map(
          (reservation) => ({
            ...reservation,
            journalDigest: `sha256:${'0'.repeat(64)}`,
          }),
        ),
      }),
    ).toThrow(/does not match the prepared journal identity/);
  });
});

async function stores() {
  const projectRoot = await temporaryRoot();
  const context = {
    projectRoot,
    workspaceId: WORKSPACE_ID,
    checkoutId: CHECKOUT_ID,
    gitCommonDir: null,
    repositoryBindingId: null,
  };
  return {
    primary: resolveTaskEntityHomeStore(context, {
      namespace: 'local',
      taskId: TASK_ID,
    }),
    secondary: resolveCoordinationEntityHomeStore(context),
  };
}

function preparedJournal(
  primaryStoreId: string,
  secondaryStoreId: string,
): OperationJournalV1 {
  return withOperationReservationDigests({
    schemaVersion: 1,
    operationId: OPERATION_ID,
    type: 'publish_promote',
    state: 'prepared',
    primaryStoreId,
    checkoutId: CHECKOUT_ID,
    secondaryReservations: [
      {
        storeId: secondaryStoreId,
        entityKeys: [`task:shared:${TASK_ID}`],
        journalDigest: `sha256:${'a'.repeat(64)}`,
      },
    ],
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    authorizationBasis: {
      schemaVersion: 1,
      action: 'shared_create_publish_promote',
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      trustBoundary: 'repo-collaborators',
      decisionDigest: `sha256:${'b'.repeat(64)}`,
      authorizedAt: '2026-07-17T10:00:00.000Z',
    },
    entityLocks: [`task:local:${TASK_ID}`, `task:shared:${TASK_ID}`],
    expectedRevisions: {
      [`task:local:${TASK_ID}`]: 1,
      [`task:shared:${TASK_ID}`]: 0,
    },
    steps: [
      { id: 'validate', state: 'pending' },
      { id: 'publish', state: 'pending' },
    ],
    startedAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'mancode-operation-store-'),
  );
  roots.push(root);
  return root;
}

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalActor,
  createSharedActorProfile,
  parseSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
  readSharedActorProfile,
} from '../src/team/actor.js';

const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('actor identity and public profile contracts', () => {
  it('creates one local actor identity without an implicitly shared email', async () => {
    const root = await temporaryRoot();
    const actor = await createLocalActor(root, {
      actorId: ACTOR_ID,
      displayName: 'Alice Example',
      now: new Date('2026-07-17T10:00:00.000Z'),
    });
    await expect(readLocalActor(root)).resolves.toEqual(actor);
    await expect(
      createLocalActor(root, { displayName: 'Another Alice' }),
    ).rejects.toThrow('MANCODE_LOCAL_ACTOR_EXISTS');
    expect(() =>
      parseSharedActorProfile({
        ...createSharedActorProfile(actor),
        email: 'a@example.com',
      }),
    ).toThrow(/unknown field/);
  });

  it('preflights and publishes the narrow public profile idempotently', async () => {
    const root = await temporaryRoot();
    const actor = await createLocalActor(root, {
      actorId: ACTOR_ID,
      displayName: 'Alice Example',
    });
    const profile = createSharedActorProfile(
      actor,
      new Date('2026-07-17T10:00:00.000Z'),
    );
    await expect(publishSharedActorProfile(root, profile)).resolves.toEqual(
      profile,
    );
    await expect(publishSharedActorProfile(root, profile)).resolves.toEqual(
      profile,
    );
    await expect(readSharedActorProfile(root, ACTOR_ID)).resolves.toEqual(
      profile,
    );
  });

  it('rejects sensitive display data before it reaches the shared profile', async () => {
    const root = await temporaryRoot();
    const actor = await createLocalActor(root, {
      actorId: ACTOR_ID,
      displayName: '/Users/alice/private',
    });
    expect(() => createSharedActorProfile(actor)).toThrow(
      'MANCODE_PRIVACY_BLOCKED',
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-actor-contract-'));
  roots.push(root);
  return root;
}

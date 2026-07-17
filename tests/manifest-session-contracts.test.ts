import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type SchemaManifestV1,
  assertSchemaManifestTransition,
  parseSchemaManifest,
} from '../src/context/manifest.js';
import { createSessionIdentityProvider } from '../src/runtime/session-identity.js';
import {
  attachSessionExecution,
  closeSession,
  createBootstrapSession,
  createSession,
  readSession,
  resolveSessionCandidate,
  resumeSession,
} from '../src/runtime/session.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const EXPLICIT_SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const OTHER_SESSION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('schema manifest contract', () => {
  it('keeps greenfield and legacy activation paths distinct', () => {
    const greenfield = parseSchemaManifest(
      manifest({
        activationState: 'initializing',
        legacyBaseline: null,
      }),
    );
    const legacy = parseSchemaManifest(
      manifest({
        activationState: 'dual_read',
        legacyBaseline: { stateDigest: DIGEST, workflowIndexDigest: DIGEST },
      }),
    );
    expect(greenfield.activationState).toBe('initializing');
    expect(legacy.activationState).toBe('dual_read');
    expect(() =>
      parseSchemaManifest(
        manifest({
          activationState: 'dual_read',
          legacyBaseline: null,
        }),
      ),
    ).toThrow(/require a legacy baseline/);
    expect(() =>
      parseSchemaManifest(
        manifest({
          activationState: 'initializing',
          legacyBaseline: { stateDigest: DIGEST, workflowIndexDigest: DIGEST },
        }),
      ),
    ).toThrow(/must not have a legacy baseline/);
  });

  it('only permits journal repair or the documented activation transitions', () => {
    const dualRead = parseSchemaManifest(
      manifest({
        activationState: 'dual_read',
        legacyBaseline: { stateDigest: DIGEST, workflowIndexDigest: DIGEST },
      }),
    );
    const activating = parseSchemaManifest(
      manifest({
        activationState: 'activating',
        legacyBaseline: { stateDigest: DIGEST, workflowIndexDigest: DIGEST },
      }),
    );
    const active = parseSchemaManifest(
      manifest({
        activationState: 'v3_active',
        legacyBaseline: { stateDigest: DIGEST, workflowIndexDigest: DIGEST },
        activatedAt: '2026-07-17T10:00:00.000Z',
      }),
    );
    expect(() =>
      assertSchemaManifestTransition(dualRead, activating),
    ).not.toThrow();
    expect(() =>
      assertSchemaManifestTransition(activating, active),
    ).not.toThrow();
    expect(() => assertSchemaManifestTransition(dualRead, active)).toThrow(
      /invalid schema manifest transition/,
    );
  });
});

describe('session identity contract', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-session-contract-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses explicit, then environment, then verified host identity without client fallbacks', () => {
    const provider = createSessionIdentityProvider(WORKSPACE_ID);
    const explicit = provider.resolveCandidate({
      explicitSessionId: EXPLICIT_SESSION_ID,
      environment: { MANCODE_SESSION_ID: OTHER_SESSION_ID },
      trustedHostInput: {
        externalSessionKey: 'window-a',
        propagatesToCommands: false,
      },
      client: 'codex',
    });
    expect(explicit).toMatchObject({
      internalSessionId: EXPLICIT_SESSION_ID,
      source: 'explicit',
    });
    const environment = provider.resolveCandidate({
      environment: { MANCODE_SESSION_ID: OTHER_SESSION_ID },
      trustedHostInput: {
        externalSessionKey: 'window-a',
        propagatesToCommands: false,
      },
      client: 'codex',
    });
    expect(environment).toMatchObject({
      internalSessionId: OTHER_SESSION_ID,
      source: 'env',
    });
    const noIdentity = provider.resolveCandidate({
      environment: {},
      client: 'codex',
    });
    expect(noIdentity).toBeNull();
    expect(() =>
      provider.resolveCandidate({
        environment: { MANCODE_SESSION_ID: 'codex' },
        client: 'codex',
      }),
    ).toThrow(/MANCODE_SESSION_ID/);
  });

  it('keeps two host windows separate and rejects closed or mismatched sessions', async () => {
    const provider = createSessionIdentityProvider(WORKSPACE_ID, {
      hostIdentityCapability: 'host_verified',
    });
    const firstCandidate = provider.resolveCandidate({
      environment: {},
      trustedHostInput: {
        externalSessionKey: 'window-a',
        propagatesToCommands: true,
      },
      client: 'codex',
    });
    const secondCandidate = provider.resolveCandidate({
      environment: {},
      trustedHostInput: {
        externalSessionKey: 'window-b',
        propagatesToCommands: true,
      },
      client: 'codex',
    });
    const first = await resolveSessionCandidate(root, firstCandidate, ACTOR_ID);
    const firstAgain = await resolveSessionCandidate(
      root,
      firstCandidate,
      ACTOR_ID,
    );
    const second = await resolveSessionCandidate(
      root,
      secondCandidate,
      ACTOR_ID,
    );
    expect(first?.sessionId).toBe(firstAgain?.sessionId);
    expect(first?.sessionId).not.toBe(second?.sessionId);

    const explicit = await createSession(root, {
      actorId: ACTOR_ID,
      client: 'codex',
      identitySource: 'env',
      sessionId: EXPLICIT_SESSION_ID,
    });
    await closeSession(root, explicit.sessionId);
    const closedCandidate = provider.resolveCandidate({
      environment: { MANCODE_SESSION_ID: explicit.sessionId },
      client: 'codex',
    });
    await expect(
      resolveSessionCandidate(root, closedCandidate),
    ).rejects.toThrow('MANCODE_SESSION_NOT_FOUND');
    const crossClient = provider.resolveCandidate({
      environment: { MANCODE_SESSION_ID: first?.sessionId },
      client: 'claude-code',
    });
    await expect(resolveSessionCandidate(root, crossClient)).rejects.toThrow(
      'MANCODE_SESSION_NOT_FOUND',
    );
  });

  it('only bootstraps explicitly and updates the resumed session without touching another window', async () => {
    const first = await createBootstrapSession(root, {
      actorId: ACTOR_ID,
      client: 'codex',
      now: new Date('2026-07-17T10:00:00.000Z'),
    });
    const second = await createSession(root, {
      actorId: ACTOR_ID,
      client: 'codex',
      identitySource: 'host',
      identityLookupKeyHash: DIGEST,
    });
    expect(first.environment.MANCODE_SESSION_ID).toBe(first.session.sessionId);
    expect(first.hint).toContain(first.session.sessionId);

    const resumed = await resumeSession(root, first.session.sessionId, {
      taskRef: { namespace: 'shared', taskId: WORKSPACE_ID },
      workflowMode: 'manteam',
      taskRevision: 7,
      now: new Date('2026-07-17T10:01:00.000Z'),
    });
    expect(resumed.activeTaskRef).toEqual({
      namespace: 'shared',
      taskId: WORKSPACE_ID,
    });
    await expect(readSession(root, second.sessionId)).resolves.toMatchObject({
      activeTaskRef: null,
    });
    await expect(
      attachSessionExecution(root, first.session.sessionId, OTHER_SESSION_ID),
    ).resolves.toMatchObject({ executionIds: [OTHER_SESSION_ID] });
  });

  it('does not overwrite a session while a same-session mutation lock is held', async () => {
    const session = await createSession(root, {
      actorId: ACTOR_ID,
      client: 'codex',
      identitySource: 'explicit',
      sessionId: EXPLICIT_SESSION_ID,
    });
    await mkdir(
      path.join(
        root,
        '.mancode',
        'local',
        'sessions',
        `.${session.sessionId}.lock`,
      ),
    );
    await expect(
      resumeSession(root, session.sessionId, {
        taskRef: { namespace: 'shared', taskId: WORKSPACE_ID },
        workflowMode: 'manteam',
        taskRevision: 1,
      }),
    ).rejects.toThrow('MANCODE_SESSION_LOCK_HELD');
    await expect(readSession(root, session.sessionId)).resolves.toMatchObject({
      activeTaskRef: null,
    });
  });
});

function manifest(overrides: Partial<SchemaManifestV1>): SchemaManifestV1 {
  return {
    manifestVersion: 1,
    layoutVersion: 3,
    epoch: WORKSPACE_ID,
    activationState: 'initializing',
    minReaderVersion: '0.4.0',
    minWriterVersion: '0.4.0',
    activatedAt: null,
    legacyBaseline: null,
    managedAdapters: {
      'claude-code': '3',
      codex: '3',
      cursor: '3',
      copilot: '3',
      zcode: '3',
    },
    lastOperationId: null,
    ...overrides,
  };
}

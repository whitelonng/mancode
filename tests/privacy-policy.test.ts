import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privacyPolicyCommand } from '../src/commands/privacy-policy.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import { createV3Checkpoint } from '../src/context/checkpoint-create.js';
import { CURRENT_WRITER_CAPABILITIES } from '../src/context/compatibility.js';
import {
  createConfirmedDecision,
  publishConfirmedDecision,
} from '../src/context/confirmed-decision.js';
import {
  addGlossaryEntry,
  readProjectGlossary,
} from '../src/context/glossary.js';
import { createUlid } from '../src/context/ids.js';
import {
  assertSchemaManifestTransition,
  parseSchemaManifest,
} from '../src/context/manifest.js';
import { withSharedPrivacyWrite } from '../src/context/privacy-guard.js';
import {
  assertPrivacyValueAllowed,
  scanPrivacyActivation,
} from '../src/context/privacy-guard.js';
import { updatePrivacyPolicy } from '../src/context/privacy-policy-operation.js';
import * as privacyAuthority from '../src/context/privacy-policy.js';
import {
  PRIVACY_POLICY_FILE,
  createInitialPrivacyPolicy,
  parsePrivacyPolicyCandidate,
  readPrivacyPolicySnapshot,
  readPrivacyPolicyStatus,
} from '../src/context/privacy-policy.js';
import {
  dryRunProjectPolicyUpgrade,
  upgradeProjectPolicy,
} from '../src/context/project-policy-upgrade.js';
import { ContextResolver } from '../src/context/resolver.js';
import { V3ContextStore } from '../src/context/store.js';
import { taskRootPath } from '../src/context/task-locator.js';
import { createV3Workflow } from '../src/context/workflow-create.js';
import { updateV3Workflow } from '../src/context/workflow-update.js';
import { DEFAULT_RULE_IDS, RULESET_VERSION } from '../src/privacy/rules.js';
import {
  resolveLocalEntityHomeStore,
  resolveTaskEntityHomeStore,
} from '../src/runtime/entity-home-store.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { OPERATION_CRASH_FIXTURES } from '../src/runtime/operation-definition.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import { readOperationJournal } from '../src/runtime/operation-store.js';
import { readProjectRuntimeContext } from '../src/runtime/project-runtime.js';
import * as writeBarrier from '../src/runtime/project-write-barrier.js';
import { createSession, readSession } from '../src/runtime/session.js';
import {
  createSharedActorProfile,
  publishSharedActorProfile,
  readLocalActor,
  readSharedActorProfile,
} from '../src/team/actor.js';
import { createLocalActor } from '../src/team/actor.js';
import { createAuthorizationBasis } from '../src/team/authorization.js';
import { VERSION } from '../src/version.js';

const now = new Date('2026-09-11T10:00:00.000Z');
const candidate = (enabled: boolean) =>
  parsePrivacyPolicyCandidate({
    schemaVersion: 1,
    enabled,
    rulesetVersion: RULESET_VERSION,
    enabledRuleIds: [...DEFAULT_RULE_IDS],
  });

describe('shared privacy policy authority', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mancode-privacy-policy-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('initializes off by default and atomically binds opt-in policy without an actor', async () => {
    await initializeV3Project({ projectRoot: root, managedAdapters: {}, now });
    expect(await readPrivacyPolicyStatus(root)).toMatchObject({
      state: 'unconfigured',
      enabled: false,
      revision: 0,
    });
    const other = path.join(root, 'other');
    await mkdir(other);
    await initializeV3Project({
      projectRoot: other,
      managedAdapters: {},
      sharedPrivacy: true,
      now,
    });
    const snapshot = await readPrivacyPolicySnapshot(other);
    expect(snapshot?.policy.enabled).toBe(true);
    const manifest = parseSchemaManifest(
      JSON.parse(
        await readFile(path.join(other, '.mancode/schema.json'), 'utf8'),
      ),
    );
    expect(manifest).toMatchObject({
      manifestVersion: 3,
      privacyPolicy: { revision: 1, digest: snapshot?.digest },
      minReaderVersion: VERSION,
      minWriterVersion: VERSION,
    });
    await expect(
      readFile(path.join(other, '.mancode/local/actor.json')),
    ).rejects.toThrow();
  });

  it('enables, disables, and reapplies idempotently without lowering compatibility', async () => {
    const sessionId = await bootstrap(root);
    expect(
      await updatePrivacyPolicy({
        projectRoot: root,
        candidate: candidate(true),
        expectedRevision: 0,
        sessionId,
        now,
      }),
    ).toMatchObject({
      state: 'committed',
      snapshot: { policy: { revision: 1, enabled: true } },
    });
    expect(
      await updatePrivacyPolicy({
        projectRoot: root,
        candidate: candidate(true),
        expectedRevision: 1,
        sessionId,
        now,
      }),
    ).toMatchObject({ state: 'unchanged' });
    await updatePrivacyPolicy({
      projectRoot: root,
      candidate: candidate(false),
      expectedRevision: 1,
      sessionId,
      now,
    });
    expect(
      await updatePrivacyPolicy({
        projectRoot: root,
        candidate: candidate(false),
        expectedRevision: 2,
        sessionId,
        now,
      }),
    ).toMatchObject({ state: 'unchanged' });
    expect(await readPrivacyPolicyStatus(root)).toMatchObject({
      state: 'disabled',
      enabled: false,
      revision: 2,
    });
    expect(
      JSON.parse(
        await readFile(path.join(root, '.mancode/schema.json'), 'utf8'),
      ),
    ).toMatchObject({ manifestVersion: 3, minWriterVersion: VERSION });
    await expect(
      updatePrivacyPolicy({
        projectRoot: root,
        candidate: candidate(true),
        expectedRevision: 1,
        sessionId,
        now,
      }),
    ).rejects.toThrow('MANCODE_EXPECTED_REVISION_CONFLICT');
  });

  it.each([1, 2])(
    'keeps an unconfigured manifest %s byte-identical when applying a disabled policy',
    async (manifestVersion) => {
      const sessionId = await bootstrap(root);
      const manifestPath = path.join(root, '.mancode/schema.json');
      if (manifestVersion === 1) {
        const { workflowPolicyDefaults: _defaults, ...legacy } = JSON.parse(
          await readFile(manifestPath, 'utf8'),
        );
        await writeFile(
          manifestPath,
          JSON.stringify({ ...legacy, manifestVersion }),
        );
      }
      const before = await readFile(manifestPath, 'utf8');
      const operationId = createUlid();
      expect(
        await updatePrivacyPolicy({
          projectRoot: root,
          candidate: candidate(false),
          expectedRevision: 0,
          sessionId,
          operationId,
          now,
        }),
      ).toEqual({ state: 'unchanged', operationId: null, snapshot: null });
      expect(await readFile(manifestPath, 'utf8')).toBe(before);
      expect(await readPrivacyPolicySnapshot(root)).toBeNull();
      const runtime = await readProjectRuntimeContext(root);
      const local = resolveLocalEntityHomeStore(runtime.entityHomeStoreContext);
      expect(await readOperationJournal(local, operationId)).toBeNull();
      await expect(
        readFile(path.join(root, '.mancode', PRIVACY_POLICY_FILE)),
      ).rejects.toThrow();
    },
  );

  it('disables an unconfigured project without requiring an actor or session', async () => {
    await initializeV3Project({ projectRoot: root, managedAdapters: {}, now });
    const print = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await privacyPolicyCommand(root, { json: true }, false)).toBe(0);
    expect(JSON.parse(String(print.mock.calls.at(-1)?.[0]))).toMatchObject({
      state: 'unchanged',
      enabled: false,
      revision: 0,
    });
    expect(await readLocalActor(root)).toBeNull();
    expect(await readPrivacyPolicySnapshot(root)).toBeNull();
  });

  it('requires the dedicated operation to change a privacy manifest reference', async () => {
    await initializeV3Project({
      projectRoot: root,
      managedAdapters: {},
      sharedPrivacy: true,
      now,
    });
    const previous = (await new V3ContextStore(root).readProjectSnapshot())
      .manifest;
    if (previous.manifestVersion !== 3)
      throw new Error('missing privacy manifest');
    expect(() =>
      assertSchemaManifestTransition(previous, {
        ...previous,
        privacyPolicy: { ...previous.privacyPolicy, revision: 2 },
      }),
    ).toThrow('MANCODE_PRIVACY_MANIFEST_TRANSITION_REQUIRED');
    expect(() =>
      assertSchemaManifestTransition(previous, {
        ...previous,
        lastOperationId: createUlid(),
      }),
    ).not.toThrow();
    expect(() =>
      parseSchemaManifest({ ...previous, manifestVersion: 4 }),
    ).toThrow('supported=1,2,3');
  });

  it('preserves privacy when upgrading a historical planning policy after activation', async () => {
    const sessionId = await bootstrap(root);
    const schemaPath = path.join(root, '.mancode/schema.json');
    const original = JSON.parse(await readFile(schemaPath, 'utf8'));
    const { workflowPolicyDefaults: _defaults, ...legacy } = original;
    await writeFile(
      schemaPath,
      JSON.stringify({ ...legacy, manifestVersion: 1 }),
    );
    await updatePrivacyPolicy({
      projectRoot: root,
      candidate: candidate(true),
      expectedRevision: 0,
      sessionId,
      now,
    });
    const before = await readPrivacyPolicySnapshot(root);
    expect(
      (await new V3ContextStore(root).readProjectSnapshot()).manifest,
    ).toMatchObject({
      manifestVersion: 3,
      workflowPolicyDefaults: { planning: 1 },
    });
    const preview = await dryRunProjectPolicyUpgrade({
      projectRoot: root,
      now,
    });
    expect(preview.willUpgrade).toBe(true);
    expect(
      await upgradeProjectPolicy({
        projectRoot: root,
        sessionId,
        operationId: preview.operationId,
        now,
      }),
    ).toMatchObject({
      state: 'committed',
      manifest: { manifestVersion: 3, workflowPolicyDefaults: { planning: 2 } },
    });
    expect(await readPrivacyPolicySnapshot(root)).toEqual(before);
    expect(
      await upgradeProjectPolicy({
        projectRoot: root,
        sessionId,
        operationId: preview.operationId,
        now,
      }),
    ).toMatchObject({ state: 'already_upgraded' });
  });

  it('rejects a snapshot when activation changes the manifest during content reads', async () => {
    await bootstrap(root);
    const file = path.join(root, '.mancode/schema.json');
    const originalRead = privacyAuthority.readPrivacyPolicySnapshot;
    vi.spyOn(
      privacyAuthority,
      'readPrivacyPolicySnapshot',
    ).mockImplementationOnce(async (...args) => {
      const result = await originalRead(...args);
      const previous = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(
        file,
        JSON.stringify({ ...previous, lastOperationId: createUlid() }),
      );
      return result;
    });
    await expect(
      new V3ContextStore(root).readProjectSnapshot(),
    ).rejects.toThrow('MANCODE_PROJECT_SNAPSHOT_CHANGED');
  });

  it('rejects hand-edited authority rather than silently treating it as disabled', async () => {
    await initializeV3Project({
      projectRoot: root,
      managedAdapters: {},
      sharedPrivacy: true,
      now,
    });
    const file = path.join(root, '.mancode', PRIVACY_POLICY_FILE);
    const policy = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...policy, enabled: false }));
    await expect(readPrivacyPolicySnapshot(root)).rejects.toThrow(
      'MANCODE_PRIVACY_POLICY_DIGEST_MISMATCH',
    );
    expect(await readPrivacyPolicyStatus(root)).toMatchObject({
      state: 'error',
      enabled: null,
    });
  });

  it('classifies immutable history for separate exclusions and blocks mutable sensitive files', async () => {
    await initializeV3Project({ projectRoot: root, managedAdapters: {}, now });
    const decisionPath = `shared/memory/decisions/${createUlid()}.json`;
    const immutable = { statement: 'Contact 13812345678' };
    await writeFile(
      path.join(root, '.mancode', decisionPath),
      JSON.stringify(immutable),
    );
    const scan = await scanPrivacyActivation(root, DEFAULT_RULE_IDS);
    expect(scan.exclusions).toContainEqual({
      kind: 'confirmed_decision',
      relativePath: decisionPath,
      entityDigest: digestCanonicalJson(immutable),
    });
    expect(scan.blockers).toEqual([]);
    await writeFile(
      path.join(root, '.mancode/shared/context/extra.json'),
      JSON.stringify(immutable),
    );
    expect(
      (await scanPrivacyActivation(root, DEFAULT_RULE_IDS)).blockers,
    ).toHaveLength(1);
  });

  it('rejects unknown rules, empty enabled policy, and new sensitive content', () => {
    expect(() =>
      parsePrivacyPolicyCandidate({
        ...candidate(true),
        enabledRuleIds: ['unknown'],
      }),
    ).toThrow('MANCODE_PRIVACY_RULE_UNSUPPORTED');
    expect(() =>
      parsePrivacyPolicyCandidate({ ...candidate(true), enabledRuleIds: [] }),
    ).toThrow('MANCODE_PRIVACY_EMPTY_RULESET');
    const snapshot = createInitialPrivacyPolicy({
      workspaceId: createUlid(),
      operationId: createUlid(),
      now: now.toISOString(),
    });
    expect(() =>
      assertPrivacyValueAllowed(snapshot, { text: '13812345678' }),
    ).toThrow('MANCODE_PRIVACY_BLOCKED');
    expect(() =>
      assertPrivacyValueAllowed(snapshot, { text: 'ordinary task' }),
    ).not.toThrow();
    for (const value of [
      { password: 'review-only-value' },
      JSON.parse('{"pass\\u0077ord":"review-only-value"}'),
      { nested: [{ password: 'quoted"value\\suffix' }] },
      { password: ['review-only-value'] },
      { client_password: 'synthetic multiple words' },
      { DB_PASSWORD: 'synthetic value' },
      { nested: [{ client_password: 'quote"slash\\value with words' }] },
      'configuration: {"client_password":"synthetic multiple words"}',
    ])
      expect(() => assertPrivacyValueAllowed(snapshot, value)).toThrow(
        'MANCODE_PRIVACY_BLOCKED',
      );
    expect(() =>
      assertPrivacyValueAllowed(snapshot, { password: '' }),
    ).not.toThrow();
  });

  it('repairs or aborts every policy journal crash point without an enabled half-state', async () => {
    for (const fixture of OPERATION_CRASH_FIXTURES.privacy_policy_update) {
      const child = path.join(root, fixture.crashAfter);
      await mkdir(child);
      const sessionId = await bootstrap(child);
      const actor = JSON.parse(
        await readFile(path.join(child, '.mancode/local/actor.json'), 'utf8'),
      );
      const operationId = createUlid();
      await expect(
        withOperationCrashInjectionForTesting(
          {
            operationType: 'privacy_policy_update',
            crashAfter: fixture.crashAfter,
          },
          () =>
            updatePrivacyPolicy({
              projectRoot: child,
              candidate: candidate(true),
              expectedRevision: 0,
              sessionId,
              operationId,
              now,
            }),
        ),
      ).rejects.toThrow();
      const recovered = await executeOperationRecovery({
        projectRoot: child,
        operationId,
        actorId: actor.actorId,
        sessionId,
        now,
      });
      expect(['committed', 'aborted']).toContain(recovered.journal.state);
      const status = await readPrivacyPolicyStatus(child);
      expect(status.state).toBe(
        recovered.journal.state === 'committed' ? 'enabled' : 'unconfigured',
      );
    }
  });

  it('repairs durable write intents even when their target file was never written', async () => {
    for (const step of ['write-exclusions', 'write-policy', 'write-manifest']) {
      const child = path.join(root, `${step}-intent`);
      await mkdir(child);
      const sessionId = await bootstrap(child);
      const actor = await readLocalActor(child);
      if (actor === null) throw new Error('missing actor');
      const operationId = createUlid();
      await expect(
        withOperationCrashInjectionForTesting(
          {
            operationType: 'privacy_policy_update',
            crashAfter: `${step}:intent`,
          },
          () =>
            updatePrivacyPolicy({
              projectRoot: child,
              candidate: candidate(true),
              expectedRevision: 0,
              sessionId,
              operationId,
              now,
            }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
      if (step !== 'write-exclusions')
        expect(await readPrivacyPolicyStatus(child)).toMatchObject({
          state: 'error',
          enabled: null,
        });
      const result = await executeOperationRecovery({
        projectRoot: child,
        operationId,
        actorId: actor.actorId,
        sessionId,
        now,
      });
      expect(result.journal.state).toBe(
        step === 'write-exclusions' ? 'aborted' : 'committed',
      );
      expect((await readPrivacyPolicyStatus(child)).state).toBe(
        step === 'write-exclusions' ? 'unconfigured' : 'enabled',
      );
    }
  });

  it('rejects reuse of an operation ID with different intent or revision', async () => {
    const sessionId = await bootstrap(root);
    const operationId = createUlid();
    await updatePrivacyPolicy({
      projectRoot: root,
      candidate: candidate(true),
      expectedRevision: 0,
      sessionId,
      operationId,
      now,
    });
    await expect(
      updatePrivacyPolicy({
        projectRoot: root,
        candidate: candidate(false),
        expectedRevision: 0,
        sessionId,
        operationId,
        now,
      }),
    ).rejects.toThrow('MANCODE_OPERATION_JOURNAL_CONFLICT');
    await expect(
      updatePrivacyPolicy({
        projectRoot: root,
        candidate: candidate(true),
        expectedRevision: 1,
        sessionId,
        operationId,
        now,
      }),
    ).rejects.toThrow('MANCODE_OPERATION_JOURNAL_CONFLICT');
  });

  it('rejects a foreign workspace policy even when both internal digests match', async () => {
    await initializeV3Project({
      projectRoot: root,
      managedAdapters: {},
      sharedPrivacy: true,
      now,
    });
    const foreign = createInitialPrivacyPolicy({
      workspaceId: createUlid(),
      operationId: createUlid(),
      now: now.toISOString(),
    });
    await writeFile(
      path.join(root, '.mancode/shared/context/privacy-policy.json'),
      JSON.stringify(foreign.policy),
    );
    await writeFile(
      path.join(root, '.mancode/shared/context/privacy-exclusions.json'),
      JSON.stringify(foreign.exclusions),
    );
    const schemaPath = path.join(root, '.mancode/schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    await writeFile(
      schemaPath,
      JSON.stringify({
        ...schema,
        privacyPolicy: { revision: 1, digest: foreign.digest },
      }),
    );
    await expect(readPrivacyPolicySnapshot(root)).rejects.toThrow(
      'MANCODE_PRIVACY_POLICY_WORKSPACE_MISMATCH',
    );
  });

  it('blocks shared create/update/checkpoint before a business journal is prepared', async () => {
    const sessionId = await bootstrapShared(root);
    await updatePrivacyPolicy({
      projectRoot: root,
      candidate: candidate(true),
      expectedRevision: 0,
      sessionId,
      now,
    });
    const rejectedTaskId = createUlid();
    const rejectedOperationId = createUlid();
    await expect(
      createV3Workflow({
        projectRoot: root,
        task: 'Call 13812345678',
        workflowMode: 'manteam',
        sessionId,
        client: 'vitest',
        sharedPrivacyConfirmed: true,
        taskId: rejectedTaskId,
        operationId: rejectedOperationId,
        now,
      }),
    ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
    await expect(
      readFile(
        path.join(
          taskRootPath(root, { namespace: 'shared', taskId: rejectedTaskId }),
          'metadata.json',
        ),
      ),
    ).rejects.toThrow();
    const task = await createV3Workflow({
      projectRoot: root,
      task: 'Review the shared changes',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      now,
    });
    const updateOperationId = createUlid();
    await expect(
      updateV3Workflow({
        projectRoot: root,
        taskRef: task.taskRef,
        sessionId,
        expectedTaskRevision: 1,
        status: 'blocked',
        blockingReason: 'Call 13812345678',
        operationId: updateOperationId,
        now,
      }),
    ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
    await expect(
      createV3Checkpoint({
        projectRoot: root,
        taskRef: task.taskRef,
        sessionId,
        expectedTaskRevision: 1,
        kind: 'diagnostic_started',
        summary: 'Call 13812345678',
        now,
      }),
    ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
    const runtime = await readProjectRuntimeContext(root);
    const home = resolveTaskEntityHomeStore(
      runtime.entityHomeStoreContext,
      task.taskRef,
    );
    expect(await readOperationJournal(home, updateOperationId)).toBeNull();
    expect(
      (await new V3ContextStore(root).readTaskSnapshot(task.taskRef)).metadata
        .revision,
    ).toBe(1);
  });

  it('rejects prefixed credentials through shared workflow creation before writing task or journal', async () => {
    const sessionId = await bootstrapShared(root);
    await updatePrivacyPolicy({
      projectRoot: root,
      candidate: candidate(true),
      expectedRevision: 0,
      sessionId,
      now,
    });
    const authority = await readPrivacyPolicySnapshot(root);
    const runtime = await readProjectRuntimeContext(root);
    for (const task of [
      'Use client_password=synthetic-value for the fixture',
      'Use DB_PASSWORD="synthetic alpha omega" for the fixture',
      'Configuration: {"client_password":"synthetic phrase words"}',
    ]) {
      const taskRef = { namespace: 'shared' as const, taskId: createUlid() };
      const operationId = createUlid();
      await expect(
        createV3Workflow({
          projectRoot: root,
          task,
          workflowMode: 'manteam',
          sessionId,
          client: 'vitest',
          sharedPrivacyConfirmed: true,
          taskId: taskRef.taskId,
          operationId,
          now,
        }),
      ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
      await expect(
        readFile(path.join(taskRootPath(root, taskRef), 'metadata.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const home = resolveTaskEntityHomeStore(
        runtime.entityHomeStoreContext,
        taskRef,
      );
      expect(await readOperationJournal(home, operationId)).toBeNull();
    }
    expect(await readPrivacyPolicySnapshot(root)).toEqual(authority);
  });

  it('activates by excluding immutable decisions and checkpoints without rewriting their bytes', async () => {
    const sessionId = await bootstrapShared(root);
    const actor = await readLocalActor(root);
    if (actor === null) throw new Error('missing actor');
    const authorization = createAuthorizationBasis(
      {
        action: 'confirmed_decision_publish',
        actorId: actor.actorId,
        session: { sessionId, actorId: actor.actorId, status: 'active' },
        joined: true,
        sharedWriteGuard: 'enforced',
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
      now,
    );
    const decision = createConfirmedDecision({
      decisionId: createUlid(),
      title: 'Contact reference',
      statement: 'Call 13812345678',
      actorId: actor.actorId,
      operationId: createUlid(),
      authorization,
      now,
    });
    await publishConfirmedDecision(root, decision);
    const task = await createV3Workflow({
      projectRoot: root,
      task: 'Review a shared checkpoint',
      workflowMode: 'manteam',
      sessionId,
      client: 'vitest',
      sharedPrivacyConfirmed: true,
      now,
    });
    const checkpoint = await createV3Checkpoint({
      projectRoot: root,
      taskRef: task.taskRef,
      sessionId,
      expectedTaskRevision: 1,
      kind: 'diagnostic_started',
      summary: 'Call 13812345678',
      now,
    });
    const decisionPath = path.join(
      root,
      '.mancode/shared/memory/decisions',
      `${decision.decisionId}.json`,
    );
    const checkpointPath = path.join(
      taskRootPath(root, task.taskRef),
      'checkpoints',
      `${checkpoint.checkpoint.checkpointId}.json`,
    );
    const before = await Promise.all([
      readFile(decisionPath, 'utf8'),
      readFile(checkpointPath, 'utf8'),
    ]);
    await updatePrivacyPolicy({
      projectRoot: root,
      candidate: candidate(true),
      expectedRevision: 0,
      sessionId,
      now,
    });
    const snapshot = await readPrivacyPolicySnapshot(root);
    expect(snapshot?.exclusions.entries).toHaveLength(2);
    expect(
      await Promise.all([
        readFile(decisionPath, 'utf8'),
        readFile(checkpointPath, 'utf8'),
      ]),
    ).toEqual(before);
    expect(() => assertPrivacyValueAllowed(snapshot, decision)).toThrow(
      'MANCODE_PRIVACY_ENTITY_EXCLUDED',
    );
    const runtime = await readProjectRuntimeContext(root);
    const project = await new V3ContextStore(root).readProjectSnapshot();
    const codeHead = (
      await promisify(execFileCallback)('git', ['rev-parse', 'HEAD'], {
        cwd: root,
      })
    ).stdout.trim();
    const resolver = new ContextResolver({
      projectRoot: root,
      entityHomeStoreContext: runtime.entityHomeStoreContext,
    });
    for (const purpose of ['orient', 'implement', 'handoff'] as const) {
      const result = await resolver.resolve({
        session: await readSession(root, sessionId),
        taskRef: task.taskRef,
        level: 'task',
        purpose,
        codeHead,
        compatibility: {
          expectedSchemaEpoch: project.manifest.epoch,
          readerVersion: VERSION,
          writerVersion: VERSION,
          writerCapabilities: CURRENT_WRITER_CAPABILITIES,
          adapterVersions: {},
        },
        generatedAt: now,
      });
      expect(result.repair).toBeNull();
      expect(JSON.stringify(result.pack)).not.toContain('13812345678');
      expect(JSON.stringify(result.pack.provenance)).not.toContain(
        decision.decisionId,
      );
      if (purpose !== 'orient')
        expect(result.pack.omissions).toContainEqual(
          expect.objectContaining({
            reason: 'privacy',
            targetJsonPointer: '/latestCheckpoint',
          }),
        );
    }
    const next = await createV3Checkpoint({
      projectRoot: root,
      taskRef: task.taskRef,
      sessionId,
      expectedTaskRevision: checkpoint.metadata.revision,
      kind: 'diagnostic_started',
      summary: 'Continue with a reviewed safe reference',
      now,
    });
    expect(next.checkpoint.checkpointId).not.toBe(
      checkpoint.checkpoint.checkpointId,
    );
    await updatePrivacyPolicy({
      projectRoot: root,
      candidate: candidate(false),
      expectedRevision: 1,
      sessionId,
      now,
    });
    expect(
      (await readPrivacyPolicySnapshot(root))?.exclusions.entries,
    ).toHaveLength(2);
  });

  it('serializes concurrent independent actor profiles through the privacy barrier', async () => {
    const sessionId = await bootstrap(root);
    await updatePrivacyPolicy({
      projectRoot: root,
      candidate: candidate(true),
      expectedRevision: 0,
      sessionId,
      now,
    });
    const actor = await readLocalActor(root);
    if (actor === null) throw new Error('missing actor');
    const first = createSharedActorProfile(actor, now);
    const second = {
      ...first,
      actorId: createUlid(),
      displayName: 'Second actor',
    };
    expect(
      await Promise.all([
        publishSharedActorProfile(root, first),
        publishSharedActorProfile(root, second),
      ]),
    ).toEqual([first, second]);
    expect(
      await Promise.all([
        readSharedActorProfile(root, first.actorId),
        readSharedActorProfile(root, second.actorId),
      ]),
    ).toEqual([first, second]);
  });

  it('preserves entity CAS conflicts after waiting for the shared barrier', async () => {
    await bootstrap(root);
    const runtime = await readProjectRuntimeContext(root);
    const store = resolveLocalEntityHomeStore(runtime.entityHomeStoreContext);
    const outcomes = await Promise.allSettled(
      ['Alpha', 'Beta'].map((term) =>
        addGlossaryEntry(root, store, 0, {
          term,
          definition: 'A reviewed term',
          now,
        }),
      ),
    );
    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = outcomes.find((result) => result.status === 'rejected');
    expect(
      rejection?.status === 'rejected' ? rejection.reason.message : null,
    ).toContain('MANCODE_GLOSSARY_REVISION_CONFLICT');
    expect(await readProjectGlossary(root)).toMatchObject({
      revision: 1,
      entries: [expect.any(Object)],
    });
  });

  it('rechecks policy after a contended writer waits across activation', async () => {
    const sessionId = await bootstrap(root);
    let releaseHolder!: () => void;
    let reachedHolder!: () => void;
    let reachedContention!: () => void;
    let releaseRetry!: () => void;
    const holding = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      reachedHolder = resolve;
    });
    const contended = new Promise<void>((resolve) => {
      reachedContention = resolve;
    });
    const retryAllowed = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const holder = withSharedPrivacyWrite(
      root,
      createUlid(),
      { text: 'safe' },
      async () => {
        reachedHolder();
        await holding;
      },
    );
    await acquired;
    const operationId = createUlid();
    const originalAcquire = writeBarrier.acquireProjectWriteBarrier;
    let observedContention = false;
    vi.spyOn(writeBarrier, 'acquireProjectWriteBarrier').mockImplementation(
      async (...args) => {
        if (args[1] === operationId && observedContention) await retryAllowed;
        try {
          return await originalAcquire(...args);
        } catch (error) {
          if (
            args[1] === operationId &&
            error instanceof Error &&
            error.message === 'MANCODE_LOCK_HELD'
          ) {
            observedContention = true;
            reachedContention();
          }
          throw error;
        }
      },
    );
    let wrote = false;
    const waitingWrite = withSharedPrivacyWrite(
      root,
      operationId,
      { text: 'Call 13812345678' },
      async () => {
        wrote = true;
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await contended;
      releaseHolder();
      await holder;
      await updatePrivacyPolicy({
        projectRoot: root,
        candidate: candidate(true),
        expectedRevision: 0,
        sessionId,
        now,
      });
    } finally {
      releaseHolder();
      releaseRetry();
      await holder;
    }
    expect(await waitingWrite).toMatchObject({
      message: 'MANCODE_PRIVACY_BLOCKED',
    });
    expect(wrote).toBe(false);
  });

  it('holds the project barrier for an unjournaled shared write until it finishes', async () => {
    const sessionId = await bootstrap(root);
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const write = withSharedPrivacyWrite(
      root,
      createUlid(),
      { text: 'safe' },
      async () => {
        reached();
        await waiting;
      },
    );
    await acquired;
    try {
      await expect(
        updatePrivacyPolicy({
          projectRoot: root,
          candidate: candidate(true),
          expectedRevision: 0,
          sessionId,
          now,
        }),
      ).rejects.toThrow('MANCODE_LOCK_HELD');
    } finally {
      release();
      await write;
    }
    await expect(
      updatePrivacyPolicy({
        projectRoot: root,
        candidate: candidate(true),
        expectedRevision: 0,
        sessionId,
        now,
      }),
    ).resolves.toMatchObject({ state: 'committed' });
  });
});

async function bootstrap(root: string) {
  await initializeV3Project({ projectRoot: root, managedAdapters: {}, now });
  const actor = await createLocalActor(root, {
    displayName: 'Privacy Tester',
    now,
  });
  const session = await createSession(root, {
    actorId: actor.actorId,
    client: 'vitest',
    identitySource: 'explicit',
    now,
  });
  return session.sessionId;
}

async function bootstrapShared(root: string) {
  const execFile = promisify(execFileCallback);
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile(
    'git',
    [
      '-c',
      'user.name=Privacy Test',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
      '-q',
    ],
    { cwd: root },
  );
  const sessionId = await bootstrap(root);
  const actor = await readLocalActor(root);
  if (actor === null) throw new Error('missing actor');
  await publishSharedActorProfile(root, createSharedActorProfile(actor, now));
  return sessionId;
}

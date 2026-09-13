import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { privacyPolicyCommand } from '../src/commands/privacy-policy.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  previewPrivacyPolicyUpdate,
  updatePrivacyPolicy,
} from '../src/context/privacy-policy-operation.js';
import {
  PRIVACY_EXCLUSIONS_FILE,
  PRIVACY_POLICY_FILE,
  type PrivacyPolicySnapshot,
  createInitialPrivacyPolicy,
  parsePrivacyExclusions,
  parsePrivacyPolicy,
} from '../src/context/privacy-policy.js';
import { readPrivacyPolicySnapshot } from '../src/context/privacy-policy.js';
import { V3ContextStore } from '../src/context/store.js';
import { DEFAULT_RULE_IDS, RULESET_VERSION } from '../src/privacy/rules.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
} from '../src/team/actor.js';
import {
  readGitRefTeamCache,
  writeGitRefTeamCache,
} from '../src/team/git-ref-cache.js';
import { createGitRefTeamManifestStore } from '../src/team/git-ref-client.js';
import {
  GitRefTeamManifestStore,
  assertGitRefManifestPrivacyAllowed,
  parseGitRefTeamManifest,
} from '../src/team/git-ref-transport.js';
import { projectConfigDigest } from '../src/team/policy.js';
import {
  applyRemotePrivacyPolicyUpdate,
  inspectGitRefPrivacyActivation,
  inspectRemotePrivacyPolicyUpdate,
  parseGitRefPrivacyPolicyUpdate,
  prepareRemotePrivacyPolicyUpdate,
} from '../src/team/privacy-policy-transport.js';

import { VERSION } from '../src/version.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const now = new Date('2026-09-12T01:00:00.000Z');
const id = (n: number) => `01JZ4B6W5Z${String(n).padStart(16, '0')}`;
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('distributed privacy policy', () => {
  it('publishes one atomic policy snapshot before any local authority and fences stale clones', async () => {
    const f = await fixture();
    const target = createInitialPrivacyPolicy({
      workspaceId: id(1),
      operationId: id(10),
      now: now.toISOString(),
    });
    const before = await readFile(
      path.join(f.a.root, '.mancode/schema.json'),
      'utf8',
    );
    const update = await prepareRemotePrivacyPolicyUpdate(
      f.a.root,
      f.a.project,
      target,
      id(10),
      f.a.actorId,
    );
    expect(update).not.toBeNull();
    if (update === null) throw new Error('expected remote intent');
    expect(await inspectRemotePrivacyPolicyUpdate(f.a.root, update)).toBe(
      'before',
    );
    expect(JSON.stringify(update)).not.toContain(f.remote);
    await applyRemotePrivacyPolicyUpdate(f.a.root, update);
    await applyRemotePrivacyPolicyUpdate(f.a.root, update);
    expect(await inspectRemotePrivacyPolicyUpdate(f.a.root, update)).toBe(
      'target',
    );
    expect(
      await readFile(path.join(f.a.root, '.mancode/schema.json'), 'utf8'),
    ).toBe(before);
    const remote = await f.a.store.inspectPrivacyPolicyAuthority();
    expect(remote.manifest).toMatchObject({
      schemaVersion: 2,
      revision: 3,
      privacyPolicy: { digest: target.digest },
      minReaderVersion: VERSION,
      lastMutation: { kind: 'privacy_policy', operationId: id(10) },
    });
    await expect(f.b.store.pull()).rejects.toThrow(
      'MANCODE_TRANSPORT_PRIVACY_POLICY_MISMATCH',
    );
    const upgraded = boundStore(f.b, target);
    expect((await upgraded.pull()).manifest?.privacyPolicy?.digest).toBe(
      target.digest,
    );
    await expect(
      upgraded.publishActorProfile({
        operationId: id(11),
        expectedRemoteRevision: 3,
        profile: {
          schemaVersion: 1,
          actorId: id(15),
          displayName: '13812345678',
          joinedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      }),
    ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
    expect((await upgraded.pull()).manifest?.revision).toBe(3);
  });

  it('allows only one of two concurrent policy CAS operations to commit', async () => {
    const f = await fixture();
    const first = createInitialPrivacyPolicy({
      workspaceId: id(1),
      operationId: id(20),
      now: now.toISOString(),
    });
    const second = createInitialPrivacyPolicy({
      workspaceId: id(1),
      operationId: id(21),
      now: now.toISOString(),
    });
    const a = await prepareRemotePrivacyPolicyUpdate(
      f.a.root,
      f.a.project,
      first,
      id(20),
      f.a.actorId,
    );
    const b = await prepareRemotePrivacyPolicyUpdate(
      f.b.root,
      f.b.project,
      second,
      id(21),
      f.b.actorId,
    );
    if (a === null || b === null) throw new Error('expected intents');
    const results = await Promise.allSettled([
      applyRemotePrivacyPolicyUpdate(f.a.root, a),
      applyRemotePrivacyPolicyUpdate(f.b.root, b),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const states = await Promise.all([
      inspectRemotePrivacyPolicyUpdate(f.a.root, a),
      inspectRemotePrivacyPolicyUpdate(f.b.root, b),
    ]);
    expect(states.sort()).toEqual(['conflict', 'target']);
  });

  it('keeps schema and exclusions after disable, and rejects tampered snapshots', async () => {
    const f = await fixture();
    const enabled = createInitialPrivacyPolicy({
      workspaceId: id(1),
      operationId: id(30),
      now: now.toISOString(),
    });
    const first = await prepareRemotePrivacyPolicyUpdate(
      f.a.root,
      f.a.project,
      enabled,
      id(30),
      f.a.actorId,
    );
    if (first === null) throw new Error('expected intent');
    await applyRemotePrivacyPolicyUpdate(f.a.root, first);
    const disabled = nextPolicy(enabled, false, id(31));
    const client = boundStore(f.a, enabled);
    await client.updatePrivacyPolicy({
      operationId: id(31),
      actorId: f.a.actorId,
      expectedRemoteRevision: 3,
      beforePrivacyPolicy: { revision: 1, digest: enabled.digest },
      targetPrivacyPolicy: disabled,
    });
    const manifest = (await client.inspectPrivacyPolicyAuthority()).manifest;
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      minReaderVersion: VERSION,
      minWriterVersion: VERSION,
      privacyPolicy: { policy: { enabled: false, revision: 2 } },
    });
    expect(() =>
      parseGitRefTeamManifest({
        ...manifest,
        privacyPolicy: {
          ...disabled,
          policy: { ...disabled.policy, enabled: true },
        },
      }),
    ).toThrow('MANCODE_TRANSPORT_PRIVACY_DIGEST_MISMATCH');
    expect(() =>
      parseGitRefTeamManifest({ ...manifest, schemaVersion: 1 }),
    ).toThrow();
    expect(() =>
      parseGitRefTeamManifest({ ...manifest, minWriterVersion: '0.6.4' }),
    ).toThrow('MANCODE_TRANSPORT_PRIVACY_VERSION_REQUIRED');
    await expect(
      f.b.store.publishActorProfile({
        operationId: id(32),
        expectedRemoteRevision: 4,
        profile: {
          schemaVersion: 1,
          actorId: id(35),
          displayName: 'New Member',
          joinedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      }),
    ).rejects.toThrow('MANCODE_TRANSPORT_PRIVACY_POLICY_MISMATCH');
  });

  it('blocks activation on current remote sensitive data and fails closed on changed remote/config', async () => {
    const f = await fixture();
    await f.a.store.publishActorProfile({
      operationId: id(40),
      expectedRemoteRevision: 2,
      profile: {
        schemaVersion: 1,
        actorId: id(45),
        displayName: '13812345678',
        joinedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    });
    const target = createInitialPrivacyPolicy({
      workspaceId: id(1),
      operationId: id(41),
      now: now.toISOString(),
    });
    const before = await f.a.store.inspectPrivacyPolicyAuthority();
    const preview = await previewPrivacyPolicyUpdate({
      projectRoot: f.a.root,
      candidate: candidate(true),
      expectedRevision: 0,
    });
    expect(preview).toMatchObject({
      remote: {
        revision: 3,
        blockers: [
          {
            entityType: 'actor_profile',
            count: 1,
            reason: 'sensitive_content',
            remediation: 'retain_basic_or_new_workspace',
          },
        ],
      },
    });
    expect(JSON.stringify(preview)).not.toContain('13812345678');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(
        await privacyPolicyCommand(
          f.a.root,
          { dryRun: true, json: true },
          true,
        ),
      ).toBe(2);
      expect(JSON.stringify(log.mock.calls)).not.toContain('13812345678');
    } finally {
      log.mockRestore();
    }
    await expect(
      updatePrivacyPolicy({
        projectRoot: f.a.root,
        candidate: candidate(true),
        expectedRevision: 0,
        sessionId: f.a.sessionId,
        operationId: id(41),
        now,
      }),
    ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
    expect(await readPrivacyPolicySnapshot(f.a.root)).toBeNull();
    expect((await f.a.store.inspectPrivacyPolicyAuthority()).commit).toBe(
      before.commit,
    );
    await expect(
      prepareRemotePrivacyPolicyUpdate(
        f.a.root,
        f.a.project,
        target,
        id(41),
        f.a.actorId,
      ),
    ).rejects.toThrow('MANCODE_PRIVACY_BLOCKED');
    const clean = await fixture();
    const update = await prepareRemotePrivacyPolicyUpdate(
      clean.a.root,
      clean.a.project,
      target,
      id(41),
      clean.a.actorId,
    );
    if (update === null) throw new Error('expected intent');
    expect(() =>
      parseGitRefPrivacyPolicyUpdate({ ...update, operationId: id(99) }),
    ).toThrow('MANCODE_PRIVACY_REMOTE_INTENT_INVALID');
    await execFile(
      'git',
      ['remote', 'set-url', 'origin', path.join(clean.remote, 'different')],
      { cwd: clean.a.root },
    );
    await expect(
      inspectRemotePrivacyPolicyUpdate(clean.a.root, update),
    ).rejects.toThrow('MANCODE_PRIVACY_REMOTE_CONFIG_CHANGED');
  });

  it('completes enable, disable and re-enable across clones after receiving shared authority files', async () => {
    const f = await fixture();
    let previous = await f.b.store.pull();
    await writeGitRefTeamCache(f.b.root, f.b.project.config, previous);
    for (const [index, enabled] of [true, false, true].entries()) {
      const applied = await updatePrivacyPolicy({
        projectRoot: f.a.root,
        candidate: candidate(enabled),
        expectedRevision: index,
        sessionId: f.a.sessionId,
        operationId: id(80 + index),
        now,
      });
      expect(applied.state).toBe('committed');
      await expect(
        createGitRefTeamManifestStore(
          f.b.root,
          f.b.project.config,
          f.b.project.manifest,
        ).pull(),
      ).rejects.toThrow('MANCODE_TRANSPORT_PRIVACY_POLICY_MISMATCH');
      // Mirrors receipt of tracked project authority via the repository's normal checkout.
      for (const file of [
        'schema.json',
        PRIVACY_POLICY_FILE,
        PRIVACY_EXCLUSIONS_FILE,
      ]) {
        await writeFile(
          path.join(f.b.root, '.mancode', file),
          await readFile(path.join(f.a.root, '.mancode', file)),
        );
      }
      const local = await new V3ContextStore(f.b.root).readProjectSnapshot();
      expect(await readGitRefTeamCache(f.b.root, local.config)).toBeNull();
      await expect(
        writeGitRefTeamCache(f.b.root, local.config, previous),
      ).rejects.toThrow('MANCODE_TRANSPORT_PRIVACY_POLICY_MISMATCH');
      previous = await createGitRefTeamManifestStore(
        f.b.root,
        local.config,
        local.manifest,
      ).pull();
      const remote = previous.manifest;
      await writeGitRefTeamCache(f.b.root, local.config, previous);
      expect(
        (await readGitRefTeamCache(f.b.root, local.config))?.manifest
          ?.privacyPolicy?.digest,
      ).toBe(local.privacy?.digest);
      expect(remote?.privacyPolicy?.digest).toBe(local.privacy?.digest);
      expect(remote?.privacyPolicy?.policy).toMatchObject({
        enabled,
        revision: index + 1,
      });
      expect(local.manifest.manifestVersion).toBe(3);
    }
  });

  it('distinguishes immutable remote history from replaceable active checkpoints without raw content', async () => {
    const f = await fixture();
    const manifest = (await f.a.store.pull()).manifest;
    if (manifest === null) throw new Error('expected remote authority');
    const sensitive = { summary: '13812345678' };
    const result = inspectGitRefPrivacyActivation(
      {
        ...manifest,
        claims: [sensitive as never, sensitive as never],
        handoffs: [sensitive as never],
        taskBundles: [
          {
            codeRef: { branch: 'main' },
            artifacts: [
              { kind: 'checkpoint', content: sensitive },
              { kind: 'plan', content: sensitive },
            ],
          } as never,
        ],
      },
      candidate(true),
    );
    expect(result.blockers).toEqual([
      {
        entityType: 'claim',
        count: 2,
        reason: 'sensitive_content',
        remediation: 'retain_basic_or_new_workspace',
      },
      {
        entityType: 'handoff',
        count: 1,
        reason: 'sensitive_content',
        remediation: 'retain_basic_or_new_workspace',
      },
      {
        entityType: 'checkpoint',
        count: 1,
        reason: 'sensitive_content',
        remediation: 'replace_checkpoint_and_sync',
      },
      {
        entityType: 'task_artifact',
        count: 1,
        reason: 'sensitive_content',
        remediation: 'replace_safe_content_and_sync',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('13812345678');
  });

  it.each([
    'write-remote-policy:intent',
    'write-remote-policy',
    'write-exclusions:intent',
    'write-policy',
    'write-manifest',
    'commit',
  ])(
    'recovers the distributed journal at %s without a local-only policy',
    async (crashAfter) => {
      const f = await fixture();
      const operationId = id(70);
      await expect(
        withOperationCrashInjectionForTesting(
          { operationType: 'privacy_policy_update', crashAfter },
          () =>
            updatePrivacyPolicy({
              projectRoot: f.a.root,
              candidate: {
                schemaVersion: 1,
                enabled: true,
                rulesetVersion: RULESET_VERSION,
                enabledRuleIds: [...DEFAULT_RULE_IDS],
              },
              expectedRevision: 0,
              sessionId: f.a.sessionId,
              operationId,
              now,
            }),
        ),
      ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');
      const recovered = await executeOperationRecovery({
        projectRoot: f.a.root,
        operationId,
        actorId: f.a.actorId,
        sessionId: f.a.sessionId,
        now,
      });
      const local = await readPrivacyPolicySnapshot(f.a.root);
      const remote =
        (await f.a.store.inspectPrivacyPolicyAuthority()).manifest
          ?.privacyPolicy ?? null;
      expect(recovered.journal.state).toBe(
        crashAfter === 'write-remote-policy:intent' ? 'aborted' : 'committed',
      );
      expect(local?.digest ?? null).toBe(remote?.digest ?? null);
      if (local !== null) expect(local.policy.enabled).toBe(true);
    },
    15000,
  );

  it('refuses excluded checkpoint content even after enhanced rules are disabled', async () => {
    const f = await fixture();
    const checkpoint = { checkpointId: id(51), summary: 'historical data' };
    const initial = createInitialPrivacyPolicy({
      workspaceId: id(1),
      operationId: id(50),
      now: now.toISOString(),
      enabled: false,
    });
    const exclusions = parsePrivacyExclusions({
      ...initial.exclusions,
      entries: [
        {
          kind: 'checkpoint',
          relativePath: `shared/workflows/${id(52)}/checkpoints/${id(51)}.json`,
          entityDigest: digestCanonicalJson(checkpoint),
        },
      ],
    });
    const policy = parsePrivacyPolicy({
      ...initial.policy,
      exclusions: {
        revision: exclusions.revision,
        digest: digestCanonicalJson(exclusions),
      },
    });
    const snapshot = {
      policy,
      exclusions,
      digest: digestCanonicalJson(policy),
    };
    const manifest = (await f.a.store.pull()).manifest;
    if (manifest === null) throw new Error('expected remote authority');
    const bundle = {
      artifacts: [{ content: checkpoint }],
      codeRef: { branch: 'main', head: 'a'.repeat(40) },
    };
    expect(() =>
      assertGitRefManifestPrivacyAllowed(
        { ...manifest, taskBundles: [bundle as never] },
        snapshot,
      ),
    ).toThrow('MANCODE_PRIVACY_ENTITY_EXCLUDED');
  });
});

function candidate(enabled: boolean) {
  return {
    schemaVersion: 1 as const,
    enabled,
    rulesetVersion: RULESET_VERSION,
    enabledRuleIds: [...DEFAULT_RULE_IDS],
  };
}

function nextPolicy(
  old: PrivacyPolicySnapshot,
  enabled: boolean,
  operationId: string,
): PrivacyPolicySnapshot {
  const exclusions = parsePrivacyExclusions({
    ...old.exclusions,
    revision: old.exclusions.revision + 1,
    lastOperationId: operationId,
  });
  const policy = parsePrivacyPolicy({
    ...old.policy,
    revision: old.policy.revision + 1,
    enabled,
    lastOperationId: operationId,
    exclusions: {
      revision: exclusions.revision,
      digest: digestCanonicalJson(exclusions),
    },
  });
  return { policy, exclusions, digest: digestCanonicalJson(policy) };
}

function boundStore(
  client: {
    root: string;
    project: Awaited<ReturnType<V3ContextStore['readProjectSnapshot']>>;
  },
  privacy: PrivacyPolicySnapshot,
) {
  return new GitRefTeamManifestStore({
    projectRoot: client.root,
    remote: 'origin',
    workspaceId: id(1),
    schemaEpoch: id(2),
    transportEpoch: 2,
    configRevision: 2,
    configDigest: projectConfigDigest(client.project.config),
    privacyPolicyReference: {
      revision: privacy.policy.revision,
      digest: privacy.digest,
    },
  });
}

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'mancode-remote-privacy-'));
  roots.push(base);
  const remote = path.join(base, 'remote.git');
  await execFile('git', ['init', '--bare', remote]);
  const client = async (name: string, actorId: string) => {
    const root = path.join(base, name);
    await mkdir(root);
    await execFile('git', ['init', '-b', 'main'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'fixture@example.test'], {
      cwd: root,
    });
    await execFile('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    await execFile('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await initializeV3Project({
      projectRoot: root,
      operationId: id(7),
      workspaceId: id(1),
      schemaEpoch: id(2),
      now,
    });
    const configPath = path.join(root, '.mancode/shared/config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        revision: 2,
        transport: { mode: 'git-ref', remote: 'origin', epoch: 2 },
      }),
    );
    const actor = await createLocalActor(root, {
      actorId,
      displayName: name,
      now,
    });
    const sessionId = id(Number(actorId.slice(-3)) + 100);
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now,
    });
    const project = await new V3ContextStore(root).readProjectSnapshot();
    const store = createGitRefTeamManifestStore(
      root,
      project.config,
      project.manifest,
    );
    return { root, actorId, actor, sessionId, project, store };
  };
  const a = await client('Alice', id(3));
  const b = await client('Bob', id(4));
  await a.store.publishActorProfile({
    operationId: id(5),
    expectedRemoteRevision: 0,
    profile: createSharedActorProfile(a.actor, now),
  });
  await b.store.publishActorProfile({
    operationId: id(6),
    expectedRemoteRevision: 1,
    profile: createSharedActorProfile(b.actor, now),
  });
  return { a, b, remote };
}

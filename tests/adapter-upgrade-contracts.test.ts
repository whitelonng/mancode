import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { V3ContextStore } from '../src/context/store.js';
import { upgradeV3Adapters } from '../src/installers/adapter-upgrade.js';
import {
  V3_ADAPTER_DIGEST_DOMAIN,
  V3_ADAPTER_PLATFORMS,
  adapterManagedContentDigest,
  inspectV3Adapter,
  inspectV3AdapterVersions,
  installV3Adapter,
  v3ModeEntryPath,
} from '../src/installers/v3-adapter.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { executeOperationRecovery } from '../src/runtime/operation-recovery-executor.js';
import { createSession } from '../src/runtime/session.js';
import { createLocalActor } from '../src/team/actor.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');

describe('adapter managed-content digest and upgrade', () => {
  let root: string;
  let actorId: Ulid;
  let sessionId: Ulid;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-adapter-upgrade-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
    actorId = id(4);
    sessionId = id(5);
    await createLocalActor(root, {
      actorId,
      displayName: 'Adapter Maintainer',
      now: NOW,
    });
    await createSession(root, {
      actorId,
      sessionId,
      client: 'vitest',
      identitySource: 'explicit',
      now: NOW,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses the frozen domain-separated digest byte sequence', () => {
    const expected = createHash('sha256')
      .update(Buffer.from(V3_ADAPTER_DIGEST_DOMAIN, 'utf8'))
      .update(Buffer.from([0]))
      .update(Buffer.from('agents#codex', 'utf8'))
      .update(Buffer.from([0]))
      .update(Buffer.from('managed\nbytes', 'utf8'))
      .digest('hex');

    expect(adapterManagedContentDigest('agents#codex', 'managed\nbytes')).toBe(
      `sha256:${expected}`,
    );
    expect(
      adapterManagedContentDigest('agents#zcode', 'managed\nbytes'),
    ).not.toBe(`sha256:${expected}`);
  });

  it('inspects all five renderers and ignores user-owned embedded content', async () => {
    for (const platform of V3_ADAPTER_PLATFORMS) {
      await installV3Adapter(root, platform);
    }
    await writeFile(
      path.join(root, 'AGENTS.md'),
      `${await readFile(path.join(root, 'AGENTS.md'), 'utf8')}\n# User-owned note\n`,
    );

    const statuses = await Promise.all(
      V3_ADAPTER_PLATFORMS.map((platform) => inspectV3Adapter(root, platform)),
    );
    expect(statuses.every((status) => status.status === 'ready')).toBe(true);
    const codexMode = statuses[1]?.targets.find(
      (target) => target.identity === 'agents-mode-man',
    );
    const zcodeMode = statuses[4]?.targets.find(
      (target) => target.identity === 'agents-mode-man',
    );
    expect(codexMode?.actualDigest).toBe(zcodeMode?.actualDigest);
  });

  it('classifies content, CRLF, truncation, missing files, and invalid UTF-8', async () => {
    await installV3Adapter(root, 'codex');
    const agentsPath = path.join(root, 'AGENTS.md');
    const original = await readFile(agentsPath, 'utf8');

    await writeFile(
      agentsPath,
      original.replace('mancode bootstrap', 'changed bootstrap'),
    );
    await expect(inspectV3Adapter(root, 'codex')).resolves.toMatchObject({
      status: 'stale',
      ready: false,
    });

    await writeFile(agentsPath, original.replaceAll('\n', '\r\n'));
    await expect(inspectV3Adapter(root, 'codex')).resolves.toMatchObject({
      status: 'stale',
    });

    await writeFile(
      agentsPath,
      original.replace('<!-- mancode:v3:codex:end -->', ''),
    );
    await expect(inspectV3Adapter(root, 'codex')).resolves.toMatchObject({
      status: 'stale',
    });

    await writeFile(agentsPath, original);
    await unlink(v3ModeEntryPath(root, 'codex', 'man'));
    await expect(inspectV3Adapter(root, 'codex')).resolves.toMatchObject({
      status: 'missing',
      installed: false,
    });

    await writeFile(v3ModeEntryPath(root, 'codex', 'man'), Buffer.from([0xff]));
    await expect(inspectV3Adapter(root, 'codex')).resolves.toMatchObject({
      status: 'unreadable',
      ready: false,
    });
  });

  it('keeps required missing platforms in inventory without inferring shared hosts', async () => {
    await installV3Adapter(root, 'codex');

    await expect(
      inspectV3AdapterVersions(root, ['codex', 'zcode', 'cursor']),
    ).resolves.toEqual({
      codex: '3',
      cursor: 'missing',
      zcode: 'missing',
    });
  });

  it('stages a dry-run without publishing live targets, then commits explicitly', async () => {
    const live = path.join(root, '.cursor', 'rules', 'mancode-v3.mdc');
    const preview = await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['cursor'],
      dryRun: true,
      operationId: id(10),
      now: NOW,
    });
    expect(preview).toMatchObject({
      state: 'preview',
      dryRun: true,
      journal: null,
      status: { cursor: { status: 'missing' } },
    });
    await expect(
      new V3ContextStore(root).readProjectSnapshot(),
    ).resolves.toMatchObject({ manifest: { managedAdapters: {} } });
    await expect(readFile(live, 'utf8')).rejects.toThrow();
    await expect(
      readFile(path.join(root, preview.stagedTargets[0] ?? ''), 'utf8'),
    ).resolves.toContain('# mancode bootstrap');

    const committed = await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['cursor'],
      explicitConfirmation: true,
      sessionId,
      operationId: id(10),
      now: NOW,
    });
    expect(committed).toMatchObject({
      state: 'committed',
      journal: { state: 'committed', type: 'adapter_upgrade' },
      status: { cursor: { status: 'ready' } },
    });
    await expect(
      new V3ContextStore(root).readProjectSnapshot(),
    ).resolves.toMatchObject({
      manifest: { managedAdapters: { cursor: '3' } },
    });
    await expect(readFile(live, 'utf8')).resolves.toContain(
      '# mancode bootstrap',
    );
  });

  it('does not create staging or live targets without dry-run or confirmation', async () => {
    const operationId = id(12);
    await expect(
      upgradeV3Adapters({
        projectRoot: root,
        platforms: ['cursor'],
        operationId,
        now: NOW,
      }),
    ).rejects.toThrow('MANCODE_EXPLICIT_CONFIRMATION_REQUIRED');
    await expect(
      readFile(path.join(root, '.cursor', 'rules', 'mancode-v3.mdc'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(
          root,
          '.mancode',
          'staging',
          'adapters',
          'upgrade',
          operationId,
          '.cursor',
          'rules',
          'mancode-v3.mdc',
        ),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('rejects a confirmation when the previewed adapter plan has changed', async () => {
    const operationId = id(13);
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['cursor'],
      dryRun: true,
      operationId,
      now: NOW,
    });
    await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
    await writeFile(
      path.join(root, '.cursor', 'rules', 'mancode-v3.mdc'),
      '# User-owned cursor rule\n',
    );

    await expect(
      upgradeV3Adapters({
        projectRoot: root,
        platforms: ['cursor'],
        explicitConfirmation: true,
        sessionId,
        operationId,
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it('upgrades all platforms while journaling shared targets only once', async () => {
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: V3_ADAPTER_PLATFORMS,
      dryRun: true,
      operationId: id(14),
      now: NOW,
    });
    const upgraded = await upgradeV3Adapters({
      projectRoot: root,
      platforms: V3_ADAPTER_PLATFORMS,
      explicitConfirmation: true,
      sessionId,
      operationId: id(14),
      now: NOW,
    });

    expect(
      V3_ADAPTER_PLATFORMS.every(
        (platform) => upgraded.status[platform].status === 'ready',
      ),
    ).toBe(true);
    expect(
      upgraded.filePlans.filter((plan) => plan.target === 'agents'),
    ).toHaveLength(1);
    expect(
      upgraded.filePlans.filter((plan) => plan.target === 'agents-mode-man'),
    ).toHaveLength(1);
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('<!-- mancode:v3:codex:start -->');
    expect(agents).toContain('<!-- mancode:v3:zcode:start -->');
  });

  it('repairs forward after a crash following one visible target write', async () => {
    const operationId = id(20);
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['cursor'],
      dryRun: true,
      operationId,
      now: NOW,
    });
    await expect(
      withOperationCrashInjectionForTesting(
        {
          operationType: 'adapter_upgrade',
          crashAfter: 'replace-managed-adapters:cursor-rule',
        },
        () =>
          upgradeV3Adapters({
            projectRoot: root,
            platforms: ['cursor'],
            explicitConfirmation: true,
            sessionId,
            operationId,
            now: NOW,
          }),
      ),
    ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

    const repaired = await executeOperationRecovery({
      projectRoot: root,
      operationId,
      actorId,
      sessionId,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(repaired).toMatchObject({
      state: 'repaired',
      journal: { state: 'committed', type: 'adapter_upgrade' },
    });
    await expect(inspectV3Adapter(root, 'cursor')).resolves.toMatchObject({
      status: 'ready',
      ready: true,
    });
  });
});

function id(offset: number): Ulid {
  return createUlid(NOW.getTime() + offset, new Uint8Array(10).fill(offset));
}

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
      original.replace('<!-- mancode:continuity:codex:end -->', ''),
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
    const live = path.join(root, '.cursor', 'rules', 'mancode-continuity.mdc');
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
    await expect(
      readFile(
        path.join(
          root,
          '.mancode',
          'staging',
          'adapters',
          'upgrade',
          preview.operationId,
          'preview.json',
        ),
        'utf8',
      ),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, preview.stagedTargets[0] ?? ''), 'utf8'),
    ).rejects.toThrow();
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
      readFile(
        path.join(root, '.cursor', 'rules', 'mancode-continuity.mdc'),
        'utf8',
      ),
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
          'mancode-continuity.mdc',
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
      path.join(root, '.cursor', 'rules', 'mancode-continuity.mdc'),
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

  it('migrates managed V3 bootstrap paths and markers to Continuity', async () => {
    const legacyRule = path.join(root, '.cursor', 'rules', 'mancode-v3.mdc');
    const legacyMode = path.join(root, '.cursor', 'commands', 'man.md');
    await mkdir(path.dirname(legacyRule), { recursive: true });
    await mkdir(path.dirname(legacyMode), { recursive: true });
    await writeFile(
      legacyRule,
      '<!-- Managed by mancode:v3-adapter. Do not edit this marker. -->\n# old bootstrap\n',
    );
    await writeFile(
      legacyMode,
      '<!-- Managed by mancode:v3-mode-entry. Do not edit this marker. -->\n# old mode\n',
    );

    const operationId = id(15);
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['cursor'],
      dryRun: true,
      operationId,
      now: NOW,
    });
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['cursor'],
      explicitConfirmation: true,
      sessionId,
      operationId,
      now: NOW,
    });

    await expect(readFile(legacyRule, 'utf8')).rejects.toThrow();
    await expect(readFile(legacyMode, 'utf8')).resolves.toContain(
      'mancode:continuity-mode-entry',
    );
    await expect(inspectV3Adapter(root, 'cursor')).resolves.toMatchObject({
      status: 'ready',
      target: '.cursor/rules/mancode-continuity.mdc',
    });

    const legacyClaudeSkill = path.join(
      root,
      '.claude',
      'skills',
      'mancode-v3',
      'SKILL.md',
    );
    await mkdir(path.dirname(legacyClaudeSkill), { recursive: true });
    await writeFile(
      legacyClaudeSkill,
      '<!-- Managed by mancode:v3-adapter. Do not edit this marker. -->\n# old bootstrap\n',
    );
    const retiredContinuitySkill = path.join(
      root,
      '.claude',
      'skills',
      'mancode-continuity',
      'SKILL.md',
    );
    await mkdir(path.dirname(retiredContinuitySkill), { recursive: true });
    await writeFile(
      retiredContinuitySkill,
      '<!-- Managed by mancode:continuity-adapter. Do not edit this marker. -->\n# retired bootstrap\n',
    );
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['claude-code'],
      dryRun: true,
      operationId: id(19),
      now: NOW,
    });
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['claude-code'],
      explicitConfirmation: true,
      sessionId,
      operationId: id(19),
      now: NOW,
    });
    await expect(readFile(legacyClaudeSkill, 'utf8')).rejects.toThrow();
    await expect(readFile(retiredContinuitySkill, 'utf8')).rejects.toThrow();
    await expect(inspectV3Adapter(root, 'claude-code')).resolves.toMatchObject({
      status: 'ready',
      target: 'CLAUDE.md',
    });
  });

  it('preserves a user-authored file at the retired V3 path', async () => {
    const legacyRule = path.join(root, '.cursor', 'rules', 'mancode-v3.mdc');
    await mkdir(path.dirname(legacyRule), { recursive: true });
    await writeFile(legacyRule, '# User-owned legacy-named cursor rule\n');

    const operationId = id(16);
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['cursor'],
      dryRun: true,
      operationId,
      now: NOW,
    });
    await upgradeV3Adapters({
      projectRoot: root,
      platforms: ['cursor'],
      explicitConfirmation: true,
      sessionId,
      operationId,
      now: NOW,
    });

    await expect(readFile(legacyRule, 'utf8')).resolves.toBe(
      '# User-owned legacy-named cursor rule\n',
    );
    await expect(inspectV3Adapter(root, 'cursor')).resolves.toMatchObject({
      status: 'ready',
    });
  });

  it.each([
    ['codex', 'AGENTS.md', 'codex'],
    ['zcode', 'AGENTS.md', 'zcode'],
    ['copilot', '.github/copilot-instructions.md', 'copilot'],
  ] as const)(
    'replaces legacy embedded V3 markers for %s without touching user content',
    async (platform, relativeTarget, markerName) => {
      const target = path.join(root, relativeTarget);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        [
          '# User instructions',
          `<!-- mancode:v3:${markerName}:start -->`,
          '# old managed bootstrap',
          `<!-- mancode:v3:${markerName}:end -->`,
          '',
        ].join('\n'),
      );

      const operationId = id(17);
      await upgradeV3Adapters({
        projectRoot: root,
        platforms: [platform],
        dryRun: true,
        operationId,
        now: NOW,
      });
      await upgradeV3Adapters({
        projectRoot: root,
        platforms: [platform],
        explicitConfirmation: true,
        sessionId,
        operationId,
        now: NOW,
      });

      const content = await readFile(target, 'utf8');
      expect(content).toContain('# User instructions');
      expect(content).not.toContain(`mancode:v3:${markerName}`);
      expect(
        content.match(
          new RegExp(`mancode:continuity:${markerName}:start`, 'g'),
        ),
      ).toHaveLength(1);
    },
  );

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
    expect(agents).toContain('<!-- mancode:continuity:codex:start -->');
    expect(agents).toContain('<!-- mancode:continuity:zcode:start -->');
  });

  it('recovers every five-platform target from its write-before and write-after boundary', async () => {
    const discovery = await upgradeV3Adapters({
      projectRoot: root,
      platforms: V3_ADAPTER_PLATFORMS,
      dryRun: true,
      operationId: id(20),
      now: NOW,
    });
    const targets = discovery.filePlans.map((plan) => plan.target);
    expect(targets.length).toBeGreaterThan(1);
    expect(new Set(targets).size).toBe(targets.length);

    let caseIndex = 0;
    for (const boundary of ['before', 'after'] as const) {
      for (const [targetIndex, target] of targets.entries()) {
        const caseRoot = path.join(root, `${boundary}-${caseIndex}`);
        await mkdir(caseRoot, { recursive: true });
        const fixture = await bootstrapAdapterCase(
          caseRoot,
          40 + caseIndex * 7,
        );
        const operationId = id(45 + caseIndex * 7);
        const preview = await upgradeV3Adapters({
          projectRoot: caseRoot,
          platforms: V3_ADAPTER_PLATFORMS,
          dryRun: true,
          operationId,
          now: NOW,
        });
        expect(preview.filePlans.map((plan) => plan.target)).toEqual(targets);

        await expect(
          withOperationCrashInjectionForTesting(
            {
              operationType: 'adapter_upgrade',
              crashAfter:
                boundary === 'before'
                  ? `replace-managed-adapters:before:${target}`
                  : `replace-managed-adapters:${target}`,
            },
            () =>
              upgradeV3Adapters({
                projectRoot: caseRoot,
                platforms: V3_ADAPTER_PLATFORMS,
                explicitConfirmation: true,
                sessionId: fixture.sessionId,
                operationId,
                now: NOW,
              }),
          ),
        ).rejects.toThrow('MANCODE_TEST_OPERATION_CRASH_INJECTED');

        const repaired = await executeOperationRecovery({
          projectRoot: caseRoot,
          operationId,
          actorId: fixture.actorId,
          sessionId: fixture.sessionId,
          now: new Date(NOW.getTime() + 1_000),
        });
        if (boundary === 'before' && targetIndex === 0) {
          expect(repaired).toMatchObject({
            state: 'aborted',
            journal: { state: 'aborted', type: 'adapter_upgrade' },
          });
        } else {
          expect(repaired).toMatchObject({
            state: 'repaired',
            journal: { state: 'committed', type: 'adapter_upgrade' },
          });
        }
        const statuses = await Promise.all(
          V3_ADAPTER_PLATFORMS.map((platform) =>
            inspectV3Adapter(caseRoot, platform),
          ),
        );
        if (boundary === 'before' && targetIndex === 0) {
          expect(statuses.every((status) => status.status === 'missing')).toBe(
            true,
          );
        } else {
          expect(statuses.every((status) => status.ready)).toBe(true);
        }
        caseIndex += 1;
      }
    }
  }, 30_000);
});

async function bootstrapAdapterCase(
  projectRoot: string,
  offset: number,
): Promise<{ actorId: Ulid; sessionId: Ulid }> {
  await initializeV3Project({
    projectRoot,
    operationId: id(offset),
    workspaceId: id(offset + 1),
    schemaEpoch: id(offset + 2),
    now: NOW,
  });
  const actorId = id(offset + 3);
  const sessionId = id(offset + 4);
  await createLocalActor(projectRoot, {
    actorId,
    displayName: 'Adapter Boundary Tester',
    now: NOW,
  });
  await createSession(projectRoot, {
    actorId,
    sessionId,
    client: 'vitest',
    identitySource: 'explicit',
    now: NOW,
  });
  return { actorId, sessionId };
}

function id(offset: number): Ulid {
  return createUlid(NOW.getTime() + offset, new Uint8Array(10).fill(offset));
}

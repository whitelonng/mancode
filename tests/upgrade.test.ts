import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../src/commands/init.js';
import {
  type UpgradeDependencies,
  commitUpgradeProject,
  stageUpgradeProject,
  upgrade,
} from '../src/commands/upgrade.js';
import { inspectV3Adapter } from '../src/installers/v3-adapter.js';
import { withOperationCrashInjectionForTesting } from '../src/runtime/operation-crash-injection.js';
import { createBootstrapSession, readSession } from '../src/runtime/session.js';
import {
  readUpgradeContinuation,
  writeUpgradeContinuation,
} from '../src/runtime/upgrade-continuation.js';
import { UpgradePackageError } from '../src/system/upgrade-package.js';
import { createLocalActor, readLocalActor } from '../src/team/actor.js';
import { VERSION } from '../src/version.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'upgrade-project-')));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('MANCODE_SESSION_ID', undefined);
  expect(
    await init(root, {
      fromCli: true,
      platform: 'codex',
      empty: true,
      yes: true,
    }),
  ).toBe(0);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function stale() {
  const file = path.join(root, '.agents/skills/man/SKILL.md');
  await writeFile(file, `${await readFile(file, 'utf8')}\nold managed skill`);
}

// Exercises command orchestration with real project/session/adapter services.
// Actual npm and registry boundaries are covered by upgrade-e2e.test.ts.
function packageFixture() {
  let installedVersion = '0.6.7';
  const entryPath = path.join(root, 'persistent-cli.js');
  const candidateEntry = path.join(root, 'candidate-cli.js');
  return {
    detectInstallation: vi
      .fn<UpgradeDependencies['detectInstallation']>()
      .mockImplementation(async () => ({
        kind: 'npm-global',
        packageRoot: root,
        entryPath,
        version: installedVersion,
        prefix: root,
      })),
    resolveTarget: vi
      .fn<UpgradeDependencies['resolveTarget']>()
      .mockResolvedValue({
        version: VERSION,
        integrity: 'fixture-integrity',
        tarball: 'https://registry.invalid/package.tgz',
        registry: 'https://registry.invalid',
      }),
    prepareCandidate: vi
      .fn<UpgradeDependencies['prepareCandidate']>()
      .mockResolvedValue({
        rootDir: root,
        packageRoot: root,
        entryPath: candidateEntry,
        version: VERSION,
        integrity: 'fixture-integrity',
        packageDigest: 'fixture-digest',
        cleanup: async () => {},
      }),
    installPackage: vi
      .fn<UpgradeDependencies['installPackage']>()
      .mockImplementation(async () => {
        installedVersion = VERSION;
        return { entryPath, version: VERSION };
      }),
    invokeCli: vi
      .fn<UpgradeDependencies['invokeCli']>()
      .mockImplementation(async (entry, cwd, args) => {
        const version = entry === candidateEntry ? VERSION : installedVersion;
        if (args.includes('--stage'))
          return {
            protocol: 1,
            version,
            preview: await stageUpgradeProject(cwd),
          };
        if (args.includes('--commit')) {
          await commitUpgradeProject(
            cwd,
            args[args.indexOf('--operation-id') + 1] ?? '',
            args[args.indexOf('--session') + 1] ?? '',
            args[args.indexOf('--client') + 1] ?? '',
          );
          return { protocol: 1, version, ready: true };
        }
        return { protocol: 1, version };
      }),
  };
}

describe('one command project update', () => {
  it('discards a pre-journal receipt after CLI version drift and requires a fresh confirmation', async () => {
    await stale();
    const preview = await stageUpgradeProject(root);
    const actor = await createLocalActor(root, { displayName: 'Owner' });
    const { session } = await createBootstrapSession(root, {
      actorId: actor.actorId,
      client: 'mancode-cli',
    });
    await writeUpgradeContinuation(root, {
      schemaVersion: 1,
      projectRoot: root,
      operationId: preview.operationId,
      platforms: preview.platforms,
      targetVersion: '0.0.1',
      initialVersion: '0.0.1',
      installationEntry: null,
      sessionId: session.sessionId,
      client: session.client,
      createdSession: true,
      phase: 'project',
    });
    expect(
      await upgrade(root, { projectOnly: true, yes: true, json: true }),
    ).toBe(4);
    expect(await readUpgradeContinuation(root)).toBeNull();
    expect((await readSession(root, session.sessionId))?.status).toBe('closed');
    const confirm = vi.fn().mockResolvedValue(false);
    expect(
      await upgrade(root, {
        projectOnly: true,
        interactive: true,
        prompter: {
          confirm,
          selectAction: async () => 'project',
          selectInstallation: async () => null,
          displayName: async () => 'unused',
        },
      }),
    ).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect((await inspectV3Adapter(root, 'codex')).ready).toBe(false);
    expect(
      await upgrade(root, { projectOnly: true, yes: true, json: true }),
    ).toBe(0);
    expect((await inspectV3Adapter(root, 'codex')).ready).toBe(true);
  });
  it.each([
    ['project', false, true],
    ['installing', false, false],
    ['project', true, false],
    ['installing', true, false],
  ] as const)(
    'handles persistent CLI version drift in phase %s with journal=%s without losing recovery authority',
    async (phase, withJournal, discardPreview) => {
      await stale();
      const preview = await stageUpgradeProject(root);
      const actor = await createLocalActor(root, { displayName: 'Owner' });
      const { session } = await createBootstrapSession(root, {
        actorId: actor.actorId,
        client: 'mancode-cli',
      });
      const receipt = {
        schemaVersion: 1 as const,
        projectRoot: root,
        operationId: preview.operationId,
        platforms: preview.platforms,
        targetVersion: '0.0.2',
        initialVersion: '0.0.1',
        installationEntry: path.join(root, 'persistent-cli.js'),
        sessionId: session.sessionId,
        client: session.client,
        createdSession: true,
        phase,
      };
      await writeUpgradeContinuation(root, receipt);
      const journalFile = path.join(
        root,
        '.mancode/local/runtime/operations',
        `${preview.operationId}.json`,
      );
      let journalBefore: string | undefined;
      if (withJournal) {
        await expect(
          withOperationCrashInjectionForTesting(
            {
              operationType: 'adapter_upgrade',
              crashAfter: 'replace-managed-adapters',
            },
            () =>
              commitUpgradeProject(
                root,
                preview.operationId,
                session.sessionId,
                session.client,
              ),
          ),
        ).rejects.toThrow();
        journalBefore = await readFile(journalFile, 'utf8');
        expect(JSON.parse(journalBefore).state).toBe('repair_required');
      }
      const fixture = packageFixture();
      expect(
        await upgrade(
          root,
          { projectOnly: true, yes: true, json: true },
          fixture,
        ),
      ).toBe(4);
      expect(
        JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).code,
      ).toBe(
        discardPreview
          ? 'MANCODE_UPGRADE_PREVIEW_VERSION_CHANGED'
          : 'MANCODE_UPGRADE_INSTALL_RESULT_UNKNOWN',
      );
      expect(fixture.invokeCli).toHaveBeenCalledOnce();
      expect(fixture.invokeCli.mock.calls[0]?.[2]).toEqual(['--protocol']);
      expect(fixture.installPackage).not.toHaveBeenCalled();
      if (discardPreview) {
        expect(await readUpgradeContinuation(root)).toBeNull();
        expect((await readSession(root, session.sessionId))?.status).toBe(
          'closed',
        );
        const confirm = vi.fn().mockResolvedValue(false);
        expect(
          await upgrade(
            root,
            {
              projectOnly: true,
              interactive: true,
              prompter: {
                confirm,
                selectAction: async () => 'project',
                selectInstallation: async () => null,
                displayName: async () => 'unused',
              },
            },
            fixture,
          ),
        ).toBe(0);
        expect(confirm).toHaveBeenCalledOnce();
        expect((await inspectV3Adapter(root, 'codex')).ready).toBe(false);
      } else {
        expect(await readUpgradeContinuation(root)).toEqual(receipt);
        expect((await readSession(root, session.sessionId))?.status).toBe(
          'active',
        );
        if (withJournal)
          expect(await readFile(journalFile, 'utf8')).toBe(journalBefore);
      }
    },
  );
  it('reports the installed dependency declaration in successful JSON', async () => {
    const fixture = packageFixture();
    fixture.detectInstallation
      .mockResolvedValueOnce({
        kind: 'npm-local',
        packageRoot: root,
        projectRoot: root,
        entryPath: path.join(root, 'persistent-cli.js'),
        version: '0.6.7',
        declaration: '~0.6.7',
        versionStyle: '~',
        dependencySection: 'devDependencies',
      })
      .mockResolvedValue({
        kind: 'npm-local',
        packageRoot: root,
        projectRoot: root,
        entryPath: path.join(root, 'persistent-cli.js'),
        version: VERSION,
        declaration: `~${VERSION}`,
        versionStyle: '~',
        dependencySection: 'devDependencies',
      });
    expect(
      await upgrade(root, { cliOnly: true, yes: true, json: true }, fixture),
    ).toBe(0);
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).cli,
    ).toMatchObject({
      status: 'updated',
      version: VERSION,
      declaration: `~${VERSION}`,
    });
  });

  it('reports cancellation during a registry check as interrupted, not offline', async () => {
    const fixture = packageFixture();
    fixture.resolveTarget.mockImplementation(async () => {
      process.emit('SIGINT');
      throw new UpgradePackageError(
        'MANCODE_UPGRADE_NPM_FAILED',
        'cancelled registry query',
      );
    });
    expect(await upgrade(root, { check: true, json: true }, fixture)).toBe(130);
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).state,
    ).toBe('interrupted');
  });
  it.each([
    ['MANCODE_UPGRADE_INVALID_TARGET', 2],
    ['MANCODE_UPGRADE_NODE_ENGINE_UNSUPPORTED', 3],
    ['MANCODE_UPGRADE_DOWNGRADE_BLOCKED', 3],
  ])('returns the public exit code for %s', async (code, expected) => {
    const fixture = packageFixture();
    fixture.resolveTarget.mockRejectedValue(
      new UpgradePackageError(String(code), 'target rejected'),
    );
    expect(await upgrade(root, { yes: true, json: true }, fixture)).toBe(
      expected,
    );
    expect(await upgrade(root, { check: true, json: true }, fixture)).toBe(
      expected,
    );
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).code,
    ).toBe(code);
  });
  it('prints target version, installation and unsupported guidance in human checks', async () => {
    const fixture = packageFixture();
    fixture.detectInstallation.mockResolvedValue({
      kind: 'unsupported',
      version: '0.6.7',
      packageRoot: root,
      entryPath: root,
      reason: 'source link',
      guidance: 'Use the original package manager.',
    });
    expect(await upgrade(root, { check: true, lang: 'en' }, fixture)).toBe(0);
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain(`Target version: ${VERSION}`);
    expect(output).toContain(`Installation: ${root}`);
    expect(output).toContain('Use the original package manager.');
  });
  it('retries an installation that failed before changing the persistent version', async () => {
    await stale();
    const fixture = packageFixture();
    fixture.installPackage.mockRejectedValueOnce(
      new Error('npm failed before install'),
    );
    expect(
      await upgrade(
        root,
        { yes: true, name: 'Install Owner', json: true },
        fixture,
      ),
    ).toBe(4);
    expect((await readUpgradeContinuation(root))?.phase).toBe('installing');
    expect(await upgrade(root, { yes: true, json: true }, fixture)).toBe(0);
    expect(fixture.installPackage).toHaveBeenCalledTimes(2);
    expect(await readUpgradeContinuation(root)).toBeNull();
    expect((await inspectV3Adapter(root, 'codex')).ready).toBe(true);
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).project,
    ).toMatchObject({ status: 'updated', ready: true });
  });
  it('does not execute an unverified entry from a continuation', async () => {
    await stale();
    const fixture = packageFixture();
    fixture.installPackage.mockRejectedValueOnce(new Error('npm failed'));
    await upgrade(root, { yes: true, name: 'Owner', json: true }, fixture);
    fixture.invokeCli.mockClear();
    fixture.detectInstallation.mockResolvedValue({
      kind: 'unsupported',
      version: VERSION,
      packageRoot: root,
      entryPath: path.join(root, 'unverified.js'),
    });
    expect(await upgrade(root, { yes: true, json: true }, fixture)).toBe(3);
    expect(fixture.invokeCli).not.toHaveBeenCalled();
  });
  it('closes its session if saving the continuation fails after confirmation', async () => {
    await stale();
    const code = await upgrade(root, {
      projectOnly: true,
      interactive: true,
      prompter: {
        selectAction: async () => 'project',
        selectInstallation: async () => null,
        displayName: async () => 'Owner',
        confirm: async () => {
          await writeFile(
            path.join(root, '.mancode/local/upgrade'),
            'concurrent obstacle',
          );
          return true;
        },
      },
    });
    expect(code).toBe(4);
    const files = await readdir(path.join(root, '.mancode/local/sessions'));
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          path.join(root, '.mancode/local/sessions', files[0] ?? ''),
          'utf8',
        ),
      ).status,
    ).toBe('closed');
    expect((await inspectV3Adapter(root, 'codex')).ready).toBe(false);
  });
  it('discards a stale preview receipt and allows a newly confirmed update', async () => {
    await stale();
    expect(
      await upgrade(root, {
        projectOnly: true,
        interactive: true,
        prompter: {
          selectAction: async () => 'project',
          selectInstallation: async () => null,
          displayName: async () => 'Owner',
          confirm: async () => {
            await stale();
            return true;
          },
        },
      }),
    ).toBe(3);
    expect(await readUpgradeContinuation(root)).toBeNull();
    expect(
      await upgrade(root, { projectOnly: true, yes: true, json: true }),
    ).toBe(0);
    expect((await inspectV3Adapter(root, 'codex')).ready).toBe(true);
  });
  it.each(['prepared', 'replace-managed-adapters', 'commit'])(
    'recovers the original operation after %s',
    async (crashAfter) => {
      await stale();
      const first = await withOperationCrashInjectionForTesting(
        { operationType: 'adapter_upgrade', crashAfter },
        () =>
          upgrade(root, {
            projectOnly: true,
            yes: true,
            name: 'Recovery User',
            json: true,
          }),
      );
      expect(first).not.toBe(0);
      const receipt = await readUpgradeContinuation(root);
      expect(receipt).not.toBeNull();
      const sessionsBefore = await readdir(
        path.join(root, '.mancode/local/sessions'),
      );
      const resumed = await upgrade(root, {
        projectOnly: true,
        yes: true,
        json: true,
      });
      expect(resumed, JSON.stringify(vi.mocked(console.log).mock.calls)).toBe(
        0,
      );
      expect((await inspectV3Adapter(root, 'codex')).ready).toBe(true);
      const sessionsAfter = await readdir(
        path.join(root, '.mancode/local/sessions'),
      );
      expect(sessionsAfter).toHaveLength(
        sessionsBefore.length + (crashAfter === 'prepared' ? 1 : 0),
      );
      expect(await readUpgradeContinuation(root)).toBeNull();
    },
  );
  it('routes the initialized init menu through the same project upgrade service', async () => {
    await stale();
    const selectAction = vi.fn().mockResolvedValue('project');
    expect(
      await init(root, {
        fromCli: true,
        interactive: true,
        upgradePrompter: {
          selectAction,
          confirm: async () => true,
          displayName: async () => 'Init Upgrade User',
          selectInstallation: async () => null,
        },
      }),
    ).toBe(0);
    expect(selectAction).toHaveBeenCalledWith(true);
    expect((await inspectV3Adapter(root, 'codex')).ready).toBe(true);
  });
  it('repairs registered entries without installing other platforms or creating a workflow', async () => {
    await stale();
    await writeFile(
      path.join(root, 'AGENTS.md'),
      `${await readFile(path.join(root, 'AGENTS.md'), 'utf8')}\nMy own instructions.\n`,
    );
    expect(
      await upgrade(root, {
        projectOnly: true,
        yes: true,
        name: 'Upgrade User',
        json: true,
      }),
    ).toBe(0);
    expect((await inspectV3Adapter(root, 'codex')).ready).toBe(true);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain(
      'My own instructions.',
    );
    expect(
      await readFile(path.join(root, '.mancode/schema.json'), 'utf8'),
    ).not.toContain('claude-code');
    expect(await readUpgradeContinuation(root)).toBeNull();
    const sessions = await readdir(path.join(root, '.mancode/local/sessions'));
    const session = JSON.parse(
      await readFile(
        path.join(root, '.mancode/local/sessions', sessions[0] ?? ''),
        'utf8',
      ),
    );
    expect(session.status).toBe('closed');
    expect(session.activeTaskRef).toBeNull();
  });
  it('does not create identity or a session on a ready project', async () => {
    expect(
      await upgrade(root, { projectOnly: true, yes: true, json: true }),
    ).toBe(0);
    expect(await readLocalActor(root)).toBeNull();
  });
  it('keeps check offline and free of staging and identity', async () => {
    await stale();
    const network = vi
      .fn()
      .mockRejectedValue(new Error('must not call network'));
    expect(
      await upgrade(
        root,
        { projectOnly: true, check: true, json: true },
        { detectInstallation: network, resolveTarget: network },
      ),
    ).toBe(0);
    expect(network).not.toHaveBeenCalled();
    expect(await readLocalActor(root)).toBeNull();
    await expect(
      readdir(path.join(root, '.mancode/staging/adapters/upgrade')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires a real first identity and leaves entries unchanged if missing', async () => {
    await stale();
    expect(
      await upgrade(root, { projectOnly: true, yes: true, json: true }),
    ).toBe(2);
    expect(await readLocalActor(root)).toBeNull();
    expect((await inspectV3Adapter(root, 'codex')).ready).toBe(false);
  });
  it('preserves a supplied session instead of closing or rebinding it', async () => {
    await stale();
    const actor = await createLocalActor(root, { displayName: 'Owner' });
    const { session } = await createBootstrapSession(root, {
      actorId: actor.actorId,
      client: 'codex',
    });
    expect(
      await upgrade(root, {
        projectOnly: true,
        yes: true,
        json: true,
        session: session.sessionId,
        client: 'codex',
      }),
    ).toBe(0);
    expect((await readSession(root, session.sessionId))?.status).toBe('active');
  });
  it('cancels after preview without identity or published edits', async () => {
    await stale();
    const confirm = vi.fn().mockResolvedValue(false);
    expect(
      await upgrade(root, {
        projectOnly: true,
        interactive: true,
        prompter: {
          confirm,
          selectAction: async () => 'project',
          displayName: async () => 'unused',
          selectInstallation: async () => null,
        },
      }),
    ).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain('.agents/skills/man/SKILL.md');
    expect(await readLocalActor(root)).toBeNull();
    expect(
      await readFile(path.join(root, '.agents/skills/man/SKILL.md'), 'utf8'),
    ).toContain('old managed skill');
  });
  it('rejects a preview changed before confirmation', async () => {
    await stale();
    const preview = await stageUpgradeProject(root);
    const actor = await createLocalActor(root, { displayName: 'Owner' });
    const { session } = await createBootstrapSession(root, {
      actorId: actor.actorId,
      client: 'mancode-cli',
    });
    await writeFile(
      path.join(root, '.agents/skills/man/SKILL.md'),
      'new user change',
    );
    await expect(
      commitUpgradeProject(
        root,
        preview.operationId,
        session.sessionId,
        session.client,
      ),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(root, '.agents/skills/man/SKILL.md'), 'utf8'),
    ).toBe('new user change');
  });
});

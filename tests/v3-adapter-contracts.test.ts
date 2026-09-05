import {
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextSessionNew } from '../src/commands/context.js';
import { init } from '../src/commands/init.js';
import { install } from '../src/commands/install.js';
import { listPlatforms } from '../src/commands/list-platforms.js';
import { refreshProject } from '../src/commands/refresh-project.js';
import { type V3StatusResult, status } from '../src/commands/status.js';
import { teamIdentityCreate } from '../src/commands/team.js';
import {
  EXIT_V3_AUTHORITY_PROTECTED,
  uninstall,
} from '../src/commands/uninstall.js';
import { ACCEPTED_STATE_NARRATIVE_GUIDANCE } from '../src/context/accepted-state-narrative-guidance.js';
import { parseSchemaManifest } from '../src/context/manifest.js';
import { upgradeV3Adapters } from '../src/installers/adapter-upgrade.js';
import type { PlatformName } from '../src/installers/registry.js';
import {
  V3_ADAPTER_PLATFORMS,
  V3_ADAPTER_VERSION,
  V3_MODE_NAMES,
  applyV3AdapterFilePlan,
  inspectUnsafeV3AdapterPaths,
  inspectV3Adapter,
  installV3Adapter,
  planV3AdapterUpgradeFiles,
  readV3AdapterFilePlanContent,
  removeV3Adapter,
  replaceUnsafeV3AdapterSymlinks,
  stageV3Adapter,
  v3ModeEntryPath,
} from '../src/installers/v3-adapter.js';

describe('V3 adapter bootstrap integration', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      tmpdir(),
      `mancode-v3-adapter-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the V3 adapter schema and original mode surface unchanged', () => {
    expect(V3_ADAPTER_VERSION).toBe('3');
    expect(V3_ADAPTER_PLATFORMS).toHaveLength(8);
    expect(V3_MODE_NAMES).toEqual([
      'manba',
      'man',
      'manteam',
      'manps',
      'mansolo',
    ]);
  });

  it('uses V3 status and bootstrap-only adapters without creating legacy authority', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await init(root, { v3: true, platform: 'codex' })).toBe(0);
      await expect(
        readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
      ).rejects.toThrow();
      const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('# mancode bootstrap');
      expect(agents).toContain('mancode context show --purpose orient');
      expect(agents).not.toContain('.mancode/state.json');
      expect(agents).not.toContain('currentMode');

      logs.mockClear();
      expect(await status(root, { json: true })).toBe(0);
      const result = JSON.parse(
        String(logs.mock.calls.at(-1)?.[0]),
      ) as V3StatusResult;
      expect(result).toMatchObject({
        authority: 'v3',
        runtime: { binding: 'ready' },
        adapters: {
          codex: {
            installed: true,
            ready: true,
            capabilities: { sessionIdentity: 'explicit-required' },
          },
          cursor: { installed: false },
        },
        sessionEvidence: {
          ready: false,
          missingPlatforms: expect.arrayContaining(['codex']),
        },
      });
      expect(result.activation.managedAdapters.codex).toBe('3');

      logs.mockClear();
      expect(await status(root, {})).toBe(0);
      const textOutput = logs.mock.calls.flat().join('\n');
      expect(textOutput).toContain('Session evidence: explicit required');
      expect(textOutput).toContain('codex');
      expect(textOutput).not.toContain('explicit required ()');

      expect(
        await teamIdentityCreate(root, {
          name: 'Adapter Maintainer',
          json: true,
        }),
      ).toBe(0);
      expect(
        await contextSessionNew(root, { client: 'fixture', json: true }),
      ).toBe(0);
      const sessionId = (
        JSON.parse(String(logs.mock.calls.at(-1)?.[0])) as {
          session: { sessionId: string };
        }
      ).session.sessionId;
      const preview = await upgradeV3Adapters({
        projectRoot: root,
        platforms: ['cursor'],
        dryRun: true,
      });
      expect(
        await install(root, 'cursor', {
          confirm: true,
          operationId: preview.operationId,
          session: sessionId,
          client: 'fixture',
        }),
      ).toBe(0);
      const cursorRule = await readFile(
        path.join(root, '.cursor', 'rules', 'mancode-continuity.mdc'),
        'utf8',
      );
      expect(cursorRule).toContain('# mancode bootstrap');
      expect(
        parseSchemaManifest(
          JSON.parse(
            await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
          ),
        ).managedAdapters,
      ).toMatchObject({ codex: '3', cursor: '3' });
      await expect(
        readFile(path.join(root, '.mancode', 'config.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it.each(V3_ADAPTER_PLATFORMS)(
    'applies the common V3 bootstrap contract for %s',
    async (platform: PlatformName) => {
      await init(root, { v3: true });

      const installed = await installV3Adapter(root, platform);
      expect(installed).toMatchObject({
        installed: true,
        ready: true,
        version: '3',
        capabilities: {
          sessionIdentity: 'explicit-required',
          sessionHook: false,
          promptHook: false,
        },
      });
      const target = path.join(root, installed.target);
      const bootstrap = await readFile(target, 'utf8');
      expect(bootstrap).toContain('# mancode bootstrap');
      expect(bootstrap).toContain('mancode context show --purpose orient');
      expect(bootstrap).toContain(
        './node_modules/.bin/mancode` when it exists, otherwise use `mancode',
      );
      expect(bootstrap).toContain(
        'In every command below, `mancode` means that selected binary',
      );
      expect(bootstrap).toContain(
        'mancode context session show --session <id> --client <client> --json',
      );
      expect(bootstrap).toContain('--session <id>');
      expect(bootstrap).toContain('mancode status --brief --json');
      expect(bootstrap).toContain('mancode design context --json');
      expect(bootstrap).toContain('present 2-3 distinct product-appropriate');
      expect(bootstrap).toContain(
        'wait for the user to choose before implementation',
      );
      expect(bootstrap).toContain(
        'do not count as a selected visual direction',
      );
      expect(bootstrap).toContain('Continue directly for scoped UI fixes');
      expect(bootstrap).toContain('Never use emoji as interface icons');
      expect(bootstrap).toContain(
        'Emoji remain allowed inside user-authored content',
      );
      expect(bootstrap).toContain('never fall back to emoji');
      expect(bootstrap).toContain(
        'snapshot already obtained in this conversation',
      );
      expect(bootstrap).toContain(
        'In operator-facing narration, say `mancode`',
      );
      expect(bootstrap).toContain(
        'treat an ordinary requested coding task as default Solo work',
      );
      expect(bootstrap).toContain(
        'Ordinary Solo work requires no actor identity, session, TaskRef, or workflow',
      );
      expect(bootstrap).toContain(
        'A supplied instruction is not automatically sound',
      );
      expect(bootstrap).toContain(
        'classify each remaining unknown as blocking, recommendable, or defaultable',
      );
      expect(bootstrap).toContain(
        'hard-risk change involving authentication, payment, sensitive data, deletion, migration, public APIs, untrusted input, concurrency, infrastructure',
      );
      expect(bootstrap).toContain(`- ${ACCEPTED_STATE_NARRATIVE_GUIDANCE}`);
      expect(bootstrap.split(ACCEPTED_STATE_NARRATIVE_GUIDANCE)).toHaveLength(
        2,
      );
      if (['AGENTS.md', 'CLAUDE.md'].includes(path.basename(target))) {
        expect(bootstrap).toContain(
          '仅用于显式启用模块交付策略的新 `/man` 任务',
        );
        expect(bootstrap).toContain('项目指定的计划基线目录，默认 `doc/`');
        expect(bootstrap).toContain('已有 `docs/` 等明确约定时沿用它');
        expect(bootstrap).toContain('mancode-progress-data');
        expect(bootstrap).toContain('被忽略不代表本地不可读');
        expect(bootstrap).toContain('交付未发布');
        expect(bootstrap).toContain('优先定位并修复根因，避免治标不治本');
        expect(bootstrap).toContain(
          '完整性校验、缓存键、证据适用性和发布溯源仍可使用哈希',
        );
        expect(bootstrap).not.toContain('扩大到十几行');
      } else
        expect(bootstrap).not.toContain('project:documentation-handoff-policy');
      expect(bootstrap).toContain(
        'explicitly asking for research, a plan, architecture, migration design, or formal acceptance authorizes the `man` planning path',
      );
      expect(bootstrap).toContain(
        'For governed task work only, if status has no `identity.actorId`',
      );
      expect(bootstrap).toContain(
        'A plain-language Solo request is not a TaskRef and needs no Context Pack.',
      );
      expect(bootstrap).toContain('mancode team identity create --name');
      expect(bootstrap).toContain(
        '`task: null` and `MANCODE_TASK_REQUIRED` do not make a session stale',
      );
      expect(bootstrap).toContain(
        'Do not probe workflow subcommands to work around `MANCODE_TASK_REQUIRED`',
      );
      expect(bootstrap).toContain(
        'An explicitly invoked original `man`, `manba`, `manteam`, `manps`, or `mansolo` entry supplies its authorized action',
      );
      expect(bootstrap).toContain(
        'before the operator explicitly requests task work, do not run `mancode init`, `mancode migrate`, `mancode workflow`',
      );
      expect(bootstrap).toContain(
        'an `export` inside one command tool does not persist to later command tools',
      );
      expect(bootstrap).toContain(
        'reuse any explicit session ID already returned in this conversation',
      );
      expect(bootstrap).not.toMatch(/\bV3\b/);
      expect(bootstrap).not.toContain('.mancode/state.json');
      expect(bootstrap).not.toContain('currentMode');
      expect(bootstrap).not.toContain(
        'Discovery produces evidence and recommendations, never execution authority.',
      );
      const bootstrapSessionCommands = Array.from(
        bootstrap.matchAll(/`(mancode [^`\n]*--session <id>[^`\n]*)`/g),
        (match) => match[1] ?? '',
      );
      expect(bootstrapSessionCommands.length).toBeGreaterThan(0);
      expect(
        bootstrapSessionCommands.every((command) =>
          command.includes('--client'),
        ),
      ).toBe(true);
      if (platform === 'claude-code') {
        expect(installed.target).toBe('CLAUDE.md');
        expect(bootstrap).toContain('mancode:continuity:claude:start');
        expect(bootstrap).toContain(
          '<!-- project:documentation-handoff-policy:end -->',
        );
      }
      if (platform === 'codex') {
        expect(installed.target).toBe('AGENTS.md');
        expect(bootstrap).toContain('mancode:continuity:codex:start');
        expect(bootstrap).toContain(
          '<!-- project:engineering-execution-quality:end -->',
        );
      }
      if (platform === 'dsh') {
        expect(installed.target).toBe('AGENTS.md');
        expect(bootstrap).toContain('mancode:continuity:dsh:start');
        expect(bootstrap).toContain('--client dsh');
      }

      for (const mode of V3_MODE_NAMES) {
        const entry = await readFile(
          v3ModeEntryPath(root, platform, mode),
          'utf8',
        );
        if (
          platform === 'claude-code' ||
          platform === 'codex' ||
          platform === 'zcode' ||
          platform === 'dsh'
        ) {
          expect(entry).toContain(`name: ${mode}`);
        }
        if (platform === 'dsh') {
          expect(entry).toContain('disable-model-invocation: true');
          expect(entry).toContain('user-invocable: true');
          if (mode !== 'manps') expect(entry).toContain('--client dsh');
          expect(v3ModeEntryPath(root, platform, mode)).toContain(
            path.join('.dsh', 'skills'),
          );
        }
        const description = entry.match(/^description: "([^"]+)"$/m)?.[1];
        expect(description).toContain('mancode');
        expect(description).not.toContain('V3');
        expect(entry).toContain('# mancode mode');
        expect(entry).toContain('./node_modules/.bin/mancode` when it exists');
        expect(entry).toContain(
          'replace the literal `mancode` with that selected binary path',
        );
        expect(entry).toContain('## Enter through mancode');
        expect(entry).toContain('In operator-facing narration, say `mancode`');
        expect(entry).not.toMatch(/\bV3\b/);
        expect(entry).toContain('mancode status --brief --json');
        expect(entry).toContain(
          'snapshot already obtained in this conversation',
        );
        expect(entry).not.toContain('.mancode/state.json');
        if (mode !== 'manps') {
          const sessionCommands = Array.from(
            entry.matchAll(/`(mancode [^`\n]*--session <id>[^`\n]*)`/g),
            (match) => match[1] ?? '',
          );
          expect(sessionCommands.length).toBeGreaterThan(0);
          expect(
            sessionCommands.every((command) => command.includes('--client')),
          ).toBe(true);
        }
        if (mode === 'man') {
          expect(entry).toContain('read-only project orientation');
          expect(entry).toContain(
            'without creating an actor, session, TaskRef, or workflow',
          );
          expect(entry).toContain('internal IDs and digests');
          expect(entry).toContain(
            'must contain exactly one item for each dimension',
          );
          expect(entry).toContain('platform');
          expect(entry).toContain('core_scope');
          expect(entry).toContain('technical_stack');
          expect(entry).toContain('data_and_persistence');
          expect(entry).toContain('performance');
          expect(entry).toContain('compatibility');
          expect(entry).toContain('security');
          expect(entry).toContain('"status": "confirmed"');
          expect(entry).toContain('"rationale": "..."');
          expect(entry).toContain('acceptanceCriteria');
          expect(entry).toContain('"method": "automated"');
          expect(entry).toContain('"verificationSurfaces"');
          expect(entry).toContain(
            "clears this session's active workflow pointer",
          );
          expect(entry).toContain('run a decision-readiness gate');
          expect(entry).toContain(
            'Do not ask ceremonial questions or manufacture alternatives when the request is already clear and sound.',
          );
          expect(entry).toContain(
            'Classify unresolved decisions as blocking, recommendable, or defaultable.',
          );
          expect(entry).toContain('2–3 bounded options');
          expect(entry).toContain(
            'stop before requirements finalization, explain the missing decision, ask focused questions, and wait for the user answer.',
          );
          expect(entry).toContain(
            'never turn an unverified assumption into confirmed scope or confirmed coverage.',
          );
          expect(entry).toContain(
            'workflow requirements <namespace:ULID> draft --file <requirements.json>',
          );
          expect(entry).toContain(
            'another session can resume the exact clarification state',
          );
          expect(entry).toContain(
            'summarize the resolved requirements and any remaining defaults',
          );
          expect(entry).toContain('clarity does not waive risk');
          expect(entry).toContain('mancode context glossary add');
          expect(entry).toContain(
            'Never write to the glossary without operator confirmation.',
          );
        }
        if (mode === 'manba') {
          expect(entry).toContain(
            'establish the expected behavior from reproducible evidence',
          );
          expect(entry).toContain(
            'ask one focused question and wait instead of inventing product behavior',
          );
          expect(entry).toContain('explicit but unsound fix instruction');
        }
        if (mode === 'manps') {
          expect(entry).toContain(
            'A local scan needs no TaskRef, actor identity, or explicit session',
          );
          expect(entry).toContain(
            'do not require a TaskRef, workflow revision, actor, or session',
          );
          expect(entry).not.toContain('For every mutation, use the TaskRef');
        }
        if (mode === 'mansolo') {
          expect(entry).toContain('Ordinary focused work needs no TaskRef');
          expect(entry).toContain(
            'Only an explicit governed handoff mutation requires',
          );
          expect(entry).toContain(
            'assess both clarity and soundness using the project facts',
          );
          expect(entry).toContain(
            'classify the rest as blocking, recommendable, or defaultable',
          );
          expect(entry).toContain('A supplied implementation direction');
          expect(entry).toContain(
            'recommend `/man`, explain the trigger, and wait for the operator to choose',
          );
          expect(entry).toContain(
            'Detect those governance triggers after the smallest fact check needed',
          );
        }
        if (mode === 'man' || mode === 'manteam' || mode === 'mansolo') {
          expect(entry).toContain('.mancode/shared/context/glossary.json');
          expect(entry).toContain('prefer its confirmed terms');
        }
        if (mode === 'man' || mode === 'manteam') {
          expect(entry).toContain(
            'Discovery produces evidence and recommendations, never execution authority.',
          );
          expect(entry).toContain('`repository_fact`');
          expect(entry).toContain('`domain_hypothesis`');
          expect(entry).toContain(
            'an unverified domain hypothesis becomes a focused question, never a fact',
          );
          expect(entry).toContain(
            'Accepted scope or behavior findings enter `confirmedScope` and the matching `acceptanceCriteria`',
          );
          expect(entry).toContain(
            'accepted technical choices enter `technicalDecisions`',
          );
          expect(entry).toContain(
            'Only explicitly excluded behavior enters `excludedScope`',
          );
          expect(entry).toContain('`implementationScope`');
        }
        if (mode === 'man') {
          expect(entry).toContain(
            'upgraded, already-running local `man` task has no executable implementation scope',
          );
          expect(entry).toContain('exact unchanged current plan');
          expect(entry).toContain('repo-relative path or glob');
          expect(entry).toContain('"surface": "real_http"');
          expect(entry).toContain('self-declared');
          expect(entry).toContain('uncommitted outside-scope');
          expect(entry).toContain('exit code 0');
          expect(entry).toContain('review_incomplete');
          expect(entry).toContain('completion, a commit, or a PR');
          expect(entry).toContain('accepted requirements and plan');
          expect(entry).toContain(
            'observed final state after available readback',
          );
          expect(entry).toContain('task-owned diff from the bound `baseHead`');
          expect(entry).toContain(
            'Preserve failures, blockers, compatibility or migration facts',
          );
          expect(entry).toContain('report it as unverified');
        }
        if (mode === 'manteam') {
          expect(entry).toContain(
            'same decision-readiness gate as `man` before finalizing requirements',
          );
          expect(entry).toContain(
            'commit the resulting `.mancode/shared` authority changes',
          );
          expect(entry).toContain(
            '`mancode team sync push <shared:ULID> --expected-task-revision <n>`',
          );
          expect(entry).toContain(
            'with the unchanged task revision to rebind the remote code head',
          );
          expect(entry).toContain(
            'ownership conflict, or hard-risk direction remains',
          );
          expect(entry).toContain(
            'do not leave ownership questions or partial answers only in chat history',
          );
          expect(entry).toContain('Before any handoff, commit, or PR');
          expect(entry).toContain(
            'current authoritative task and handoff state plus the task-owned diff',
          );
          expect(entry).toContain(
            'accepted requirements, the observed final state after available readback',
          );
          expect(entry).toContain(
            'Preserve failures, blockers, incomplete work, compatibility and migration facts, audit evidence',
          );
          expect(entry).toContain(
            'every formal handoff status and resolution reason',
          );
          expect(entry).toContain('mark it unverified');
        }
        if (mode === 'mansolo') {
          expect(entry).not.toContain(
            'Discovery produces evidence and recommendations, never execution authority.',
          );
          expect(entry).not.toContain(
            'Accepted scope or behavior findings enter `confirmedScope`',
          );
        }
        if (mode === 'man' || mode === 'manba' || mode === 'manteam') {
          expect(entry).toContain(`mancode workflow create ${mode}`);
        }
      }

      // Installation is an idempotent bootstrap renderer, not task authority.
      await installV3Adapter(root, platform);
      expect(await inspectV3Adapter(root, platform)).toMatchObject({
        installed: true,
        ready: true,
      });
      await expect(
        readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
      ).rejects.toThrow();

      await removeV3Adapter(root, platform);
      expect(await inspectV3Adapter(root, platform)).toMatchObject({
        installed: false,
        ready: false,
      });
      if (
        platform !== 'codex' &&
        platform !== 'zcode' &&
        platform !== 'kimi-code'
      ) {
        await expect(
          readFile(v3ModeEntryPath(root, platform, 'man'), 'utf8'),
        ).rejects.toThrow();
      }
    },
  );

  it('preserves user instructions outside the V3 managed block', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), '# User instructions\n');

    expect(await init(root, { v3: true, platform: 'codex' })).toBe(0);
    expect(await init(root, { v3: true, platform: 'codex' })).toBe(1);
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# User instructions');
    expect(agents.match(/mancode:continuity:codex:start/g)).toHaveLength(1);
  });

  it('keeps the Claude bootstrap always loaded without replacing user memory', async () => {
    const claudeMemory = path.join(root, 'CLAUDE.md');
    await writeFile(claudeMemory, '# User project memory\n\nKeep this rule.\n');

    await installV3Adapter(root, 'claude-code');
    await installV3Adapter(root, 'claude-code');
    const installed = await readFile(claudeMemory, 'utf8');
    expect(installed).toContain('# User project memory');
    expect(installed).toContain('Keep this rule.');
    expect(installed.match(/mancode:continuity:claude:start/g)).toHaveLength(1);

    await removeV3Adapter(root, 'claude-code');
    const removed = await readFile(claudeMemory, 'utf8');
    expect(removed).toContain('# User project memory');
    expect(removed).not.toContain('mancode:continuity:claude');
  });

  it('stages the bootstrap and every original mode entry without changing live files', async () => {
    await mkdir(path.join(root, '.mancode'), { recursive: true });

    const staged = await stageV3Adapter(root, 'cursor');

    expect(staged.modeEntries.map((entry) => entry.mode)).toEqual([
      ...V3_MODE_NAMES,
    ]);
    await expect(
      readFile(path.join(root, staged.stagingTarget), 'utf8'),
    ).resolves.toContain('# mancode bootstrap');
    for (const entry of staged.modeEntries) {
      await expect(
        readFile(path.join(root, entry.stagingTarget), 'utf8'),
      ).resolves.toContain(`# mancode mode: ${entry.mode}`);
    }
    await expect(
      readFile(path.join(root, '.cursor', 'commands', 'man.md'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(root, '.cursor', 'rules', 'mancode-continuity.mdc'),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('keeps shared Codex and ZCode original mode entries host-neutral', async () => {
    await init(root, { v3: true });
    await installV3Adapter(root, 'codex');
    const modePath = v3ModeEntryPath(root, 'codex', 'man');
    const afterCodex = await readFile(modePath, 'utf8');
    expect(afterCodex).toContain('--client codex');
    expect(afterCodex).toContain('--client zcode');
    const agentsAfterCodex = await readFile(
      path.join(root, 'AGENTS.md'),
      'utf8',
    );

    await installV3Adapter(root, 'zcode');
    await expect(readFile(modePath, 'utf8')).resolves.toBe(afterCodex);
    const agentsAfterZcode = await readFile(
      path.join(root, 'AGENTS.md'),
      'utf8',
    );
    expect(agentsAfterZcode).toContain('--client codex');
    expect(agentsAfterZcode).toContain('--client zcode');
    expect(agentsAfterCodex).toContain('Codex, ZCode, or Kimi Code');
  });

  it('keeps DSH mode entries isolated from shared agent skills', async () => {
    await init(root, { v3: true });
    await installV3Adapter(root, 'codex');
    const codexModePath = v3ModeEntryPath(root, 'codex', 'man');
    const codexMode = await readFile(codexModePath, 'utf8');

    await installV3Adapter(root, 'dsh');

    await expect(readFile(codexModePath, 'utf8')).resolves.toBe(codexMode);
    const dshModePath = v3ModeEntryPath(root, 'dsh', 'man');
    await expect(readFile(dshModePath, 'utf8')).resolves.toContain(
      'disable-model-invocation: true',
    );
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('mancode:continuity:codex:start');
    expect(agents).toContain('mancode:continuity:dsh:start');

    await removeV3Adapter(root, 'dsh');
    await expect(readFile(codexModePath, 'utf8')).resolves.toBe(codexMode);
    await expect(readFile(dshModePath, 'utf8')).rejects.toThrow();
  });

  it('renders the complete plan and local reframe command contracts', async () => {
    await init(root, { v3: true, platform: 'codex' });
    const man = await readFile(v3ModeEntryPath(root, 'codex', 'man'), 'utf8');

    expect(man).toContain(
      'revise --expected-revision <n> --file <repo-relative-plan.md> --scope-file <scope.json> --session <id> --client <active-client>',
    );
    expect(man).toContain(
      'confirm --expected-revision <n> --plan-decision <plan_only|governed_execution> --session <id> --client <active-client>',
    );
    expect(man).toContain(
      'workflow reframe <namespace:ULID> --expected-revision <n> --checkpoint-id <fresh-ULID>',
    );
    expect(man).toContain('stops at Step 2 with draft requirements');
    expect(man).toContain(
      'Do not substitute plan revise, scope-change, or workflow update for reframe.',
    );
    expect(man).toContain(
      'workflow archive <namespace:ULID> show <archive-ULID> --json',
    );
    expect(man).toContain(
      'workflow checkpoint <namespace:ULID> show <checkpoint-ULID> --json',
    );
    expect(man).toContain(
      'operation repair <operation-ULID> --replacement-checkpoint-id <fresh-ULID> --session <id> --client <active-client>',
    );
    expect(man).toContain('limited to that proven reframe checkpoint conflict');
    expect(man).toContain('--delivery --session <id> --client <active-client>');
    expect(man).toContain('one total review (not one per snippet');
    expect(man).toContain('goal → implementation');
    expect(man).toContain('diff → goal');
    for (const mode of V3_MODE_NAMES.filter((mode) => mode !== 'man')) {
      const other = await readFile(
        v3ModeEntryPath(root, 'codex', mode),
        'utf8',
      );
      expect(other).not.toContain('--delivery');
      expect(other).not.toContain('mancode:plan-baseline');
    }
  });

  it('refuses to overwrite a user-authored original mode entry', async () => {
    await init(root, { v3: true });
    const modePath = v3ModeEntryPath(root, 'codex', 'man');
    await mkdir(path.dirname(modePath), { recursive: true });
    await writeFile(modePath, '# My own man skill\n');

    await expect(installV3Adapter(root, 'codex')).rejects.toThrow(
      'MANCODE_V3_MODE_ENTRY_USER_AUTHORED',
    );
    await expect(readFile(modePath, 'utf8')).resolves.toBe(
      '# My own man skill\n',
    );
    await expect(
      readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked adapter parent without writing outside the project',
    async () => {
      await init(root, { v3: true });
      const outside = `${root}-outside`;
      await mkdir(outside, { recursive: true });
      try {
        await symlink(outside, path.join(root, '.agents'));

        await expect(installV3Adapter(root, 'codex')).rejects.toThrow(
          'MANCODE_ARTIFACT_PATH_UNSAFE',
        );
        await expect(
          readFile(path.join(outside, 'AGENTS.md')),
        ).rejects.toThrow();
        await expect(
          readFile(path.join(outside, 'skills', 'man', 'SKILL.md')),
        ).rejects.toThrow();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'merges CLAUDE.md -> AGENTS.md into one physical plan and preserves the link',
    async () => {
      const agentsPath = path.join(root, 'AGENTS.md');
      const claudePath = path.join(root, 'CLAUDE.md');
      await writeFile(agentsPath, '# Shared user instructions\n');
      await symlink('AGENTS.md', claudePath);

      const plans = await planV3AdapterUpgradeFiles(root, [
        'claude-code',
        'codex',
      ]);
      const physicalPlans = plans.filter(
        (plan) => plan.resolvedTarget === 'AGENTS.md',
      );
      expect(physicalPlans).toHaveLength(1);
      expect(physicalPlans[0]).toMatchObject({
        target: 'agents',
        beforeContent: '# Shared user instructions\n',
        resolvedTarget: 'AGENTS.md',
        linkIdentities: [{ linkPath: 'CLAUDE.md', linkTarget: 'AGENTS.md' }],
      });
      expect(plans.some((plan) => plan.target === 'claude-skill')).toBe(false);
      const physicalPlan = physicalPlans[0];
      if (physicalPlan === undefined) {
        throw new Error('expected shared physical adapter plan');
      }

      await applyV3AdapterFilePlan(root, physicalPlan);

      expect((await lstat(claudePath)).isSymbolicLink()).toBe(true);
      const content = await readFile(agentsPath, 'utf8');
      expect(content).toContain('# Shared user instructions');
      expect(content).toContain('mancode:continuity:claude:start');
      expect(content).toContain('mancode:continuity:codex:start');
    },
  );

  it.each([
    ['regular', 'read'],
    ['regular', 'publish'],
    ['symlink', 'read'],
    ['symlink', 'publish'],
  ] as const)(
    'rejects a hardlink added after planning a %s target on %s',
    async (kind, operation) => {
      const physicalPath = path.join(root, 'AGENTS.md');
      const aliasPath = path.join(root, 'ALIAS.md');
      const before = '# Original target\n';
      await writeFile(physicalPath, before);
      if (kind === 'symlink') {
        await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));
      }
      const plans = await planV3AdapterUpgradeFiles(root, [
        kind === 'symlink' ? 'claude-code' : 'codex',
      ]);
      const plan = plans.find(
        (candidate) => candidate.beforeContent === before,
      );
      if (plan === undefined) throw new Error('expected physical adapter plan');
      await link(physicalPath, aliasPath);
      const original = await lstat(physicalPath);
      expect(original.nlink).toBe(2);

      await expect(
        operation === 'read'
          ? readV3AdapterFilePlanContent(root, plan)
          : applyV3AdapterFilePlan(root, plan),
      ).rejects.toThrow('MANCODE_V3_ADAPTER_TARGET_CONFLICT');
      for (const target of [physicalPath, aliasPath]) {
        await expect(readFile(target, 'utf8')).resolves.toBe(before);
        expect(await lstat(target)).toMatchObject({
          ino: original.ino,
          dev: original.dev,
          nlink: 2,
        });
      }
      if (kind === 'symlink') {
        expect(
          (await lstat(path.join(root, 'CLAUDE.md'))).isSymbolicLink(),
        ).toBe(true);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a journaled adapter plan after its symlink is retargeted',
    async () => {
      const agentsPath = path.join(root, 'AGENTS.md');
      const alternatePath = path.join(root, 'ALTERNATE.md');
      const claudePath = path.join(root, 'CLAUDE.md');
      await writeFile(agentsPath, '# Original target\n');
      await writeFile(alternatePath, '# Alternate target\n');
      await symlink('AGENTS.md', claudePath);
      const plans = await planV3AdapterUpgradeFiles(root, ['claude-code']);
      const plan = plans.find((candidate) => candidate.resolvedTarget);
      expect(plan).toBeDefined();
      if (plan === undefined) throw new Error('expected symlink adapter plan');

      await rm(claudePath);
      await symlink('ALTERNATE.md', claudePath);

      await expect(applyV3AdapterFilePlan(root, plan)).rejects.toThrow(
        'MANCODE_V3_ADAPTER_TARGET_CONFLICT',
      );
      await expect(readFile(agentsPath, 'utf8')).resolves.toBe(
        '# Original target\n',
      );
      await expect(readFile(alternatePath, 'utf8')).resolves.toBe(
        '# Alternate target\n',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a journaled adapter plan after its resolved target is removed',
    async () => {
      const agentsPath = path.join(root, 'AGENTS.md');
      const claudePath = path.join(root, 'CLAUDE.md');
      await writeFile(agentsPath, '# Original target\n');
      await symlink('AGENTS.md', claudePath);
      const plans = await planV3AdapterUpgradeFiles(root, ['claude-code']);
      const plan = plans.find((candidate) => candidate.resolvedTarget);
      expect(plan).toBeDefined();
      if (plan === undefined) throw new Error('expected symlink adapter plan');

      await rm(agentsPath);

      await expect(applyV3AdapterFilePlan(root, plan)).rejects.toThrow(
        'MANCODE_ARTIFACT_PATH_UNSAFE',
      );
      expect((await lstat(claudePath)).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink that points outside the project during planning and replay',
    async () => {
      const agentsPath = path.join(root, 'AGENTS.md');
      const claudePath = path.join(root, 'CLAUDE.md');
      const outsidePath = `${root}-outside.md`;
      await writeFile(agentsPath, '# Original target\n');
      await symlink('AGENTS.md', claudePath);
      const plans = await planV3AdapterUpgradeFiles(root, ['claude-code']);
      const plan = plans.find((candidate) => candidate.resolvedTarget);
      expect(plan).toBeDefined();
      if (plan === undefined) throw new Error('expected symlink adapter plan');

      try {
        await writeFile(outsidePath, '# Outside target\n');
        await rm(claudePath);
        await symlink(outsidePath, claudePath);

        await expect(applyV3AdapterFilePlan(root, plan)).rejects.toThrow(
          'MANCODE_ARTIFACT_PATH_UNSAFE',
        );
        await expect(
          planV3AdapterUpgradeFiles(root, ['claude-code']),
        ).rejects.toThrow('MANCODE_ARTIFACT_PATH_UNSAFE');
        await expect(readFile(outsidePath, 'utf8')).resolves.toBe(
          '# Outside target\n',
        );
      } finally {
        await rm(outsidePath, { force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'writes through an in-repo symlinked fixed target and keeps the link',
    async () => {
      await init(root, { v3: true, platform: 'codex' });
      // Repo convention (CLAUDE.md -> AGENTS.md): the link survives and the
      // resolved file receives the managed block beside user content.
      await writeFile(
        path.join(root, 'AGENTS.md'),
        '# shared agent instructions\n',
      );
      await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));

      await expect(
        installV3Adapter(root, 'claude-code'),
      ).resolves.toMatchObject({ installed: true });
      const entry = await lstat(path.join(root, 'CLAUDE.md'));
      expect(entry.isSymbolicLink()).toBe(true);
      // Reading the link reads the resolved file, so both views agree.
      await expect(
        readFile(path.join(root, 'CLAUDE.md'), 'utf8'),
      ).resolves.toContain('# shared agent instructions');
      const resolved = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
      expect(resolved).toContain('# shared agent instructions');
      expect(resolved).toContain('mancode:continuity:claude:start');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports an in-repo symlinked fixed target through the inspection API',
    async () => {
      await init(root, { v3: true, platform: 'codex' });
      await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));

      const found = await inspectUnsafeV3AdapterPaths(root, 'claude-code');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        relative: 'CLAUDE.md',
        kind: 'symlink',
        finalTarget: true,
      });
      expect(found[0]?.resolvedTo?.endsWith('AGENTS.md')).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'materializes a symlinked fixed target as a regular file with preserved content',
    async () => {
      await init(root, { v3: true, platform: 'codex' });
      await writeFile(
        path.join(root, 'AGENTS.md'),
        '# shared agent instructions\n',
      );
      await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));

      const found = await inspectUnsafeV3AdapterPaths(root, 'claude-code');
      await replaceUnsafeV3AdapterSymlinks(found);

      const entry = await lstat(path.join(root, 'CLAUDE.md'));
      expect(entry.isSymbolicLink()).toBe(false);
      await expect(
        readFile(path.join(root, 'CLAUDE.md'), 'utf8'),
      ).resolves.toBe('# shared agent instructions\n');

      const status = await installV3Adapter(root, 'claude-code');
      expect(status.ready).toBe(true);
      const content = await readFile(path.join(root, 'CLAUDE.md'), 'utf8');
      expect(content).toContain('# shared agent instructions');
      expect(content).toContain('mancode:continuity:claude:start');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'leaves an escaping symlinked parent unreplaced and still rejects install',
    async () => {
      await init(root, { v3: true });
      const outside = `${root}-outside`;
      await mkdir(outside, { recursive: true });
      try {
        await symlink(outside, path.join(root, '.agents'));

        const found = await inspectUnsafeV3AdapterPaths(root, 'codex');
        expect(found.some((entry) => entry.kind === 'symlink')).toBe(true);
        await replaceUnsafeV3AdapterSymlinks(found);
        await expect(installV3Adapter(root, 'codex')).rejects.toThrow(
          'MANCODE_ARTIFACT_PATH_UNSAFE',
        );
        await expect(
          readFile(path.join(outside, 'AGENTS.md')),
        ).rejects.toThrow();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('retires legacy managed entrypoints when repairing an active V3 adapter', async () => {
    await init(root, { v3: true });
    const legacyCodexAlias = path.join(
      root,
      '.agents',
      'skills',
      'mamba',
      'SKILL.md',
    );
    await mkdir(path.dirname(legacyCodexAlias), { recursive: true });
    await writeFile(
      legacyCodexAlias,
      '<!-- Managed by mancode:codex-skill. Do not edit this file manually. -->\nRead `.mancode/state.json`.\n',
    );
    await writeFile(
      path.join(root, 'AGENTS.md'),
      [
        '# User instructions',
        '<!-- mancode:start -->',
        'Read `.mancode/state.json`.',
        '<!-- mancode:end -->',
        '<!-- mancode:zcode:start -->',
        'Also read `.mancode/state.json`.',
        '<!-- mancode:zcode:end -->',
      ].join('\n'),
    );
    await installV3Adapter(root, 'codex');
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# User instructions');
    expect(agents).not.toContain('.mancode/state.json');
    const codexAlias = await readFile(legacyCodexAlias, 'utf8');
    expect(codexAlias).toContain('# mancode mode compatibility alias');
    expect(codexAlias).toContain('public mancode mode `manba`');
    expect(codexAlias).not.toContain('.mancode/state.json');
    await removeV3Adapter(root, 'codex');
    await expect(readFile(legacyCodexAlias, 'utf8')).rejects.toThrow();

    await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
    await writeFile(
      path.join(root, '.cursor', 'rules', 'mancode-context.mdc'),
      '<!-- Managed by mancode:cursor-rule. Do not edit this marker. -->\nRead `.mancode/state.json`.\n',
    );
    const legacyCursorAlias = path.join(
      root,
      '.cursor',
      'rules',
      'mancode-mamba.mdc',
    );
    await writeFile(
      legacyCursorAlias,
      '<!-- Managed by mancode:cursor-rule. Do not edit this marker. -->\nRead `.mancode/state.json`.\n',
    );
    await installV3Adapter(root, 'cursor');
    const cursorRule = await readFile(
      path.join(root, '.cursor', 'rules', 'mancode-context.mdc'),
      'utf8',
    );
    expect(cursorRule).toContain('alwaysApply: false');
    expect(cursorRule).not.toContain('.mancode/state.json');
    const cursorAlias = await readFile(legacyCursorAlias, 'utf8');
    expect(cursorAlias).toContain('Use the `/manba` mancode mode command.');
    expect(cursorAlias).not.toContain('.mancode/state.json');
    await removeV3Adapter(root, 'cursor');
    await expect(
      readFile(
        path.join(root, '.cursor', 'rules', 'mancode-context.mdc'),
        'utf8',
      ),
    ).rejects.toThrow();
    await expect(readFile(legacyCursorAlias, 'utf8')).rejects.toThrow();

    await mkdir(path.join(root, '.claude', 'skills', 'solo'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.claude', 'skills', 'solo', 'SKILL.md'),
      '<!-- Managed by mancode:claude-skill. Do not edit this marker. -->\nRead `.mancode/state.json`.\n',
    );
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(
      path.join(root, '.claude', 'settings.json'),
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node ".mancode/hooks/session-start.mjs"',
                },
                { type: 'command', command: 'node user-hook.mjs' },
              ],
            },
          ],
        },
      })}\n`,
    );
    await installV3Adapter(root, 'claude-code');
    const settings = await readFile(
      path.join(root, '.claude', 'settings.json'),
      'utf8',
    );
    expect(settings).not.toContain('session-start.mjs');
    expect(settings).toContain('node user-hook.mjs');
    await expect(
      readFile(
        path.join(root, '.claude', 'skills', 'solo', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toContain('# mancode mode compatibility alias');
    await removeV3Adapter(root, 'claude-code');
    await expect(
      readFile(
        path.join(root, '.claude', 'skills', 'solo', 'SKILL.md'),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('stages a dual-read adapter candidate without changing the live target', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await init(root, { v3: true })).toBe(0);
      const schemaPath = path.join(root, '.mancode', 'schema.json');
      const manifest = JSON.parse(await readFile(schemaPath, 'utf8'));
      await writeFile(
        schemaPath,
        `${JSON.stringify(
          {
            ...manifest,
            activationState: 'dual_read',
            activatedAt: null,
            legacyBaseline: {
              stateDigest: `sha256:${'a'.repeat(64)}`,
              workflowIndexDigest: `sha256:${'b'.repeat(64)}`,
            },
          },
          null,
          2,
        )}\n`,
      );
      const liveAgents = '# User instructions\n';
      await writeFile(path.join(root, 'AGENTS.md'), liveAgents);

      expect(await install(root, 'codex', { shadow: true })).toBe(0);
      await expect(
        readFile(path.join(root, 'AGENTS.md'), 'utf8'),
      ).resolves.toBe(liveAgents);
      await expect(
        readFile(
          path.join(
            root,
            '.mancode',
            'staging',
            'adapters',
            'continuity',
            'codex',
            'AGENTS.md',
          ),
          'utf8',
        ),
      ).resolves.toContain('# mancode bootstrap');
      expect(logs.mock.calls.flat().join(' ')).toContain(
        'staged for shadow comparison',
      );
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('persists detected project facts and refreshes them without legacy state', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      );
      expect(await init(root, { v3: true })).toBe(0);

      const initialFacts = JSON.parse(
        await readFile(
          path.join(root, '.mancode', 'shared', 'context', 'project.json'),
          'utf8',
        ),
      );
      expect(initialFacts).toMatchObject({
        schemaVersion: 1,
        revision: 1,
        trust: 'detected',
        profile: {
          projectKind: 'web',
          languages: ['JavaScript/TypeScript'],
          frameworks: ['React'],
          sourceRoots: ['src'],
        },
      });

      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          dependencies: { react: '^19.0.0', tailwindcss: '^4.0.0' },
        }),
      );
      expect(await refreshProject(root)).toBe(0);
      const refreshedFacts = JSON.parse(
        await readFile(
          path.join(root, '.mancode', 'shared', 'context', 'project.json'),
          'utf8',
        ),
      );
      expect(refreshedFacts).toMatchObject({
        revision: 2,
        profile: { frameworks: ['React', 'Tailwind CSS'] },
        uiLibrary: 'Tailwind CSS',
      });
      await expect(
        readFile(path.join(root, '.mancode', 'state.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });

  it('lists and removes only V3 bootstrap files without treating V3 authority as legacy state', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await init(root, { v3: true, platform: 'codex' })).toBe(0);
      expect(await listPlatforms(root)).toBe(0);
      expect(logs.mock.calls.flat().join(' ')).toContain(
        'Available platforms (mancode bootstrap)',
      );
      expect(logs.mock.calls.flat().join(' ')).toContain('codex');

      expect(await uninstall(root, 'codex', { force: true })).toBe(0);
      await expect(
        readFile(path.join(root, 'AGENTS.md'), 'utf8'),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
      ).resolves.toContain('v3_active');
      expect(await uninstall(root, undefined, { all: true })).toBe(
        EXIT_V3_AUTHORITY_PROTECTED,
      );
      expect(errors.mock.calls.flat().join('\n')).toContain(
        'context compact --dry-run',
      );
      expect(errors.mock.calls.flat().join('\n')).not.toContain(
        'archive/migration workflow',
      );
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
  });
});

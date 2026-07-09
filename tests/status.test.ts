import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import { install } from '../src/commands/install.js';
import {
  EXIT_CORRUPT_STATE,
  EXIT_NOT_INITIALIZED,
  EXIT_OK,
  type StatusResult,
  status,
} from '../src/commands/status.js';
import { createWorkflow } from '../src/system/workflow.js';
import { VERSION } from '../src/version.js';

describe('mancode status', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-status-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns EXIT_NOT_INITIALIZED when mancode is not initialized', async () => {
    const code = await status(dir);
    expect(code).toBe(EXIT_NOT_INITIALIZED);
  });

  it('returns EXIT_OK and shows project state after init', async () => {
    await silentInit(dir);
    const code = await status(dir);
    expect(code).toBe(EXIT_OK);
  });

  it('--json outputs valid JSON with all fields', async () => {
    await silentInit(dir);

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.version).toBe(VERSION);
    expect(result.mode).toBe('solo');
    expect(result.platforms).toEqual(['claude-code']);
    expect(result.uiLibrary).toBe('None');
    expect(result.initializedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(result.hooks.sessionStart).toBe(true);
    expect(result.hooks.userPromptSubmit).toBe(true);
    expect(result.hooks.registered).toBe(true);
    expect(result.hookInjection.cap).toBe(800);
    expect(typeof result.hookInjection.tokens).toBe('number');
    expect(result.team.isTeam).toBe(false);
    expect(result.team.contributors).toBeGreaterThanOrEqual(1);
    expect(result.currentWorkflow).toBeNull();
  });

  it('project name comes from package.json name field', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'my-cool-app' }),
      'utf-8',
    );
    await silentInit(dir);

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.project).toBe('my-cool-app');
  });

  it('project name falls back to directory basename without package.json', async () => {
    await silentInit(dir);

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.project).toBe(path.basename(dir));
  });

  it('detects missing hook files', async () => {
    await silentInit(dir);

    await rm(path.join(dir, '.mancode', 'hooks', 'session-start.sh'), {
      force: true,
    });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.hooks.sessionStart).toBe(false);
    expect(result.hooks.userPromptSubmit).toBe(true);
    expect(result.hooks.registered).toBe(true);
  });

  it('detects when hooks are not registered in settings.json', async () => {
    await silentInit(dir);

    await writeFile(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: {} }),
      'utf-8',
    );

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.hooks.sessionStart).toBe(true);
    expect(result.hooks.userPromptSubmit).toBe(true);
    expect(result.hooks.registered).toBe(false);
  });

  it('text output contains key fields aligned with spec', async () => {
    await silentInit(dir);

    const logs = await captureLog(() => status(dir));
    const output = logs.join('\n');

    expect(output).toContain(`mancode v${VERSION}`);
    expect(output).toContain('Project:');
    expect(output).toContain('Mode:');
    expect(output).toContain('solo (default)');
    expect(output).toContain('Style:');
    expect(output).toContain('Initialized:');
    expect(output).toContain('Team:');
    expect(output).toContain('Hook injection:');
    expect(output).toContain('Installed platforms:');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Hooks:');
    expect(output).toContain('session-start.sh');
    expect(output).toContain('user-prompt-submit.sh');
    expect(output).toContain('settings.json');
  });

  it('omits top-level Hooks section for non-Claude Code projects', async () => {
    await silentInit(dir, { platform: 'codex' });

    const logs = await captureLog(() => status(dir));
    const output = logs.join('\n');

    expect(output).toContain('Platform status:');
    expect(output).toContain('Codex CLI: ready');
    expect(output).not.toContain('Hooks:');
    expect(output).not.toContain('registered in .claude/settings.json');
  });

  it('shows active workflow in JSON and text output', async () => {
    await silentInit(dir);
    const workflowMeta = await createWorkflow(
      dir,
      'active workflow task',
      'man',
    );
    const statePath = path.join(dir, '.mancode', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    state.currentMode = 'man';
    state.currentTask = workflowMeta.taskId;
    state.currentWorkflowMode = 'man';
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');

    const jsonLogs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(jsonLogs.join('\n'));
    expect(result.currentWorkflow?.taskId).toBe(workflowMeta.taskId);
    expect(result.currentWorkflow?.currentStep).toBe(1);

    const textLogs = await captureLog(() => status(dir));
    const output = textLogs.join('\n');
    expect(output).toContain('Workflow:');
    expect(output).toContain(workflowMeta.taskId);
    expect(output).toContain('Step 1/8');
  });

  it('shows manteam active workflow as an 8-step workflow', async () => {
    await silentInit(dir);
    const workflowMeta = await createWorkflow(
      dir,
      'coordinate team login',
      'manteam',
    );
    const statePath = path.join(dir, '.mancode', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    state.currentMode = 'manteam';
    state.currentTask = workflowMeta.taskId;
    state.currentWorkflowMode = 'manteam';
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');

    const jsonLogs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(jsonLogs.join('\n'));
    expect(result.currentWorkflow?.mode).toBe('manteam');

    const textLogs = await captureLog(() => status(dir));
    const output = textLogs.join('\n');
    expect(output).toContain('Workflow:');
    expect(output).toContain(workflowMeta.taskId);
    expect(output).toContain('Step 1/8');
  });

  it('returns EXIT_CORRUPT_STATE for malformed state.json', async () => {
    await mkdir(path.join(dir, '.mancode'), { recursive: true });
    await writeFile(
      path.join(dir, '.mancode', 'state.json'),
      '{ invalid json',
      'utf-8',
    );

    const code = await status(dir);
    expect(code).toBe(EXIT_CORRUPT_STATE);
  });

  it('platforms comes from config.json, not just state.json', async () => {
    await silentInit(dir);

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platforms).toContain('claude-code');
  });

  it('platforms falls back to state.platform when config.json is missing', async () => {
    await silentInit(dir);

    // 删除 config.json，迫使 fallback 到 state.json 的 platform 字段
    await rm(path.join(dir, '.mancode', 'config.json'), { force: true });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.platforms).toEqual(['claude-code']);
  });

  it('status respects --team forced mode from config/state', async () => {
    const code = await silentInit(dir, { team: true });
    expect(code).toBeUndefined();

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));
    expect(result.team.isTeam).toBe(true);
    expect(result.team.forced).toBe(true);
    expect(result.team.autoDetected).toBe(false);

    const textLogs = await captureLog(() => status(dir));
    expect(textLogs.join('\n')).toContain('Team:        forced');
  });

  it('shows per-platform installation readiness in JSON', async () => {
    await silentInit(dir);
    await install(dir, 'cursor');
    await install(dir, 'codex');
    await install(dir, 'copilot');
    await install(dir, 'zcode');

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platforms).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'copilot',
      'zcode',
    ]);
    expect(result.platformStatus['claude-code'].ready).toBe(true);
    expect(result.platformStatus.cursor.ready).toBe(true);
    expect(result.platformStatus.codex.ready).toBe(true);
    expect(result.platformStatus.copilot.ready).toBe(true);
    expect(result.platformStatus.zcode.ready).toBe(true);
    expect(result.platformStatus.cursor.target).toBe('.cursor/rules/');
  });

  it('treats Cursor minimal install as ready when core rules exist', async () => {
    await silentInit(dir);
    await install(dir, 'cursor', { force: true, minimal: true });

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus.cursor.installed).toBe(true);
    expect(result.platformStatus.cursor.ready).toBe(true);
  });

  it('does not report unrecorded platform files as ready', async () => {
    await silentInit(dir);
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      [
        '<!-- mancode:start -->',
        '# stale codex block',
        '<!-- mancode:end -->',
        '',
      ].join('\n'),
      'utf-8',
    );

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus.codex.installed).toBe(false);
    expect(result.platformStatus.codex.ready).toBe(false);
    expect(result.platformStatus.codex.detail).toContain('not recorded');
  });

  it('does not treat managed block marker examples inside fenced code as ready', async () => {
    await silentInit(dir, { platform: 'codex' });
    await writeFile(
      path.join(dir, 'AGENTS.md'),
      [
        '# User Guidance',
        '',
        '```html',
        '<!-- mancode:start -->',
        '<!-- mancode:end -->',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );

    const logs = await captureLog(() => status(dir, { json: true }));
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(result.platformStatus.codex.installed).toBe(true);
    expect(result.platformStatus.codex.ready).toBe(false);
    expect(result.platformStatus.codex.detail).toContain('missing');
  });

  it('times out hook injection estimates instead of hanging status', async () => {
    await silentInit(dir);
    await writeFile(
      path.join(dir, '.mancode', 'hooks', 'user-prompt-submit.sh'),
      '#!/usr/bin/env bash\nsleep 5\n',
      'utf-8',
    );

    const started = Date.now();
    const logs = await captureLog(() => status(dir, { json: true }));
    const elapsedMs = Date.now() - started;
    const result: StatusResult = JSON.parse(logs.join('\n'));

    expect(elapsedMs).toBeLessThan(4000);
    expect(result.hookInjection.tokens).toBe(0);
    expect(result.hookInjection.cap).toBe(800);
  });
});

/**
 * 静默执行 init，吞掉 init 的 stdout/stderr 噪音。
 *
 * status 测试只关心 init 产生的文件，不关心 init 的进度输出。
 * 如果 init 失败（返回非 0），抛出错误让测试直接挂掉——
 * 测试的前提条件没满足，没有继续的意义。
 */
async function silentInit(
  dir: string,
  options: Parameters<typeof init>[1] = {},
): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await init(dir, options);
    if (code !== 0) {
      throw new Error(`silentInit failed: init exited with ${code}`);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/**
 * 捕获 console.log 输出，测试后自动恢复。
 */
async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

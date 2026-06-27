import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_ALREADY_INITIALIZED,
  EXIT_NOT_A_PROJECT_DIR,
  EXIT_OK,
  type MancodeState,
  init,
} from '../src/commands/init.js';
import { VERSION } from '../src/version.js';

describe('mancode init', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-init-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates .mancode/state.json with default solo mode (exit 0)', async () => {
    const code = await init(dir);

    expect(code).toBe(EXIT_OK);

    const statePath = path.join(dir, '.mancode', 'state.json');
    const raw = await readFile(statePath, 'utf-8');
    const state: MancodeState = JSON.parse(raw);

    expect(state.currentMode).toBe('solo');
    expect(state.platform).toBe('claude-code');
    expect(state.version).toBe(VERSION);
    expect(state.initializedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('is idempotent — second run returns EXIT_ALREADY_INITIALIZED and does not overwrite', async () => {
    const first = await init(dir);
    const statePath = path.join(dir, '.mancode', 'state.json');
    const firstContent = await readFile(statePath, 'utf-8');

    // 等一秒确保时间戳会不同，验证不会被覆盖
    await new Promise((r) => setTimeout(r, 1100));

    const second = await init(dir);
    const secondContent = await readFile(statePath, 'utf-8');

    expect(first).toBe(EXIT_OK);
    expect(second).toBe(EXIT_ALREADY_INITIALIZED);
    expect(secondContent).toBe(firstContent);
  });

  it('returns EXIT_OK when .mancode dir already exists but no state.json', async () => {
    // 用户预先创建了 .mancode/ 但没 state.json（不应触发，但要稳）
    await mkdir(path.join(dir, '.mancode'), { recursive: true });
    const code = await init(dir);
    expect(code).toBe(EXIT_OK);

    const statePath = path.join(dir, '.mancode', 'state.json');
    const raw = await readFile(statePath, 'utf-8');
    expect(JSON.parse(raw).currentMode).toBe('solo');
  });

  it('returns EXIT_NOT_A_PROJECT_DIR when target dir is not writable', async () => {
    // 用 /dev/null/<x> 模拟"不是目录"的失败场景
    const code = await init('/dev/null/mancode-test-should-fail');
    expect(code).toBe(EXIT_NOT_A_PROJECT_DIR);
  });
});

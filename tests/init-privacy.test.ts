import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_ALREADY_INITIALIZED,
  EXIT_OK,
  EXIT_USER_CANCEL,
  init,
} from '../src/commands/init.js';
import { readPrivacyPolicyStatus } from '../src/context/privacy-policy.js';
import type { InitPrompter } from '../src/system/init-onboarding.js';
import { createTerminalPrompter } from '../src/system/init-onboarding.js';

vi.mock('node:readline/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof readline>()),
  createInterface: vi.fn(),
}));

let base: string;
let root: string;
let userHome: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'mancode-init-privacy-'));
  root = path.join(base, 'project');
  userHome = path.join(base, 'home');
  await fs.mkdir(root);
  await fs.mkdir(userHome);
  vi.spyOn(os, 'homedir').mockReturnValue(userHome);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});
const prompter = (
  select: NonNullable<InitPrompter['selectPrivacyProtection']>,
): InitPrompter => ({
  confirmGenericProject: async () => true,
  selectPlatforms: async () => ['codex'],
  resolveUnsafeAdapterPaths: async () => 'exit',
  selectPrivacyProtection: select,
});

describe('first-init privacy choices', () => {
  it.each([false, true])(
    'persists shared=%s only on first init',
    async (sharedPrivacy) => {
      expect(
        await init(root, {
          fromCli: true,
          empty: true,
          platform: 'codex',
          sharedPrivacy,
        }),
      ).toBe(EXIT_OK);
      const before = await fs.readFile(
        path.join(root, '.mancode/schema.json'),
        'utf8',
      );
      expect((await readPrivacyPolicyStatus(root)).enabled).toBe(sharedPrivacy);
      expect(
        await init(root, { fromCli: true, sharedPrivacy: !sharedPrivacy }),
      ).toBe(EXIT_ALREADY_INITIALIZED);
      expect(
        await fs.readFile(path.join(root, '.mancode/schema.json'), 'utf8'),
      ).toBe(before);
      expect((await readPrivacyPolicyStatus(root)).enabled).toBe(sharedPrivacy);
      expect(await fs.readdir(userHome)).toEqual([]);
    },
  );

  it('keeps new defaults disabled for --yes and never opens privacy questions', async () => {
    const select = vi.fn(async () => ({
      sharedPrivacy: true,
    }));
    expect(
      await init(root, {
        fromCli: true,
        empty: true,
        platform: 'codex',
        yes: true,
        interactive: true,
        prompter: prompter(select),
      }),
    ).toBe(EXIT_OK);
    expect(select).not.toHaveBeenCalled();
    expect((await readPrivacyPolicyStatus(root)).enabled).toBe(false);
    expect(await fs.readdir(userHome)).toEqual([]);
  });

  it('asks before mutation and cancellation leaves no project', async () => {
    const select = vi.fn(async () => null);
    expect(
      await init(root, {
        fromCli: true,
        empty: true,
        platform: 'codex',
        interactive: true,
        prompter: prompter(select),
      }),
    ).toBe(EXIT_USER_CANCEL);
    expect(select).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(userHome)).toEqual([]);
  });

  it('respects an explicit shared choice without prompting', async () => {
    const select = vi.fn(async () => ({
      sharedPrivacy: true,
    }));
    expect(
      await init(root, {
        fromCli: true,
        empty: true,
        platform: 'codex',
        interactive: true,
        sharedPrivacy: false,
        prompter: prompter(select),
      }),
    ).toBe(EXIT_OK);
    expect(select).not.toHaveBeenCalled();
    expect((await readPrivacyPolicyStatus(root)).enabled).toBe(false);
  });

  it.each(['zh-CN', 'en'] as const)(
    'asks only about shared protection in %s',
    async (lang) => {
      const question = vi.fn().mockResolvedValue('y');
      vi.mocked(readline.createInterface).mockReturnValue({
        question,
        close: vi.fn(),
      } as unknown as readline.Interface);
      expect(
        await init(root, {
          fromCli: true,
          empty: true,
          platform: 'codex',
          interactive: true,
          lang,
          prompter: createTerminalPrompter(),
        }),
      ).toBe(EXIT_OK);
      expect(question).toHaveBeenCalledOnce();
      expect((await readPrivacyPolicyStatus(root)).enabled).toBe(true);
      expect(await fs.readdir(userHome)).toEqual([]);
      expect(question.mock.calls[0]?.[0]).not.toMatch(/gateway|网关|API Key/i);
      expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain(
        'privacy gateway',
      );
    },
  );

  it.each(['n', '', 'q'])(
    'does not configure a gateway or print a startup command for %j',
    async (answer) => {
      const question = vi.fn().mockResolvedValue(answer);
      vi.mocked(readline.createInterface).mockReturnValue({
        question,
        close: vi.fn(),
      } as unknown as readline.Interface);
      expect(
        await init(root, {
          fromCli: true,
          empty: true,
          platform: 'codex',
          interactive: true,
          prompter: createTerminalPrompter(),
        }),
      ).toBe(answer === 'q' ? EXIT_USER_CANCEL : EXIT_OK);
      expect(question).toHaveBeenCalledOnce();
      expect(await fs.readdir(userHome)).toEqual([]);
      expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain(
        'mancode privacy gateway run',
      );
      if (answer === 'q') expect(await fs.readdir(root)).toEqual([]);
    },
  );

  it.each([true, false])(
    'does not ask another question when sharedPrivacy=%s is explicit',
    async (sharedPrivacy) => {
      const select = vi.fn(async () => null);
      expect(
        await init(root, {
          fromCli: true,
          empty: true,
          platform: 'codex',
          interactive: true,
          sharedPrivacy,
          prompter: prompter(select),
        }),
      ).toBe(EXIT_OK);
      expect(select).not.toHaveBeenCalled();
      expect((await readPrivacyPolicyStatus(root)).enabled).toBe(sharedPrivacy);
    },
  );
});

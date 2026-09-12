import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_ALREADY_INITIALIZED,
  EXIT_INIT_FAILED,
  EXIT_OK,
  EXIT_USER_CANCEL,
  init,
} from '../src/commands/init.js';
import { readPrivacyGatewayStatus } from '../src/commands/privacy-gateway.js';
import { readPrivacyPolicyStatus } from '../src/context/privacy-policy.js';
import { readGatewayConfig } from '../src/gateway/config.js';
import type { InitPrompter } from '../src/system/init-onboarding.js';

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
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'persists shared=%s gateway=%s only on first init',
    async (sharedPrivacy, gatewayPrivacy) => {
      expect(
        await init(root, {
          fromCli: true,
          empty: true,
          platform: 'codex',
          sharedPrivacy,
          gatewayPrivacy,
        }),
      ).toBe(EXIT_OK);
      const gatewayBefore = await readGatewayConfig(root);
      expect((await readPrivacyGatewayStatus(root)).enabled).toBe(
        gatewayPrivacy,
      );
      const before = await fs.readFile(
        path.join(root, '.mancode/schema.json'),
        'utf8',
      );
      expect((await readPrivacyPolicyStatus(root)).enabled).toBe(sharedPrivacy);
      expect(
        await init(root, {
          fromCli: true,
          sharedPrivacy: !sharedPrivacy,
          gatewayPrivacy: !gatewayPrivacy,
        }),
      ).toBe(EXIT_ALREADY_INITIALIZED);
      expect(
        await fs.readFile(path.join(root, '.mancode/schema.json'), 'utf8'),
      ).toBe(before);
      expect((await readPrivacyPolicyStatus(root)).enabled).toBe(sharedPrivacy);
      expect(await readGatewayConfig(root)).toEqual(gatewayBefore);
      if (!gatewayPrivacy) expect(await fs.readdir(userHome)).toEqual([]);
    },
  );

  it('keeps the initialized shared project when local gateway settings fail', async () => {
    await fs.writeFile(path.join(userHome, '.mancode'), 'not a directory');
    expect(
      await init(root, {
        fromCli: true,
        empty: true,
        platform: 'codex',
        sharedPrivacy: true,
        gatewayPrivacy: true,
      }),
    ).toBe(EXIT_INIT_FAILED);
    expect((await readPrivacyPolicyStatus(root)).enabled).toBe(true);
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, '.mancode/schema.json'), 'utf8'),
      ).activationState,
    ).toBe('v3_active');
  });

  it('keeps new defaults disabled for --yes and never opens privacy questions', async () => {
    const select = vi.fn(async () => ({
      sharedPrivacy: true,
      gatewayPrivacy: true,
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

  it('asks both choices before mutation and cancellation leaves no project', async () => {
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

  it('respects an explicit choice while asking only the unresolved scope', async () => {
    const select = vi.fn(async () => ({
      sharedPrivacy: true,
      gatewayPrivacy: false,
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
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        sharedPrivacy: false,
        gatewayPrivacy: undefined,
      }),
    );
    expect((await readPrivacyPolicyStatus(root)).enabled).toBe(false);
  });
});

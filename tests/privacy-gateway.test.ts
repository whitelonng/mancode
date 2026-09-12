import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configurePrivacyGateway,
  disablePrivacyGateway,
  printPrivacyGatewayConfig,
  readPrivacyGatewayStatus,
  registerPrivacyGatewayCommands,
  runPrivacyGateway,
} from '../src/commands/privacy-gateway.js';
import { initializeV3Project } from '../src/commands/v3-init.js';
import {
  controlProof,
  gatewayConfigDigest,
  gatewayLocation,
  readGatewayConfig,
  writePrivateJson,
} from '../src/gateway/config.js';

describe('privacy gateway command boundary', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'privacy-gateway-'));
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    await initializeV3Project({ projectRoot: root, managedAdapters: {} });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });
  it('never sends authentication to a dead record or an unproved live port', async () => {
    await configurePrivacyGateway(root, { enabled: true });
    const config = await readGatewayConfig(root);
    if (!config) throw new Error('Missing test config');
    const { directory } = await gatewayLocation(root);
    const record = {
      schemaVersion: 1,
      instanceId: '00000000-0000-4000-8000-000000000000',
      processId: 2147483647,
      port: 17641,
      scope: config.scope,
      loadedDigest: gatewayConfigDigest(config),
      startedAt: new Date().toISOString(),
    };
    await writePrivateJson(path.join(directory, 'runtime.json'), record);
    const network = vi.fn(
      async () =>
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', network);
    expect((await readPrivacyGatewayStatus(root)).runtime).toBe('stopped');
    expect(network).not.toHaveBeenCalled();
    await writePrivateJson(path.join(directory, 'runtime.json'), {
      ...record,
      processId: process.pid,
    });
    expect((await readPrivacyGatewayStatus(root)).runtime).toBe('unconfirmed');
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]?.[1]).not.toHaveProperty('headers');
  });
  it('uses only action-bound HMACs after a valid probe and detects unapplied edits', async () => {
    await configurePrivacyGateway(root, { enabled: true });
    const config = await readGatewayConfig(root);
    if (!config) throw new Error('Missing config');
    const location = await gatewayLocation(root);
    const record = {
      schemaVersion: 1,
      instanceId: '00000000-0000-4000-8000-000000000000',
      processId: process.pid,
      port: config.port,
      scope: config.scope,
      loadedDigest: gatewayConfigDigest(config),
      startedAt: new Date().toISOString(),
    };
    await writePrivateJson(
      path.join(location.directory, 'runtime.json'),
      record,
    );
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      const challenge = new URL(url).searchParams.get('challenge');
      if (challenge)
        return new Response(
          JSON.stringify({
            instanceId: record.instanceId,
            loadedDigest: record.loadedDigest,
            challenge,
            proof: controlProof(
              config.accessToken,
              record.instanceId,
              record.loadedDigest,
              challenge,
            ),
          }),
        );
      expect(init?.headers).not.toHaveProperty('authorization');
      return new Response(
        JSON.stringify({
          instanceId: record.instanceId,
          loadedDigest: record.loadedDigest,
          scope: record.scope,
          state: 'accepting',
          port: record.port,
          routeVerified: false,
          routeObservedAt: null,
          observedHostBinding: null,
        }),
      );
    });
    vi.stubGlobal('fetch', network);
    expect((await readPrivacyGatewayStatus(root)).runtime).toBe('accepting');
    expect(JSON.stringify(network.mock.calls)).not.toContain(
      config.accessToken,
    );
    await configurePrivacyGateway(root, {
      enabled: true,
      envKey: 'CHANGED_UPSTREAM_KEY',
    });
    expect((await readPrivacyGatewayStatus(root)).pendingRestart).toBe(true);
  });
  it('serializes a pending startup with disable and rejects every later stale-intent start', async () => {
    await configurePrivacyGateway(root, { enabled: true });
    let unblock: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const starter = vi.fn(async () => {
      entered();
      await barrier;
      throw new Error('synthetic startup interrupted');
    });
    const running = runPrivacyGateway(root, { startServer: starter }).catch(
      () => undefined,
    );
    await started;
    let disabled = false;
    const disabling = disablePrivacyGateway(root).then((status) => {
      disabled = true;
      return status;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(disabled).toBe(false);
    unblock();
    await running;
    expect((await disabling).enabled).toBe(false);
    await expect(
      runPrivacyGateway(root, { startServer: starter }),
    ).rejects.toThrow('DISABLED');
    expect(starter).toHaveBeenCalledTimes(1);
  });
  it('enable only records intent and disable is idempotent without a running instance', async () => {
    expect((await readPrivacyGatewayStatus(root)).configured).toBe(false);
    const enabled = await configurePrivacyGateway(root, { enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(enabled.runtime).toBe('stopped');
    expect(enabled.routeVerified).toBe(false);
    const disabled = await disablePrivacyGateway(root);
    expect(disabled.enabled).toBe(false);
    expect(disabled.runtime).toBe('stopped');
    expect(await disablePrivacyGateway(root)).toEqual(disabled);
    expect(JSON.stringify(enabled)).not.toContain('accessToken');
  });
  it('prints reviewable client fragments without exposing the token or silently applying settings', async () => {
    await configurePrivacyGateway(root, {
      enabled: true,
      upstreamId: 'openai',
      clientHost: 'codex-cli/0.153.4',
    });
    const printed = await printPrivacyGatewayConfig(root, 'codex');
    expect(printed).toContain('supports_websockets = false');
    expect(printed).toContain('MANCODE_GATEWAY_TOKEN');
    expect(printed).not.toMatch(/[a-f0-9]{64}(?:"|')/);
    await expect(printPrivacyGatewayConfig(root, 'claude')).rejects.toThrow(
      'HOST_UPSTREAM_MISMATCH',
    );
  });
  it('registers the complete consistent gateway namespace', () => {
    const privacy = new Command('privacy');
    registerPrivacyGatewayCommands(privacy);
    expect(
      privacy.commands[0]?.commands.map((command) => command.name()).sort(),
    ).toEqual(['disable', 'doctor', 'enable', 'print-config', 'run', 'status']);
  });
});

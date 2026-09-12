import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import {
  configureGateway,
  gatewayConfigDigest,
  gatewayLocation,
  readGatewayConfig,
} from '../src/gateway/config.js';

describe('private gateway configuration', () => {
  it('switches default credentials with the upstream and invalidates old host binding', async () => {
    await configureGateway(root, {
      enabled: true,
      clientHost: 'codex-cli/0.153.4',
    });
    const anthropic = await configureGateway(root, {
      enabled: true,
      upstreamId: 'anthropic',
    });
    expect(anthropic.envKey).toBe('ANTHROPIC_API_KEY');
    expect(anthropic.clientHost).toBe('unverified');
    const openai = await configureGateway(root, {
      enabled: true,
      upstreamId: 'openai',
    });
    expect(openai.envKey).toBe('OPENAI_API_KEY');
    const explicit = await configureGateway(root, {
      enabled: true,
      upstreamId: 'anthropic',
      envKey: 'CUSTOM_ANTHROPIC_KEY',
      clientHost: 'claude-code/2.1.142',
    });
    expect(explicit.envKey).toBe('CUSTOM_ANTHROPIC_KEY');
    await expect(
      configureGateway(root, {
        enabled: true,
        clientHost: 'codex-cli/0.153.4',
      }),
    ).rejects.toThrow('HOST_UPSTREAM_MISMATCH');
  });
  let root: string;
  let other: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'gateway-config-'));
    other = await mkdtemp(path.join(os.tmpdir(), 'gateway-other-'));
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    await initializeV3Project({ projectRoot: root, managedAdapters: {} });
  });
  it('rejects enabling an uninitialized directory without creating authority', async () => {
    await expect(configureGateway(other, { enabled: true })).rejects.toThrow(
      'NOT_INITIALIZED',
    );
    expect(await readGatewayConfig(other)).toBeNull();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  });
  it('persists private checkout scope with stable token across idempotent switches', async () => {
    const first = await configureGateway(root, { enabled: true });
    const again = await configureGateway(root, { enabled: true });
    const disabled = await configureGateway(root, { enabled: false });
    expect(again.accessToken).toBe(first.accessToken);
    expect(disabled.accessToken).toBe(first.accessToken);
    expect(gatewayConfigDigest(disabled)).toBe(gatewayConfigDigest(first));
    const { directory } = await gatewayLocation(root);
    expect((await stat(path.join(directory, 'config.json'))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readGatewayConfig(other)).toBeNull();
  });
  it('rejects damaged or hand-edited unknown configuration and preserves source', async () => {
    await configureGateway(root, { enabled: true });
    const { directory } = await gatewayLocation(root);
    const file = path.join(directory, 'config.json');
    const value = JSON.parse(await readFile(file, 'utf8'));
    value.upstreamId = 'https://attacker.invalid';
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await expect(readGatewayConfig(root)).rejects.toThrow('CONFIG_INVALID');
    await expect(configureGateway(root, { enabled: false })).rejects.toThrow(
      'CONFIG_INVALID',
    );
    expect(JSON.parse(await readFile(file, 'utf8')).upstreamId).toBe(
      'https://attacker.invalid',
    );
  });
});

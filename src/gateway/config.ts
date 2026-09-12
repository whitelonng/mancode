import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RULE_IDS, RULESET_VERSION } from '../privacy/rules.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { GatewayError } from './errors.js';

export const UPSTREAMS = {
  openai: {
    origin: 'https://api.openai.com',
    protocol: 'responses' as const,
    envKey: 'OPENAI_API_KEY',
  },
  anthropic: {
    origin: 'https://api.anthropic.com',
    protocol: 'messages' as const,
    envKey: 'ANTHROPIC_API_KEY',
  },
};
export type UpstreamId = keyof typeof UPSTREAMS;
export interface GatewayScope {
  principal: string;
  checkout: string;
  workspaceId: string | null;
  checkoutId: string | null;
}
export interface GatewayConfig {
  schemaVersion: 1;
  enabled: boolean;
  upstreamId: UpstreamId;
  envKey: string;
  clientHost: 'codex-cli/0.153.4' | 'claude-code/2.1.142' | 'unverified';
  accessToken: string;
  port: number;
  scope: GatewayScope;
  ruleIds: string[];
  rulesetVersion: string;
}
export interface GatewayConfigureOptions {
  enabled: boolean;
  upstreamId?: UpstreamId;
  envKey?: string;
  clientHost?: GatewayConfig['clientHost'];
  port?: number;
}
export const hashValue = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export async function gatewayLocation(
  root: string,
): Promise<{ directory: string; scope: GatewayScope }> {
  const resolved = await realpath(root);
  let workspaceId: string | null = null;
  let checkoutId: string | null = null;
  let initialized = false;
  try {
    await lstat(path.join(resolved, '.mancode'));
    initialized = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new GatewayError('MANCODE_GATEWAY_SCOPE_UNAVAILABLE');
  }
  if (initialized) {
    try {
      const runtime = await readProjectRuntimeContext(resolved);
      workspaceId = runtime.workspaceId;
      checkoutId = runtime.checkoutId;
    } catch {
      throw new GatewayError('MANCODE_GATEWAY_SCOPE_UNAVAILABLE');
    }
  }
  const physical = await lstat(resolved);
  const scope = {
    principal: hashValue(`${os.homedir()}:${process.getuid?.() ?? 'user'}`),
    checkout: hashValue(
      JSON.stringify({
        root: resolved,
        device: physical.dev,
        inode: physical.ino,
        created: physical.birthtimeMs,
        workspaceId,
        checkoutId,
      }),
    ),
    workspaceId,
    checkoutId,
  };
  return {
    directory: path.join(
      os.homedir(),
      '.mancode',
      'privacy-gateway',
      scope.checkout,
    ),
    scope,
  };
}

function assertKeys(value: Record<string, unknown>, expected: string[]): void {
  if (
    Object.keys(value).some((key) => !expected.includes(key)) ||
    expected.some((key) => !(key in value))
  )
    throw new GatewayError('MANCODE_GATEWAY_CONFIG_INVALID');
}

export function parseGatewayConfig(
  value: unknown,
  scope: GatewayScope,
): GatewayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayError('MANCODE_GATEWAY_CONFIG_INVALID');
  const config = value as Record<string, unknown>;
  assertKeys(config, [
    'schemaVersion',
    'enabled',
    'upstreamId',
    'envKey',
    'clientHost',
    'accessToken',
    'port',
    'scope',
    'ruleIds',
    'rulesetVersion',
  ]);
  if (
    config.schemaVersion !== 1 ||
    typeof config.enabled !== 'boolean' ||
    !(config.upstreamId === 'openai' || config.upstreamId === 'anthropic') ||
    typeof config.envKey !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(config.envKey) ||
    typeof config.accessToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(config.accessToken) ||
    !Number.isInteger(config.port) ||
    Number(config.port) < 1024 ||
    Number(config.port) > 65535 ||
    !['codex-cli/0.153.4', 'claude-code/2.1.142', 'unverified'].includes(
      String(config.clientHost),
    ) ||
    config.rulesetVersion !== RULESET_VERSION ||
    !Array.isArray(config.ruleIds) ||
    config.ruleIds.length === 0 ||
    config.ruleIds.some(
      (id) => typeof id !== 'string' || !DEFAULT_RULE_IDS.includes(id),
    ) ||
    new Set(config.ruleIds).size !== config.ruleIds.length
  )
    throw new GatewayError('MANCODE_GATEWAY_CONFIG_INVALID');
  const binding = config.scope as GatewayScope | undefined;
  if (
    (config.clientHost === 'codex-cli/0.153.4' &&
      config.upstreamId !== 'openai') ||
    (config.clientHost === 'claude-code/2.1.142' &&
      config.upstreamId !== 'anthropic')
  )
    throw new GatewayError('MANCODE_GATEWAY_HOST_UPSTREAM_MISMATCH');
  if (
    binding?.principal !== scope.principal ||
    binding?.checkout !== scope.checkout ||
    binding?.workspaceId !== scope.workspaceId ||
    binding?.checkoutId !== scope.checkoutId ||
    Object.keys(binding).length !== 4
  )
    throw new GatewayError('MANCODE_GATEWAY_CONFIG_SCOPE_MISMATCH');
  return { ...config, scope: { ...scope } } as unknown as GatewayConfig;
}

export async function readPrivateJson(file: string): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 64 * 1024 ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new GatewayError('MANCODE_GATEWAY_PRIVATE_FILE_UNSAFE');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('MANCODE_GATEWAY_PRIVATE_FILE_INVALID');
  } finally {
    await handle?.close();
  }
}

export async function readGatewayConfig(
  root: string,
): Promise<GatewayConfig | null> {
  const location = await gatewayLocation(root);
  const value = await readPrivateJson(
    path.join(location.directory, 'config.json'),
  );
  return value === null ? null : parseGatewayConfig(value, location.scope);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && stat.uid !== process.getuid?.())
  )
    throw new GatewayError('MANCODE_GATEWAY_PRIVATE_DIRECTORY_UNSAFE');
  await chmod(directory, 0o700);
}

export async function writePrivateJson(
  file: string,
  value: unknown,
): Promise<void> {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function configureGateway(
  root: string,
  options: GatewayConfigureOptions,
): Promise<GatewayConfig> {
  const binding = await gatewayLocation(root);
  if (!binding.scope.workspaceId || !binding.scope.checkoutId)
    throw new GatewayError('MANCODE_GATEWAY_NOT_INITIALIZED');
  return withGatewayLifecycleLock(root, async () => {
    const location = await gatewayLocation(root);
    const existing = await readGatewayConfig(root);
    const config = parseGatewayConfig(
      {
        schemaVersion: 1,
        enabled: options.enabled,
        upstreamId: options.upstreamId ?? existing?.upstreamId ?? 'openai',
        envKey:
          options.envKey ??
          (options.upstreamId && options.upstreamId !== existing?.upstreamId
            ? UPSTREAMS[options.upstreamId].envKey
            : existing?.envKey) ??
          UPSTREAMS[options.upstreamId ?? 'openai'].envKey,
        clientHost:
          options.clientHost ??
          (options.upstreamId && options.upstreamId !== existing?.upstreamId
            ? 'unverified'
            : existing?.clientHost) ??
          'unverified',
        accessToken: existing?.accessToken ?? randomBytes(32).toString('hex'),
        port: options.port ?? existing?.port ?? 17641,
        scope: location.scope,
        ruleIds: existing?.ruleIds ?? [...DEFAULT_RULE_IDS],
        rulesetVersion: RULESET_VERSION,
      },
      location.scope,
    );
    await writePrivateJson(
      path.join(location.directory, 'config.json'),
      config,
    );
    return config;
  });
}

export async function withGatewayLifecycleLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const location = await gatewayLocation(root);
  await ensurePrivateDirectory(path.dirname(location.directory));
  await ensurePrivateDirectory(location.directory);
  const lock = path.join(location.directory, 'config-locks');
  const release = await acquireConfigLock(lock);
  try {
    return await action();
  } finally {
    await release();
  }
}

/** Bakery tickets use unique owner files: recovery never removes a successor's lock. */
async function acquireConfigLock(lock: string): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(lock);
  const owner = {
    processId: process.pid,
    nonce: randomBytes(16).toString('hex'),
    choosing: true,
    ticket: 0,
  };
  const candidate = path.join(lock, `${owner.nonce}.json`);
  type Owner = typeof owner;
  const contenders = async (): Promise<Owner[]> => {
    const result: Owner[] = [];
    for (const name of await readdir(lock)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const file = path.join(lock, name);
      const current = (await readPrivateJson(file)) as Owner | null;
      if (!current) continue;
      if (
        !Number.isSafeInteger(current.processId) ||
        current.processId < 1 ||
        current.nonce !== name.slice(0, -5) ||
        typeof current.choosing !== 'boolean' ||
        !Number.isSafeInteger(current.ticket) ||
        current.ticket < 0
      )
        throw new GatewayError('MANCODE_GATEWAY_CONFIG_LOCK_UNVERIFIED');
      if (!processIsAlive(current.processId)) {
        await rm(file, { force: true });
        continue;
      }
      result.push(current);
    }
    if (result.length > 64)
      throw new GatewayError('MANCODE_GATEWAY_CONFIG_BUSY', 409);
    return result;
  };
  await writePrivateJson(candidate, owner);
  let acquired = false;
  try {
    owner.ticket =
      Math.max(0, ...(await contenders()).map((other) => other.ticket)) + 1;
    if (!Number.isSafeInteger(owner.ticket))
      throw new GatewayError('MANCODE_GATEWAY_CONFIG_BUSY', 409);
    owner.choosing = false;
    await writePrivateJson(candidate, owner);
    for (let attempt = 0; attempt < 100; attempt++) {
      const blocked = (await contenders()).some(
        (other) =>
          other.nonce !== owner.nonce &&
          (other.choosing ||
            other.ticket < owner.ticket ||
            (other.ticket === owner.ticket && other.nonce < owner.nonce)),
      );
      if (!blocked) {
        acquired = true;
        return async () => {
          await rm(candidate, { force: true });
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new GatewayError('MANCODE_GATEWAY_CONFIG_BUSY', 409);
  } finally {
    if (!acquired) await rm(candidate, { force: true });
  }
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Desired enable/disable changes do not silently replace a running stream's policy. */
export function gatewayConfigDigest(config: GatewayConfig): string {
  return hashValue(
    JSON.stringify({
      upstreamId: config.upstreamId,
      envKey: config.envKey,
      clientHost: config.clientHost,
      port: config.port,
      scope: config.scope,
      rulesetVersion: config.rulesetVersion,
      ruleIds: config.ruleIds,
      tokenBinding: hashValue(config.accessToken),
    }),
  );
}

export function constantTokenEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function controlProof(
  token: string,
  instanceId: string,
  loadedDigest: string,
  challenge: string,
  action: 'probe' | 'health' | 'stop' = 'probe',
): string {
  return createHmac('sha256', token)
    .update(
      JSON.stringify({
        purpose: 'mancode-gateway-control-v1',
        instanceId,
        loadedDigest,
        challenge,
        action,
      }),
    )
    .digest('hex');
}

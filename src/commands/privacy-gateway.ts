import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import {
  type GatewayConfig,
  type GatewayConfigureOptions,
  type GatewayScope,
  configureGateway,
  constantTokenEquals,
  controlProof,
  gatewayConfigDigest,
  gatewayLocation,
  processIsAlive,
  readGatewayConfig,
  readPrivateJson,
  withGatewayLifecycleLock,
  writePrivateJson,
} from '../gateway/config.js';
import { GatewayError, gatewayErrorCode } from '../gateway/errors.js';
import { type GatewayHealth, startGatewayServer } from '../gateway/server.js';

interface RuntimeRecord {
  schemaVersion: 1;
  instanceId: string;
  processId: number;
  port: number;
  scope: GatewayScope;
  loadedDigest: string;
  startedAt: string;
}
interface RuntimeInspection {
  state: 'stopped' | 'accepting' | 'draining' | 'unconfirmed';
  record: RuntimeRecord | null;
  health: GatewayHealth | null;
}
export interface PrivacyGatewayStatus {
  schemaVersion: 1;
  configured: boolean;
  enabled: boolean | null;
  configurationStatus: 'valid' | 'missing' | 'invalid';
  runtime: RuntimeInspection['state'];
  routeVerified: false;
  routeObservedAt: string | null;
  observedHostBinding: string | null;
  loadedDigest: string | null;
  configuredDigest: string | null;
  pendingRestart: boolean;
  scope: GatewayScope | null;
  upstreamId: string | null;
  clientHost: string | null;
  coverage: string;
  error?: string;
}

async function control(
  config: GatewayConfig,
  record: RuntimeRecord,
  action: 'health' | 'stop',
): Promise<unknown> {
  const challenge = randomBytes(32).toString('hex');
  const probe = await fetch(
    `http://127.0.0.1:${record.port}/__mancode/probe?challenge=${challenge}`,
    { signal: AbortSignal.timeout(750), redirect: 'error' },
  );
  const proof = (await readControlJson(probe, 2048)) as {
    instanceId: string;
    loadedDigest: string;
    challenge: string;
    proof: string;
  };
  if (
    proof.instanceId !== record.instanceId ||
    proof.loadedDigest !== record.loadedDigest ||
    proof.challenge !== challenge ||
    typeof proof.proof !== 'string' ||
    !constantTokenEquals(
      proof.proof,
      controlProof(
        config.accessToken,
        record.instanceId,
        record.loadedDigest,
        challenge,
      ),
    )
  )
    throw new GatewayError('MANCODE_GATEWAY_RUNTIME_UNCONFIRMED');
  const response = await fetch(
    `http://127.0.0.1:${record.port}/__mancode/${action}`,
    {
      method: action === 'stop' ? 'POST' : 'GET',
      headers: {
        'x-mancode-instance': record.instanceId,
        'x-mancode-control-nonce': challenge,
        'x-mancode-control-proof': controlProof(
          config.accessToken,
          record.instanceId,
          record.loadedDigest,
          challenge,
          action,
        ),
      },
      signal: AbortSignal.timeout(750),
      redirect: 'error',
    },
  );
  return readControlJson(response, 32 * 1024);
}

async function readControlJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  if (!response.ok || !response.body)
    throw new GatewayError('MANCODE_GATEWAY_RUNTIME_UNCONFIRMED');
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    const value = await reader.read();
    if (value.done) break;
    size += value.value.length;
    if (size > limit) {
      await reader.cancel();
      throw new GatewayError('MANCODE_GATEWAY_RUNTIME_UNCONFIRMED');
    }
    parts.push(Buffer.from(value.value));
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function inspectRuntime(
  root: string,
  config: GatewayConfig,
): Promise<RuntimeInspection> {
  const location = await gatewayLocation(root);
  const raw = await readPrivateJson(
    path.join(location.directory, 'runtime.json'),
  );
  if (raw === null) return { state: 'stopped', record: null, health: null };
  const record = raw as RuntimeRecord;
  if (
    record.schemaVersion !== 1 ||
    typeof record.instanceId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(record.instanceId) ||
    !Number.isSafeInteger(record.processId) ||
    record.processId < 1 ||
    !Number.isInteger(record.port) ||
    record.port < 1024 ||
    record.port > 65535 ||
    typeof record.loadedDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.loadedDigest) ||
    JSON.stringify(record.scope) !== JSON.stringify(config.scope)
  )
    throw new GatewayError('MANCODE_GATEWAY_RUNTIME_RECORD_INVALID');
  if (!processIsAlive(record.processId))
    return { state: 'stopped', record, health: null };
  try {
    const health = (await control(config, record, 'health')) as GatewayHealth;
    if (
      health.instanceId !== record.instanceId ||
      health.loadedDigest !== record.loadedDigest ||
      JSON.stringify(health.scope) !== JSON.stringify(record.scope) ||
      health.port !== record.port ||
      !['accepting', 'draining'].includes(health.state) ||
      health.routeVerified !== false
    )
      throw new GatewayError('MANCODE_GATEWAY_RUNTIME_SCOPE_MISMATCH');
    return { state: health.state, record, health };
  } catch {
    return {
      state: processIsAlive(record.processId) ? 'unconfirmed' : 'stopped',
      record,
      health: null,
    };
  }
}

export async function readPrivacyGatewayStatus(
  root: string = process.cwd(),
): Promise<PrivacyGatewayStatus> {
  const empty: PrivacyGatewayStatus = {
    schemaVersion: 1,
    configured: false,
    enabled: false,
    configurationStatus: 'missing',
    runtime: 'stopped',
    routeVerified: false,
    routeObservedAt: null,
    observedHostBinding: null,
    loadedDigest: null,
    configuredDigest: null,
    pendingRestart: false,
    scope: null,
    upstreamId: null,
    clientHost: null,
    coverage:
      'Responses/Anthropic Messages HTTP/SSE text only; opaque thinking/signature/encrypted blocks excluded; unsupported executable tool restoration blocked',
  };
  try {
    const config = await readGatewayConfig(root);
    if (!config) return empty;
    const runtime = await inspectRuntime(root, config);
    const configuredDigest = gatewayConfigDigest(config);
    return {
      ...empty,
      configured: true,
      enabled: config.enabled,
      configurationStatus: 'valid',
      runtime: runtime.state,
      configuredDigest,
      loadedDigest: runtime.health?.loadedDigest ?? null,
      pendingRestart: Boolean(
        runtime.health && runtime.health.loadedDigest !== configuredDigest,
      ),
      routeObservedAt: runtime.health?.routeObservedAt ?? null,
      observedHostBinding: runtime.health?.observedHostBinding ?? null,
      scope: config.scope,
      upstreamId: config.upstreamId,
      clientHost: config.clientHost,
    };
  } catch (error) {
    return {
      ...empty,
      enabled: null,
      configurationStatus: 'invalid',
      runtime: 'unconfirmed',
      error: gatewayErrorCode(error),
    };
  }
}

/** Used after successful first initialization; this records intent only. */
export async function configurePrivacyGateway(
  root: string,
  options: GatewayConfigureOptions,
): Promise<PrivacyGatewayStatus> {
  await configureGateway(root, options);
  return readPrivacyGatewayStatus(root);
}

export async function disablePrivacyGateway(
  root: string,
): Promise<PrivacyGatewayStatus> {
  const config = await readGatewayConfig(root);
  if (!config) return readPrivacyGatewayStatus(root);
  await configureGateway(root, { enabled: false });
  const runtime = await inspectRuntime(root, config);
  if (runtime.health && runtime.record) {
    const stopped = (await control(config, runtime.record, 'stop')) as {
      instanceId?: string;
    };
    if (stopped.instanceId !== runtime.record.instanceId)
      throw new GatewayError('MANCODE_GATEWAY_RUNTIME_SCOPE_MISMATCH');
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await readPrivacyGatewayStatus(root);
      if (status.runtime === 'stopped') return status;
    }
  }
  return readPrivacyGatewayStatus(root);
}

async function verifyInstalledHost(config: GatewayConfig): Promise<string> {
  if (config.clientHost === 'unverified') return 'unverified';
  const executable = config.clientHost.startsWith('codex-cli/')
    ? 'codex'
    : 'claude';
  try {
    const result = await promisify(execFile)(executable, ['--version'], {
      timeout: 5000,
      maxBuffer: 16 * 1024,
    });
    const actual =
      executable === 'codex'
        ? /codex-cli (\d+\.\d+\.\d+)/.exec(result.stdout)?.[1]
        : /^(\d+\.\d+\.\d+) \(Claude Code\)/.exec(result.stdout)?.[1];
    if (actual !== config.clientHost.split('/')[1])
      throw new GatewayError('MANCODE_GATEWAY_HOST_VERSION_UNVERIFIED');
    return config.clientHost;
  } catch {
    throw new GatewayError('MANCODE_GATEWAY_HOST_VERSION_UNVERIFIED');
  }
}

export async function runPrivacyGateway(
  root: string,
  dependencies: { startServer?: typeof startGatewayServer } = {},
): Promise<void> {
  const binding = await gatewayLocation(root);
  if (!binding.scope.workspaceId || !binding.scope.checkoutId)
    throw new GatewayError('MANCODE_GATEWAY_NOT_INITIALIZED');
  const { config, server, file } = await withGatewayLifecycleLock(
    root,
    async () => {
      const config = await readGatewayConfig(root);
      if (!config?.enabled) throw new GatewayError('MANCODE_GATEWAY_DISABLED');
      await verifyInstalledHost(config);
      const runtime = await inspectRuntime(root, config);
      if (runtime.state !== 'stopped')
        throw new GatewayError(
          'MANCODE_GATEWAY_ALREADY_RUNNING_OR_UNCONFIRMED',
        );
      const location = await gatewayLocation(root);
      const server = await (dependencies.startServer ?? startGatewayServer)(
        config,
      );
      const record: RuntimeRecord = {
        schemaVersion: 1,
        instanceId: server.instanceId,
        processId: process.pid,
        port: server.port,
        scope: config.scope,
        loadedDigest: gatewayConfigDigest(config),
        startedAt: new Date().toISOString(),
      };
      const file = path.join(location.directory, 'runtime.json');
      try {
        await writePrivateJson(file, record);
      } catch (error) {
        await server.stop();
        throw error;
      }
      return { config, server, file };
    },
  );
  const stop = (): void => {
    void server.stop();
  };
  try {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdout.write(
      `${JSON.stringify({ gateway: 'running', ...server.health(), clientHost: config.clientHost, note: 'Dedicated checkout instance. Route verification requires current client evidence. No client configuration was changed.' })}\n`,
    );
    await server.closed;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await server.stop();
    const current = (await readPrivateJson(file)) as RuntimeRecord | null;
    if (current?.instanceId === server.instanceId)
      await rm(file, { force: true });
  }
}

export async function printPrivacyGatewayConfig(
  root: string,
  host: string,
): Promise<string> {
  const config = await readGatewayConfig(root);
  if (!config) throw new GatewayError('MANCODE_GATEWAY_NOT_CONFIGURED');
  const { directory } = await gatewayLocation(root);
  const note = `# Review before applying. Read accessToken from the private file ${path.join(directory, 'config.json')}.\n# Put it in MANCODE_GATEWAY_TOKEN for this shell only. No credentials are printed here.\n# Only this checkout is covered; no desktop, subscription, or cloud routing claim.\n`;
  if (host === 'codex') {
    if (config.upstreamId !== 'openai')
      throw new GatewayError('MANCODE_GATEWAY_HOST_UPSTREAM_MISMATCH');
    return `${note}# User-level Codex configuration fragment; choose this provider explicitly.\n[model_providers.mancode_privacy]\nname = "mancode privacy"\nbase_url = "http://127.0.0.1:${config.port}/v1"\nwire_api = "responses"\nenv_key = "MANCODE_GATEWAY_TOKEN"\nsupports_websockets = false\nhttp_headers = { "X-Mancode-Host" = "${config.clientHost}" }\n`;
  }
  if (host === 'claude') {
    if (config.upstreamId !== 'anthropic')
      throw new GatewayError('MANCODE_GATEWAY_HOST_UPSTREAM_MISMATCH');
    return `${note}# Shell fragment for an explicit Claude Code API-key session.\nexport ANTHROPIC_BASE_URL='http://127.0.0.1:${config.port}'\nexport ANTHROPIC_API_KEY="$MANCODE_GATEWAY_TOKEN"\nexport ANTHROPIC_CUSTOM_HEADERS='X-Mancode-Host: ${config.clientHost}'\n# Run the gateway in a separate shell with the real upstream env-key reference.\n`;
  }
  throw new GatewayError('MANCODE_GATEWAY_HOST_UNSUPPORTED');
}

export function registerPrivacyGatewayCommands(privacy: Command): void {
  const gateway = privacy
    .command('gateway')
    .description('Configure and run the optional private local model gateway');
  const execute = (action: () => Promise<unknown>): Promise<void> =>
    action()
      .then((value) => {
        if (value !== undefined)
          process.stdout.write(
            `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`,
          );
      })
      .catch((error) => {
        process.stderr.write(
          `${JSON.stringify({ error: gatewayErrorCode(error) })}\n`,
        );
        process.exitCode = 2;
      });
  gateway
    .command('enable')
    .description('Record intent; does not start or reroute a client')
    .option('--upstream <id>', 'openai or anthropic')
    .option(
      '--env-key <name>',
      'Reference to the upstream key environment variable',
    )
    .option(
      '--client-host <host>',
      'codex-cli/0.153.4, claude-code/2.1.142, or unverified',
    )
    .option('--port <port>', 'Loopback port, 1024–65535')
    .option('--json')
    .action((options) =>
      execute(() =>
        configurePrivacyGateway(process.cwd(), {
          enabled: true,
          upstreamId: options.upstream,
          envKey: options.envKey,
          clientHost: options.clientHost,
          port: options.port === undefined ? undefined : Number(options.port),
        }),
      ),
    );
  gateway
    .command('disable')
    .description(
      'Stop new requests and drain the current instance; never enable plaintext forwarding',
    )
    .option('--json')
    .action(() => execute(() => disablePrivacyGateway(process.cwd())));
  gateway
    .command('status')
    .description('Read configured intent and authenticated runtime evidence')
    .option('--json')
    .action(() => execute(() => readPrivacyGatewayStatus()));
  gateway
    .command('doctor')
    .description(
      'Read local runtime and installed host version; does not call a model',
    )
    .option('--json')
    .action(() =>
      execute(async () => {
        const status = await readPrivacyGatewayStatus();
        const config = await readGatewayConfig(process.cwd());
        let hostVersion = 'unverified';
        if (config) {
          try {
            hostVersion = await verifyInstalledHost(config);
          } catch {
            hostVersion = 'version-mismatch-or-unavailable';
          }
        }
        return {
          ...status,
          installedHost: hostVersion,
          upstreamKeyPresent: Boolean(config && process.env[config.envKey]),
          routeVerified: false,
        };
      }),
    );
  gateway
    .command('run')
    .description('Run one dedicated checkout instance in the foreground')
    .action(() => execute(() => runPrivacyGateway(process.cwd())));
  gateway
    .command('print-config')
    .description(
      'Print a reviewable fragment without credentials or applying it',
    )
    .requiredOption('--host <host>', 'codex or claude')
    .action((options) =>
      execute(() => printPrivacyGatewayConfig(process.cwd(), options.host)),
    );
}

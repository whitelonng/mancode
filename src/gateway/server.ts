import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import {
  type GatewayConfig,
  UPSTREAMS,
  constantTokenEquals,
  controlProof,
  gatewayConfigDigest,
  hashValue,
} from './config.js';
import type { AuditSummary } from './engine.js';
import { GatewayError, gatewayErrorCode } from './errors.js';
import type { TransformResult } from './protocol.js';
import { SseDecoder, type SseFrame, encodeSse } from './sse.js';
import { GatewayWorker } from './worker-client.js';

export const GATEWAY_LIMITS = {
  requestBytes: 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  streamBytes: 16 * 1024 * 1024,
  concurrentRequests: 8,
  idleMs: 30_000,
  generationMs: 300_000,
  drainMs: 5000,
};
export interface GatewayHealth {
  instanceId: string;
  loadedDigest: string;
  scope: GatewayConfig['scope'];
  state: 'accepting' | 'draining';
  port: number;
  activeRequests: number;
  routeVerified: false;
  routeObservedAt: string | null;
  observedHostBinding: string | null;
  coverage: 'text-only-with-opaque-exclusions';
  opaqueBlocks: number;
  lastAudit: AuditSummary | null;
  history: 'memory-only; restart invalidates previous_response_id';
}
export interface GatewayServer {
  port: number;
  instanceId: string;
  health(): GatewayHealth;
  stop(): Promise<void>;
  closed: Promise<void>;
}
export interface GatewayServerDependencies {
  /** Test injection only; never read from configuration, headers, or CLI. */
  fetchUpstream?: typeof fetch;
  workerUrl?: URL;
  upstreamKey?: string;
  drainMs?: number;
  onDiagnostic?: (code: string) => void;
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<string> {
  const length = request.headers['content-length'];
  if (
    length &&
    (!/^\d+$/.test(length) || Number(length) > GATEWAY_LIMITS.requestBytes)
  )
    throw new GatewayError('MANCODE_GATEWAY_REQUEST_LIMIT', 413);
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    total += chunk.length;
    if (total > GATEWAY_LIMITS.requestBytes)
      throw new GatewayError('MANCODE_GATEWAY_REQUEST_LIMIT', 413);
    parts.push(chunk);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(parts),
    );
  } catch {
    throw new GatewayError('MANCODE_GATEWAY_INVALID_UTF8');
  }
}

async function emit(
  response: ServerResponse,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!response.write(text)) await once(response, 'drain', { signal });
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(error instanceof GatewayError ? error.status : 502, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(
    JSON.stringify({
      error: {
        code: gatewayErrorCode(error),
        message:
          'Gateway request was not forwarded or could not be completed safely.',
      },
    }),
  );
}

export async function startGatewayServer(
  config: GatewayConfig,
  dependencies: GatewayServerDependencies = {},
): Promise<GatewayServer> {
  if (!config.enabled) throw new GatewayError('MANCODE_GATEWAY_DISABLED', 503);
  const upstream = UPSTREAMS[config.upstreamId];
  const upstreamKey = dependencies.upstreamKey ?? process.env[config.envKey];
  if (!upstreamKey || /[\r\n]/.test(upstreamKey))
    throw new GatewayError('MANCODE_GATEWAY_UPSTREAM_KEY_UNAVAILABLE', 503);
  const instanceId = randomUUID();
  const loadedDigest = gatewayConfigDigest(config);
  const worker = new GatewayWorker(
    hashValue(
      JSON.stringify({
        scope: config.scope,
        instanceId,
        upstream: config.upstreamId,
        loadedDigest,
      }),
    ),
    config.ruleIds,
    config.clientHost,
    dependencies.workerUrl,
  );
  const fetchUpstream = dependencies.fetchUpstream ?? fetch;
  const active = new Set<AbortController>();
  let draining = false;
  let port = config.port;
  let routeObservedAt: string | null = null;
  let observedHostBinding: string | null = null;
  let opaqueBlocks = 0;
  let lastAudit: AuditSummary | null = null;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let stopping: Promise<void> | undefined;
  const health = (): GatewayHealth => ({
    instanceId,
    loadedDigest,
    scope: config.scope,
    state: draining ? 'draining' : 'accepting',
    port,
    activeRequests: active.size,
    routeVerified: false,
    routeObservedAt,
    observedHostBinding,
    coverage: 'text-only-with-opaque-exclusions',
    opaqueBlocks,
    lastAudit,
    history: 'memory-only; restart invalidates previous_response_id',
  });
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: GATEWAY_LIMITS.idleMs,
      headersTimeout: 10_000,
    },
    (request, response) => {
      void handle(request, response).catch((error) =>
        errorResponse(response, error),
      );
    },
  );
  server.maxConnections = 24;
  server.keepAliveTimeout = 5000;
  server.on('upgrade', (_request, socket) => {
    socket.end(
      'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
  server.on('connect', (_request, socket) => {
    socket.end(
      'HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
  server.on('clientError', (_error, socket) => {
    socket.end(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    draining = true;
    stopping = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const controller of active) controller.abort();
        server.closeAllConnections();
      }, dependencies.drainMs ?? GATEWAY_LIMITS.drainMs);
      server.close(() => {
        clearTimeout(timer);
        void worker.close().finally(() => {
          resolve();
          resolveClosed();
        });
      });
      server.closeIdleConnections();
    });
    return stopping;
  };
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      request.headers.host !== `127.0.0.1:${port}` ||
      request.headers.origin !== undefined ||
      request.url?.startsWith('http')
    )
      throw new GatewayError('MANCODE_GATEWAY_HOST_REJECTED', 403);
    const challenge =
      request.method === 'GET'
        ? /^\/__mancode\/probe\?challenge=([a-f0-9]{64})$/.exec(
            request.url ?? '',
          )?.[1]
        : undefined;
    if (challenge) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(
        JSON.stringify({
          instanceId,
          loadedDigest,
          challenge,
          proof: controlProof(
            config.accessToken,
            instanceId,
            loadedDigest,
            challenge,
          ),
        }),
      );
      return;
    }
    const authorization =
      request.headers.authorization ??
      (typeof request.headers['x-api-key'] === 'string'
        ? `Bearer ${request.headers['x-api-key']}`
        : '');
    const controlAction =
      request.method === 'GET' && request.url === '/__mancode/health'
        ? 'health'
        : request.method === 'POST' && request.url === '/__mancode/stop'
          ? 'stop'
          : undefined;
    const nonce = request.headers['x-mancode-control-nonce'];
    const proof = request.headers['x-mancode-control-proof'];
    const provedControl =
      controlAction &&
      request.headers['x-mancode-instance'] === instanceId &&
      typeof nonce === 'string' &&
      /^[a-f0-9]{64}$/.test(nonce) &&
      typeof proof === 'string' &&
      constantTokenEquals(
        proof,
        controlProof(
          config.accessToken,
          instanceId,
          loadedDigest,
          nonce,
          controlAction,
        ),
      );
    if (
      !provedControl &&
      !constantTokenEquals(authorization, `Bearer ${config.accessToken}`)
    )
      throw new GatewayError('MANCODE_GATEWAY_AUTH_REQUIRED', 401);
    if (request.method === 'GET' && request.url === '/__mancode/health') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(health()));
      return;
    }
    if (request.method === 'POST' && request.url === '/__mancode/stop') {
      draining = true;
      response.writeHead(202, {
        'content-type': 'application/json',
        connection: 'close',
      });
      response.end(JSON.stringify({ instanceId, state: 'draining' }));
      setImmediate(() => {
        void stop();
      });
      return;
    }
    if (draining) throw new GatewayError('MANCODE_GATEWAY_DRAINING', 503);
    const metadata =
      request.method === 'GET' &&
      /^\/v1\/models(?:\?client_version=\d+\.\d+\.\d+)?$/.test(
        request.url ?? '',
      );
    const generationPath =
      upstream.protocol === 'responses'
        ? request.url === '/v1/responses'
        : request.url === '/v1/messages' ||
          request.url === '/v1/messages?beta=true';
    if (!metadata && (request.method !== 'POST' || !generationPath))
      throw new GatewayError('MANCODE_GATEWAY_PATH_UNSUPPORTED', 404);
    if (
      request.headers['content-encoding'] &&
      request.headers['content-encoding'] !== 'identity'
    )
      throw new GatewayError('MANCODE_GATEWAY_ENCODING_UNSUPPORTED', 415);
    if (
      !metadata &&
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        request.headers['content-type'] ?? '',
      )
    )
      throw new GatewayError('MANCODE_GATEWAY_CONTENT_TYPE_UNSUPPORTED', 415);
    if (active.size >= GATEWAY_LIMITS.concurrentRequests)
      throw new GatewayError('MANCODE_GATEWAY_CONCURRENCY_LIMIT', 429);
    const controller = new AbortController();
    active.add(controller);
    const id = randomUUID();
    const timer = setTimeout(
      () => controller.abort(),
      GATEWAY_LIMITS.generationMs,
    );
    request.setTimeout(GATEWAY_LIMITS.idleMs, () => {
      controller.abort();
      request.destroy();
    });
    response.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    let began = false;
    try {
      const headers: Record<string, string> = {
        accept: 'application/json, text/event-stream',
        'accept-encoding': 'identity',
      };
      if (config.upstreamId === 'openai')
        headers.authorization = `Bearer ${upstreamKey}`;
      else {
        headers['x-api-key'] = upstreamKey as string;
        const version = request.headers['anthropic-version'];
        if (
          version !== undefined &&
          (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version))
        )
          throw new GatewayError('MANCODE_GATEWAY_HEADER_UNSUPPORTED');
        headers['anthropic-version'] =
          typeof version === 'string' ? version : '2023-06-01';
        const beta = request.headers['anthropic-beta'];
        if (beta !== undefined) {
          if (typeof beta !== 'string' || !/^[a-z0-9, -]{1,512}$/.test(beta))
            throw new GatewayError('MANCODE_GATEWAY_HEADER_UNSUPPORTED');
          headers['anthropic-beta'] = beta;
        }
      }
      let body: string | undefined;
      if (!metadata) {
        const input = await readBody(request, controller.signal);
        const masked = await worker.call<TransformResult>({
          kind: 'begin',
          id,
          body: input,
          protocol: upstream.protocol,
        });
        began = true;
        controller.signal.throwIfAborted();
        body = masked.body;
        opaqueBlocks += masked.opaqueBlocks;
        headers['content-type'] = 'application/json';
      } else if (
        request.headers['content-length'] ||
        request.headers['transfer-encoding']
      )
        throw new GatewayError('MANCODE_GATEWAY_METADATA_BODY_REJECTED');
      const upstreamResponse = await fetchUpstream(
        `${upstream.origin}${request.url}`,
        {
          method: request.method,
          headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
        },
      );
      if (!upstreamResponse.ok || !upstreamResponse.body)
        throw new GatewayError('MANCODE_GATEWAY_UPSTREAM_REJECTED', 502);
      const encoding = upstreamResponse.headers.get('content-encoding');
      if (encoding && encoding !== 'identity')
        throw new GatewayError('MANCODE_GATEWAY_ENCODING_UNSUPPORTED', 502);
      const contentType = upstreamResponse.headers.get('content-type') ?? '';
      if (!metadata) {
        routeObservedAt = new Date().toISOString();
        observedHostBinding =
          request.headers['x-mancode-host'] === config.clientHost
            ? config.clientHost
            : 'unverified-client';
      }
      const reader = upstreamResponse.body.getReader();
      let total = 0;
      const parts: Buffer[] = [];
      const decoder = new SseDecoder();
      const streaming =
        !metadata && /^text\/event-stream(?:;|$)/i.test(contentType);
      if (!streaming && !/^application\/json(?:;|$)/i.test(contentType))
        throw new GatewayError(
          'MANCODE_GATEWAY_UPSTREAM_CONTENT_UNSUPPORTED',
          502,
        );
      if (streaming)
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'x-mancode-coverage': 'text-only; opaque-blocks-excluded',
        });
      for (;;) {
        const idle = setTimeout(
          () => controller.abort(),
          GATEWAY_LIMITS.idleMs,
        );
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } finally {
          clearTimeout(idle);
        }
        controller.signal.throwIfAborted();
        if (result.done) break;
        total += result.value.length;
        if (
          total >
          (streaming
            ? GATEWAY_LIMITS.streamBytes
            : GATEWAY_LIMITS.responseBytes)
        )
          throw new GatewayError('MANCODE_GATEWAY_RESPONSE_LIMIT', 502);
        if (!streaming) parts.push(Buffer.from(result.value));
        else
          for (const frame of decoder.push(result.value)) {
            const transformed = await worker.call<{
              frames: SseFrame[];
              opaqueBlocks: number;
            }>({ kind: 'frame', id, frame });
            opaqueBlocks = Math.max(opaqueBlocks, transformed.opaqueBlocks);
            for (const output of transformed.frames)
              await emit(response, encodeSse(output), controller.signal);
          }
      }
      if (streaming) {
        decoder.push(new Uint8Array(), true);
        const finished = await worker.call<{ audit: AuditSummary }>({
          kind: 'finish',
          id,
        });
        lastAudit = finished.audit;
        response.end();
      } else {
        let original: string;
        try {
          original = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(parts),
          );
        } catch {
          throw new GatewayError('MANCODE_GATEWAY_INVALID_UTF8', 502);
        }
        const output = metadata
          ? { body: original, audit: null }
          : await worker.call<TransformResult & { audit: AuditSummary }>({
              kind: 'response',
              id,
              body: original,
            });
        lastAudit = output.audit;
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-mancode-coverage': metadata
            ? 'metadata-endpoint'
            : 'text-only; opaque-blocks-excluded',
        });
        response.end(output.body);
      }
    } catch (error) {
      dependencies.onDiagnostic?.(gatewayErrorCode(error));
      controller.abort();
      errorResponse(response, error);
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      if (began) await worker.call({ kind: 'release', id }).catch(() => {});
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new GatewayError('MANCODE_GATEWAY_BIND_FAILED', 503);
    port = address.port;
    return { port, instanceId, health, stop, closed };
  } catch {
    await worker.close();
    throw new GatewayError('MANCODE_GATEWAY_BIND_FAILED', 503);
  }
}

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../src/gateway/config.js';
import {
  type GatewayServer,
  startGatewayServer,
} from '../src/gateway/server.js';
import { DEFAULT_RULE_IDS, RULESET_VERSION } from '../src/privacy/rules.js';

const config: GatewayConfig = {
  schemaVersion: 1,
  enabled: true,
  upstreamId: 'openai',
  envKey: 'SYNTHETIC_KEY',
  clientHost: 'unverified',
  accessToken: 'a'.repeat(64),
  port: 0,
  scope: { principal: 'p', checkout: 'c', workspaceId: null, checkoutId: null },
  ruleIds: [...DEFAULT_RULE_IDS],
  rulesetVersion: RULESET_VERSION,
};
describe('authenticated gateway server', () => {
  let directory: string;
  let workerUrl: URL;
  const servers: GatewayServer[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-worker-'));
    const outfile = path.join(directory, 'worker.mjs');
    await build({
      entryPoints: ['src/gateway/worker.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      mainFields: ['module', 'main'],
    });
    workerUrl = pathToFileURL(outfile);
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function start(
    fetchUpstream: typeof fetch,
    options: Partial<GatewayConfig> = {},
  ) {
    const server = await startGatewayServer(
      { ...config, ...options },
      {
        fetchUpstream,
        workerUrl,
        upstreamKey: 'synthetic-upstream',
        drainMs: 50,
      },
    );
    servers.push(server);
    return server;
  }
  const headers = {
    authorization: `Bearer ${config.accessToken}`,
    'content-type': 'application/json',
  };
  it('masks upstream JSON, restores response and exposes authenticated honest status', async () => {
    let sent = '';
    let upstreamAuth = '';
    const server = await start(async (_url, init) => {
      sent = String(init?.body);
      upstreamAuth = (init?.headers as Record<string, string>).authorization;
      return new Response(
        JSON.stringify({
          id: 'resp_a',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.parse(sent).input }],
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/responses`,
      {
        method: 'POST',
        headers,
        body: '{"model":"m","input":"alice@example.com"}',
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('alice@example.com');
    expect(sent).not.toContain('alice@example.com');
    expect(upstreamAuth).toBe('Bearer synthetic-upstream');
    const health = await (
      await fetch(`http://127.0.0.1:${server.port}/__mancode/health`, {
        headers,
      })
    ).json();
    expect(health.routeVerified).toBe(false);
    expect(health.routeObservedAt).not.toBeNull();
    expect(JSON.stringify(health)).not.toContain('alice@example.com');
  });
  it('rejects invalid host/auth/path/encoding and unsafe content before upstream access', async () => {
    let calls = 0;
    const server = await start(async () => {
      calls++;
      return new Response('{}');
    });
    for (const options of [
      { headers: { ...headers, authorization: 'Bearer wrong' } },
      { headers: { ...headers, origin: 'http://attacker.invalid' } },
      { headers: { ...headers, 'content-encoding': 'gzip' } },
      { route: '/v1/responses/compact' },
      { route: '/v1/responses?redirect=https://attacker.invalid' },
      {
        body: '{"model":"m","input":[{"role":"user","content":[{"type":"input_image"}]}]}',
      },
      { body: '{"model":"m","input":"one","input":"two"}' },
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${server.port}${options.route ?? '/v1/responses'}`,
        {
          method: 'POST',
          headers: options.headers ?? headers,
          body: options.body ?? '{"model":"m","input":"hello"}',
        },
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.text();
    }
    expect(calls).toBe(0);
  });
  it.each(['responses', 'messages'] as const)(
    'keeps every word of a quoted credential from the %s upstream and restores the client response',
    async (protocol) => {
      const source =
        'client_password="synthetic alpha omega"; DB_PASSWORD=synthetic-other; token_count=12';
      let sent = '';
      const server = await start(
        async (_url, init) => {
          sent = String(init?.body);
          const request = JSON.parse(sent);
          const text =
            protocol === 'responses'
              ? request.input
              : request.messages[0].content;
          const body =
            protocol === 'responses'
              ? {
                  id: 'resp_secret',
                  output: [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text }],
                    },
                  ],
                }
              : {
                  id: 'msg_secret',
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'text', text }],
                };
          return new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
          });
        },
        { upstreamId: protocol === 'responses' ? 'openai' : 'anthropic' },
      );
      const request =
        protocol === 'responses'
          ? { model: 'm', input: source }
          : {
              model: 'm',
              messages: [{ role: 'user', content: source }],
              max_tokens: 32,
            };
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v1/${protocol}`,
        { method: 'POST', headers, body: JSON.stringify(request) },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(
        protocol === 'responses'
          ? body.output[0].content[0].text
          : body.content[0].text,
      ).toBe(source);
      for (const word of ['synthetic', 'alpha', 'omega'])
        expect(sent).not.toContain(word);
      expect(sent).toContain('token_count=12');
    },
  );
  it('does not follow redirects or reveal upstream errors', async () => {
    const server = await start(async (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response('sensitive upstream diagnostic', {
        status: 302,
        headers: { location: 'https://attacker.invalid' },
      });
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/responses`,
      { method: 'POST', headers, body: '{"model":"m","input":"hello"}' },
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(
      'sensitive upstream diagnostic',
    );
  });
  it('accepts bounded 1 MiB bodies and rejects overflow without blocking the network loop', async () => {
    let id = 0;
    const server = await start(
      async () =>
        new Response(JSON.stringify({ id: `resp_${++id}`, output: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const body = JSON.stringify({
      model: 'm',
      input: 'plain '.repeat(170_000),
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
          method: 'POST',
          headers,
          body,
        }),
      ),
    );
    expect(responses.map((item) => item.status)).toEqual(Array(8).fill(200));
    await Promise.all(responses.map((item) => item.text()));
    const large = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'm', input: 'x'.repeat(1024 * 1024) }),
    }).catch(() => null);
    expect(large === null || large.status === 413).toBe(true);
    await large?.text();
  }, 20_000);
  it('disable drains with a fixed deadline and cancels upstream; no plaintext listener remains', async () => {
    let aborted = false;
    const server = await start(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                Buffer.from(
                  'event: response.created\ndata: {"type":"response.created","response":{"id":"r","output":[]}}\n\n',
                ),
              );
              init?.signal?.addEventListener('abort', () => {
                aborted = true;
                controller.error(new Error('cancelled'));
              });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/responses`,
      {
        method: 'POST',
        headers,
        body: '{"model":"m","input":"hello","stream":true}',
      },
    );
    const reading = response.text().catch(() => 'cancelled');
    const stop = await fetch(`http://127.0.0.1:${server.port}/__mancode/stop`, {
      method: 'POST',
      headers,
    });
    expect(stop.status).toBe(202);
    await stop.text();
    await server.closed;
    expect(await reading).toBe('cancelled');
    expect(aborted).toBe(true);
    await expect(
      fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: 'POST',
        headers,
        body: '{}',
      }),
    ).rejects.toThrow();
  });
});

// Installed hosts -> current gateway implementation -> in-memory synthetic upstream.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(os.tmpdir(), 'mancode-gateway-spike-'));
const canary = 'gateway.canary@example.com';
const results = [];
const gatewayModule = path.join(directory, 'gateway.mjs');
const workerModule = path.join(directory, 'worker.mjs');
await Promise.all([build({ entryPoints: ['src/gateway/server.ts'], outfile: gatewayModule, bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'] }), build({ entryPoints: ['src/gateway/worker.ts'], outfile: workerModule, bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'] })]);
const { startGatewayServer } = await import(pathToFileURL(gatewayModule));
// Build the rules module so this probe uses the same current default rules.
const ruleModule = path.join(directory, 'rules.mjs');
await build({ entryPoints: ['src/privacy/rules.ts'], outfile: ruleModule, bundle: true, platform: 'node', format: 'esm' });
const { DEFAULT_RULE_IDS, RULESET_VERSION } = await import(pathToFileURL(ruleModule));
const base = { schemaVersion: 1, enabled: true, upstreamId: 'openai', envKey: 'SYNTHETIC_UPSTREAM_KEY', clientHost: 'unverified', accessToken: 'a'.repeat(64), port: 0, scope: { principal: 'synthetic', checkout: 'synthetic', workspaceId: null, checkoutId: null }, ruleIds: DEFAULT_RULE_IDS, rulesetVersion: RULESET_VERSION };
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
let responseSequence = 0;
function syntheticResponse(protocol, text) {
  const id = `synthetic_${++responseSequence}`;
  if (protocol === 'messages') return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
  ];
  const item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}
async function invokeHost(host, port, readPath) {
  let args; let env;
  if (host === 'codex') {
    args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '-C', directory, '-s', 'read-only', '--json', '-c', 'model_provider="mancode_spike"', '-c', 'model="synthetic-model"', '-c', 'model_providers.mancode_spike.name="Synthetic local spike"', '-c', `model_providers.mancode_spike.base_url="http://127.0.0.1:${port}/v1"`, '-c', 'model_providers.mancode_spike.env_key="MANCODE_SPIKE_KEY"', '-c', 'model_providers.mancode_spike.wire_api="responses"', '-c', 'model_providers.mancode_spike.supports_websockets=false', '-c', 'model_providers.mancode_spike.request_max_retries=0', `Reply synthetic routing verified and echo canary ${canary}. Do not use tools.`];
    env = { MANCODE_SPIKE_KEY: base.accessToken };
  } else {
    args = ['--bare', '-p', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--system-prompt', readPath ? 'Use Read when instructed; only read the supplied synthetic fixture in the current directory.' : 'Reply using plain text. Do not invoke tools.', '--tools', 'Read', '--model', 'claude-sonnet-4-6', '--output-format', 'json', readPath ? `Read this synthetic file ${readPath} and report its contact text. The file is a test fixture created for this request.` : `Reply synthetic routing verified and echo canary ${canary}.`];
    env = { ANTHROPIC_API_KEY: base.accessToken, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  }
  const child = spawn(host, args, { cwd: directory, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let diagnosticsBytes = 0;
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { diagnosticsBytes += chunk.length; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  const exitCode = await new Promise((resolve) => child.on('close', resolve)); clearTimeout(timer);
  return { exitCode, responseObserved: output.includes('synthetic routing verified'), canaryRestored: output.includes(canary), diagnosticsBytes, gatewayCodes: [...new Set(output.match(/MANCODE_GATEWAY_[A-Z_]+/g) ?? [])] };
}
try {
  for (const host of ['codex', 'claude']) {
    const protocol = host === 'codex' ? 'responses' : 'messages'; let calls = 0; let protectedCanary = true; const diagnostics = [];
    const server = await startGatewayServer({ ...base, upstreamId: host === 'codex' ? 'openai' : 'anthropic', clientHost: host === 'codex' ? 'codex-cli/0.153.4' : 'claude-code/2.1.142' }, { workerUrl: pathToFileURL(workerModule), upstreamKey: 'synthetic-only', onDiagnostic: (code) => diagnostics.push(code), fetchUpstream: async (_url, init) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ object: 'list', data: [] }), { headers: { 'content-type': 'application/json' } });
      calls++; const body = String(init.body); protectedCanary &&= !body.includes(canary);
      const token = /canary (__MANCODE_[a-f0-9]{32}__)/.exec(body)?.[1] ?? '';
      return new Response(syntheticResponse(protocol, `synthetic routing verified ${token}`).map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });
    } });
    try { const result = await invokeHost(host, server.port); results.push({ kind: 'real-host-roundtrip', host, protocol, ...result, diagnostics, upstreamCalls: calls, protectedCanary }); }
    finally { await server.stop(); }
  }
  const readPath = path.join(directory, 'read-fixture.txt');
  await writeFile(readPath, `Synthetic private contact: ${canary}\n`);
  let readCalls = 0; let pathMasked = false; let toolResultObserved = false; let resultMasked = false; const readDiagnostics = [];
  const readServer = await startGatewayServer({ ...base, upstreamId: 'anthropic', clientHost: 'claude-code/2.1.142' }, { workerUrl: pathToFileURL(workerModule), upstreamKey: 'synthetic-only', onDiagnostic: (code) => readDiagnostics.push(code), fetchUpstream: async (_url, init) => {
    const body = String(init.body); const data = JSON.parse(body); readCalls++;
    if (readCalls === 1) {
      const token = /Read this synthetic file (__MANCODE_[a-f0-9]{32}__)/.exec(body)?.[1]; pathMasked = Boolean(token) && !body.includes(readPath);
      const events = [
        { type: 'message_start', message: { id: 'read_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_read', name: 'Read', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: token ?? 'unsupported' }) } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ];
      return new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    const toolResults = data.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool_result');
    const resultText = JSON.stringify(toolResults);
    const token = /Synthetic private contact: (__MANCODE_[a-f0-9]{32}__)/.exec(resultText)?.[1];
    toolResultObserved = Boolean(token); resultMasked = !resultText.includes(canary);
    return new Response(syntheticResponse('messages', `synthetic routing verified ${token ?? ''}`).map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try { const result = await invokeHost('claude', readServer.port, readPath); results.push({ kind: 'real-host-read-roundtrip', host: 'claude', ...result, upstreamCalls: readCalls, pathMasked, toolResultObserved, resultMasked, diagnostics: readDiagnostics, hostPermissionBypass: false }); }
  finally { await readServer.stop(); }
  if (!process.argv.includes('--hosts-only')) {
  const lag = monitorEventLoopDelay({ resolution: 1 }); lag.enable(); let id = 0;
  const server = await startGatewayServer(base, { workerUrl: pathToFileURL(workerModule), upstreamKey: 'synthetic-only', fetchUpstream: async () => new Response(JSON.stringify({ id: `load_${++id}`, output: [] }), { headers: { 'content-type': 'application/json' } }) });
  try {
    const body = JSON.stringify({ model: 'm', input: 'plain '.repeat(170_000) });
    const timings = []; const statuses = [];
    for (const concurrency of [1, 8]) {
      await Promise.all(Array.from({ length: concurrency }, async () => { const start = performance.now(); const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${base.accessToken}`, 'content-type': 'application/json' }, body }); await response.text(); statuses.push(response.status); timings.push(performance.now() - start); }));
    }
    lag.disable(); results.push({ kind: '1MiB-request-load', bytes: Buffer.byteLength(body), concurrency: [1, 8], statuses, elapsedMs: timings.map((value) => Math.round(value * 100) / 100), mainLoopP95Ms: Math.round(lag.percentile(95) / 1e4) / 100, mainLoopMaxMs: Math.round(lag.max / 1e4) / 100 });
  } finally { await server.stop(); }
  const deltas = []; const ready = new Map();
  const streaming = await startGatewayServer(base, { workerUrl: pathToFileURL(workerModule), upstreamKey: 'synthetic-only', fetchUpstream: async () => {
    const id = `latency_${++responseSequence}`; const item = `item_${id}`;
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(Buffer.from(frame({ type: 'response.created', response: { id, output: [] } })));
      for (let index = 0; index < 30; index++) { await new Promise((resolve) => setTimeout(resolve, 10)); const text = `sample_${index};`; ready.set(text, performance.now()); controller.enqueue(Buffer.from(frame({ type: 'response.output_text.delta', item_id: item, output_index: 0, content_index: 0, delta: text }))); }
      controller.enqueue(Buffer.from(frame({ type: 'response.output_text.done', item_id: item, output_index: 0, content_index: 0, text: Array.from({ length: 30 }, (_, i) => `sample_${i};`).join('') })));
      controller.enqueue(Buffer.from(frame({ type: 'response.completed', response: { id, output: [] } }))); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const response = await fetch(`http://127.0.0.1:${streaming.port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${base.accessToken}`, 'content-type': 'application/json' }, body: '{"model":"m","input":"latency","stream":true}' });
    let pending = ''; for await (const chunk of response.body) { pending += Buffer.from(chunk).toString('utf8'); let end; while ((end = pending.indexOf('\n\n')) >= 0) { const block = pending.slice(0, end); pending = pending.slice(end + 2); const data = block.split('\n').find((line) => line.startsWith('data: ')); if (!data) continue; const event = JSON.parse(data.slice(6)); if (event.type === 'response.output_text.delta' && ready.has(event.delta)) deltas.push(performance.now() - ready.get(event.delta)); } }
    deltas.sort((a, b) => a - b); results.push({ kind: 'stream-forward-latency', samples: deltas.length, p95Ms: Math.round(deltas[Math.floor(deltas.length * 0.95)] * 100) / 100, maxMs: Math.round(deltas.at(-1) * 100) / 100, includes: 'worker restoration + HTTP forwarding + loopback client; synthetic plaintext deltas' });
  } finally { await streaming.stop(); }
  }
  const output = { date: new Date().toISOString(), results, limits: 'No desktop/subscription/cloud claim; no real model. Read adapter uses separately captured schema.' };
  await writeFile(`tests/fixtures/privacy-protocols/${process.argv.includes('--hosts-only') ? 'host-roundtrip-evidence' : 'implementation-evidence'}.json`, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  if (results.some((result) => result.kind === 'real-host-roundtrip' && (!result.responseObserved || !result.canaryRestored || !result.protectedCanary || result.upstreamCalls === 0))) process.exitCode = 1;
  if (results.some((result) => result.kind === 'real-host-read-roundtrip' && (!result.pathMasked || !result.toolResultObserved || !result.resultMasked || !result.canaryRestored))) process.exitCode = 1;
} finally { await rm(directory, { recursive: true, force: true }); }

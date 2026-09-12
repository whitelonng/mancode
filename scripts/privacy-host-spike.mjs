// Synthetic, local-only routing probe. Never applies client configuration.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'mancode-host-spike-'));
const requests = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const fields = body ? Object.keys(JSON.parse(body)) : [];
  requests.push({ method: request.method, path: request.url, syntheticAuth: request.headers.authorization === 'Bearer synthetic-spike-only', fields });
  if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const output = { id: 'msg_spike', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic routing verified', annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_spike', object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_spike', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_spike', output_index: 0, content_index: 0, delta: 'synthetic routing verified' },
    { type: 'response.output_text.done', item_id: 'msg_spike', output_index: 0, content_index: 0, text: 'synthetic routing verified' },
    { type: 'response.output_item.done', output_index: 0, item: output },
    { type: 'response.completed', response: { id: 'resp_spike', object: 'response', status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '-C', directory, '-s', 'read-only', '--json',
    '-c', 'model_provider="mancode_spike"', '-c', 'model="synthetic-model"',
    '-c', 'model_providers.mancode_spike.name="Synthetic local spike"',
    '-c', `model_providers.mancode_spike.base_url="http://127.0.0.1:${port}/v1"`,
    '-c', 'model_providers.mancode_spike.env_key="MANCODE_SPIKE_KEY"',
    '-c', 'model_providers.mancode_spike.wire_api="responses"',
    '-c', 'model_providers.mancode_spike.supports_websockets=false',
    '-c', 'model_providers.mancode_spike.request_max_retries=0',
    'Reply with synthetic routing verified. Do not use tools.'];
  const child = spawn('codex', args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, MANCODE_SPIKE_KEY: 'synthetic-spike-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let error = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { error += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  const result = { host: 'Codex CLI', transport: 'Responses HTTP/SSE', exitCode, requests, responseObserved: output.includes('synthetic routing verified'), diagnosticsBytes: Buffer.byteLength(error), scope: 'isolated command-line provider override; no desktop/subscription/cloud support assertion' };
  console.log(JSON.stringify(result, null, 2));
  if (!result.responseObserved || requests.length === 0 || !requests.every((item) => item.syntheticAuth)) process.exitCode = 1;
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }

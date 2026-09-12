import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'mancode-claude-spike-'));
const requests = [];
let readSchema;
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const data = body ? JSON.parse(body) : {};
  readSchema = data.tools?.find((tool) => tool.name === 'Read')?.input_schema ?? readSchema;
  requests.push({ method: request.method, path: request.url, syntheticAuth: request.headers['x-api-key'] === 'synthetic-spike-only', streaming: data.stream === true, readTool: Boolean(readSchema), fields: Object.keys(data), controls: { context_management: data.context_management, output_config: data.output_config } });
  if (!request.url.startsWith('/v1/messages')) { response.writeHead(404).end(); return; }
  const message = { id: 'msg_spike', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [{ type: 'message_start', message }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic routing verified' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const child = spawn('claude', ['--bare', '-p', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--system-prompt', 'Reply using plain text. Do not invoke tools.', '--tools', 'Read', '--model', 'claude-sonnet-4-6', '--output-format', 'json', 'Reply synthetic routing verified.'], { cwd: directory, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ANTHROPIC_API_KEY: 'synthetic-spike-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let diagnosticsBytes = 0;
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { diagnosticsBytes += chunk.length; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  const exitCode = await new Promise((resolve) => child.on('close', resolve)); clearTimeout(timer);
  const result = { host: 'Claude Code', version: '2.1.142', transport: 'Messages HTTP/SSE', exitCode, responseObserved: output.includes('synthetic routing verified'), requests, diagnosticsBytes };
  if (readSchema) await writeFile(new URL('../tests/fixtures/privacy-protocols/claude-read-2.1.142.json', import.meta.url), `${JSON.stringify(readSchema, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.responseObserved || !readSchema || !requests.filter((item) => item.method === 'POST').every((item) => item.syntheticAuth)) process.exitCode = 1;
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }

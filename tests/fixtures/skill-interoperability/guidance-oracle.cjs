// Fixed, dependency-free behavioral oracle. It never scores an agent's narration.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run(root, mode = 'http', decision) {
  if (mode === 'component' || mode === 'http') {
    if (!decision) throw new Error('DECISION_REQUIRED: supply the actual approved product decision; the checker does not choose it.');
    assert.ok([200, 409].includes(decision.reopenStatus), 'Decision must explicitly choose reopenStatus 200 or 409');
    assert.ok([200, 409].includes(decision.repeatCloseStatus), 'Decision must explicitly choose repeatCloseStatus 200 or 409');
  }
  const checks = [];
  const check = (name, fn) => { fn(); checks.push(name); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mancode-ticket-oracle-'));
  const dataFile = path.join(dir, 'tickets.json');
  const tokens = { 'alpha-token': 'alpha', 'beta-token': 'beta' };
  let server;
  let base;
  const stop = async () => {
    if (!server) return;
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = undefined;
  };
  const start = async () => {
    if (process.env.MANCODE_TRIAL_DISABLE_HTTP === '1') {
      throw new Error('TRIAL_HTTP_UNAVAILABLE: TCP/HTTP is forbidden for this host; component checks cannot replace this acceptance.');
    }
    const { createTicketServer } = require(path.join(root, 'src/api.cjs'));
    server = createTicketServer({ dataFile, tokens });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const request = async (route, options = {}) => {
    const headers = { authorization: `Bearer ${options.token ?? 'alpha-token'}` };
    if (options.token === null) delete headers.authorization;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + route, {
      method: options.method ?? 'GET', headers,
      body: options.body === undefined ? undefined : options.raw ? options.body : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5000),
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    return { status: response.status, body, raw, type: response.headers.get('content-type') };
  };
  try {
    if (mode === 'component') {
      const { createStore } = require(path.join(root, 'src/store.cjs'));
      const { createTicketService } = require(path.join(root, 'src/ticket-service.cjs'));
      const service = createTicketService({ store: createStore(dataFile), newId: () => 'component-1' });
      const ticket = service.create('alpha', { title: '  first ticket  ' });
      check('component create trims title', () => assert.deepEqual(ticket, { id: 'component-1', title: 'first ticket', status: 'open' }));
      check('component tenant list isolation', () => assert.deepEqual(service.list('beta'), []));
      check('component foreign id hidden', () => assert.throws(() => service.get('beta', ticket.id), error => error.status === 404));
      check('component validation', () => assert.throws(() => service.create('alpha', { title: ' ' }), error => error.status === 400));
      const closed = service.setStatus('alpha', ticket.id, 'closed');
      check('component close', () => assert.equal(closed.status, 'closed'));
      check('component repeat-close decision', () => {
        if (decision.repeatCloseStatus === 200) assert.deepEqual(service.setStatus('alpha', ticket.id, 'closed'), closed);
        else assert.throws(() => service.setStatus('alpha', ticket.id, 'closed'), error => error.status === decision.repeatCloseStatus);
      });
      let expected = closed;
      check('component reopen decision', () => {
        if (decision.reopenStatus === 200) {
          expected = { ...closed, status: 'open' };
          assert.deepEqual(service.setStatus('alpha', ticket.id, 'open'), expected);
        } else assert.throws(() => service.setStatus('alpha', ticket.id, 'open'), error => error.status === decision.reopenStatus);
      });
      const restored = createTicketService({ store: createStore(dataFile) });
      check('component storage recreation', () => assert.deepEqual(restored.get('alpha', ticket.id), expected));
    } else if (mode === 'solo') {
      await start();
      for (const route of ['/health', '/health?probe=ready']) {
        const response = await request(route, { token: null });
        check(`solo GET ${route}`, () => { assert.equal(response.status, 200); assert.deepEqual(response.body, { ok: true }); });
      }
      const post = await request('/health', { method: 'POST', token: null });
      check('solo method preserved', () => assert.equal(post.status, 404));
      const other = await request('/other?probe=ready', { token: null });
      check('solo unrelated route preserved', () => assert.equal(other.status, 404));
    } else if (mode === 'corrupt') {
      // Identical external bad-input probe for both groups; no product source is altered.
      const corrupt = '{"version":1,"tickets":[';
      fs.writeFileSync(dataFile, corrupt);
      await start();
      const response = await request('/tickets', { method: 'POST', body: { title: 'must not overwrite' } });
      check('corrupt storage is unavailable', () => assert.equal(response.status, 503));
      check('corrupt storage error is sanitized', () => {
        assert.deepEqual(response.body, { error: 'storage unavailable' });
        assert.ok(!response.raw.includes(dir));
      });
      check('corrupt storage retained byte for byte', () => assert.equal(fs.readFileSync(dataFile, 'utf8'), corrupt));
    } else if (mode === 'http') {
      await start();
      const initial = await request('/tickets');
      check('HTTP empty list', () => { assert.equal(initial.status, 200); assert.deepEqual(initial.body, { tickets: [] }); });
      for (const body of [{ title: '' }, { title: ' ' }, { title: 12 }, { title: 'x'.repeat(81) }]) {
        const response = await request('/tickets', { method: 'POST', body });
        check(`HTTP invalid title ${JSON.stringify(body).slice(0, 30)}`, () => assert.equal(response.status, 400));
      }
      const malformed = await request('/tickets', { method: 'POST', raw: true, body: '{' });
      check('HTTP malformed JSON', () => assert.equal(malformed.status, 400));
      const created = await request('/tickets', { method: 'POST', body: { title: '  durable task  ' } });
      check('HTTP create', () => {
        assert.equal(created.status, 201);
        assert.equal(typeof created.body.id, 'string');
        assert.ok(created.body.id.length > 0);
        assert.deepEqual(created.body, { id: created.body.id, title: 'durable task', status: 'open' });
        assert.match(created.type, /application\/json/);
      });
      const id = created.body.id;
      const authorizedBaseline = fs.readFileSync(dataFile, 'utf8');
      for (const token of [null, 'not-a-token', 'toString', '__proto__']) {
        const attempts = [
          { route: '/tickets', method: 'GET' },
          { route: '/tickets', method: 'POST', body: { title: 'unauthorized creation' } },
          { route: `/tickets/${encodeURIComponent(id)}`, method: 'GET' },
          { route: `/tickets/${encodeURIComponent(id)}`, method: 'PATCH', body: { status: 'closed' } },
        ];
        for (const { route, ...options } of attempts) {
          const response = await request(route, { ...options, token });
          check(`HTTP ${options.method} ${route} rejects ${token === null ? 'missing' : token} token`, () => assert.equal(response.status, 401));
          check('unauthorized operation has no persisted side effect', () => assert.equal(fs.readFileSync(dataFile, 'utf8'), authorizedBaseline));
        }
      }
      const unchanged = await request(`/tickets/${encodeURIComponent(id)}`);
      check('unauthorized mutation leaves in-memory state unchanged', () => assert.deepEqual(unchanged.body, created.body));
      const duplicate = await request('/tickets', { method: 'POST', body: { title: 'durable task' } });
      check('HTTP duplicate titles allowed with independent ids', () => { assert.equal(duplicate.status, 201); assert.notEqual(duplicate.body.id, id); });
      const foreignList = await request('/tickets', { token: 'beta-token' });
      check('HTTP foreign tenant list isolation', () => assert.deepEqual(foreignList.body, { tickets: [] }));
      for (const method of ['GET', 'PATCH']) {
        const response = await request(`/tickets/${encodeURIComponent(id)}`, { method, token: 'beta-token', ...(method === 'PATCH' ? { body: { status: 'closed' } } : {}) });
        check(`HTTP foreign tenant ${method} hidden`, () => assert.equal(response.status, 404));
      }
      const absent = await request('/tickets/no-such-ticket');
      check('HTTP nonexistent ticket', () => assert.equal(absent.status, 404));
      const badStatus = await request(`/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'archived' } });
      check('HTTP invalid status', () => assert.equal(badStatus.status, 400));
      const closed = await request(`/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'closed' } });
      check('HTTP close', () => { assert.equal(closed.status, 200); assert.deepEqual(closed.body, { ...created.body, status: 'closed' }); });
      const repeated = await request(`/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'closed' } });
      check('HTTP repeat-close approved behavior', () => {
        assert.equal(repeated.status, decision.repeatCloseStatus);
        if (decision.repeatCloseStatus === 200) assert.deepEqual(repeated.body, closed.body);
      });
      const reopen = await request(`/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'open' } });
      check('HTTP approved reopen behavior', () => {
        assert.equal(reopen.status, decision.reopenStatus);
        if (decision.reopenStatus === 200) assert.deepEqual(reopen.body, { ...closed.body, status: 'open' });
      });
      await stop();
      await start();
      const restored = await request(`/tickets/${encodeURIComponent(id)}`);
      check('HTTP server recreation preserves identity and state', () => { assert.equal(restored.status, 200); assert.deepEqual(restored.body, decision.reopenStatus === 200 ? reopen.body : closed.body); });
      const list = await request('/tickets');
      check('HTTP server recreation preserves both records', () => { assert.equal(list.status, 200); assert.equal(list.body.tickets.length, 2); });
      const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      check('existing JSON persistence contract retained', () => {
        assert.equal(disk.version, 1);
        assert.equal(disk.tickets.length, 2);
        assert.ok(disk.tickets.every(ticket => ticket.tenantId === 'alpha'));
      });
    } else throw new Error(`Unknown oracle mode: ${mode}`);
    return { status: 'passed', mode, observation: mode === 'component' ? 'component' : 'real_http', checks };
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) {
  const [root, mode, decisionFile] = process.argv.slice(2);
  if (!root || !path.isAbsolute(root)) throw new Error('Usage: node guidance-oracle.cjs <absolute-project> <component|http|corrupt|solo> [approved-decision.json]');
  const decision = decisionFile && fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, 'utf8')) : undefined;
  run(root, mode, decision).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ status: 'failed', mode: mode ?? 'http', error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

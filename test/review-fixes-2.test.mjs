// Tests for fixes applied after the v0.3.6 code review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { parseModelJson, validateResult, normalizeChat } from '../compatibility.mjs';
import { createAdmission } from '../admission.mjs';
import { ApiError } from '../transport.mjs';

async function serve(t, opts = {}) {
  const server = createServer({ token: opts.token ?? '', askFn: opts.askFn });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.shutdown().finally(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function withToken(url, token) {
  if (!token) return url;
  return { url, headers: { Authorization: 'Bearer ' + token } };
}

test('health: compact and authentication flags', async t => {
  const base = await serve(t, { askFn: async () => ({ text: 'x' }) });
  const full = await (await fetch(base + '/health')).json();
  assert.equal(full.ok, true);
  assert.equal(full.authentication, 'loopback-trusted');
  const compact = await (await fetch(base + '/health?compact=1')).json();
  assert.equal(compact.status, 'ok');
});

test('health: token-required + 401 invalid_api_key', async t => {
  const base = await serve(t, { token: 'secret', askFn: async () => ({ text: 'x' }) });
  const unauth = await (await fetch(base + '/v1/models')).json();
  assert.equal(unauth.error.code, 'invalid_api_key');
  // With the token, /health succeeds and reports token-required.
  const health = await (await fetch(base + '/health', { headers: { Authorization: 'Bearer secret' } })).json();
  assert.equal(health.authentication, 'token-required');
});

test('5xx with known client code maps to invalid_request_error', async t => {
  const base = await serve(t, { askFn: async () => { throw new ApiError('bad output', 502, 'invalid_model_output'); } });
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'grok-bot', messages: [{ role: 'user', content: 'hi' }] }) });
  const body = await r.json();
  assert.equal(r.status, 502);
  assert.equal(body.error.type, 'invalid_request_error');
});

test('content:null with tool_calls is accepted in validateResult', () => {
  const request = normalizeChat({ model: 'grok-bot', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {}, additionalProperties: false } } }] });
  const message = validateResult(request, { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }] });
  assert.equal(message.content, null);
  assert.equal(message.tool_calls.length, 1);
});

test('parseModelJson tolerates unescaped control chars inside a JSON string', () => {
  const text = '{"a":"line1\nline2"}';
  assert.deepEqual(parseModelJson(text), { a: 'line1\nline2' });
});

test('incremental text is NOT streamed when tools are present', async t => {
  let streamed;
  const base = await serve(t, { askFn: async (_text, options) => { streamed = options.onText; return { text: '{"content":null,"tool_calls":[]}' }; } });
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'grok-bot', stream: true, messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {}, additionalProperties: false } } }] }) });
  await r.text();
  assert.equal(streamed, undefined);
});

test('admission: maxPending allows configured waiters and rejects extras', async () => {
  const a = createAdmission({ maxPending: 2, waitMs: 5000 });
  const release1 = await a.acquire();
  const w1 = a.acquire();
  const w2 = a.acquire();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.status().pending, 2);
  await a.acquire().then(
    () => { throw new Error('expected rejection'); },
    err => assert.equal(err.code, 'backend_busy'),
  );
  release1();
  const r1 = await w1;
  r1();
  const r2 = await w2;
  r2();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.status().active, 0);
  assert.equal(a.status().pending, 0);
});

test('admission: client cancel removes the pending entry', async () => {
  const a = createAdmission({ maxPending: 1, waitMs: 5000 });
  const release1 = await a.acquire();
  const ctrl = new AbortController();
  const pending = a.acquire(ctrl.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.status().pending, 1);
  ctrl.abort();
  await assert.rejects(pending);
  assert.equal(a.status().pending, 0);
  release1();
});

test('admission: timer fires and rejects pending after waitMs', async () => {
  const a = createAdmission({ maxPending: 1, waitMs: 30 });
  const release1 = await a.acquire();
  await a.acquire().then(
    () => { throw new Error('expected rejection'); },
    err => assert.equal(err.code, 'backend_busy'),
  );
  release1();
});

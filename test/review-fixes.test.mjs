import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createServer } from '../server.mjs';
import { ApiError } from '../transport.mjs';
import { normalizeChat, parseAgentResult } from '../compatibility.mjs';

const base = { model: 'grok-bot', messages: [{ role: 'user', content: 'Hello' }] };
const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function serve(t, options = {}) {
  const server = createServer({ token: '', queueLimit: 0, warn: () => {}, askFn: async () => ({ text: 'hello' }), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (url, body, extra = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });

test('model retrieval and request IDs work through OpenAI SDK, including errors', async t => {
  const url = await serve(t);
  const client = new OpenAI({ baseURL: url + '/v1', apiKey: 'local', maxRetries: 0 });
  const { data, response } = await client.models.retrieve('grok-bot').withResponse();
  assert.equal(data.id, 'grok-bot');
  assert.match(response.headers.get('x-request-id'), /^req_/);
  const missing = await fetch(url + '/v1/models/unknown');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.type, 'invalid_request_error');
  assert.notEqual(missing.headers.get('x-request-id'), response.headers.get('x-request-id'));
});

test('HTTP client errors use request/auth/permission types and preserve request IDs', async t => {
  const url = await serve(t);
  for (const [path, init, status, type] of [
    ['/missing', {}, 404, 'invalid_request_error'],
    ['/v1/chat/completions', { method: 'POST' }, 415, 'invalid_request_error'],
    ['/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(2_000_001) }) }, 413, 'invalid_request_error'],
    ['/health', { headers: { Origin: 'https://example.test' } }, 403, 'permission_error'],
  ]) {
    const r = await fetch(url + path, init);
    assert.equal(r.status, status); assert.equal((await r.json()).error.type, type);
    assert.ok(r.headers.get('x-request-id'));
  }
  const locked = await serve(t, { token: 'test-only' });
  const denied = await fetch(locked + '/health');
  assert.equal(denied.status, 401); assert.equal((await denied.json()).error.type, 'authentication_error');
});

test('busy agent rejects Chat, Responses and direct requests before SSE; slot is released', async t => {
  const gate = deferred(), entered = deferred(); let calls = 0;
  t.after(() => gate.resolve());
  const url = await serve(t, { askFn: async () => { calls++; entered.resolve(); await gate.promise; return { text: 'done' }; } });
  const first = await post(url + '/v1/chat/completions', { ...base, stream: true });
  await entered.promise;
  for (const [path, body] of [
    ['/v1/chat/completions', { ...base, stream: true }],
    ['/v1/responses', { model: 'grok-bot', input: 'Hello', stream: true }],
    ['/v1/agent', { prompt: 'Hello' }],
  ]) {
    const r = await post(url + path, body);
    assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '1');
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.deepEqual((await r.json()).error, { message: 'Grok Bot backend is busy. Retry after the current request finishes.', type: 'rate_limit_error', code: 'backend_busy', param: null });
  }
  assert.equal(calls, 1);
  assert.equal((await fetch(url + '/health')).status, 200);
  gate.resolve(); assert.match(await first.text(), /\[DONE\]/);
  const next = await post(url + '/v1/chat/completions', base);
  assert.equal(next.status, 200); assert.equal(calls, 2);
});

test('Responses SSE errors retain the event discriminator and are recognized by SDK', async t => {
  const url = await serve(t, { askFn: async () => { throw new ApiError('Test failure', 503, 'test_failure'); } });
  const response = await post(url + '/v1/responses', { model: 'grok-bot', input: 'Hello', stream: true });
  const sse = await response.text();
  const event = JSON.parse(sse.split('\n').find(x => x.startsWith('data: ')).slice(6));
  assert.equal(event.type, 'error'); assert.equal(event.code, 'test_failure');
  assert.doesNotMatch(sse, /response.completed/);
  const client = new OpenAI({ baseURL: url + '/v1', apiKey: 'local', maxRetries: 0 });
  await assert.rejects(async () => {
    const stream = await client.responses.create({ model: 'grok-bot', input: 'Hello', stream: true });
    for await (const _ of stream) {}
  }, /Test failure/);
  // Failure must release admission too.
  assert.equal((await post(url + '/v1/chat/completions', base)).status, 503);
});

test('client cancellation retains reservation until backend cleanup finishes', async t => {
  const cleanup = deferred(), aborted = deferred(), entered = deferred(); let calls = 0;
  t.after(() => cleanup.resolve());
  const url = await serve(t, { askFn: async (_, { signal }) => {
    if (++calls > 1) return { text: 'done' };
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve(); await cleanup.promise; throw new ApiError('Cancelled', 499, 'cancelled');
  } });
  const controller = new AbortController();
  const first = await post(url + '/v1/chat/completions', { ...base, stream: true }, { signal: controller.signal });
  await entered.promise; controller.abort(); await first.text().catch(() => {}); await aborted.promise;
  assert.equal((await post(url + '/v1/chat/completions', base)).status, 429);
  cleanup.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post(url + '/v1/chat/completions', base)).status, 200);
});

test('standard Chat options are validated, disclosed and rejected in strict parameter mode', async t => {
  const options = { logprobs: false, top_logprobs: 0, user: 'client', service_tier: 'auto', store: false, metadata: { task: 'test' }, logit_bias: { 123: 2 } };
  const url = await serve(t);
  const r = await post(url + '/v1/chat/completions', { ...base, ...options });
  assert.equal(r.status, 200);
  assert.deepEqual(new Set(r.headers.get('x-grokbot-ignored-parameters').split(',')), new Set(Object.keys(options)));
  const answer = await r.json(); assert.equal(answer.usage, null); assert.equal(answer.choices[0].logprobs, null);
  assert.deepEqual(normalizeChat({ ...base, ...options }, { native: true }).ignored_parameters, Object.keys(options));
  for (const [key, value] of Object.entries(options)) assert.throws(() => normalizeChat({ ...base, [key]: value }, { strictParameters: true }), e => e.param === key);
  for (const [key, value] of [['logprobs', 'yes'], ['top_logprobs', 21], ['user', {}], ['service_tier', 'fake'], ['store', 1], ['metadata', { a: 1 }], ['logit_bias', { 123: 101 }]]) {
    assert.throws(() => normalizeChat({ ...base, [key]: value }), e => e.status === 400 && e.param === key);
  }
});

test('strict true and false are disclosed; schema and tool choice validation remain mandatory', () => {
  for (const strict of [true, false]) {
    const request = normalizeChat({ ...base, tools: [{ ...tool, function: { ...tool.function, strict } }] });
    assert.deepEqual(request.ignored_parameters, ['tools[0].function.strict']);
    assert.throws(() => parseAgentResult(request, JSON.stringify({ content: null, tool_calls: [{ name: 'read_file', arguments: { path: 42 } }] })), /JSON Schema/);
    const structured = normalizeChat({ ...base, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict, schema: { type: 'object', required: ['ok'] } } } });
    assert.deepEqual(structured.ignored_parameters, ['response_format.json_schema.strict']);
    assert.throws(() => parseAgentResult(structured, '{}'), /response_format/);
  }
  assert.throws(() => normalizeChat({ ...base, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: 'false', schema: {} } } }), e => e.param === 'response_format.json_schema.strict');
});

test('Responses accepts explicit defaults, preserves storage and reports caller parameter names', async t => {
  const url = await serve(t);
  const r = await post(url + '/v1/responses', { model: 'grok-bot', input: 'Hello', store: false, metadata: { task: 'test' }, background: false, truncation: 'disabled', include: [], reasoning: { effort: 'low' }, text: { verbosity: 'low' }, user: 'client', service_tier: 'auto', max_output_tokens: 100 });
  assert.equal(r.status, 200);
  assert.deepEqual(new Set(r.headers.get('x-grokbot-ignored-parameters').split(',')), new Set(['reasoning.effort', 'text.verbosity', 'user', 'service_tier', 'max_output_tokens']));
  const data = await r.json(); assert.equal(data.store, false); assert.deepEqual(data.metadata, { task: 'test' });
  assert.equal((await fetch(url + '/v1/responses/' + data.id)).status, 404);
  for (const option of [{ background: true }, { truncation: 'auto' }, { include: ['reasoning.encrypted_content'] }, { reasoning: { summary: 'auto' } }, { max_tool_calls: 1 }]) {
    assert.equal((await post(url + '/v1/responses', { model: 'grok-bot', input: 'Hello', ...option })).status, 400);
  }
  const strictUrl = await serve(t, { strictParameters: true });
  const rejected = await post(strictUrl + '/v1/responses', { model: 'grok-bot', input: 'Hello', text: { verbosity: 'low' } });
  assert.equal((await rejected.json()).error.param, 'text.verbosity');
});

test('Responses function events correlate by item.id and arguments.done omits extraneous name', async t => {
  const url = await serve(t, { askFn: async () => ({ text: JSON.stringify({ content: null, tool_calls: [{ name: 'read_file', arguments: { path: 'a' } }] }) }) });
  const r = await post(url + '/v1/responses', { model: 'grok-bot', input: 'Read a', tools: [{ type: 'function', ...tool.function, strict: true }], stream: true });
  assert.equal(r.headers.get('x-grokbot-ignored-parameters'), 'tools[0].strict');
  const events = (await r.text()).split('\n').filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6)));
  const args = events.find(e => e.type === 'response.function_call_arguments.done');
  const done = events.find(e => e.type === 'response.output_item.done');
  assert.equal(args.item_id, done.item.id); assert.equal('name' in args, false);
  assert.equal(done.item.name, 'read_file');
});

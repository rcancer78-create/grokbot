import test from 'node:test';
import assert from 'node:assert/strict';
import { correlatedReply, waitForReply, createBot } from '../bot.mjs';
import { decodeFrames, envelope, ApiError } from '../transport.mjs';
import { createServer, promptFrom } from '../server.mjs';
import { serve } from './helpers.mjs';

const row = (seq, body) => ({ seq: String(seq), body: Buffer.from(JSON.stringify(body)).toString('base64') });
const echo = (nonce = 'mine') => ({ kind: 'message', role: 'user', clientNonce: nonce, requestId: 'server-id' });
const answer = (text = 'OK', extra = {}) => ({ kind: 'send-message', requestId: 'server-id', message: { type: 'text', content: text }, timestampMs: 20, ...extra });
const rows = entries => ({ rows: { agentId: 'a', entries } });
const idle = time => ({ agentState: { live: [{ agentId: 'a', updatedAtMs: String(time) }] } });
const stream = events => ({ async *watch() { yield* events; } });

test('correlates via clientNonce, never by timestamp or direct messageId', () => {
  const entries = new Map([
    ['1', { seq: 1n, body: echo() }],
    ['2', { seq: 2n, body: answer('foreign', { requestId: 'mine', timestampMs: Date.now() }) }],
    ['3', { seq: 3n, body: answer('OK') }],
  ]);
  assert.equal(correlatedReply(entries, 'mine').text, 'OK');
  assert.equal(correlatedReply(entries, 'unknown'), null);
});

test('waits for idle AFTER the reply and aggregates ordered final messages', async () => {
  let reachedIdle = false;
  const transport = { async *watch() {
    yield idle(1);
    yield rows([row(1, echo()), row(3, answer('second')), row(2, answer('partial', { streaming: true }))]);
    yield rows([row(2, answer('first'))]);
    reachedIdle = true;
    yield idle(30);
  } };
  const result = await waitForReply(transport, 'a', '', 'mine');
  assert.equal(reachedIdle, true);
  assert.equal(result.text, 'first\n\nsecond');
});

test('accepts already finished replay using a fresh idle snapshot', async () => {
  const result = await waitForReply(stream([
    { connected: { serverTimeMs: '30' } }, { agentState: { snapshot: true } },
    rows([row(1, echo()), row(2, answer())]),
  ]), 'a', '', 'mine');
  assert.equal(result.text, 'OK');
});

test('does not return an answer from a different agent/session or author', async () => {
  await assert.rejects(waitForReply(stream([
    idle(30), { rows: { agentId: 'other', entries: [row(1, echo()), row(2, answer())] } },
    { rows: { agentId: 'a', sessionId: 'other-session', entries: [row(1, echo()), row(2, answer())] } },
    rows([row(1, echo()), row(2, answer('human', { author: { id: 'human' } }))]),
  ]), 'a', '', 'mine'), /ended before completion/);
});

test('turn failure and omitted body cannot become successful completions', async () => {
  await assert.rejects(waitForReply(stream([{ turnFailed: { agentId: 'a', code: 'GROK_BOT_TURN_FAILURE_CODE_USAGE_LIMIT' } }]), 'a', '', 'mine'), e => e.status === 429);
  await assert.rejects(waitForReply(stream([rows([{ seq: '1', bodyOmitted: true }])]), 'a', '', 'mine'), /omitted/);
  await assert.rejects(waitForReply(stream([rows([row(1, echo()), row(2, answer('', { message: { type: 'widget' } }))])]), 'a', '', 'mine'), e => e.status === 409);
});

test('Connect decoder handles arbitrary network splits and UTF-8', async () => {
  const bytes = Buffer.concat([envelope({ text: 'Привет' }), envelope({ rows: [1] }), envelope({}, 2)]);
  const chunks = { async *[Symbol.asyncIterator]() { for (const byte of bytes) yield Buffer.from([byte]); } };
  const out = [];
  for await (const frame of decodeFrames(chunks)) out.push(frame);
  assert.deepEqual(out, [{ text: 'Привет' }, { rows: [1] }]);
});

test('Connect rejects errors inside HTTP 200, compression and truncated frames', async () => {
  const collect = async bytes => { for await (const _ of decodeFrames([bytes])) {} };
  await assert.rejects(collect(envelope({ error: { code: 'resource_exhausted', message: 'quota' } }, 2)), e => e.status === 429);
  await assert.rejects(collect(envelope({}, 1)), /flags/);
  await assert.rejects(collect(envelope({ text: 'long' }).subarray(0, 8)), /Truncated/);
});

function fakeTransport({ hang = false, failSend = false, warn = () => {} } = {}) {
  const calls = []; let id, nonce;
  return { calls, warn,
    async rpc(method, body) {
      calls.push({ method, body });
      if (method === 'CreateGrokBotAgent') { id = body.agentId; return { agent: { agentId: id, id: 'owned-id', harness: 'temporal' } }; }
      if (method === 'SendGrokBotUserMessage') {
        nonce = body.messageId;
        if (failSend) throw new Error('network failed after acceptance');
        return { delivery: 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL' };
      }
      return {};
    },
    async *watch(agentId, sessionId, signal) {
      if (hang) {
        await new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      yield { connected: { serverTimeMs: '30' } };
      yield { agentState: { snapshot: true } };
      yield { rows: { agentId: id, entries: [row(1, echo(nonce)), row(2, answer())] } };
    },
  };
}

test('fresh agent for every request, delete only the owned resource', async () => {
  const t = fakeTransport();
  const bot = createBot({ transportFactory: () => t });
  assert.equal((await bot.ask('one')).text, 'OK');
  await bot.ask('two');
  const creates = t.calls.filter(c => c.method === 'CreateGrokBotAgent');
  assert.notEqual(creates[0].body.agentId, creates[1].body.agentId);
  assert.deepEqual(t.calls.filter(c => c.method === 'DeleteGrokBotAgent').map(c => c.body), [{ id: 'owned-id' }, { id: 'owned-id' }]);
  assert.equal(t.calls.some(c => c.method === 'EnsureGrokBotDefaultMainAgent'), false);
});

test('timeout interrupts and cleans up; parallel request is rejected before sending', async () => {
  const t = fakeTransport({ hang: true });
  const bot = createBot({ transportFactory: () => t, timeoutMs: 30 });
  const first = assert.rejects(bot.ask('one'), e => e.status === 504);
  await assert.rejects(bot.ask('two'), e => e.status === 429);
  await first;
  assert.deepEqual(t.calls.map(c => c.method), ['CreateGrokBotAgent', 'SendGrokBotUserMessage', 'InterruptGrokBotAgentRun', 'DeleteGrokBotAgent']);
});

test('unknown send outcome is not retried and client abort interrupts', async () => {
  const t = fakeTransport({ failSend: true });
  await assert.rejects(createBot({ transportFactory: () => t }).ask('one'), /network failed/);
  assert.equal(t.calls.filter(c => c.method === 'SendGrokBotUserMessage').length, 1);
  assert.equal(t.calls.some(c => c.method === 'InterruptGrokBotAgentRun'), true);
  const hanging = fakeTransport({ hang: true });
  const controller = new AbortController();
  const work = assert.rejects(createBot({ transportFactory: () => hanging }).ask('two', { signal: controller.signal }), e => e.status === 499);
  controller.abort();
  await work;
});

test('does not delete a pre-existing agent returned under a mismatched ID', async () => {
  const calls = [];
  const bot = createBot({ transportFactory: () => ({ async rpc(method) { calls.push(method); return { agent: { agentId: 'someone-else', id: 'existing' } }; } }) });
  await assert.rejects(bot.ask('one'), /isolated/);
  assert.deepEqual(calls, ['CreateGrokBotAgent']);
});

test('validation rejects unsupported semantics instead of silently discarding them', () => {
  const base = { model: 'grok-bot', messages: [{ role: 'user', content: 'hello' }] };
  for (const change of [{ tools: [{ type: 'web_search' }] }, { temperature: 3 }, { model: 'other' }, { stream: 'true' }, { n: 2 }, { messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }]) {
    assert.throws(() => promptFrom({ ...base, ...change }), e => e.status === 400);
  }
  for (const body of [null, [], 'hello', {}]) assert.throws(() => promptFrom(body), e => e.status === 400);
  assert.match(promptFrom({ ...base, messages: [{ role: 'system', content: 'use Russian' }, ...base.messages] }), /"role":"system"/);
});

const request = (base, body, headers = {}) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const valid = { model: 'grok-bot', messages: [{ role: 'user', content: 'Привет' }] };

test('HTTP JSON, buffered SSE and health without consuming upstream quota', async t => {
  let asks = 0;
  const base = await serve(t, { token: '', askFn: async () => { asks++; return { text: 'Ответ' }; }, usageFn: () => { throw new Error('not called'); } });
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal(asks, 0);
  const json = await (await request(base, valid)).json();
  assert.equal(json.choices[0].message.content, 'Ответ');
  const sse = await request(base, { ...valid, stream: true });
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  const events = (await sse.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  assert.equal(events.pop(), '[DONE]');
  const chunks = events.map(JSON.parse);
  assert.equal(new Set(chunks.map(c => c.id)).size, 1);
  assert.equal(chunks[1].choices[0].delta.content, 'Ответ');
  assert.equal(chunks[2].choices[0].finish_reason, 'stop');
});

test('auth, origin, malformed and oversized body never invoke the agent', async t => {
  const base = await serve(t, { token: 'test', askFn: () => { throw new Error('must not run'); } });
  assert.equal((await request(base, valid)).status, 401);
  assert.equal((await request(base, valid, { Authorization: 'Bearer test', Origin: 'https://example.com' })).status, 403);
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer test' };
  assert.equal((await fetch(base + '/v1/chat/completions', { method: 'POST', headers: auth, body: '{' })).status, 400);
  assert.equal((await request(base, { ...valid, padding: 'x'.repeat(2_000_000) }, auth)).status, 413);
});

test('SSE error reports failure, with no successful finish chunk', async t => {
  const base = await serve(t, { token: '', askFn: async () => { throw new ApiError('quota', 429, 'quota'); } });
  const result = await request(base, { ...valid, stream: true });
  const text = await result.text();
  assert.match(text, /"error"/);
  assert.doesNotMatch(text, /"finish_reason":"stop"/);
});

test('streaming transcript text is emitted only after an unchanged later snapshot', async () => {
  const deltas = [];
  const seen = { async *watch() {
    yield rows([row(1, echo()), row(2, answer('partial', { streaming: true })), row(3, answer('second'))]);
    yield rows([row(2, answer('first')), row(3, answer('second'))]);
    yield { rows: { agentId: 'a', entries: [row(2, answer('first'))], deletes: [{ seq: '3' }] } };
    yield rows([row(2, answer('first')), row(3, answer('second'))]);
    yield idle(30);
  } };
  const result = await waitForReply(seen, 'a', '', 'mine', undefined, { onText: text => deltas.push(text) });
  assert.equal(result.text, 'first\n\nsecond');
  assert.deepEqual(deltas, ['first', '\n\nsecond']);
  assert.equal(deltas.some(text => text.includes('partial')), false);
});

test('a confirmed delta cannot be replaced by a later transcript snapshot', async () => {
  const deltas = [];
  await assert.rejects(waitForReply({ async *watch() {
    yield rows([row(1, echo()), row(2, answer('OK'))]);
    yield rows([row(2, answer('OK'))]);
    yield rows([row(2, answer('NO'))]);
    yield idle(30);
  } }, 'a', '', 'mine', undefined, { onText: text => deltas.push(text) }), /replaced/);
  assert.deepEqual(deltas, ['OK']);
});

test('plain-text SSE forwards confirmed deltas and does not repeat the full answer', async t => {
  const baseUrl = await serve(t, { token: '', askFn: async (_text, { onText } = {}) => { onText?.('При'); onText?.('вет'); return { text: 'Привет' }; } });
  const sse = await request(baseUrl, { ...valid, stream: true });
  const contents = (await sse.text()).split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content).filter(Boolean);
  assert.deepEqual(contents, ['При', 'вет']);
});

test('tool calls stay buffered instead of streaming unvalidated agent text', async t => {
  let streamed;
  const baseUrl = await serve(t, { token: '', askFn: async (_text, options = {}) => { streamed = options.onText; return { text: '{"content":"visible","tool_calls":[]}' }; } });
  const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } };
  const response = await request(baseUrl, { ...valid, tools: [tool], stream: true });
  assert.equal(response.status, 200);
  assert.equal(streamed, undefined);
  assert.match(await response.text(), /visible/);
});

test('HTTP disconnect propagates cancellation upstream', async t => {
  let wasAborted;
  const observed = new Promise(resolve => { wasAborted = resolve; });
  const base = await serve(t, { token: '', askFn: (_text, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { wasAborted(true); reject(new ApiError('cancelled', 499)); }, { once: true });
  }) });
  const controller = new AbortController();
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...valid, stream: true }), signal: controller.signal });
  assert.equal(response.status, 200);
  controller.abort();
  assert.equal(await observed, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAdmission } from '../admission.mjs';
import { createServer } from '../server.mjs';
import { createBot } from '../bot.mjs';
import { serveServer as serve } from './helpers.mjs';

const base = { model: 'grok-bot', messages: [{ role: 'user', content: 'Hello' }] };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const post = (url, body, options = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
async function waitPending(url, expected) {
  for (let i = 0; i < 100; i++) {
    const health = await (await fetch(url + '/health')).json();
    if (health.agent_queue.pending === expected) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Queue did not reach expected size');
}

test('admission is FIFO, bounded, idempotently released and cleans aborted waiters', async () => {
  const queue = createAdmission({ maxPending: 2 });
  const release = await queue.acquire();
  const abort = new AbortController();
  const second = queue.acquire(abort.signal);
  const third = queue.acquire();
  await assert.rejects(queue.acquire(), e => e.status === 429 && e.code === 'backend_busy');
  const rejected = assert.rejects(second, /cancel test/);
  abort.abort(new Error('cancel test')); await rejected;
  assert.equal(queue.status().pending, 1);
  const fourth = queue.acquire();
  release(); release();
  const releaseThird = await third;
  assert.equal(queue.status().active, 1); assert.equal(queue.status().pending, 1);
  releaseThird(); (await fourth)();
  assert.equal(queue.status().active, 0); assert.equal(queue.status().pending, 0);
});

test('admission expires waiting requests and shutdown rejects pending and future work', async () => {
  const queue = createAdmission({ maxPending: 1, waitMs: 10 });
  const release = await queue.acquire();
  await assert.rejects(queue.acquire(), e => e.status === 429);
  assert.equal(queue.status().pending, 0);
  const waiting = assert.rejects(queue.acquire(), e => e.code === 'server_shutdown');
  queue.close(); await waiting;
  await assert.rejects(queue.acquire(), e => e.code === 'server_shutdown');
  release(); assert.equal(queue.status().active, 0);
  for (const options of [{ maxPending: -1 }, { maxPending: 33 }, { waitMs: 0 }, { waitMs: NaN }]) assert.throws(() => createAdmission(options));
});

test('queued HTTP turns run once in order; overflow returns JSON 429 before stream headers', async t => {
  const gate = defer(), prompts = [];
  t.after(() => gate.resolve());
  const { url } = await serve(t, { queueLimit: 2, askFn: async prompt => { prompts.push(prompt); if (prompts.length === 1) await gate.promise; return { text: 'done' }; } });
  const first = await post(url + '/v1/chat/completions', { ...base, stream: true });
  const second = post(url + '/v1/responses', { model: 'grok-bot', input: 'SECOND_TURN' });
  await waitPending(url, 1);
  const third = post(url + '/v1/agent', { prompt: 'THIRD_TURN' });
  await waitPending(url, 2);
  const overflow = await post(url + '/v1/chat/completions', { ...base, stream: true });
  assert.equal(overflow.status, 429); assert.equal(overflow.headers.get('retry-after'), '1');
  assert.match(overflow.headers.get('content-type'), /application\/json/);
  assert.equal(prompts.length, 1);
  gate.resolve(); await first.text();
  assert.equal((await second).status, 200); assert.equal((await third).status, 200);
  assert.equal(prompts.length, 3); assert.match(prompts[1], /SECOND_TURN/); assert.equal(prompts[2], 'THIRD_TURN');
});

test('aborting an HTTP request waiting for headers removes it without contacting the bot', async t => {
  const gate = defer(); let calls = 0;
  t.after(() => gate.resolve());
  const { url } = await serve(t, { askFn: async () => { calls++; await gate.promise; return { text: 'done' }; } });
  const first = await post(url + '/v1/chat/completions', { ...base, stream: true });
  const abort = new AbortController();
  const pending = post(url + '/v1/chat/completions', base, { signal: abort.signal });
  const rejected = assert.rejects(pending, e => e.name === 'AbortError');
  await waitPending(url, 1); abort.abort(); await rejected; await waitPending(url, 0);
  gate.resolve(); await first.text(); assert.equal(calls, 1);
});

test('queue deadline returns retryable HTTP status without starting the waiting turn', async t => {
  const gate = defer(); let calls = 0;
  t.after(() => gate.resolve());
  const { url } = await serve(t, { queueWaitMs: 15, askFn: async () => { calls++; await gate.promise; return { text: 'done' }; } });
  const first = await post(url + '/v1/chat/completions', { ...base, stream: true });
  const second = await post(url + '/v1/responses', { model: 'grok-bot', input: 'Hi', stream: true });
  assert.equal(second.status, 429); assert.equal(second.headers.get('retry-after'), '1');
  assert.equal(calls, 1); gate.resolve(); await first.text();
});

test('graceful shutdown waits for actual bot interruption/deletion and never starts queued work', async t => {
  const watching = defer(), deleting = defer(), cleanup = defer(), operations = [];
  t.after(() => cleanup.resolve());
  const bot = createBot({ transportFactory: () => ({
    async rpc(method, body) {
      operations.push(method);
      if (method === 'CreateGrokBotAgent') return { agent: { agentId: body.agentId, id: 'owned', harness: 'temporal' } };
      if (method === 'SendGrokBotUserMessage') return { delivery: 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL' };
      if (method === 'DeleteGrokBotAgent') { deleting.resolve(); await cleanup.promise; }
      return {};
    },
    async *watch(_agent, _session, signal) {
      watching.resolve();
      await new Promise((_, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  }) });
  const { server, url } = await serve(t, { askFn: bot.ask });
  const first = await post(url + '/v1/chat/completions', { ...base, stream: true });
  await watching.promise;
  const queued = post(url + '/v1/chat/completions', base);
  await waitPending(url, 1);
  let finished = false;
  const shutdown = server.shutdown(); shutdown.then(() => { finished = true; });
  assert.equal(server.shutdown(), shutdown);
  await deleting.promise; assert.equal(finished, false);
  const rejected = await queued; assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.code, 'server_shutdown');
  assert.deepEqual(operations, ['CreateGrokBotAgent', 'SendGrokBotUserMessage', 'InterruptGrokBotAgentRun', 'DeleteGrokBotAgent']);
  cleanup.resolve(); assert.equal(await shutdown, true);
  assert.doesNotMatch(await first.text(), /"finish_reason":"stop"/);
});

test('shutdown deadline bounds a hung backend and warns about incomplete cleanup', async t => {
  const warnings = [];
  const { server, url } = await serve(t, { askFn: () => new Promise(() => {}), warn: m => warnings.push(m) });
  const first = await post(url + '/v1/chat/completions', { ...base, stream: true });
  const reading = first.text().catch(() => {});
  assert.equal(await server.shutdown({ timeoutMs: 15 }), false);
  await reading; assert.match(warnings.join('\n'), /deadline exceeded/);
});

test('explicit aliases are listed, retrieved and preserved in Chat/Responses while disclosing backend', async t => {
  const { url } = await serve(t, { modelAliases: 'ide-model, gpt-4o, ide-model' });
  const client = new OpenAI({ baseURL: url + '/v1', apiKey: 'local', maxRetries: 0 });
  assert.deepEqual((await client.models.list()).data.map(m => m.id), ['grok-bot', 'ide-model', 'gpt-4o']);
  assert.equal((await client.models.retrieve('gpt-4o')).owned_by, 'grok-bot');
  const answer = await client.chat.completions.create({ ...base, model: 'ide-model' }).withResponse();
  assert.equal(answer.data.model, 'ide-model'); assert.equal(answer.response.headers.get('x-grokbot-backend'), 'grok-bot');
  const stream = await client.chat.completions.create({ ...base, model: 'gpt-4o', stream: true });
  for await (const c of stream) assert.equal(c.model, 'gpt-4o');
  const response = await client.responses.create({ model: 'ide-model', input: 'Hello' });
  assert.equal(response.model, 'ide-model'); assert.equal((await client.responses.retrieve(response.id)).model, 'ide-model');
  assert.equal((await post(url + '/v1/chat/completions', { ...base, model: 'unknown' })).status, 400);
  assert.throws(() => createServer({ modelAliases: 'bad\r\nheader' }), /ALIASES/);
});

test('usage estimation is opt-in, disclosed in headers/body/streams and retained with Responses history', async t => {
  const { url } = await serve(t, { estimateUsage: true });
  const client = new OpenAI({ baseURL: url + '/v1', apiKey: 'local', maxRetries: 0 });
  const r = await client.chat.completions.create(base).withResponse();
  assert.match(r.response.headers.get('x-grokbot-usage-source'), /estimated/);
  assert.match(r.data.grokbot_usage_source, /not-subscription-usage/);
  assert.ok(Number.isInteger(r.data.usage.prompt_tokens));
  assert.equal(r.data.usage.total_tokens, r.data.usage.prompt_tokens + r.data.usage.completion_tokens);
  const stream = await client.chat.completions.create({ ...base, stream: true, stream_options: { include_usage: true } });
  let usage;
  for await (const chunk of stream) { if (chunk.usage) usage = chunk.usage; }
  assert.deepEqual(usage, r.data.usage);
  const response = await client.responses.create({ model: 'grok-bot', input: 'Hello' });
  assert.ok(response.usage.input_tokens > 0); assert.match(response.grokbot_usage_source, /estimated/);
  const saved = await client.responses.retrieve(response.id).withResponse();
  assert.equal(saved.response.headers.get('x-grokbot-usage-source'), response.grokbot_usage_source);
  const { url: defaults } = await serve(t);
  const plain = await post(defaults + '/v1/chat/completions', base);
  assert.equal(plain.headers.get('x-grokbot-usage-source'), null); assert.equal((await plain.json()).usage, null);
});

test('estimation does not replace native measured usage or fabricate missing native usage', async t => {
  for (const usage of [null, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }]) {
    const { url } = await serve(t, { estimateUsage: true, nativeProvider: { complete: async () => ({ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop', usage }) } });
    const r = await post(url + '/v1/chat/completions', base);
    assert.equal(r.headers.get('x-grokbot-usage-source'), null);
    assert.deepEqual((await r.json()).usage, usage);
  }
});

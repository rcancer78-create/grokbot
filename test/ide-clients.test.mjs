import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createServer } from '../server.mjs';
import { normalizeChat } from '../compatibility.mjs';

const tool = { type: 'function', function: { name: 'read_file', description: 'Read a project file using the IDE.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } };
const reply = JSON.stringify({ content: null, tool_calls: [{ name: 'read_file', arguments: { path: 'example.txt' } }] });
async function serve(t, extra = {}) {
  const server = createServer({ token: 'local-test', askFn: async () => ({ text: reply }), warn: () => {}, ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test('Roo-style OpenAI SDK request with default temperature produces usable tool deltas', async t => {
  const client = new OpenAI({ baseURL: await serve(t), apiKey: 'local-test', maxRetries: 0 });
  const { data: stream, response } = await client.chat.completions.create({ model: 'grok-bot', temperature: 0, messages: [{ role: 'system', content: 'You are Roo. Use read_file.' }, { role: 'user', content: [{ type: 'text', text: 'Read example.txt' }] }], stream: true, stream_options: { include_usage: true }, tools: [tool], tool_choice: 'auto', parallel_tool_calls: true }).withResponse();
  assert.equal(response.headers.get('x-grokbot-ignored-parameters'), 'temperature');
  const chunks = []; for await (const c of stream) chunks.push(c);
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.name, 'read_file');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('Cline-style AI SDK v4 parses text, native function result and a second turn', async t => {
  let n = 0;
  const model = createOpenAICompatible({ name: 'grokbot', baseURL: await serve(t, { askFn: async () => ({ text: n++ === 0 ? reply : JSON.stringify({ content: 'IDE_ROUNDTRIP_OK', tool_calls: [] }) }) }), apiKey: 'local-test', includeUsage: true })('grok-bot');
  const prompt = [{ role: 'system', content: 'You are Cline. Use declared client tools.' }, { role: 'user', content: [{ type: 'text', text: 'Read example.txt' }] }];
  const tools = [{ type: 'function', name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters }];
  const first = await model.doStream({ prompt, tools, toolChoice: { type: 'auto' }, temperature: 0, maxOutputTokens: 8192 });
  const events = []; for await (const e of first.stream) events.push(e);
  assert.equal(events.some(e => e.type === 'error'), false, JSON.stringify(events));
  const call = events.find(e => e.type === 'tool-call');
  assert.equal(call.toolName, 'read_file'); assert.deepEqual(JSON.parse(call.input), { path: 'example.txt' });
  prompt.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: 'IDE_ROUNDTRIP_OK' } }] });
  const second = await model.doStream({ prompt, tools, temperature: 0, maxOutputTokens: 8192 });
  let text = ''; for await (const e of second.stream) { assert.notEqual(e.type, 'error'); if (e.type === 'text-delta') text += e.delta; }
  assert.equal(text, 'IDE_ROUNDTRIP_OK');
});

test('unsupported controls are disclosed, strict mode still rejects them, invalid values never pass', () => {
  const body = { model: 'grok-bot', messages: [{ role: 'user', content: 'Hi' }], temperature: 0, max_tokens: 8192, top_p: null };
  assert.deepEqual(normalizeChat(body).ignored_parameters, ['temperature', 'max_tokens']);
  assert.throws(() => normalizeChat(body, { strictParameters: true }), e => e.status === 400 && e.param === 'temperature');
  assert.deepEqual(normalizeChat(body, { native: true }).ignored_parameters, []);
  assert.throws(() => normalizeChat({ ...body, max_tokens: -1 }), e => e.status === 400);
  assert.throws(() => normalizeChat({ ...body, made_up: true }), e => e.status === 400);
});

test('Roo cache annotations preserve text and are disclosed instead of misreported as images', async t => {
  const client = new OpenAI({ baseURL: await serve(t), apiKey: 'local-test', maxRetries: 0 });
  const { data, response } = await client.chat.completions.create({ model: 'grok-bot', messages: [
    { role: 'system', content: [{ type: 'text', text: 'Use read_file.', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: [{ type: 'text', text: 'Read example.txt', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
  ], tools: [tool] }).withResponse();
  assert.equal(response.headers.get('x-grokbot-ignored-parameters'), 'cache_control');
  assert.equal(data.choices[0].message.tool_calls[0].function.name, 'read_file');
  const body = { model: 'grok-bot', messages: [{ role: 'user', content: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }] }] };
  assert.equal(normalizeChat(body).messages[0].content, 'A\nB');
  assert.throws(() => normalizeChat({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:private' } }] }] }), e => e.param === 'messages[0].content[0]' && !e.message.includes('data:private'));
});

test('modern JSON Schema enforces prefixItems, unevaluatedProperties and local references', () => {
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://example.test/tool', type: 'object', $defs: { path: { type: 'string', minLength: 1 } }, properties: { path: { $ref: '#/$defs/path' }, position: { type: 'array', prefixItems: [{ type: 'integer' }, { type: 'string' }], items: false } }, required: ['path'], unevaluatedProperties: false };
  const request = () => normalizeChat({ model: 'grok-bot', messages: [{ role: 'user', content: 'Hi' }], tools: [{ ...tool, function: { ...tool.function, parameters: schema } }] });
  for (let i = 0; i < 2; i++) {
    const validate = request().tools[0].validate;
    assert.equal(validate({ path: 'a', position: [1, 'b'] }), true);
    assert.equal(validate({ path: '' }), false);
    assert.equal(validate({ path: 'a', position: ['wrong', 'b'] }), false);
    assert.equal(validate({ path: 'a', position: [1, 'b', 2] }), false);
    assert.equal(validate({ path: 'a', extra: 1 }), false);
  }
  const older = { $schema: 'http://json-schema.org/draft/2019-09/schema#', type: 'object', properties: { path: { type: 'string' }, encoding: { type: 'string' } }, dependentRequired: { path: ['encoding'] } };
  const r = normalizeChat({ model: 'grok-bot', messages: [{ role: 'user', content: 'Hi' }], tools: [{ ...tool, function: { ...tool.function, parameters: older } }] });
  assert.equal(r.tools[0].validate({ path: 'a' }), false);
  assert.equal(r.tools[0].validate({ path: 'a', encoding: 'utf8' }), true);
});

test('AI SDK sends and receives tools with a 2020-12 schema', async t => {
  const model = createOpenAICompatible({ name: 'grokbot', baseURL: await serve(t), apiKey: 'local-test' })('grok-bot');
  const result = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Read example.txt' }] }], tools: [{ type: 'function', name: 'read_file', inputSchema: { ...tool.function.parameters, $schema: 'https://json-schema.org/draft/2020-12/schema' } }] });
  let call;
  for await (const event of result.stream) { assert.notEqual(event.type, 'error'); if (event.type === 'tool-call') call = event; }
  assert.equal(call.toolName, 'read_file');
});

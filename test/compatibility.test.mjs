import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChat, parseAgentResult, createCompletionService, parseModelJson } from '../compatibility.mjs';
import { createServer } from '../server.mjs';
import { serve } from './helpers.mjs';
import { createResponseStore } from '../responses.mjs';
import { createInference, decodeProto, encodeInference, pbBytes, pbInt, protoEnvelope, protoFrames } from '../inference.mjs';
import { createProject, runProject, applyReport, unifiedDiff } from '../project.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const base = { model: 'grok-bot', messages: [{ role: 'user', content: 'Read a file.' }] };
const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } };
const envelope = (name = 'read_file', args = { path: 'a.txt' }) => JSON.stringify({ content: null, tool_calls: [{ name, arguments: args }] });

test('literal line breaks in long tool argument strings are escaped without changing their contents', async () => {
  const completion = { type: 'function', function: { name: 'attempt_completion', parameters: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false } } };
  const text = 'Программа читает CSV.\r\n\r\n1. Суммирует суммы.\n2. Сохраняет report.json.\tКонец.';
  const output = JSON.stringify({ content: null, tool_calls: [{ name: 'attempt_completion', arguments: { result: text } }] }).replaceAll('\\r', '\r').replaceAll('\\n', '\n').replaceAll('\\t', '\t');
  let calls = 0; const service = createCompletionService(async () => { calls++; return { text: output }; });
  const result = await service.run(service.normalize({ ...base, tools: [completion] }));
  assert.equal(JSON.parse(result.message.tool_calls[0].function.arguments).result, text); assert.equal(calls, 1);
  assert.deepEqual(parseModelJson('{\n"path":"C:\\\\repo\\\\file", "text":"say \\"hello\\"\nnext"\n}'), { path: 'C:\\repo\\file', text: 'say "hello"\nnext' });
  assert.throws(() => parseModelJson('{"text":"unterminated\n'));
  assert.throws(() => parseModelJson('{"text":"hello",}'));
});

test('ordinary explanations after file reads are valid auto/none answers without another request', async () => {
  const text = 'Программа читает CSV, рассчитывает итоги и показывает таблицу.\n\n```python\nprint("итог")\n```';
  let calls = 0;
  const service = createCompletionService(async () => { calls++; return { text }; });
  for (const tool_choice of ['auto', 'none']) {
    const result = await service.run(service.normalize({ ...base, tools: [tool], tool_choice }));
    assert.equal(result.message.content, text); assert.equal(result.finish_reason, 'stop');
  }
  assert.equal(calls, 2);
  assert.throws(() => parseAgentResult(normalizeChat({ ...base, tools: [tool], tool_choice: 'required' }), text), e => e.code === 'invalid_model_output');
});

test('one fenced function batch can follow commentary but multiple/malformed batches never execute', () => {
  const request = normalizeChat({ ...base, tools: [tool] });
  const message = parseAgentResult(request, 'Сначала прочитаю файл.\n\n```json\n' + envelope() + '\n```');
  assert.equal(message.content, 'Сначала прочитаю файл.'); assert.equal(message.tool_calls[0].function.name, 'read_file');
  assert.throws(() => parseAgentResult(request, '```json\n' + envelope() + '\n```\n```json\n' + envelope() + '\n```'), e => e.code === 'invalid_model_output');
  assert.throws(() => parseAgentResult(request, '{"content":null,"tool_calls":['), e => e.formatRepairable === true);
});

test('format repair runs once without original file contents and validates the converted calls', async () => {
  const prompts = [];
  const service = createCompletionService(async prompt => { prompts.push(prompt); return { text: prompts.length === 1 ? '<read_file><path>a.txt</path></read_file>' : envelope() }; }, undefined, { warn: () => {} });
  const request = service.normalize({ ...base, messages: [{ role: 'user', content: 'PRIVATE_FILE_CONTENT_DO_NOT_REPEAT' }], tools: [tool] });
  const result = await service.run(request);
  assert.equal(result.finish_reason, 'tool_calls'); assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[1], /PRIVATE_FILE_CONTENT_DO_NOT_REPEAT/);
  let failedCalls = 0;
  const broken = createCompletionService(async () => { failedCalls++; return { text: '{"tool_calls":[' }; }, undefined, { warn: () => {} });
  await assert.rejects(broken.run(request), /one format repair failed/); assert.equal(failedCalls, 2);
});

test('schema failures and transport errors do not trigger format repair', async () => {
  for (const output of [envelope('unknown'), envelope('read_file', { path: 2 })]) {
    let calls = 0; const service = createCompletionService(async () => { calls++; return { text: output }; });
    await assert.rejects(service.run(service.normalize({ ...base, tools: [tool] })), e => e.code === 'invalid_model_output');
    assert.equal(calls, 1);
  }
  let calls = 0; const service = createCompletionService(async () => { calls++; throw Object.assign(new Error('quota'), { status: 429 }); });
  await assert.rejects(service.run(service.normalize({ ...base, tools: [tool] })), e => e.status === 429); assert.equal(calls, 1);
});
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('tool choice, schema and history validation prevent unknown or malformed execution', () => {
  const r = normalizeChat({ ...base, tools: [tool], tool_choice: 'required' });
  const message = parseAgentResult(r, envelope());
  assert.equal(message.tool_calls[0].function.arguments, '{"path":"a.txt"}');
  for (const raw of [envelope('unknown'), envelope('read_file', { path: 1 }), envelope('read_file', { path: 'a', extra: true }), '{"content":"ok","tool_calls":[]}', '```json\n{}\n```']) assert.throws(() => parseAgentResult(r, raw), e => e.code === 'invalid_model_output');
  assert.throws(() => parseAgentResult(normalizeChat({ ...base, tools: [tool], tool_choice: 'none' }), envelope()), /tool_choice/);
  assert.throws(() => normalizeChat({ ...base, messages: [...base.messages, message] }), /Missing tool results/);
  const history = [...base.messages, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'hello' }];
  assert.equal(normalizeChat({ ...base, messages: history }).messages.at(-1).name, 'read_file');
  assert.throws(() => normalizeChat({ ...base, messages: [...history, history.at(-1)] }), /duplicate/);
});

test('JSON Schema checks actual output and rejects unsupported schema drafts', () => {
  const request = normalizeChat({ ...base, response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false } } } });
  assert.equal(parseAgentResult(request, '{"ok":true}').content, '{"ok":true}');
  assert.throws(() => parseAgentResult(request, '{"ok":false}'), /response_format/);
  assert.throws(() => normalizeChat({ ...base, tools: [{ ...tool, function: { ...tool.function, parameters: { type: 'object', $ref: 'https://example.com/schema' } } }] }), /Schema/);
});

test('Chat function SSE roundtrip preserves IDs and finish reason', async t => {
  const url = await serve(t, { askFn: async () => ({ text: envelope() }) });
  const r = await post(url + '/v1/chat/completions', { ...base, tools: [tool], stream: true });
  const chunks = (await r.text()).split('\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunks[2].choices[0].finish_reason, 'tool_calls');
  assert.equal((await (await fetch(url + '/v1/capabilities')).json()).function_calling, 'prompt-emulated; schema-validated');
});

test('Responses stores tool history, accepts output, excludes prior instructions, supports delete and SSE', async t => {
  let count = 0, secondPrompt;
  const url = await serve(t, { askFn: async prompt => { count++; if (count === 1) return { text: envelope() }; secondPrompt = prompt; return { text: 'done' }; } });
  const first = await (await post(url + '/v1/responses', { model: 'grok-bot', input: 'Read a.txt', instructions: 'ONCE_ONLY_INSTRUCTION', tools: [{ type: 'function', ...tool.function }] })).json();
  assert.equal(first.output[0].type, 'function_call');
  const next = await post(url + '/v1/responses', { model: 'grok-bot', previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: first.output[0].call_id, output: 'contents' }], stream: true, store: false });
  const sse = await next.text();
  assert.match(sse, /event: response.completed/); assert.match(sse, /event: response.output_text.delta/);
  assert.match(secondPrompt, /contents/); assert.doesNotMatch(secondPrompt, /ONCE_ONLY_INSTRUCTION/);
  assert.equal((await fetch(url + '/v1/responses/' + first.id)).status, 200);
  assert.equal((await fetch(url + '/v1/responses/' + first.id, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(url + '/v1/responses/' + first.id)).status, 404);
});

test('response store bounds bytes, count and expiry and does not mutate stored history', () => {
  let now = 0; const store = createResponseStore({ ttlMs: 10, maxBytes: 100, maxEntries: 1, now: () => now });
  store.set('a', { messages: [] }); const a = store.get('a'); a.messages.push('x'); assert.equal(store.get('a').messages.length, 0);
  store.set('b', {}); assert.throws(() => store.get('a'), e => e.status === 404);
  now = 11; assert.throws(() => store.get('b'), e => e.status === 404);
  assert.throws(() => store.set('c', { text: 'x'.repeat(200) }), e => e.status === 507);
});

test('protobuf decoder rejects truncation, invalid wire types and missing Connect trailer', async () => {
  for (const bytes of [Buffer.from([10, 5, 1]), Buffer.from([8, 128]), Buffer.from([15]), Buffer.from([0])]) assert.throws(() => decodeProto(bytes), /Malformed/);
  const text = protoEnvelope(pbBytes(1, pbBytes(1, 'Привет'))), end = protoEnvelope(Buffer.from('{}'), 2);
  const bytes = Buffer.concat([text, end]), out = [];
  for await (const frame of protoFrames([...bytes].map(b => Buffer.from([b])))) out.push(frame);
  assert.equal(decodeProto(out[0].get(1)[0]).get(1)[0].toString(), 'Привет');
  await assert.rejects(async () => { for await (const _ of protoFrames([text])) {} }, /trailer/);
});

test('native request preserves tool calls/results, token limit, schema workaround and system role', () => {
  const message = parseAgentResult(normalizeChat({ ...base, tools: [tool] }), envelope());
  const req = normalizeChat({ ...base, messages: [{ role: 'system', content: 'rules' }, ...base.messages, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'result' }], tools: [tool], max_tokens: 73 }, { native: true });
  const fields = decodeProto(encodeInference(req));
  assert.equal(decodeProto(fields.get(4)[0]).get(1)[0], 73);
  assert.equal(decodeProto(fields.get(1)[0]).get(1)[0], 4);
  assert.equal(decodeProto(fields.get(2)[0]).has(3), false);
  assert.ok(decodeProto(fields.get(1)[2]).has(4)); assert.ok(decodeProto(fields.get(1)[3]).has(6));
});

test('native renewal is shared, secrets stay out of errors, streaming usage preserved', async () => {
  let renewals = 0, streams = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('inference-credential')) { renewals++; await new Promise(r => setTimeout(r, 10)); return Response.json({ grokBotToken: 'secret', expiresAtMs: Date.now() + 600000 }); }
    streams++; assert.equal(options.headers.Authorization, 'Bearer secret');
    return new Response(Buffer.concat([protoEnvelope(pbBytes(1, pbBytes(1, 'hello'))), protoEnvelope(pbBytes(3, Buffer.concat([pbInt(1, 5), pbInt(2, 2), pbInt(3, 7)]))), protoEnvelope(Buffer.from('{}'), 2)]), { headers: { 'content-type': 'application/connect+proto' } });
  };
  const provider = createInference({ credential: 'renew-secret', machineId: 'machine', fetchImpl });
  const request = normalizeChat(base, { native: true }), deltas = [];
  const [one] = await Promise.all([provider.complete(request, { onDelta: d => deltas.push(d) }), provider.complete(request)]);
  assert.equal(renewals, 1); assert.equal(streams, 2); assert.deepEqual(deltas, [{ content: 'hello' }]); assert.equal(one.usage.total_tokens, 7);
  assert.throws(() => createInference({ credential: '', machineId: '' }), /needs/);
});

test('native completed tool args replace prior deltas instead of duplication', async () => {
  const tc = (args, done) => protoEnvelope(pbBytes(2, Buffer.concat([pbBytes(1, 'call_a'), pbBytes(2, 'read_file'), pbBytes(3, args), pbInt(4, done)])));
  const provider = createInference({ credential: 'c', machineId: 'm', fetchImpl: async url => url.endsWith('inference-credential') ? Response.json({ grokBotToken: 's' }) : new Response(Buffer.concat([tc('{"path":', 0), tc('{"path":"a.txt"}', 1), protoEnvelope(Buffer.from('{}'), 2)]), { headers: { 'content-type': 'application/connect+proto' } }) });
  const result = await provider.complete(normalizeChat({ ...base, tools: [tool] }, { native: true }));
  assert.equal(result.message.tool_calls[0].function.arguments, '{"path":"a.txt"}');
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grokbot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'one two\n'); return root;
}
test('project stages edits, blocks traversal/secrets, detects concurrent changes before writes', async t => {
  const root = await fixture(t), p = await createProject(root);
  await assert.rejects(p.execute('write_file', { path: 'a.txt', content: 'new' }), /Read/);
  for (const file of ['../outside', 'C:\\other', '.env', '.git/config', 'a.txt:stream', 'NUL']) await assert.rejects(p.execute('read_file', { path: file }));
  await p.execute('read_file', { path: 'a.txt' }); await p.execute('replace_text', { path: 'a.txt', old_text: 'two', new_text: 'three' });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one two\n');
  assert.equal((await p.execute('read_file', { path: 'a.txt' })).content, 'one three\n');
  await fs.writeFile(path.join(root, 'a.txt'), 'user changed');
  await assert.rejects(p.apply(), /changed during/); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'user changed');
});
test('project rejects links and applies validated edits including a new file', async t => {
  const root = await fixture(t), p = await createProject(root);
  await fs.link(path.join(root, 'a.txt'), path.join(root, 'hard.txt'));
  await assert.rejects(p.execute('read_file', { path: 'hard.txt' }), /linked/);
  await fs.unlink(path.join(root, 'hard.txt'));
  await p.execute('read_file', { path: 'a.txt' }); await p.execute('replace_text', { path: 'a.txt', old_text: 'two', new_text: 'three' });
  await p.execute('write_file', { path: 'new.txt', content: 'hello' });
  assert.deepEqual(await p.apply(), ['a.txt', 'new.txt']); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one three\n');
});
test('project loop reads, stages and returns changes without applying by default', async t => {
  const root = await fixture(t); let i = 0;
  const results = [envelope('read_file', { path: 'a.txt' }), envelope('replace_text', { path: 'a.txt', old_text: 'two', new_text: 'three' }), '{"content":"Changed two to three.","tool_calls":[]}'];
  const url = await serve(t, { askFn: async () => ({ text: results[i++] }) });
  const result = await runProject({ root, prompt: 'edit', baseUrl: url + '/v1' });
  assert.equal(result.changes[0].after, 'one three\n'); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one two\n');
  const file = path.join(root, 'report.json'); await fs.writeFile(file, JSON.stringify(result));
  assert.deepEqual(await applyReport(file, root), ['a.txt']);
  await assert.rejects(applyReport(file, root), /changed since/);
});
test('unified diff and staged file moves stay off disk until apply', async t => {
  assert.match(unifiedDiff('a.txt', 'one two\n', 'one three\n'), /-one two[\s\S]*\+one three/);
  const root = await fixture(t), p = await createProject(root);
  await assert.rejects(p.execute('delete_file', { path: 'a.txt' }), /Read/);
  await p.execute('write_file', { path: 'fresh.txt', content: 'new' });
  assert.equal((await p.execute('read_file', { path: 'fresh.txt' })).content, 'new');
  await p.execute('delete_file', { path: 'fresh.txt' });
  await p.execute('read_file', { path: 'a.txt' });
  await p.execute('rename_file', { from: 'a.txt', to: 'moved.txt' });
  await p.execute('create_directory', { path: 'sub' });
  await assert.rejects(p.execute('write_file', { path: 'missing/x.txt', content: 'z' }), /Parent/);
  await p.execute('write_file', { path: 'sub/x.txt', content: 'z\n' });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one two\n');
  assert.deepEqual(p.changes().map(c => c.op + ':' + c.path), ['mkdir:sub', 'create:moved.txt', 'create:sub/x.txt', 'delete:a.txt']);
  const report = path.join(root, 'report.json');
  await fs.writeFile(report, JSON.stringify({ root: p.root, changes: p.changes() }));
  assert.deepEqual(await applyReport(report, root), ['sub', 'moved.txt', 'sub/x.txt', 'a.txt']);
  assert.equal(await fs.readFile(path.join(root, 'moved.txt'), 'utf8'), 'one two\n');
  assert.equal(await fs.readFile(path.join(root, 'sub/x.txt'), 'utf8'), 'z\n');
  await assert.rejects(fs.access(path.join(root, 'a.txt')));
});
test('a failed apply restores files already written', async t => {
  const root = await fixture(t), p = await createProject(root);
  const blocked = path.join(root, 'b.txt');
  await fs.writeFile(blocked, 'keep\n');
  t.after(() => fs.chmod(blocked, 0o666).catch(() => {}));
  await p.execute('read_file', { path: 'a.txt' });
  await p.execute('replace_text', { path: 'a.txt', old_text: 'two', new_text: 'three' });
  await p.execute('read_file', { path: 'b.txt' });
  await p.execute('replace_text', { path: 'b.txt', old_text: 'keep', new_text: 'changed' });
  await fs.chmod(blocked, 0o444);
  await assert.rejects(p.apply(), /Rolled back: a\.txt/);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one two\n');
  assert.equal(await fs.readFile(blocked, 'utf8'), 'keep\n');
});

import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
if (!process.argv.includes('--live')) throw new Error('Pass --live: this uses Grok Bot allowance.');
const server = createServer({ token: 'smoke-local' });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function post(route, body) {
  const r = await fetch(base + route, { method: 'POST', headers: { Authorization: 'Bearer smoke-local', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw new Error(JSON.stringify(data)); return data;
}
try {
  if (!process.argv.includes('--json-only')) {
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a local file through the API client.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
  const messages = [{ role: 'user', content: 'Use the declared read_file function for file example.txt. Do not access any computer yourself.' }];
  const first = await post('/v1/chat/completions', { model: 'grok-bot', messages, tools, tool_choice: { type: 'function', function: { name: 'read_file' } }, parallel_tool_calls: false });
  const message = first.choices[0].message;
  assert.equal(first.choices[0].finish_reason, 'tool_calls'); assert.equal(message.tool_calls[0].function.name, 'read_file');
  console.log('Live function call OK');
  messages.push(message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'The file says: TOOL_ROUNDTRIP_OK' });
  const second = await post('/v1/chat/completions', { model: 'grok-bot', messages, tools, tool_choice: 'none' });
  assert.match(second.choices[0].message.content, /TOOL_ROUNDTRIP_OK/); console.log('Live tool result roundtrip OK');
  }
  const third = await post('/v1/responses', { model: 'grok-bot', input: 'Return the JSON object with ok=true and value=42.', text: { format: { type: 'json_schema', name: 'check', strict: true, schema: { type: 'object', properties: { ok: { const: true }, value: { const: 42 } }, required: ['ok', 'value'], additionalProperties: false } } } });
  assert.deepEqual(JSON.parse(third.output[0].content[0].text), { ok: true, value: 42 }); console.log('Live Responses + JSON Schema OK');
} finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }

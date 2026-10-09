import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
if (!process.argv.includes('--live')) throw new Error('Pass --live: consumes Grok Bot allowance. Requires Node >=22 and dev dependencies.');
const baseURL = process.env.GROKBOT_TEST_URL || 'http://127.0.0.1:8788/v1';
const apiKey = process.env.GROKBOT_TOKEN || 'local';
const client = new OpenAI({ baseURL, apiKey, maxRetries: 0, timeout: 240000 });
const parameters = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
const stream = await client.chat.completions.create({ model: 'grok-bot', temperature: 0, max_completion_tokens: 8192, messages: [{ role: 'system', content: [{ type: 'text', text: 'You are an IDE coding assistant. Use the declared client function. Do not use your own computer tools.', cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: 'Read example.txt with read_file.' }], tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file through the IDE.', parameters } }], tool_choice: { type: 'function', function: { name: 'read_file' } }, parallel_tool_calls: false, stream: true, stream_options: { include_usage: true } });
let call, finished;
for await (const chunk of stream) { const choice = chunk.choices[0]; if (choice?.delta.tool_calls?.length) call = choice.delta.tool_calls[0]; if (choice?.finish_reason) finished = choice.finish_reason; }
assert.equal(finished, 'tool_calls'); assert.equal(call.function.name, 'read_file'); assert.equal(JSON.parse(call.function.arguments).path, 'example.txt');
console.log('Roo-style SDK: live streamed function call OK');
const model = createOpenAICompatible({ name: 'grokbot', baseURL, apiKey, includeUsage: true })('grok-bot');
const second = await model.doStream({ temperature: 0, maxOutputTokens: 8192, tools: [{ type: 'function', name: 'read_file', inputSchema: parameters }], toolChoice: { type: 'none' }, prompt: [
  { role: 'system', content: 'Return only the exact content of the file returned by the client. Do not perform any external actions.' },
  { role: 'user', content: [{ type: 'text', text: 'Read example.txt and tell me its contents.' }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call.id, toolName: call.function.name, input: JSON.parse(call.function.arguments) }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.id, toolName: call.function.name, output: { type: 'text', value: 'IDE_CLIENTS_LIVE_OK' } }] },
] });
let text = '';
for await (const e of second.stream) { if (e.type === 'error') throw e.error; if (e.type === 'text-delta') text += e.delta; }
assert.match(text, /IDE_CLIENTS_LIVE_OK/);
console.log('Cline-style AI SDK v4: live streamed tool-result roundtrip OK');

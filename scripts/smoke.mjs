// Explicit live check: consumes a small amount of the user's Grok Bot quota.
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';

if (!process.argv.includes('--live')) throw new Error('Pass --live to use the Grok Bot session and quota.');
const server = createServer({ token: 'smoke-local' });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer smoke-local' },
    body: JSON.stringify({ model: 'grok-bot', stream: true, messages: [{ role: 'user', content: 'Reply with exactly HTTP_SSE_OK.' }] }),
    signal: AbortSignal.timeout(200000),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  assert.equal(events.pop(), '[DONE]');
  const chunks = events.map(JSON.parse);
  assert.equal(chunks.some(c => c.error), false, JSON.stringify(chunks.find(c => c.error)));
  const answer = chunks.map(c => c.choices?.[0]?.delta?.content || '').join('');
  assert.equal(answer.trim(), 'HTTP_SSE_OK');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  console.log(JSON.stringify({ ok: true, answer, chunks: chunks.length }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

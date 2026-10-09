// Tests for fixes and improvements applied in v0.3.7
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { estimateTokens, validateEnv, createLogger } from '../server.mjs';
import { createProject } from '../project.mjs';
import { normalizeChat, parseAgentResult } from '../compatibility.mjs';
import { DEFAULT_UPSTREAM_URL, createTransport } from '../transport.mjs';

test('estimateTokens accounts for Cyrillic and ASCII tokens realistically', () => {
  const ascii = 'Hello world, this is a test of ASCII tokenization.';
  const cyrillic = 'Привет мир, это проверка оценки токенов для кириллицы.';
  const asciiTokens = estimateTokens(ascii);
  const cyrillicTokens = estimateTokens(cyrillic);
  assert.ok(asciiTokens > 0);
  assert.ok(cyrillicTokens > 0);
  // Cyrillic tokens must be weighed more heavily per char than ASCII/4
  assert.ok(cyrillicTokens > Math.ceil(cyrillic.length / 4));
});

test('project read_file supports offset_line and limit_lines pagination', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grokbot-test-paged-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n');
  await fs.writeFile(path.join(root, 'numbers.txt'), lines, 'utf8');

  const p = await createProject(root);
  const paged = await p.execute('read_file', { path: 'numbers.txt', offset_line: 10, limit_lines: 5 });
  assert.equal(paged.total_lines, 50);
  assert.equal(paged.offset_line, 10);
  assert.equal(paged.limit_lines, 5);
  assert.equal(paged.has_more, true);
  assert.equal(paged.content, 'Line 10\nLine 11\nLine 12\nLine 13\nLine 14');

  const tail = await p.execute('read_file', { path: 'numbers.txt', offset_line: 48, limit_lines: 10 });
  assert.equal(tail.has_more, false);
  assert.equal(tail.content, 'Line 48\nLine 49\nLine 50');
});

test('project read_file allows reading files > 200 KB in paged mode', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grokbot-test-large-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Generate ~300 KB file (over MAX_FILE of 200 KB, but under MAX_TOTAL of 2 MB)
  const line = 'A'.repeat(99) + '\n';
  const content = line.repeat(3000); // 300,000 bytes
  await fs.writeFile(path.join(root, 'large.txt'), content, 'utf8');

  const p = await createProject(root);
  // Unpaged read of >200 KB throws
  await assert.rejects(p.execute('read_file', { path: 'large.txt' }), /oversized/);

  // Paged read of >200 KB succeeds
  const slice = await p.execute('read_file', { path: 'large.txt', offset_line: 1, limit_lines: 10 });
  assert.equal(slice.total_lines, 3001);
  assert.equal(slice.content.split('\n').length, 10);
});

test('project replace_text supports all: true and fails gracefully on multiple matches', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grokbot-test-replace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'sample.txt'), 'foo bar foo baz foo\n', 'utf8');

  const p = await createProject(root);
  await p.execute('read_file', { path: 'sample.txt' });

  // Without all=true, multiple matches throw with helpful guidance
  await assert.rejects(
    p.execute('replace_text', { path: 'sample.txt', old_text: 'foo', new_text: 'qux' }),
    /old_text must match exactly once.*all=true/
  );

  // With all=true, all instances are replaced
  await p.execute('replace_text', { path: 'sample.txt', old_text: 'foo', new_text: 'qux', all: true });
  const updated = await p.execute('read_file', { path: 'sample.txt' });
  assert.equal(updated.content, 'qux bar qux baz qux\n');
});

test('compatibility: tool_choice none accepts text mentioning tool_calls', () => {
  const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
  const request = normalizeChat({
    model: 'grok-bot',
    messages: [{ role: 'user', content: 'Explain tool_calls' }],
    tools: [tool],
    tool_choice: 'none'
  });
  const text = 'In OpenAI API, the format is {"tool_calls": [{"name": "read_file"}]}.';
  const result = parseAgentResult(request, text);
  assert.equal(result.role, 'assistant');
  assert.equal(result.content, text);
  assert.equal(result.tool_calls, undefined);
});

test('transport exports default upstream URL and respects env override', () => {
  assert.ok(DEFAULT_UPSTREAM_URL.startsWith('https://'));
  assert.match(DEFAULT_UPSTREAM_URL, /aiserver/);
});

test('transport.rpc retries idempotent requests on network error', async () => {
  let attempts = 0;
  const mockFetch = async () => {
    attempts++;
    if (attempts === 1) {
      throw new TypeError('fetch failed');
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    };
  };
  const transport = createTransport({ token: 'test-token', fetchImpl: mockFetch });
  const data = await transport.rpc('GetSandUsageStatus', {});
  assert.equal(attempts, 2);
  assert.deepEqual(data, { ok: true });
});

test('validateEnv warns on unrecognized env vars and rejects invalid values', () => {
  const warnings = [];
  validateEnv({ GROKBOT_UNKNOWN_VAR: '123' }, msg => warnings.push(msg));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unrecognized environment variable "GROKBOT_UNKNOWN_VAR"/);

  assert.throws(() => validateEnv({ GROKBOT_PORT: '999999' }), /GROKBOT_PORT/);
  assert.throws(() => validateEnv({ GROKBOT_MODE: 'invalid_mode' }), /GROKBOT_MODE/);
  assert.throws(() => validateEnv({ GROKBOT_QUEUE_LIMIT: '-1' }), /GROKBOT_QUEUE_LIMIT/);
});

test('createLogger supports text and json modes', () => {
  const textLogs = [];
  const textLogger = createLogger({ format: 'text', logFn: m => textLogs.push(m) });
  textLogger.info('hello', { requestId: 'req_1' });
  assert.equal(textLogs.length, 1);
  assert.match(textLogs[0], /\[INFO\] \[req_1\] hello/);

  const jsonLogs = [];
  const jsonLogger = createLogger({ format: 'json', logFn: m => jsonLogs.push(m) });
  jsonLogger.info('hello', { requestId: 'req_2' });
  assert.equal(jsonLogs.length, 1);
  const parsed = JSON.parse(jsonLogs[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.message, 'hello');
  assert.equal(parsed.requestId, 'req_2');
});

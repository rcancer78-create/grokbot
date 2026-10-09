import { randomUUID } from 'node:crypto';
import { ApiError, createTransport, FrameBuffer } from './transport.mjs';
import { validateResult } from './compatibility.mjs';

export const DEFAULT_UPSTREAM_MODEL = 'grok-4.6';

const concat = (...parts) => Buffer.concat(parts.flat());
export function varint(n) {
  n = BigInt(n); const out = [];
  do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
export const pbInt = (f, n) => concat(varint(f * 8), varint(n));
export const pbBytes = (f, b) => { b = Buffer.isBuffer(b) ? b : Buffer.from(b); return concat(varint(f * 8 + 2), varint(b.length), b); };
const pbFloat = (f, n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return concat(varint(f * 8 + 5), b); };
const malformed = (cause) => new ApiError('Malformed inference protobuf.', 502, 'invalid_upstream', null, cause ? { cause } : undefined);
export function decodeProto(b) {
  let i = 0; const fields = new Map();
  const read = () => {
    let n = 0n;
    for (let k = 0; k < 10 && i < b.length; k++) { const c = b[i++]; n |= BigInt(c & 127) << BigInt(7 * k); if (!(c & 128)) { if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed(); return Number(n); } }
    throw malformed();
  };
  while (i < b.length) {
    const tag = read(), f = Math.floor(tag / 8), wire = tag & 7;
    if (!f) throw malformed();
    let value;
    if (wire === 0) value = read();
    else {
      const len = wire === 2 ? read() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (len < 0 || i + len > b.length) throw malformed();
      value = b.subarray(i, i + len); i += len;
    }
    if (!fields.has(f)) fields.set(f, []); fields.get(f).push(value);
  }
  return fields;
}
const str = (fields, n) => fields.get(n)?.[0]?.toString('utf8') || '';
const num = (fields, n) => fields.get(n)?.[0] ?? 0;
function protoValue(value) {
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (typeof value === 'string') return pbBytes(3, value);
  if (typeof value === 'boolean') return pbInt(4, Number(value));
  if (typeof value === 'number') { const b = Buffer.alloc(8); b.writeDoubleLE(value); return concat(varint(17), b); }
  if (Array.isArray(value)) return pbBytes(6, concat(value.map(v => pbBytes(1, protoValue(v)))));
  return pbBytes(5, protoStruct(value));
}
function protoStruct(value) { return concat(Object.entries(value).map(([k, v]) => pbBytes(1, concat(pbBytes(1, k), pbBytes(2, protoValue(v)))))); }

export function encodeInference(request, model = 'grok-4.6') {
  const parts = [], known = new Map();
  for (const message of request.messages) {
    const fields = [pbInt(1, { user: 1, assistant: 2, tool: 3, system: 4, developer: 4 }[message.role])];
    if (message.role === 'tool') {
      fields.push(pbBytes(6, pbBytes(1, concat(pbBytes(1, message.tool_call_id), pbBytes(2, known.get(message.tool_call_id) || message.name || ''), pbBytes(3, protoValue(message.content))))));
    } else {
      if (message.content !== null) fields.push(pbBytes(2, message.name ? `${message.name}: ${message.content}` : message.content));
      for (const call of message.tool_calls || []) {
        known.set(call.id, call.function.name);
        fields.push(pbBytes(4, concat(pbBytes(1, call.id), pbBytes(2, call.function.name), pbBytes(3, protoStruct(JSON.parse(call.function.arguments))), pbBytes(4, call.function.arguments))));
      }
    }
    parts.push(pbBytes(1, concat(fields)));
  }
  if (request.format.type !== 'text' || request.choice === 'required' || request.forced || request.parallel_tool_calls === false) {
    const instruction = [request.format.type === 'text' ? '' : `Return JSON ${request.format.type === 'json_schema' ? 'conforming to ' + JSON.stringify(request.format.json_schema.schema) : 'with an object root'}.`, request.forced ? `Call ${request.forced}.` : request.choice === 'required' ? 'Call a declared function.' : '', request.parallel_tool_calls === false ? 'Call at most one function.' : ''].join(' ');
    parts.unshift(pbBytes(1, concat(pbInt(1, 4), pbBytes(2, instruction))));
  }
  for (const tool of request.choice === 'none' ? [] : request.tools.filter(t => !request.forced || t.function.name === request.forced)) {
    // Provider rejects field 3 parameters. Keep native calls; describe schema in field 2.
    parts.push(pbBytes(2, concat(pbBytes(1, tool.function.name), pbBytes(2, (tool.function.description || '') + '\nArguments JSON Schema: ' + JSON.stringify(tool.function.parameters)))));
  }
  const config = [];
  const limit = request.max_completion_tokens ?? request.max_tokens;
  if (limit !== undefined) config.push(pbInt(1, limit));
  if (request.temperature !== undefined) config.push(pbFloat(2, request.temperature));
  if (request.top_p !== undefined) config.push(pbFloat(3, request.top_p));
  for (const stop of typeof request.stop === 'string' ? [request.stop] : request.stop || []) config.push(pbBytes(4, stop));
  if (config.length) parts.push(pbBytes(4, concat(config)));
  parts.push(pbBytes(7, concat(pbBytes(1, model), ...[['effort', 'high'], ['fast', 'true']].map(([k, v]) => pbBytes(3, concat(pbBytes(1, k), pbBytes(2, v)))))));
  const conversation = randomUUID();
  parts.push(pbBytes(6, randomUUID()), pbBytes(8, conversation), pbBytes(12, conversation));
  return concat(parts);
}
export function checksum(machineId, now = Date.now()) {
  let n = BigInt(Math.floor(now / 1e6)); const b = Buffer.alloc(6);
  for (let i = 5; i >= 0; i--) { b[i] = Number(n & 255n); n >>= 8n; }
  const CHECKSUM_SEED = 165; let last = CHECKSUM_SEED;
  for (let i = 0; i < 6; i++) { b[i] = ((b[i] ^ last) + i) & 255; last = b[i]; }
  return b.toString('base64url') + machineId;
}
export function protoEnvelope(payload, flags = 0) {
  const h = Buffer.alloc(5);
  h[0] = flags;
  h.writeUInt32BE(payload.length, 1);
  return concat(h, payload);
}

export async function* protoFrames(body) {
  const fb = new FrameBuffer();
  let ended = false;
  for await (const chunk of body) {
    if (ended) throw malformed();
    fb.append(chunk);
    while (fb.length >= 5) {
      const flags = fb.byte(0);
      const len = fb.readUInt32BE(1);
      if (![0, 2].includes(flags) || len > 8_000_000) throw malformed();
      if (fb.length < len + 5) break;
      const payload = Buffer.from(fb.slice(5, len));
      fb.consume(len + 5);
      if (flags === 2) {
        let end;
        try {
          end = JSON.parse(payload.toString());
        } catch (err) {
          throw malformed(err);
        }
        if (end.error) {
          throw new ApiError('Inference service rejected the request.', end.error.code === 'resource_exhausted' ? 429 : 502, 'inference_error');
        }
        if (fb.length) throw malformed();
        ended = true;
        break;
      }
      yield decodeProto(payload);
    }
  }
  if (fb.length || !ended) throw new ApiError('Inference stream ended without a complete trailer.', 502, 'truncated_stream');
}

export function createInference({ credential = process.env.GROKBOT_RENEWAL_CREDENTIAL || process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL, machineId = process.env.GROKBOT_MACHINE_ID || process.env.SAND_MACHINE_ID, model = process.env.GROKBOT_UPSTREAM_MODEL || DEFAULT_UPSTREAM_MODEL, fetchImpl = fetch } = {}) {
  if (!credential || !machineId) throw new ApiError('Native mode needs GROKBOT_RENEWAL_CREDENTIAL and its matching GROKBOT_MACHINE_ID. The desktop session is not an inference credential.', 503, 'native_not_configured');
  let cached, renewing;
  const metadata = (requestId) => ({
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': '0.30.0',
    'x-sand-box-namespace': 'prod',
    'x-cursor-checksum': checksum(machineId),
    'x-ghost-mode': 'true',
    'x-request-id': requestId || randomUUID(),
  });
  async function token() {
    if (cached && cached.expires > Date.now() + 120000) return cached.token;
    if (!renewing) renewing = (async () => {
      const r = await fetchImpl('https://api2.cursor.sh/sand-box/inference-credential', {
        method: 'POST',
        redirect: 'error',
        headers: { ...metadata(), 'content-type': 'application/json' },
        body: JSON.stringify({ credential }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw new ApiError('Grok Bot inference credential renewal failed.', r.status === 429 ? 429 : 503, 'native_auth_failed');
      }
      const data = await r.json(), access = data.grokBotToken || data.grok_bot_token;
      if (!access) throw new ApiError('Renewal did not return a Grok Bot inference token.', 503, 'native_auth_failed');
      let expiry;
      try { expiry = JSON.parse(Buffer.from(access.split('.')[1], 'base64url')).exp * 1000; } catch {}
      cached = { token: access, sessionToken: data.accessToken, expires: Number(data.expiresAtMs) || expiry || Date.now() + 600000 };
      return access;
    })().finally(() => { renewing = null; });
    return renewing;
  }
  return {
    async usage({ signal } = {}) {
      await token();
      signal?.throwIfAborted();
      if (!cached.sessionToken) throw new ApiError('Renewal returned no session token for quota lookup.', 503, 'usage_unavailable');
      const data = await createTransport({ token: cached.sessionToken, fetchImpl }).rpc('GetSandUsageStatus', {}, { signal, service: 'DashboardService' });
      return {
        source: 'grok-bot',
        host: 'api2.cursor.sh',
        plan: data.grokPlanLabel || 'Grok Bot',
        usagePercent: data.usagePercent ?? null,
        hasAvailableUsage: data.hasAvailableUsage ?? null,
        resetAt: data.nextResetTimestampUtc || null,
      };
    },
    async complete(request, { signal, requestId, onDelta } = {}) {
      const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
      const access = await token();
      bounded.throwIfAborted();
      const reqId = requestId || signal?.requestId;
      const r = await fetchImpl('https://api2.cursor.sh/aiserver.v1.InferenceService/Stream', {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...metadata(reqId),
          Authorization: `Bearer ${access}`,
          'content-type': 'application/connect+proto',
          'connect-protocol-version': '1',
          'connect-timeout-ms': '180000',
        },
        body: protoEnvelope(encodeInference(request, model)),
        signal: bounded,
      });
      if (!r.ok) {
        await r.body?.cancel();
        if ([401, 403].includes(r.status)) cached = null;
        throw new ApiError('Grok Bot inference request failed; it was not retried.', r.status === 429 ? 429 : 502, 'inference_error');
      }
      if (!r.headers.get('content-type')?.startsWith('application/connect+proto')) {
        await r.body?.cancel();
        throw malformed();
      }
      let content = '', usage = null;
      const calls = new Map();
      // Structured outputs/functions are buffered until validation, so clients cannot execute invalid deltas.
      const incremental = !request.tools.length && request.format.type === 'text';
      for await (const f of protoFrames(r.body)) {
        if (f.has(8)) { cached = null; throw new ApiError('Inference service reported a generation error.', 502, 'inference_error'); }
        for (const p of f.get(1) || []) { const text = str(decodeProto(p), 1); content += text; if (incremental && text) onDelta?.({ content: text }); }
        for (const p of f.get(2) || []) {
          const t = decodeProto(p), id = str(t, 1), index = num(t, 5);
          const key = id || `index:${index}`;
          let call = calls.get(key) || [...calls.values()].find(c => c.index === index && (!id || c.id === id));
          if (!call) { call = { id, index, name: '', arguments: '', complete: false }; calls.set(key, call); }
          call.id ||= id; call.name ||= str(t, 2);
          const args = str(t, 3);
          if (num(t, 4)) { call.arguments = args || call.arguments; call.complete = true; } else call.arguments += args;
        }
        for (const p of f.get(3) || []) { const u = decodeProto(p); usage = { prompt_tokens: num(u, 1), completion_tokens: num(u, 2), total_tokens: num(u, 3) || num(u, 1) + num(u, 2) }; }
        for (const p of f.get(5) || []) { const u = decodeProto(p); usage = { prompt_tokens: num(u, 1), completion_tokens: num(u, 2), total_tokens: num(u, 1) + num(u, 2), prompt_tokens_details: { cached_tokens: num(u, 3) } }; }
      }
      if ([...calls.values()].some(c => !c.complete)) throw new ApiError('Incomplete native tool call.', 502, 'invalid_model_output');
      const message = validateResult(request, { content: content || (calls.size ? null : ''), tool_calls: [...calls.values()].map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) });
      if (!incremental) onDelta?.(message);
      const limit = request.max_completion_tokens ?? request.max_tokens;
      const truncated = !calls.size && limit !== undefined && usage && usage.completion_tokens >= limit;
      return { message, finish_reason: calls.size ? 'tool_calls' : truncated ? 'length' : 'stop', usage };
    },
  };
}

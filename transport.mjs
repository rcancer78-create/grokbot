import { loadSession } from './session.mjs';

export const DEFAULT_UPSTREAM_URL = 'https://api2.cursor.sh/aiserver.v1.';
const API = process.env.GROKBOT_UPSTREAM_URL || DEFAULT_UPSTREAM_URL;

export class ApiError extends Error {
  constructor(message, status = 502, code = 'upstream_error', param = null, options = undefined) {
    super(message, options);
    Object.assign(this, { status, code, param });
  }
}

function remoteError(status, data) {
  const code = data?.code || 'upstream_error';
  const mapped = {
    resource_exhausted: 429,
    unauthenticated: 503,
    permission_denied: 403,
    deadline_exceeded: 504,
  };
  return new ApiError(
    `Grok Bot: ${data?.message || `HTTP ${status}`}`,
    mapped[code] || (status === 429 ? 429 : 502),
    code
  );
}

export function envelope(value, flags = 0) {
  const data = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}

export class FrameBuffer {
  constructor(initialCapacity = 16384) {
    this.buf = Buffer.alloc(initialCapacity);
    this.start = 0;
    this.end = 0;
  }

  append(chunk) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const len = buf.length;
    if (this.start > 0 && this.end + len > this.buf.length) {
      this.buf.copy(this.buf, 0, this.start, this.end);
      this.end -= this.start;
      this.start = 0;
    }
    if (this.end + len > this.buf.length) {
      const next = Buffer.alloc(Math.max(this.buf.length * 2, this.end + len));
      this.buf.copy(next, 0, this.start, this.end);
      this.end -= this.start;
      this.start = 0;
      this.buf = next;
    }
    buf.copy(this.buf, this.end);
    this.end += len;
  }

  get length() {
    return this.end - this.start;
  }

  readUInt32BE(offset) {
    return this.buf.readUInt32BE(this.start + offset);
  }

  byte(offset) {
    return this.buf[this.start + offset];
  }

  slice(offset, len) {
    return this.buf.subarray(this.start + offset, this.start + offset + len);
  }

  consume(len) {
    this.start += len;
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
  }
}

export async function* decodeFrames(body) {
  const fb = new FrameBuffer();
  for await (const chunk of body) {
    fb.append(chunk);
    while (fb.length >= 5) {
      const length = fb.readUInt32BE(1);
      if (length > 8_000_000) throw new ApiError('Grok Bot stream frame is too large.');
      if (fb.length < length + 5) break;
      const flags = fb.byte(0);
      if (flags !== 0 && flags !== 2) throw new ApiError('Unsupported Connect frame flags.');
      let value;
      try {
        value = JSON.parse(fb.slice(5, length).toString('utf8'));
      } catch (err) {
        throw new ApiError('Malformed Grok Bot stream JSON.', 502, 'upstream_error', null, { cause: err });
      }
      fb.consume(5 + length);
      if (flags === 2) {
        if (value.error) throw remoteError(502, value.error);
        return;
      }
      yield value;
    }
  }
  if (fb.length) throw new ApiError('Truncated Grok Bot stream frame.');
}

// Pin the account for the entire operation, including cleanup after an account switch.
export function createTransport({ token, fetchImpl = fetch } = {}) {
  let resolvedToken = token;
  const getToken = async () => {
    if (!resolvedToken) {
      const session = await loadSession();
      resolvedToken = session.token;
    }
    return resolvedToken;
  };

  return {
    async rpc(method, body, { signal, requestId, service = 'GrokBotService' } = {}) {
      const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      const actualToken = await getToken();
      const reqId = requestId || signal?.requestId;
      const headers = {
        Authorization: `Bearer ${actualToken}`,
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json',
        ...(reqId ? { 'x-request-id': reqId } : {}),
      };

      const isIdempotent = method.startsWith('Get') || method.startsWith('Check') ||
        method === 'DeleteGrokBotAgent' || method === 'InterruptGrokBotAgentRun';
      const maxAttempts = isIdempotent ? 2 : 1;
      let lastError;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        bounded.throwIfAborted();
        let response;
        try {
          response = await fetchImpl(`${API}${service}/${method}`, {
            method: 'POST',
            redirect: 'error',
            headers,
            body: JSON.stringify(body),
            signal: bounded,
          });
        } catch (err) {
          if (bounded.aborted) throw bounded.reason;
          lastError = err;
          if (attempt < maxAttempts && (err instanceof TypeError || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
            continue;
          }
          throw new ApiError(`Grok Bot network error: ${err.message}`, 502, 'network_error', null, { cause: err });
        }

        let data;
        try {
          data = await response.json();
        } catch (err) {
          if (bounded.aborted) throw bounded.reason;
          throw new ApiError('Grok Bot returned invalid JSON.', 502, 'upstream_error', null, { cause: err });
        }

        if (!response.ok) throw remoteError(response.status, data);
        return data;
      }
      throw lastError;
    },

    async *watch(agentId, sessionId, signal, { requestId } = {}) {
      const actualToken = await getToken();
      const reqId = requestId || signal?.requestId;
      const headers = {
        Authorization: `Bearer ${actualToken}`,
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/connect+json',
        ...(reqId ? { 'x-request-id': reqId } : {}),
      };

      const response = await fetchImpl(`${API}GrokBotService/WatchGrokBotTranscripts`, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: envelope({
          cursors: [{ agentId, sessionId, generation: 0, afterUpdatedSeq: '0' }],
          inlineBodyMaxBytes: 2_000_000,
        }),
        signal,
      });

      if (!response.ok) {
        throw remoteError(response.status, await response.json().catch(() => ({})));
      }
      if (!response.headers.get('content-type')?.startsWith('application/connect+json')) {
        throw new ApiError('Unexpected Grok Bot stream content type.');
      }
      yield* decodeFrames(response.body);
    },
  };
}

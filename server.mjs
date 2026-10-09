import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ask, usage } from './bot.mjs';
import { ApiError } from './transport.mjs';
import { createCompletionService, normalizeChat, agentPrompt } from './compatibility.mjs';
import { createInference } from './inference.mjs';
import { createResponseStore, responseRequest, responseObject, responseEvents, responseParameter } from './responses.mjs';
import { createAdmission } from './admission.mjs';
import { VERSION } from './version.mjs';

const BODY_LIMIT = 2_000_000;
const MODEL = { id: 'grok-bot', object: 'model', created: 0, owned_by: 'grok-bot' };
const ESTIMATED_USAGE = 'estimated-bpe-heuristic; not-subscription-usage';

export function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii * 1.2);
}

const invalid = (message, param = null, options = undefined) => new ApiError(message, 400, 'invalid_request', param, options);

export function promptFrom(body, agent = false) {
  if (!agent) return agentPrompt(normalizeChat(body));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected a JSON object.');
  for (const key of Object.keys(body)) {
    if (key !== 'prompt') throw invalid(`Unsupported parameter: ${key}.`, key);
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw invalid('prompt is required.', 'prompt');
  return body.prompt;
}

function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        if (!rejected) {
          rejected = true;
          chunks.length = 0;
          reject(new ApiError('Request body too large.', 413, 'body_too_large'));
        }
      } else if (!rejected) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(invalid('Invalid JSON.', null, { cause: err }));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(invalid('Request body interrupted.')));
  });
}

function authorized(req, token) {
  if (!token) return true;
  const a = Buffer.from(req.headers.authorization || '');
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorPayload(error) {
  const known = error instanceof ApiError;
  return {
    error: {
      message: known ? error.message : 'Grok Bot is unavailable. Check sign-in and network access.',
      type: error.status === 401 ? 'authentication_error'
        : error.status === 403 ? 'permission_error'
        : error.status === 429 ? 'rate_limit_error'
        : error.status >= 400 && error.status < 500 ? 'invalid_request_error'
        : known && ['invalid_model_output', 'cursor_lost', 'interaction_required', 'transcript_replaced'].includes(error.code) ? 'invalid_request_error'
        : 'api_error',
      code: known ? error.code : 'backend_unavailable',
      param: error.param || null,
    },
  };
}

export function validateEnv(env = process.env, warn = console.warn) {
  const recognized = new Set([
    'GROKBOT_TOKEN',
    'GROKBOT_HOST',
    'GROKBOT_PORT',
    'GROKBOT_MODE',
    'GROKBOT_QUEUE_LIMIT',
    'GROKBOT_QUEUE_WAIT_MS',
    'GROKBOT_MODEL_ALIASES',
    'GROKBOT_ESTIMATE_USAGE',
    'GROKBOT_STRICT_PARAMETERS',
    'GROKBOT_UPSTREAM_URL',
    'GROKBOT_UPSTREAM_MODEL',
    'GROKBOT_RENEWAL_CREDENTIAL',
    'GROKBOT_MACHINE_ID',
    'GROKBOT_LOG_FORMAT',
  ]);
  for (const key of Object.keys(env)) {
    if (key.startsWith('GROKBOT_') && !recognized.has(key)) {
      warn(`[grokbot] Warning: unrecognized environment variable "${key}". Check spelling.`);
    }
  }
  if (env.GROKBOT_PORT) {
    const port = Number(env.GROKBOT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`GROKBOT_PORT must be an integer between 1 and 65535 (got "${env.GROKBOT_PORT}").`);
    }
  }
  if (env.GROKBOT_MODE && !['agent', 'native'].includes(env.GROKBOT_MODE)) {
    throw new Error('GROKBOT_MODE must be agent or native.');
  }
  if (env.GROKBOT_QUEUE_LIMIT !== undefined) {
    const limit = Number(env.GROKBOT_QUEUE_LIMIT);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('GROKBOT_QUEUE_LIMIT must be a non-negative integer.');
    }
  }
  if (env.GROKBOT_QUEUE_WAIT_MS !== undefined) {
    const wait = Number(env.GROKBOT_QUEUE_WAIT_MS);
    if (!Number.isInteger(wait) || wait <= 0) {
      throw new Error('GROKBOT_QUEUE_WAIT_MS must be a positive integer.');
    }
  }
}

export function createLogger({ format = process.env.GROKBOT_LOG_FORMAT || 'text', logFn = console.log, warnFn = console.warn, errorFn = console.error } = {}) {
  return {
    info(message, meta = {}) {
      if (format === 'json') logFn(JSON.stringify({ time: new Date().toISOString(), level: 'info', message, ...meta }));
      else logFn(`[${new Date().toISOString()}] [INFO] ${meta.requestId ? `[${meta.requestId}] ` : ''}${message}`);
    },
    warn(message, meta = {}) {
      if (format === 'json') warnFn(JSON.stringify({ time: new Date().toISOString(), level: 'warn', message, ...meta }));
      else warnFn(`[${new Date().toISOString()}] [WARN] ${meta.requestId ? `[${meta.requestId}] ` : ''}${message}`);
    },
    error(message, meta = {}) {
      if (format === 'json') errorFn(JSON.stringify({ time: new Date().toISOString(), level: 'error', message, ...meta }));
      else errorFn(`[${new Date().toISOString()}] [ERROR] ${meta.requestId ? `[${meta.requestId}] ` : ''}${message}`);
    },
  };
}

function handleProbe(res, url, { token, service, models, admission, strictParameters, estimateUsage, validationErrors }) {
  if (url.pathname === '/v1/diagnostics') {
    return send(res, 200, { version: VERSION, validation_errors: validationErrors });
  }

  const compact = url.searchParams.get('compact') === '1';
  if (compact) {
    return send(res, 200, {
      status: 'ok',
      version: VERSION,
      mode: service.native ? 'native-inference' : 'agent',
    });
  }

  return send(res, 200, {
    ok: true,
    version: VERSION,
    backend: 'grok-bot',
    mode: service.native ? 'native-inference' : 'agent',
    authentication: token ? 'token-required' : 'loopback-trusted',
    model_aliases: models.slice(1),
    agent_queue: admission.status(),
    parameter_policy: strictParameters ? 'strict' : 'compatibility; unsupported controls reported in X-Grokbot-Ignored-Parameters',
    isolation: service.native ? 'stateless-inference' : 'temporary-agent',
    streaming: service.native ? 'text-deltas; tools/responses buffered' : 'stable-transcript-deltas; tools-and-json-buffered',
    function_calling: service.native ? 'native-protobuf; schema-validated' : 'prompt-emulated; schema-validated',
    structured_outputs: 'prompted-and-validated; no-constrained-decoding',
    schema_validation: 'always; strict flag does not disable validation',
    responses: true,
    response_storage: 'process-memory; 1h; 100 entries; 16MB',
    modalities: ['text'],
    local_execution: 'client-owned',
    usage_tokens: service.native ? 'upstream-or-null' : estimateUsage ? ESTIMATED_USAGE : null,
  });
}

function handleModels(res, url, models) {
  if (url.pathname === '/v1/models') {
    return send(res, 200, { object: 'list', data: models.map(id => ({ ...MODEL, id })) });
  }
  const id = url.pathname.slice('/v1/models/'.length);
  if (!models.includes(id)) {
    throw new ApiError('Model not found.', 404, 'model_not_found', 'model');
  }
  return send(res, 200, { ...MODEL, id });
}

function handleResponses(req, res, url, responseStore) {
  const responseId = /^\/v1\/responses\/(resp_[\w-]+)$/.exec(url.pathname)?.[1];
  if (!responseId) return false;
  if (req.method === 'GET') {
    const saved = responseStore.get(responseId).response;
    if (saved.grokbot_usage_source) res.setHeader('X-Grokbot-Usage-Source', saved.grokbot_usage_source);
    send(res, 200, saved);
    return true;
  }
  if (req.method === 'DELETE') {
    if (!responseStore.delete(responseId)) throw new ApiError('Response not found.', 404, 'response_not_found');
    send(res, 200, { id: responseId, object: 'response.deleted', deleted: true });
    return true;
  }
  return false;
}

export function createServer({
  askFn = ask,
  usageFn,
  token = process.env.GROKBOT_TOKEN || '',
  nativeProvider,
  responseStore = createResponseStore(),
  strictParameters = process.env.GROKBOT_STRICT_PARAMETERS === '1',
  warn = console.warn,
  modelAliases = process.env.GROKBOT_MODEL_ALIASES || '',
  queueLimit = Number(process.env.GROKBOT_QUEUE_LIMIT ?? 4),
  queueWaitMs = Number(process.env.GROKBOT_QUEUE_WAIT_MS ?? 30000),
  estimateUsage = process.env.GROKBOT_ESTIMATE_USAGE === '1',
} = {}) {
  const aliases = modelAliases.split(',').map(x => x.trim()).filter(Boolean);
  if (aliases.length > 32 || aliases.some(x => !/^[\w.-]{1,128}$/.test(x))) {
    throw new Error('GROKBOT_MODEL_ALIASES must contain up to 32 comma-separated IDs (letters, digits, _, . or -).');
  }
  const models = [...new Set(['grok-bot', ...aliases])];
  const service = createCompletionService(askFn, nativeProvider, { strictParameters, warn, models });
  const warnedControls = new Set();
  const validationErrors = [];
  const readUsage = usageFn || nativeProvider?.usage || usage;
  const admission = createAdmission({ maxPending: queueLimit, waitMs: queueWaitMs });
  const controllers = new Set();
  const tasks = new Set();
  let stopping = false;
  let shutdownPromise;

  const server = http.createServer((req, res) => {
    const requestId = `req_${randomUUID()}`;
    res.setHeader('x-request-id', requestId);
    res.setHeader('X-Grokbot-Backend', 'grok-bot');
    const controller = new AbortController();
    controllers.add(controller);
    controller.signal.addEventListener('abort', () => { if (!req.complete) req.destroy(); }, { once: true });
    res.on('close', () => {
      clearInterval(heartbeat);
      if (!res.writableEnded) controller.abort();
    });
    let heartbeat;
    let releaseAgent;

    const route = async () => {
      if (stopping) throw new ApiError('Server is shutting down.', 503, 'server_shutdown');
      // No permissive browser CORS: a random web page must not invoke the local agent.
      if (req.headers.origin) throw new ApiError('Browser origins are not enabled.', 403, 'origin_forbidden');
      const url = new URL(req.url, 'http://localhost');

      // Health, capabilities and diagnostics are intentionally unauthenticated so
      // external monitors and load balancers can probe the server without a token.
      // With a token configured, every request (including probes) must present it.
      const isProbePath = url.pathname === '/health' || url.pathname === '/v1/capabilities' || url.pathname === '/v1/diagnostics';
      const isPublicProbe = req.method === 'GET' && isProbePath && !token;
      if (!isPublicProbe && !authorized(req, token)) throw new ApiError('Unauthorized.', 401, 'invalid_api_key');

      if (req.method === 'GET' && isProbePath) {
        return handleProbe(res, url, { token, service, models, admission, strictParameters, estimateUsage, validationErrors });
      }

      if (req.method === 'GET' && url.pathname === '/usage') {
        return send(res, 200, await readUsage({ signal: controller.signal }));
      }

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/'))) {
        return handleModels(res, url, models);
      }

      if (handleResponses(req, res, url, responseStore)) return;

      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/agent', '/v1/responses'].includes(url.pathname)) {
        throw new ApiError('Not found.', 404, 'not_found');
      }
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        throw new ApiError('Content-Type must be application/json.', 415, 'unsupported_media_type');
      }

      const body = await readBody(req);
      const agent = url.pathname === '/v1/agent';
      const responses = url.pathname === '/v1/responses';
      const converted = responses ? responseRequest(body, responseStore) : null;
      let request;
      try {
        request = agent ? null : service.normalize(converted?.chat || body);
      } catch (error) {
        if (responses && error instanceof ApiError) error.param = responseParameter(error.param);
        throw error;
      }

      if (responses) request.ignored_parameters = request.ignored_parameters.map(responseParameter);
      if (request?.ignored_parameters.length) {
        const ignored = request.ignored_parameters.join(',');
        res.setHeader('X-Grokbot-Ignored-Parameters', ignored);
        if (!warnedControls.has(ignored)) {
          if (warnedControls.size >= 100) warnedControls.clear();
          warnedControls.add(ignored);
          warn(`Grok Bot ${service.native ? 'native' : 'agent'} cannot enforce these client controls: ${ignored}. See /v1/capabilities. Set GROKBOT_STRICT_PARAMETERS=1 to reject them.`);
        }
      }

      const prompt = agent ? promptFrom(body, true) : null;
      // Reserve the entire agent turn, including format repair and cleanup, before SSE.
      if (agent || !service.native) releaseAgent = await admission.acquire(controller.signal);
      controller.signal.throwIfAborted();

      const estimated = !agent && !service.native && estimateUsage;
      const usageDisclosure = estimated ? { grokbot_usage_source: ESTIMATED_USAGE } : {};
      if (estimated) res.setHeader('X-Grokbot-Usage-Source', ESTIMATED_USAGE);

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        });
        res.write(': waiting for Grok Bot\n\n');
        heartbeat = setInterval(() => { if (!res.destroyed) res.write(': waiting\n\n'); }, 10000);
      }

      if (agent) {
        const result = await askFn(prompt, { signal: controller.signal, requestId });
        return send(res, 200, { text: result.text, delivery: result.delivery, source: 'grok-bot' });
      }

      const chunk = (delta, finish_reason = null, usageValue) => res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: request.model,
          ...usageDisclosure,
          choices: usageValue !== undefined ? [] : [{ index: 0, delta, finish_reason, logprobs: null }],
          ...(usageValue !== undefined ? { usage: usageValue } : {}),
        })}\n\n`
      );

      if (body.stream && !responses) chunk({ role: 'assistant', content: '' });

      const result = await service.run(request, {
        signal: controller.signal,
        requestId,
        onDelta: body.stream && !responses ? delta => {
          if (res.destroyed) return;
          const { role, ...value } = delta;
          if (value.tool_calls) value.tool_calls = value.tool_calls.map((c, index) => ({ index, ...c }));
          chunk(value);
        } : undefined,
      });

      if (res.destroyed) return;

      if (!service.native && estimateUsage && result.usage == null) {
        const prompt_tokens = estimateTokens(agentPrompt(request));
        const completion_tokens = estimateTokens(JSON.stringify(result.message));
        result.usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
      }

      if (responses) {
        const response = { ...responseObject(body, result), ...usageDisclosure };
        if (body.store !== false) responseStore.set(response.id, { response, messages: [...converted.messages, result.message] });
        if (body.stream) {
          for (const e of responseEvents(response)) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          res.end();
        } else {
          send(res, 200, response);
        }
        return;
      }

      if (body.stream) {
        chunk({}, result.finish_reason);
        if (request.stream_options?.include_usage && result.usage) chunk({}, null, result.usage);
        res.end('data: [DONE]\n\n');
      } else {
        send(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: request.model,
          ...usageDisclosure,
          choices: [{ index: 0, message: result.message, finish_reason: result.finish_reason, logprobs: null }],
          usage: result.usage,
        });
      }
    };

    const task = route().catch(error => {
      if (error instanceof ApiError && error.status === 400) {
        validationErrors.push({ time: new Date().toISOString(), code: error.code, param: error.param || null, message: error.message });
        if (validationErrors.length > 10) validationErrors.shift();
      }
      if (res.destroyed) return;
      if (!res.headersSent && error.status === 429) res.setHeader('Retry-After', '1');
      if (res.headersSent && req.url.split('?')[0] === '/v1/responses') {
        const { message, code, param } = errorPayload(error).error;
        res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', sequence_number: 0, message, code, param })}\n\n`);
      } else if (res.headersSent) {
        res.end(`data: ${JSON.stringify(errorPayload(error))}\n\ndata: [DONE]\n\n`);
      } else {
        send(res, error.status || 502, errorPayload(error));
      }
    }).finally(() => {
      clearInterval(heartbeat);
      releaseAgent?.();
      controllers.delete(controller);
      tasks.delete(task);
    });
    tasks.add(task);
  });

  server.shutdown = ({ timeoutMs = 12000 } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    const reason = new ApiError('Server is shutting down.', 503, 'server_shutdown');
    admission.close(reason);
    const closed = new Promise(resolve => server.close(resolve));
    for (const controller of controllers) controller.abort(reason);
    server.closeIdleConnections();
    shutdownPromise = (async () => {
      let timer;
      const complete = await Promise.race([
        Promise.all([closed, Promise.allSettled([...tasks])]).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (!complete) {
        server.closeAllConnections();
        warn('Shutdown deadline exceeded. Temporary Grok Bot agents may require manual cleanup.');
      }
      return complete;
    })();
    return shutdownPromise;
  };
  server.requestTimeout = 30000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateEnv();
  const host = process.env.GROKBOT_HOST || '127.0.0.1';
  const port = Number(process.env.GROKBOT_PORT || 8788);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !process.env.GROKBOT_TOKEN) {
    throw new Error('GROKBOT_TOKEN is required for a non-loopback listener.');
  }
  const mode = process.env.GROKBOT_MODE || 'agent';
  if (!['agent', 'native'].includes(mode)) throw new Error('GROKBOT_MODE must be agent or native.');
  const server = createServer({ nativeProvider: mode === 'native' ? createInference() : undefined });
  let exiting = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, async () => {
      if (exiting) return;
      exiting = true;
      console.log('Stopping Grok Bot server; waiting for temporary-agent cleanup.');
      const clean = await server.shutdown();
      process.exit(clean ? 0 : 1);
    });
  }
  server.listen(port, host, () => console.log(`grokbot http://${host}:${port} backend=grok-bot mode=${mode}`));
}

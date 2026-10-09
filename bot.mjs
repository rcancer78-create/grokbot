import { randomUUID } from 'node:crypto';
import { createTransport, ApiError } from './transport.mjs';
export { loadSession } from './session.mjs';

export async function usage({ signal } = {}) {
  const data = await createTransport().rpc('GetSandUsageStatus', {}, { signal, service: 'DashboardService' });
  return { source: 'grok-bot', host: 'api2.cursor.sh', plan: data.grokPlanLabel || 'Grok Bot',
    usagePercent: data.usagePercent ?? null, hasAvailableUsage: data.hasAvailableUsage ?? null,
    resetAt: data.nextResetTimestampUtc || null };
}

// Only an echo of OUR nonce can establish the server's requestId. Timestamps are not identifiers.
export function replyRows(entries, messageId) {
  const rows = [...entries.values()].sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
  const echo = rows.find(e => e.body.kind === 'message' && e.body.role === 'user' && e.body.clientNonce === messageId);
  if (!echo?.body.requestId) return null;
  const replies = rows.filter(e => e.body.kind === 'send-message' && e.body.author == null && e.body.requestId === echo.body.requestId);
  if (replies.some(e => e.body.message?.type !== 'text')) throw new ApiError('Grok Bot requires interaction or returned non-text content.', 409, 'interaction_required');
  if (replies.some(e => typeof e.body.message?.content !== 'string')) throw new ApiError('Unsupported Grok Bot text schema.');
  return {
    messages: replies.map(e => ({ seq: String(e.seq), content: e.body.message.content, streaming: !!(e.body.streaming || e.body.isStreaming) })),
    timestamp: replies.length ? Math.max(...replies.map(e => Number(e.body.timestampMs) || 0)) : 0,
    requestId: echo.body.requestId,
  };
}
export function correlatedReply(entries, messageId) {
  const parsed = replyRows(entries, messageId);
  if (!parsed?.messages.length || parsed.messages.some(m => m.streaming)) return null;
  return { text: parsed.messages.map(m => m.content).join('\n\n'), timestamp: parsed.timestamp, requestId: parsed.requestId };
}
// A transcript row may replace earlier streaming text. Emit a prefix only after a later
// snapshot repeats that prefix unchanged, and only through the first still-unstable row.
export function confirmedDelta(previous, current, committed) {
  const prior = new Map((previous || []).map(m => [m.seq, m]));
  let stable = '';
  for (const msg of current) {
    const old = prior.get(msg.seq);
    if (!old || old.streaming || old.content !== msg.content || msg.streaming) break;
    stable += (stable ? '\n\n' : '') + msg.content;
  }
  if (committed && !stable.startsWith(committed)) return { replaced: true, previous: current, committed, delta: '' };
  return { replaced: false, previous: current, committed: stable, delta: stable.slice(committed.length) };
}

export async function waitForReply(transport, agentId, sessionId, messageId, signal, { onText } = {}) {
  const entries = new Map();
  let serverTime = 0, idleAt = -1, idle = false, snapshot = null, committed = '';
  const note = messages => {
    if (!onText) return;
    const step = confirmedDelta(snapshot, messages, committed);
    snapshot = step.previous;
    if (step.replaced) throw new ApiError('Grok Bot replaced transcript text after a confirmed delta was delivered.', 502, 'transcript_replaced');
    if (!step.delta) return;
    committed = step.committed;
    onText(step.delta);
  };
  for await (const event of transport.watch(agentId, sessionId, signal)) {
    if (event.connected) serverTime = Number(event.connected.serverTimeMs);
    const matches = value => value?.agentId === agentId && (value.sessionId || '') === sessionId;
    if (matches(event.turnFailed)) {
      const code = event.turnFailed.code || 'turn_failed';
      throw new ApiError(event.turnFailed.summary || 'Grok Bot generation failed.', /USAGE_LIMIT|RATE_LIMIT/.test(code) ? 429 : 502, code);
    }
      if (matches(event.cleared)) throw new ApiError('Grok Bot transcript changed.', 502, 'transcript_changed');
      if (matches(event.cursorTooOld)) throw new ApiError('Grok Bot lost its transcript cursor.', 502, 'cursor_lost');
      if (event.agentState) {
        const state = (event.agentState.live || []).find(matches);
        if (state) {
          if (state.awaiting) throw new ApiError('Grok Bot is waiting for user interaction.', 409, 'interaction_required');
          idle = !state.isRunning && !state.isComposingMessage && !state.isRetrying && !state.hasRunningSubagents;
          idleAt = Number(state.updatedAtMs) || 0;
        } else if (event.agentState.snapshot) { idle = true; idleAt = serverTime; }
      }
      if (matches(event.rows)) {
        for (const row of event.rows.entries || []) {
          if (row.bodyOmitted || !row.body) throw new ApiError('Grok Bot omitted a transcript body; refusing a partial answer.');
          let body;
          try { body = JSON.parse(Buffer.from(row.body, 'base64').toString('utf8')); }
          catch (err) { throw new ApiError('Invalid Grok Bot transcript body.', 502, 'upstream_error', null, { cause: err }); }
          const seq = BigInt(row.seq || '0');
          entries.set(String(seq), { seq, body });
        }
        for (const row of event.rows.deletes || []) entries.delete(String(row.seq));
      }
      const parsed = replyRows(entries, messageId);
      if (parsed) note(parsed.messages);
      const result = correlatedReply(entries, messageId);
      if (result && idle && idleAt >= result.timestamp) {
        if (onText) {
          if (!result.text.startsWith(committed)) throw new ApiError('Grok Bot replaced transcript text after a confirmed delta was delivered.', 502, 'transcript_replaced');
          const rest = result.text.slice(committed.length);
          if (rest) onText(rest);
        }
        return result;
      }
    }
    throw new ApiError('Grok Bot event stream ended before completion. No request was resent.');
  }

export function createBot({ transportFactory = createTransport, timeoutMs = 180000, maxConcurrent = 1, warn = console.warn } = {}) {
  let active = 0;
  return {
    async ask(text, { signal, requestId, onText } = {}) {
      if (active >= maxConcurrent) throw new ApiError('Grok Bot backend is busy. Retry after the current request finishes.', 429, 'backend_busy');
      active++;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new ApiError('Grok Bot request timed out.', 504, 'timeout')), timeoutMs);
        const cancel = () => controller.abort(new ApiError('Client disconnected.', 499, 'cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        let transport, agent, sent = false, complete = false;
        const messageId = randomUUID();
        try {
          controller.signal.throwIfAborted();
          transport = transportFactory();
          const agentId = randomUUID();
          const created = await transport.rpc('CreateGrokBotAgent', {
            agentId,
            name: 'grokbot API',
            title: `API ${messageId.slice(0, 8)}`,
            harness: 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL',
            introductionSuppressed: true,
            kickstartRequested: false,
            createIntent: 'GROK_BOT_AGENT_CREATE_INTENT_FRESH',
            createCaller: 'GROK_BOT_AGENT_CREATE_CALLER_PRODUCT_CREATE',
          }, { signal: controller.signal, requestId });
          agent = created.agent;
          if (agent?.agentId !== agentId || !agent.id || agent.harness !== 'temporal') {
            if (agent?.agentId !== agentId) agent = null;
            throw new ApiError('Grok Bot did not create the requested isolated Temporal agent.');
          }
          const sessionId = agent.viewerSessionId || '';
          sent = true; // A network failure can still mean the server accepted the message.
          const delivery = await transport.rpc('SendGrokBotUserMessage', {
            agentId,
            sessionId,
            messageId,
            text,
            sentAtMs: String(Date.now()),
          }, { signal: controller.signal, requestId });
          if (!['GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL', 'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE'].includes(delivery.delivery)) {
            throw new ApiError(delivery.refusal?.message || 'Grok Bot refused delivery.', 502, 'delivery_refused');
          }
          const result = await waitForReply(transport, agentId, sessionId, messageId, controller.signal, { onText });
          complete = true;
          return { ...result, agentId, messageId, delivery: delivery.delivery };
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error?.name === 'TimeoutError') throw new ApiError('Grok Bot RPC timed out; request was not resent.', 504, 'timeout');
          throw error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          if (!controller.signal.aborted) controller.abort();
          else if (!controller.signal.reason) controller.abort(new ApiError('Request ended.', 499, 'cancelled'));
          if (agent) {
            if (sent && !complete) {
              try {
                await transport.rpc('InterruptGrokBotAgentRun', {
                  agentId: agent.agentId,
                  sessionId: agent.viewerSessionId || '',
                  reason: 'api_request_finished',
                }, { signal: AbortSignal.timeout(5000), requestId });
              } catch {
                warn(`Could not interrupt temporary Grok Bot agent ${agent.agentId}.`);
              }
            }
            try {
              await transport.rpc('DeleteGrokBotAgent', { id: agent.id }, { signal: AbortSignal.timeout(5000), requestId });
            } catch {
              warn(`Could not delete temporary Grok Bot agent ${agent.agentId} (id ${agent.id}). Remove it in the app.`);
            }
          }
        }
      } finally {
        active--;
      }
    },
    };
  }
export const ask = createBot().ask;

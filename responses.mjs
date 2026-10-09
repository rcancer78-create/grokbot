import { randomUUID } from 'node:crypto';
import { invalid } from './compatibility.mjs';
import { ApiError } from './transport.mjs';

export function createResponseStore({ ttlMs = 3600000, maxBytes = 16_000_000, maxEntries = 100, now = Date.now } = {}) {
  const entries = new Map(); let bytes = 0;
  const remove = id => { const item = entries.get(id); if (!item) return false; bytes -= item.size; return entries.delete(id); };
  const prune = () => { for (const [id, v] of entries) if (v.expires <= now()) remove(id); };
  return {
    get(id) { prune(); const v = entries.get(id); if (!v) throw new ApiError('Response not found or expired. History is local to this server process.', 404, 'response_not_found'); return structuredClone(v.value); },
    set(id, value) {
      prune(); const size = Buffer.byteLength(JSON.stringify(value));
      if (size > maxBytes) throw new ApiError('Response history is too large to store.', 507, 'history_too_large');
      remove(id); while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value);
      entries.set(id, { value: structuredClone(value), size, expires: now() + ttlMs }); bytes += size;
    },
    delete(id) { prune(); return remove(id); },
  };
}
function textParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalid('Response input content must be text.', 'input');
  return content.map(p => {
    if (!p || !['input_text', 'output_text'].includes(p.type) || typeof p.text !== 'string' || Object.keys(p).some(k => !['type', 'text', 'annotations', 'logprobs'].includes(k))) throw invalid('Only text input parts are supported.', 'input');
    return p.text;
  }).join('\n');
}
export function responseRequest(body, store) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected JSON object.');
  const allowed = ['model', 'input', 'instructions', 'previous_response_id', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'store', 'metadata', 'text', 'temperature', 'top_p', 'max_output_tokens', 'user', 'service_tier', 'background', 'truncation', 'include', 'reasoning'];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid(`Unsupported Responses parameter: ${k}.`, k);
  // Accept explicit defaults without pretending to implement asynchronous jobs or truncation.
  if (body.background !== undefined && body.background !== false) throw invalid('Only background:false is supported.', 'background');
  if (body.truncation !== undefined && body.truncation !== 'disabled') throw invalid('Only truncation:disabled is supported.', 'truncation');
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.length)) throw invalid('Only an empty include array is supported.', 'include');
  if (body.store !== undefined && typeof body.store !== 'boolean') throw invalid('store must be boolean.', 'store');
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw invalid('instructions must be text.', 'instructions');
  if (body.previous_response_id !== undefined && typeof body.previous_response_id !== 'string') throw invalid('previous_response_id must be a string.', 'previous_response_id');
  if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata) || Object.entries(body.metadata).length > 16 || Object.entries(body.metadata).some(([k, v]) => k.length > 64 || typeof v !== 'string' || v.length > 512))) throw invalid('Invalid metadata.', 'metadata');
  const messages = body.previous_response_id ? store.get(body.previous_response_id).messages : [];
  if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input });
  else if (Array.isArray(body.input) && body.input.length) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') throw invalid('Invalid input item.', 'input');
      if (item.type === 'function_call') {
        if (Object.keys(item).some(k => !['type', 'id', 'call_id', 'name', 'arguments', 'status'].includes(k))) throw invalid('Unsupported function_call field.', 'input');
        const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
        const previous = messages.at(-1);
        if (previous?.role === 'assistant' && previous.tool_calls) previous.tool_calls.push(call);
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      } else if (item.type === 'function_call_output') {
        if (Object.keys(item).some(k => !['type', 'id', 'call_id', 'output', 'status'].includes(k))) throw invalid('Unsupported function_call_output field.', 'input');
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: textParts(item.output) });
      } else if (!item.type || item.type === 'message') {
        if (Object.keys(item).some(k => !['type', 'id', 'status', 'role', 'content'].includes(k))) throw invalid('Unsupported message field.', 'input');
        messages.push({ role: item.role, content: textParts(item.content) });
      } else throw invalid('Unsupported input item type.', 'input');
    }
  } else throw invalid('input must be text or a non-empty array.', 'input');
  const chat = { model: body.model, messages: [...(body.instructions ? [{ role: 'system', content: body.instructions }] : []), ...messages], stream: body.stream };
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw invalid('tools must be an array.', 'tools');
    chat.tools = body.tools.map(t => {
      if (!t || t.type !== 'function' || Object.keys(t).some(k => !['type', 'name', 'description', 'parameters', 'strict'].includes(k))) throw invalid('Only function tools are supported.', 'tools');
      const { type, ...fn } = t; return { type, function: fn };
    });
  }
  for (const k of ['parallel_tool_calls', 'temperature', 'top_p', 'user', 'service_tier']) if (body[k] !== undefined) chat[k] = body[k];
  if (body.reasoning !== undefined) {
    if (!body.reasoning || typeof body.reasoning !== 'object' || Array.isArray(body.reasoning) || Object.keys(body.reasoning).some(k => k !== 'effort')) throw invalid('Only reasoning.effort is supported, with disclosure that it cannot be enforced.', 'reasoning');
    if (body.reasoning.effort !== undefined) chat.reasoning_effort = body.reasoning.effort;
  }
  if (body.max_output_tokens !== undefined) chat.max_completion_tokens = body.max_output_tokens;
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'object') {
      if (!body.tool_choice || body.tool_choice.type !== 'function' || Object.keys(body.tool_choice).some(k => !['type', 'name'].includes(k))) throw invalid('Unsupported tool_choice.', 'tool_choice');
      chat.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    } else chat.tool_choice = body.tool_choice;
  }
  if (body.text !== undefined) {
    if (!body.text || typeof body.text !== 'object' || Array.isArray(body.text) || Object.keys(body.text).some(k => !['format', 'verbosity'].includes(k))) throw invalid('Only text.format and text.verbosity are supported.', 'text');
    if (body.text.verbosity !== undefined) chat.verbosity = body.text.verbosity;
    const f = body.text.format;
    if (f !== undefined) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) throw invalid('Invalid text.format.', 'text.format');
      if (f.type === 'json_schema') { const { type, ...schema } = f; chat.response_format = { type, json_schema: schema }; }
      else chat.response_format = f;
    }
  }
  return { chat, messages };
}
// Diagnostics must refer to the caller's Responses fields, not internal Chat names.
export function responseParameter(param) {
  return ({ max_completion_tokens: 'max_output_tokens', verbosity: 'text.verbosity', reasoning_effort: 'reasoning.effort' })[param]
    || param?.replace(/^tools\[(\d+)\]\.function\./, 'tools[$1].').replace(/^response_format\.json_schema\./, 'text.format.');
}
export function responseObject(body, result, id = `resp_${randomUUID().replaceAll('-', '')}`) {
  const output = [];
  if (result.message.content !== null) output.push({ id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: result.message.content, annotations: [], logprobs: [] }] });
  for (const call of result.message.tool_calls || []) output.push({ type: 'function_call', id: `fc_${randomUUID().replaceAll('-', '')}`, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' });
  const u = result.usage;
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', error: null, incomplete_details: null, model: body.model, output, parallel_tool_calls: body.parallel_tool_calls ?? true, previous_response_id: body.previous_response_id || null, instructions: body.instructions ?? null, tools: body.tools || [], tool_choice: body.tool_choice ?? 'auto', metadata: body.metadata || {}, store: body.store !== false,
    usage: u ? { input_tokens: u.prompt_tokens, ...(u.prompt_tokens_details ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } } : {}), output_tokens: u.completion_tokens, total_tokens: u.total_tokens } : null };
}
// Responses emits valid lifecycle events; this adapter buffers until output validation succeeds.
export function responseEvents(response) {
  const events = []; let sequence_number = 0;
  const emit = (type, data) => events.push({ type, sequence_number: sequence_number++, ...data });
  const initial = { ...response, status: 'in_progress', output: [], usage: null };
  emit('response.created', { response: initial }); emit('response.in_progress', { response: initial });
  response.output.forEach((item, output_index) => {
    emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } });
    if (item.type === 'message') {
      const part = item.content[0], common = { item_id: item.id, output_index, content_index: 0 };
      emit('response.content_part.added', { ...common, part: { ...part, text: '' } });
      emit('response.output_text.delta', { ...common, delta: part.text, logprobs: [] });
      emit('response.output_text.done', { ...common, text: part.text, logprobs: [] });
      emit('response.content_part.done', { ...common, part });
    } else {
      emit('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
      emit('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
    }
    emit('response.output_item.done', { output_index, item });
  });
  emit('response.completed', { response }); return events;
}

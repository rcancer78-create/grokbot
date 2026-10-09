import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from './server.mjs';
import { createInference } from './inference.mjs';

const skipped = new Set(['.git', '.svn', '.hg', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', 'vendor', 'research', '.grokbot-runs', '.aws', '.ssh', '.codex', '.agents']);
const privateName = name => /^\.env(?:\.|$)/i.test(name) || /(?:^|[._-])(?:secrets?|credentials?)(?:[._-]|$)/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
const MAX_FILE = 200000, MAX_TOTAL = 2_000_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };
const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
export const projectTools = [
  fn('list_files', 'List eligible project text/source file paths, including files staged in this run. No traversal or secret files.', {}, []),
  fn('read_file', 'Read a UTF-8 project file, including staged contents. Read before editing, deleting or renaming. Optional offset_line (1-indexed) and limit_lines for viewing parts of large files.', { path: { type: 'string' }, offset_line: { type: 'integer', minimum: 1 }, limit_lines: { type: 'integer', minimum: 1 } }, ['path']),
  fn('search_text', 'Find a literal case-sensitive string in project files. Returns at most 100 matching lines.', { query: { type: 'string', minLength: 1 } }, ['query']),
  fn('replace_text', 'Stage an exact unique text replacement. File must have been read. Original files remain unchanged until the run succeeds and --apply is enabled. Set all=true to replace all occurrences if not unique.', { path: { type: 'string' }, old_text: { type: 'string', minLength: 1 }, new_text: { type: 'string' }, all: { type: 'boolean' } }, ['path', 'old_text', 'new_text']),
  fn('write_file', 'Stage complete UTF-8 file contents. Read existing files first. New files are allowed in existing directories or directories staged with create_directory.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('delete_file', 'Stage deletion of a file that was read in this run. The file stays on disk until apply.', { path: { type: 'string' } }, ['path']),
  fn('rename_file', 'Stage a move within the project. Read the source first. The destination must not already exist unless it is staged for deletion.', { from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']),
  fn('create_directory', 'Stage a new directory. The parent must already exist or be staged. Does not create missing parents implicitly.', { path: { type: 'string' } }, ['path']),
];
const decode = (bytes, max = MAX_FILE) => {
  if (bytes.length > max || bytes.includes(0)) throw new Error('Binary or oversized file.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
};
export function unifiedDiff(file, before, after) {
  const lines = value => value == null ? [] : value.split('\n');
  const left = lines(before), right = lines(after);
  const header = `--- ${before == null ? '/dev/null' : file}\n+++ ${after == null ? '/dev/null' : file}\n`;
  if (left.length * right.length > 160000) return `${header}@@ ${left.length} lines → ${right.length} lines @@\n`;
  const next = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) next[i][j] = left[i] === right[j] ? next[i + 1][j + 1] + 1 : Math.max(next[i + 1][j], next[i][j + 1]);
  const body = [];
  for (let i = 0, j = 0; i < left.length || j < right.length;) {
    if (i < left.length && j < right.length && left[i] === right[j]) { body.push(' ' + left[i]); i++; j++; }
    else if (i < left.length && (j >= right.length || next[i + 1][j] >= next[i][j + 1])) body.push('-' + left[i++]);
    else body.push('+' + right[j++]);
  }
  return header + '@@\n' + body.join('\n') + '\n';
}

export async function createProject(root) {
  root = await fs.realpath(path.resolve(root));
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Project must be a directory.');
  const originals = new Map(), staged = new Map(), deleted = new Set(), directories = new Set();
  const rel = full => path.relative(root, full).replaceAll('\\', '/');
  function guard(file) {
    if (typeof file !== 'string' || !file || path.isAbsolute(file) || /[:\x00-\x1f]/.test(file)) throw new Error('Use a relative project path.');
    const segments = file.split(/[\\/]/).filter(s => s !== '.');
    if (!segments.length || segments.some(s => !s || s === '..' || skipped.has(s.toLowerCase()) || privateName(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw new Error('Excluded or invalid project path.');
    const full = path.resolve(root, segments.join(path.sep));
    if (!inside(root, full)) throw new Error('Path leaves project.');
    return full;
  }
  async function parentReady(full) {
    let dir = path.dirname(full);
    while (dir !== root) {
      if (!inside(root, dir)) throw new Error('Directory link leaves project.');
      let stat;
      try { stat = await fs.lstat(dir); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!directories.has(dir)) throw new Error('Parent directory does not exist.');
        dir = path.dirname(dir); continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Parent is not a real directory.');
      if (!inside(root, await fs.realpath(dir))) throw new Error('Directory link leaves project.');
      return;
    }
  }
  async function resolve(file, allowNew = false, allowOversized = false) {
    const full = guard(file);
    await parentReady(full);
    const maxAllowed = allowOversized ? MAX_TOTAL : MAX_FILE;
    try {
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || stat.size > maxAllowed) throw new Error(stat.size > maxAllowed ? 'Binary or oversized file.' : 'Only regular, small, non-linked files are allowed.');
      if (!inside(root, await fs.realpath(full))) throw new Error('File leaves project.');
    } catch (error) { if (!(allowNew && error.code === 'ENOENT')) throw error; }
    return full;
  }
  async function disk(full, maxAllowed = MAX_FILE) {
    try { return decode(await fs.readFile(full), maxAllowed); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function read(file, allowOversized = false) {
    const full = guard(file);
    if (deleted.has(full)) throw new Error('File is staged for deletion.');
    if (staged.has(full)) return staged.get(full);
    const located = await resolve(file, false, allowOversized);
    const content = await disk(located, allowOversized ? MAX_TOTAL : MAX_FILE);
    if (content === null) throw new Error('File does not exist.');
    if (!originals.has(located)) originals.set(located, content);
    return content;
  }
  async function list() {
    const result = [];
    async function walk(dir, depth = 0) {
      if (depth > 20 || result.length >= 5000) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (skipped.has(entry.name.toLowerCase()) || privateName(entry.name) || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile() && !deleted.has(path.resolve(full))) { result.push(rel(full)); if (result.length >= 5000) break; }
      }
    }
    await walk(root);
    for (const full of staged.keys()) if (!deleted.has(full) && result.length < 5000) result.push(rel(full));
    return [...new Set(result)].sort();
  }
  function remember(full, current) {
    if (current !== null && !originals.has(full)) throw new Error('Read the file before editing it.');
    if (!originals.has(full)) originals.set(full, current);
  }
  async function stage(file, content) {
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error('File is too large.');
    const full = await resolve(file, true);
    if (directories.has(full)) throw new Error('Path is a staged directory.');
    const current = await disk(full);
    remember(full, current);
    deleted.delete(full);
    const total = [...staged].reduce((n, [f, v]) => n + (f === full ? 0 : Buffer.byteLength(v)), Buffer.byteLength(content));
    if (total > MAX_TOTAL) throw new Error('Change set is too large.');
    staged.set(full, content); return { staged: file, bytes: Buffer.byteLength(content), applied: false };
  }
  function fileChange(full, after) {
    const before = originals.get(full) ?? null;
    if (before === after) return null;
    return { op: before === null ? 'create' : after === null ? 'delete' : 'edit', path: rel(full), before, after, before_sha256: before === null ? null : hash(before) };
  }
  async function writeContents(full, content, { create, expect }) {
    const handle = await fs.open(full, create ? 'wx' : 'r+');
    let closed = false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('File became linked.');
      if (!create && decode(await handle.readFile()) !== expect) throw new Error(`Concurrent change: ${rel(full)}.`);
      const buffer = Buffer.from(content); let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
        if (!bytesWritten) throw new Error('File write stopped before completion.');
        offset += bytesWritten;
      }
      await handle.truncate(buffer.length); await handle.sync();
    } catch (error) {
      try {
        if (create) { await handle.close(); closed = true; await fs.unlink(full); }
        else {
          const buffer = Buffer.from(expect ?? ''); let offset = 0;
          while (offset < buffer.length) {
            const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
            if (!bytesWritten) break;
            offset += bytesWritten;
          }
          await handle.truncate(buffer.length); await handle.sync();
        }
      } catch (restoreError) { error.message += ` Restore failed: ${restoreError.message}.`; }
      throw error;
    } finally { if (!closed) await handle.close(); }
  }
  return {
    root,
    async execute(name, args) {
      if (name === 'list_files') return { files: await list(), limit: 5000 };
      if (name === 'read_file') {
        const paged = args.offset_line !== undefined || args.limit_lines !== undefined;
        const fullContent = await read(args.path, paged);
        if (paged) {
          const lines = fullContent.split('\n');
          const start = Math.max(1, args.offset_line || 1) - 1;
          const count = args.limit_lines !== undefined ? Math.max(0, args.limit_lines) : (lines.length - start);
          const slice = lines.slice(start, start + count).join('\n');
          return { path: args.path, content: slice, total_lines: lines.length, offset_line: start + 1, limit_lines: count, has_more: start + count < lines.length };
        }
        return { path: args.path, content: fullContent };
      }
      if (name === 'search_text') {
        const matches = []; let scanned = 0;
        for (const file of await list()) {
          if (scanned++ >= 500) break;
          let content; try { content = await read(file); } catch { continue; }
          for (const [i, line] of content.split('\n').entries()) if (line.includes(args.query)) { matches.push({ path: file, line: i + 1, text: line.slice(0, 1000) }); if (matches.length >= 100) return { matches, truncated: true }; }
        }
        return { matches, scanned, limit: 500 };
      }
      if (name === 'write_file') return stage(args.path, args.content);
      if (name === 'replace_text') {
        const full = guard(args.path);
        if (!originals.has(full)) throw new Error('Read the file before editing it.');
        if (deleted.has(full)) throw new Error('File is staged for deletion.');
        const content = staged.get(full) ?? originals.get(full);
        if (!args.old_text) throw new Error('old_text must not be empty.');
        const at = content.indexOf(args.old_text);
        if (at < 0) throw new Error('old_text not found in file.');
        if (args.all) return stage(args.path, content.replaceAll(args.old_text, args.new_text));
        if (content.indexOf(args.old_text, at + 1) >= 0) throw new Error('old_text must match exactly once. Include more surrounding lines for context or set all=true.');
        return stage(args.path, content.slice(0, at) + args.new_text + content.slice(at + args.old_text.length));
      }
      if (name === 'delete_file') {
        const full = guard(args.path);
        if (originals.get(full) === null && staged.has(full)) { staged.delete(full); originals.delete(full); return { path: args.path, staged: 'discarded', applied: false }; }
        const located = await resolve(args.path);
        if (!originals.has(located)) throw new Error('Read the file before editing it.');
        staged.delete(located); deleted.add(located);
        return { path: args.path, staged: 'delete', applied: false };
      }
      if (name === 'rename_file') {
        const src = await resolve(args.from, originals.get(guard(args.from)) === null);
        if (!originals.has(src)) throw new Error('Read the file before editing it.');
        if (deleted.has(src)) throw new Error('File is staged for deletion.');
        const content = staged.get(src) ?? originals.get(src);
        const dest = await resolve(args.to, true);
        if (src === dest) throw new Error('Rename destination must differ.');
        if (directories.has(dest)) throw new Error('Destination is a staged directory.');
        const destDisk = await disk(dest);
        if (staged.has(dest) || destDisk !== null && !deleted.has(dest)) throw new Error('Destination already exists.');
        if (destDisk === null && deleted.has(dest)) throw new Error('Destination disappeared during the run.');
        const total = [...staged].reduce((n, [f, v]) => n + (f === src || f === dest ? 0 : Buffer.byteLength(v)), Buffer.byteLength(content));
        if (total > MAX_TOTAL) throw new Error('Change set is too large.');
        deleted.delete(dest);
        if (!originals.has(dest)) originals.set(dest, destDisk);
        if (originals.get(src) === null) { staged.delete(src); originals.delete(src); }
        else { staged.delete(src); deleted.add(src); }
        staged.set(dest, content);
        return { from: args.from, to: args.to, bytes: Buffer.byteLength(content), applied: false };
      }
      if (name === 'create_directory') {
        const full = guard(args.path);
        if (staged.has(full) || deleted.has(full)) throw new Error('Path is already a staged file.');
        await parentReady(full);
        let stat;
        try { stat = await fs.lstat(full); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat?.isSymbolicLink()) throw new Error('Directory link leaves project.');
        if (stat?.isDirectory()) return { path: args.path, staged: 'exists', applied: false };
        if (stat) throw new Error('Path is already a file.');
        directories.add(full);
        return { path: args.path, staged: 'directory', applied: false };
      }
      throw new Error('Unknown local tool.');
    },
    changes() {
      const dirs = [...directories].map(full => ({ op: 'mkdir', path: rel(full), before: null, after: null, before_sha256: null }))
        .sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1));
      const files = [...staged].map(([full, after]) => deleted.has(full) ? null : fileChange(full, after)).filter(Boolean);
      const removals = [...deleted].map(full => fileChange(full, null)).filter(Boolean);
      return [...dirs, ...files, ...removals];
    },
    async apply() {
      const planned = this.changes();
      for (const change of planned) {
        if (change.op === 'mkdir') {
          const full = guard(change.path);
          await parentReady(full);
          try {
            const stat = await fs.lstat(full);
            if (stat.isSymbolicLink() || !inside(root, await fs.realpath(full))) throw new Error('Directory link leaves project.');
            throw new Error(`Directory appeared during the run: ${change.path}. No changes applied.`);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          continue;
        }
        const full = await resolve(change.path, change.before === null);
        if (await disk(full) !== change.before) throw new Error(`File changed during the run: ${change.path}. No changes applied.`);
      }
      const applied = [];
      const revert = async change => {
        const full = guard(change.path);
        if (change.op === 'mkdir') { await fs.rmdir(full); return; }
        if (change.op === 'delete') { await writeContents(full, change.before, { create: true }); return; }
        if (change.op === 'create') {
          if (await disk(full) !== change.after) throw new Error(`Created file changed during rollback: ${change.path}.`);
          await fs.unlink(full); return;
        }
        await writeContents(full, change.before, { expect: change.after });
      };
      try {
        for (const change of planned) {
          const full = change.op === 'mkdir' ? guard(change.path) : await resolve(change.path, change.before === null);
          if (change.op === 'mkdir') { await parentReady(full); await fs.mkdir(full); }
          else if (change.op === 'delete') {
            if (await disk(full) !== change.before) throw new Error(`Concurrent change: ${change.path}.`);
            const stat = await fs.lstat(full);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('File became linked.');
            await fs.unlink(full);
          } else {
            if (await disk(full) !== change.before) throw new Error(`Concurrent change: ${change.path}.`);
            await writeContents(full, change.after, { create: change.before === null, expect: change.before });
          }
          applied.push(change);
        }
      } catch (error) {
        const rolled = [], failed = [];
        for (const change of applied.reverse()) { try { await revert(change); rolled.push(change.path); } catch { failed.push(change.path); } }
        throw new Error(`${error.message} Rolled back: ${rolled.join(', ') || 'none'}. Still changed: ${failed.join(', ') || 'none'}. Review the saved change report.`);
      }
      return applied.map(c => c.path);
    },
  };
}

export async function runProject({ root, prompt, baseUrl, token = '', apply = false, maxTurns = 12, signal, report = () => {} }) {
  const project = await createProject(root);
  const messages = [{ role: 'system', content: 'You are editing a local project through client functions. Use ONLY the declared API functions. Start with list_files. Read relevant source and project instructions before proposing edits. Do not use Grok Bot built-in tools. All paths are relative to the supplied root. Changes are staged; finish with a concise explanation of findings, proposed edits and limitations. Do not claim tests ran. Never seek secret files. Read before editing, deleting or renaming. create_directory before a new file in a new folder. The client will apply staged changes only if explicitly enabled.' }, { role: 'user', content: prompt }];
  for (let turn = 0; turn < maxTurns; turn++) {
    signal?.throwIfAborted();
    report(`Ход ${turn + 1}/${maxTurns}`);
    const response = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ model: 'grok-bot', messages, tools: projectTools, parallel_tool_calls: false }), signal });
    const data = await response.json();
    signal?.throwIfAborted();
    if (!response.ok || data.error) {
      const errMessage = data.error?.message || `HTTP ${response.status}`;
      if (turn < maxTurns - 1 && (response.status === 400 || response.status === 502) && data.error?.code !== 'backend_busy') {
        report(`  Ошибка ответа модели (${errMessage}). Повтор с запросом на исправление...`);
        messages.push({
          role: 'user',
          content: `Предыдущий шаг завершился ошибкой: ${errMessage}. Пожалуйста, исправь формат и вызови нужную функцию проекта.`,
        });
        continue;
      }
      throw new Error(errMessage);
    }
    const message = data.choices?.[0]?.message;
    if (!message || message.role !== 'assistant') throw new Error('Invalid assistant response.');
    messages.push(message);
    if (!message.tool_calls?.length) return { root: project.root, summary: message.content, changes: project.changes(), apply: () => project.apply(), requestedApply: apply };
    for (const call of message.tool_calls) {
      signal?.throwIfAborted();
      report(`  ${call.function.name}`);
      let result;
      try { result = await project.execute(call.function.name, JSON.parse(call.function.arguments)); }
      catch (error) { result = { error: error.message }; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error(`Достигнут лимит ${maxTurns} ходов. Файлы проекта не изменены.`);
}

export async function applyReport(file, root) {
  const stat = await fs.stat(file);
  if (stat.size > 5_000_000) throw new Error('Change report too large.');
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  const project = await createProject(root);
  if (typeof report.root !== 'string' || await fs.realpath(report.root) !== project.root || !Array.isArray(report.changes) || report.changes.length > 1000) throw new Error('Report does not match the selected project.');
  for (const c of report.changes) {
    const op = c?.op || (c?.before === null ? 'create' : 'edit');
    if (!c || typeof c.path !== 'string' || !['edit', 'create', 'delete', 'mkdir'].includes(op)) throw new Error('Invalid change report.');
    if (op === 'mkdir') {
      if (c.before !== null || c.after !== null || c.before_sha256 !== null) throw new Error('Invalid change report.');
      await project.execute('create_directory', { path: c.path });
      continue;
    }
    if (op === 'delete') {
      if (typeof c.before !== 'string' || c.after !== null || c.before_sha256 !== hash(c.before)) throw new Error('Invalid change report.');
      const current = (await project.execute('read_file', { path: c.path })).content;
      if (current !== c.before) throw new Error(`File changed since the report: ${c.path}. No changes applied.`);
      await project.execute('delete_file', { path: c.path });
      continue;
    }
    if (typeof c.after !== 'string' || !(c.before === null || typeof c.before === 'string') || c.before_sha256 !== (c.before === null ? null : hash(c.before))) throw new Error('Invalid change report.');
    let current;
    try { current = (await project.execute('read_file', { path: c.path })).content; }
    catch (e) { if (c.before === null && e.code === 'ENOENT') current = null; else throw e; }
    if (current !== c.before) throw new Error(`File changed since the report: ${c.path}. No changes applied.`);
    await project.execute('write_file', { path: c.path, content: c.after });
  }
  return project.apply();
}

async function main() {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--apply') opts.apply = true;
    else if (key === '--yes') opts.yes = true;
    else if (['--root', '--prompt', '--base-url', '--max-turns', '--test', '--test-timeout', '--apply-report'].includes(key) && args[i + 1]) opts[key.slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${key}`);
  }
  if (opts['apply-report']) {
    if (!opts.root || Object.keys(opts).some(k => !['root', 'apply-report'].includes(k))) throw new Error('--apply-report requires --root and cannot be combined with other options.');
    console.log(`Записано файлов: ${(await applyReport(opts['apply-report'], opts.root)).length}`); return;
  }
  if (!opts.root || !opts.prompt) throw new Error('Usage: node project.mjs --root D:\\project --prompt "task" [--apply] [--max-turns 12] [--test "npm test"]');
  const maxTurns = Number(opts['max-turns'] || 12);
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) throw new Error('--max-turns must be 1..50.');
  if (opts.test && !opts.apply) throw new Error('--test requires --apply: tests run against saved files.');
  let server; const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Project run cancelled.'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const token = opts['base-url'] ? process.env.GROKBOT_TOKEN || '' : randomUUID();
  try {
    if (!opts['base-url']) {
      server = createServer({ token, nativeProvider: process.env.GROKBOT_MODE === 'native' ? createInference() : undefined });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    }
    const result = await runProject({ root: opts.root, prompt: opts.prompt, apply: !!opts.apply, maxTurns, baseUrl: opts['base-url'] || `http://127.0.0.1:${server.address().port}/v1`, token, signal: controller.signal, report: console.log });
    controller.signal.throwIfAborted();
    const reports = path.join(path.dirname(fileURLToPath(import.meta.url)), '.grokbot-runs');
    await fs.mkdir(reports, { recursive: true });
    const file = path.join(reports, `${Date.now()}-${randomUUID().slice(0, 8)}.json`);
    await fs.writeFile(file, JSON.stringify({ ...result, applied: false }, null, 2), { flag: 'wx' });
    console.log(result.summary); console.log(`Отчёт с исходным и новым содержимым: ${file}`);
    console.log(`Подготовлены изменения: ${result.changes.map(c => c.op === 'mkdir' ? `${c.path}/` : c.path).join(', ') || 'нет'}`);
    for (const change of result.changes) {
      const diff = change.op === 'mkdir' ? `каталог ${change.path}/\n` : unifiedDiff(change.path, change.before, change.after);
      console.log(diff.length > 8000 ? diff.slice(0, 8000) + '\n… diff сокращён\n' : diff);
    }
    if (opts.apply) {
      // Confirm before writing files unless stdin is not a TTY or --yes is set.
      if (process.stdout.isTTY && !process.env.GROKBOT_ASSUME_YES && !opts.yes) {
        const rl = await import('node:readline/promises').then(m => m.createInterface({ input: process.stdin, output: process.stdout }));
        try { const answer = (await rl.question('Apply ' + (result.changes.length) + ' changes to disk? [y/N] ')).trim().toLowerCase(); if (answer !== 'y' && answer !== 'yes') { console.log('Cancelled. Report saved, no files written.'); return; } }
        finally { rl.close(); }
      }
      controller.signal.throwIfAborted(); const applied = await result.apply(); await fs.writeFile(file, JSON.stringify({ ...result, applied }, null, 2)); console.log(`Записано файлов: ${applied.length}`); }
    else console.log(`Режим просмотра: файлы проекта не изменены. Применить отчёт без повторного запроса: node project.mjs --root "${result.root}" --apply-report "${file}"`);
    if (opts.test) {
      const testTimeoutMs = Number(opts['test-timeout'] || process.env.GROKBOT_TEST_TIMEOUT || 120) * 1000;
      const testSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(testTimeoutMs)]);
      await new Promise((resolve, reject) => {
        const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', opts.test], { cwd: result.root, stdio: 'inherit', windowsHide: true, signal: testSignal });
        child.on('error', err => {
          if (testSignal.aborted && !controller.signal.aborted) reject(new Error(`Test command timed out after ${testTimeoutMs / 1000}s. Changes remain saved.`));
          else reject(err);
        });
        child.on('exit', (code, sig) => {
          if (testSignal.aborted && !controller.signal.aborted) reject(new Error(`Test command timed out after ${testTimeoutMs / 1000}s. Changes remain saved.`));
          else if (code === 0) resolve();
          else reject(new Error(`Test command exited ${code ?? sig}. Changes remain saved.`));
        });
      });
    }
  } finally {
    controller.abort();
    if (server && !await server.shutdown()) process.exitCode = 1;
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });

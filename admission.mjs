import { ApiError } from './transport.mjs';

const busy = () => new ApiError('Grok Bot backend is busy. Retry after the current request finishes.', 429, 'backend_busy');
const cancelled = signal => signal?.reason || new ApiError('Client disconnected.', 499, 'cancelled');

// One agent turn owns the slot through output repair and backend cleanup.
// Waiting requests have not contacted Grok Bot and consume no allowance.
export function createAdmission({ maxPending = 4, waitMs = 30000 } = {}) {
  if (!Number.isInteger(maxPending) || maxPending < 0 || maxPending > 32) throw new Error('GROKBOT_QUEUE_LIMIT must be 0..32.');
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 120000) throw new Error('GROKBOT_QUEUE_WAIT_MS must be 1..120000.');
  let active = false, closed;
  const pending = [];
  function releaseToken() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = pending.shift();
      if (next) { next.detach(); next.resolve(releaseToken()); }
      else active = false;
    };
  }
  return {
    acquire(signal) {
      if (closed) return Promise.reject(closed);
      if (signal?.aborted) return Promise.reject(cancelled(signal));
      if (!active) { active = true; return Promise.resolve(releaseToken()); }
      if (pending.length >= maxPending) return Promise.reject(busy());
      return new Promise((resolve, reject) => {
        const remove = error => {
          const index = pending.indexOf(entry);
          if (index < 0) return;
          pending.splice(index, 1); entry.detach(); reject(error);
        };
        const abort = () => remove(cancelled(signal));
        const timer = setTimeout(() => remove(busy()), waitMs);
        const entry = { resolve, reject, detach() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
        pending.push(entry);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
    close(error = new ApiError('Server is shutting down.', 503, 'server_shutdown')) {
      closed = error;
      for (const entry of pending.splice(0)) { entry.detach(); entry.reject(error); }
    },
    status: () => ({ active: Number(active), pending: pending.length, max_pending: maxPending, wait_ms: waitMs }),
  };
}

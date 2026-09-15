// Periodic in-memory state sweeper.
//
// The freebuff executor keeps per-process state that outlives its useful life:
// cached session rows and per-token/model + per-egress cooldowns. Left alone
// that grows without bound on a long-running server, so a cron-like tick drops
// the expired entries. Fail-open everywhere — a failed sweep retries on the
// next tick and never blocks startup or requests.
//
// This is the natural home for other engine-layer sweeps (pool fitness, egress
// geo cache) if those subsystems are ever added.

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let started = false;
let handle = null;

async function sweep() {
  try {
    const { pruneSessionState } = await import("open-sse/executors/freebuff.js");
    const removed = pruneSessionState();
    if (removed) {
      console.log(`[StateSweeper] pruned ${removed} freebuff session/cooldown entries`);
    }
    return removed;
  } catch {
    return 0; // fail-open: next tick retries
  }
}

export function startStateSweeper({ intervalMs } = {}) {
  if (started) return false;
  if (typeof window !== "undefined") return false;
  started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : SWEEP_INTERVAL_MS;
  handle = setInterval(() => { sweep().catch(() => {}); }, period);
  if (handle.unref) handle.unref();
  return true;
}

export function stopStateSweeper() {
  if (handle) clearInterval(handle);
  handle = null;
  started = false;
}

export const __test__ = { sweep };

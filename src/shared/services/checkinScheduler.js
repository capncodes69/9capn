/**
 * Daily automatic check-in scheduler.
 *
 * ## Why a new file instead of modifying an existing module
 *
 * The upstream 9router v0.5.99 repository has **no check-in implementation at all**
 * (no route, no service, zero mentions in the CHANGELOG; the only occurrence of the
 * word `check-in` is an upstream error string in a test fixture). So this feature is
 * purely additive, and its integration deliberately mirrors the existing
 * `quotaAutoPing.js` (the same "opt-in background scheduler" pattern) rather than
 * inventing a new paradigm — that way its footprint on upstream is just a small
 * change to 3 files.
 *
 * ## Design trade-offs (each one maps to a pitfall hit in real testing)
 *
 * 1. **Default off.** Check-in is a **write operation against upstream performed on the
 *    user's behalf**. [It could be] default on (by explicit user request), but 9router is
 *    a multi-user gateway, and enabling it by default would consume upstream quota and
 *    trigger risk controls without the user's consent. Hence the default `enabled: false`,
 *    to be explicitly turned on by the user in the panel/API.
 *
 * 2. **Run only once per day, and the criterion is "has today been handled", not
 *    "did it succeed".** The rule: the date is only recorded when at least one result
 *    **proves today was handled** (`claimed` or `already-claimed`). A round where
 *    everything fails ⇒ **not recorded**, retried on the next start. Otherwise a single
 *    upstream hiccup would make the user miss the check-in for the whole day.
 *
 * 3. **Serial per provider and per account, never concurrent.** One check-in round is
 *    "number of providers × number of accounts" serial upstream requests (the
 *    anti-risk-control rule). This discipline is stressed repeatedly in the implementation.
 *
 * 4. **Don't maintain a second capability list.** The authority on "who can check in" is
 *    the implementation table in `checkinProviders.js`. This module only asks "is it
 *    implemented", and never copies the provider list — two lists are bound to drift apart.
 *
 * 5. **Run after a delay following startup, so as not to compete with startup for
 *    resources**, and **let credential renewal run a round first** (expired credentials
 *    would turn the whole round into failures). The delay can be overridden with
 *    `NINEROUTER_CHECKIN_DELAY_MS`; `0` is valid.
 *
 * 6. **Only handle enabled connections**: skip `isActive: false`.
 *    (Deactivation is treated here as a deliberate user exclusion, so it doesn't take
 *    part in check-in.)
 *
 * 7. **A single account's failure doesn't abort the whole round** — each account is
 *    wrapped in its own try, and exceptions are turned into failed.
 *
 * ## How the scheduler gets started (**a real pitfall hit**)
 *
 * The scheduler is started by `register()` in `src/instrumentation.js` — **not** only by
 * `initializeApp.js`.
 *
 * ⚠️ Why: the reachable path to `initializeApp.js` is
 * `src/app/layout.js → bootstrap.js → initializeApp()`, and `layout.js` only runs when
 * **rendering a page**. Measured: when only hitting API requests like `/api/health` or
 * `/api/version`, `[Checkin] scheduler started` **never appears** — in other words, a
 * gateway that "only serves API traffic and never has anyone open the panel" would
 * **silently never check in**.
 *
 * `register()` is Next's Node-runtime server hook, **executed once at startup**,
 * regardless of whether there's traffic — that's the guarantee a "daily scheduler"
 * needs. Hence `instrumentation.js` is the primary path, and the call in
 * `initializeApp.js` is kept as a **redundant safety net** (idempotent, harmless if
 * called repeatedly).
 *
 * ## Addendum: how to ensure it runs only once a day once the scheduler is up
 *
 * Run a round after a delay following startup, then tick every 30 minutes (to catch up
 * across day boundaries, so a long-running container doesn't have to wait for a restart
 * to check in for the next day). A tick re-reads settings and the state file:
 * - already successfully recorded for today ⇒ return immediately;
 * - the switch has been turned off ⇒ stop the scheduler.
 *
 * ## State file
 *
 * `DATA_DIR/checkin-state.json`, written atomically (tmp + rename). A separate file
 * rather than being stuffed into settings: it's **runtime state**, not user
 * configuration, and mixing it into settings would let "export/import config" carry away
 * or overwrite check-in progress as a side effect.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { getSettings, getProviderConnections } from "@/lib/localDb";
import {
  claimCheckin,
  checkinLabel,
  describeOutcome,
  resolveIanaTimezone,
  utc8DateString,
} from "./checkinProviders.js";

/** State file name (placed in the DATA_DIR root, alongside jwt-secret / machine-id). */
export const CHECKIN_STATE_FILE = "checkin-state.json";

/** Env var: how long after startup to wait before running the automatic check-in (ms). */
export const CHECKIN_DELAY_ENV = "NINEROUTER_CHECKIN_DELAY_MS";
/** Default delay of 30 seconds (see reason #5 in the module header). */
export const DEFAULT_CHECKIN_DELAY_MS = 30_000;

const DEFAULT_STATE = {
  /** UTC+8 date (`YYYY-MM-DD`) of the last **completed** automatic check-in; empty = never run. */
  lastDate: "",
  /** Timestamp (ms) when it last finished; 0 = never run. */
  lastAt: 0,
  /** Whether the last round was recorded for the day (false ⇒ it will retry on the next start). */
  lastMarked: false,
  /** Summary of the last result (a short human-readable sentence). */
  lastSummary: "",
  /** Per-provider results (in traversal order). */
  channels: [],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Cap on per-provider entries (the number of providers is finite; dirty data shouldn't bloat the file). */
const MAX_CHANNEL_ENTRIES = 64;

function statePath() {
  return join(DATA_DIR, CHECKIN_STATE_FILE);
}

/**
 * Log output: **must go through process.stdout, not console.log**.
 *
 * ⚠️ `initConsoleLogCapture()` in `src/lib/consoleLogBuffer.js` replaces all of
 * `console.log/info/warn/error/debug` with implementations that write into an
 * **in-memory ring buffer** (read by the panel's log view), so console-family output is
 * **invisible** in `docker logs`. When debugging scheduler problems this makes people
 * think "the scheduler didn't run" — a pitfall hit in real testing.
 */
function logLine(message) {
  try {
    process.stdout.write(`[Checkin] ${message}\n`);
  } catch {
    /* ignore when stdout is closed */
  }
}

/** Normalize the state document: illegal values all fall back to defaults (**never throws**). */
export function sanitizeState(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_STATE };
  const ms = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const channels = Array.isArray(raw.channels)
    ? raw.channels
        .filter((c) => typeof c === "object" && c !== null && typeof c.provider === "string")
        .slice(0, MAX_CHANNEL_ENTRIES)
        .map((c) => ({
          provider: String(c.provider),
          label: typeof c.label === "string" ? c.label : String(c.provider),
          accounts: typeof c.accounts === "number" ? c.accounts : 0,
          claimed: typeof c.claimed === "number" ? c.claimed : 0,
          alreadyClaimed: typeof c.alreadyClaimed === "number" ? c.alreadyClaimed : 0,
          failed: typeof c.failed === "number" ? c.failed : 0,
          credit: typeof c.credit === "number" ? c.credit : 0,
          text: typeof c.text === "string" ? c.text.slice(0, 160) : "",
        }))
    : [];
  return {
    lastDate: typeof raw.lastDate === "string" && DATE_RE.test(raw.lastDate) ? raw.lastDate : "",
    lastAt: ms(raw.lastAt),
    lastMarked: raw.lastMarked === true,
    lastSummary: typeof raw.lastSummary === "string" ? raw.lastSummary.slice(0, 240) : "",
    channels,
  };
}

export function readState() {
  try {
    if (!existsSync(statePath())) return { ...DEFAULT_STATE };
    return sanitizeState(JSON.parse(readFileSync(statePath(), "utf8")));
  } catch {
    // Dirty data is treated as defaults: a failed state read must not stop the gateway from starting.
    return { ...DEFAULT_STATE };
  }
}

function writeState(state) {
  const file = statePath();
  mkdirSync(dirname(file), { recursive: true });
  // Atomic write: write tmp first, then rename, so a process killed mid-write doesn't leave half a JSON file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, file);
}

/** Read the delay config. ⚠️ Don't write `Number(env.X) || default` — `0` is a valid value and is falsy. */
export function checkinDelayMs(env = process.env) {
  const raw = env[CHECKIN_DELAY_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_CHECKIN_DELAY_MS;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CHECKIN_DELAY_MS;
}

/** Whether this run is recorded for the day (i.e. "today has been handled"). */
export function shouldMarkToday(totals) {
  return totals.claimed + totals.alreadyClaimed > 0;
}

/**
 * Run one check-in round.
 *
 * @param {{ force?: boolean, only?: string[], now?: number, listConnections?: Function }} [options]
 *   `force` skips the "already ran today" check (for manual triggers).
 * @returns Per-provider results + summary.
 */
export async function runCheckin({ force = false, only = null, now = Date.now(), listConnections } = {}) {
  const settings = await getSettings();
  const config = settings.autoCheckin || {};

  // Providers explicitly chosen by the user (empty/absent = all implemented providers).
  const configured = config.providers && typeof config.providers === "object" ? config.providers : {};
  const optedIn = Object.entries(configured).filter(([, on]) => on === true).map(([p]) => p);

  // Fetch the account pool: on failure, report the round honestly as an error (rather than silently treating it as "no accounts").
  let connections;
  try {
    connections = listConnections ? await listConnections() : await getProviderConnections({ isActive: true });
  } catch (error) {
    return {
      ok: false,
      // English: this message goes into the UI verbatim via the API (i18n only translates English source text).
      message: `Failed to read the account pool: ${error instanceof Error ? error.message : String(error)}`,
      channels: [],
      totals: { accounts: 0, claimed: 0, alreadyClaimed: 0, failed: 0, inactive: 0, credit: 0 },
    };
  }

  // provider => that provider's enabled connections (order is the priority order, already sorted by the repo).
  const byProvider = new Map();
  for (const conn of connections) {
    if (conn.isActive === false || conn.isActive === 0) continue;
    if (only && !only.includes(conn.provider)) continue;
    if (!byProvider.has(conn.provider)) byProvider.set(conn.provider, []);
    byProvider.get(conn.provider).push(conn);
  }

  // Keep only providers that "have a check-in implementation" — the authority is checkinProviders, no separate copied list.
  const timezoneId = resolveIanaTimezone();
  const channels = [];
  const totals = { accounts: 0, claimed: 0, alreadyClaimed: 0, failed: 0, inactive: 0, credit: 0 };
  const today = utc8DateString(now);

  for (const [provider, pool] of byProvider) {
    // If the user explicitly configured a set of providers, only run the checked ones —
    // **but `only` is an exception**.
    //
    // ⚠️ `only` means the user **just clicked "check in now" for this provider in the
    // panel**, which is an explicit action and must be allowed through (same rule as
    // `force` allowing "already ran today"). Without this exception, "the config only
    // checks A, yet the user clicks B's button" would be silently filtered down to 0
    // accounts, and the UI would show "no accounts to check in" — it looks like there
    // are no accounts, when in fact the config blocked them.
    const explicitlyRequested = Array.isArray(only) && only.includes(provider);
    if (!explicitlyRequested && optedIn.length > 0 && !optedIn.includes(provider)) continue;

    const channel = {
      provider,
      label: checkinLabel(provider),
      accounts: pool.length,
      claimed: 0,
      alreadyClaimed: 0,
      failed: 0,
      inactive: 0,
      credit: 0,
      text: "",
    };
    const notes = [];

    for (const conn of pool) {
      totals.accounts += 1;
      try {
        const outcome = await claimCheckin(provider, conn, { timezoneId });
        switch (outcome.kind) {
          case "claimed":
            channel.claimed += 1;
            channel.credit += typeof outcome.credit === "number" ? outcome.credit : 0;
            totals.claimed += 1;
            totals.credit += typeof outcome.credit === "number" ? outcome.credit : 0;
            break;
          case "already-claimed":
            channel.alreadyClaimed += 1;
            totals.alreadyClaimed += 1;
            break;
          case "inactive":
            channel.inactive += 1;
            totals.inactive += 1;
            break;
          default:
            channel.failed += 1;
            totals.failed += 1;
            notes.push(`${conn.name || conn.id}: ${describeOutcome(outcome)}`);
        }
      } catch (error) {
        // A single account's exception must never abort the whole round.
        channel.failed += 1;
        totals.failed += 1;
        notes.push(`${conn.name || conn.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const parts = [];
    if (channel.claimed > 0) parts.push(`${channel.claimed} claimed`);
    if (channel.credit > 0) parts.push(`+${channel.credit}`);
    if (channel.alreadyClaimed > 0) parts.push(`${channel.alreadyClaimed} already done`);
    if (channel.inactive > 0) parts.push(`${channel.inactive} no activity`);
    if (channel.failed > 0) parts.push(`${channel.failed} failed`);
    channel.text = parts.join(", ") || "Nothing to do";
    if (notes.length > 0) channel.text += ` (${notes.slice(0, 3).join("; ")})`;

    channels.push(channel);
  }

  const marked = shouldMarkToday(totals);
  return {
    ok: true,
    date: today,
    marked,
    channels,
    totals,
    summary: buildSummary(totals, channels),
  };
}

/**
 * Whole-round summary.
 *
 * ⚠️ The output is **English**: this text goes directly into `docker logs`, API
 * responses and the state file, and the runtime i18n only translates "English source
 * text" (src/i18n/runtime.js); Chinese would never be translated. Maintainer-facing
 * explanations are still written as Chinese comments (they never get rendered).
 */
function buildSummary(totals, channels) {
  if (totals.accounts === 0) return "No accounts to check in";
  const parts = [`${channels.length} provider(s) / ${totals.accounts} account(s)`];
  if (totals.claimed > 0) parts.push(`${totals.claimed} claimed`);
  if (totals.credit > 0) parts.push(`+${totals.credit}`);
  if (totals.alreadyClaimed > 0) parts.push(`${totals.alreadyClaimed} already done`);
  if (totals.inactive > 0) parts.push(`${totals.inactive} no activity`);
  if (totals.failed > 0) parts.push(`${totals.failed} failed`);
  return parts.join(", ");
}

/** Current state for the UI to read (including "did it run today"). */
export async function getCheckinStatus(now = Date.now()) {
  const settings = await getSettings();
  const config = settings.autoCheckin || {};
  const state = readState();
  const today = utc8DateString(now);
  return {
    enabled: config.enabled === true,
    delayMs: typeof config.delayMs === "number" ? config.delayMs : checkinDelayMs(),
    providers: config.providers && typeof config.providers === "object" ? config.providers : {},
    ranToday: state.lastDate === today,
    state,
  };
}

/** Run a round manually (an explicit user action, always bypasses the "already ran today" check). */
export async function runCheckinNow(options = {}) {
  const result = await runCheckin({ ...options, force: true });
  if (result.ok) {
    const previous = readState();
    const next = {
      lastDate: result.marked ? result.date : previous.lastDate,
      lastAt: Date.now(),
      lastMarked: result.marked,
      // English: `lastSummary` is written to the state file and returned via the API (i18n only translates English source text).
      lastSummary: `${result.marked ? "" : "NOT RECORDED · "}${result.summary}`,
      channels: result.channels.map((c) => ({ ...c })),
    };
    try {
      writeState(next);
    } catch {
      // A failed state write must not lose the result: the caller still gets this round's result.
    }
    result.state = next;
  }
  return result;
}

// ── Scheduling (mirrors quotaAutoPing's shape: global singleton + reconfigurable) ─────────────────

/** Use global to withstand Next's module hot-reload, ensuring one scheduler per process. */
const g = (global.__checkinScheduler ??= {
  timer: null,
  interval: null,
  startedAt: 0,
  running: false,
  lastRunAt: 0,
});

/** Stop the scheduler. */
export function stopCheckinScheduler() {
  if (g.timer) {
    clearTimeout(g.timer);
    g.timer = null;
  }
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
  }
}

/**
 * Start/reconfigure the scheduler.
 *
 * On startup, run a round after a delay; after that, check every 30 minutes (catching
 * up across day boundaries, so a long-running container doesn't have to wait for a
 * restart to check in for the next day).
 *
 * Idempotent: if a timer already exists, return immediately (`instrumentation.js` and `initializeApp.js` each call this once).
 */
export function configureCheckinScheduler(settings) {
  const config = settings?.autoCheckin;
  if (config?.enabled !== true) {
    stopCheckinScheduler();
    logLine("switch not enabled, scheduler not started");
    return;
  }

  // If a timer already exists, don't start another (but each tick re-reads settings, so config changes take effect naturally).
  if (g.timer || g.interval) {
    logLine("scheduler already running, skipping duplicate start");
    return;
  }

  const delay = typeof config.delayMs === "number" && config.delayMs >= 0
    ? config.delayMs
    : checkinDelayMs();

  const tick = async () => {
    if (g.running) return;
    g.running = true;
    try {
      const now = Date.now();
      const state = readState();
      const today = utc8DateString(now);

      // Already successfully recorded for today ⇒ do nothing.
      if (state.lastDate === today && state.lastMarked) return;

      const current = await getSettings();
      if (current.autoCheckin?.enabled !== true) {
        stopCheckinScheduler();
        return;
      }

      const result = await runCheckin({ now });
      if (!result.ok) {
        logLine(`round not completed: ${result.message}`);
        return;
      }

      const next = {
        lastDate: result.marked ? result.date : state.lastDate,
        lastAt: now,
        lastMarked: result.marked,
        lastSummary: result.summary,
        channels: result.channels.map((c) => ({ ...c })),
      };
      writeState(next);
      g.lastRunAt = now;
      logLine(`${result.date} ${result.marked ? "" : "(not recorded for the day, will retry) "}${result.summary}`);
    } catch (error) {
      // fail-open: an error in one round must never kill the scheduling loop.
      logLine(`scheduler error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      g.running = false;
    }
  };

  g.startedAt = Date.now();
  g.timer = setTimeout(() => {
    g.timer = null;
    tick().catch(() => {});
    // Day-boundary catch-up: 30-minute granularity is enough to catch up shortly after the day rolls over.
    const EVERY_MS = 30 * 60 * 1000;
    g.interval = setInterval(() => { tick().catch(() => {}); }, EVERY_MS);
    if (g.interval.unref) g.interval.unref();
  }, delay);
  if (g.timer.unref) g.timer.unref();

  logLine(`scheduler started (delay ${delay}ms)`);
}

/** For tests only: clear the scheduler state. */
export function resetCheckinScheduler() {
  stopCheckinScheduler();
  g.running = false;
  g.lastRunAt = 0;
  g.startedAt = 0;
}

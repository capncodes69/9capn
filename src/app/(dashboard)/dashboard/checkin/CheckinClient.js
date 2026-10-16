"use client";

/**
 * Daily auto check-in panel.
 *
 * ## Interaction
 *
 * - Top master switch: when on, a background scheduler runs it automatically once a day (off by default, see checkinScheduler.js).
 * - One row per provider: the switch decides whether it is included in the **automatic** check-in;
 *   the "Check in now" button on the right runs only that one provider and is an **explicit action**,
 *   not constrained by the master switch or the per-provider selection.
 * - The "Check in now" button is disabled when `accounts === 0` — clicking a provider with no accounts
 *   would only show "No accounts to check in", which is a no-op.
 *
 * ## Why the disabled "Check in now" needs its reason spelled out
 *
 * A provider like `codebuddy-intl` may have no accounts at all. If the button stayed clickable, users
 * would think "I clicked and nothing happened"; disabling it + marking "no accounts connected" at the
 * end of the row is the honest presentation.
 *
 * ## Trade-off on status refresh
 *
 * One check-in round is "number of providers × number of accounts" serial upstream requests
 * (anti-rate-limit, cannot be concurrent), so it can take over ten seconds.
 * Therefore, after clicking, the button enters loading and is disabled (no chance of a second click);
 * when done, the result is rendered directly from **this round's return value**, rather than immediately
 * re-GETting — this saves an upstream probe and avoids the UI flashing back to the old state.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, Button, Toggle, Badge, Spinner } from "@/shared/components";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";

/** Timeout for a single request. A round may be 10+ serial upstream requests, so give plenty of margin. */
const RUN_TIMEOUT_MS = 180_000;

function outcomeVariant(claimed, alreadyClaimed, failed) {
  if (failed > 0) return "warning";
  if (claimed > 0) return "success";
  if (alreadyClaimed > 0) return "info";
  return "default";
}

/**
 * Render a provider's counts as an **English** sentence, instead of using the
 * server-generated Chinese `text` directly.
 *
 * ⚠️ Why it must be assembled on the frontend: runtime i18n is an "English source → translation"
 * lookup table (see src/i18n/runtime.js); Chinese returned by the server lands as-is in the English UI
 * and **will never be translated**. The first version did exactly this in practice:
 * the English UI mixed in "Last: 已签到 7" (i.e. "checked in 7", left untranslated) and Chinese notes.
 * Structured counts are language-neutral, so assembling them into English on the frontend is what
 * lets them go through the i18n lookup.
 */
function describeCounts(c) {
  const parts = [];
  if (c.claimed > 0) parts.push(`${c.claimed} claimed`);
  if (c.credit > 0) parts.push(`+${c.credit}`);
  if (c.alreadyClaimed > 0) parts.push(`${c.alreadyClaimed} already done`);
  if (c.inactive > 0) parts.push(`${c.inactive} no activity`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  return parts.join(", ") || "Nothing to do";
}

/** Whole-round summary (also assembled into English on the frontend; rationale see describeCounts). */
function summarize(channels) {
  const t = { accounts: 0, claimed: 0, alreadyClaimed: 0, inactive: 0, failed: 0, credit: 0 };
  for (const c of channels) {
    t.accounts += c.accounts || 0;
    t.claimed += c.claimed || 0;
    t.alreadyClaimed += c.alreadyClaimed || 0;
    t.inactive += c.inactive || 0;
    t.failed += c.failed || 0;
    t.credit += c.credit || 0;
  }
  if (t.accounts === 0) return "No accounts to check in";
  const parts = [`${channels.length} provider${channels.length === 1 ? "" : "s"}, ${t.accounts} account${t.accounts === 1 ? "" : "s"}`];
  if (t.claimed > 0) parts.push(`${t.claimed} claimed`);
  if (t.credit > 0) parts.push(`+${t.credit}`);
  if (t.alreadyClaimed > 0) parts.push(`${t.alreadyClaimed} already done`);
  if (t.inactive > 0) parts.push(`${t.inactive} no activity`);
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  return parts.join(" · ");
}

export default function CheckinClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [providers, setProviders] = useState({});
  const [supported, setSupported] = useState([]);
  const [totalAccounts, setTotalAccounts] = useState(0);
  const [ranToday, setRanToday] = useState(false);
  const [state, setState] = useState(null);
  const [running, setRunning] = useState(null); // null | "all" | provider id
  const [lastResult, setLastResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [locale, setLocale] = useState("en");

  // Runtime i18n looks up by English source, so register here to re-render after a language switch
  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const applyStatus = useCallback((data) => {
    setEnabled(data.enabled === true);
    setProviders(data.providers && typeof data.providers === "object" ? data.providers : {});
    setSupported(Array.isArray(data.supported) ? data.supported : []);
    setTotalAccounts(typeof data.totalAccounts === "number" ? data.totalAccounts : 0);
    setRanToday(data.ranToday === true);
    setState(data.state || null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/checkin", { headers: { "Cache-Control": "no-store" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyStatus(await res.json());
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Only change settings, do not trigger a check-in. */
  const patch = async (body) => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/checkin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      applyStatus(data);
      return true;
    } catch (e) {
      setError(String(e.message || e));
      await refresh(); // On failure, fall back to the server's real state, leaving no wrong optimistic frontend value
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Run one check-in round. An empty provider = all providers. */
  const run = async (provider) => {
    setRunning(provider || "all");
    setError("");
    setLastResult(null);
    try {
      const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(`/api/checkin${qs}`, { method: "POST", signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
      setLastResult(data);
      // This round has written the status file — refresh the status area (without re-probing upstream)
      await refresh();
    } catch (e) {
      setError(e.name === "AbortError" ? "Check-in timed out. Check the server logs for the result." : String(e.message || e));
    } finally {
      setRunning(null);
    }
  };

  const onToggleMaster = (value) => {
    setEnabled(value); // Optimistic: the switch is purely local state; on failure patch() pulls back the real value
    patch({ enabled: value });
  };

  /**
   * Whether a provider is included in automatic check-in.
   *
   * ⚠️ Key semantics: an **empty `providers` object = all providers included** (the scheduler uses
   * `optedIn.length > 0` to decide "whether it has ever been explicitly restricted"). So with an empty
   * object, each switch must not be drawn as "off" — that would show "check in nothing", while the actual
   * behavior is check in all, which would be a deceptive UI.
   * Once the user flips any one switch, the whole list is **made concrete** into an explicit mapping.
   */
  const explicitSelection = Object.keys(providers).length > 0;
  const isIncluded = (id) => (explicitSelection ? providers[id] === true : true);

  const onToggleProvider = (id, value) => {
    // Make concrete: change one entry based on "the full list currently in effect", to avoid accidentally excluding the rest.
    const next = {};
    for (const p of supported) next[p.id] = isIncluded(p.id);
    next[id] = value;
    setProviders(next);
    patch({ providers: next });
  };

  /** Last per-provider result (from the status file). */
  const lastChannels = state?.channels || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Error message ── */}
      {error && (
        <div className="p-3 rounded-[10px] bg-red-500/10 border border-red-500/30 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* ── Master switch ── */}
      <Card
        title="Daily Auto Check-in"
        subtitle="Automatically claim daily credits from providers that support check-in"
        icon="event_available"
        action={
          <Button onClick={() => run(null)} disabled={running !== null || saving} size="sm">
            {running === "all" ? "Running…" : "Check in all now"}
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <Toggle
              checked={enabled}
              onChange={onToggleMaster}
              disabled={saving}
              label="Enable automatic check-in"
              description={
                enabled
                  ? "Runs once per day shortly after startup, then re-checks every 30 minutes"
                  : "Off — nothing is claimed automatically (manual buttons below still work)"
              }
            />
            <div className="flex items-center gap-2 shrink-0">
              {enabled ? (
                <Badge variant="success" dot>
                  Enabled
                </Badge>
              ) : (
                <Badge variant="default" dot>
                  Disabled
                </Badge>
              )}
              {ranToday && (
                <Badge variant="info" icon="check_circle">
                  Ran today
                </Badge>
              )}
            </div>
          </div>

          <div className="text-xs text-text-muted">
            {totalAccounts > 0
              ? `${totalAccounts} account${totalAccounts === 1 ? "" : "s"} across ${supported.filter((p) => p.accounts > 0).length} provider(s) can check in.`
              : "No connected accounts for any check-in provider yet."}
          </div>

          {/* ── Last result summary ── */}
          {state?.channels?.length > 0 && (
            <div className="p-3 rounded-[10px] bg-bg border border-border-subtle">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-text-muted">Last run</span>
                <span className="text-xs text-text-muted">
                  {state.lastDate || "—"}
                  {state.lastMarked === false && " · not recorded, will retry"}
                </span>
              </div>
              {/* The summary is assembled into English on the **frontend** from structured counts — the server's
                  lastSummary is a Chinese string, and rendering it directly would never be translated by the i18n
                  lookup (see the comment on describeCounts). */}
              <div className="text-sm text-text-main mt-1">{summarize(state.channels)}</div>
              <div className="space-y-0.5 mt-2">
                {state.channels.map((c) => (
                  <div key={c.provider} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-text-muted">{c.label || c.provider}</span>
                    <span className="text-text-muted">{describeCounts(c)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* ── This round's result (right after the button is clicked) ── */}
      {lastResult && (
        <Card title="Latest result" icon="receipt_long">
          <div className="space-y-2">
            {/* Both the summary and the details are assembled into English on the frontend from structured counts —
                the server's summary/text is Chinese, and rendering it directly would never be translated by the
                i18n lookup (see the comment on describeCounts). */}
            <div className="text-sm text-text-main">{summarize(lastResult.channels || [])}</div>
            <div className="text-xs text-text-muted">
              {lastResult.date} · {lastResult.marked ? "recorded for today" : "not recorded (will retry next start)"}
              {lastResult.provider ? ` · only ${lastResult.provider}` : ""}
            </div>
            <div className="space-y-1 mt-2">
              {(lastResult.channels || []).map((c) => (
                <div key={c.provider} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-text-muted">{c.label}</span>
                  <Badge variant={outcomeVariant(c.claimed, c.alreadyClaimed, c.failed)} size="sm">
                    {describeCounts(c)}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* ── Per provider ── */}
      <Card
        title="Providers"
        subtitle="Toggle a provider to include it in the automatic run, or claim it right now"
        icon="dns"
      >
        <div className="space-y-1">
          {supported.map((p) => {
            const hasAccounts = p.accounts > 0;
            const included = isIncluded(p.id);
            const last = lastChannels.find((c) => c.provider === p.id);
            const busy = running === p.id;
            return (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 py-3 border-b border-border-subtle last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text-main">{p.label}</span>
                    {hasAccounts ? (
                      <Badge variant="default" size="sm">
                        {p.accounts} account{p.accounts === 1 ? "" : "s"}
                      </Badge>
                    ) : (
                      <Badge variant="warning" size="sm">
                        no accounts connected
                      </Badge>
                    )}
                    {/* Providers not verified against real accounts must be marked out; do not pretend they are verified */}
                    {p.verified === false && (
                      <Badge variant="info" size="sm">
                        not live-verified
                      </Badge>
                    )}
                  </div>
                  {last?.text && (
                    <div className="text-xs text-text-muted mt-1 truncate">
                      Last: {describeCounts(last)}
                    </div>
                  )}
                  {p.note && (
                    <div className="text-xs text-text-muted mt-1">{p.note}</div>
                  )}
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <Toggle
                    checked={included}
                    onChange={(v) => onToggleProvider(p.id, v)}
                    disabled={saving || !enabled}
                    size="sm"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!hasAccounts || running !== null || saving}
                    onClick={() => run(p.id)}
                  >
                    {busy ? "Running…" : "Check in now"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {!enabled && (
          <div className="text-xs text-text-muted mt-4">
            Per-provider toggles are disabled while automatic check-in is off. The
            &ldquo;Check in now&rdquo; buttons still work.
          </div>
        )}
        {enabled && !explicitSelection && (
          <div className="text-xs text-text-muted mt-4">
            No provider filter set — every provider with accounts is included. Toggling any
            switch above pins the list explicitly.
          </div>
        )}
      </Card>

      {/* ── Notes ── */}
      <Card title="How it works" icon="help">
        <ul className="text-xs text-text-muted space-y-1.5 list-disc pl-4">
          <li>
            Off by default: check-in spends upstream quota on your behalf, so you opt in here.
          </li>
          <li>
            Accounts are processed one at a time, never in parallel, to avoid tripping
            provider rate limits.
          </li>
          <li>
            A provider is recorded as done for the day only when at least one account reports
            success or &ldquo;already checked in&rdquo;. If every request fails, the day is not
            recorded and the next start retries.
          </li>
          <li>
            <code className="text-[11px]">codebuddy-cn</code> and <code className="text-[11px]">qoder</code> reset daily on
            UTC+8; <code className="text-[11px]">minimax</code> uses your local timezone.
          </li>
          <li>
            <code className="text-[11px]">cline</code>, <code className="text-[11px]">workbuddy</code> and{" "}
            <code className="text-[11px]">raccoon</code> have no check-in endpoint upstream.
          </li>
        </ul>
      </Card>
    </div>
  );
}

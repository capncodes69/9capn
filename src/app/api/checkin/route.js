/**
 * Daily check-in API.
 *
 * ## Authentication
 *
 * The route is mounted at `/api/checkin` (**not** `/api/v1/*`), so it goes through
 * `dashboardGuard.js`'s deny-by-default branch: it requires a dashboard session or a CLI token.
 * ⚠️ Deliberately NOT placed under `PUBLIC_PREFIXES` (`/api/v1`) —— check-in is a **write
 * operation** and must never become unauthenticated just because it falls within the LLM
 * public prefix.
 *
 * ## Endpoints
 *
 * - `GET   /api/checkin`                → current status (switch, whether it already ran today, last per-channel result + **available account count per channel**)
 * - `GET   /api/checkin?probe=1`        → read-only live query of upstream check-in status (one request per account, does not claim)
 * - `POST  /api/checkin`                → manually run one round (write operation; bypasses the "already ran today" check)
 * - `POST  /api/checkin?dryRun=1`       → read-only probe (same as `probe=1`)
 * - `POST  /api/checkin?provider=<id>`  → **run only the specified channel** (the per-channel button on the dashboard)
 * - `PATCH /api/checkin`                → change switch / delay / channel selection
 */

import { NextResponse } from "next/server";
import { getSettings, updateSettings, getProviderConnections } from "@/lib/localDb";
import {
  getCheckinStatus,
  runCheckin,
  runCheckinNow,
  readState,
} from "@/shared/services/checkinScheduler";
import {
  checkinStatus,
  listCheckinProviders,
  isCheckinSupported,
  checkinLabel,
  resolveIanaTimezone,
} from "@/shared/services/checkinProviders";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = { "Cache-Control": "no-store" };

/**
 * How many **enabled** accounts each check-in-capable channel has.
 *
 * The dashboard needs this number: clicking a channel that has an implementation but no
 * accounts would only show "no accounts available for check-in", an invalid operation.
 * The UI uses `accounts` to decide whether to disable that channel's button.
 */
async function accountCounts() {
  const connections = await getProviderConnections({ isActive: true });
  const counts = {};
  for (const p of listCheckinProviders()) counts[p.id] = 0;
  for (const c of connections) {
    if (c.isActive === false || c.isActive === 0) continue;
    if (Object.prototype.hasOwnProperty.call(counts, c.provider)) counts[c.provider] += 1;
  }
  return counts;
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    // ?probe=1 live-queries upstream check-in status (read-only, one request per account)
    if (url.searchParams.get("probe") === "1") {
      return NextResponse.json(await probeAll(), { headers: HEADERS });
    }
    const status = await getCheckinStatus();
    const counts = await accountCounts();
    return NextResponse.json(
      {
        ...status,
        supported: listCheckinProviders().map((p) => ({ ...p, accounts: counts[p.id] || 0 })),
        totalAccounts: Object.values(counts).reduce((a, b) => a + b, 0),
      },
      { headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: HEADERS });
  }
}

export async function POST(request) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dryRun") === "1";
    // Run only the specified channel (the per-channel button on the dashboard).
    const provider = url.searchParams.get("provider");

    // Read-only mode: query status, never claim.
    if (dryRun) return NextResponse.json(await probeAll(), { headers: HEADERS });

    // When a channel is specified, validate that it actually has an implementation ——
    // otherwise it would silently return "0 accounts", making it look like it ran.
    if (provider && !isCheckinSupported(provider)) {
      return NextResponse.json(
        { ok: false, error: `${provider} has no check-in implementation` },
        { status: 400, headers: HEADERS },
      );
    }

    const result = await runCheckinNow(provider ? { only: [provider] } : {});
    if (!result.ok) {
      return NextResponse.json(result, { status: 500, headers: HEADERS });
    }
    return NextResponse.json({ ...result, provider: provider || null }, { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: HEADERS });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Switch and channel selection: same atomic read-modify-write path as the rest of settings.
    const current = await getSettings();
    const prev = current.autoCheckin || {};
    const next = { ...prev };

    if (typeof body.enabled === "boolean") next.enabled = body.enabled;
    if (typeof body.delayMs === "number" && body.delayMs >= 0) next.delayMs = body.delayMs;
    if (body.providers && typeof body.providers === "object" && !Array.isArray(body.providers)) {
      // Accept only provider ids that have a check-in implementation —— silently drop
      // unknown entries to avoid accumulating dirty config.
      const clean = {};
      for (const [id, on] of Object.entries(body.providers)) {
        if (isCheckinSupported(id)) clean[id] = on === true;
      }
      next.providers = clean;
    }

    await updateSettings({ autoCheckin: next });

    // Immediately reconfigure the scheduler after the change (the timer starts as soon as
    // the switch is turned on, no restart needed).
    const { configureCheckinScheduler } = await import("@/shared/services/checkinScheduler");
    configureCheckinScheduler({ autoCheckin: next });

    const status = await getCheckinStatus();
    const counts = await accountCounts();
    return NextResponse.json(
      {
        ...status,
        supported: listCheckinProviders().map((p) => ({ ...p, accounts: counts[p.id] || 0 })),
        totalAccounts: Object.values(counts).reduce((a, b) => a + b, 0),
      },
      { headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: HEADERS });
  }
}

/** **Read-only** query of check-in status per channel and per account (does not claim). */
async function probeAll() {
  const connections = await getProviderConnections({ isActive: true });
  const timezoneId = resolveIanaTimezone();
  const byProvider = new Map();

  for (const c of connections) {
    if (c.isActive === false || c.isActive === 0) continue;
    if (!isCheckinSupported(c.provider)) continue;
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
    byProvider.get(c.provider).push(c);
  }

  const channels = [];
  for (const [provider, pool] of byProvider) {
    const accounts = [];
    for (const conn of pool) {
      try {
        const result = await checkinStatus(provider, conn, { timezoneId });
        accounts.push({
          id: conn.id,
          name: conn.name || conn.id,
          ok: result.ok === true,
          todayCheckedIn: result.todayCheckedIn === true,
          message: result.ok ? undefined : result.message,
        });
      } catch (error) {
        accounts.push({ id: conn.id, name: conn.name || conn.id, ok: false, message: error.message });
      }
    }
    channels.push({ provider, label: checkinLabel(provider), accounts });
  }

  return { ok: true, readOnly: true, timezoneId, channels, state: readState() };
}

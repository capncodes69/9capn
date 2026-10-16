/**
 * 9router daily check-in — the **pure protocol implementation layer** for each provider.
 *
 * ## What this module is
 *
 * "Automatic check-in" is a **new capability** on 9router (upstream v0.5.99 has no checkin
 * implementation anywhere in the repo; see the research conclusions in
 * `docs/checkin-feature.md`). This file does exactly one thing: given a provider name plus
 * one connection credential for that provider, it sends the upstream request and returns a
 * **normalized result**. It **does not touch the database, does not touch scheduling, and
 * does not emit any UI**, so it can be tested directly as a single file with `node` (which
 * is exactly why it can be verified provider by provider).
 *
 * ## ⚠️ Implementation criteria (getting them wrong costs you "silent missed check-ins")
 *
 * 1. **Idempotency criteria always live in the response body, never in the HTTP status code.**
 *    codebuddy returns **HTTP 400** + `{code:10001}` for a duplicate claim; looking only at
 *    the status code misreports "already checked in today" as a **failure** (which then gets
 *    retried, or even treated as a credential problem).
 *    Measured: all 7 real accounts hit this branch.
 *
 * 2. **Do not use `response.json()`.**
 *    When a credential expires the Tencent gateway returns an **HTML error page**, and
 *    `json()` throws `Unexpected token '<'` — the user cannot see that the real cause is
 *    "you need to log in again". So always `text()` + manual `JSON.parse`, and on failure
 *    include the HTTP status code and a snippet.
 *
 * 3. **"Nothing to claim" ≠ "already claimed".**
 *    Qoder's criterion must be "there exists an entry with `actionType==='CLAIM_BENEFIT'`
 *    and `claimStatus==='CLAIMED'`", and **must not** be written as "no claimable item means
 *    already claimed" — the latter misreports "already claimed" when "the activity has not
 *    refreshed yet" or "the server does not send it down because the request headers are
 *    incomplete", and an error in this direction is **irreversible** (the user genuinely
 *    misses the claim that day).
 *    Measured: `qoder-cn` shows the `CLAIM_BENEFIT/CLAIMED` shape, while `qoder` only ever
 *    has the `VIEW_DETAILS` shape; the criterion holds accordingly.
 *
 * 4. **`active` is always `true` (true as soon as we get a response).**
 *    When "already claimed today", Qoder clears `campaigns` and returns `showCampaign:false`.
 *    If active were judged by "the list is non-empty", the caller would first hit the
 *    "activity not open" branch and misreport "already claimed today" as "activity not open".
 *
 * 5. **Serial per account, never concurrent.** See `checkinScheduler.js`.
 *
 * ## Key behavioral differences (not typos)
 *
 * | provider | idempotency criterion | HTTP when idempotent |
 * |---|---|---|
 * | codebuddy-cn / intl | `code === 10001` / `1001` | **400** |
 * | qoder / qoder-cn | `replayed === true` | 200 |
 * | minimax | `claim_result === 2` | 200 |
 *
 * ## Timezone
 *
 * codebuddy / qoder settle their daily quota by **UTC+8** (the server's convention,
 * independent of the client timezone).
 * minimax is the **exception**: it settles by the **IANA timezone reported by the client**;
 * `timezone_id` is a required query parameter and **must not be assumed to be UTC+8**.
 */

/** Control-plane request timeout (check-in is a write operation: give it enough time, but don't wait forever). */
const REQUEST_TIMEOUT_MS = 30_000;

/** UTC+8 offset (milliseconds). Matches Qoder's billing convention. */
export const UTC8_OFFSET_MS = 8 * 3_600_000;

/**
 * Get "today's date in UTC+8" (`YYYY-MM-DD`).
 *
 * ⚠️ Must use **arithmetic shifting** rather than the runtime timezone: the day boundary
 * belongs to the server (each channel settles its daily quota by UTC+8). Using the runtime
 * timezone yields the wrong "today" when the container timezone differs — if it runs ahead
 * (east), the day gets recorded as already run prematurely (a genuine missed check-in);
 * if it runs behind (west), it runs twice in one day.
 */
export function utc8DateString(nowMs = Date.now()) {
  return new Date(nowMs + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}

/** Get the current IANA timezone name (used by MiniMax; this is how the client obtains it). */
export function resolveIanaTimezone(resolve) {
  try {
    const zone = (resolve || (() => Intl.DateTimeFormat().resolvedOptions().timeZone))();
    return typeof zone === "string" && zone.trim().length > 0 ? zone.trim() : "UTC";
  } catch {
    return "UTC";
  }
}

// ── Small utilities (tolerant of upstream shape changes) ────────────────────

function asRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
}

/** Read a number, tolerating the string form (upstream uses strings to dodge floating point). Invalid ⇒ undefined, **never fabricate 0**. */
function looseNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t === "") return undefined; // ⚠️ Number('') === 0, which would misread an empty string as 0
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function looseBool(v) {
  return v === true;
}

function looseString(v) {
  return typeof v === "string" ? v : "";
}

/**
 * Send one request and parse the JSON text body.
 *
 * Deliberately **does not** use `response.json()`: when a credential expires the gateway
 * returns HTML, and `json()`'s error (`Unexpected token '<'`) is meaningless to the user.
 * Here we `text()` first and then parse, and on non-JSON we include the HTTP status code so
 * the clue "401/403 → credential problem" surfaces.
 */
async function requestJson(url, init) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, status: 0, message: `Network request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, status: response.status, message: `Failed to read response: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const snippet = text.trim().slice(0, 120).replace(/\s+/g, " ");
    const hint = response.status === 401 || response.status === 403
      ? `Credential expired (HTTP ${response.status}). Reconnect this account.`
      : `Upstream returned a non-JSON response (HTTP ${response.status}): ${snippet}`;
    return { ok: false, status: response.status, message: hint };
  }

  const record = asRecord(parsed);
  if (record === undefined) {
    return { ok: false, status: response.status, message: "Response is not a JSON object" };
  }
  return { ok: true, status: response.status, body: record };
}

/**
 * HTTP-level **credential-expiry** detection.
 *
 * ⚠️ Why this must be checked separately: `requestJson` only looks at "does it parse into
 * a JSON object", so a response like `401 {"error":"invalid access token"}` is judged
 * `ok:true`, and then each provider's parser defaults it to "not checked in today" — so
 * **credential expiry is silently displayed as "not checked in"**, and the user sees
 * "check-in didn't take effect" instead of "you need to log in again". Measured: a minimax
 * account (with an expired `mmoat_` credential) hit exactly this shape.
 *
 * ⚠️ Why this won't accidentally break codebuddy's idempotency branch: there a duplicate
 * claim is **HTTP 400** (`code:10001`), not 401/403. So treating 401/403 as a hard failure
 * is safe.
 */
function credentialFailure(status) {
  return status === 401 || status === 403;
}

// ── Normalized results ──────────────────────────────────────────────────────

/** A normalized check-in result. The four values of `kind` are "already claimed / claimed now / not eligible / failed". */
export function claimed(credit, extra = {}) {
  return { kind: "claimed", credit: typeof credit === "number" && Number.isFinite(credit) ? credit : 0, ...extra };
}
export function alreadyClaimed(message = "Already checked in today") {
  return { kind: "already-claimed", message };
}
export function inactive(message) {
  return { kind: "inactive", message };
}
export function failed(code, message) {
  return { kind: "failed", code, message };
}

// ── CodeBuddy (China edition + international edition, same protocol shape) ──

/**
 * CodeBuddy's check-in endpoints.
 *
 * China edition `copilot.tencent.com` (**measured with 7 real accounts**);
 * international edition `www.codebuddy.ai` — same shape as CN (its registry's
 * `transport.usage.url` is the very same `/v2/billing/meter/get-user-resource` path,
 * just with a different domain).
 * ⚠️ The international edition has **not been measured against a real account** (none of
 * the accounts available during development were on that channel); it is classified as
 * "structurally identical".
 */
const CODEBUDDY_CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const CODEBUDDY_DAILY_CHECKIN_PATH = "/v2/billing/meter/daily-checkin";

/** Business code: duplicate claim (note there are two values; each site uses one). */
const CB_CODE_ALREADY_CLAIMED = 10001;
const CB_CODE_ALREADY_CLAIMED_ALT = 1001;
/** Business code: not eligible to claim / activity ended. */
const CB_CODE_NO_QUALIFICATION = 1002;
const CB_CODE_ACTIVITY_ENDED = 1003;

function codebuddyHeaders(data) {
  const psd = asRecord(data.providerSpecificData) || {};
  const headers = {
    // An API-key connection stores the credential in `apiKey`, an OAuth one in
    // `accessToken` (see `rowToConn` — the row's `data` object is spread onto the
    // connection). Reading only `accessToken` sends an empty bearer for the
    // apikey form, so the claim is refused with no useful error. The quota
    // readers pass both for the same reason: `getCodeBuddyIntlUsage(c.accessToken,
    // c.apiKey, …)` in open-sse/services/usage.js.
    Authorization: `Bearer ${data.accessToken || data.apiKey || ""}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    // X-Domain must match the request's baseURL, otherwise they contradict each other (the server determines the region from the domain).
    "X-Domain": looseString(psd.domain) || "copilot.tencent.com",
    "X-Product": "SaaS",
    "X-Product-Code": "codebuddy",
    "User-Agent": "CodeBuddyIDE/1.106.1",
  };
  const userId = looseString(psd.userId);
  if (userId) headers["X-User-Id"] = userId;
  const enterpriseId = looseString(psd.enterpriseId);
  if (enterpriseId) {
    headers["X-Enterprise-Id"] = enterpriseId;
    headers["X-Tenant-Id"] = enterpriseId;
  }
  return headers;
}

async function codebuddyStatus(host, data) {
  const res = await requestJson(`${host}${CODEBUDDY_CHECKIN_STATUS_PATH}`, {
    method: "POST",
    headers: codebuddyHeaders(data),
    body: "{}",
  });
  if (!res.ok) return { ok: false, message: res.message };
  const { body } = res;
  if (credentialFailure(res.status)) {
    return { ok: false, message: `Credential expired (HTTP ${res.status}). Reconnect this account.` };
  }
  // ⚠️ The upstream msg is in Chinese; use it only as detail (see the analogous note in codebuddyClaim).
  if (looseNumber(body.code) !== 0) {
    const upstream = looseString(body.msg);
    return { ok: false, message: "Status query failed", ...(upstream ? { detail: upstream } : {}) };
  }
  const d = asRecord(body.data);
  if (d === undefined) return { ok: false, message: "Status response is missing the data field" };
  return {
    ok: true,
    active: looseBool(d.active),
    todayCheckedIn: looseBool(d.today_checked_in),
    streakDays: looseNumber(d.streak_days) ?? 0,
    dailyCredit: looseNumber(d.daily_credit) ?? 0,
    todayCredit: looseNumber(d.today_credit) ?? 0,
    totalCredits: looseNumber(d.total_credits) ?? 0,
    endTime: looseString(d.end_time),
  };
}

async function codebuddyClaim(host, data) {
  // ⚠️ The criterion is the response body's code, not the HTTP status code (duplicate claim = HTTP 400 + code 10001).
  const res = await requestJson(`${host}${CODEBUDDY_DAILY_CHECKIN_PATH}`, {
    method: "POST",
    headers: codebuddyHeaders(data),
    body: "{}",
  });
  if (!res.ok) return failed(-1, res.message);

  const { body } = res;
  if (credentialFailure(res.status)) {
    return failed(-1, `Credential expired (HTTP ${res.status}). Reconnect this account.`);
  }
  const code = looseNumber(body.code) ?? -1;
  // ⚠️ The upstream `msg` is in **Chinese** (e.g. "already checked in today, please come
  // back tomorrow"). It cannot be used directly as display copy: i18n only translates
  // English source text, so Chinese would be left as-is in the English UI. So put it in
  // `detail` (goes to logs, convenient for cross-checking upstream), and use English for `message`.
  const upstream = looseString(body.msg);
  const detail = upstream ? { detail: upstream } : {};

  if (code === CB_CODE_ALREADY_CLAIMED || code === CB_CODE_ALREADY_CLAIMED_ALT) {
    return { ...alreadyClaimed("Already checked in today"), ...detail };
  }
  if (code === CB_CODE_NO_QUALIFICATION || code === CB_CODE_ACTIVITY_ENDED) {
    return { ...inactive("Not eligible to claim right now"), ...detail };
  }
  if (code !== 0) return { ...failed(code, "Claim failed"), ...detail };

  const d = asRecord(body.data);
  if (d === undefined) return failed(code, "Claim response is missing the data field");
  return claimed(looseNumber(d.credit) ?? 0, {
    streakDays: looseNumber(d.streak_days) ?? 0,
    ...(looseString(d.message) ? { delayedMessage: looseString(d.message) } : {}),
  });
}

// ── Qoder (international edition + China edition, same protocol shape) ──────

const QODER_CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";

/**
 * Common request headers for Qoder's `/sash/` endpoints.
 *
 * ⚠️ **Both** machine headers are required to have any chance of getting a claimable
 * activity (ablation measured: with either one missing, the server only returns
 * `VIEW_DETAILS` and **does not send down** `CLAIM_BENEFIT`). In 9router's connection,
 * `machineId` is the UUID persisted at login, which conveniently serves as the source for
 * token/type. When it can't be obtained, **do not send empty headers** — omitting them is a
 * safe degradation, whereas sending an empty string may be judged an illegal device.
 */
function qoderHeaders(data) {
  const psd = asRecord(data.providerSpecificData) || {};
  const headers = {
    Accept: "application/json",
    // Same credential-shape rule as codebuddyHeaders: an apikey connection keeps
    // the token in `apiKey`, an OAuth one in `accessToken`.
    Authorization: `Bearer ${data.accessToken || data.apiKey || ""}`,
    "User-Agent": "Qoder",
    // '10' = desktop app identity; with '5' (CLI) the server never sends down a claimable activity.
    "Cosy-ClientType": "10",
  };
  const machineId = looseString(psd.machineId);
  if (machineId) {
    headers["Cosy-MachineToken"] = machineId;
    headers["Cosy-MachineType"] = "5";
  }
  return headers;
}

function parseQoderCampaigns(body) {
  const campaigns = Array.isArray(body.campaigns) ? body.campaigns.filter((c) => asRecord(c) !== undefined) : [];
  return campaigns.map((c) => ({
    campaignId: looseString(c.campaignId),
    campaignKey: looseString(c.campaignKey),
    actionType: looseString(c.actionType),
    claimStatus: looseString(c.claimStatus),
    amount: looseNumber(asRecord(c.benefit)?.amount),
  }));
}

function qoderClaimable(campaigns) {
  return campaigns.filter((c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMABLE" && c.campaignId);
}

/**
 * The criterion for "already claimed today": there exists a **claim-type** activity whose
 * status is `CLAIMED`.
 *
 * ⚠️ Must not be written as "no claimable item means already claimed" (see item 3 in the
 *    module header).
 * ⚠️ Nor may claim be skipped on this basis — the server is idempotent for duplicate
 *    claims (returns `replayed:true`); misjudging it as "not claimed" costs at most one
 *    harmless extra request, whereas misjudging it as "already claimed" means a genuine
 *    missed claim that day. So the status is used only for **presentation**, and claim is
 *    still sent (backstopped by `replayed`).
 */
function qoderTodayCheckedIn(campaigns) {
  return campaigns.some((c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMED");
}

async function qoderCampaigns(host, data) {
  const res = await requestJson(`${host}${QODER_CAMPAIGNS_PATH}`, {
    method: "GET",
    headers: qoderHeaders(data),
  });
  if (!res.ok) return { ok: false, message: res.message };
  if (credentialFailure(res.status)) {
    return { ok: false, message: `Credential expired (HTTP ${res.status}). Reconnect this account.` };
  }
  return { ok: true, campaigns: parseQoderCampaigns(res.body) };
}

async function qoderClaimOne(host, data, campaignId) {
  const res = await requestJson(`${host}${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`, {
    method: "POST",
    headers: { ...qoderHeaders(data), "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return failed(-1, res.message);
  if (credentialFailure(res.status)) {
    return failed(-1, `Credential expired (HTTP ${res.status}). Reconnect this account.`);
  }

  // ⚠️ The idempotency criterion is `replayed`: a duplicate claim also returns 200, but with replayed=true and no benefit.
  if (looseBool(res.body.replayed)) return alreadyClaimed("Already claimed today");
  const d = asRecord(res.body.data) || res.body;
  const amount = looseNumber(asRecord(d.benefit)?.amount);
  return claimed(amount ?? 0);
}

// ── MiniMax ────────────────────────────────────────────────────────────────

const MINIMAX_SIGNIN_STATUS_PATH = "/minimax-cloud/api/v1/signin/status";
const MINIMAX_SIGNIN_CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";

/** Single-day status (asar `SigninDayStatus`). */
const MINIMAX_DAY = { Upcoming: 1, Claimable: 2, Claimed: 3, Disabled: 4 };
/** Claim result (asar `SigninClaimResult`). */
const MINIMAX_CLAIM_RESULT = { Claimed: 1, AlreadyClaimed: 2 };

function minimaxHeaders(data) {
  // MiniMax's business endpoints **only need Bearer** (no machine headers or signature).
  // For an apikey-type connection, `apiKey` is itself the OAuth access token (the `mmoat_` prefix).
  return {
    Authorization: `Bearer ${data.accessToken || data.apiKey || ""}`,
    Accept: "application/json",
  };
}

/** Unwrap the envelope: if there's a `data` object use it, otherwise use the top level (`credit/details` are flat). */
function unwrapEnvelope(payload) {
  const nested = asRecord(payload.data);
  return nested === undefined ? payload : nested;
}

/**
 * The business code is in `base_resp.status_code`, and `invalid timezone_id` is also
 * **HTTP 200** — looking only at the HTTP status code would treat it as success.
 */
function minimaxBusinessError(body) {
  const base = asRecord(body.base_resp);
  if (base === undefined) return undefined;
  const code = looseNumber(base.status_code);
  if (code === undefined || code === 0) return undefined;
  // ⚠️ `status_msg` may be Chinese; use it only as detail (see the analogous note in codebuddyClaim).
  const upstream = looseString(base.status_msg);
  return { code, message: `Upstream error ${code}`, ...(upstream ? { detail: upstream } : {}) };
}

function withTimezone(base, path, timezoneId) {
  const url = new URL(`${base}${path}`);
  url.searchParams.set("timezone_id", timezoneId);
  return url.toString();
}

async function minimaxStatus(host, data, timezoneId) {
  const res = await requestJson(withTimezone(host, MINIMAX_SIGNIN_STATUS_PATH, timezoneId), {
    method: "GET",
    headers: minimaxHeaders(data),
  });
  if (!res.ok) return { ok: false, message: res.message };
  if (credentialFailure(res.status)) {
    return { ok: false, message: `Credential expired (HTTP ${res.status}). Reconnect this account.` };
  }
  const biz = minimaxBusinessError(res.body);
  if (biz) return { ok: false, message: biz.message, ...(biz.detail ? { detail: biz.detail } : {}) };

  const panel = asRecord(unwrapEnvelope(res.body).panel);
  const days = Array.isArray(panel?.days) ? panel.days : [];
  const today = days.find((d) => looseBool(asRecord(d)?.isToday)) || days[0];
  return {
    ok: true,
    todayCheckedIn: looseNumber(asRecord(today)?.status) === MINIMAX_DAY.Claimed,
    streakDays: looseNumber(asRecord(today)?.streakDays) ?? 0,
  };
}

async function minimaxClaim(host, data, timezoneId) {
  const res = await requestJson(withTimezone(host, MINIMAX_SIGNIN_CLAIM_PATH, timezoneId), {
    method: "POST",
    headers: { ...minimaxHeaders(data), "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return failed(-1, res.message);
  if (credentialFailure(res.status)) {
    return failed(-1, `Credential expired (HTTP ${res.status}). Reconnect this account.`);
  }

  const biz = minimaxBusinessError(res.body);
  // ⚠️ The `detail` (upstream's original text) must be carried onto the outcome too: lose
  // it and the upstream explanation kept in `biz` never reaches the logs, leaving only a
  // context-free code like "Upstream error 1004" when debugging.
  if (biz) {
    return { ...failed(biz.code, biz.message), ...(biz.detail ? { detail: biz.detail } : {}) };
  }

  const payload = unwrapEnvelope(res.body);
  const claimResult = looseNumber(payload.claim_result);

  // ⚠️ Idempotency: a duplicate claim returns 2 (AlreadyClaimed).
  if (claimResult === MINIMAX_CLAIM_RESULT.AlreadyClaimed) return alreadyClaimed("Already checked in today");
  if (claimResult !== MINIMAX_CLAIM_RESULT.Claimed) {
    return failed(-1, "Check-in response is missing a valid claim_result");
  }
  // ⚠️ credit takes points (the total, already including bonus_points).
  return claimed(looseNumber(payload.points) ?? 0);
}

// ── provider table ──────────────────────────────────────────────────────────

/**
 * Providers that have a check-in implementation.
 *
 * The contract of `run`: **never throw**; on failure it returns a `failed` outcome too
 * (during batch check-in, a single account's failure must not interrupt the rest).
 */
const IMPLEMENTATIONS = {
  "codebuddy-cn": {
    label: "CodeBuddy CN",
    host: "https://copilot.tencent.com",
    status: (data) => codebuddyStatus("https://copilot.tencent.com", data),
    claim: (data) => codebuddyClaim("https://copilot.tencent.com", data),
    unit: "credit",
    verified: true,
  },
  "codebuddy-intl": {
    label: "CodeBuddy",
    host: "https://www.codebuddy.ai",
    status: (data) => codebuddyStatus("https://www.codebuddy.ai", data),
    claim: (data) => codebuddyClaim("https://www.codebuddy.ai", data),
    unit: "credit",
    verified: false,
    // ⚠️ The wording must stay environment-independent. `verified` asserts that
    // WE have not validated this implementation against a live account — it must
    // never claim that some particular host has no account for this provider,
    // because that stops being true on another deployment and the UI then shows
    // "1 account" next to "no account available".
    note: "Protocol matches CN (same paths, different host), but this implementation has not been verified against a real account.",
  },
  qoder: {
    label: "Qoder",
    host: "https://openapi.qoder.sh",
    status: async (data) => {
      const r = await qoderCampaigns("https://openapi.qoder.sh", data);
      if (!r.ok) return { ok: false, message: r.message };
      return {
        ok: true,
        // ⚠️ active is always true (true as soon as we get a response); see item 4 in the module header.
        todayCheckedIn: qoderTodayCheckedIn(r.campaigns),
        claimable: qoderClaimable(r.campaigns).length,
      };
    },
    claim: async (data) => {
      const r = await qoderCampaigns("https://openapi.qoder.sh", data);
      if (!r.ok) return failed(-1, r.message);
      return claimQoderCampaignList("https://openapi.qoder.sh", data, r.campaigns);
    },
    unit: "credit",
    verified: true,
  },
  "qoder-cn": {
    label: "Qoder CN",
    host: "https://openapi.qoder.com.cn",
    status: async (data) => {
      const r = await qoderCampaigns("https://openapi.qoder.com.cn", data);
      if (!r.ok) return { ok: false, message: r.message };
      return {
        ok: true,
        todayCheckedIn: qoderTodayCheckedIn(r.campaigns),
        claimable: qoderClaimable(r.campaigns).length,
      };
    },
    claim: async (data) => {
      const r = await qoderCampaigns("https://openapi.qoder.com.cn", data);
      if (!r.ok) return failed(-1, r.message);
      return claimQoderCampaignList("https://openapi.qoder.com.cn", data, r.campaigns);
    },
    unit: "credit",
    verified: true,
  },
  minimax: {
    label: "MiniMax",
    host: "https://agent.minimax.cn",
    status: (data, ctx) => minimaxStatus("https://agent.minimax.cn", data, ctx.timezoneId),
    claim: (data, ctx) => minimaxClaim("https://agent.minimax.cn", data, ctx.timezoneId),
    unit: "credit",
    verified: false,
    // Likewise states only "not verified by a real claim", and does not describe whether some machine has an account (that stops being true on another machine).
    note: "Endpoints and envelope shape follow the source, but a live claim has not been verified (the credential used during development was expired).",
  },
};

/**
 * Claim Qoder's activities one by one; **stop as soon as the first one succeeds** (an
 * account has only one daily check-in per day).
 *
 * When all of them are `replayed` (already claimed earlier), return already-claimed;
 * when there is not a single claimable one, return `inactive` (**not** already-claimed —
 * that would cause a genuine missed claim that day, and this direction is irreversible).
 */
async function claimQoderCampaignList(host, data, campaigns) {
  const claimable = qoderClaimable(campaigns);
  if (claimable.length === 0) {
    return qoderTodayCheckedIn(campaigns)
      ? alreadyClaimed("Already claimed today")
      : inactive("No claimable activity right now");
  }
  let last = inactive("No claimable activity right now");
  for (const c of claimable) {
    const outcome = await qoderClaimOne(host, data, c.campaignId);
    if (outcome.kind === "claimed") return outcome;
    last = outcome;
    if (outcome.kind === "failed") return outcome;
  }
  return last;
}

/** Providers that explicitly do **not** support check-in, and the reason (determining this sends no upstream request at all). */
const UNSUPPORTED = {
  cline: "Cline does not support daily check-in (no check-in endpoint upstream)",
  workbuddy: "WorkBuddy does not support daily check-in (no check-in endpoint upstream)",
  raccoon: "Raccoon Work does not support daily check-in (credits are granted server-side)",
};

/** Whether this provider has a check-in implementation. */
export function isCheckinSupported(provider) {
  return Object.prototype.hasOwnProperty.call(IMPLEMENTATIONS, provider);
}

/** This provider's display name (falls back to the provider id when there is no implementation). */
export function checkinLabel(provider) {
  return IMPLEMENTATIONS[provider]?.label || provider;
}

/**
 * All providers with an implementation (for UI / debugging enumeration).
 *
 * ⚠️ `note` is text **rendered directly onto the dashboard**, so it must be in **English**:
 * runtime i18n works by looking up "English source → translation" (src/i18n/runtime.js);
 * Chinese source text is never translated and would be left as-is in the English UI
 * (measured: the first version was exactly like this). The rationale itself is still
 * written in Chinese in the registry's source comments, which are for maintainers and do
 * not enter the UI.
 */
export function listCheckinProviders() {
  return Object.keys(IMPLEMENTATIONS).map((id) => ({
    id,
    label: IMPLEMENTATIONS[id].label,
    verified: IMPLEMENTATIONS[id].verified === true,
    ...(IMPLEMENTATIONS[id].note ? { note: IMPLEMENTATIONS[id].note } : {}),
  }));
}

/** The reason check-in is unsupported (returns undefined if supported). */
export function unsupportedReason(provider) {
  return UNSUPPORTED[provider];
}

/**
 * Check-in status (read-only, **sends no write request**).
 *
 * @returns `{ ok: true, todayCheckedIn, ... }` or `{ ok: false, message }`.
 *   Failure is strictly distinguished from "balance is 0" — a network failure does not
 *   mean "not checked in today".
 */
export async function checkinStatus(provider, data, ctx = {}) {
  const impl = IMPLEMENTATIONS[provider];
  if (impl === undefined) {
    const reason = unsupportedReason(provider);
    return { ok: false, message: reason || `${provider} has no check-in implementation` };
  }
  const context = { timezoneId: ctx.timezoneId || resolveIanaTimezone() };
  try {
    return await impl.status(data, context);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Perform one check-in claim (**a write operation**; should be called only once per account
 * per day).
 *
 * **Never throws** — on failure it returns a `failed` outcome too.
 */
export async function claimCheckin(provider, data, ctx = {}) {
  const impl = IMPLEMENTATIONS[provider];
  if (impl === undefined) {
    const reason = unsupportedReason(provider);
    return failed(-1, reason || `${provider} has no check-in implementation`);
  }
  const context = { timezoneId: ctx.timezoneId || resolveIanaTimezone() };
  try {
    return await impl.claim(data, context);
  } catch (error) {
    return failed(-1, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Turn an outcome into a human-readable sentence (shared by UI / logs).
 *
 * ⚠️ This is the **sole funnel** for display copy, so it adds one more safety net here: if
 * `message` contains CJK characters, it means some upstream original text leaked into the
 * display path (i18n only translates English source text; Chinese would be left as-is in
 * the English UI), in which case fall back to the English default copy. Each provider
 * already puts the upstream original text into `detail`; this layer is defensive — if a new
 * provider forgets this rule it still won't leak Chinese into the UI (there is a regression
 * test guarding it).
 */
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

function englishOr(message, fallback) {
  return typeof message === "string" && message.length > 0 && !CJK_RE.test(message)
    ? message
    : fallback;
}

export function describeOutcome(outcome) {
  switch (outcome?.kind) {
    case "claimed":
      return `Checked in +${outcome.credit}`;
    case "already-claimed":
      return englishOr(outcome.message, "Already checked in today");
    case "inactive":
      return englishOr(outcome.message, "No claimable activity");
    case "failed":
      return englishOr(outcome.message, "Check-in failed");
    default:
      return "Unknown outcome";
  }
}

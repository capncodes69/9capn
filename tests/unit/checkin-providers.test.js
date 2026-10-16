/**
 * Offline regression cases for the check-in protocol layer (no network).
 *
 * They guard three classes of "silent error" — all sharing the trait of
 * **not throwing but returning the wrong result**, which makes them nearly
 * impossible to catch in manual acceptance testing. The tests must catch them:
 *
 * 1. **An expired credential misreported as "not checked in today"** (minimax hits this exactly).
 * 2. **The idempotent branch misreported as "failed"** (codebuddy's duplicate claim is HTTP 400;
 *    judging by status code alone treats "already checked in today" as a failure, which then gets
 *    retried or even blamed on the credential).
 * 3. **A wrong UTC+8 day boundary** (east of UTC marks "already ran today" early ⇒ a real missed
 *    check-in; west of UTC runs twice in one day).
 *
 * Run: cd tests && npx vitest run <this file>
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  utc8DateString,
  isCheckinSupported,
  unsupportedReason,
  checkinStatus,
  claimCheckin,
  describeOutcome,
  listCheckinProviders,
  resolveIanaTimezone,
} from "../../src/shared/services/checkinProviders.js";

// ── Swap in an injectable fetch on the global, asserting parse logic per shape ────────────────────────────

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CODEBUDDY_CREDS = {
  accessToken: "tok",
  providerSpecificData: { userId: "u1", domain: "copilot.tencent.com" },
};

// ── 1. UTC+8 day boundary ──────────────────────────────────────────────────────────

test("utc8DateString: rolls to the next day after 16:00Z (UTC+8 day boundary)", () => {
  assert.equal(utc8DateString(Date.parse("2026-10-15T15:59:59Z")), "2026-10-15");
  assert.equal(utc8DateString(Date.parse("2026-10-15T16:00:00Z")), "2026-10-16");
  assert.equal(utc8DateString(Date.parse("2026-10-15T23:30:00Z")), "2026-10-16");
});

test("utc8DateString: independent of the process timezone", () => {
  // The same instant must yield the same result under any TZ (an arithmetic offset, not the local timezone).
  const t = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(utc8DateString(t), "2026-01-01");
});

// ── 2. Unsupported channels must make zero requests ───────────────────────────────────────────────

test("cline/workbuddy/raccoon/gemini have no implementation and give a reason", () => {
  for (const p of ["cline", "workbuddy", "raccoon", "gemini"]) {
    assert.equal(isCheckinSupported(p), false, `${p} must have no implementation`);
  }
  // These reasons are **rendered directly in the UI**, so they must be English (i18n only translates English source text).
  assert.match(unsupportedReason("cline"), /does not support daily check-in/);
  assert.match(unsupportedReason("workbuddy"), /does not support daily check-in/);
  assert.match(unsupportedReason("raccoon"), /does not support daily check-in/);
});

test("claimCheckin(unsupported channel) makes no network request", async () => {
  let called = 0;
  const restore = stubFetch(async () => { called++; return jsonResponse({}); });
  try {
    const outcome = await claimCheckin("cline", {});
    assert.equal(outcome.kind, "failed");
    assert.equal(called, 0, "must not issue an upstream request");
  } finally {
    restore();
  }
});

// ── 3. Expired credential ≠ not checked in today ──────────────────────────────────────────────────

test("HTTP 401 must report an expired credential, not 'not checked in'", async () => {
  const restore = stubFetch(async () =>
    jsonResponse({ error: "invalid access token" }, 401),
  );
  try {
    // minimax's shape: 401 + JSON body (parseable, so especially easy to misjudge as success).
    const st = await checkinStatus("minimax", { apiKey: "dead", accessToken: "dead" });
    assert.equal(st.ok, false, "401 must be judged a failure");
    assert.match(st.message, /Credential expired/);

    const cl = await claimCheckin("minimax", { apiKey: "dead", accessToken: "dead" });
    assert.equal(cl.kind, "failed");
    assert.match(cl.message, /Credential expired/);

    // qoder, same shape
    const qd = await checkinStatus("qoder", { accessToken: "dead" });
    assert.equal(qd.ok, false);
    assert.match(qd.message, /Credential expired/);

    // codebuddy, same shape
    const cb = await checkinStatus("codebuddy-cn", CODEBUDDY_CREDS);
    assert.equal(cb.ok, false);
    assert.match(cb.message, /Credential expired/);
  } finally {
    restore();
  }
});

// ── 4. Idempotent branch: the criterion is in the response body, not the HTTP status code ──────────────────────────────

test("codebuddy duplicate claim (HTTP 400 + code 10001) is judged already checked in today, not failed", async () => {
  const restore = stubFetch(async () =>
    jsonResponse({ code: 10001, msg: "今天已签到，请明天再来" }, 400),
  );
  try {
    const outcome = await claimCheckin("codebuddy-cn", CODEBUDDY_CREDS);
    assert.equal(outcome.kind, "already-claimed");
    // The displayed text must be English (i18n only translates English source text)...
    assert.match(describeOutcome(outcome), /already checked in/i);
    assert.doesNotMatch(describeOutcome(outcome), /[\u4e00-\u9fff]/, "displayed text must not contain Chinese");
    // ...while the upstream raw text is still preserved for cross-checking.
    assert.equal(outcome.detail, "今天已签到，请明天再来");
  } finally {
    restore();
  }
});

test("codebuddy fallback code 1001 is also judged already checked in", async () => {
  const restore = stubFetch(async () => jsonResponse({ code: 1001, msg: "已领取" }, 400));
  try {
    const outcome = await claimCheckin("codebuddy-cn", CODEBUDDY_CREDS);
    assert.equal(outcome.kind, "already-claimed");
  } finally {
    restore();
  }
});

// ── 4b. Credential shape: an apikey connection keeps the token in `apiKey` ────────────────────────────────
//
// `rowToConn` spreads the row's `data` object onto the connection, so an
// `authType: "apikey"` connection has `apiKey` and NO `accessToken`. Reading only
// `accessToken` then sends `Authorization: Bearer ` (empty) and the claim is
// refused with no useful error. Measured on a live pool: 12 of 288
// `codebuddy-intl` connections are apikey-only.

test("codebuddy sends the token from apiKey when the connection is apikey-only", async () => {
  let seenAuth = null;
  const restore = stubFetch(async (_url, init) => {
    seenAuth = init?.headers?.Authorization;
    return jsonResponse({ code: 10001, msg: "今天已签到" }, 400);
  });
  try {
    // No accessToken at all — exactly the apikey row shape.
    const outcome = await claimCheckin("codebuddy-cn", {
      apiKey: "apikey-token-value",
      providerSpecificData: {},
    });
    assert.equal(seenAuth, "Bearer apikey-token-value", "must fall back to apiKey");
    assert.equal(outcome.kind, "already-claimed");
  } finally {
    restore();
  }
});

test("qoder sends the token from apiKey when the connection is apikey-only", async () => {
  let seenAuth = null;
  const restore = stubFetch(async (_url, init) => {
    seenAuth = init?.headers?.Authorization;
    return jsonResponse({ code: 0, data: { campaigns: [] } });
  });
  try {
    await claimCheckin("qoder", { apiKey: "qoder-apikey", providerSpecificData: {} });
    assert.equal(seenAuth, "Bearer qoder-apikey", "must fall back to apiKey");
  } finally {
    restore();
  }
});

test("an accessToken still wins over apiKey when both are present", async () => {
  let seenAuth = null;
  const restore = stubFetch(async (_url, init) => {
    seenAuth = init?.headers?.Authorization;
    return jsonResponse({ code: 10001, msg: "今天已签到" }, 400);
  });
  try {
    await claimCheckin("codebuddy-cn", { accessToken: "oauth-token", apiKey: "other", providerSpecificData: {} });
    assert.equal(seenAuth, "Bearer oauth-token");
  } finally {
    restore();
  }
});

test("codebuddy a real successful claim returns claimed + credit", async () => {
  const restore = stubFetch(async () =>
    jsonResponse({ code: 0, msg: "OK", data: { credit: 100, streak_days: 5 } }),
  );
  try {
    const outcome = await claimCheckin("codebuddy-cn", CODEBUDDY_CREDS);
    assert.equal(outcome.kind, "claimed");
    assert.equal(outcome.credit, 100);
    assert.equal(outcome.streakDays, 5);
  } finally {
    restore();
  }
});

test("codebuddy ineligible/ended campaign is judged inactive (not already-claimed)", async () => {
  for (const code of [1002, 1003]) {
    const restore = stubFetch(async () => jsonResponse({ code, msg: "无资格" }, 400));
    try {
      const outcome = await claimCheckin("codebuddy-cn", CODEBUDDY_CREDS);
      assert.equal(outcome.kind, "inactive", `code ${code} should be inactive`);
    } finally {
      restore();
    }
  }
});

test("codebuddy gives a readable reason on an HTML gateway error page, without 'Unexpected token'", async () => {
  const restore = stubFetch(async () =>
    new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
  );
  try {
    const outcome = await claimCheckin("codebuddy-cn", CODEBUDDY_CREDS);
    assert.equal(outcome.kind, "failed");
    assert.doesNotMatch(outcome.message, /Unexpected token/);
    assert.match(outcome.message, /502/);
  } finally {
    restore();
  }
});

// ── 5. Qoder: replayed idempotency + "no campaign" ≠ "already claimed" ────────────────────────────

function qoderFetch({ campaigns, replayed = false }) {
  return async (url) => {
    if (String(url).includes("/claim")) {
      return jsonResponse(replayed ? { replayed: true } : { data: { benefit: { amount: 100 } } });
    }
    return jsonResponse({ showCampaign: true, claimable: true, campaigns });
  };
}

test("qoder replayed:true is judged already claimed (a duplicate claim is also 200)", async () => {
  const restore = stubFetch(
    qoderFetch({
      replayed: true,
      campaigns: [
        { campaignId: "c1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", benefit: { amount: 100 } },
      ],
    }),
  );
  try {
    const outcome = await claimCheckin("qoder", { accessToken: "t" });
    assert.equal(outcome.kind, "already-claimed");
  } finally {
    restore();
  }
});

test("qoder with no claimable campaign and not yet claimed ⇒ inactive (must never report already claimed)", async () => {
  const restore = stubFetch(
    qoderFetch({ campaigns: [{ campaignId: "c1", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE" }] }),
  );
  try {
    const outcome = await claimCheckin("qoder", { accessToken: "t" });
    assert.equal(outcome.kind, "inactive", "with nothing claimable it must not report already-claimed — that would cause a real missed claim that day");
  } finally {
    restore();
  }
});

test("qoder with a CLAIMED claim-type campaign ⇒ judged already claimed today", async () => {
  const restore = stubFetch(
    qoderFetch({
      campaigns: [
        { campaignId: "c1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED", benefit: { amount: 100 } },
      ],
    }),
  );
  try {
    const st = await checkinStatus("qoder", { accessToken: "t" });
    assert.equal(st.ok, true);
    assert.equal(st.todayCheckedIn, true, "CLAIM_BENEFIT+CLAIMED is a reliable signal that the benefit was already claimed");
  } finally {
    restore();
  }
});

test("qoder with only VIEW_DETAILS has todayCheckedIn false (an unrefreshed campaign ≠ already claimed)", async () => {
  const restore = stubFetch(
    qoderFetch({ campaigns: [{ campaignId: "c1", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE" }] }),
  );
  try {
    const st = await checkinStatus("qoder", { accessToken: "t" });
    assert.equal(st.ok, true);
    assert.equal(st.todayCheckedIn, false);
  } finally {
    restore();
  }
});

test("qoder a successful claim surfaces benefit.amount", async () => {
  const restore = stubFetch(
    qoderFetch({
      campaigns: [
        { campaignId: "c1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", benefit: { amount: 100 } },
      ],
    }),
  );
  try {
    const outcome = await claimCheckin("qoder", { accessToken: "t" });
    assert.equal(outcome.kind, "claimed");
    assert.equal(outcome.credit, 100);
  } finally {
    restore();
  }
});

// ── 6. MiniMax: claim_result idempotency + business code ──────────────────────────────────

test("minimax claim_result:2 is judged already checked in", async () => {
  const restore = stubFetch(async () => jsonResponse({ data: { claim_result: 2 } }));
  try {
    const outcome = await claimCheckin("minimax", { accessToken: "t" });
    assert.equal(outcome.kind, "already-claimed");
  } finally {
    restore();
  }
});

test("minimax claim_result:1 is judged a success and reads out points", async () => {
  const restore = stubFetch(async () => jsonResponse({ data: { claim_result: 1, points: 800 } }));
  try {
    const outcome = await claimCheckin("minimax", { accessToken: "t" });
    assert.equal(outcome.kind, "claimed");
    assert.equal(outcome.credit, 800);
  } finally {
    restore();
  }
});

test("minimax a non-zero base_resp.status_code ⇒ failure (HTTP 200 still counts as failure)", async () => {
  const restore = stubFetch(async () =>
    jsonResponse({ base_resp: { status_code: 1004, status_msg: "invalid timezone_id" } }),
  );
  try {
    const outcome = await claimCheckin("minimax", { accessToken: "t" });
    assert.equal(outcome.kind, "failed", "a non-zero business code must be a failure even though HTTP is 200");
    assert.equal(outcome.code, 1004);
    // The displayed text is the English fallback; the upstream raw text stays in detail (i18n only translates English source text).
    assert.match(outcome.message, /Upstream error 1004/);
    assert.equal(outcome.detail, "invalid timezone_id");
  } finally {
    restore();
  }
});

test("minimax a missing claim_result ⇒ failure, no fabricated success", async () => {
  const restore = stubFetch(async () => jsonResponse({ data: {} }));
  try {
    const outcome = await claimCheckin("minimax", { accessToken: "t" });
    assert.equal(outcome.kind, "failed");
  } finally {
    restore();
  }
});

// ── 7. Request header contract ──────────────────────────────────────────────────────────

test("codebuddy sends the full X-Domain / X-Product-Code / X-User-Id", async () => {
  let seen = null;
  const restore = stubFetch(async (url, init) => {
    seen = init.headers;
    return jsonResponse({ code: 0, data: { credit: 1 } });
  });
  try {
    await claimCheckin("codebuddy-cn", CODEBUDDY_CREDS);
    assert.equal(seen["X-Domain"], "copilot.tencent.com");
    assert.equal(seen["X-Product"], "SaaS");
    assert.equal(seen["X-Product-Code"], "codebuddy");
    assert.equal(seen["X-User-Id"], "u1");
    assert.equal(seen.Authorization, "Bearer tok");
  } finally {
    restore();
  }
});

test("qoder uses Cosy-ClientType:10 and omits the machine header when machineId is missing", async () => {
  let seen = null;
  const restore = stubFetch(async (url, init) => {
    seen = init.headers;
    return jsonResponse({ campaigns: [] });
  });
  try {
    await checkinStatus("qoder", { accessToken: "t", providerSpecificData: {} });
    assert.equal(seen["Cosy-ClientType"], "10", "must be '10' (desktop app); '5' never gets a claimable campaign");
    assert.equal("Cosy-MachineToken" in seen, false, "must not send an empty header when machineId is missing");
  } finally {
    restore();
  }
});

test("qoder sends the machine headers as a pair when machineId is present", async () => {
  let seen = null;
  const restore = stubFetch(async (url, init) => {
    seen = init.headers;
    return jsonResponse({ campaigns: [] });
  });
  try {
    await checkinStatus("qoder", { accessToken: "t", providerSpecificData: { machineId: "m-1" } });
    assert.equal(seen["Cosy-MachineToken"], "m-1");
    assert.equal(seen["Cosy-MachineType"], "5");
  } finally {
    restore();
  }
});

test("minimax status query carries timezone_id (settles by client timezone, not UTC+8)", async () => {
  let seenUrl = null;
  const restore = stubFetch(async (url) => {
    seenUrl = String(url);
    return jsonResponse({ data: { panel: { days: [] } } });
  });
  try {
    await checkinStatus("minimax", { accessToken: "t" }, { timezoneId: "Asia/Shanghai" });
    assert.match(seenUrl, /timezone_id=Asia%2FShanghai/);
  } finally {
    restore();
  }
});

// ── 8. Metadata ──────────────────────────────────────────────────────────────

test("the list of implemented channels has 5 entries and all have a label", () => {
  const list = listCheckinProviders();
  assert.equal(list.length, 5);
  for (const p of list) {
    assert.ok(p.label && p.label.length > 0, `${p.id} is missing a label`);
  }
  // Ones not tested against a real account must be marked explicitly, not passed off as verified.
  assert.equal(list.find((p) => p.id === "codebuddy-intl").verified, false);
  assert.equal(list.find((p) => p.id === "codebuddy-cn").verified, true);
});

test("resolveIanaTimezone falls back to UTC on error instead of throwing", () => {
  assert.equal(resolveIanaTimezone(() => { throw new Error("boom"); }), "UTC");
  assert.equal(resolveIanaTimezone(() => "  "), "UTC");
  assert.equal(resolveIanaTimezone(() => "Asia/Tokyo"), "Asia/Tokyo");
});

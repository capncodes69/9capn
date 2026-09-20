// Qoder keeps campaign rewards in their own `addOnQuota` bucket, separate from
// the plan quota: qoder.com renders it as "Add-on Credits → Bonus Credits
// (Total: N)". The card must surface it as its own row (the way CodeBuddy's
// bonus packs are) and must NOT invent a row for an account that never claimed
// a reward — Qoder omits the key for those, and an account can answer all-zero.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const QODER_QUOTA_URL = "https://openapi.qoder.sh/api/v2/quota/usage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Verbatim shape of a live answer from an account holding a claimed +100:
// plan Pro Trial (300) plus the bonus pack (100). `addOnQuota` sits beside
// `userQuota` in the same response — no second request is involved.
const PLAN_WITH_BONUS = {
  userId: "01a0bebb-9028-7c40-8725-bebcd1989119",
  userType: "personal_professional_trial",
  totalUsagePercentage: 0,
  isQuotaExceeded: false,
  expiresAt: 1791115992174,
  userQuota: { total: 300, used: 0, remaining: 300, unit: "credits" },
  addOnQuota: { total: 100, used: 0, remaining: 100, unit: "credits" },
};

describe("getQoderUsage add-on credits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("surfaces the campaign bucket as its own quota row", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(PLAN_WITH_BONUS));

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "jt-live",
    });

    expect(usage.message).toBeUndefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe(QODER_QUOTA_URL);

    expect(usage.quotas.user).toMatchObject({ total: 300, used: 0, remaining: 300 });
    expect(usage.quotas.addon).toMatchObject({
      total: 100,
      used: 0,
      remaining: 100,
      unit: "credits",
      // One-shot pack: no resetAt, because the payload's `expiresAt` is the
      // *plan's* reset and the pack expiry is not published here.
      resetAt: null,
      recurring: false,
      // 100 credits = one reward.
      packs: 1,
    });
  });

  it("counts the accumulated rewards the aggregate is made of", async () => {
    // docs.qoder.com/events/100credits: rewards never reset — "if you claim 100
    // Credits today and use 20, then claim another 100 Credits tomorrow, you
    // will have 180 Credits across the two rewards". So `total` is the sum of
    // the pack sizes, which is what makes the count recoverable at all. The
    // per-reward list (with each reward's own expiry) is web-session-only.
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        ...PLAN_WITH_BONUS,
        addOnQuota: { total: 200, used: 20, remaining: 180, unit: "credits" },
      }),
    );

    const usage = await getUsageForProvider({ provider: "qoder", accessToken: "jt-live" });

    expect(usage.quotas.addon).toMatchObject({ total: 200, used: 20, remaining: 180, packs: 2 });
    // Still no date — the count is the only thing the aggregate can prove.
    expect(usage.quotas.addon.resetAt).toBeNull();
  });

  it("never divides an odd aggregate into a fractional pack count", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        ...PLAN_WITH_BONUS,
        addOnQuota: { total: 150, used: 0, remaining: 150, unit: "credits" },
      }),
    );

    const usage = await getUsageForProvider({ provider: "qoder", accessToken: "jt-live" });

    expect(usage.quotas.addon.packs).toBe(1);
  });

  it("omits the row when the account never claimed a reward (key absent)", async () => {
    const { addOnQuota, ...withoutAddon } = PLAN_WITH_BONUS;
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(withoutAddon));

    const usage = await getUsageForProvider({ provider: "qoder", accessToken: "jt-live" });

    expect(usage.quotas.user.total).toBe(300);
    expect(usage.quotas.addon).toBeUndefined();
  });

  it("omits the row when the bucket is present but all-zero", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ ...PLAN_WITH_BONUS, addOnQuota: { total: 0, used: 0, remaining: 0 } }),
    );

    const usage = await getUsageForProvider({ provider: "qoder", accessToken: "jt-live" });

    expect(usage.quotas.addon).toBeUndefined();
  });

  it("uses the bucket's own unit (never assumes credits)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        ...PLAN_WITH_BONUS,
        addOnQuota: { total: 100, used: 25, remaining: 75, unit: "calls" },
      }),
    );

    const usage = await getUsageForProvider({ provider: "qoder", accessToken: "jt-live" });

    expect(usage.quotas.addon).toMatchObject({ used: 25, total: 100, unit: "calls" });
  });
});

describe("parseQuotaData(qoder)", () => {
  it("labels the add-on bucket and keeps it out of the plan row", () => {
    const rows = parseQuotaData("qoder", {
      quotas: {
        user: { total: 300, used: 0, remaining: 300, unit: "credits", resetAt: "2026-10-04T00:00:00Z" },
        organization: { total: 0, used: 0, remaining: 0 },
        addon: { total: 100, used: 0, remaining: 100, unit: "credits", resetAt: null, recurring: false },
      },
    });

    const byName = Object.fromEntries(rows.map((q) => [q.name, q]));
    expect(Object.keys(byName)).toEqual(["Personal", "Bonus Credits"]);
    expect(byName["Personal"].total).toBe(300);
    expect(byName["Personal"].recurring).toBe(true);
    expect(byName["Bonus Credits"]).toMatchObject({
      used: 0,
      total: 100,
      recurring: false,
      resetAt: null,
    });
    // Absolute credit counts must never reach the 0-100 percentage maths.
    expect(byName["Personal"].remaining).toBeUndefined();
    expect(byName["Bonus Credits"].remaining).toBeUndefined();
  });

  it("says how many rewards a multi-pack aggregate holds", () => {
    const rows = parseQuotaData("qoder", {
      quotas: {
        user: { total: 300, used: 0, remaining: 300, unit: "credits" },
        addon: {
          total: 300,
          used: 20,
          remaining: 280,
          unit: "credits",
          resetAt: null,
          recurring: false,
          packs: 3,
        },
      },
    });

    const addon = rows.find((q) => q.name.startsWith("Bonus Credits"));
    // Three rewards with three separate 30-day clocks cannot be drawn as three
    // bars (their dates are not readable), so the count rides on the one row.
    expect(addon.name).toBe("Bonus Credits (3 packs)");
    expect(addon.total).toBe(300);
  });

  it("keeps the plain label for a single reward", () => {
    const rows = parseQuotaData("qoder", {
      quotas: {
        user: { total: 300, used: 0, remaining: 300, unit: "credits" },
        addon: { total: 100, used: 0, remaining: 100, unit: "credits", packs: 1 },
      },
    });

    expect(rows.map((q) => q.name)).toEqual(["Personal", "Bonus Credits"]);
  });

  it("drops every empty non-plan bucket (organization and add-on alike)", () => {
    const rows = parseQuotaData("qoder", {
      quotas: {
        user: { total: 0, used: 0, remaining: 0, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0 },
        addon: { total: 0, used: 0, remaining: 0 },
      },
    });

    // A free account still shows its (empty) plan row — but nothing else.
    expect(rows.map((q) => q.name)).toEqual(["Personal"]);
  });
});

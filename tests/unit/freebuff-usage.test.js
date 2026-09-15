import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const SESSION_URL = "https://www.codebuff.com/api/v1/freebuff/session";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PRE_JOIN = {
  status: "none",
  accessTier: "limited",
  rateLimitsByModel: {
    "deepseek/deepseek-v4-flash": {
      limit: 6,
      recentCount: 4.1,
      period: "pacific_day",
      resetTimeZone: "America/Los_Angeles",
      resetAt: "2026-08-06T07:00:00.000Z",
      entitlementBreakdown: { base: 6, referral: 0, streak: 0 },
    },
    "openai/gpt-5.6-luna": {
      limit: 6,
      recentCount: 1,
      period: "pacific_day",
      resetTimeZone: "America/Los_Angeles",
      resetAt: "2026-08-06T07:00:00.000Z",
    },
  },
};

describe("freebuff registry usage flag", () => {
  it("exposes the session endpoint as transport.usage url", () => {
    const cfg = PROVIDERS["freebuff"];
    expect(cfg.usage?.url).toBe(SESSION_URL);
  });

  it("is listed in USAGE_SUPPORTED_PROVIDERS (features.usage)", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("freebuff");
  });
});

describe("getUsageForProvider(freebuff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GETs the session endpoint and normalizes per-model session quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(PRE_JOIN));

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Freebuff (Limited)");
    expect(usage.quotas["deepseek/deepseek-v4-flash"]).toMatchObject({
      used: 4.1,
      total: 6,
      resetAt: "2026-08-06T07:00:00.000Z",
      recurring: true,
      unlimited: false,
      displayName: "DeepSeek V4.1 Flash",
    });
    expect(usage.quotas["openai/gpt-5.6-luna"]).toMatchObject({
      used: 1,
      total: 6,
      displayName: "GPT-5.6 Luna",
    });

    // Quota reads MUST be GET (a POST would claim a session and burn quota).
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(SESSION_URL);
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer tok-1");
  });

  it("folds the active session's own rateLimit into the shared map", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "active",
        accessTier: "full",
        instanceId: "inst-1",
        model: "meta/muse-spark-1.2-contributor",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        rateLimit: {
          limit: 6,
          recentCount: 2.4,
          period: "pacific_day",
          resetAt: "2026-08-06T07:00:00.000Z",
        },
        rateLimitsByModel: {},
      }),
    );

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    expect(usage.plan).toBe("Freebuff");
    expect(usage.quotas["meta/muse-spark-1.2-contributor"]).toMatchObject({
      used: 2.4,
      total: 6,
      displayName: "Muse Spark 1.2",
    });
  });

  it("reports the Freebucks daily pool under each priced model for metered accounts (no rateLimitsByModel)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "none",
        accessTier: "limited",
        rateLimitsByModel: {},
        freebucks: {
          balance: 10,
          daily: { limit: 25, spent: 15, remaining: 10, resetAt: "2026-09-08T07:00:00.000Z" },
          wallet: { balance: 0, monthlyBonus: 0 },
          spend: { limitUsd: 4, resetAt: "2026-09-08T07:00:00.000Z" },
          monthly: { limitUsd: 10, spentUsd: 3.5, remainingUsd: 6.5, resetAt: "2026-10-01T07:00:00.000Z" },
          planId: null,
          prices: { "deepseek/deepseek-v4-flash": 15, "z-ai/glm-5.3-flash": 5 },
        },
      }),
    );

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.quotas["deepseek/deepseek-v4-flash"]).toMatchObject({
      used: 15,
      total: 25,
      resetAt: "2026-09-08T07:00:00.000Z",
      recurring: true,
      unlimited: false,
      price: 15,
      displayName: "DeepSeek V4.1 Flash",
    });
    expect(usage.quotas["z-ai/glm-5.3-flash"]).toMatchObject({
      used: 15,
      total: 25,
      price: 5,
      displayName: "GLM 5.3 Flash",
    });
    // No session pools → only the freebucks-derived rows exist.
    expect(Object.keys(usage.quotas)).toEqual([
      "deepseek/deepseek-v4-flash",
      "z-ai/glm-5.3-flash",
    ]);
    // Account summary rides the response for the card header (server data,
    // nothing hardcoded client-side).
    expect(usage.freebucks).toEqual({
      balance: 10,
      daily: {
        limit: 25,
        spent: 15,
        remaining: 10,
        resetAt: "2026-09-08T07:00:00.000Z",
      },
      wallet: { balance: 0 },
      monthly: { remainingUsd: 6.5, limitUsd: 10, resetAt: "2026-10-01T07:00:00.000Z" },
    });
  });

  it("folds the server's announced priceChanges into the live price (promos expire without a client release)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "none",
        accessTier: "full",
        rateLimitsByModel: {},
        freebucks: {
          balance: 20,
          daily: { limit: 25, spent: 5, remaining: 20, resetAt: "2026-09-08T07:00:00.000Z" },
          wallet: { balance: 0, monthlyBonus: 0 },
          planId: null,
          prices: { "upstage/solar-pro4": 0 },
          priceNotices: { "upstage/solar-pro4": "0 Freebucks · Labor Day weekend (through Sep 7 PT)" },
          priceChanges: [
            {
              at: "2026-01-01T00:00:00.000Z", // already due
              modelId: "upstage/solar-pro4",
              price: 5,
              tagline: "Limited-time trial",
            },
          ],
        },
      }),
    );

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    // The due change is folded in: price 5 + new tagline, schedule emptied.
    expect(usage.quotas["upstage/solar-pro4"]).toMatchObject({
      price: 5,
      priceNote: "Limited-time trial",
      displayName: "Solar Pro 4",
    });
  });

  it("attaches no price to legacy session-quota rows", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(PRE_JOIN));

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    expect(usage.quotas["deepseek/deepseek-v4-flash"].price).toBeUndefined();
    expect(usage.freebucks).toBeUndefined();
  });

  it("surfaces a re-login message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "expired",
    });

    expect(usage.message).toMatch(/expired|re-login/i);
    expect(usage.quotas).toBeUndefined();
  });

  it("surfaces a region message on 403 country_blocked (not a re-login hint)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ status: "country_blocked", countryCode: "XX" }, 403),
    );

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    expect(usage.message).toMatch(/not available in your region/i);
  });

  it("treats 404 (no session row) as pre-join with no quota", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({}, 404));

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    expect(usage.message).toMatch(/no session quota/i);
  });

  it("returns a message when the session response carries no quota map", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ status: "none", accessTier: "full" }));

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    expect(usage.plan).toBe("Freebuff");
    expect(usage.message).toMatch(/no session quota/i);
  });

  it("does not throw when the session fetch fails", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("network down"));

    const usage = await getUsageForProvider({
      provider: "freebuff",
      accessToken: "tok-1",
    });

    expect(usage.message).toMatch(/usage error/i);
  });
});

describe("parseQuotaData(freebuff)", () => {
  it("uses displayName for the row label and keeps modelKey for ordering", () => {
    const rows = parseQuotaData("freebuff", {
      plan: "Freebuff (Limited)",
      quotas: {
        "deepseek/deepseek-v4-flash": {
          used: 4.1,
          total: 6,
          resetAt: "2026-08-06T07:00:00.000Z",
          displayName: "DeepSeek V4.1 Flash",
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "DeepSeek V4.1 Flash",
      modelKey: "deepseek/deepseek-v4-flash",
      used: 4.1,
      total: 6,
    });
  });
});

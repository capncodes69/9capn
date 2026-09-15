import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked before the route is imported: the tracker's spend read, the provider
// usage fetch, and the two DB/proxy lookups the route performs on the way in.
const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProviderSpend: vi.fn(),
  getUsageForProvider: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/usageDb", () => ({ getProviderSpend: mocks.getProviderSpend }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));

import { parseCapnZedUsage, applyCapnZedSpend } from "../../open-sse/services/usage/capnzed.js";
import { CAPNZED_TRIAL_CREDIT_USD } from "../../open-sse/shared/capnzedAuth.js";
import {
  getRemainingPercentage,
  parseQuotaData,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

const trialUser = {
  plan: {
    plan_v3: "zed_pro_trial",
    trial_started_at: "2026-09-10T00:00:00Z",
    usage: { edit_predictions: { used: 3, limit: "unlimited" } },
  },
};

const proUser = {
  plan: {
    plan_v3: "zed_pro",
    subscription_period: { started_at: "2026-09-01T00:00:00Z" },
  },
};

describe("CapnZed trial credit estimate", () => {
  it("adds a USD credit row for a trial account, windowed to the trial end", () => {
    const base = parseCapnZedUsage(trialUser, NOW);
    const enriched = applyCapnZedSpend(base, { costUsd: 1.234, requests: 7 });

    const credit = enriched.quotas["Trial Credit (est.)"];
    expect(credit.used).toBe(1.23);
    expect(credit.total).toBe(CAPNZED_TRIAL_CREDIT_USD);
    expect(credit.unit).toBe("USD");
    // A credit never refills: the UI must say "expires in", not "resets in".
    expect(credit.recurring).toBe(false);
    expect(credit.resetAt).toBe(new Date(base.trialEndsAtMs).toISOString());
    expect(credit.remainingPercentage).toBeCloseTo(75.32, 1);
  });

  it("does not mutate the payload it is given", () => {
    const base = parseCapnZedUsage(trialUser, NOW);
    const before = Object.keys(base.quotas);
    applyCapnZedSpend(base, { costUsd: 2, requests: 2 });

    expect(Object.keys(base.quotas)).toEqual(before);
    expect(base.quotas["Trial Credit (est.)"]).toBeUndefined();
  });

  it("clamps the meter at 0% when the estimate passes the credit", () => {
    const base = parseCapnZedUsage(trialUser, NOW);
    const enriched = applyCapnZedSpend(base, { costUsd: 6.5, requests: 90 });

    expect(enriched.quotas["Trial Credit (est.)"].remainingPercentage).toBe(0);
    expect(enriched.message).toMatch(/past the trial credit/i);
  });

  it("reports spend as text (no bar) on a paid plan, and says nothing at zero spend", () => {
    const pro = applyCapnZedSpend(parseCapnZedUsage(proUser, NOW), {
      costUsd: 12.5,
      requests: 40,
    });

    expect(pro.quotas["Trial Credit (est.)"]).toBeUndefined();
    expect(pro.message).toMatch(/\$12\.50/);
    expect(pro.message).toMatch(/40 requests/);

    const untouched = applyCapnZedSpend(parseCapnZedUsage(proUser, NOW), {
      costUsd: 0,
      requests: 0,
    });
    expect(untouched.message).not.toMatch(/Local estimate/);
  });

  it("always labels the number as a local estimate", () => {
    const enriched = applyCapnZedSpend(parseCapnZedUsage(trialUser, NOW), {
      costUsd: 0.5,
      requests: 1,
    });
    expect(enriched.message).toMatch(/Local estimate/);
    expect(enriched.message).toMatch(/Zed's own meter decides/);
  });

  it("passes an error payload through untouched", () => {
    const errorPayload = { message: "CapnZed authentication failed." };
    expect(applyCapnZedSpend(errorPayload, { costUsd: 1, requests: 1 })).toBe(errorPayload);
    expect(applyCapnZedSpend(null, { costUsd: 1, requests: 1 })).toBe(null);
  });

  it("tolerates a missing spend snapshot", () => {
    const base = parseCapnZedUsage(trialUser, NOW);
    const enriched = applyCapnZedSpend(base, null);
    expect(enriched.quotas["Trial Credit (est.)"]).toBeUndefined();
    expect(enriched.message).toBe(base.message);
  });
});

describe("CapnZed stays parseable by the dashboard tracker", () => {
  it("keeps unit / remainingPercentage / recurring on normalized rows", () => {
    const enriched = applyCapnZedSpend(parseCapnZedUsage(trialUser, NOW), {
      costUsd: 1.25,
      requests: 4,
    });
    const rows = parseQuotaData("capnzed", enriched);

    const credit = rows.find((row) => row.name === "Trial Credit (est.)");
    expect(credit).toBeDefined();
    // Without the explicit capnzed case the generic fallback would drop unit and
    // remainingPercentage, and the dollar row would render as a request count.
    expect(credit.unit).toBe("USD");
    expect(credit.remainingPercentage).toBeCloseTo(75, 1);
    expect(credit.recurring).toBe(false);

    const window = rows.find((row) => row.name === "Trial Window");
    expect(window).toBeDefined();
    expect(window.total).toBe(14);
  });

  it("drives the tracker's own percentage math", () => {
    const enriched = applyCapnZedSpend(parseCapnZedUsage(trialUser, NOW), {
      costUsd: 1.25,
      requests: 4,
    });
    const credit = parseQuotaData("capnzed", enriched).find(
      (row) => row.name === "Trial Credit (est.)",
    );

    // $1.25 of $5 spent → 75% of the credit still available.
    expect(getRemainingPercentage(credit)).toBe(75);
  });
});

describe("usage route attaches the local spend to CapnZed only", () => {
  const callRoute = async (connectionId = "conn-1") => {
    const { GET } = await import("@/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request(`http://localhost/api/usage/${connectionId}`), {
      params: Promise.resolve({ connectionId }),
    });
    return response.json();
  };

  const capnzedConnection = {
    id: "conn-1",
    provider: "capnzed",
    authType: "oauth",
    accessToken: "token",
    providerSpecificData: { userId: "user-1", organizationId: "org-1" },
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.getProviderSpend.mockResolvedValue({ costUsd: 2.5, requests: 10, firstAt: null, lastAt: null });
  });

  it("sums this connection's spend since the trial started", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(capnzedConnection);
    mocks.getUsageForProvider.mockResolvedValue(parseCapnZedUsage(trialUser, NOW));

    const body = await callRoute();

    expect(mocks.getProviderSpend).toHaveBeenCalledTimes(1);
    const filter = mocks.getProviderSpend.mock.calls[0][0];
    expect(filter.provider).toBe("capnzed");
    expect(filter.connectionId).toBe("conn-1");
    expect(filter.since.toISOString()).toBe("2026-09-10T00:00:00.000Z");

    expect(body.quotas["Trial Credit (est.)"].used).toBe(2.5);
    expect(body.quotas["Trial Credit (est.)"].total).toBe(CAPNZED_TRIAL_CREDIT_USD);
  });

  it("falls back to the subscription period when there is no trial start", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(capnzedConnection);
    mocks.getUsageForProvider.mockResolvedValue(parseCapnZedUsage(proUser, NOW));

    await callRoute();

    expect(mocks.getProviderSpend.mock.calls[0][0].since.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("leaves other providers alone", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ ...capnzedConnection, provider: "claude" });
    mocks.getUsageForProvider.mockResolvedValue({
      plan: "Claude Pro",
      quotas: { session: { used: 1, total: 2 } },
    });

    const body = await callRoute();

    expect(mocks.getProviderSpend).not.toHaveBeenCalled();
    expect(body.quotas.session).toBeDefined();
  });
});

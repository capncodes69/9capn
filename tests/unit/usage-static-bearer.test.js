// The usage endpoint must accept every static bearer a provider can meter:
// apikey / api_key (whitelisted providers) and the raw access_token shape a
// pasted JWT produces — CodeBuddy CN connections arrive as access_token with no
// refresh pair, so the gate must not answer "Usage not available".
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/usageDb", () => ({
  getProviderSpend: vi.fn(async () => ({ requests: 0 })),
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));
vi.mock("open-sse/services/usage/capnzed.js", () => ({ applyCapnZedSpend: (u) => u }));
vi.mock("open-sse/services/usage/camber.js", () => ({ applyCamberMessageCount: (u) => u }));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ needsRefresh: () => false })),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");

const UNAVAILABLE = "Usage not available for this connection";

async function fetchUsage(connection) {
  mocks.getProviderConnectionById.mockResolvedValue(connection);
  mocks.getUsageForProvider.mockResolvedValue({ plan: "ok", quotas: {} });
  const res = await GET(new Request("http://localhost/api/usage/x"), {
    params: { connectionId: connection.id },
  });
  return res.json();
}

beforeEach(() => vi.clearAllMocks());

describe("usage endpoint authType gate", () => {
  it("meters an access_token connection on a usageApikey provider (CodeBuddy CN)", async () => {
    const body = await fetchUsage({
      id: "cb-1",
      provider: "codebuddy-cn",
      authType: "access_token",
      accessToken: "eyJ.fake",
      providerSpecificData: {},
    });

    expect(body).not.toEqual({ message: UNAVAILABLE });
    expect(mocks.getUsageForProvider).toHaveBeenCalledOnce();
    expect(body.plan).toBe("ok");
  });

  it("still refuses an access_token provider that cannot meter a static bearer (codex)", async () => {
    const body = await fetchUsage({
      id: "cx-1",
      provider: "codex",
      authType: "access_token",
      accessToken: "eyJ.fake",
      providerSpecificData: {},
    });

    expect(body).toEqual({ message: UNAVAILABLE });
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });

  it("keeps apikey and oauth connections working", async () => {
    await fetchUsage({
      id: "glm-1",
      provider: "glm",
      authType: "apikey",
      apiKey: "k",
      providerSpecificData: {},
    });
    await fetchUsage({
      id: "cb-2",
      provider: "codebuddy-cn",
      authType: "oauth",
      accessToken: "t",
      providerSpecificData: {},
    });

    expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(2);
  });

  it("refuses other auth kinds on a usageApikey provider (cookie)", async () => {
    const body = await fetchUsage({
      id: "cb-3",
      provider: "codebuddy-cn",
      authType: "cookie",
      providerSpecificData: {},
    });

    expect(body).toEqual({ message: UNAVAILABLE });
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });
});

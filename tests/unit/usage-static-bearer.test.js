// A connection can hold a raw bearer with no refresh pair under three authTypes:
// "apikey", "api_key" (Kiro's headless flow) and "access_token" (a pasted token —
// the Codex import-token route is the one writer today). Providers that meter an
// API key (`features.usageApikey`) meter all three identically, because their
// usage handlers read `c.accessToken || c.apiKey`.
//
// Two separate gates decide what a user sees, and they have to agree:
//   /api/providers/client      decides whether the dashboard SHOWS a quota card
//   /api/usage/[connectionId]  decides whether the card can actually LOAD
// When only one of them learned about "access_token", the UI either hid a working
// card or advertised one that answered "Usage not available".
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  getUsageForProvider: vi.fn(),
  getProviderConnections: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: mocks.getProviderConnections,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));

vi.mock("@/shared/constants/providers", () => ({
  USAGE_SUPPORTED_PROVIDERS: ["codebuddy-intl", "kiro", "glm", "codex"],
  // Providers whose registry entry sets features.usageApikey.
  USAGE_APIKEY_PROVIDERS: ["codebuddy-intl", "kiro", "glm"],
}));

function connection(overrides = {}) {
  return {
    id: "conn-1",
    provider: "codebuddy-intl",
    authType: "apikey",
    accessToken: null,
    apiKey: "sk-test",
    refreshToken: null,
    providerSpecificData: {},
    ...overrides,
  };
}

async function callUsageRoute(conn) {
  mocks.getProviderConnectionById.mockResolvedValue(conn);
  const { GET } = await import("@/app/api/usage/[connectionId]/route.js");
  const request = new Request("https://9router.local/api/usage/conn-1");
  const response = await GET(request, { params: Promise.resolve({ connectionId: "conn-1" }) });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.refreshAndUpdateCredentials.mockImplementation(async (c) => ({ connection: c }));
  mocks.getUsageForProvider.mockResolvedValue({ quotas: { Monthly: { used: 1, total: 10 } } });
});

describe("/api/usage/[connectionId] accepts every static-bearer authType", () => {
  it("serves usage for an access_token connection on a usageApikey provider", async () => {
    const { status, body } = await callUsageRoute(connection({
      authType: "access_token",
      accessToken: "pasted.jwt.token",
      apiKey: null,
    }));
    expect(status).toBe(200);
    expect(body).toHaveProperty("quotas");
    // The handler must receive the connection; before the fix this answered
    // "Usage not available for this connection".
    expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  it("still serves usage for apikey and api_key", async () => {
    for (const authType of ["apikey", "api_key"]) {
      vi.clearAllMocks();
      mocks.getUsageForProvider.mockResolvedValue({ quotas: {} });
      const { status } = await callUsageRoute(connection({ authType }));
      expect(status, authType).toBe(200);
    }
  });

  it("does NOT refresh an access_token connection", async () => {
    // There is no refresh pair; entering the OAuth branch would either throw or
    // overwrite the pasted token with nothing.
    await callUsageRoute(connection({ authType: "access_token", accessToken: "t", apiKey: null }));
    expect(mocks.refreshAndUpdateCredentials).not.toHaveBeenCalled();
  });

  it("treats access_token as a static bearer, not as oauth", async () => {
    // The distinction that matters: a pasted token must not enter the OAuth
    // refresh branch. With no refresh pair that branch can only fail or blank the
    // credential. `isOAuth` is a literal comparison against "oauth", so an
    // access_token row skips it and reaches the handler directly.
    const { status } = await callUsageRoute(connection({
      authType: "access_token", accessToken: "pasted.jwt", apiKey: null, refreshToken: null,
    }));
    expect(status).toBe(200);
    expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(1);
    const passed = mocks.getUsageForProvider.mock.calls[0][0];
    expect(passed.authType).toBe("access_token");
    expect(passed.accessToken).toBe("pasted.jwt");
  });

  it("refuses access_token on a provider that does not meter an API key", async () => {
    const { status, body } = await callUsageRoute(connection({
      provider: "codex", authType: "access_token", accessToken: "t", apiKey: null,
    }));
    // codex has features.usage only, not usageApikey — its quota comes from the
    // OAuth path, so a pasted token is out of scope here.
    expect(body.message).toBe("Usage not available for this connection");
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });
});

describe("/api/providers/client agrees with the usage route", () => {
  // The dashboard reads this to decide whether to render a quota card.
  async function isEligible(conn) {
    const mod = await import("@/app/api/providers/client/route.js");
    return mod.isUsageEligible(conn);
  }

  it("marks an access_token connection on a usageApikey provider eligible", async () => {
    expect(await isEligible(connection({
      authType: "access_token", accessToken: "t", apiKey: null,
    }))).toBe(true);
  });

  it("marks the same shapes ineligible that the usage route refuses", async () => {
    // codex + access_token: the usage route refuses it, so the card must not show.
    expect(await isEligible(connection({
      provider: "codex", authType: "access_token", accessToken: "t", apiKey: null,
    }))).toBe(false);
  });

  it("keeps an oauth connection eligible regardless of provider list", async () => {
    expect(await isEligible(connection({
      provider: "codex", authType: "oauth", accessToken: "t", apiKey: null,
    }))).toBe(true);
  });
});

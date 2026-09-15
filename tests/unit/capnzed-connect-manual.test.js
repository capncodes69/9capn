/**
 * Regression: connecting a CapnZed account by pasting the callback URL.
 *
 * The RSA native-app callback is a 127.0.0.1 URL, so it can only be consumed
 * automatically when 9router runs on the same machine as the browser. Over a
 * remote deployment (Fly) the paste box is the ONLY way to connect — and it used
 * to be impossible: /exchange fell through to the generic path, which requires a
 * redirectUri/codeVerifier the caller never has, and answered
 * "Missing required fields" for every paste.
 *
 * These tests pin the contract:
 *   - the RSA private key is resolved from the session registered by
 *     /register-session, so a paste needs nothing but state + callback URL
 *   - a caller-supplied codeVerifier still wins (covers an evicted session)
 *   - a missing/unknown session fails with an actionable message, not a 500
 *   - a successful paste clears the session and stops the callback listener
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(async () => ({
    accessToken: "zed-access-token",
    refreshToken: null,
    expiresIn: null,
    displayName: "octocat",
    providerSpecificData: { authMethod: "oauth", userId: "u-1", systemId: "sys-1" },
  })),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async (d) => ({ id: "conn-1", ...d })),
}));

vi.mock("open-sse/shared/mimoAccount.js", () => ({
  readDesktopPassToken: vi.fn(async () => null),
}));

vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));

// Single-slot Zed session store, mirroring src/lib/oauth/utils/server.js.
const zedSession = { current: null };
const proxyCalls = { stopped: 0 };

vi.mock("@/lib/oauth/utils/server", () => {
  const notUsed = () => { throw new Error("unexpected helper"); };
  const noop = () => {};
  return {
    startCodexProxy: notUsed, stopCodexProxy: noop, registerCodexSession: noop,
    getCodexSessionStatus: () => null, clearCodexSession: noop,
    startXaiProxy: notUsed, stopXaiProxy: noop, registerXaiSession: noop,
    getXaiSessionStatus: () => null, clearXaiSession: noop,
    startTraeProxy: notUsed, stopTraeProxy: noop, registerTraeSession: noop,
    getTraeSessionStatus: () => null, clearTraeSession: noop,
    startWindsurfProxy: notUsed, stopWindsurfProxy: noop, registerWindsurfSession: noop,
    getWindsurfSessionStatus: () => null, clearWindsurfSession: noop,
    startZedProxy: notUsed,
    stopZedProxy: () => { proxyCalls.stopped += 1; },
    registerZedSession: ({ state, codeVerifier, provider }) => {
      if (!state || !codeVerifier) return false;
      zedSession.current = { state, codeVerifier, provider, status: "pending" };
      return true;
    },
    getZedSessionStatus: (state, provider) => {
      const s = zedSession.current;
      if (!s) return null;
      if (state && s.state !== state) return null;
      if (provider && s.provider && s.provider !== provider) return null;
      return s;
    },
    clearZedSession: (state) => {
      if (!state || zedSession.current?.state === state) zedSession.current = null;
    },
    startXiaomiMimoProxy: notUsed, stopXiaomiMimoProxy: noop, registerXiaomiMimoSession: noop,
    getXiaomiMimoSessionStatus: () => null, clearXiaomiMimoSession: noop,
  };
});

const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
const { exchangeTokens } = await import("@/lib/oauth/providers");
const { createProviderConnection } = await import("@/models");

const registerSession = (state, codeVerifier) =>
  POST(
    new Request("http://localhost/api/oauth/capnzed/register-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, codeVerifier }),
    }),
    { params: Promise.resolve({ provider: "capnzed", action: "register-session" }) },
  );

const exchange = (body) =>
  POST(
    new Request("http://localhost/api/oauth/capnzed/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider: "capnzed", action: "exchange" }) },
  );

const CALLBACK = "http://127.0.0.1:12345/?user_id=u-1&access_token=encrypted-blob";

beforeEach(() => {
  zedSession.current = null;
  proxyCalls.stopped = 0;
  vi.clearAllMocks();
});

describe("CapnZed manual callback exchange", () => {
  it("exchanges a pasted callback URL using the session's RSA key", async () => {
    await registerSession("state-1", "capnzed-rsa-pkcs1:PRIVATEKEY");

    const res = await exchange({ code: CALLBACK, state: "state-1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.connection).toMatchObject({ id: "conn-1", provider: "capnzed" });

    // The key came from the session, not from the request body.
    expect(exchangeTokens).toHaveBeenCalledWith("capnzed", CALLBACK, null, "capnzed-rsa-pkcs1:PRIVATEKEY", "state-1");
    expect(createProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "capnzed", authType: "oauth", expiresAt: null }),
    );
  });

  it("prefers a codeVerifier supplied by the caller (evicted session)", async () => {
    const res = await exchange({
      code: CALLBACK,
      state: "state-2",
      codeVerifier: "capnzed-rsa-pkcs1:FROMBODY",
    });

    expect(res.status).toBe(200);
    expect(exchangeTokens).toHaveBeenCalledWith("capnzed", CALLBACK, null, "capnzed-rsa-pkcs1:FROMBODY", "state-2");
  });

  it("clears the session + stops the listener once the paste succeeds", async () => {
    await registerSession("state-3", "capnzed-rsa-pkcs1:PRIVATEKEY");

    await exchange({ code: CALLBACK, state: "state-3" });

    expect(zedSession.current).toBeNull();
    expect(proxyCalls.stopped).toBe(1);
  });

  it("answers 400 with an actionable message when the session is gone", async () => {
    const res = await exchange({ code: CALLBACK, state: "state-unknown" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/restart the login flow/i);
    expect(exchangeTokens).not.toHaveBeenCalled();
  });

  it("requires a state — without it the RSA key cannot be found", async () => {
    const res = await exchange({ code: CALLBACK });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing state/i);
  });

  it("requires the callback URL itself", async () => {
    await registerSession("state-4", "capnzed-rsa-pkcs1:PRIVATEKEY");

    const res = await exchange({ state: "state-4" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing callback url/i);
  });

  it("surfaces an exchange failure as a 500 instead of a fake success", async () => {
    await registerSession("state-5", "capnzed-rsa-pkcs1:PRIVATEKEY");
    exchangeTokens.mockRejectedValueOnce(new Error("Failed to decrypt CapnZed access token: bad padding"));

    const res = await exchange({ code: CALLBACK, state: "state-5" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to decrypt/i);
    expect(createProviderConnection).not.toHaveBeenCalled();
  });
});

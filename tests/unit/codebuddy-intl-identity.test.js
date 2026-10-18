// CodeBuddy intl identity: the profile lookup that fills an email in, and the
// dedup guard that stops a re-import from creating a second row for one account.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalDataDir = process.env.DATA_DIR;
let tmpDir;
let db;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A JWT-shaped string. Only the payload is ever read. */
function makeJwt(payload) {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cbai-"));
  process.env.DATA_DIR = tmpDir;
  // The adapter is cached on `global._dbAdapter` and survives `vi.resetModules()`,
  // so each test would otherwise read the previous test's rows out of the
  // previous temp dir.
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
  delete global._dbAdapter;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// ── mapTokens: identity comes off the token ────────────────────────────────

describe("codebuddy-intl mapTokens", () => {
  it("reads email, username and sub off the access token", async () => {
    const { default: intl } = await import("@/lib/oauth/providers/codebuddy-intl.js");
    const mapped = intl.mapTokens({
      access_token: makeJwt({ sub: "u-1", email: "nova@example.com", preferred_username: "nova" }),
      refresh_token: "",
      expires_in: 3600,
    });
    expect(mapped.email).toBe("nova@example.com");
    expect(mapped.name).toBe("nova");
    expect(mapped.providerSpecificData.userId).toBe("u-1");
    expect(mapped.providerSpecificData.username).toBe("nova");
  });

  it("falls back to a synthetic email from sub so dedup stays possible", async () => {
    const { default: intl } = await import("@/lib/oauth/providers/codebuddy-intl.js");
    const mapped = intl.mapTokens({
      access_token: makeJwt({ sub: "u-no-email" }),
      refresh_token: "",
      expires_in: 3600,
    });
    // Without a non-empty email the DB layer cannot dedup at all, so a synthetic
    // one keyed on the stable account id is the fallback.
    expect(mapped.email).toBe("cb-u-no-email");
    expect(mapped.name).toBe("cb-u-no-ema"); // "cb-" + first 8 chars of the sub
  });

  it("prefers token claims over the profile lookup", async () => {
    const { default: intl } = await import("@/lib/oauth/providers/codebuddy-intl.js");
    const mapped = intl.mapTokens({
      access_token: makeJwt({ sub: "u-2", email: "token@example.com", preferred_username: "tokuser" }),
      refresh_token: "",
      expires_in: 3600,
      _profile: { email: "profile@example.com", username: "profileuser", displayName: "Profile Name" },
    });
    expect(mapped.email).toBe("token@example.com");
    expect(mapped.providerSpecificData.username).toBe("tokuser");
    // The profile only contributes what the token omitted.
    expect(mapped.displayName).toBe("Profile Name");
  });

  it("uses the profile when the token carries no identity", async () => {
    const { default: intl } = await import("@/lib/oauth/providers/codebuddy-intl.js");
    const mapped = intl.mapTokens({
      access_token: "opaque-not-a-jwt",
      refresh_token: "",
      expires_in: 3600,
      _profile: { email: "from-profile@example.com", username: "puser", userId: "p-1" },
    });
    expect(mapped.email).toBe("from-profile@example.com");
    expect(mapped.providerSpecificData.userId).toBe("p-1");
  });
});

// ── pollToken: profile lookup is best-effort ───────────────────────────────

describe("codebuddy-intl pollToken profile lookup", () => {
  const config = {
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    userAgent: "IDE/test",
  };

  it("attaches the profile when the gateway answers it", async () => {
    const { default: intl } = await import("@/lib/oauth/providers/codebuddy-intl.js");
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v2/plugin/auth/token")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { accessToken: makeJwt({ sub: "u-3", email: "three@example.com" }), refreshToken: "rt" },
        }), { status: 200 });
      }
      if (String(url).includes("/v2/plugin/auth/user")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { email: "three@example.com", nickname: "Three", organizationId: "org-1" },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await intl.pollToken(config, "state-1", null, {});
    expect(result.ok).toBe(true);
    expect(result.data._profile.email).toBe("three@example.com");
    expect(result.data._profile.organizationId).toBe("org-1");

    const mapped = intl.mapTokens(result.data);
    expect(mapped.providerSpecificData.organizationId).toBe("org-1");
  });

  it("still logs in when the profile lookup fails", async () => {
    const { default: intl } = await import("@/lib/oauth/providers/codebuddy-intl.js");
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("/v2/plugin/auth/token")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { accessToken: makeJwt({ sub: "u-4", email: "four@example.com" }), refreshToken: "rt" },
        }), { status: 200 });
      }
      // Profile endpoint down, malformed, or gated — none of it may block login.
      return new Response("nope", { status: 500 });
    }));

    const result = await intl.pollToken(config, "state-2", null, {});
    expect(result.ok).toBe(true);
    expect(intl.mapTokens(result.data).email).toBe("four@example.com");
  });

  it("does not throw when the profile request itself rejects", async () => {
    const { default: intl } = await import("@/lib/oauth/providers/codebuddy-intl.js");
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("/v2/plugin/auth/token")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { accessToken: makeJwt({ sub: "u-5" }), refreshToken: "rt" },
        }), { status: 200 });
      }
      throw new Error("ECONNRESET");
    }));

    const result = await intl.pollToken(config, "state-3", null, {});
    expect(result.ok).toBe(true);
  });
});

// ── The dedup guard ────────────────────────────────────────────────────────

describe("createProviderConnection dedup for CodeBuddy", () => {
  it("collapses a re-login of the same account onto the existing row", async () => {
    const first = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ sub: "same-user", email: "same@example.com", preferred_username: "same" }),
      refreshToken: "rt-1",
      email: "same@example.com",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const second = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ sub: "same-user", email: "same@example.com", preferred_username: "same", iat: 999 }),
      refreshToken: "rt-2",
      email: "same@example.com",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    expect(second.id).toBe(first.id);
    const rows = await db.getProviderConnections({ provider: "codebuddy-intl" });
    expect(rows).toHaveLength(1);
    // The newer credential is what gets kept.
    expect(rows[0].refreshToken).toBe("rt-2");
  });

  it("collapses a re-login that carries no email, using the token's sub", async () => {
    // The device flow returns no profile object, so this is the common shape.
    const token = makeJwt({ sub: "no-email-user", preferred_username: "silent" });
    const first = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: token,
      refreshToken: "rt-a",
    });
    const second = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: token,
      refreshToken: "rt-b",
    });

    expect(second.id).toBe(first.id);
    expect(await db.getProviderConnections({ provider: "codebuddy-intl" })).toHaveLength(1);
  });

  it("keeps two genuinely different accounts apart", async () => {
    await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ sub: "user-a", email: "a@example.com", preferred_username: "alpha" }),
      refreshToken: "rt",
      email: "a@example.com",
    });
    await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ sub: "user-b", email: "b@example.com", preferred_username: "beta" }),
      refreshToken: "rt",
      email: "b@example.com",
    });
    expect(await db.getProviderConnections({ provider: "codebuddy-intl" })).toHaveLength(2);
  });

  it("treats the same JWT pasted as an API key as the same account", async () => {
    // A row can hold the token in `apiKey` (API-key mode) or `accessToken`
    // (device flow). Both are the same account and must not stack.
    const token = makeJwt({ sub: "dual-path", email: "dual@example.com", preferred_username: "dual" });
    const viaOauth = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: token,
      refreshToken: "rt",
      email: "dual@example.com",
    });
    const viaApiKey = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "apikey",
      apiKey: token,
      name: "dual@example.com",
      email: "dual@example.com",
    });

    expect(viaApiKey.id).toBe(viaOauth.id);
    expect(await db.getProviderConnections({ provider: "codebuddy-intl" })).toHaveLength(1);
  });

  it("does not dedup across the cn and intl providers", async () => {
    // One Keycloak realm, but separate providers with separate credentials.
    await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ sub: "shared-id", email: "shared@example.com" }),
      refreshToken: "rt",
      email: "shared@example.com",
    });
    await db.createProviderConnection({
      provider: "codebuddy-cn",
      authType: "oauth",
      accessToken: makeJwt({ sub: "shared-id", email: "shared@example.com" }),
      refreshToken: "rt",
      email: "shared@example.com",
    });
    expect(await db.getProviderConnections({ provider: "codebuddy-intl" })).toHaveLength(1);
    expect(await db.getProviderConnections({ provider: "codebuddy-cn" })).toHaveLength(1);
  });

  it("does not merge a row it cannot identify", async () => {
    // An opaque token with no sub and no email proves nothing; two such rows
    // must stay separate rather than one silently overwriting the other.
    await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: "opaque-1",
      refreshToken: "rt",
    });
    await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: "opaque-2",
      refreshToken: "rt",
    });
    expect(await db.getProviderConnections({ provider: "codebuddy-intl" })).toHaveLength(2);
  });

  it("names the connection from the token rather than 'Account N'", async () => {
    const created = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ sub: "named-user", email: "named@example.com", preferred_username: "named" }),
      refreshToken: "rt",
      email: "named@example.com",
    });
    expect(created.name).toBe("named");
  });
});

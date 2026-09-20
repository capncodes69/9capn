// CodeBuddy and Qoder both answer a login with an opaque credential and no
// profile object, so the same account used to be addable twice — once per
// session — stacking "Account N" / "Key N" rows. These tests pin the three
// places that identity is recovered:
//   * `mapTokens` reads it off the CodeBuddy JWT / the Qoder userinfo
//   * `createProviderConnection` matches an incoming row against it
//   * `POST /api/providers` exchanges a pasted Qoder PAT to learn it
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

function makeJwt(payload) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signature`;
}

describe("CodeBuddy + Qoder connection identity", () => {
  let tempDir;
  let db;
  let cleanupRoute = () => {};

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-identity-"));
    process.env.DATA_DIR = tempDir;
    // The adapter is cached on `global._dbAdapter` and survives
    // `vi.resetModules()`, so each test would otherwise read the previous
    // test's rows out of the previous temp dir.
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterEach(() => {
    cleanupRoute();
    cleanupRoute = () => {};
    vi.doUnmock("next/server");
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  // ── CodeBuddy ──────────────────────────────────────────────────────────

  it("collapses a CodeBuddy re-login onto the existing row and names it from the token", async () => {
    const first = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ sub: "cb-user-1", email: "nova@example.com", preferred_username: "nova" }),
      refreshToken: "rt-1",
      name: "Account 1",
    });

    const second = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      // Same identity, fresh grant — the only difference is the new `iat`.
      accessToken: makeJwt({ sub: "cb-user-1", email: "nova@example.com", preferred_username: "nova", iat: 2000 }),
      refreshToken: "rt-1-rotated",
      name: "Account 2",
    });

    expect(second.id).toBe(first.id);            // one row, not two
    expect(second.name).toBe("nova");            // name came from the token
    expect(second.accessToken).not.toBe(first.accessToken); // but the token is fresh
    const rows = await db.getProviderConnections({ provider: "codebuddy-intl" });
    expect(rows).toHaveLength(1);
  });

  it("matches CodeBuddy on the token email when the token carries no sub", async () => {
    await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ email: "nosub@example.com", preferred_username: "nosub" }),
      name: "Account 1",
    });
    const again = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ email: "nosub@example.com", preferred_username: "nosub" }),
      name: "Account 2",
    });

    expect(again.name).toBe("nosub");
    expect(await db.getProviderConnections({ provider: "codebuddy-intl" })).toHaveLength(1);
  });

  it("still keeps two different CodeBuddy identities apart", async () => {
    await db.createProviderConnection({
      provider: "codebuddy-intl", authType: "oauth",
      accessToken: makeJwt({ sub: "cb-a", email: "a@example.com", preferred_username: "alpha" }),
      name: "Account 1",
    });
    await db.createProviderConnection({
      provider: "codebuddy-intl", authType: "oauth",
      accessToken: makeJwt({ sub: "cb-b", email: "b@example.com", preferred_username: "beta" }),
      name: "Account 2",
    });

    const rows = await db.getProviderConnections({ provider: "codebuddy-intl" });
    expect(rows.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("applies the same rule to codebuddy-cn", async () => {
    const token = makeJwt({ sub: "cn-1", preferred_username: "cn-nova" });
    const first = await db.createProviderConnection({
      provider: "codebuddy-cn", authType: "oauth", accessToken: token, name: "Account 1",
    });
    const second = await db.createProviderConnection({
      provider: "codebuddy-cn", authType: "oauth", accessToken: token, name: "Account 2",
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("cn-nova");
    expect(await db.getProviderConnections({ provider: "codebuddy-cn" })).toHaveLength(1);
  });

  it("dedups a CodeBuddy JWT pasted as the API key, not just a device-flow token", async () => {
    // The executor sends `apiKey` as the bearer, so the token reaches the repo
    // in that field when the row was added from the API-key form.
    const token = makeJwt({ sub: "cb-apikey", preferred_username: "apikey-nova" });
    const first = await db.createProviderConnection({
      provider: "codebuddy-intl", authType: "apikey", apiKey: token, name: "Account 1",
    });
    const second = await db.createProviderConnection({
      provider: "codebuddy-intl", authType: "apikey", apiKey: token, name: "Account 2",
    });
    // The device-flow row and the API-key row for one identity must also agree,
    // which is why the branch does not filter on authType.
    const viaOAuth = await db.createProviderConnection({
      provider: "codebuddy-intl", authType: "oauth",
      accessToken: makeJwt({ sub: "cb-apikey", preferred_username: "apikey-nova", iat: 7 }),
      name: "Account 3",
    });

    expect(second.id).toBe(first.id);
    expect(viaOAuth.id).toBe(first.id);
    expect(await db.getProviderConnections({ provider: "codebuddy-intl" })).toHaveLength(1);
  });

  // ── Qoder ──────────────────────────────────────────────────────────────

  it("updates one row when the same Qoder PAT is added twice", async () => {
    const first = await db.createProviderConnection({
      provider: "qoder", authType: "apikey", name: "Key 1",
      apiKey: "pt-same-key", email: "q@example.com",
      providerSpecificData: { userId: "q-user-1", email: "q@example.com" },
    });
    const second = await db.createProviderConnection({
      provider: "qoder", authType: "apikey", name: "Key 2",
      apiKey: "pt-same-key", email: "q@example.com",
      providerSpecificData: { userId: "q-user-1", email: "q@example.com" },
    });

    expect(second.id).toBe(first.id);
    expect(await db.getProviderConnections({ provider: "qoder" })).toHaveLength(1);
  });

  it("updates the existing Qoder row when the PAT was rotated but the userId is known", async () => {
    const first = await db.createProviderConnection({
      provider: "qoder", authType: "apikey", name: "Key 1",
      apiKey: "pt-old-key", email: "rot@example.com",
      providerSpecificData: { userId: "q-user-2", email: "rot@example.com" },
    });
    const second = await db.createProviderConnection({
      provider: "qoder", authType: "apikey", name: "Key 2",
      apiKey: "pt-rotated-key", email: "rot@example.com",
      providerSpecificData: { userId: "q-user-2", email: "rot@example.com" },
    });

    expect(second.id).toBe(first.id);
    expect(second.apiKey).toBe("pt-rotated-key");
    expect(await db.getProviderConnections({ provider: "qoder" })).toHaveLength(1);
  });

  it("keeps distinct Qoder identities apart", async () => {
    await db.createProviderConnection({
      provider: "qoder", authType: "apikey", name: "Key 1", apiKey: "pt-one",
      providerSpecificData: { userId: "q-1", email: "one@example.com" },
    });
    await db.createProviderConnection({
      provider: "qoder", authType: "apikey", name: "Key 2", apiKey: "pt-two",
      providerSpecificData: { userId: "q-2", email: "two@example.com" },
    });

    expect(await db.getProviderConnections({ provider: "qoder" })).toHaveLength(2);
  });

  it("names a nameless row from the credential instead of falling back to \"Account N\"", async () => {
    const codebuddy = await db.createProviderConnection({
      provider: "codebuddy-intl", authType: "oauth",
      accessToken: makeJwt({ sub: "cb-n", preferred_username: "nameless" }),
    });
    const qoder = await db.createProviderConnection({
      provider: "qoder", authType: "oauth",
      accessToken: "dt-nameless",
      providerSpecificData: { email: "via-psd@example.com" },
    });

    expect(codebuddy.name).toBe("nameless");
    expect(qoder.name).toBe("via-psd@example.com");
  });

  // ── mapTokens identity extraction ──────────────────────────────────────

  it("mapTokens pulls the CodeBuddy identity out of the JWT", async () => {
    const { default: codebuddyIntl } = await import("@/lib/oauth/providers/codebuddy-intl.js");
    const { default: codebuddyCn } = await import("@/lib/oauth/providers/codebuddy-cn.js");
    const tokens = {
      access_token: makeJwt({ sub: "u-9", email: "nine@example.com", preferred_username: "nine" }),
      refresh_token: "rt",
    };

    const intl = codebuddyIntl.mapTokens(tokens);
    expect(intl.email).toBe("nine@example.com");
    expect(intl.name).toBe("nine");
    expect(intl.providerSpecificData).toEqual({ userId: "u-9", username: "nine" });

    const cn = codebuddyCn.mapTokens({ access_token: makeJwt({ sub: "u-9" }), refresh_token: "" });
    expect(cn.email).toBe("cb-cn-u-9");   // synthetic fallback keeps dedup possible
    expect(cn.name).toBe("cb-cn-u-9");
  });

  it("mapTokens falls back to a synthetic Qoder identity and always fills `name`", async () => {
    const { default: qoder } = await import("@/lib/oauth/providers/qoder.js");

    const withProfile = qoder.mapTokens({
      access_token: "dt-1", refresh_token: "rt", expires_in: 3600,
      _qoderUserId: "q-user-9", _qoderName: "Nine", _qoderEmail: "nine@example.com",
    });
    expect(withProfile.name).toBe("Nine");
    expect(withProfile.displayName).toBe("Nine");
    expect(withProfile.providerSpecificData.email).toBe("nine@example.com");

    const noProfile = qoder.mapTokens({
      access_token: "dt-2", expires_in: 3600, _qoderUserId: "q-user-10",
    });
    expect(noProfile.email).toBe("qoder-user-q-user-10");
    expect(noProfile.name).toBe("qoder-q-user-1"); // first 8 chars of the userId, never null
    expect(noProfile.providerSpecificData.userId).toBe("q-user-10");
  });

  // ── POST /api/providers resolves a pasted Qoder PAT ────────────────────

  function postProvider(body) {
    return new Request("https://9router.local/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("resolves email and name from the exchange + userinfo when a Qoder PAT is added", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "jt-abc" }), { status: 200 });
      }
      if (String(url).includes("/userinfo")) {
        return new Response(JSON.stringify({ id: "q-resolved", email: "resolved@example.com", name: "resolved-name" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    cleanupRoute = () => vi.unstubAllGlobals();

    const { POST } = await import("@/app/api/providers/route.js");
    const response = await POST(postProvider({
      provider: "qoder", apiKey: "pt-pasted", name: "Key 1",
    }));
    const { connection } = await response.json();

    expect(response.status).toBe(201);
    expect(connection.name).toBe("resolved-name");
    expect(connection.email).toBe("resolved@example.com");
    expect(connection.providerSpecificData.userId).toBe("q-resolved");

    const rows = await db.getProviderConnections({ provider: "qoder" });
    expect(rows).toHaveLength(1);
    const again = await POST(postProvider({ provider: "qoder", apiKey: "pt-pasted", name: "Key 2" }));
    expect((await again.json()).connection.id).toBe(connection.id);
    expect(await db.getProviderConnections({ provider: "qoder" })).toHaveLength(1);

    // The exchange request must carry the normalised `pt-` prefix.
    expect(String(fetchMock.mock.calls[0][0])).toContain("/jobToken/exchange");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).personal_token).toBe("pt-pasted");
  });

  it("still saves the Qoder key when the exchange cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    cleanupRoute = () => vi.unstubAllGlobals();

    const { POST } = await import("@/app/api/providers/route.js");
    const response = await POST(postProvider({
      provider: "qoder", apiKey: "pt-offline", name: "Key 1",
    }));

    expect(response.status).toBe(201);
    const rows = await db.getProviderConnections({ provider: "qoder" });
    expect(rows).toHaveLength(1);
    expect(rows[0].apiKey).toBe("pt-offline");
    expect(rows[0].name).toBe("Key 1"); // nothing to resolve against, so the given name stands
  });
});

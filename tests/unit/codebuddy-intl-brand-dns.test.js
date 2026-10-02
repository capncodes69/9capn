// The Tencent CDN that serves CodeBuddy/WorkBuddy flips its A record between
// the real address and the blackhole 0.0.0.1 — per resolver, per query. The
// router machine's resolver is one that catches the blackhole, so the
// device-code call died as `fetch failed` / ConnectTimeoutError and the attach
// logged "9router: no device code for codebuddy-intl" (measured live in the
// router: getent → 0.0.0.1 while 1.1.1.1, 8.8.8.8 and Cloudflare DoH all
// answered 43.174.57.1). These tests pin the fix: brand hosts are resolved
// through public resolvers, the blackhole answer is refused, the socket is
// pinned to the vetted address, and nothing outside the brands changes.
import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "dns";

async function load() {
  // Imported lazily so per-case spies on the resolver are in place first.
  return await import("open-sse/utils/brandDns.js");
}

/** Stub every `dns.promises.Resolver` the helper builds, by the server it asked. */
function stubResolve4(responder) {
  return vi.spyOn(dns.promises.Resolver.prototype, "resolve4").mockImplementation(async function () {
    return responder(this.getServers()[0]);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("brand DNS pin", () => {
  it("refuses the blackhole answer and asks the next public resolver", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    const spy = stubResolve4((server) => (server === "1.1.1.1" ? ["0.0.0.1"] : ["43.174.57.1"]));

    expect(await resolveBrandIp("www.workbuddy.ai")).toBe("43.174.57.1");
    // 1.1.1.1 answered first (blackholed), 1.0.0.1 answered with the real address.
    expect(spy.mock.calls.length).toBe(2);
  });

  it("caches a vetted answer", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    const spy = stubResolve4(() => ["43.174.57.1"]);

    await resolveBrandIp("www.codebuddy.ai");
    await resolveBrandIp("www.codebuddy.ai");
    expect(spy.mock.calls.length).toBe(1);
  });

  it("returns empty when every resolver blackholes the host, and does not cache that", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    const spy = stubResolve4(() => ["0.0.0.1"]);

    expect(await resolveBrandIp("www.workbuddy.ai")).toBe("");
    expect(spy.mock.calls.length).toBe(3);
    await resolveBrandIp("www.workbuddy.ai");
    expect(spy.mock.calls.length).toBe(6);
  });

  it("pins the vetted address in both lookup callback shapes", async () => {
    const { brandLookup, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    stubResolve4(() => ["1.2.3.4"]);

    const one = await new Promise((resolve, reject) =>
      brandLookup("www.workbuddy.ai", {}, (err, ip, family) => (err ? reject(err) : resolve([ip, family]))));
    expect(one).toEqual(["1.2.3.4", 4]);

    const all = await new Promise((resolve, reject) =>
      brandLookup("www.workbuddy.ai", { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));
    expect(all).toEqual([{ address: "1.2.3.4", family: 4 }]);
  });

  it("leaves other hostnames to the system resolver", async () => {
    const { brandLookup } = await load();
    const addrs = await new Promise((resolve, reject) =>
      brandLookup("localhost", { all: true }, (err, entries) => (err ? reject(err) : resolve(entries))));
    expect(addrs.some((entry) => /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(entry.address))).toBe(true);
  });

  it("recognises only the brand hosts", async () => {
    const { isBrandHost, isBrandHostUrl } = await load();
    expect(isBrandHost("www.workbuddy.ai")).toBe(true);
    expect(isBrandHost("www.codebuddy.ai")).toBe(true);
    expect(isBrandHost("codebuddy.ai.evil.test")).toBe(false);
    expect(isBrandHost("www.codebuddy.cn")).toBe(false);
    expect(isBrandHostUrl("https://www.workbuddy.ai/v2/plugin/auth/state")).toBe(true);
    expect(isBrandHostUrl("https://example.com/")).toBe(false);
    expect(isBrandHostUrl("not a url")).toBe(false);
  });
});

describe("proxyAwareFetch brand pin", () => {
  it("attaches the pinned dispatcher to brand calls only", async () => {
    const envKeys = [
      "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
      "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
    ];
    const saved = envKeys.map((key) => [key, process.env[key]]);
    for (const key of envKeys) delete process.env[key];

    try {
      const calls = [];
      vi.stubGlobal("fetch", vi.fn(async (url, init) => {
        calls.push({ url: String(url), init });
        return { ok: true, status: 200 };
      }));

      const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
      await proxyAwareFetch("https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI", { method: "POST" });
      expect(calls[0].init.dispatcher).toBeTruthy();

      await proxyAwareFetch("https://example.com/", {});
      expect(calls[1].init.dispatcher).toBeUndefined();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

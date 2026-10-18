// The CDN behind CodeBuddy/WorkBuddy answers its A record with the blackhole
// 0.0.0.1 for some resolvers. On the deployment machine www.codebuddy.ai
// resolved to 0.0.0.1 on every query while 1.1.1.1, 1.0.0.1 and 8.8.8.8 all
// answered 43.174.57.1 — and the blackholed host is not connectable, so the
// device flow died as "9router: no device code for codebuddy-intl" after a 10s
// connect timeout. These tests pin the fix: brand hosts resolve through public
// resolvers, the blackhole answer is refused, the socket is pinned to the
// vetted address, and nothing outside the brands changes.
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

    expect(await resolveBrandIp("www.codebuddy.ai")).toBe("43.174.57.1");
    // 1.1.1.1 answered first (blackholed), 1.0.0.1 answered with the real address.
    expect(spy.mock.calls.length).toBe(2);
  });

  it("skips a blackhole answer that arrives after a real one in the same reply", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    stubResolve4(() => ["0.0.0.1", "43.174.57.1"]);

    expect(await resolveBrandIp("www.workbuddy.ai")).toBe("43.174.57.1");
  });

  it("returns empty when every resolver answers with a blackhole", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    stubResolve4(() => ["0.0.0.1"]);

    // "" means "no vetted answer" — the caller then leaves the system resolver
    // alone rather than inventing an address.
    expect(await resolveBrandIp("www.codebuddy.ai")).toBe("");
  });

  it("returns empty when every resolver errors", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    vi.spyOn(dns.promises.Resolver.prototype, "resolve4").mockRejectedValue(
      Object.assign(new Error("no answer"), { code: "ENOTFOUND" }),
    );

    expect(await resolveBrandIp("www.codebuddy.ai")).toBe("");
  });

  it("caches a vetted answer instead of asking on every call", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    const spy = stubResolve4(() => ["43.174.57.1"]);

    await resolveBrandIp("www.codebuddy.ai");
    await resolveBrandIp("www.codebuddy.ai");
    expect(spy.mock.calls.length).toBe(1);
  });

  it("does not cache a failed lookup, so a blip cannot outlive itself", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    let call = 0;
    stubResolve4(() => {
      call += 1;
      return call <= 3 ? ["0.0.0.1"] : ["43.174.57.1"];
    });

    expect(await resolveBrandIp("www.codebuddy.ai")).toBe("");
    // The next attempt must retry rather than serve a cached failure.
    expect(await resolveBrandIp("www.codebuddy.ai")).toBe("43.174.57.1");
  });

  it("lowercases the cache key so one host is one entry", async () => {
    const { resolveBrandIp, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    const spy = stubResolve4(() => ["43.174.57.1"]);

    await resolveBrandIp("WWW.CodeBuddy.AI");
    await resolveBrandIp("www.codebuddy.ai");
    expect(spy.mock.calls.length).toBe(1);
  });
});

describe("isBrandHost / isBrandHostUrl", () => {
  it("matches the two brand domains and their subdomains", async () => {
    const { isBrandHost } = await load();
    for (const h of ["www.codebuddy.ai", "codebuddy.ai", "api.codebuddy.ai", "www.workbuddy.ai", "workbuddy.ai"]) {
      expect(isBrandHost(h), h).toBe(true);
    }
  });

  it("does not match lookalikes", async () => {
    const { isBrandHost } = await load();
    for (const h of ["codebuddy.ai.example.com", "notcodebuddy.ai", "codebuddy.com", "evil.ai", ""]) {
      expect(isBrandHost(h), h).toBe(false);
    }
  });

  it("handles a full URL, and a malformed one without throwing", async () => {
    const { isBrandHostUrl } = await load();
    expect(isBrandHostUrl("https://www.codebuddy.ai/v2/chat/completions")).toBe(true);
    expect(isBrandHostUrl("https://example.com/x")).toBe(false);
    expect(isBrandHostUrl("not a url")).toBe(false);
    expect(isBrandHostUrl(undefined)).toBe(false);
  });
});

describe("brandLookup", () => {
  it("pins a brand host to the vetted address in the single shape", async () => {
    const { brandLookup, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    stubResolve4(() => ["43.174.57.1"]);

    const result = await new Promise((resolve, reject) => {
      brandLookup("www.codebuddy.ai", {}, (err, address, family) =>
        err ? reject(err) : resolve({ address, family }));
    });
    expect(result).toEqual({ address: "43.174.57.1", family: 4 });
  });

  it("pins a brand host in the `all` shape undici asks for", async () => {
    const { brandLookup, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    stubResolve4(() => ["43.174.57.1"]);

    const result = await new Promise((resolve, reject) => {
      brandLookup("www.codebuddy.ai", { all: true }, (err, addresses) =>
        err ? reject(err) : resolve(addresses));
    });
    expect(result).toEqual([{ address: "43.174.57.1", family: 4 }]);
  });

  it("leaves a non-brand host to the system resolver", async () => {
    const { brandLookup } = await load();
    const resolve4 = stubResolve4(() => ["43.174.57.1"]);
    const systemLookup = vi.spyOn(dns, "lookup").mockImplementation((host, options, cb) => {
      cb(null, "203.0.113.9", 4);
    });

    const result = await new Promise((resolve, reject) => {
      brandLookup("example.com", {}, (err, address) => (err ? reject(err) : resolve(address)));
    });
    expect(result).toBe("203.0.113.9");
    expect(resolve4).not.toHaveBeenCalled();
    expect(systemLookup).toHaveBeenCalled();
  });

  it("falls back to the system resolver when no vetted answer exists", async () => {
    const { brandLookup, clearBrandDnsCache } = await load();
    clearBrandDnsCache();
    stubResolve4(() => ["0.0.0.1"]);
    vi.spyOn(dns, "lookup").mockImplementation((host, options, cb) => {
      cb(null, "198.51.100.7", 4);
    });

    const result = await new Promise((resolve, reject) => {
      brandLookup("www.codebuddy.ai", {}, (err, address) => (err ? reject(err) : resolve(address)));
    });
    // The pin removes a poisoned answer; it never invents one and never blocks.
    expect(result).toBe("198.51.100.7");
  });
});

describe("getBrandDispatcher", () => {
  it("builds once and returns the same dispatcher", async () => {
    const { getBrandDispatcher } = await load();
    const a = await getBrandDispatcher();
    const b = await getBrandDispatcher();
    expect(a).toBe(b);
    // undici is a direct dependency; a null here would mean it failed to load.
    expect(a).not.toBeNull();
  });
});

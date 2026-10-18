// The CDN behind CodeBuddy/WorkBuddy answers its A record with the blackhole
// 0.0.0.1 for some resolvers. On the deployment machine www.codebuddy.ai
// resolved to 0.0.0.1 on every query while 1.1.1.1, 1.0.0.1 and 8.8.8.8 all
// answered 43.174.57.1 — and the blackholed host is not connectable, so the
// device flow died as "9router: no device code for codebuddy-intl" after a 10s
// connect timeout.
//
// These tests go through the two functions production actually calls:
// `isBrandHostUrl` (the guard in proxyFetch) and `getBrandDispatcher` (the pinned
// agent). Internal helpers stay private — testing them directly would pin an
// implementation detail instead of the behaviour that matters.
import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "dns";
import net from "node:net";

// Each case needs its own module instance: the dispatcher is memoised per module,
// so a shared import would carry one case's stub into the next.
const load = () => {
  vi.resetModules();
  return import("open-sse/utils/brandDns.js");
};

/** Stub every `dns.promises.Resolver` the module builds, by the server it asked. */
function stubResolve4(responder) {
  return vi.spyOn(dns.promises.Resolver.prototype, "resolve4").mockImplementation(async function () {
    return responder(this.getServers()[0]);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isBrandHostUrl", () => {
  it("matches the two brand domains and their subdomains", async () => {
    const { isBrandHostUrl } = await load();
    for (const url of [
      "https://www.codebuddy.ai/v2/chat/completions",
      "https://codebuddy.ai/v2/plugin/auth/state",
      "https://api.codebuddy.ai/x",
      "https://www.workbuddy.ai/v2/chat/completions",
      "https://workbuddy.ai/x",
    ]) {
      expect(isBrandHostUrl(url), url).toBe(true);
    }
  });

  it("does not match lookalikes", async () => {
    const { isBrandHostUrl } = await load();
    for (const url of [
      "https://codebuddy.ai.example.com/x",
      "https://notcodebuddy.ai/x",
      "https://codebuddy.com/x",
      "https://evil.ai/x",
      "https://example.com/x",
    ]) {
      expect(isBrandHostUrl(url), url).toBe(false);
    }
  });

  it("survives a malformed or missing URL", async () => {
    const { isBrandHostUrl } = await load();
    expect(isBrandHostUrl("not a url")).toBe(false);
    expect(isBrandHostUrl(undefined)).toBe(false);
    expect(isBrandHostUrl("")).toBe(false);
  });
});

describe("getBrandDispatcher", () => {
  it("builds once and reuses the same agent", async () => {
    const { getBrandDispatcher } = await load();
    const a = await getBrandDispatcher();
    const b = await getBrandDispatcher();
    expect(a).toBe(b);
    // undici is a direct dependency; null would mean it failed to load, which
    // would silently disable the pin.
    expect(a).not.toBeNull();
  });

  it("pins a brand host to the address a public resolver vouched for", async () => {
    // A real listener stands in for the CDN. If the pin works the connection
    // lands on it; if the system resolver were used the request would go to
    // 0.0.0.1 and never arrive. Asserting on what actually connected means the
    // test cannot pass by accident.
    //
    // 127.0.0.2 rather than 127.0.0.1: the module refuses loopback addresses as
    // blackholes by design (BLOCKED_IPS), so a vetted answer has to be something
    // else. Linux routes the whole 127/8 range to loopback.
    let accepted = false;
    const server = net.createServer((socket) => {
      accepted = true;
      socket.destroy();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.2", resolve);
    });
    const port = server.address().port;

    try {
      stubResolve4((srv) => (srv === "1.1.1.1" ? ["0.0.0.1"] : ["127.0.0.2"]));
      const { getBrandDispatcher } = await load();
      const agent = await getBrandDispatcher();

      // HTTPS against a plain TCP listener fails the handshake — but only after
      // the connection was accepted, which is the proof we need.
      await fetch(`https://www.codebuddy.ai:${port}/probe`, { dispatcher: agent })
        .catch(() => {});
      expect(accepted).toBe(true);
    } finally {
      server.close();
    }
  }, 20000);

  it("refuses the blackhole and keeps asking the other resolvers", async () => {
    const spy = stubResolve4((srv) => (srv === "1.1.1.1" ? ["0.0.0.1"] : ["127.0.0.2"]));
    const { getBrandDispatcher } = await load();
    const agent = await getBrandDispatcher();

    await fetch("https://www.workbuddy.ai/probe", { dispatcher: agent }).catch(() => {});
    // 1.1.1.1 answered first with the blackhole, so at least one more resolver
    // had to be asked before an address was usable.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 20000);
});

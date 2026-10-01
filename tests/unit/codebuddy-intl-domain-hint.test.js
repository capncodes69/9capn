// 9router has no WorkBuddy provider, so a WorkBuddy attach rides
// `codebuddy-intl` and names the host its two calls belong on: `?domain=` on
// the device-code request, `extraData.domain` on the poll. These tests pin the
// three things that makes true: the default stays codebuddy.ai, the hint swaps
// the host on BOTH legs, and a host that isn't one of the brands is refused —
// the router must not be talked into fetching an arbitrary origin.
import { describe, it, expect, afterEach, vi } from "vitest";

async function loadProvider() {
  // Imported lazily so `vi.stubGlobal` below is in place for the call, not the
  // import — the module reads no globals at import time, but keeping the order
  // explicit avoids depending on that.
  return (await import("@/lib/oauth/providers/codebuddy-intl.js")).default;
}

function stubFetch(responder) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  }));
  return calls;
}

const stateOk = { ok: true, json: async () => ({ code: 0, data: { state: "s1", authUrl: "https://x/login" } }) };
const pending = { ok: true, json: async () => ({ code: 11217, msg: "RetryFetchToken" }) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("codebuddy-intl brand host hint", () => {
  it("defaults to codebuddy.ai when no hint is given", async () => {
    const provider = await loadProvider();
    const calls = stubFetch(() => stateOk);
    await provider.requestDeviceCode(provider.config, undefined, {});
    expect(calls[0].url).toBe("https://www.codebuddy.ai/v2/plugin/auth/state?platform=ide");
    expect(calls[0].init.headers["X-Domain"]).toBe("www.codebuddy.ai");
  });

  it("device-code uses the hinted host (WorkBuddy)", async () => {
    const provider = await loadProvider();
    const calls = stubFetch(() => stateOk);
    await provider.requestDeviceCode(provider.config, undefined, { domain: "workbuddy.ai" });
    expect(calls[0].url).toBe("https://www.workbuddy.ai/v2/plugin/auth/state?platform=ide");
    expect(calls[0].init.headers["X-Domain"]).toBe("www.workbuddy.ai");
  });

  it("normalises www. and case in the hint", async () => {
    const provider = await loadProvider();
    const calls = stubFetch(() => stateOk);
    await provider.requestDeviceCode(provider.config, undefined, { domain: "WWW.WorkBuddy.AI" });
    expect(calls[0].url).toBe("https://www.workbuddy.ai/v2/plugin/auth/state?platform=ide");
  });

  it("poll uses the hinted host on the token leg too", async () => {
    const provider = await loadProvider();
    const calls = stubFetch(() => pending);
    const res = await provider.pollToken(provider.config, "state-1", null, { domain: "workbuddy.ai" });
    expect(calls[0].url).toBe("https://www.workbuddy.ai/v2/plugin/auth/token?state=state-1");
    expect(calls[0].init.headers["X-Domain"]).toBe("www.workbuddy.ai");
    // The pending answer still has to read as pending, whatever host it came from.
    expect(res).toEqual({ ok: true, data: { error: "authorization_pending" } });
  });

  it("poll without a hint stays on codebuddy.ai", async () => {
    const provider = await loadProvider();
    const calls = stubFetch(() => pending);
    await provider.pollToken(provider.config, "state-2", null, {});
    expect(calls[0].url).toBe("https://www.codebuddy.ai/v2/plugin/auth/token?state=state-2");
  });

  it("refuses a host that is not one of the brands", async () => {
    const provider = await loadProvider();
    const calls = stubFetch(() => stateOk);
    await provider.requestDeviceCode(provider.config, undefined, { domain: "evil.example.com" });
    expect(calls[0].url).toBe("https://www.codebuddy.ai/v2/plugin/auth/state?platform=ide");
    calls.length = 0;
    await provider.pollToken(provider.config, "state-3", null, { domain: "codebuddy.ai.evil.test" });
    expect(calls[0].url).toBe("https://www.codebuddy.ai/v2/plugin/auth/token?state=state-3");
  });
});

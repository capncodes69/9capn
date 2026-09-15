import { describe, it, expect, afterEach } from "vitest";
import {
  buildProxyOptions,
  checkProxyRequirement,
} from "../../open-sse/handlers/chatCore/proxyGuard.js";

const ENV_KEY = "FREEBUFF_ALLOW_DIRECT";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("buildProxyOptions", () => {
  it("maps connectionProxyPoolId (auth layer) to proxyPoolId (executor)", () => {
    const opts = buildProxyOptions("freebuff", { connectionProxyPoolId: "pool-1" });
    expect(opts.proxyPoolId).toBe("pool-1");
  });

  it("accepts an already-mapped proxyPoolId", () => {
    expect(buildProxyOptions("zed", { proxyPoolId: "pool-2" }).proxyPoolId).toBe("pool-2");
  });

  it("forces strictProxy for freebuff even without a pool flag", () => {
    expect(buildProxyOptions("freebuff", {}).strictProxy).toBe(true);
  });

  it("does not force strictProxy for other providers", () => {
    expect(buildProxyOptions("zed", {}).strictProxy).toBe(false);
  });

  it("honors an explicit strictProxy flag on any provider", () => {
    expect(buildProxyOptions("zed", { strictProxy: true }).strictProxy).toBe(true);
  });

  it("normalizes missing fields to safe defaults", () => {
    const opts = buildProxyOptions("freebuff");
    expect(opts).toMatchObject({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      proxyPoolId: null,
    });
  });
});

describe("checkProxyRequirement", () => {
  const noProxy = buildProxyOptions("freebuff", {});

  it("never blocks a non-freebuff provider", () => {
    expect(checkProxyRequirement("zed", "gpt-4", noProxy)).toBeNull();
  });

  it("blocks freebuff with no proxy at all (503)", () => {
    const res = checkProxyRequirement("freebuff", "deepseek-v3", noProxy);
    expect(res?.status).toBe(503);
    expect(res?.message).toContain("proxy pool");
    expect(res?.message).toContain("deepseek-v3");
  });

  it("allows freebuff when a proxy pool is set", () => {
    const opts = buildProxyOptions("freebuff", { connectionProxyPoolId: "pool-1" });
    expect(checkProxyRequirement("freebuff", "deepseek-v3", opts)).toBeNull();
  });

  it("allows freebuff when a relay is set", () => {
    const opts = buildProxyOptions("freebuff", { vercelRelayUrl: "https://relay.example" });
    expect(checkProxyRequirement("freebuff", "deepseek-v3", opts)).toBeNull();
  });

  it("allows freebuff when a legacy connection proxy is set", () => {
    const opts = buildProxyOptions("freebuff", {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:8080",
    });
    expect(checkProxyRequirement("freebuff", "deepseek-v3", opts)).toBeNull();
  });

  it("ignores an enabled legacy proxy without a URL", () => {
    const opts = buildProxyOptions("freebuff", { connectionProxyEnabled: true });
    expect(checkProxyRequirement("freebuff", "deepseek-v3", opts)?.status).toBe(503);
  });

  it("is bypassed by FREEBUFF_ALLOW_DIRECT", () => {
    process.env[ENV_KEY] = "1";
    expect(checkProxyRequirement("freebuff", "deepseek-v3", noProxy)).toBeNull();
  });
});

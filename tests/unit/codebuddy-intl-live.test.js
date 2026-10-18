// Live probe (not part of the normal suite): exercises the real gateway through
// the patched provider and the patched global fetch.
//
//   cd tests && CODEBUDDY_LIVE=1 npx vitest run unit/codebuddy-intl-live.test.js
//
// It calls codebuddy.ai / workbuddy.ai for a pre-auth device code, so it spends
// no credits. Skipped unless CODEBUDDY_LIVE=1 — a normal run never hits the
// network.
import { describe, it, expect } from "vitest";

const live = process.env.CODEBUDDY_LIVE === "1";

describe.skipIf(!live)("codebuddy-intl live gateway", () => {
  it("issues a device code on the default host", async () => {
    // Loading proxyFetch installs the patched global fetch, which is what pins
    // brand hosts past the DNS blackhole. Without this import the provider's
    // bare `fetch` would use the poisoned system resolver.
    await import("open-sse/utils/proxyFetch.js");
    const { default: provider } = await import("@/lib/oauth/providers/codebuddy-intl.js");

    const result = await provider.requestDeviceCode(
      { ...provider.config, platform: "ide" }, null, {});
    expect(result.device_code).toBeTruthy();
    expect(result.verification_uri).toMatch(/^https?:\/\//);
    expect(result._brandHost).toBe("www.codebuddy.ai");
  }, 30000);

  it("issues a device code on the workbuddy host when asked", async () => {
    await import("open-sse/utils/proxyFetch.js");
    const { default: provider } = await import("@/lib/oauth/providers/codebuddy-intl.js");

    const result = await provider.requestDeviceCode(
      { ...provider.config, platform: "ide" }, null, { domain: "workbuddy.ai" });
    expect(result.device_code).toBeTruthy();
    expect(result._brandHost).toBe("www.workbuddy.ai");
  }, 30000);

  it("answers a poll instead of hanging on a connect timeout", async () => {
    await import("open-sse/utils/proxyFetch.js");
    const { default: provider } = await import("@/lib/oauth/providers/codebuddy-intl.js");

    const t0 = Date.now();
    const result = await provider.pollToken(
      provider.config, "00000000-0000-4000-8000-000000000000", null, {});
    // Pending or a plain failure — the point is that it answers at all. The DNS
    // blackhole used to make this a 10s connect timeout.
    expect(result).toHaveProperty("ok");
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 30000);
});

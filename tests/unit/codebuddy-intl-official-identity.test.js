// The gateway's risk engine scores client identity, and identity is the header set. The
// official 4.12.1 desktop client sends CodeBuddyIDE/* — not IDE/*, which no shipped client
// has ever sent. These values come from the client bundle's own product files, not from
// guessing: see open-sse/config/codebuddyIdentity.js.
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { CODEBUDDY_CLIENT, codeBuddyUserAgent } from "open-sse/config/codebuddyIdentity.js";

const H = () => PROVIDERS["codebuddy-intl"].headers;

describe("codebuddy-intl static identity", () => {
  it("declares the official client constants", () => {
    expect(CODEBUDDY_CLIENT.platform).toBe("CodeBuddyIDE");
    expect(CODEBUDDY_CLIENT.productName).toBe("CodeBuddy");
    expect(CODEBUDDY_CLIENT.deploymentType).toBe("SaaS");
    expect(CODEBUDDY_CLIENT.domain).toBe("www.codebuddy.ai");
  });

  it("builds the UA in the official order: platform first, product second", () => {
    // buildUserAgent() unshifts productName then platform, so platform ends up first.
    expect(codeBuddyUserAgent()).toMatch(/^CodeBuddyIDE\/[\d.]+ CodeBuddy\/[\d.]+$/);
  });

  it("registry sends CodeBuddyIDE, never the legacy IDE value", () => {
    expect(H()["X-IDE-Type"]).toBe("CodeBuddyIDE");
    expect(H()["X-IDE-Name"]).toBe("CodeBuddyIDE");
    expect(H()["X-IDE-Type"]).not.toBe("IDE");
    expect(H()["X-IDE-Name"]).not.toBe("IDE");
  });

  it("registry sends the version headers the client sends", () => {
    expect(H()["X-IDE-Version"]).toBe(CODEBUDDY_CLIENT.platformVersion);
    expect(H()["X-Product-Version"]).toBe(CODEBUDDY_CLIENT.productVersion);
    expect(H()["X-Product"]).toBe("SaaS");
    expect(H()["X-Domain"]).toBe("www.codebuddy.ai");
  });

  it("registry UA equals the UA builder output", () => {
    expect(H()["User-Agent"]).toBe(codeBuddyUserAgent());
  });

  it("keeps the headers the gateway already accepted", () => {
    expect(H()["x-requested-with"]).toBe("XMLHttpRequest");
    expect(H()["x-codebuddy-request"]).toBe("1");
  });
});

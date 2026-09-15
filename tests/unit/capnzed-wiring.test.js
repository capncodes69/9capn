import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { getProvider, getProviderNames, generateAuthData } from "@/lib/oauth/providers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("CapnZed is wired end to end", () => {
  it("registers as a VISIBLE oauth provider with the czd alias", () => {
    const entry = REGISTRY.find((r) => r.id === "capnzed");

    expect(entry).toBeDefined();
    expect(entry.hidden).toBeFalsy();
    expect(entry.category).toBe("oauth");
    expect(entry.alias).toBe("czd");
    expect(entry.uiAlias).toBe("czd");
    expect(entry.display.name).toBe("CapnZed");
    // Static floor for the picker (the ids Zed's own client ships) plus
    // passthrough, so the live /models read stays authoritative and an unknown
    // id is still forwarded rather than rejected.
    expect(entry.models.length).toBeGreaterThan(50);
    expect(entry.models.some((m) => m.id === "gpt-5.6-luna")).toBe(true);
    expect(entry.passthroughModels).toBe(true);
    expect(entry.features?.usage).toBe(true);
  });

  it("keeps upstream `zed` hidden and untouched", () => {
    const zed = REGISTRY.find((r) => r.id === "zed");
    expect(zed?.hidden).toBe(true);
  });

  it("lands in the dashboard's oauth list (the `!info.hidden` filter passes)", async () => {
    const { OAUTH_PROVIDERS, AI_PROVIDERS } = await import("@/shared/constants/providers.js");

    expect(OAUTH_PROVIDERS.capnzed).toBeDefined();
    expect(AI_PROVIDERS.capnzed?.hidden).toBeFalsy();
    expect(OAUTH_PROVIDERS.capnzed.name).toBe("CapnZed");
    expect(OAUTH_PROVIDERS.capnzed.textIcon).toBe("CZ");
  });

  it("routes to its own executor instead of the default one", () => {
    expect(hasSpecializedExecutor("capnzed")).toBe(true);
    expect(getExecutor("capnzed").constructor.name).toBe("CapnZedExecutor");
  });

  it("has a usage handler that refuses cleanly without credentials", async () => {
    // No network: the missing-user-id guard returns before any fetch.
    const usage = await getUsageForProvider({
      provider: "capnzed",
      accessToken: "token",
      providerSpecificData: {},
    });
    expect(usage.message).toMatch(/user id/i);
  });

  it("exposes an OAuth handler that builds a native_app_signin URL", async () => {
    expect(getProviderNames()).toContain("capnzed");

    const authData = await generateAuthData(
      "capnzed",
      "http://127.0.0.1:58444/",
      { nativeAppPort: "58444" },
    );
    const url = new URL(authData.authUrl);

    expect(url.origin).toBe("https://zed.dev");
    expect(url.pathname).toBe("/native_app_signin");
    expect(url.searchParams.get("native_app_port")).toBe("58444");
    // The verifier transports the RSA private key, not a PKCE string.
    expect(authData.codeVerifier.startsWith("capnzed-rsa-pkcs1:")).toBe(true);
    expect(authData.callbackPath).toBe("/");
  });

  it("uses a different default callback port than upstream zed", async () => {
    const { CAPNZED_HOSTED_CONFIG, ZED_HOSTED_CONFIG } = await import(
      "@/lib/oauth/constants/oauth"
    );
    expect(CAPNZED_HOSTED_CONFIG.defaultNativeAppPort).not.toBe(
      ZED_HOSTED_CONFIG.defaultNativeAppPort,
    );
  });

  it("ships a 128x128 icon at the path the dashboard resolver builds", () => {
    const iconPath = resolve(ROOT, "public/providers/capnzed.png");
    expect(existsSync(iconPath)).toBe(true);
    expect(getProvider("capnzed").config.webBaseUrl).toBe("https://zed.dev");
  });
});

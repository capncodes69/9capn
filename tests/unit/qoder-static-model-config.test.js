/**
 * Unit tests for the Qoder static `model_config` fallback.
 *
 * Background: Qoder's per-account catalog (GET /algo/api/v2/model/list) does not
 * always publish the frontier models `smodel` (Sonus) / `cmodel` (Cantus). The
 * chat endpoint accepts a known key without a catalog entry, so the executor now
 * falls back to an RE'd static block instead of hard-failing with
 * "model_config for \"cmodel\" not yet known".
 *
 * These cover the fallback wiring without touching the network:
 *   - the static blocks themselves match what the CLI logs at request time
 *   - the live catalog still wins when it has an entry (fallback is a fallback)
 *   - the forced-refresh path still populates from a fresh catalog
 *   - genuinely unknown keys keep failing loudly
 *   - Sonus/Cantus are routable in the static provider catalog
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(),
  resolveQoderModels: vi.fn(),
  isQoderPat: vi.fn(() => false),
  resolveQoderCredentials: vi.fn(async (credentials) => credentials),
}));

import { getQoderModelConfig, resolveQoderModels } from "../../open-sse/services/qoderModels.js";
import { __test__ as qoderExecutorInternals } from "../../open-sse/executors/qoder.js";
import {
  QODER_MODEL_MAP,
  QODER_STATIC_MODEL_CONFIGS,
  getQoderStaticModelConfig,
} from "../../open-sse/shared/qoder/constants.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const { buildQoderRequestBody } = qoderExecutorInternals;

const CREDS = {
  accessToken: "jt-test-token",
  displayName: "Tester",
  providerSpecificData: { userId: "user-abc", machineId: "machine-abc" },
};

const BODY = { messages: [{ role: "user", content: "hello" }] };

function build(model) {
  return buildQoderRequestBody({ model, body: BODY, credentials: CREDS });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QODER_MODEL_MAP", () => {
  it("maps the Sonus/Cantus canonical keys", () => {
    expect(QODER_MODEL_MAP.smodel).toBe("smodel");
    expect(QODER_MODEL_MAP.cmodel).toBe("cmodel");
  });
});

describe("QODER_STATIC_MODEL_CONFIGS / getQoderStaticModelConfig", () => {
  it("advertises Sonus and Cantus with the RE'd 200K reasoning flags", () => {
    expect(QODER_STATIC_MODEL_CONFIGS.smodel).toMatchObject({
      key: "smodel",
      display_name: "Sonus",
      is_vl: true,
      is_reasoning: true,
      max_input_tokens: 180000,
      source: "system",
      format: "openai",
    });
    expect(QODER_STATIC_MODEL_CONFIGS.cmodel).toMatchObject({
      key: "cmodel",
      display_name: "Cantus",
      is_vl: true,
      is_reasoning: true,
      max_input_tokens: 180000,
      source: "system",
      format: "openai",
    });
  });

  it("returns a fresh copy so callers can mutate `key` without leaking", () => {
    const a = getQoderStaticModelConfig("smodel");
    a.key = "mutated";
    a.max_input_tokens = 1;
    expect(getQoderStaticModelConfig("smodel").key).toBe("smodel");
    expect(QODER_STATIC_MODEL_CONFIGS.smodel.max_input_tokens).toBe(180000);
  });

  it("returns null for keys without a static block", () => {
    expect(getQoderStaticModelConfig("zzz_unknown")).toBeNull();
    expect(getQoderStaticModelConfig("")).toBeNull();
    expect(getQoderStaticModelConfig(undefined)).toBeNull();
  });

  it("lists Sonus/Cantus in the static provider catalog so they are routable", () => {
    const ids = (PROVIDER_MODELS.qd || []).map((m) => m.id);
    expect(ids).toContain("smodel");
    expect(ids).toContain("cmodel");
    const sonus = PROVIDER_MODELS.qd.find((m) => m.id === "smodel");
    expect(sonus.name).toBe("Sonus");
  });
});

describe("qoder capabilities — Sonus/Cantus", () => {
  // Without an explicit PROVIDER_CAPABILITIES.qoder row both keys fall through to
  // DEFAULT_CAPABILITIES, which advertises a text-only, non-reasoning model at a
  // context window that only happens to match. Pin the RE'd values instead.
  it.each(["smodel", "cmodel"])("%s reports 200K context + vision + reasoning", (id) => {
    const caps = getCapabilitiesForModel("qoder", id);
    expect(caps.contextWindow).toBe(200000);
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    // qodercli has no thinking picker — thinking is fixed upstream, so "none"
    // must never be offered (same as every other qoder entry).
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.tools).toBe(true);
  });

  it("keeps the RE'd default output cap (no maxOutput invented)", () => {
    // The RE block carries no max_output_tokens, so the entry must not invent one:
    // the default 64000 stays.
    expect(getCapabilitiesForModel("qoder", "smodel").maxOutput).toBe(64000);
  });
});

describe("buildQoderRequestBody — catalog fallback", () => {
  it("falls back to the static Sonus block when the catalog omits smodel", async () => {
    getQoderModelConfig.mockResolvedValue(null);
    resolveQoderModels.mockResolvedValue({ rawConfigs: new Map() });

    const built = await build("qoder/smodel");
    expect(built.qoderKey).toBe("smodel");
    expect(built.payload.model_config).toMatchObject({
      key: "smodel",
      display_name: "Sonus",
      is_reasoning: true,
      max_input_tokens: 180000,
    });
    // chat_context must mirror the same key.
    expect(built.payload.chat_context.extra.modelConfig.key).toBe("smodel");
  });

  it("falls back to the static Cantus block when the catalog omits cmodel", async () => {
    getQoderModelConfig.mockResolvedValue(null);
    resolveQoderModels.mockResolvedValue({ rawConfigs: new Map() });

    const built = await build("qoder/cmodel");
    expect(built.payload.model_config.key).toBe("cmodel");
    expect(built.payload.model_config.display_name).toBe("Cantus");
    expect(built.payload.model_config.is_reasoning).toBe(true);
  });

  it("keeps the live catalog entry when one exists (fallback is a fallback)", async () => {
    getQoderModelConfig.mockResolvedValue({
      key: "smodel",
      display_name: "Sonus (live)",
      is_reasoning: true,
      max_input_tokens: 999,
    });

    const built = await build("qoder/smodel");
    expect(built.payload.model_config.max_input_tokens).toBe(999);
    expect(built.payload.model_config.display_name).toBe("Sonus (live)");
    // The catalog hit must not trigger the forced refresh.
    expect(resolveQoderModels).not.toHaveBeenCalled();
  });

  it("uses a freshly refreshed catalog entry before the static fallback", async () => {
    getQoderModelConfig.mockResolvedValue(null);
    resolveQoderModels.mockResolvedValue({
      rawConfigs: new Map([["cmodel", { key: "cmodel", max_input_tokens: 12345 }]]),
    });

    const built = await build("qoder/cmodel");
    expect(built.payload.model_config.max_input_tokens).toBe(12345);
  });

  it("still throws for a key that is in neither the catalog nor the static table", async () => {
    getQoderModelConfig.mockResolvedValue(null);
    resolveQoderModels.mockResolvedValue({ rawConfigs: new Map() });

    await expect(build("qoder/zzz_unknown")).rejects.toThrow(/not yet known/);
  });
});

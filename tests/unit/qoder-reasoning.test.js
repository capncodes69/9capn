/**
 * Unit tests for the Qoder reasoning-parameter mapping.
 *
 * qodercli builds `parameters` as { max_tokens, reasoning_effort?,
 * enable_thinking?, reasoning_budget_tokens? } and clears `is_reasoning` when
 * thinking is off. 9router previously hardcoded `{ max_tokens }`, so a client's
 * `reasoning_effort` was dropped and a reasoning model ran at the server's
 * default effort — which reads as the model having gotten dumber.
 *
 * The gateway also defaults the effort for the frontier pair (Sonus/Cantus),
 * so a client that never sends `reasoning_effort` still gets deep thinking.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(),
  resolveQoderModels: vi.fn(),
  isQoderPat: vi.fn(() => false),
  resolveQoderCredentials: vi.fn(async (credentials) => credentials),
}));

import { getQoderModelConfig } from "../../open-sse/services/qoderModels.js";
import { __test__ as qoderExecutorInternals } from "../../open-sse/executors/qoder.js";
import {
  QODER_DEFAULT_EFFORTS,
  QODER_REASONING_EFFORT_ENV,
  QODER_THINKING_EFFORTS,
  buildQoderParameters,
  effortFromBudget,
  extractQoderThinking,
  normalizeQoderEffort,
  qoderThinkingDisablesReasoning,
  resolveDefaultQoderEffort,
  resolveQoderThinking,
} from "../../open-sse/shared/qoder/reasoning.js";

const { buildQoderRequestBody } = qoderExecutorInternals;

const CREDS = {
  accessToken: "jt-test-token",
  providerSpecificData: { userId: "user-abc", machineId: "machine-abc" },
};

const SONUS = { key: "smodel", display_name: "Sonus", is_reasoning: true, max_input_tokens: 180000 };

describe("normalizeQoderEffort", () => {
  it("accepts exactly the levels the upstream accepts", () => {
    for (const level of QODER_THINKING_EFFORTS) expect(normalizeQoderEffort(level)).toBe(level);
  });

  it("maps the CLI's aliases", () => {
    expect(normalizeQoderEffort("disabled")).toBe("none");
    expect(normalizeQoderEffort("off")).toBe("none");
    expect(normalizeQoderEffort("minimal")).toBe("low");
    expect(normalizeQoderEffort("ultra")).toBe("max");
    expect(normalizeQoderEffort("HIGH")).toBe("high");
  });

  it("drops nonsense rather than guessing", () => {
    expect(normalizeQoderEffort("turbo")).toBeUndefined();
    expect(normalizeQoderEffort("")).toBeUndefined();
    expect(normalizeQoderEffort(5)).toBeUndefined();
    expect(normalizeQoderEffort("auto")).toBeUndefined();
  });
});

describe("effortFromBudget (qodercli's _l)", () => {
  it("maps budgets to levels at the CLI's boundaries", () => {
    expect(effortFromBudget(0)).toBe("none");
    expect(effortFromBudget(1024)).toBe("low");
    expect(effortFromBudget(1025)).toBe("medium");
    expect(effortFromBudget(8192)).toBe("medium");
    expect(effortFromBudget(8193)).toBe("high");
    expect(effortFromBudget(24576)).toBe("high");
    expect(effortFromBudget(49152)).toBe("xhigh");
    expect(effortFromBudget(49153)).toBe("max");
  });

  it("returns nothing when there is no budget", () => {
    expect(effortFromBudget(undefined)).toBeUndefined();
    expect(effortFromBudget("nope")).toBeUndefined();
  });
});

describe("extractQoderThinking", () => {
  it("reads OpenAI reasoning_effort", () => {
    expect(extractQoderThinking({ reasoning_effort: "high" })).toMatchObject({ effort: "high" });
  });

  it("reads reasoning.effort and thinking.effort", () => {
    expect(extractQoderThinking({ reasoning: { effort: "low" } })).toMatchObject({ effort: "low" });
    expect(extractQoderThinking({ thinking: { effort: "xhigh" } })).toMatchObject({ effort: "xhigh" });
  });

  it("reads Claude/Gemini disabled shapes as none", () => {
    expect(extractQoderThinking({ thinking: { type: "disabled" } })).toMatchObject({ effort: "none", enableThinking: false });
    expect(extractQoderThinking({ thinkingConfig: { thinkingBudget: 0 } })).toMatchObject({ effort: "none" });
  });

  it("reads Qwen enable_thinking and thinking_budget", () => {
    expect(extractQoderThinking({ enable_thinking: true })).toMatchObject({ enableThinking: true });
    expect(extractQoderThinking({ enable_thinking: false })).toMatchObject({ enableThinking: false });
    expect(extractQoderThinking({ thinking_budget: 3000 })).toMatchObject({ budget: 3000, effort: "medium" });
  });

  it("returns null when the client expressed no thinking intent", () => {
    expect(extractQoderThinking({})).toBeNull();
    expect(extractQoderThinking({ messages: [] })).toBeNull();
    expect(extractQoderThinking(null)).toBeNull();
  });
});

describe("buildQoderParameters", () => {
  it("sends only max_tokens when nothing was requested (the CLI's own default)", () => {
    expect(buildQoderParameters({ maxTokens: 4096, thinking: null })).toEqual({ max_tokens: 4096 });
  });

  it("sets effort + enable_thinking for a requested level", () => {
    expect(buildQoderParameters({ maxTokens: 4096, thinking: { effort: "high" } })).toEqual({
      max_tokens: 4096,
      reasoning_effort: "high",
      enable_thinking: true,
    });
  });

  it("carries a budget through when one was given", () => {
    expect(buildQoderParameters({ maxTokens: 4096, thinking: { effort: "high", budget: 20000 } })).toEqual({
      max_tokens: 4096,
      reasoning_effort: "high",
      enable_thinking: true,
      reasoning_budget_tokens: 20000,
    });
  });

  it("turns thinking off for effort none and drops the budget", () => {
    expect(buildQoderParameters({ maxTokens: 4096, thinking: { effort: "none", budget: 1000 } })).toEqual({
      max_tokens: 4096,
      reasoning_effort: "none",
      enable_thinking: false,
    });
  });

  it("honours a bare enable_thinking flag", () => {
    expect(buildQoderParameters({ maxTokens: 4096, thinking: { enableThinking: false } })).toEqual({
      max_tokens: 4096,
      enable_thinking: false,
    });
    expect(buildQoderParameters({ maxTokens: 4096, thinking: { enableThinking: true } })).toEqual({
      max_tokens: 4096,
      enable_thinking: true,
    });
  });
});

describe("resolveDefaultQoderEffort", () => {
  const NO_ENV = {};

  it("defaults the frontier pair to xhigh", () => {
    expect(QODER_DEFAULT_EFFORTS.smodel).toBe("xhigh");
    expect(QODER_DEFAULT_EFFORTS.cmodel).toBe("xhigh");
    expect(resolveDefaultQoderEffort({ key: "smodel", modelConfig: SONUS, env: NO_ENV })).toBe("xhigh");
    expect(resolveDefaultQoderEffort({ key: "cmodel", modelConfig: { is_reasoning: true }, env: NO_ENV })).toBe("xhigh");
  });

  it("leaves every other Qoder model alone, like qodercli does", () => {
    for (const key of ["auto", "ultimate", "qmodel_38max", "qmodel"]) {
      expect(resolveDefaultQoderEffort({ key, modelConfig: { is_reasoning: true }, env: NO_ENV })).toBeUndefined();
    }
    expect(resolveDefaultQoderEffort({ modelConfig: SONUS, env: NO_ENV })).toBeUndefined();
  });

  it("respects a catalog entry that says the model cannot reason", () => {
    expect(
      resolveDefaultQoderEffort({ key: "smodel", modelConfig: { key: "smodel", is_reasoning: false }, env: NO_ENV }),
    ).toBeUndefined();
  });

  it("honours the QODER_REASONING_EFFORT override", () => {
    expect(resolveDefaultQoderEffort({ key: "smodel", env: { [QODER_REASONING_EFFORT_ENV]: "medium" } })).toBe("medium");
    // an explicit level applies to every model, not just the frontier pair
    expect(resolveDefaultQoderEffort({ key: "auto", env: { [QODER_REASONING_EFFORT_ENV]: "high" } })).toBe("high");
    // …and `auto`/unset fall back to the table
    expect(resolveDefaultQoderEffort({ key: "smodel", env: { [QODER_REASONING_EFFORT_ENV]: "auto" } })).toBe("xhigh");
    expect(resolveDefaultQoderEffort({ key: "smodel", env: { [QODER_REASONING_EFFORT_ENV]: "" } })).toBe("xhigh");
  });

  it("can be switched off entirely", () => {
    for (const value of ["off", "none", "disabled", "unset", "FALSE"]) {
      expect(resolveDefaultQoderEffort({ key: "smodel", env: { [QODER_REASONING_EFFORT_ENV]: value } })).toBeUndefined();
    }
  });

  it("falls back to the table for an unparseable override rather than guessing", () => {
    expect(resolveDefaultQoderEffort({ key: "smodel", env: { [QODER_REASONING_EFFORT_ENV]: "turbo" } })).toBe("xhigh");
    expect(resolveDefaultQoderEffort({ key: "auto", env: { [QODER_REASONING_EFFORT_ENV]: "turbo" } })).toBeUndefined();
  });
});

describe("resolveQoderThinking", () => {
  const opts = (key = "smodel", env = {}) => ({ key, modelConfig: { is_reasoning: true }, env });

  it("lets the client's level win over the default", () => {
    expect(resolveQoderThinking({ reasoning_effort: "low" }, opts())).toEqual({
      effort: "low",
      enableThinking: undefined,
      budget: undefined,
      source: "client",
    });
  });

  it("uses the default when the client asked for nothing", () => {
    expect(resolveQoderThinking({ messages: [] }, opts())).toEqual({ effort: "xhigh", source: "default" });
  });

  it("returns null when no default applies either", () => {
    expect(resolveQoderThinking({ messages: [] }, opts("auto"))).toBeNull();
    expect(resolveQoderThinking({ messages: [] }, opts("smodel", { [QODER_REASONING_EFFORT_ENV]: "off" }))).toBeNull();
  });

  it("fills the level in for a caller that wanted thinking but named none", () => {
    expect(resolveQoderThinking({ enable_thinking: true }, opts())).toMatchObject({ effort: "xhigh", source: "client+default" });
  });

  it("never overrides an explicit off switch", () => {
    expect(resolveQoderThinking({ thinking: { type: "disabled" } }, opts())).toMatchObject({ effort: "none", source: "client" });
    expect(resolveQoderThinking({ enable_thinking: false }, opts())).toMatchObject({ effort: "none", source: "client" });
  });
});

describe("qoderThinkingDisablesReasoning", () => {
  it("flags the two shapes that turn thinking off", () => {
    expect(qoderThinkingDisablesReasoning({ reasoning_effort: "none" })).toBe(true);
    expect(qoderThinkingDisablesReasoning({ enable_thinking: false })).toBe(true);
    expect(qoderThinkingDisablesReasoning({ enable_thinking: true })).toBe(false);
    expect(qoderThinkingDisablesReasoning(null)).toBe(false);
  });
});

describe("executor wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards reasoning_effort into payload.parameters", async () => {
    getQoderModelConfig.mockResolvedValue(SONUS);

    const built = await buildQoderRequestBody({
      model: "qoder/smodel",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      credentials: CREDS,
    });

    expect(built.payload.parameters).toMatchObject({ reasoning_effort: "high", enable_thinking: true });
    expect(built.payload.parameters.max_tokens).toBeGreaterThan(0);
  });

  it("defaults to xhigh when the client asked for nothing", async () => {
    getQoderModelConfig.mockResolvedValue(SONUS);

    const built = await buildQoderRequestBody({
      model: "qoder/smodel",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: CREDS,
    });

    expect(built.payload.parameters).toMatchObject({ reasoning_effort: "xhigh", enable_thinking: true });
  });

  it("leaves a non-frontier model's parameters at just max_tokens", async () => {
    getQoderModelConfig.mockResolvedValue({ key: "auto", display_name: "Auto", is_reasoning: true });

    const built = await buildQoderRequestBody({
      model: "qoder/auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: CREDS,
    });

    expect(built.payload.parameters).toEqual({ max_tokens: built.payload.parameters.max_tokens });
  });

  it("lets the client's effort win over the default", async () => {
    getQoderModelConfig.mockResolvedValue(SONUS);

    const built = await buildQoderRequestBody({
      model: "qoder/smodel",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" },
      credentials: CREDS,
    });

    expect(built.payload.parameters).toMatchObject({ reasoning_effort: "medium", enable_thinking: true });
  });

  it("honours an explicit off switch even though a default exists", async () => {
    getQoderModelConfig.mockResolvedValue(SONUS);

    const built = await buildQoderRequestBody({
      model: "qoder/smodel",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "none" },
      credentials: CREDS,
    });

    expect(built.payload.parameters).toMatchObject({ reasoning_effort: "none", enable_thinking: false });
  });

  it("clears is_reasoning when thinking is switched off, like the CLI does", async () => {
    getQoderModelConfig.mockResolvedValue(SONUS);

    const built = await buildQoderRequestBody({
      model: "qoder/smodel",
      body: { messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } },
      credentials: CREDS,
    });

    expect(built.payload.model_config.is_reasoning).toBe(false);
    expect(built.payload.chat_context.extra.modelConfig.is_reasoning).toBe(false);
    expect(built.payload.parameters.enable_thinking).toBe(false);
  });
});

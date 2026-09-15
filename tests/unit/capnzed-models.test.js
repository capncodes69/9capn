/**
 * The CapnZed model catalog + relay-provider mapping.
 *
 * Zed's hosted provider fronts Anthropic / OpenAI / Google / xAI *and* a set of
 * open-weight models that Baseten relays. The relay provider decides which body
 * shape goes on the wire (Responses vs Chat Completions vs Claude vs Gemini), so
 * a mis-mapped model is rejected upstream rather than degraded.
 *
 * The live /models response carries an explicit `provider` per model and always
 * wins; these tests pin the *fallback* used when the catalog cannot be read (and
 * the static ids the picker offers before a connection exists).
 */
import { describe, it, expect } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { normalizeCapnZedProvider } from "../../open-sse/executors/capnzed.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";

const entry = REGISTRY.find((r) => r.id === "capnzed");

/** Ids taken from the cloud model table inside the Zed client binary. */
const EXPECTED_CATALOG = [
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "grok-build-0.1",
  "deepseek-v4-pro",
  "glm-5.3",
  "kimi-k3",
  "minimax-m3",
  "mimo-v2.5-pro",
  "qwen3.8-max",
  "hy3",
];

describe("CapnZed static catalog", () => {
  it("carries the ids Zed's own client uses", () => {
    const ids = new Set(entry.models.map((m) => m.id));
    for (const id of EXPECTED_CATALOG) {
      expect(ids.has(id), `missing ${id}`).toBe(true);
    }
  });

  it("keeps ids unique and every entry named", () => {
    const ids = entry.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of entry.models) {
      expect(model.name, `unnamed ${model.id}`).toBeTruthy();
      expect(model.name).not.toBe(model.id);
    }
  });

  it("is exposed through the shared provider-model registry", () => {
    const models = getModelsByProviderId("capnzed");
    expect(models.length).toBe(entry.models.length);
    expect(models.some((m) => m.id === "gpt-5.6-sol")).toBe(true);
  });

  it("stays a floor, not a gate — passthrough is still on", () => {
    expect(entry.passthroughModels).toBe(true);
  });
});

describe("normalizeCapnZedProvider", () => {
  it("trusts the live catalog's provider value over any id heuristic", () => {
    expect(normalizeCapnZedProvider("Anthropic", "gpt-5.6-luna")).toBe("Anthropic");
    expect(normalizeCapnZedProvider("Baseten", "claude-opus-5")).toBe("Baseten");
    expect(normalizeCapnZedProvider("xai", "glm-5")).toBe("XAi");
    expect(normalizeCapnZedProvider("open_ai", "gemini-3-flash")).toBe("OpenAi");
  });

  it.each([
    ["claude-opus-5", "Anthropic"],
    ["claude-sonnet-4", "Anthropic"],
    ["gemini-3.1-pro", "Google"],
    ["gemini-3.5-flash-lite", "Google"],
    ["grok-build-0.1", "XAi"],
    ["gpt-5.6-luna", "OpenAi"],
    ["gpt-5-codex", "OpenAi"],
  ])("infers %s → %s", (model, provider) => {
    expect(normalizeCapnZedProvider(null, model)).toBe(provider);
  });

  it.each([
    "deepseek-v4-pro",
    "glm-5",
    "glm-5.2",
    "kimi-k2.7-code",
    "minimax-m2.5",
    "mimo-v2.5-pro",
    "qwen3.6-plus",
    "hy3",
    "muse-spark-1.2",
  ])("routes the open-weight family %s through Baseten", (model) => {
    // ChatGPT-style Responses bodies are rejected for these; Chat Completions is not.
    expect(normalizeCapnZedProvider(null, model)).toBe("Baseten");
  });

  it("falls back to OpenAi for an unrecognised id (and passthrough still forwards it)", () => {
    expect(normalizeCapnZedProvider(null, "some-future-model")).toBe("OpenAi");
    expect(normalizeCapnZedProvider(null, "")).toBe("OpenAi");
  });
});

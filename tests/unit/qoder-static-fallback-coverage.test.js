import { describe, expect, it } from "vitest";
import {
  getQoderStaticModelConfig,
  QODER_STATIC_MODEL_CONFIGS,
} from "../../open-sse/shared/qoder/constants.js";
import QODER_PROVIDER from "../../open-sse/providers/registry/qoder.js";

/**
 * The per-account /model/list catalog frequently omits models the account is
 * entitled to. The chat endpoint does not validate model_config.key against the
 * catalog, so refusing before sending makes an available model look broken.
 *
 * Production hit exactly this: qd/qmodel_latest answered
 *   400 "qoder: model_config for \"qmodel_latest\" not yet known"
 * in 205ms, never reaching upstream.
 *
 * Every model the registry advertises must therefore have a static fallback.
 */
describe("qoder static model fallback coverage", () => {
  const registryIds = (QODER_PROVIDER.models || []).map((m) => m.id);

  it("has a static fallback for every model the registry advertises", () => {
    const missing = registryIds.filter((id) => !getQoderStaticModelConfig(id));
    expect(missing).toEqual([]);
  });

  it("specifically covers qmodel_latest, which failed in production", () => {
    const cfg = getQoderStaticModelConfig("qmodel_latest");
    expect(cfg).not.toBeNull();
    expect(cfg.key).toBe("qmodel_latest");
  });

  it("keeps the static blocks freezable copies, not shared references", () => {
    const a = getQoderStaticModelConfig("smodel");
    const b = getQoderStaticModelConfig("smodel");
    expect(a).not.toBe(b);
    a.key = "mutated";
    expect(b.key).toBe("smodel");
  });
});

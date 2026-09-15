/**
 * Qoder reasoning parameters — the `parameters` object qodercli actually sends.
 *
 * qodercli builds every request's `parameters` from a generation config
 * (`LS()` in the v1.1.52 bundle):
 *
 *   Y = U5(generation)                  // reasoning_budget_tokens, …
 *   Y.max_tokens = …                    // explicit max output tokens
 *   oe = generation.reasoningEffort ?? _l(generation.thinkingBudget)
 *   if (oe) {
 *     Y.reasoning_effort = oe
 *     if (oe === "none")        { Y.enable_thinking = false; delete Y.reasoning_budget_tokens }
 *     else                      { Y.enable_thinking = true; Y.reasoning_budget_tokens = budget }
 *   }
 *   if (thinkingBudget === 0 || Y.reasoning_effort === "none" || Y.enable_thinking === false)
 *     model_config.is_reasoning = false
 *
 * Valid efforts are exactly `none|low|medium|high|xhigh|max`. `_l()` maps a
 * budget to a level (0 → none, ≤1024 → low, ≤8192 → medium, ≤24576 → high,
 * ≤49152 → xhigh, else max); `disabled`/`off` are aliases for `none`.
 *
 * Before this, 9router hardcoded `parameters: { max_tokens }` and dropped a
 * client's `reasoning_effort` on the floor — so a reasoning model silently ran
 * at whatever effort the server defaulted to. For an agentic frontier model
 * that reads as "the model got dumb", which is what it is: the thinking budget
 * was never requested.
 *
 * Beyond mirroring the client, the gateway now also *defaults* the effort for
 * the frontier pair (Sonus/Cantus): a plain client that never heard of
 * `reasoning_effort` still gets deep thinking. See QODER_DEFAULT_EFFORTS.
 */

export const QODER_THINKING_EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);

export const QODER_REASONING_EFFORT_ENV = "QODER_REASONING_EFFORT";

/**
 * Effort applied when the caller named no level of its own. Sonus (smodel) and
 * Cantus (cmodel) are the frontier agentic pair — the whole reason to route
 * there is long-horizon autonomous work, which is exactly what a thinking
 * budget buys, and they are billed at 3.2x either way. `xhigh` is the level
 * that matches that intent.
 *
 * Every other Qoder model is left alone (no field at all), which is what
 * qodercli itself does. Widen or narrow with `QODER_REASONING_EFFORT`.
 */
export const QODER_DEFAULT_EFFORTS = Object.freeze({
  smodel: "xhigh",
  cmodel: "xhigh",
});

/** Values that switch the server-side default off entirely (env level). */
const EFFORT_DEFAULTS_DISABLED = Object.freeze(["off", "none", "disabled", "unset", "false"]);

const EFFORT_ALIASES = Object.freeze({
  disabled: "none",
  off: "none",
  minimal: "low",
  ultra: "max",
});

/** qodercli's `_l()`: thinking budget → discrete effort level. */
export function effortFromBudget(budget) {
  if (budget === undefined || budget === null) return undefined;
  const n = Number(budget);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return "none";
  if (n <= 1024) return "low";
  if (n <= 8192) return "medium";
  if (n <= 24576) return "high";
  if (n <= 49152) return "xhigh";
  return "max";
}

/** Accept only what the upstream accepts; unknown levels are dropped, not guessed. */
export function normalizeQoderEffort(value) {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "auto") return undefined; // "auto" means "let the server decide"
  const aliased = EFFORT_ALIASES[raw] ?? raw;
  return QODER_THINKING_EFFORTS.includes(aliased) ? aliased : undefined;
}

/**
 * Read thinking intent from a request body in any of the shapes clients send
 * (OpenAI `reasoning_effort`, `reasoning.effort`, Claude `thinking`, Qwen
 * `enable_thinking`/`thinking_budget`, Gemini `thinkingConfig`).
 */
export function extractQoderThinking(body) {
  if (!body || typeof body !== "object") return null;

  let effort = normalizeQoderEffort(
    body.reasoning_effort
      ?? (typeof body.reasoning === "object" ? body.reasoning?.effort : undefined)
      ?? (typeof body.thinking === "object" ? body.thinking?.effort : undefined)
      ?? (typeof body.thinkingConfig === "object" ? body.thinkingConfig?.thinkingLevel : undefined),
  );

  let budget;
  for (const candidate of [
    body.thinking_budget,
    body.reasoning_budget_tokens,
    typeof body.thinking === "object" ? body.thinking?.budget_tokens : undefined,
    typeof body.thinkingConfig === "object" ? body.thinkingConfig?.thinkingBudget : undefined,
  ]) {
    const n = Number(candidate);
    if (Number.isFinite(n)) {
      budget = n;
      break;
    }
  }

  let enableThinking;
  if (body.enable_thinking === false) enableThinking = false;
  else if (body.enable_thinking === true) enableThinking = true;
  else if (body.thinking?.type === "disabled") enableThinking = false;
  else if (body.thinking?.type === "enabled" || body.thinking?.type === "adaptive") enableThinking = true;

  if (budget !== undefined && effort === undefined) effort = effortFromBudget(budget);
  // `thinking: { type: "disabled" }` is an explicit off-switch even without an effort.
  if (enableThinking === false && effort === undefined) effort = "none";
  if (effort === undefined && enableThinking === undefined) return null;
  return { effort, enableThinking, budget };
}

/** The per-model table, guarded by the catalog's own `is_reasoning` flag. */
function modelDefaultEffort(key, modelConfig) {
  if (!key) return undefined;
  if (modelConfig && modelConfig.is_reasoning === false) return undefined;
  return QODER_DEFAULT_EFFORTS[String(key).toLowerCase()];
}

/**
 * The effort the *gateway* wants when the caller expressed no level.
 *
 * `QODER_REASONING_EFFORT` is the operator override:
 *   unset | `auto`      → per-model table (xhigh for smodel/cmodel, else none)
 *   `off` | `none` | …  → never inject a default
 *   a valid level       → that level for every Qoder model
 * An unparseable value falls back to the table rather than guessing.
 */
export function resolveDefaultQoderEffort({ key, modelConfig, env = process.env } = {}) {
  const configured = env?.[QODER_REASONING_EFFORT_ENV];
  const raw = configured === undefined || configured === null ? "" : String(configured).trim().toLowerCase();

  if (raw && raw !== "auto") {
    if (EFFORT_DEFAULTS_DISABLED.includes(raw)) return undefined;
    const level = normalizeQoderEffort(raw);
    if (level) return level;
  }
  return modelDefaultEffort(key, modelConfig);
}

/**
 * Resolve the thinking intent for one request: the caller's, and failing that
 * the gateway default. Returns `null` when neither applies (send nothing).
 *
 * `source` is returned for logging only — `buildQoderParameters` ignores it.
 *
 * @returns {{ effort?: string, enableThinking?: boolean, budget?: number, source: "client"|"default"|"client+default" }|null}
 */
export function resolveQoderThinking(body, { key, modelConfig, env = process.env } = {}) {
  const explicit = extractQoderThinking(body);
  const fallback = resolveDefaultQoderEffort({ key, modelConfig, env });

  if (!explicit) {
    return fallback ? { effort: fallback, source: "default" } : null;
  }
  // The caller asked to think but named no level (e.g. a bare
  // `enable_thinking: true`): fill in the gateway default instead of leaving
  // the effort unset.
  if (explicit.effort === undefined && fallback && explicit.enableThinking !== false) {
    return { ...explicit, effort: fallback, source: "client+default" };
  }
  return { ...explicit, source: "client" };
}

/**
 * Build the `parameters` object for one Qoder request, mirroring qodercli.
 * Returns `{ max_tokens }` alone when the caller expressed no thinking intent
 * and no default applies, which is exactly what the CLI does too.
 */
export function buildQoderParameters({ maxTokens, thinking } = {}) {
  const parameters = { max_tokens: maxTokens };

  if (!thinking) return parameters;
  const { effort, enableThinking, budget } = thinking;

  if (effort) {
    parameters.reasoning_effort = effort;
    if (effort === "none") {
      parameters.enable_thinking = false;
      delete parameters.reasoning_budget_tokens;
    } else {
      parameters.enable_thinking = true;
      if (Number.isFinite(budget) && budget > 0) parameters.reasoning_budget_tokens = budget;
      else delete parameters.reasoning_budget_tokens;
    }
    return parameters;
  }

  if (enableThinking !== undefined) {
    parameters.enable_thinking = enableThinking;
    if (!enableThinking) delete parameters.reasoning_budget_tokens;
  }
  if (Number.isFinite(budget) && budget > 0 && enableThinking !== false) {
    parameters.enable_thinking = true;
    parameters.reasoning_budget_tokens = budget;
  }
  return parameters;
}

/**
 * qodercli clears `model_config.is_reasoning` when thinking is switched off, so
 * the echo back to the caller matches what actually ran. Mirrored here.
 */
export function qoderThinkingDisablesReasoning(parameters) {
  if (!parameters) return false;
  return parameters.reasoning_effort === "none" || parameters.enable_thinking === false;
}

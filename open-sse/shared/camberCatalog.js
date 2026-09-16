// Camber — pure catalog and identifiers.
//
// This module exists for ONE reason: the provider registry
// (open-sse/providers/registry/*.js) is pulled into the CLIENT bundle (it is
// imported by src/shared/constants/providers.js, which the dashboard shell
// renders). Importing the wire layer from a registry entry drags proxyFetch —
// and its `await import("dns")` — into the browser graph, which Next then warns
// about on every build. So the declarative constants live here with ZERO
// imports, and registry/camber.js may safely import them.
//
// camberAuth.js re-exports everything here, so the wire layer stays the single
// place callers import from.
//
// Nothing in this file may import another module. Keep it that way.

export const CAMBER_PROVIDER_ID = "camber";

export const CAMBER_API_BASE_URL = "https://api-v2.cambercloud.com/api/cli";
export const CAMBER_WEB_BASE_URL = "https://app.cambercloud.com";
/** The browser page a device-flow session is authorised on. */
export const CAMBER_LOGIN_PATH = "/auth-cli";

/** Agent used when a connection does not pin one. Ships with the platform. */
export const CAMBER_DEFAULT_AGENT = "nova.cli";

/** Effort values the server accepts (model.Effort `oneof`). */
export const CAMBER_EFFORTS = ["low", "medium", "high"];

export const CAMBER_DEFAULT_MODEL = "bedrock:claude-opus-5";

/**
 * Static model floor. Camber exposes no catalog endpoint, so this is the union
 * of the CLI's own `--model` list and the ids the web picker sends. The server
 * is authoritative: a model outside the account's plan is refused with
 * `400 Model not supported by the current plan`.
 */
export const CAMBER_MODELS = [
  { id: "claude-opus-5", wire: "bedrock:claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", wire: "bedrock:claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-4-8", wire: "bedrock:claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6", wire: "bedrock:claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", wire: "bedrock:claude-opus-4-6-v1", name: "Claude Opus 4.6" },
];

/**
 * The usage API the web app reads, and why a connection cannot.
 *
 * `app.cambercloud.com/personal-usage` renders four resources — the ids come
 * back from this endpoint, verified in the web bundle (`personal-usage` chunk):
 *
 *   GET https://api-v2.cambercloud.com/api/credit-usage/me
 *   → { data: [ { resource: "cpu_seconds" | "gpu_seconds" | "llm_messages" | "storage_gb" }, … ] }
 *
 * It is scoped to the **web session**: probing it with a CLI API key (or with no
 * token at all) answers `401 unauthorized - invalid token`, while the same key
 * reads `/api/cli/me` fine. Both credentials a 9capn connection can hold — the
 * pasted key and the one the browser login issues — are CLI-scoped, so this
 * endpoint is not reachable from a provider. Do not add it to a fetcher; the
 * card says where the real numbers live instead.
 */
export const CAMBER_WEB_USAGE_PATH = "/api/credit-usage/me";
export const CAMBER_WEB_USAGE_URL = "https://app.cambercloud.com/personal-usage";

/**
 * Per-plan grants, as published on cambercloud.com/pricing (monthly).
 *
 * Only `llmMessages` is something a chat provider can meter for itself: one
 * request served through the connection is one LLM message, which is exactly
 * how Camber counts them. CPU/GPU hours and storage belong to jobs and
 * notebooks, not to chat, so they are listed here for reference only — never
 * drawn as a bar. A Pro **trial** is granted more messages than the paid Pro
 * row (500 observed), which is why the plan is a per-connection choice and an
 * explicit limit always wins over this table.
 */
export const CAMBER_PLAN_LIMITS = {
  student: { label: "Student", llmMessages: 50, cpuHours: 40, gpuHours: 5, storageGb: 50 },
  pro: { label: "Pro", llmMessages: 200, cpuHours: 100, gpuHours: 20, storageGb: 75 },
  teams: { label: "Teams", llmMessages: 500, cpuHours: 300, gpuHours: 50, storageGb: 200 },
};

/** Codes surface in errors/logs so a failure is diagnosable after the fact. */
export const CAMBER_ERROR_CODES = {
  noCredentials: "camber_no_credentials",
  badApiKey: "camber_bad_api_key",
  unknownAgent: "camber_unknown_agent",
  modelNotInPlan: "camber_model_not_in_plan",
  unknownConversation: "camber_unknown_conversation",
  validation: "camber_validation_failed",
  rateLimited: "camber_rate_limited",
};

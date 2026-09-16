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

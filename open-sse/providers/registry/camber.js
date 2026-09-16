// Camber — 9capn's provider for the Camber platform (cambercloud.com).
//
// Two things are unusual about Camber and both are visible in this entry:
//
//   1. It is an AGENT platform, not a plain model gateway, and the agent is NOT
//      optional: every chat is agent-mediated (no raw inference route exists, and
//      /api/ai/* refuses a CLI key). The agent is a PER-CONNECTION setting
//      (providerSpecificData.camberAgent) while the model stays the routed id --
//      which is why the catalog below is a list of Bedrock Claude models rather
//      than a list of agents.
//
//      The connection pins NO agent by default: `context_agent` is left off the
//      request, which is what the web app does, and the server's orchestrator then
//      picks a platform agent itself. Pinning a CLI agent (e.g. "nova.cli") makes
//      the model introduce itself as a Camber CLI and try to run jobs in a Camber
//      sandbox instead of editing the caller's local files -- verified live. Only
//      set one when the account wants that agent's tools or skills.
//
//   2. There is NO model catalog endpoint: 13 candidate paths were probed and all
//      404. The list below is the union of the CLI's `--model` values and the ids
//      the web picker sends. The server decides: a model outside the account's
//      plan is refused with `400 Model not supported by the current plan`, and
//      passthroughModels keeps unknown ids routable without a 9capn release.
//
// Auth is deliberately dual, mirroring qoder: a browser login (device-flow shaped
// — POST /auth/initiate then GET /auth/poll?session_id=…) OR a pasted API key.
// Both end up as the same credential: `Authorization: Bearer <api-key>`.
//
// Everything wire-specific lives in open-sse/shared/camberAuth.js.
//
// NOTE: import the CATALOG, not the wire layer. This file is pulled into the
// client bundle (src/shared/constants/providers.js -> dashboard shell), and
// camberAuth.js reaches proxyFetch, whose `await import("dns")` makes Next warn
// on every build. camberCatalog.js has zero imports and is safe here.
import { CAMBER_DEFAULT_AGENT, CAMBER_MODELS } from "../../shared/camberCatalog.js";

export default {
  id: "camber",
  priority: 25,
  alias: "cbr",
  uiAlias: "cbr",
  display: {
    name: "Camber",
    // Material-symbols fallback; no bitmap icon is shipped for this provider.
    icon: "science",
    color: "#10B981",
    textIcon: "CB",
    website: "https://cambercloud.com",
    notice: {
      signupUrl: "https://app.cambercloud.com",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint:
    "Sign in with the browser flow, or paste the token `camber login` prints (CAMBER_API_KEY). Pin an agent only if you need that agent's tools — the default lets Camber choose.",

  transport: {
    // The real call is POST /chat; the executor streams and translates it.
    baseUrl: "https://api-v2.cambercloud.com/api/cli/chat",
    format: "openai",
    forceStream: true,
    headers: {
      "content-type": "application/json",
    },
    // Camber warms a sandbox before the first frame of a new conversation, which
    // measured ~2 minutes on a cold account; later turns in the same conversation
    // are fast. Timeouts must clear that, not the streaming speed.
    timeoutMs: 300000,
    stallTimeoutMs: 300000,
    auth: {
      header: "Authorization",
      scheme: "Bearer <api-key>",
    },
    usage: {
      url: "https://api-v2.cambercloud.com/api/cli/me",
    },
  },

  // Display name per id; the wire wants the `bedrock:`-prefixed id, which the
  // executor adds (see resolveCamberModel).
  models: CAMBER_MODELS.map((model) => ({ id: model.id, name: model.name })),
  // A model Camber adds later still routes; the server validates it.
  passthroughModels: true,

  oauth: {
    apiBaseUrl: "https://api-v2.cambercloud.com/api/cli",
    webBaseUrl: "https://app.cambercloud.com",
    loginPath: "/auth-cli",
    initiateUrl: "/auth/initiate",
    pollUrl: "/auth/poll",
    // The CLI polls every ~5s; match it.
    pollIntervalSeconds: 5,
    // Empty = send no `context_agent` at all (Camber's own orchestrator decides).
    defaultAgent: CAMBER_DEFAULT_AGENT,
  },

  features: {
    // GET /me is the identity + connectivity probe.
    usage: true,
    // Pasted API-key connections can read /me too.
    usageApikey: true,
  },
};

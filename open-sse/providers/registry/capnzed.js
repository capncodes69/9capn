// CapnZed — 9capn's custom Zed provider for the free Pro trial.
//
// Distinct from the upstream `zed` provider on purpose: that one treats a Zed
// account as a normal BYO credential, while CapnZed exists to farm the free
// "Zed Pro Trial" ($5 of hosted-model credit, 14 days, per account) and rotate
// to the next account the moment one is spent. Everything trial-specific lives
// in open-sse/shared/capnzedAuth.js + open-sse/executors/capnzed.js.
//
// Not hidden: unlike `zed`, this provider is meant to be used from the dashboard.
export default {
  id: "capnzed",
  priority: 5,
  alias: "czd",
  uiAlias: "czd",
  display: {
    name: "CapnZed",
    icon: "bolt",
    color: "#0EA5E9",
    textIcon: "CZ",
    website: "https://zed.dev/pricing",
    notice: {
      signupUrl: "https://zed.dev/pricing",
    },
  },
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,

  transport: {
    // Same relay as Zed's own client: cloud.zed.dev/completions takes
    // { thread_id, prompt_id, provider, model, provider_request } where
    // provider_request is the raw provider-native body, and answers with NDJSON
    // ({ "event": … } / { "status": … }, terminated by a "stream_ended" status).
    baseUrl: "https://cloud.zed.dev/completions",
    format: "openai",
    forceStream: true,
    headers: {
      "content-type": "application/json",
    },
    // Account API uses "Authorization: {user_id} {access_token}"; the LLM plane
    // uses "Bearer {llm_token}" minted per-organization from /client/llm_tokens.
    // The executor builds both, so the scheme here is a marker for tooling.
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "<user_id> <access_token>",
    },
    usage: {
      url: "https://cloud.zed.dev/client/users/me",
    },
    // Catalog is always fetched live — Zed rotates upstream models constantly.
    modelsUrl: "https://cloud.zed.dev/models",
  },

  // Static catalog = the models the dashboard/picker offers before (or without)
  // a live catalog read. The live /models response stays authoritative and any
  // client-sent model id is still forwarded as-is (passthroughModels), so this
  // list is a floor, not a gate.
  //
  // Source: the cloud model table compiled into the Zed client itself (the same
  // ids its own settings use, e.g. agent.default_model = { provider: "zed.dev",
  // model: "gpt-5.6-sol" }). Re-derive it from the binary after a client update:
  //   strings -n 4 -t d zed-editor | grep -n "Claude Opus 5Claude Opus 4.8"
  // which prints display names followed by the id list. Per-model context limits,
  // vision/thinking flags and effort levels are NOT hardcoded here — they come
  // from the live catalog (max_token_count / supports_images / …).
  models: [
    // Anthropic
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    // OpenAI
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.5-pro", name: "GPT-5.5 Pro" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-pro", name: "GPT-5.4 Pro" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { id: "gpt-5.4-nano", name: "GPT-5.4 Nano" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { id: "gpt-5.1", name: "GPT-5.1" },
    { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
    { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
    { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5-codex", name: "GPT-5 Codex" },
    { id: "gpt-5-nano", name: "GPT-5 Nano" },
    // Google
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    // xAI
    { id: "grok-build-0.1", name: "Grok Build 0.1" },
    // Baseten-relayed open weights
    { id: "muse-spark-1.2", name: "Muse Spark 1.2" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "mimo-v2.5", name: "MiMo V2.5" },
    { id: "qwen3.5-plus", name: "Qwen3.5 Plus" },
    { id: "qwen3.6-plus", name: "Qwen3.6 Plus" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "hy3", name: "Hy3" },
  ],
  passthroughModels: true,

  oauth: {
    // RSA keypair native-app flow (NOT OAuth2/PKCE):
    //   1. Generate RSA-2048 keypair locally (PKCS#1 DER, URL-safe base64).
    //   2. Bind a local callback port.
    //   3. Open /native_app_signin?native_app_port=…&native_app_public_key=….
    //   4. Zed redirects to http://127.0.0.1:{port}/?user_id=…&access_token=…
    //      with the token RSA-encrypted against the public key.
    //   5. Decrypt locally (OAEP-SHA256, PKCS#1 v1.5 fallback).
    // No client_id/client_secret and no refresh token — one keypair per login.
    authorizeUrl: "https://zed.dev/native_app_signin",
    platform: "capnzed",
    rsaKeyExchange: true,
  },

  features: {
    usage: true,
  },
};

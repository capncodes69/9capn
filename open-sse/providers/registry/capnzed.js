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

  // No static catalog: the live /models response is authoritative and any
  // client-sent model id is forwarded as-is.
  models: [],
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

# open-sse

Provider-agnostic SSE engine: one OpenAI-style request → any provider (LLM chat, image, embedding, tts, stt, search), streamed back in the client's format.

## Request lifecycle (chat)

`handlers/chatCore.js` → `services/model.js` `parseModel` (resolve `provider/model`) → **pre-translate hooks** (`rtk/` tool_result compress, `rtk/headroom.js` proxy compress, `rtk/caveman.js` system inject — all fail-open) → `executors/index.js` `getExecutor(provider)` → `translator/index.js` `translateRequest` (client format → provider format) → `executor.execute()` (streams upstream) → `translateResponse` (provider chunks → client format) → SSE out.

## Directory map

- `config/` — ALL constants/config (no hardcode elsewhere). `providers.js`/`registry/` (provider defs), `providerModels.js` (alias→models matrix), `runtimeConfig.js` (timeouts, token limits), `*Constants.js`.
- `translator/` — format conversion. `request/<from>-to-<to>.js`, `response/<from>-to-<to>.js`, `schema/` (enums: ROLE, CLAUDE_BLOCK…), `concerns/` (shared logic), `formats.js`+`formats/` (per-format). `index.js` is the registry/entry.
- `executors/` — per-provider upstream call. `base.js` (BaseExecutor), one file per special provider, `index.js` map.
- `providers/` — registry build + `capabilities.js` + `pricing.js`. Entry: `index.js` (PROVIDERS).
- `handlers/` — per-modality cores (chat/image/embedding/tts/stt/search) + sub-provider folders. `chatCore/` has the streaming/non-streaming/sse-to-json handlers.
- `rtk/` — request token-killer. `index.js` compresses `tool_result` content in-place (OpenAI/Claude/Kiro shapes); `filters/` per-tool compressors + `autodetect.js`; `headroom.js` external compress proxy; `caveman.js` system-prompt injector.
- `transformer/` — `responsesTransformer.js` (Chat Completions SSE → Codex Responses API SSE), `streamToJsonConverter.js`.
- `shared/` — cross-provider auth/identity: `clineAuth.js`, `machineId.js`, `qoder/`.
- `services/` — `model.js`, `provider.js`, `accountFallback.js`, `combo.js`, `compact.js`, `tokenRefresh/`+`tokenRefresh.js`, `oauthCredentialManager.js`, `usage/`, `projectId.js`, `kiroModels.js`/`qoderModels.js`.
- `utils/` — streamHandler, stream, sse, error, sessionManager, claudeCloaking, clientDetector, proxyFetch (patches global fetch), cursorProtobuf/cursorChecksum, ollamaTransform.

## Conventions

- Config-driven, DRY, camelCase. NEVER hardcode values, models, or block/role strings — use `config/` + `schema/` constants.
- Translator pipeline pivots through OpenAI as the intermediate format. A translator registered on the exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop.
- Translators self-register via `register(from, to, reqFn, resFn)` as an import side-effect — new files MUST be imported in `translator/index.js`.

## How to add

- **Provider**: copy `providers/REGISTRY_TEMPLATE.js` → `providers/registry/{id}.js`; add models to `config/providerModels.js`. Generic providers need no executor (DefaultExecutor handles OpenAI-compatible APIs).
- **Executor** (only for non-standard upstream): subclass `BaseExecutor` (override `getBaseUrls`/`buildHeaders`/`buildUrl`/`execute`), register in `executors/index.js` map. `getExecutor` falls back to `DefaultExecutor` when absent.
- **Translator**: add `request|response/<from>-to-<to>.js` calling `register(...)`, then import it in `translator/index.js`. Reuse `schema/` + `concerns/` — don't re-implement parsing.

## CapnZed (Zed trial provider)

`capnzed` is 9capn's own Zed hosted-models provider, built to farm the free **Zed Pro Trial** and rotate accounts when one is spent. It shares **no code** with the upstream `zed` provider (which stays `hidden: true` and untouched) — `shared/capnzedAuth.js` + `executors/capnzed.js` are a deliberate self-contained copy so upstream can change its Zed files without breaking this one.

**Reverse-engineered wire facts** (Zed 1.19.2, `df181c6f`; from `crates/language_models_cloud`, `crates/cloud_llm_client`, `crates/cloud_api_client`, `crates/cloud_api_types`):

- **One host** `https://cloud.zed.dev` serves both the account API and the LLM API. `api.zed.dev` is the unrelated collab/RPC API.
- **Two auth schemes.** Account API/T: `Authorization: {user_id} {access_token}` (space-separated — *not* Bearer). LLM API: `Authorization: Bearer {llm_token}`, minted per-organization by `POST /client/llm_tokens` with `{"organization_id": …}`.
- **Login is RSA, not OAuth2.** Generate an RSA keypair → open `/native_app_signin?native_app_port&native_app_public_key` → browser redirects to `http://127.0.0.1:{port}/` with the `access_token` RSA-encrypted against the public key → decrypt locally (OAEP-SHA256, PKCS#1 v1.5 fallback). No client_id/secret, no refresh token.
- **`POST /completions` is a pass-through relay, not OpenAI-shaped.** Body is `{thread_id, prompt_id, provider, model, provider_request}` where `provider_request` is the raw provider-native body; `provider` ∈ `Anthropic | Baseten | OpenAi | Google | XAi`. The response is **NDJSON**, one JSON object per line, each `{"event": …}` or `{"status": …}`, terminated by a `stream_ended` status. Errors arrive as `{code, message, upstream_status, retry_after}`.
- **The trial is metered server-side as a dollar credit, not bandwidth or tokens:** "$5 of GPT Luna and unlimited edit predictions for 14 days from trial start". There is **no balance/remaining-credit endpoint** — `PlanInfo.usage` only covers edit predictions.
- **Trial exhaustion == HTTP 402** on `/completions` (the client renders it as "payment required to use this language model"). Per-account state is readable from `GET /client/users/me` → `plan.plan_v3` (`zed_pro_trial`/`zed_pro`/`zed_free`/…), `trial_started_at` (RFC3339), `subscription_period.{started_at,ended_at}`, `is_account_too_young`, `has_overdue_invoices`.
- **There is a second, per-IP gate.** "Trial access is blocked" exists only server-side (nothing in the client crate emits it), so an account needs a unique egress IP as well as unique credentials — give every CapnZed connection its own sticky proxy pool.

**Behaviour:** trial + Pro are served; everything else (`zed_free`/`student`/`business`/`vip`, too-young, overdue) is refused pre-flight and the account is parked until the trial window ends (`subscription_period.ended_at` → `trial_started_at + 14d` → `now + 30d`, clamped to 31d). A spent account locks **every model at once** (`modelLock___all`) because the credit is account-wide, and `src/sse/services/auth.js` honours the full CapnZed window instead of the generic 30-minute cap.

**Quota tracker:** the dashboard card is built from `GET /client/users/me` (plan + trial window) plus 9capn's **own ledger**, because Zed exposes no balance endpoint. `applyCapnZedSpend()` (`services/usage/capnzed.js`) folds in `getProviderSpend()` (`src/lib/db/repos/usageRepo.js`), which sums the recorded `cost` of this connection's CapnZed requests since the trial/period start — so the credit row is a **local estimate at list prices**, never Zed's number, and the card message says so. The row declares `unit: "USD"` (rendered with a `$` by `QuotaTable`) and `recurring: false` (the trial credit never refills → "expires in"). A paid `zed_pro` account has no credit to draw a bar against, so its spend is reported as text instead. Credit/day constants live in `shared/capnzedAuth.js` (`CAPNZED_TRIAL_CREDIT_USD`, `CAPNZED_TRIAL_DAYS`); the branch that preserves `unit`/`remainingPercentage` for the dashboard is `case "capnzed"` in `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` (the generic fallback drops both).

**Connecting an account.** Two paths reach the same `exchangeTokens(provider, callbackUrl, null, rsaPrivateKey, state)` call — the auto path in `lib/oauth/utils/server.js` (the local callback listener decrypts and saves by itself) and the **manual paste** in `POST /api/oauth/capnzed/exchange`. The paste is not a fallback nicety: Zed redirects the browser to `http://127.0.0.1:{port}/`, so when 9router runs anywhere other than the user's machine the redirect always fails to load and the paste box is the *only* way in. The route therefore resolves the RSA private key **from the session registered by `/register-session`** (a `codeVerifier` in the body still wins) — do not make it require `codeVerifier`/`redirectUri` like the generic authorization-code path, or every remote connect dies with "Missing required fields". `tests/unit/capnzed-connect-manual.test.js` pins this.

**Decryption must fail loudly.** `decryptCapnZedAccessToken()` tries OAEP-SHA256 then PKCS#1 v1.5, and both results are validated with `looksLikeAccessToken()` (printable header-safe ASCII, 16–8192 chars). OpenSSL 3 implements *implicit rejection* for PKCS#1 v1.5, so a wrong-key or stale callback returns random bytes instead of throwing — without the guard that garbage gets saved as a working-looking connection which then 401s/403s later with a message that points nowhere. A wrong paste must 500, never `success: true`.

**Model catalog.** `registry/capnzed.js` carries a static floor of the ids Zed's own client ships (its `agent.default_model` uses e.g. `provider: "zed.dev", model: "gpt-5.6-sol"`), because the dashboard picker needs a list before a connection exists. The **live** `GET /models` response stays authoritative and per-model (`display_name`, `provider`, `max_token_count`, `supports_images/thinking`, `supported_effort_levels`), and `passthroughModels` keeps unknown ids working. The connection page reads it through the `capnzed` entry in `src/app/api/providers/[id]/models/route.js`, which falls back to the static list with a warning when the account cannot be read. Re-derive the static list after a client update:

```
strings -n 4 -t d ~/.local/zed.app/libexec/zed-editor | grep -n "Claude Opus 5Claude Opus 4.8"
# prints the display names table, followed by the same-order id table
```

Relay-provider mapping matters because it picks the body shape: `claude*`→Anthropic, `gemini*`→Google, `grok*`→XAi, `gpt*`→OpenAi, and the open-weight families (`deepseek`, `glm`, `kimi`, `minimax`, `mimo`, `qwen`, `hy3`, `muse-spark`)→**Baseten** (Chat Completions, *not* Responses). `normalizeCapnZedProvider()` only guesses; the live catalog's explicit `provider` wins.

**When Zed updates, re-check in this order:** (1) the trial copy in `crates/language_models/src/provider/cloud.rs` (credit amount + day count — currently $5 / 14 days, mirrored in `CAPNZED_TRIAL_CREDIT_USD`); (2) `plan.rs` `PlanInfo` fields and `Plan` variants; (3) whether the 402 mapping in `language_models_cloud.rs` still marks `ProviderErrorCategory::PaymentRequired`; (4) the `x-zed-*` header names in `cloud_llm_client.rs` (including `x-zed-minimum-required-version`, which the server uses to force client upgrades); (5) the `LanguageModelProvider` enum (a new relay provider must be added to `normalizeCapnZedProvider` — `baseten` was missing upstream and silently sent to `OpenAi`, i.e. the wrong body shape).

## Pitfalls

- OpenAI bridge is lossy (thinking, non-base64 images, tool ids, is_error) — prefer a direct route for fragile pairs.
- `registry/index.js` is an auto-generated static import list; regenerate it (don't hand-edit) after adding a `registry/{id}.js`. REGISTRY_TEMPLATE is excluded by design.
- Special binary/protobuf formats (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — handle in their executor.
- `rtk/` + `headroom.js` mutate the request body in-place and are **fail-open**: any error returns null and leaves the body untouched — never throw out of them. RTK skips `is_error`/`status:"error"` tool results to preserve traces.
- `proxyAwareFetch(url, options, proxyOptions)` takes proxyOptions **third**; passing a `signal` there silently drops the connection proxy. For IP-gated providers (zed/capnzed/freebuff) that means egressing from the wrong IP. Always pass `proxyOptions` explicitly on every call.
- CapnZed mints the LLM token per Zed **organization** and gates on the account's plan, so `providerSpecificData` must carry `userId`, `systemId` and `organizationId` — a connection missing `userId` cannot even read its own quota.
- Freebuff's session tier is bound to the egress IP, so `handlers/chatCore/proxyGuard.js` forces `strictProxy` (a failing pool must throw, never fall back to direct) and refuses a request with no pool/relay/legacy proxy. `FREEBUFF_ALLOW_DIRECT=1` opts out of the refusal only.

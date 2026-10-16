# open-sse

Provider-agnostic SSE engine: one OpenAI-style request → any provider (LLM chat, image, embedding, tts, stt, search), streamed back in the client's format.

## Request lifecycle (chat)

`handlers/chatCore.js` → `services/model.js` `parseModel` (resolve `provider/model`) → **RTK for `cursor`** (`rtk/` compresses the source-format `tool_result` / `role:tool` in-place — its translator rewrites those shapes, so this one provider must run **before** translate) → `translator/index.js` `translateRequest` (client format → provider format) → **post-translate savers** (`rtk/` compress for every other provider, `rtk/headroom.js` proxy compress, `rtk/caveman.js` / `rtk/ponytail.js` system inject — all fail-open) → `executors/index.js` `getExecutor(provider)` → `executor.execute()` (streams upstream) → `translateResponse` (provider chunks → client format) → SSE out.

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

## Qoder usage (add-on credits)

`GET https://openapi.qoder.sh/api/v2/quota/usage` — the endpoint `registry/qoder.js` already declares — answers **two credit buckets in one response**, and the dashboard needs both:

- `userQuota` — the plan quota. A Pro Trial reads `total: 300`; a free account reads `total: 0`, and that row is shown either way.
- `addOnQuota` — campaign rewards, what qoder.com renders as *"Add-on Credits → Bonus Credits (Total: N)"*. It is the bucket the daily/event claims pay into, so it stays separate from the plan: a spent trial still holds its bonus. **The key is omitted outright — not sent as zero — when the account holds none** (verified on three reward-less accounts, absent in all three), so it must render no row rather than a 0/0 bar.

`expiresAt` is the **plan's** reset, never the pack's, so the add-on row carries no `resetAt` and sets `recurring: false`. `services/usage/misc.js` `getQoderUsage` tags the bucket `addon`; `case "qoder"` in `ProviderLimits/utils.js` names it **Bonus Credits**, drops the absolute `remaining` (that field is read as a 0-100 percentage) and is the only place forwarding `recurring` for this provider. Both are pinned by `tests/unit/qoder-usage.test.js`.

### Rewards accumulate — and the per-reward list is not on this surface

Per `docs.qoder.com/events/100credits`, claimed Credits **never reset with the day**: *"if you claim 100 Credits today and use 20, then claim another 100 Credits tomorrow, you will have 180 Credits across the two rewards"*, and *"each reward is valid for 30 days from its own claim date"*. The campaign payload states the rule verbatim — `benefit.validity = {"mode":"RELATIVE_DAYS","days":30}`, "Daily reset: 10:00 (UTC+8). Valid for 30 days after claiming." — but it carries **no claim timestamp** (`claimStatus: "CLAIMED"` and nothing else; every key printed), so a pack cannot be dated from it.

qoder.com's own Usage page shows the real thing (*"1 Included Credit Packs → Bonus Credits (Total: 100) Remaining 100 credits. Expires on Oct 20, 2026"*). That list comes from `GET https://qoder.com/api/v2/me/usages/big_model_credits` (found in the web bundle `g.alicdn.com/qbase/qoder/0.0.705/index.js`, which also calls `/api/v1/me/usages/big_model_credits/histories`; its UI keys are `creditPacksList` / `creditPackItem` / `expireTime` / `expiring`). **It is session-cookie auth: it answers 401 Unauthorized to both a PAT (`pt-…`) and an exchanged job token, where a missing path answers 404.** Do not re-hunt it on the token surface — measured 2026-09-20 and all dead ends:

| Probe | Result |
|---|---|
| `/api/v2/quota/usage`, `/sash/api/v2/me/usage` (openapi) | 200 — aggregate only |
| `Cosy-ClientType` 1-20 on the sash usage route | identical response for all 20 |
| 15 candidate names on openapi (`/sash/api/v1|v2/me/creditPacks`, `…/packs`, `…/credits`, `…/rewards`, `…/claims`, `/api/v2/creditPack/list`, …) | 404 |
| `center.qoder.sh` equivalents, incl. the histories route | 404 |
| query variants (`?includeCreditPacks`, `?withPacks`, `?detail`, `?quota_key=…`, …) | no change |

So the card reports what the aggregate proves and nothing more: `packs = total / 100` (every grant is `benefit.amount: 100`, and `total` is the sum of live pack sizes), labelled **Bonus Credits (N packs)** when N > 1. The division is only taken when it is exact — a non-multiple stays one pack rather than reporting a fraction. A dated per-reward row needs a source that does not exist here, so never stamp `resetAt` for this bucket.

Fleet note: as of 2026-09-20 no account anywhere held more than one reward (`addon_credits` distribution across 464 rows: `{100: 190, 0: 274}`), because the daily claim only opened 18 Sep — so a genuine multi-pack payload has still never been observed.

## Connection identity (CodeBuddy, Qoder)

CodeBuddy and Qoder both answer a login with an **opaque credential and no profile object**, so `createProviderConnection` had nothing to match on and the same account could be added once per session — stacking `Account N` / `Key N` rows. Identity is now recovered in three places, and all three are needed:

| Layer | File | What it does |
|---|---|---|
| OAuth `mapTokens` | `oauth/providers/codebuddy-{intl,cn}.js` | Decodes the device-flow JWT and returns `email`, `name`, `displayName`, `providerSpecificData.{userId,username}` |
| OAuth `mapTokens` | `oauth/providers/qoder.js` | `name` = `_qoderName` → email → `qoder-<userId[:8]>`; also keeps `providerSpecificData.email` |
| Repo dedup | `db/repos/connectionsRepo.js` | Matches a CodeBuddy row on JWT `sub` (else `providerSpecificData.userId`, else email) and a Qoder row on token → `userId` → email |

The CodeBuddy token is read from **`accessToken` → `refreshToken` → `apiKey`** (`findCodeBuddyJwt`). All three are needed: the device flow stores it as `accessToken`, while the API-key form pastes the same JWT into `apiKey`, which the executor sends as the bearer — reading only the first two dedups one path and stacks rows on the other.
| API-key intake | `app/api/providers/route.js` | Exchanges a pasted Qoder PAT (`/api/v1/jobToken/exchange` → `/api/v1/userinfo`) to learn `email`/`name`/`userId` before saving |

**Why `name` and `email` must be filled at the provider layer:** `createProviderConnection` prefers `data.name` verbatim, and its OAuth branch only runs for rows that carry an `email`. A CodeBuddy token with no `email` claim therefore gets a **synthetic but stable** fallback (`cb-<sub>` / `cb-cn-<sub>`, `qoder-user-<userId>`) — synthetic is the point: it is stable across logins, so the second login folds onto the first row instead of creating a new one.

**Qoder's PAT is opaque**, so the exchange in `route.js` is the only way to name a pasted key. It is wrapped in a bare `try {} catch {}` **on purpose**: an unreachable `openapi.qoder.sh` must still save the connection, because the key itself does not depend on the lookup — the row just keeps the caller's name and no email. The `name` rewrite is also conditional (`/^Key \d+$/.test(name)`), so an operator-chosen label is never overwritten.

**Two traps when touching this:** the codebuddy branch deliberately does **not** check `authType`, because the same identity can arrive as `oauth` and as `apikey` and collapsing them is the goal (that is also why the `apiKey` fallback above is not optional); and the JWT decoder is **duplicated** inside `connectionsRepo.js` rather than imported from `lib/oauth/providerHelpers.js`, because the DB layer must not reach into the OAuth layer. Both dedup paths, the synthetic fallbacks and the PAT exchange are pinned by `tests/unit/qoder-codebuddy-dedup.test.js`.

## CodeBuddy intl channel verification

`www.codebuddy.ai` (and the `workbuddy.ai` brand host) gates chat on a **header family the official IDE sends**: a request without `X-Conversation-ID`, `X-Conversation-Request-ID` and `X-Conversation-Message-ID` is answered `HTTP 400 code 11128 "conversation id missing"`, with `displayTips` saying the call "failed channel verification". The gate appeared on 2026-10-15 and broke **every** `cbai/*` request until the family was sent. `codebuddy-cn` (copilot.tencent.com) is not gated.

`CodeBuddyIntlExecutor.buildHeaders` attaches the family (`withConversationHeaders` in `open-sse/executors/codebuddy-intl.js`):

- **All three headers are required.** Measured A/B against the live gateway: any two of them are still answered `11128`.
- **`X-Request-ID` is not required** — it mirrors the message id because the official client sends it.
- `X-Conversation-ID` is derived stably from the session key (or the opening user message) so retries and later turns keep it; the per-call ids are fresh, and a **second pass over the same bag does not rotate them** (a retry must reuse the pair).
- Reads and writes are **case-insensitive** — a caller's `x-conversation-id` is found, not shadowed by a duplicate that undici would join into `"caller, ours"`.
- `buildHeaders` **fails closed**: an unexpected failure throws a message that names the gate, because a request without the family is refused every time and a silent fall-through would be a 100%-failure with no cause.
- `parseError` recognises the gate and names it. Code `11128` is **overloaded** — it also carries `"first message is not system prompt"` (a body-shape problem fixed in `transformRequest`), so the branch keys on the **message**, never the code alone.

**The gate can change without any code change here.** Unit tests mock the gateway, so they cannot see it. Run the live smoke test when touching this provider, or on a schedule:

```
CODEBUDDY_INTL_TOKEN=<token> node scripts/test-codebuddy-intl-channel.mjs
```

Exit `0` = family accepted · `1` = the gate rejected it (required headers changed — re-measure) · `2` = probe could not run. It makes one tiny real inference call, so do not loop it against a metered account.

## Pitfalls

- A `registry/{id}.js` entry is in the **client** bundle (`src/shared/constants/providers.js` → dashboard shell). Import only *import-free* modules from it; importing a wire layer drags `proxyFetch` in, and `next build` then **fails** on `Module not found: Can't resolve 'net'` / `UnhandledSchemeError: node:assert` — the Fly deploy runs that build, so this is a deploy-blocker, not a warning.
- `OAuthModal` keeps a **hardcoded** `deviceCodeProviders` list while the route serves `/device-code` for anything whose provider declares `flowType: "device_code"`. A provider missing from that list dies on Connect with "uses device-code login but is not wired in the OAuth modal device-code list". The two must agree — the wiring test derives the list from `PROVIDERS` and fails on either a missing or a stale entry.
- OpenAI bridge is lossy (thinking, non-base64 images, tool ids, is_error) — prefer a direct route for fragile pairs.
- `registry/index.js` is an auto-generated static import list; regenerate it (don't hand-edit) after adding a `registry/{id}.js`. REGISTRY_TEMPLATE is excluded by design.
- Special binary/protobuf formats (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — handle in their executor.
- `rtk/` + `headroom.js` mutate the request body in-place and are **fail-open**: any error returns null and leaves the body untouched — never throw out of them. RTK skips `is_error`/`status:"error"` tool results to preserve traces.
- `proxyAwareFetch(url, options, proxyOptions)` takes proxyOptions **third**; passing a `signal` there silently drops the connection proxy. For IP-gated providers (zed) that means egressing from the wrong IP. Always pass `proxyOptions` explicitly on every call.

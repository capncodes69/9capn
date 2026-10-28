# 9capn

A fork of [decolua/9router](https://github.com/decolua/9router) that fixes the
CodeBuddy (`cbai/*`) provider and adds production deployment for
[`9capnrouter`](https://9capnrouter.fly.dev).

**Upstream's README was removed.** It documents 9router, not this fork — every
instruction in it (install, provider setup, dashboard tour) describes a tree you are
not running. What follows is the only thing upstream's README cannot tell you: what
this fork changes, and why.

- Base: upstream `v0.5.111` (`3a978a63`, 2026-10-26)
- This tree: `master`, 4 commits on top
- Scope of the diff: **19 files, +1746 / −22** against `upstream/master`

---

## 1. CodeBuddy (`codebuddy-intl`)

The fork exists for this. Upstream's `codebuddy-intl` is broken against the live
gateway in three independent ways, and each one was fixed separately.

### 1.1 What the gateway rejects, and what this fork sends instead

| | Upstream `master` | 9capn `master` |
| --- | --- | --- |
| `X-Conversation-*` family | **not sent** → every chat answers `400 / 11128 "conversation id missing"` | all three sent, plus `X-Request-ID` |
| `X-Conversation-ID` | — | stable per conversation (SHA-1 → RFC-4122-v5 shape), so retries and later turns keep it |
| `X-Conversation-Request-ID` | — | fresh 32-hex per request, **mirrored into `X-Request-ID`** as the client does |
| `X-Conversation-Message-ID` | — | fresh dashed UUID per request |
| `User-Agent` | `IDE/2.108.1 CodeBuddy/2.108.1` | `CodeBuddyIDE/4.12.1 CodeBuddy/1.106.1` |
| `X-IDE-Type` / `X-IDE-Name` | `IDE` | `CodeBuddyIDE` |
| `X-IDE-Version` | **not sent** | `4.12.1` |
| `X-Product-Version` | **not sent** | `1.106.1` |
| `X-Domain` | **not sent** | `www.codebuddy.ai` |
| `X-User-Id` | **not sent** | from `providerSpecificData.userId` |
| `X-Model-ID` | **not sent** | from the request model |
| `X-Trace-ID` / `X-B3-*` / `b3` | **not sent** | full W3C + B3 trace family |
| Headers sent per request | **6** | **24** |

The identity values were read out of the shipped 4.12.1 desktop client, not guessed:
`product.json`, `product-ide.json`, `out/codebuddy/main.js` (`buildUserAgent`) and
`extensions/genie/out/extension/index.js` (the header builder). All of them live in
`open-sse/config/codebuddyIdentity.js` with the file each value came from.

### 1.2 Failure classification

`11128` and `11140` are different failures with different causes, and upstream
conflates them.

| Code | Meaning | Upstream behaviour | 9capn behaviour |
| --- | --- | --- | --- |
| `11128` "conversation id missing" | channel verification — not sent from an official client | request-scoped catch-all → `cooldownMs: 0`, re-fires into the refusal forever | `parseError` names the gate; the `X-Conversation-*` family removes the cause |
| `11128` "first message is not system prompt" | body shape | same catch-all | branched on the **message**, not the code, so it is not mislabelled as a gate |
| `11140` "account restricted / unusual activity" | risk engine flagged the client identity | no rule → no backoff | still no rule — this one is addressed by 1.1, not by backoff |
| `14018` "Credits exhausted" | quota | `429` backoff | same |

### 1.3 WorkBuddy (`workbuddy.ai`)

Both brands are one gateway with separate Keycloak realms
(`issuer: https://www.<brand>.ai/auth/realms/copilot`), so a token minted on one is
rejected by the other.

| | Upstream | 9capn |
| --- | --- | --- |
| `brandHost()` in the OAuth provider | **absent** | present; accepts `codebuddy.ai`, `workbuddy.ai`, with or without `www.` |
| Device-code host | hardcoded `www.codebuddy.ai` | `options.domain` selects the host; `_brandHost` is echoed back |
| Poll host | hardcoded | reads `extraData.domain` / `_brandHost` |
| Per-call id shape on the WorkBuddy host | — | hyphen-less UUIDv7 (measured difference between the hosts) |
| Identity on `workbuddy.ai` | — | `isWorkBuddyHost()` switches the id family automatically |

### 1.4 DNS blackhole

The CodeBuddy CDN answers its A record with `0.0.0.1` for some resolvers. On a
deployment whose resolver is one of those, every call dies as a 10 s connect timeout
and the device flow reports `no device code for codebuddy-intl`.

| | Upstream | 9capn |
| --- | --- | --- |
| `open-sse/utils/brandDns.js` | **deleted** | present: resolves brand hosts via `1.1.1.1` / `8.8.8.8`, refuses the blackhole answer, pins the socket to the vetted address |
| `proxyFetch.js` integration | removed | pins only when no proxy is configured (a proxy resolves DNS on its own side) |
| TLS verification | — | unchanged — only the address is pinned, the hostname is still verified |

Measured on the deployment this fork was built for: `10_554 ms` timeout before the
pin, `66 ms` with it.

### 1.5 Account dedup

Upstream deleted the CodeBuddy identity block from `connectionsRepo.js` and did not
move it anywhere. Without it, a re-login of the same account stacks a second row, and
the newer row shadows the older one on rotation.

| | Upstream | 9capn |
| --- | --- | --- |
| `findCodeBuddyJwt` / `codeBuddyIdentity` / `codeBuddyEmail` | **removed** | present |
| Identity source | email only, gated on `data.email` | JWT `sub` first, then email — CodeBuddy's device flow returns no profile object, so email alone is not always there |
| Identity matched across authTypes | no | yes — the same JWT pasted as `apiKey` and returned by the device flow are one account |
| Same account imported twice | two rows | collapses onto the existing row |

### 1.6 Account rotation

| | Upstream | 9capn |
| --- | --- | --- |
| Selection order | priority ascending → the front of the pool is drained until it dies | `pickNextConnection()`: least-recently-used first (a never-used account counts as oldest), then lowest consecutive-use count, then priority |
| Level-15 backoff | still selected | `shouldSkipForBackoff()` keeps it out of rotation entirely |
| Wired into the request path | — | **no** — both helpers are exported and tested but not yet called from `open-sse/services/accountFallback.js` |

Measured on a live 310-account pool: the three accounts the gateway restricted
(`11140`) had 6 / 13 / 14 model locks and were 56–62 days old; the only healthy
accounts were 0–3 hours old and had never been used.

---

## 2. Deployment

| | Upstream | 9capn |
| --- | --- | --- |
| `fly.toml` | **absent** | present: `app = "9capnrouter"`, `primary_region = "sin"`, internal port `20128` |
| `.github/workflows/deploy-fly.yml` | **absent** | present: deploys on push to `master` via `flyctl deploy --config fly.toml --remote-only`, gated on `FLY_API_TOKEN` |

---

## 3. Tests

| | Upstream | 9capn |
| --- | --- | --- |
| CodeBuddy test files | 6 | **14** |
| `codebuddy-intl-identity` | removed | restored (276 lines): JWT claims, `mapTokens`, dedup |
| `codebuddy-intl-conversation-headers` | removed | restored + corrected: `X-Conversation-Request-ID` mirrors `X-Request-ID` |
| `codebuddy-intl-brand-dns` | removed | restored: blackhole refusal, pinning |
| `codebuddy-intl-waf-backoff` | removed | restored |
| `codebuddy-intl-live` | removed | restored (skipped unless `CODEBUDDY_LIVE=1`) |
| `codebuddy-intl-official-identity` | — | new: the 4.12.1 identity values |
| `codebuddy-intl-request-identity` | — | new: trace family, mirrored ids, user/model headers |
| `codebuddy-intl-rotation` | — | new: LRU selection, backoff gate |
| `usage-static-bearer` | removed | restored |
| `known-fails.txt` | 37 entries | taken from upstream; **not yet regenerated** against this tree |

Current state: **3706 pass, 29 fail** across `tests/unit/`. None of the 29 are in a
CodeBuddy suite — the CodeBuddy set is 45/45 green. `codebuddy-block-backoff` fails
5/11, and it fails **identically on a clean `upstream/master` worktree**, so it is a
pre-existing upstream failure, not a fork regression.

---

## 4. Divergence notes

The fork's history was squashed to one commit, so `git merge-base` between this tree
and upstream returns nothing. Bringing upstream in required
`--allow-unrelated-histories` and resolving 54 conflicts by policy: upstream wins
everywhere except the CodeBuddy and deployment files listed above.

That merge also dropped three things that had to be restored afterwards —
`connectionsRepo.js`'s CodeBuddy dedup, the `proxyFetch.js` / `brandDns.js`
integration, and the rotation helpers. See commit `7fd7c8d1`. If you merge upstream
again, re-check those three; upstream deletes them on purpose and will keep doing so.

Two upstream changes were **not** taken, deliberately:

| Upstream change | Why it is not here |
| --- | --- |
| `errorConfig.js` codebuddy rules | upstream already carries both at lines 63-64; our branch had duplicated them at 41-42 as well. Upstream's version is the clean one. |
| `combo.js` `checkFallbackError` provider argument | upstream already passes `provider`; our branch only added explanatory comments. Nothing functional was lost. |

---

## 5. Updating the client identity

There is no endpoint that returns the current CodeBuddy version — `/v2/config`,
`/v2/update`, `latest.yml` and `/v2/plugin/version` all answer 404, and the plugin
VSIX behind `/v2/plugin/download?platform=…` is 403-locked. The only source is the
release artifact:

```bash
# The macOS build is a plain ZIP; the Windows .exe is a customised Inno Setup 6.7.0
# that innoextract 1.9 and 1.10-dev both refuse.
curl -O https://download.codebuddy.ai/aiide/darwin-arm64/CodeBuddy-darwin-arm64-<ver>-<commit>.zip
# read Contents/Resources/app/product.json       -> nameShort, version, genieVersion
# read Contents/Resources/app/product-ide.json   -> platform
# then update open-sse/config/codebuddyIdentity.js and re-run:
cd tests && npx vitest run unit/codebuddy-intl-official-identity.test.js
```

This is a manual step by design. A version no client ever sent is worse than a
slightly stale one: the gateway rejects implausible identities, not old ones.

**Known gap:** `X-Device-Token` comes from Tencent's Turing Shield SDK
(`turingShieldService.getDeviceToken()`). It cannot be synthesised here, so requests
from this fork are still distinguishable from a real IDE by that one header.

---

## 6. Running it

Nothing here differs from 9router's own operation, which upstream's README documents
and this file does not repeat. The two commands this fork adds:

```bash
# Local
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev

# Deploy (also runs on push to master)
flyctl deploy --config fly.toml --remote-only
```

Environment contract: see `.env.example`. Security-sensitive variables
(`JWT_SECRET`, `INITIAL_PASSWORD`, `API_KEY_SECRET`, `MACHINE_ID_SALT`) must be
overridden before the dashboard is exposed.

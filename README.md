# 9capn

Fork of [decolua/9router](https://github.com/decolua/9router) that fixes the CodeBuddy
(`cbai/*`) provider. 9router's own README was removed — it documents a tree you are not
running. This file covers only what the fork changes.

Base: 9router `v0.5.111` (`3a978a63`) · 9 commits on top · code diff **19 files, +1746 / −22**

---

## CodeBuddy: request headers

9router sends 6 headers and no conversation ids, so every chat answers
`400 / 11128 "conversation id missing"`.

| | 9router | 9capn |
| --- | --- | --- |
| `X-Conversation-ID` | not sent | stable per conversation (SHA-1 → RFC-4122-v5) |
| `X-Conversation-Request-ID` | not sent | fresh 32-hex, **mirrored into `X-Request-ID`** as the client does |
| `X-Conversation-Message-ID` | not sent | fresh dashed UUID per request |
| `User-Agent` | `IDE/2.108.1 CodeBuddy/2.108.1` | `CodeBuddyIDE/4.12.1 CodeBuddy/1.106.1` |
| `X-IDE-Type` / `X-IDE-Name` | `IDE` | `CodeBuddyIDE` |
| `X-IDE-Version` / `X-Product-Version` | not sent | `4.12.1` / `1.106.1` |
| `X-Domain` | not sent | `www.codebuddy.ai` |
| `X-User-Id` / `X-Model-ID` | not sent | from credentials / request model |
| `X-Trace-ID`, `X-B3-*`, `b3` | not sent | full W3C + B3 trace family |
| **Total per request** | **6** | **24** |

Values were read out of the shipped 4.12.1 client, not guessed: `product.json`,
`product-ide.json`, `out/codebuddy/main.js` (`buildUserAgent`) and
`extensions/genie/out/extension/index.js` (header builder). All live in
`open-sse/config/codebuddyIdentity.js` with the file each value came from.

## CodeBuddy: failure codes

| Code | Meaning | 9router | 9capn |
| --- | --- | --- | --- |
| `11128` conversation id missing | channel verification | request-scoped catch-all → `cooldownMs: 0`, re-fires forever | `parseError` names the gate; headers above remove the cause |
| `11128` first message not system | body shape | same catch-all | branched on the **message**, so not mislabelled as a gate |
| `11140` account restricted | risk engine flagged the identity | no rule, no backoff | same — addressed by the headers, not by backoff |
| `14018` credits exhausted | quota | `429` backoff | same |

## WorkBuddy (`workbuddy.ai`)

One gateway, separate Keycloak realms (`issuer: https://www.<brand>.ai/auth/realms/copilot`),
so a token from one brand is rejected by the other.

| | 9router | 9capn |
| --- | --- | --- |
| `brandHost()` | absent | accepts `codebuddy.ai` / `workbuddy.ai`, with or without `www.` |
| Device-code + poll host | hardcoded `www.codebuddy.ai` | `options.domain`, echoed back as `_brandHost` |
| Id shape on the WorkBuddy host | — | hyphen-less UUIDv7, switched by `isWorkBuddyHost()` |

## DNS blackhole

The CDN answers `0.0.0.1` for some resolvers; every call then dies as a 10 s connect
timeout and the device flow reports `no device code for codebuddy-intl`.

| | 9router | 9capn |
| --- | --- | --- |
| `open-sse/utils/brandDns.js` | deleted | resolves via `1.1.1.1` / `8.8.8.8`, refuses the blackhole, pins the socket to the vetted address |
| `proxyFetch.js` | integration removed | pins only when no proxy is set; TLS still verifies the hostname |

Measured on the deployment this fork was built for: **10 554 ms → 66 ms**.

## Account dedup

9router deleted the CodeBuddy identity block from `connectionsRepo.js` and moved it
nowhere. Without it a re-login of the same account stacks a second row, and the newer
row shadows the older on rotation.

| | 9router | 9capn |
| --- | --- | --- |
| `findCodeBuddyJwt` / `codeBuddyIdentity` / `codeBuddyEmail` | removed | present |
| Identity source | email only, gated on `data.email` | JWT `sub` first, then email — the device flow returns no profile object |
| Matched across authTypes | no | yes — the same JWT as `apiKey` and from the device flow is one account |

## Account rotation

| | 9router | 9capn |
| --- | --- | --- |
| Selection | priority ascending → the front of the pool drains until it dies | `pickNextConnection()`: least-recently-used first, then fewest consecutive uses, then priority |
| Level-15 backoff | still selected | `shouldSkipForBackoff()` keeps it out entirely |
| Wired into the request path | — | **no** — both helpers are exported and tested but not yet called from `accountFallback.js` |

Live 310-account pool: the three accounts the gateway restricted had 6 / 13 / 14 model
locks and were 56–62 days old; the only healthy ones were 0–3 hours old, never used.

## Tests

| | 9router | 9capn |
| --- | --- | --- |
| CodeBuddy test files | 6 | **14** |
| `-identity`, `-conversation-headers`, `-brand-dns`, `-waf-backoff`, `-live`, `usage-static-bearer` | removed | restored |
| `-official-identity`, `-request-identity`, `-rotation` | — | new |

`tests/unit/`: **3706 pass, 29 fail**. CodeBuddy suites are **45/45 green**.
`codebuddy-block-backoff` fails 5/11 — identically on a clean 9router worktree, so it is
pre-existing, not a fork regression. `known-fails.txt` is still 9router's and has not
been regenerated against this tree.

---

## Notes

**Merging 9router again.** The fork's history was squashed, so `git merge-base` returns
nothing; bringing upstream in needs `--allow-unrelated-histories`. Policy: 9router wins
everywhere except the files above. The last merge silently dropped three things that had
to be restored — the dedup block, the `proxyFetch`/`brandDns` integration, and the
rotation helpers. Re-check those three every time.

**Updating the client identity.** No endpoint returns the current version — `/v2/config`,
`/v2/update`, `latest.yml`, `/v2/plugin/version` are 404 and the plugin VSIX is 403. Read
it from the release artifact (`CodeBuddy-darwin-arm64-<ver>-<commit>.zip` is a plain ZIP;
the Windows `.exe` is a customised Inno Setup that `innoextract` refuses), then update
`open-sse/config/codebuddyIdentity.js` and run
`npx vitest run unit/codebuddy-intl-official-identity.test.js`. Manual by design: a
version no client ever sent is worse than a slightly stale one.

**Known gap.** `X-Device-Token` comes from Tencent's Turing Shield SDK and cannot be
synthesised here, so requests are still distinguishable from a real IDE by that header.

**Deploying.** 9capn runs like 9router — `npm run dev`, or any Node host or container.
`fly.toml` and `.github/workflows/deploy-fly.yml` are included for one deployment that
happens to use Fly; no code imports them, so delete them if you don't. The portable
contract is `.env.example` plus `PORT` (default `20128`). Override `JWT_SECRET`,
`INITIAL_PASSWORD`, `API_KEY_SECRET` and `MACHINE_ID_SALT` before exposing the dashboard.

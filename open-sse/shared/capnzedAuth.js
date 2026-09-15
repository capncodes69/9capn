// CapnZed — 9capn's own Zed hosted-models provider, scoped to the free Pro trial.
//
// WHY THIS FILE EXISTS (and why it does not import open-sse/shared/zedAuth.js)
// -----------------------------------------------------------------------------
// Zed's hosted LLM aggregator (cloud.zed.dev) is metered per ACCOUNT, not per
// API key: a fresh account gets a Pro *trial* worth "$5 of GPT Luna and unlimited
// edit predictions for 14 days from trial start" (verbatim from the Zed client's
// own plan description, crates/language_models/src/provider/cloud.rs). When the
// credit is spent the server answers **HTTP 402** on POST /completions. So the only
// way to keep working is to rotate across many trial accounts — which is exactly
// what this module implements, plus the per-account sticky-egress plumbing Zed's
// anti-abuse gate needs.
//
// It is deliberately self-contained: it shares NO code with the upstream `zed`
// provider so that upstream can change or delete its own Zed files without
// affecting CapnZed. The wire facts below were reverse-engineered from the Zed
// 1.19.2 release binary (crates/language_models_cloud, crates/cloud_llm_client,
// crates/cloud_api_client, crates/cloud_api_types) and confirmed against the
// upstream source pinned at that exact commit.
//
// WIRE FACTS THIS MODULE RELIES ON
// -----------------------------------------------------------------------------
//   Auth (account API)  Authorization: "{user_id} {access_token}"   — NOT Bearer.
//                       See cloud_api_client.rs::build_request + its unit tests.
//   Auth (LLM API)      Authorization: "Bearer {llm_token}"         — exchanged
//                       per-organization from POST /client/llm_tokens.
//   Base host           https://cloud.zed.dev serves BOTH the account API and the
//                       LLM API. api.zed.dev is the unrelated collab/RPC API.
//   Login               RSA keypair (not OAuth2): generate keypair → open
//                       /native_app_signin?native_app_port&native_app_public_key →
//                       browser redirects to http://127.0.0.1:{port}/ with an
//                       RSA-encrypted access_token → decrypt locally.
//   POST /completions   Pass-through relay, NOT OpenAI-shaped:
//                       { thread_id, prompt_id, provider, model, provider_request }
//                       where provider_request is the raw PROVIDER-NATIVE body.
//                       Response is NDJSON (one JSON object per line), each line
//                       shaped { "event": ... } or { "status": ... }; the stream is
//                       terminated by a "stream_ended" status.
//   GET  /models        Server-authoritative catalog. NEVER hardcode models.
//   GET  /client/users/me
//                       Returns plan state, including:
//                         plan.plan_v3            "zed_pro_trial" | "zed_pro" | "zed_free" | …
//                         plan.trial_started_at   RFC3339
//                         plan.subscription_period { started_at, ended_at } RFC3339
//                         plan.is_account_too_young / plan.has_overdue_invoices
//                       (cloud_api_types/src/plan.rs::PlanInfo — the field is named
//                        plan_v3 on the wire, and KnownOrUnknown is untagged so the
//                        plan value is a plain JSON string.)
//   Trial exhaustion    HTTP 402 on /completions. The Zed client maps it to
//                       "payment required to use this language model; please
//                       upgrade your account" (language_models_cloud.rs), and there
//                       is NO balance/remaining-credit endpoint — 402 is the only
//                       authoritative "this account is spent" signal.
//
// POLICY (chosen for 9capn; see AGENTS notes)
// -----------------------------------------------------------------------------
//   * zed_pro_trial  → served (the whole point)
//   * zed_pro        → served (a paid account is strictly more capable)
//   * anything else  → refused pre-flight, and the account is parked until the
//                      trial window lapses (see capnZedLockUntilMs)
//   * is_account_too_young / has_overdue_invoices → refused, same parking
//
// One account == one connection. Give each connection its own sticky proxy pool:
// Zed's trial gate is ALSO enforced per egress IP ("Trial access is blocked"), so
// account + IP must both vary together.

import crypto from "node:crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const CAPNZED_PROVIDER_ID = "capnzed";

export const CAPNZED_WEB_BASE_URL = "https://zed.dev";
export const CAPNZED_CLOUD_BASE_URL = "https://cloud.zed.dev";

/** Zed's own header vocabulary (names copied from cloud_llm_client.rs constants). */
export const CAPNZED_HEADERS = {
  version: "x-zed-version",
  systemId: "x-zed-system-id",
  expiredToken: "x-zed-expired-token",
  outdatedToken: "x-zed-outdated-token",
  clientSupportsStatus: "x-zed-client-supports-status-messages",
  clientSupportsStreamEnded:
    "x-zed-client-supports-stream-ended-request-completion-status",
  serverSupportsStatus: "x-zed-server-supports-status-messages",
  clientSupportsXai: "x-zed-client-supports-x-ai",
  minimumRequiredVersion: "x-zed-minimum-required-version",
};

/** Trial length, straight from the client's plan copy ("14 days from trial start"). */
export const CAPNZED_TRIAL_DAYS = 14;

/**
 * Trial credit, from the same client copy ("Your Pro trial includes $5 of GPT
 * Luna ... for 14 days from trial start").
 *
 * There is NO endpoint that reports the remaining balance — the amount is only
 * revealed by a 402 on POST /completions — so the tracker can show the allowance
 * but must label whatever it draws against it as an estimate.
 */
export const CAPNZED_TRIAL_CREDIT_USD = 5;

/** Fallback parking window when we cannot compute a real trial end (e.g. the
 *  plan is already zed_free, so "trial end" is in the past). Long enough that a
 *  spent account stops being re-poked, short enough to re-check eventually. */
export const CAPNZED_FALLBACK_LOCK_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard ceiling for a CapnZed cooldown (mirrors markAccountUnavailable's
 *  provider-specific bypass in src/sse/services/auth.js). */
export const CAPNZED_MAX_LOCK_MS = 31 * 24 * 60 * 60 * 1000;

/** Plans CapnZed will actually serve. Trial first; Pro is a superset. */
export const CAPNZED_ALLOWED_PLANS = new Set(["zed_pro_trial", "zed_pro"]);

/** Human labels for dashboard/errors, mirroring the Zed client vocabulary. */
const PLAN_LABELS = {
  zed_free: "Zed Free",
  zed_pro: "Zed Pro",
  zed_pro_trial: "Zed Pro Trial",
  zed_student: "Zed Student",
  zed_business: "Zed Business",
  zed_vip: "Zed VIP",
};

/** Codes surface in errors/logs so a rotation is diagnosable after the fact. */
export const CAPNZED_LOCK_CODES = {
  planNotEligible: "capnzed_plan_not_eligible",
  trialExhausted: "capnzed_trial_exhausted",
  accountTooYoung: "capnzed_account_too_young",
  overdueInvoices: "capnzed_overdue_invoices",
  trialBlocked: "capnzed_trial_blocked",
};

const PRIVATE_KEY_PREFIX = "capnzed-rsa-pkcs1:";
const LLM_TOKEN_TTL_MS = 50 * 60 * 1000;
const MODELS_TTL_MS = 60 * 60 * 1000;
const PLAN_TTL_MS = 5 * 60 * 1000;

const llmTokenCache = new Map();
const modelCache = new Map();
const modelInflight = new Map();
const planCache = new Map();

// ───────────────────────────── small helpers ─────────────────────────────

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function b64urlPadded(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64url(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function normalizeBaseUrl(baseUrl, fallback) {
  return String(baseUrl || fallback).replace(/\/+$/, "");
}

function capnZedUrl(config, key, path, fallbackBase) {
  return `${normalizeBaseUrl(config?.[key], fallbackBase)}${path}`;
}

/** RFC3339 (what Zed serializes Timestamp as) → epoch ms, or null. */
export function parseCapnZedTimestamp(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function tail(value, size = 16) {
  return String(value || "").slice(-size);
}

/** Unwrap `{ token: "..." }` / `{ token: ["..."] }` / a bare string. */
function normalizeLlmToken(payload) {
  const raw = payload?.token ?? payload;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((item) => typeof item === "string");
    return first || null;
  }
  if (raw && typeof raw === "object") {
    if (typeof raw.value === "string") return raw.value;
    if (typeof raw.token === "string") return raw.token;
  }
  return null;
}

// ─────────────────────── RSA native_app_signin flow ───────────────────────

export function encodeCapnZedPrivateKeyVerifier(privateKeyPem) {
  return `${PRIVATE_KEY_PREFIX}${b64url(privateKeyPem)}`;
}

export function decodeCapnZedPrivateKeyVerifier(verifier) {
  const value = String(verifier || "");
  if (!value.startsWith(PRIVATE_KEY_PREFIX)) {
    throw new Error("Missing CapnZed private key verifier; restart the login flow");
  }
  return fromB64url(value.slice(PRIVATE_KEY_PREFIX.length));
}

export function isCapnZedPrivateKeyVerifier(verifier) {
  return String(verifier || "").startsWith(PRIVATE_KEY_PREFIX);
}

/** Generate a fresh RSA keypair + the zed.dev native_app_signin URL bound to it. */
export function createCapnZedNativeAuthData(config = {}, options = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const nativeAppPort = Number(
    options.nativeAppPort || config.defaultNativeAppPort || 58443,
  );
  const systemId = options.systemId || crypto.randomUUID();
  const publicKeyString = b64urlPadded(publicKey);

  const signInUrl = new URL(
    `${normalizeBaseUrl(config.webBaseUrl, CAPNZED_WEB_BASE_URL)}/native_app_signin`,
  );
  signInUrl.searchParams.set("native_app_port", String(nativeAppPort));
  signInUrl.searchParams.set("native_app_public_key", publicKeyString);
  if (systemId) signInUrl.searchParams.set("system_id", systemId);

  return {
    authUrl: signInUrl.toString(),
    privateKeyVerifier: encodeCapnZedPrivateKeyVerifier(privateKey),
    nativeAppPort,
    systemId,
    publicKey: publicKeyString,
  };
}

/** Parse the pasted native-app callback URL/JSON/query into userId + encrypted token. */
export function parseCapnZedCallbackPayload(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Missing CapnZed callback URL");

  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    let url;
    try {
      url = new URL(raw);
    } catch {
      try {
        url = new URL(`http://127.0.0.1/?${raw.replace(/^\?/, "")}`);
      } catch {
        throw new Error("Invalid CapnZed callback URL");
      }
    }
    url.searchParams.forEach((value, key) => {
      data[key] = value;
    });
  }

  const userId = data.user_id || data.userId;
  const encryptedAccessToken = data.access_token || data.accessToken || data.token;
  if (!userId || !encryptedAccessToken) {
    throw new Error("CapnZed callback must include user_id and access_token");
  }
  return { userId: String(userId), encryptedAccessToken: String(encryptedAccessToken) };
}

/**
 * An access token travels in an HTTP header, so it must be a printable, non-empty
 * string. This guard is what keeps a FAILED decryption from looking like a success:
 * OpenSSL 3 implements implicit rejection for PKCS#1 v1.5, so a wrong-key or
 * corrupted ciphertext returns random bytes instead of throwing. Without the check
 * we would happily save a garbage token as a connection, and the account would only
 * fail later (401 / plan gate) with a message that points nowhere.
 */
function looksLikeAccessToken(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 8192) return false;
  if (!/^[\x20-\x7e]+$/.test(value)) return false;
  return value === value.trim();
}

/** Decrypt the RSA-encrypted access token with the private key that never left the host. */
export function decryptCapnZedAccessToken(encryptedAccessToken, privateKeyVerifier) {
  const privateKey = decodeCapnZedPrivateKeyVerifier(privateKeyVerifier);
  const encrypted = Buffer.from(String(encryptedAccessToken), "base64url");
  let oaepError = null;
  try {
    const token = crypto
      .privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        encrypted,
      )
      .toString("utf8");
    if (looksLikeAccessToken(token)) return token;
    oaepError = new Error("OAEP decryption did not yield a token");
  } catch (error) {
    oaepError = error;
  }

  try {
    const token = crypto
      .privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        encrypted,
      )
      .toString("utf8");
    if (looksLikeAccessToken(token)) return token;
  } catch {
    /* fall through to the original error below */
  }

  const message = oaepError instanceof Error ? oaepError.message : String(oaepError);
  throw new Error(
    `Failed to decrypt CapnZed access token: ${message}. The callback URL must come from the ` +
      "same login attempt that produced the keypair (restart the flow and paste a fresh URL).",
  );
}

// ───────────────────────────── account auth ─────────────────────────────

/** "{user_id} {access_token}" — Zed's account-API scheme (not Bearer). */
export function buildCapnZedAccountAuthHeader(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const userId = psd.userId || credentials?.userId;
  const accessToken = credentials?.accessToken || credentials?.apiKey;
  if (!userId || !accessToken) {
    throw new Error("CapnZed credential is missing userId or accessToken");
  }
  return `${userId} ${accessToken}`;
}

function capnZedSystemId(credentials) {
  return String(credentials?.providerSpecificData?.systemId || credentials?.systemId || "");
}

function accountHeaders(credentials) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: buildCapnZedAccountAuthHeader(credentials),
  };
  const systemId = capnZedSystemId(credentials);
  if (systemId) headers[CAPNZED_HEADERS.systemId] = systemId;
  return headers;
}

export function normalizeCapnZedOrganizationId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    if (typeof value[0] === "string") return value[0];
    if (typeof value.id === "string") return value.id;
  }
  return String(value);
}

export function resolveCapnZedOrganizationId(credentials, userInfo = null) {
  const psd = credentials?.providerSpecificData || {};
  const explicit = normalizeCapnZedOrganizationId(
    psd.organizationId || psd.defaultOrganizationId,
  );
  if (explicit) return explicit;
  const fromUser = normalizeCapnZedOrganizationId(
    userInfo?.default_organization_id || userInfo?.defaultOrganizationId,
  );
  if (fromUser) return fromUser;
  const orgs = userInfo?.organizations || [];
  const org = orgs.find((item) => item?.is_personal) || orgs[0];
  return normalizeCapnZedOrganizationId(org?.id);
}

async function fetchJson(url, options, proxyOptions = null) {
  const res = await proxyAwareFetch(url, options, proxyOptions);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const message =
      data?.message || data?.error?.message || data?.error || text || `HTTP ${res.status}`;
    const err = new Error(String(message));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ───────────────────── plan / trial classification ─────────────────────

/**
 * Read the plan block of GET /client/users/me into plain epoch-ms values.
 * Tolerates both snake_case (what Zed emits) and camelCase.
 */
export function parseCapnZedPlanInfo(userInfo) {
  const plan = userInfo?.plan || {};
  const planId = normalizeCapnZedOrganizationId(
    plan.plan_v3 || plan.planV3 || plan.plan_v2 || plan.planV2 || plan.plan || userInfo?.plan_v3,
  ).toLowerCase();

  const period = plan.subscription_period || plan.subscriptionPeriod || null;
  const trialStartedAtMs = parseCapnZedTimestamp(
    plan.trial_started_at || plan.trialStartedAt,
  );

  return {
    planId: planId || null,
    planLabel: planId ? PLAN_LABELS[planId] || planId : "Unknown",
    trialStartedAtMs,
    periodStartedAtMs: parseCapnZedTimestamp(period?.started_at || period?.startedAt),
    periodEndedAtMs: parseCapnZedTimestamp(period?.ended_at || period?.endedAt),
    accountTooYoung: !!(plan.is_account_too_young || plan.isAccountTooYoung),
    hasOverdueInvoices: !!(plan.has_overdue_invoices || plan.hasOverdueInvoices),
  };
}

/** True when the catalog says this account may serve requests. */
export function isCapnZedPlanAllowed(userInfo) {
  const info = parseCapnZedPlanInfo(userInfo);
  return CAPNZED_ALLOWED_PLANS.has(info.planId) && !info.accountTooYoung && !info.hasOverdueInvoices;
}

/**
 * How long a spent/blocked account should stay parked.
 *
 * Order of preference:
 *   1. subscription_period.ended_at   — the real end of the paid/trial window
 *   2. trial_started_at + 14 days     — Zed's documented trial length
 *   3. now + 30 days                  — the plan is already Free, so there is no
 *                                       window to wait for; re-check eventually
 *
 * Clamped to CAPNZED_MAX_LOCK_MS so a bad server value can never lock forever.
 */
export function capnZedLockUntilMs(userInfo, now = Date.now()) {
  const info = parseCapnZedPlanInfo(userInfo);
  const candidates = [];

  if (info.periodEndedAtMs && info.periodEndedAtMs > now) candidates.push(info.periodEndedAtMs);
  if (info.trialStartedAtMs) {
    const trialEnd = info.trialStartedAtMs + CAPNZED_TRIAL_DAYS * 24 * 60 * 60 * 1000;
    if (trialEnd > now) candidates.push(trialEnd);
  }

  const base = candidates.length ? Math.max(...candidates) : now + CAPNZED_FALLBACK_LOCK_MS;
  return Math.min(base, now + CAPNZED_MAX_LOCK_MS);
}

/**
 * Decide whether this account may serve a request, without touching the network.
 * Returns { allowed, code?, reason?, lockUntilMs? }.
 */
export function classifyCapnZedUser(userInfo, now = Date.now()) {
  const info = parseCapnZedPlanInfo(userInfo);

  if (info.accountTooYoung) {
    return {
      allowed: false,
      code: CAPNZED_LOCK_CODES.accountTooYoung,
      reason:
        "This Zed account is too new for hosted-model access. Zed refuses 'too young' accounts — use an older account.",
      lockUntilMs: capnZedLockUntilMs(userInfo, now),
      info,
    };
  }

  if (info.hasOverdueInvoices) {
    return {
      allowed: false,
      code: CAPNZED_LOCK_CODES.overdueInvoices,
      reason:
        "This Zed account has overdue invoices, so Zed is blocking hosted-model usage. Resolve billing or use another account.",
      lockUntilMs: capnZedLockUntilMs(userInfo, now),
      info,
    };
  }

  if (!CAPNZED_ALLOWED_PLANS.has(info.planId)) {
    return {
      allowed: false,
      code: CAPNZED_LOCK_CODES.planNotEligible,
      reason:
        `CapnZed only serves Zed Pro Trial or Zed Pro accounts; this one is on ${info.planLabel}. ` +
        "Start the free trial on that account, or connect a different account.",
      lockUntilMs: capnZedLockUntilMs(userInfo, now),
      info,
    };
  }

  return { allowed: true, info };
}

// ───────────────────────────── plan fetch ─────────────────────────────

function planCacheKey(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const userId = psd.userId || credentials?.userId || "unknown";
  const token = credentials?.accessToken || credentials?.apiKey || "";
  return `${userId}:${tail(token)}`;
}

export function clearCapnZedPlanCache(credentials = null) {
  if (!credentials) {
    planCache.clear();
    return;
  }
  planCache.delete(planCacheKey(credentials));
}

/**
 * GET /client/users/me — the account's plan + trial state. Cached briefly because
 * it is called on every request for the pre-flight gate.
 */
export async function fetchCapnZedUser(credentials, options = {}) {
  const config = options.config || {};
  return fetchJson(
    capnZedUrl(config, "cloudBaseUrl", "/client/users/me", CAPNZED_CLOUD_BASE_URL),
    {
      method: "GET",
      headers: accountHeaders(credentials),
      signal: options.signal ?? undefined,
    },
    options.proxyOptions ?? null,
  );
}

export async function loadCapnZedPlan(credentials, options = {}) {
  const key = planCacheKey(credentials);
  const cached = planCache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.entry;

  const userInfo = await fetchCapnZedUser(credentials, options);
  const entry = { userInfo, ...classifyCapnZedUser(userInfo) };
  planCache.set(key, { entry, expiresAt: Date.now() + PLAN_TTL_MS });
  return entry;
}

/** Record a known-spent account so the next request parks it without a round trip. */
export function markCapnZedAccountSpent(credentials, { reason, code, lockUntilMs }) {
  const entry = {
    allowed: false,
    code: code || CAPNZED_LOCK_CODES.trialExhausted,
    reason,
    lockUntilMs,
  };
  planCache.set(planCacheKey(credentials), {
    entry,
    expiresAt: lockUntilMs && lockUntilMs > Date.now() ? lockUntilMs : Date.now() + PLAN_TTL_MS,
  });
  return entry;
}

// ─────────────────────── LLM token + model catalog ───────────────────────

function llmTokenCacheKey(credentials, organizationId) {
  const psd = credentials?.providerSpecificData || {};
  const userId = psd.userId || credentials?.userId || "unknown";
  const token = credentials?.accessToken || credentials?.apiKey || "";
  return `${userId}:${organizationId || "default"}:${tail(token)}`;
}

function modelCacheKey(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const org = psd.organizationId || psd.defaultOrganizationId || "default";
  return `${psd.userId || "unknown"}:${org}:${tail(credentials?.accessToken || credentials?.apiKey || "")}`;
}

export async function fetchCapnZedLlmToken(credentials, options = {}) {
  const config = options.config || {};
  let organizationId = options.organizationId || resolveCapnZedOrganizationId(credentials);
  if (!organizationId) {
    const userInfo = options.userInfo || (await fetchCapnZedUser(credentials, options));
    organizationId = resolveCapnZedOrganizationId(credentials, userInfo);
  }
  if (!organizationId) throw new Error("CapnZed account has no Zed organization to mint a token for");

  const key = llmTokenCacheKey(credentials, organizationId);
  const cached = llmTokenCache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;

  const data = await fetchJson(
    capnZedUrl(config, "cloudBaseUrl", "/client/llm_tokens", CAPNZED_CLOUD_BASE_URL),
    {
      method: "POST",
      headers: accountHeaders(credentials),
      body: JSON.stringify({ organization_id: organizationId }),
      signal: options.signal ?? undefined,
    },
    options.proxyOptions ?? null,
  );

  const token = normalizeLlmToken(data);
  if (!token) throw new Error("CapnZed: Zed did not return an LLM token");
  llmTokenCache.set(key, { token, expiresAt: Date.now() + LLM_TOKEN_TTL_MS });
  return token;
}

export function shouldRefreshCapnZedLlmToken(response) {
  return (
    response?.status === 401 ||
    !!response?.headers?.has?.(CAPNZED_HEADERS.expiredToken) ||
    !!response?.headers?.has?.(CAPNZED_HEADERS.outdatedToken)
  );
}

/**
 * LLM-plane fetch. NOTE the third argument to proxyAwareFetch is proxyOptions —
 * passing a signal there silently drops the connection proxy, which for Zed means
 * egressing from the wrong IP (and getting trial-blocked). Every call site here
 * passes it explicitly.
 */
export async function capnZedLlmFetch(credentials, path, options = {}) {
  const config = options.config || {};
  const url = capnZedUrl(config, "llmBaseUrl", path, CAPNZED_CLOUD_BASE_URL);

  const buildRequest = async (forceRefresh) => {
    const token = await fetchCapnZedLlmToken(credentials, { ...options, forceRefresh });
    return proxyAwareFetch(
      url,
      {
        ...options.fetchOptions,
        headers: {
          ...(options.fetchOptions?.headers || {}),
          Authorization: `Bearer ${token}`,
        },
        signal: options.signal ?? undefined,
      },
      options.proxyOptions ?? null,
    );
  };

  let response = await buildRequest(false);
  if (shouldRefreshCapnZedLlmToken(response)) {
    response = await buildRequest(true);
  }
  return response;
}

function normalizeModelId(id) {
  if (!id) return "";
  if (typeof id === "string") return id;
  if (typeof id === "object" && id !== null) {
    if (typeof id[0] === "string") return id[0];
    if (typeof id.id === "string") return id.id;
  }
  return String(id);
}

export function mapCapnZedModel(model) {
  const id = normalizeModelId(model?.id);
  if (!id) return null;
  return {
    id,
    name: model.display_name || model.displayName || id,
    provider: model.provider,
    isLatest: !!model.is_latest,
    contextLength: model.max_token_count ?? model.maxTokenCount,
    contextLengthInMaxMode: model.max_token_count_in_max_mode ?? model.maxTokenCountInMaxMode,
    maxOutputTokens: model.max_output_tokens ?? model.maxOutputTokens,
    supportsTools: !!model.supports_tools,
    supportsImages: !!model.supports_images,
    supportsThinking: !!model.supports_thinking,
    supportsDisablingThinking: !!model.supports_disabling_thinking,
    supportsFastMode: !!model.supports_fast_mode,
    supportsServerSideCompaction: !!model.supports_server_side_compaction,
    supportedEffortLevels: model.supported_effort_levels ?? model.supportedEffortLevels ?? [],
    supportsStreamingTools: !!model.supports_streaming_tools,
    supportsParallelToolCalls: !!model.supports_parallel_tool_calls,
    isDisabled: !!model.is_disabled,
    disabledReason: model.disabled_reason ?? null,
  };
}

/** Resolve (and cache) the live Zed catalog. Never a hardcoded list. */
export async function resolveCapnZedModels(credentials, options = {}) {
  if (!credentials?.accessToken) return null;
  const key = modelCacheKey(credentials);
  const cached = modelCache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached;

  const existing = modelInflight.get(key);
  if (existing && !options.forceRefresh) return existing;

  const promise = (async () => {
    const response = await capnZedLlmFetch(credentials, "/models", {
      ...options,
      fetchOptions: {
        method: "GET",
        headers: {
          Accept: "application/json",
          [CAPNZED_HEADERS.clientSupportsXai]: "true",
        },
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`CapnZed models failed: ${response.status} ${text}`);
    }
    const data = await response.json();
    const rawModels = Array.isArray(data?.models) ? data.models : [];
    const models = rawModels
      .map(mapCapnZedModel)
      .filter(Boolean)
      .filter((model) => !model.isDisabled);
    const rawById = new Map();
    for (const raw of rawModels) {
      const id = normalizeModelId(raw?.id);
      if (id) rawById.set(id, raw);
    }
    const entry = {
      expiresAt: Date.now() + MODELS_TTL_MS,
      models,
      rawModels,
      rawById,
      defaultModel: normalizeModelId(data?.default_model ?? data?.defaultModel),
      defaultFastModel: normalizeModelId(data?.default_fast_model ?? data?.defaultFastModel),
      recommendedModels: (data?.recommended_models || data?.recommendedModels || [])
        .map(normalizeModelId)
        .filter(Boolean),
    };
    modelCache.set(key, entry);
    return entry;
  })();

  modelInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (modelInflight.get(key) === promise) modelInflight.delete(key);
  }
}

export function clearCapnZedCaches() {
  llmTokenCache.clear();
  modelCache.clear();
  modelInflight.clear();
  planCache.clear();
}

// ─────────────────────── exhaustion detection ───────────────────────

/** Zed's 402 copy, and the shapes the server puts in the body. */
const PAYMENT_PATTERNS = [
  "payment required",
  "free usage limit",
  "upgrade your account",
  "trial access is blocked",
  "no credits",
  "insufficient credit",
  "spend limit",
];

/** Substrings that mean "this ACCOUNT is done", not "retry this request". */
export function isCapnZedAccountExhausted(status, bodyText) {
  if (Number(status) === 402) return true;
  const text = String(bodyText || "").toLowerCase();
  if (!text) return false;
  return PAYMENT_PATTERNS.some((pattern) => text.includes(pattern));
}

/** `{"status":{"failed":{...}}}` frames arrive mid-stream, after a 200. */
export function isCapnZedInStreamAccountFailure(statusFrame) {
  if (!statusFrame || typeof statusFrame !== "object") return false;
  const failed = statusFrame.failed || statusFrame;
  if (!failed || typeof failed !== "object") return false;
  const haystack = [failed.code, failed.message, failed.error, statusFrame.type]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return PAYMENT_PATTERNS.some((pattern) => haystack.includes(pattern));
}

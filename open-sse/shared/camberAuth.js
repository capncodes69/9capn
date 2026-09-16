// Camber — 9capn's provider for the Camber platform (cambercloud.com).
//
// Camber is an agentic compute platform: every conversation is driven by a
// server-side *agent* (an "agent" = prompt + knowledge base + skills), and the
// foundation model is chosen per request. The hosted models are Bedrock Claude
// ids, and access is plan-gated server-side.
//
// WIRE FACTS THIS MODULE RELIES ON
// -----------------------------------------------------------------------------
//   Base          https://api-v2.cambercloud.com/api/cli   (the CLI surface)
//                 The web app uses /api/ai/* instead — SAME host, DIFFERENT
//                 prefix. /api/ai/* rejects the CLI token with
//                 `401 {"message":"unauthorized - invalid token"}`, so a
//                 provider built on an API key must stay on /api/cli/*.
//   Auth          Authorization: Bearer <api-key>          — plain Bearer.
//                 The key is the 40-char hex token the CLI prints after login
//                 (`camber login` → "… api  Use this token to authenticate with
//                 the Camber API"). Also settable as CAMBER_API_KEY.
//   Envelope      Every REST answer is { code, message, data } with code 0 on
//                 success. Errors use code 1 (validation), 2 (domain), 10 (agent
//                 not found) and may carry error_details[{key,field,message}].
//   Login         Device-flow shaped, NOT OAuth2: POST /auth/initiate (empty
//                 body) → { session_id }; the user authorises at
//                 https://app.cambercloud.com/auth-cli?session_id=…; then
//                 GET /auth/poll?session_id=… answers 202 {"data":"pending"}
//                 until it returns 200 {"data":{"token":"<base64>"}}.
//                 The base64 blob decodes to
//                 { profile: { username, email, token }, teams: [ { id, uniqueName, name } ] }
//                 and `profile.token` is what goes in the Bearer header.
//   Chat (sync)   POST /chat  → stream. Body:
//                 { context_agent, content, conversation_id?, model_name?,
//                   effort?, thinking_enabled?, context_agent_version? }
//                 `context_agent` is the agent alias WITHOUT the leading "@"
//                 (e.g. "nova.cli"). Confirmed field types: conversation_id is
//                 *uuid.UUID, effort is model.Effort, model_name is
//                 model.SupportedModel, thinking_enabled is bool.
//   Effort        Validated with a `oneof` tag — the accepted set is exactly
//                 low | medium | high (instant / xhigh / auto / none / default
//                 are rejected). The CLI exposes --effort but NEVER sends the
//                 field (bug in 1.0.39); we do send it.
//   Thinking      `thinking_enabled` (bool) is the real switch. The CLI's
//                 --no-thinking is likewise dropped on the wire.
//   Stream        The request asks for text/event-stream but the server answers
//                 Content-Type: text/plain + Transfer-Encoding: chunked, and the
//                 frames are the Vercel AI SDK v4 "data stream" protocol — a
//                 `<prefix>:<json>` line per frame, NOT `data:` SSE lines:
//                   0:  text delta        (JSON string)
//                   2:  app data          (JSON array)
//                   3:  error             (JSON string)
//                   8:  message annotations
//                   9:  tool call         { toolCallId, toolName, args }
//                   a:  tool result       { toolCallId, result }
//                   b:  tool call start   { toolCallId, toolName }
//                   c:  tool call delta
//                   d:  finish message    { finishReason, usage:{promptTokens,completionTokens} }
//                   e:  finish step       { finishReason, usage, isContinued }
//                   f:  start step        { messageId }
//                   z:  custom end marker ([] seen)
//                 The `d:` frame carries REAL token usage, which is the only
//                 usage signal Camber gives us.
//   Chat (async)  POST /conversations/init { content, context_agent } → 201 with
//                 the conversation; then the same POST /chat with
//                 conversation_id; then poll
//                 GET /conversations/{id}/status → { status } ("running" → "idle")
//                 and GET /conversations/{id}/reply → { content, output_stash_files }.
//   Errors        Unknown agent      → 404 {"code":10,"message":"Agent not found"}
//                 Unknown conversation→ 500 {"code":2,"message":"Failed to get conversation"}
//                 Model not in plan   → 400 {"code":2,"message":"Model not supported by the current plan"}
//                 Bad content type    → 400 {"message":"Unmarshal type error: …"}
//   No catalog    There is NO /models endpoint (13 candidates probed, all 404),
//                 so the model list below is a static floor: the CLI's own
//                 --model list plus the ids the web picker sends
//                 (Opus 5 / Sonnet 5 / Opus 4.8). Validity is decided by the
//                 server, and the failure mode is explicit.
//
// Re-derive after a Camber CLI/web update:
//   strings -n 5 ~/.camber/bin/camber | grep -E "auth/(initiate|poll)|conversations/|/api/cli/"
//   # then capture the wire with an HTTPS MITM (see open-sse/AGENTS.md)
//   # and re-probe the request struct by sending a field as `{}`:
//   #   curl -H "Authorization: Bearer $KEY" -d '{"content":"x","effort":{}}' \
//   #        https://api-v2.cambercloud.com/api/cli/chat
//   # → "Unmarshal type error: expected=model.Effort, got=object, field=effort"
//   # which proves the field exists; a silently ignored field means it does not.

import { proxyAwareFetch } from "../utils/proxyFetch.js";

// The declarative constants live in camberCatalog.js — a zero-import module the
// client-bundled provider registry can pull in without dragging this file (and
// proxyFetch's node builtins) into the browser graph. Re-exported so callers
// keep importing the wire layer from one place.
import {
  CAMBER_API_BASE_URL,
  CAMBER_DEFAULT_AGENT,
  CAMBER_DEFAULT_MODEL,
  CAMBER_EFFORTS,
  CAMBER_ERROR_CODES,
  CAMBER_LOGIN_PATH,
  CAMBER_MODELS,
  CAMBER_PROVIDER_ID,
  CAMBER_WEB_BASE_URL,
} from "./camberCatalog.js";

export {
  CAMBER_API_BASE_URL,
  CAMBER_DEFAULT_AGENT,
  CAMBER_DEFAULT_MODEL,
  CAMBER_EFFORTS,
  CAMBER_ERROR_CODES,
  CAMBER_LOGIN_PATH,
  CAMBER_MODELS,
  CAMBER_PROVIDER_ID,
  CAMBER_WEB_BASE_URL,
};

const MODEL_WIRE_BY_ID = new Map(CAMBER_MODELS.map((m) => [m.id, m.wire]));
const WIRE_TO_ID = new Map(CAMBER_MODELS.map((m) => [m.wire, m.id]));

// ───────────────────────────── small helpers ─────────────────────────────

function apiBase(config) {
  return String(config?.apiBaseUrl || CAMBER_API_BASE_URL).replace(/\/+$/, "");
}

function webBase(config) {
  return String(config?.webBaseUrl || CAMBER_WEB_BASE_URL).replace(/\/+$/, "");
}

/**
 * Normalise an API key. The key Camber issues is 40 hex characters, but other
 * accounts/dev tiers may differ, so accept any token-shaped string and only
 * reject the things that are certainly user error (empty, whitespace, a pasted
 * URL, a pasted JSON envelope).
 */
export function normalizeCamberApiKey(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (/\s/.test(value)) return "";
  if (/^https?:\/\//i.test(value)) return "";
  if (value.startsWith("{")) return "";
  return value;
}

/**
 * Why a pasted value cannot be an API key, or null when it could be one.
 *
 * The connect form is easy to fill with the wrong thing — the sign-in URL is
 * right there in the browser, and `camber login` prints a JSON-ish blob next to
 * the token. Probing upstream with those earns a confusing "user not found"
 * (Camber answers that for any bearer it does not know), which reads like a
 * wrong-account problem instead of a paste error. Callers that have a request
 * in flight should ask this first and report what is actually wrong.
 *
 * Server-side only: this module reaches proxyFetch, so it must never be
 * imported from a client component (see open-sse/AGENTS.md → Pitfalls).
 */
export function describeCamberKeyProblem(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "Enter the Camber API key.";
  if (/^https?:\/\//i.test(value)) {
    return "That is the Camber sign-in URL, not an API key. Paste the 40-character token `camber login` prints.";
  }
  if (value.startsWith("{")) {
    return 'That looks like a copied JSON response. Paste just the token field from `camber login`.';
  }
  if (/\s/.test(value)) {
    return "A Camber API key contains no spaces — check for a line break or a partial copy.";
  }
  return null;
}

/** Agent alias as the wire wants it: no leading "@", defaulted. */
export function resolveCamberAgent(providerSpecificData) {
  const raw = providerSpecificData?.camberAgent ?? providerSpecificData?.agent;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return withoutAt || CAMBER_DEFAULT_AGENT;
}

/**
 * Map a routed model id to Camber's `model_name`.
 *
 * Accepts the registry id (`claude-opus-5`), the already-prefixed wire name
 * (`bedrock:claude-opus-5`) or anything else the caller pinned — an unknown id
 * falls back to `bedrock:<id>` rather than being dropped, so a model added by
 * Camber keeps working without a 9capn release.
 */
export function resolveCamberModel(model) {
  const value = String(model || "").trim();
  if (!value) return CAMBER_DEFAULT_MODEL;
  if (MODEL_WIRE_BY_ID.has(value)) return MODEL_WIRE_BY_ID.get(value);
  if (value.includes(":")) return value; // already provider-qualified
  return `bedrock:${value}`;
}

/** Inverse of resolveCamberModel, for surfacing a catalog id back to the UI. */
export function camberModelIdFromWire(wire) {
  const value = String(wire || "").trim();
  return WIRE_TO_ID.get(value) || value;
}

/**
 * Translate an OpenAI-style reasoning effort onto Camber's vocabulary.
 *
 * Camber separates the two concerns the OpenAI API conflates:
 *   effort           → how hard the model thinks   (low | medium | high)
 *   thinking_enabled → whether it thinks at all    (bool)
 * `none`/`minimal` disable thinking outright; the CLI's own `--effort`
 * vocabulary is low/medium/high, and the server rejects anything else.
 */
export function resolveCamberEffort(reasoningEffort) {
  const value = String(reasoningEffort || "").trim().toLowerCase();
  if (!value || value === "auto") return { effort: null, thinkingEnabled: null };
  if (value === "none" || value === "off" || value === "minimal" || value === "disabled") {
    return { effort: null, thinkingEnabled: false };
  }
  if (CAMBER_EFFORTS.includes(value)) return { effort: value, thinkingEnabled: true };
  // xhigh / maximum / anything unknown: clamp to the highest supported tier.
  if (value === "xhigh" || value === "maximum" || value === "max") {
    return { effort: "high", thinkingEnabled: true };
  }
  return { effort: null, thinkingEnabled: null };
}

// ───────────────────────── stream frame decoding ─────────────────────────

/** AI SDK v4 data-stream prefixes we understand. */
const FRAME_PREFIXES = new Set(["0", "2", "3", "8", "9", "a", "b", "c", "d", "e", "f", "z"]);

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Decode ONE protocol line into a normalised event.
 *
 * Pure and synchronous so the whole protocol is unit-testable without a socket.
 * Returns null for blank lines, the `z:` end marker and frames we deliberately
 * ignore (tool traffic is dropped here — the executor only ever forwards text).
 *
 * @param {string} line raw line, without its trailing newline
 * @returns {{type:"text",text:string}|{type:"error",message:string}
 *          |{type:"finish",finishReason:string|null,usage:object|null}
 *          |{type:"step",finishReason:string|null}
 *          |{type:"message",messageId:string}
 *          |{type:"end"}|null}
 */
export function decodeCamberFrame(line) {
  const raw = typeof line === "string" ? line.replace(/\r$/, "") : "";
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const sep = trimmed.indexOf(":");
  if (sep <= 0) return null;
  const prefix = trimmed.slice(0, sep);
  if (!FRAME_PREFIXES.has(prefix)) return null;
  const payload = trimmed.slice(sep + 1).trim();

  switch (prefix) {
    case "0": {
      // Text delta. The payload is a JSON string, but tolerate a bare string
      // in case the server ever stops quoting it.
      const parsed = safeJson(payload);
      const text = typeof parsed === "string" ? parsed : parsed == null ? payload : null;
      return text ? { type: "text", text } : null;
    }
    case "3": {
      const parsed = safeJson(payload);
      const message =
        typeof parsed === "string"
          ? parsed
          : parsed?.message || parsed?.error || payload || "Camber stream error";
      return { type: "error", message };
    }
    case "d": {
      const parsed = safeJson(payload) || {};
      return {
        type: "finish",
        finishReason: parsed.finishReason || null,
        usage: normalizeCamberUsage(parsed.usage),
      };
    }
    case "e": {
      const parsed = safeJson(payload) || {};
      return { type: "step", finishReason: parsed.finishReason || null };
    }
    case "f": {
      const parsed = safeJson(payload) || {};
      return { type: "message", messageId: parsed.messageId || null };
    }
    case "z":
      return { type: "end" };
    // Tool traffic (9/a/b/c), app data (2) and annotations (8) are intentionally
    // dropped: the provider exposes a text chat surface only.
    default:
      return null;
  }
}

/**
 * Split an accumulating buffer into complete lines and decode each.
 *
 * @param {string} buffer text received so far (may end mid-line)
 * @returns {{events:Array<object>, rest:string}} decoded events + unconsumed tail
 */
export function decodeCamberFrames(buffer) {
  const text = typeof buffer === "string" ? buffer : "";
  const events = [];
  let start = 0;
  let nl = text.indexOf("\n", start);
  while (nl !== -1) {
    const event = decodeCamberFrame(text.slice(start, nl));
    if (event) events.push(event);
    start = nl + 1;
    nl = text.indexOf("\n", start);
  }
  return { events, rest: text.slice(start) };
}

/**
 * Normalise the `usage` object from a `d:` frame into OpenAI token fields.
 * Returns null when the server reports nothing (it sends nulls for tool-only
 * turns, which must not be recorded as a zero-token request).
 */
export function normalizeCamberUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = toCount(usage.promptTokens ?? usage.prompt_tokens);
  const completion = toCount(usage.completionTokens ?? usage.completion_tokens);
  if (prompt == null && completion == null) return null;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      toCount(usage.totalTokens ?? usage.total_tokens) ?? promptTokens + completionTokens,
  };
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// ─────────────────────────────── HTTP layer ───────────────────────────────

/**
 * Error raised for a non-2xx Camber answer, carrying the parsed envelope so the
 * executor can translate it into the right 9router status.
 */
export class CamberApiError extends Error {
  constructor(message, { status = 0, code = null, camberCode = null, body = null } = {}) {
    super(message);
    this.name = "CamberApiError";
    this.status = status;
    this.code = camberCode || code;
    this.camberCode = code;
    this.body = body;
  }
}

function describeBody(bodyText) {
  if (!bodyText) return null;
  const parsed = safeJson(bodyText);
  if (parsed && typeof parsed === "object") {
    return {
      code: typeof parsed.code === "number" ? parsed.code : null,
      message: parsed.message || parsed.error || null,
      parsed,
    };
  }
  return { code: null, message: typeof bodyText === "string" ? bodyText.slice(0, 400) : null, parsed: null };
}

/**
 * Map a HTTP failure onto a 9router-facing message + code.
 * Exported (pure) so the mapping is unit-testable without a live server.
 */
export function classifyCamberError(status, bodyText) {
  const described = describeBody(bodyText);
  const message = described?.message || "";
  const code = described?.code;

  if (status === 401 || status === 403) {
    return { status, code: CAMBER_ERROR_CODES.badApiKey, message: "Camber rejected the API key. Re-connect the account." };
  }
  if (status === 404 && /agent not found/i.test(message)) {
    return { status, code: CAMBER_ERROR_CODES.unknownAgent, message: `Camber: ${message || "Agent not found"}` };
  }
  if (/model not supported/i.test(message)) {
    return { status, code: CAMBER_ERROR_CODES.modelNotInPlan, message: `Camber: ${message}` };
  }
  if (/failed to get conversation/i.test(message)) {
    return { status, code: CAMBER_ERROR_CODES.unknownConversation, message: `Camber: ${message}` };
  }
  if (status === 429) {
    return { status, code: CAMBER_ERROR_CODES.rateLimited, message: `Camber rate limited: ${message || "try again shortly"}` };
  }
  if (code === 1) {
    return { status, code: CAMBER_ERROR_CODES.validation, message: `Camber validation failed: ${message || "invalid request"}` };
  }

  return {
    status: status || 502,
    code: CAMBER_ERROR_CODES.validation,
    message: message || (status ? `Camber upstream error: HTTP ${status}` : "Camber request failed"),
  };
}

/** Credentials for the wire: an API key (or an OAuth-issued access token). */
export function camberAuthToken(credentials) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  return normalizeCamberApiKey(raw) || (typeof raw === "string" ? raw.trim() : "");
}

/**
 * Single choke point for every Camber request.
 *
 * `proxyOptions` is threaded into `proxyAwareFetch` as its THIRD argument —
 * passing it anywhere else silently drops the connection's proxy, which is a
 * live bug in the upstream zed executor worth not repeating.
 */
export async function camberFetch(pathname, credentials, options = {}) {
  const token = camberAuthToken(credentials);
  if (!token) {
    throw new CamberApiError("Camber connection has no API key.", {
      status: 401,
      camberCode: CAMBER_ERROR_CODES.noCredentials,
    });
  }

  const { method = "GET", body = null, signal = null, proxyOptions = null, config = null, headers = {}, query = null } = options;
  const url = new URL(`${apiBase(config)}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }

  const response = await proxyAwareFetch(
    url.toString(),
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body != null ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
      signal,
    },
    proxyOptions,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const classified = classifyCamberError(response.status, text);
    throw new CamberApiError(classified.message, {
      status: response.status,
      code: describedCode(text),
      camberCode: classified.code,
      body: text,
    });
  }

  return response;
}

function describedCode(bodyText) {
  const parsed = safeJson(bodyText);
  return parsed && typeof parsed === "object" && typeof parsed.code === "number" ? parsed.code : null;
}

/** Read the { code, message, data } envelope, throwing on code !== 0. */
export async function camberJson(pathname, credentials, options = {}) {
  const response = await camberFetch(pathname, credentials, options);
  const text = await response.text().catch(() => "");
  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== "object") {
    throw new CamberApiError("Camber returned an unreadable response.", {
      status: 502,
      camberCode: CAMBER_ERROR_CODES.validation,
      body: text,
    });
  }
  if (typeof parsed.code === "number" && parsed.code !== 0) {
    const classified = classifyCamberError(response.status, text);
    throw new CamberApiError(parsed.message || classified.message, {
      status: response.status,
      code: parsed.code,
      camberCode: classified.code,
      body: text,
    });
  }
  return parsed.data ?? parsed;
}

// ──────────────────────────────── identity ────────────────────────────────

/**
 * GET /me — account identity. Also the validation call for a pasted API key.
 */
export async function fetchCamberMe(credentials, options = {}) {
  return camberJson("/me", credentials, options);
}

/**
 * Decode the base64 blob the login poll returns.
 *
 * Shape (verified against a live login):
 *   { profile: { username, email, token }, teams: [ { id, uniqueName, name } ] }
 */
export function decodeCamberLoginToken(token) {
  const raw = typeof token === "string" ? token.trim() : "";
  if (!raw) return null;
  let text = null;
  try {
    text = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return null;
  }
  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== "object" || !parsed.profile) return null;
  const apiKey = normalizeCamberApiKey(parsed.profile?.token);
  if (!apiKey) return null;
  return {
    apiKey,
    username: parsed.profile.username || null,
    email: parsed.profile.email || null,
    teams: Array.isArray(parsed.teams)
      ? parsed.teams.map((t) => ({ id: t?.id || null, uniqueName: t?.uniqueName || null, name: t?.name || null }))
      : [],
  };
}

/**
 * POST /auth/initiate — open a browser-login session.
 * Returns the URL the user must visit. Derived from the CLI's own flow.
 */
export async function initiateCamberLogin({ config = null, proxyOptions = null, signal = null } = {}) {
  const response = await proxyAwareFetch(
    `${apiBase(config)}/auth/initiate`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      signal,
    },
    proxyOptions,
  );
  const text = await response.text().catch(() => "");
  const parsed = safeJson(text);
  if (!response.ok || !parsed || typeof parsed !== "object") {
    throw new CamberApiError(`Camber login could not start (HTTP ${response.status}).`, {
      status: response.status,
      body: text,
    });
  }
  const sessionId = parsed.data?.session_id || parsed.session_id;
  if (!sessionId) {
    throw new CamberApiError("Camber login did not return a session id.", { status: 502, body: text });
  }
  const loginUrl = `${webBase(config)}${config?.loginPath || CAMBER_LOGIN_PATH}?session_id=${encodeURIComponent(sessionId)}`;
  return { sessionId, loginUrl };
}

/**
 * GET /auth/poll?session_id=… — 202 {"data":"pending"} until the user finishes,
 * then 200 {"data":{"token":"<base64>"}}.
 *
 * Returns { pending: true } while waiting; { apiKey, username, email, teams }
 * once authorised. A non-202 failure is thrown so the modal can surface it.
 */
export async function pollCamberLogin(sessionId, { config = null, proxyOptions = null, signal = null } = {}) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) throw new CamberApiError("Camber login session is missing.", { status: 400 });

  const url = new URL(`${apiBase(config)}/auth/poll`);
  url.searchParams.set("session_id", id);

  const response = await proxyAwareFetch(
    url.toString(),
    { method: "GET", headers: { Accept: "application/json" }, signal },
    proxyOptions,
  );

  if (response.status === 202) return { pending: true };

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const classified = classifyCamberError(response.status, text);
    throw new CamberApiError(classified.message, { status: response.status, camberCode: classified.code, body: text });
  }

  const parsed = safeJson(text);
  const blob = typeof parsed?.data === "string" ? parsed.data : parsed?.data?.token;
  if (blob === "pending") return { pending: true };

  const decoded = decodeCamberLoginToken(blob);
  if (!decoded) {
    throw new CamberApiError("Camber login returned a token we could not read. Try again.", { status: 502, body: text });
  }
  return decoded;
}

// ──────────────────────────────── requests ────────────────────────────────

/**
 * Build the POST /chat body. Pure, so the exact wire shape is testable.
 *
 * Only the fields Camber documents are sent; `thinking_enabled`/`effort` are
 * included only when the caller actually expressed an intent, because the
 * server treats them as nullable (the CLI omits both).
 */
export function buildCamberChatBody({ model, messages, providerSpecificData, reasoningEffort, conversationId }) {
  const agent = resolveCamberAgent(providerSpecificData);
  const level = resolveCamberEffort(reasoningEffort ?? providerSpecificData?.reasoningEffort);
  const body = {
    context_agent: agent,
    content: buildCamberContent(messages),
    model_name: resolveCamberModel(model),
  };
  if (conversationId) body.conversation_id = conversationId;
  if (level.effort) body.effort = level.effort;
  if (level.thinkingEnabled != null) body.thinking_enabled = level.thinkingEnabled;
  const agentVersion = providerSpecificData?.camberAgentVersion;
  if (agentVersion) body.context_agent_version = String(agentVersion);
  return body;
}

/**
 * Flatten an OpenAI-style message list into the single `content` string Camber
 * takes (the endpoint is conversation-based: history lives server-side, so a
 * fresh conversation is seeded with the whole transcript).
 */
export function buildCamberContent(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const parts = [];
  for (const message of list) {
    const role = message?.role;
    const text = extractMessageText(message?.content);
    if (!text) continue;
    if (role === "system") parts.push(`[system]\n${text}`);
    else if (role === "assistant") parts.push(`[assistant]\n${text}`);
    else if (role === "tool") parts.push(`[tool]\n${text}`);
    else parts.push(text);
  }
  return parts.join("\n\n");
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" || part?.type === "input_text") return part.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** POST /chat — returns the raw streaming Response (chunked, AI SDK frames). */
export async function startCamberChat({ model, messages, credentials, providerSpecificData, reasoningEffort, signal, proxyOptions, config, conversationId }) {
  const body = buildCamberChatBody({ model, messages, providerSpecificData, reasoningEffort, conversationId });
  const token = camberAuthToken(credentials);
  if (!token) {
    throw new CamberApiError("Camber connection has no API key.", {
      status: 401,
      camberCode: CAMBER_ERROR_CODES.noCredentials,
    });
  }
  const response = await proxyAwareFetch(
    `${apiBase(config)}/chat`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // The CLI asks for this; the server answers text/plain regardless.
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    },
    proxyOptions,
  );
  return { response, body };
}

// ───────────────────────── async fallback surface ─────────────────────────

/** POST /conversations/init — create the conversation the run will attach to. */
export async function initCamberConversation({ content, providerSpecificData, credentials, signal, proxyOptions, config }) {
  return camberJson("/conversations/init", credentials, {
    method: "POST",
    body: { content, context_agent: resolveCamberAgent(providerSpecificData) },
    signal,
    proxyOptions,
    config,
  });
}

/** GET /conversations/{id}/status → "running" while the run is live. */
export async function fetchCamberConversationStatus(conversationId, credentials, options = {}) {
  const data = await camberJson(`/conversations/${encodeURIComponent(conversationId)}/status`, credentials, options);
  return { conversationId: data?.conversation_id || conversationId, status: data?.status || "unknown" };
}

/** GET /conversations/{id}/reply → the assembled answer once status is idle. */
export async function fetchCamberConversationReply(conversationId, credentials, options = {}) {
  const data = await camberJson(`/conversations/${encodeURIComponent(conversationId)}/reply`, credentials, options);
  return {
    conversationId: data?.conversation_id || conversationId,
    content: data?.content || "",
    outputStashFiles: Array.isArray(data?.output_stash_files) ? data.output_stash_files : [],
  };
}

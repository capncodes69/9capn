import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */

// Deterministic RFC-4122-v5-shaped UUID derived from a session key. The gateway
// keys channel verification on this id, so it must be stable across the turns of
// one conversation and across a retry of the same turn — a random value would
// make every turn look like a new conversation.
function stableUuidFrom(key) {
  const hash = createHash("sha1").update(key).digest("hex");
  const timeHigh = ((parseInt(hash.slice(12, 16), 16) & 0x0fff) | 0x5000)
    .toString(16)
    .padStart(4, "0");
  const clockSeq = ((parseInt(hash.slice(16, 20), 16) & 0x3fff) | 0x8000)
    .toString(16)
    .padStart(4, "0");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    timeHigh,
    clockSeq,
    hash.slice(20, 32),
  ].join("-");
}

// RFC-4122-v7 UUID (time-ordered). The WorkBuddy brand host was measured to take
// hyphen-less v7 ids for the two per-call ids; the codebuddy.ai host takes the
// dashed v4 shape of randomUUID below.
function uuidV7() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

// 32 lowercase hex chars — the shape the client uses for trace and request ids
// (it strips the dashes from a UUID before sending).
function hex32() {
  return randomUUID().replace(/-/g, "");
}

// 16 hex chars, the B3 span-id width.
function hex16() {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

// www.workbuddy.ai is the same gateway under its second brand host.
function isWorkBuddyHost(url) {
  try {
    return /(?:^|\.)workbuddy\.ai$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Read a header case-insensitively. HTTP header names are case-insensitive, so a
// caller that already sent `x-conversation-id` must be found — testing the exact
// key would miss it, add a second `X-Conversation-ID`, and undici would then join
// both into one comma-separated value ("caller, ours"), silently corrupting the
// id we are supposed to keep stable. Accepts a plain object (the executor path)
// or a fetch `Headers` instance (whose get/set are already case-insensitive).
// A non-object input is treated as "no headers" rather than throwing: the caller
// is a header bag, and a missing one means there is nothing to preserve.
function readHeader(headers, name) {
  if (typeof headers?.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" ? value.trim() : "";
  }
  if (!headers || typeof headers !== "object") return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

// Write a header, updating the caller's existing key when only the case differs
// rather than adding a duplicate.
function writeHeader(headers, name, value) {
  if (typeof headers?.set === "function") {
    headers.set(name, value);
    return;
  }
  if (!headers || typeof headers !== "object") return;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  headers[key || name] = value;
}

/**
 * Attach the conversation-correlation family the gateway's channel verification
 * demands (HTTP 400 code 11128 "conversation id missing" without it). Values that
 * already exist and are non-empty are preserved, so a caller tracking its own
 * conversation keeps it; blank values count as absent.
 *
 * **All three of `X-Conversation-ID`, `X-Conversation-Request-ID` and
 * `X-Conversation-Message-ID` are required** — measured against the live gateway,
 * any two of them are still answered 11128. `X-Request-ID` is not part of the
 * requirement; it is mirrored from the message id because the official client
 * sends it, and dropping it is not known to break anything.
 *
 * - `X-Conversation-ID`: derived stably from the session key (or the opening user
 *   message), so retries of a turn and later turns of one conversation keep the
 *   id; a fresh UUID when nothing is derivable.
 * - `X-Conversation-Request-ID` / `X-Conversation-Message-ID`: fresh per request,
 *   and `X-Request-ID` mirrors the message id.
 *
 * Only the intl executor grows these headers — codebuddy-cn is not gated.
 */
function withConversationHeaders(headers, url, body = null, { model = "", credentials = null } = {}) {
  const workbuddy = isWorkBuddyHost(url);

  const sessionKey =
    (typeof body?.session_id === "string" && body.session_id) ||
    (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key) ||
    (typeof body?.conversation_id === "string" && body.conversation_id) ||
    null;
  const firstUser = Array.isArray(body?.messages)
    ? body.messages.find((m) => m?.role === "user")
    : null;
  const userText =
    typeof firstUser?.content === "string"
      ? firstUser.content
      : Array.isArray(firstUser?.content)
        ? firstUser.content
            .map((b) => (b && typeof b.text === "string" ? b.text : ""))
            .join("\n")
        : "";
  const conversationKey = sessionKey || (userText ? `cbai:${userText}` : null);

  if (!readHeader(headers, "X-Conversation-ID")) {
    writeHeader(headers, "X-Conversation-ID", conversationKey
      ? stableUuidFrom(conversationKey)
      : workbuddy
        ? uuidV7()
        : randomUUID());
  }

  // The client assigns ONE requestId to both X-Request-ID and
  // X-Conversation-Request-ID. Sending two different values is a shape no real client
  // produces, so mirror them here; a caller-supplied X-Request-ID wins.
  const requestId = readHeader(headers, "X-Request-ID") || hex32();
  writeHeader(headers, "X-Request-ID", requestId);
  if (!readHeader(headers, "X-Conversation-Request-ID")) {
    writeHeader(headers, "X-Conversation-Request-ID", requestId);
  }

  // Fresh per request, and a dashed UUID — the client uses crypto.randomUUID() here.
  if (!readHeader(headers, "X-Conversation-Message-ID")) {
    writeHeader(headers, "X-Conversation-Message-ID", randomUUID());
  }

  // W3C/B3 trace family. The client sends all of it; a request carrying none of it is
  // another shape no real IDE produces.
  const traceId = readHeader(headers, "X-Trace-ID") || readHeader(headers, "X-B3-TraceId") || hex32();
  writeHeader(headers, "X-Trace-ID", traceId);
  writeHeader(headers, "X-B3-TraceId", traceId);
  if (!readHeader(headers, "X-B3-ParentSpanId")) writeHeader(headers, "X-B3-ParentSpanId", hex32());
  if (!readHeader(headers, "X-B3-SpanId")) writeHeader(headers, "X-B3-SpanId", hex16());
  writeHeader(headers, "X-B3-Sampled", "1");
  writeHeader(
    headers,
    "b3",
    `${traceId}-${readHeader(headers, "X-B3-SpanId")}-1-${readHeader(headers, "X-B3-ParentSpanId")}`,
  );

  // Identity headers the client sends that we can derive from what we have.
  const userId = credentials?.providerSpecificData?.userId;
  if (userId && !readHeader(headers, "X-User-Id")) writeHeader(headers, "X-User-Id", String(userId));
  if (model && !readHeader(headers, "X-Model-ID")) writeHeader(headers, "X-Model-ID", String(model));

  return headers;
}

export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  // The intl gateway's channel verification rejects requests that don't carry the
  // X-Conversation-* family the official IDE sends on every turn. The derivation
  // and per-host shape rules live in withConversationHeaders above.
  //
  // Fail closed, not open. buildHeaders runs OUTSIDE the fetch try/catch in
  // base.js, so a throw here surfaces as a named error rather than a generic 502.
  // Falling through to "send without the family" would be worse than throwing:
  // the gateway refuses such a request every time, so a silent drop converts a
  // diagnosable bug into a 400 with no cause.
  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    try {
      return withConversationHeaders(headers, url, body, { model, credentials });
    } catch (error) {
      throw new Error(
        `CodeBuddy channel verification: could not attach the X-Conversation-* family `
        + `(${error?.message || error}). The intl gateway rejects any request without it `
        + `(HTTP 400 code 11128 "conversation id missing"), so this request cannot succeed. `
        + `See open-sse/executors/codebuddy-intl.js.`,
      );
    }
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }

  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }

        // code 11128 is overloaded: it also carries "first message is not system
        // prompt" (a body-shape problem fixed in transformRequest). Only the
        // conversation-id variant is channel verification, so branch on the
        // message, never on the code alone.
        if (data?.code === 11128 && /conversation id missing/i.test(msg)) {
          const tip = data?.displayTips?.en || data?.displayMsg?.en || "";
          return {
            status: 400,
            message:
              "CodeBuddy channel verification failed (11128 \"conversation id missing\"): "
              + "the upstream gateway requires the X-Conversation-* header family the official "
              + "IDE sends. CodeBuddyIntlExecutor.buildHeaders() supplies it — if this appears, "
              + "the gate likely changed (e.g. a new required header) and the family in "
              + "open-sse/executors/codebuddy-intl.js needs re-measuring against the live gateway."
              + (tip ? ` Upstream said: ${tip}` : ""),
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;

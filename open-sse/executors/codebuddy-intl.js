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

// Deterministic RFC-4122-v5-shaped UUID derived from a session key, mirroring
// the official client's per-conversation id (uuid5 over the session key).
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

// RFC-4122-v7 UUID (time-ordered). The WorkBuddy brand host takes hyphen-less
// v7 ids for the two per-call ids; the default host takes the dashed v4 shape
// of randomUUID below.
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

// www.workbuddy.ai is the same gateway under its second brand host.
function isWorkBuddyHost(url) {
  try {
    return /(?:^|\.)workbuddy\.ai$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Attach the conversation-correlation family the gateway's channel
 * verification demands (HTTP 400 code 11128 "conversation id missing" without
 * it). Values that already exist and are non-empty are preserved, so a caller
 * tracking its own conversation keeps it; blank values count as absent.
 *
 * - `X-Conversation-ID`: derived stably from the session key (or the opening
 *   user message), so retries of a turn and later turns of one conversation
 *   keep the id; a fresh UUID when nothing is derivable.
 * - `X-Conversation-Request-ID` / `X-Conversation-Message-ID`: fresh per
 *   request, and `X-Request-ID` mirrors the message id.
 *
 * The per-call shapes follow what each brand host was measured to accept:
 * workbuddy.ai takes hyphen-less v7, codebuddy.ai the dashed v4. Only the
 * intl executor grows these headers — codebuddy-cn is not gated.
 */
export function withConversationHeaders(headers, url, body = null) {
  const has = (name) => typeof headers[name] === "string" && headers[name].trim() !== "";
  const workbuddy = isWorkBuddyHost(url);
  const freshCallId = () => (workbuddy ? uuidV7().replace(/-/g, "") : randomUUID());

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

  if (!has("X-Conversation-ID")) {
    headers["X-Conversation-ID"] = conversationKey
      ? stableUuidFrom(conversationKey)
      : workbuddy
        ? uuidV7()
        : randomUUID();
  }
  if (!has("X-Conversation-Request-ID")) {
    headers["X-Conversation-Request-ID"] = freshCallId();
  }
  // The request id mirrors the message id: reuse whichever side already exists.
  const messageId = has("X-Conversation-Message-ID")
    ? headers["X-Conversation-Message-ID"]
    : has("X-Request-ID")
      ? headers["X-Request-ID"]
      : freshCallId();
  if (!has("X-Conversation-Message-ID")) headers["X-Conversation-Message-ID"] = messageId;
  if (!has("X-Request-ID")) headers["X-Request-ID"] = messageId;

  return headers;
}

export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  // The intl gateway's channel verification rejects requests that don't carry
  // the X-Conversation-* family the official IDE sends on every turn. The
  // derivation/shape rules live in withConversationHeaders above.
  buildHeaders(credentials, stream = true, url, model, body = null) {
    return withConversationHeaders(
      super.buildHeaders(credentials, stream, url, model, body),
      url,
      body,
    );
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
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;

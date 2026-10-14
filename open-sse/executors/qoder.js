/**
 * QoderExecutor — sends OpenAI-format chat requests to Qoder's COSY-signed
 * inference endpoint at api3.qoder.sh, then unwraps Qoder's `{statusCodeValue,
 * body}` SSE envelope back into plain OpenAI SSE for the rest of the pipeline.
 *
 * Differences vs the previous placeholder:
 *   - URL is api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
 *     with `&Encode=1` so we can ship the body through the WAF-bypass
 *     encoder.
 *   - Authentication is COSY (RSA + AES + MD5 + ~17 Cosy-* headers), not
 *     a static HMAC.
 *   - The request shape Qoder expects is non-trivial (chat_context with
 *     mirrored modelConfig, business block with stable IDs, system text
 *     hoisted out of the messages array). All ported from the reference.
 *   - Model identifier is one of the canonical Qoder keys (auto / ultimate /
 *     performance / efficient / lite + frontier "*model" ids); the
 *     translator layer feeds us "qoder/<key>" so we strip the prefix.
 *   - Per-model `model_config` is fetched live from /algo/api/v2/model/list
 *     and cached. Sending the wrong block silently downgrades to a
 *     different model upstream, so an entry we can't supply at all is a
 *     hard error. Keys that the per-account catalog omits but we have an
 *     RE'd static block for (Sonus `smodel` / Cantus `cmodel`) fall back to
 *     that block — see getQoderStaticModelConfig.
 */

import { qoderEncodeBody } from "../shared/qoder/encoding.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { FETCH_CONNECT_TIMEOUT_MS, HTTP_STATUS } from "../config/runtimeConfig.js";
import {
  QODER_CHAT_SIG_PATH,
  QODER_CONTEXT_TIER_ENV,
  getQoderStaticModelConfig,
  qoderInferenceBase,
} from "../shared/qoder/constants.js";
import { getQoderModelConfig, resolveQoderModels, isQoderPat, resolveQoderCredentials } from "../services/qoderModels.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK } from "../translator/schema/blocks.js";
import { encodeDataUri } from "../translator/concerns/image.js";
import { createQoderSseCoalescer } from "../shared/qoder/sse.js";
import { rewriteQoderMessageAttachments } from "../shared/qoder/attachments.js";
import { resolveQoderContextTier, applyQoderContextTier } from "../shared/qoder/contextTier.js";
import { buildQoderPersona, resolvePersonaMode } from "../shared/qoder/persona.js";
import {
  buildQoderParameters,
  qoderThinkingDisablesReasoning,
  resolveQoderThinking,
} from "../shared/qoder/reasoning.js";
import {
  computeQoderQueueDelayMs,
  isQoderQueuedBody,
  parseQoderQueueInfo,
  qoderQueueMaxWaitMs,
} from "../shared/qoder/queue.js";

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and flatten multipart content arrays — EXCEPT image
 * blocks, which are preserved (see normalizeContent).
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = normalizeContent(msg.content);
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

/**
 * Normalize one message's content for Qoder.
 *
 * Text-only content is flattened to a plain string (Qoder's historical
 * shape). When images are present the content stays an array and image
 * blocks are kept as OpenAI-style `image_url` parts. Native qodercli
 * uploads inlined bytes to `/api/v2/image/upload` first and then sends
 * the OSS URL — `buildQoderRequestBody` does that rewrite before this
 * runs. Tiny leftover data URIs are still accepted. The legacy
 * top-level `image_urls` / `chat_context.imageUrls` slots stay null —
 * qodercli leaves them null too.
 *
 * Claude-style `{type:"image", source:{...}}` blocks are converted to
 * `image_url`. File/document blocks that survived rewrite become short
 * stubs so 30MB PDFs never land in agent_chat_generation.
 */
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);

  const blocks = [];
  const textParts = [];
  let hasImage = false;

  const pushText = (text) => {
    if (!text) return;
    if (hasImage || blocks.length) blocks.push({ type: OPENAI_BLOCK.TEXT, text });
    else textParts.push(text);
  };

  const imageUrlOf = (item) => {
    if (typeof item.image_url === "string" && item.image_url) return item.image_url;
    if (typeof item.image_url?.url === "string" && item.image_url.url) return item.image_url.url;
    return null;
  };

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const imageUrl = item.type === OPENAI_BLOCK.IMAGE_URL ? imageUrlOf(item) : null;
    if (imageUrl) {
      blocks.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: imageUrl } });
      hasImage = true;
    } else if (item.type === CLAUDE_BLOCK.IMAGE && item.source) {
      // Claude base64/url image → OpenAI image_url equivalent.
      const src = item.source;
      const url = src.type === "base64" && src.data
        ? encodeDataUri(src.media_type || "image/png", src.data)
        : typeof src.url === "string" && src.url ? src.url : null;
      if (url) {
        blocks.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url } });
        hasImage = true;
      }
    } else if (item.type === OPENAI_BLOCK.FILE) {
      const name = item.file?.filename || item.file?.name || "file";
      pushText(`[file omitted: ${name} — Qoder reads documents via its file API, not inlined bytes]`);
    } else if (item.type === CLAUDE_BLOCK.DOCUMENT) {
      const name = item.title || "document";
      pushText(`[file omitted: ${name} — Qoder reads documents via its file API, not inlined bytes]`);
    } else if (typeof item.text === "string" && item.text) {
      pushText(item.text);
    }
  }

  if (!hasImage) return textParts.join("\n");
  // Prepend any text collected before the first image block.
  if (textParts.length) blocks.unshift({ type: OPENAI_BLOCK.TEXT, text: textParts.join("\n") });
  return blocks;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return extractText(m.content);
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens) {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    } else if (Array.isArray(m.content)) {
      // Include image refs so the same prompt with a different image gets
      // a distinct chat_record_id.
      h.update("\0");
      try { h.update(JSON.stringify(m.content)); } catch {}
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
async function buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal, uploadFn = null, region = "intl" }) {
  const qoderKey = String(model || "").replace(/^qoder\//, "");

  // Fetch model config from dynamic API instead of relying on static QODER_MODEL_MAP.
  // This allows support for new Qoder models (e.g., qmodel_latest) without code changes.
  let modelConfig = await getQoderModelConfig(credentials, qoderKey, { log, proxyOptions, signal, region });
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { forceRefresh: true, log, proxyOptions, signal, region });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (retried) {
      modelConfig = { ...retried, key: qoderKey };
    } else {
      // The per-account catalog doesn't publish this key. This is normal for
      // the frontier models Sonus (smodel) / Cantus (cmodel), which the plan
      // exposes in the CLI picker but the model-list API often omits. The chat
      // endpoint accepts a known key without a catalog entry, so fall back to
      // the RE'd static block instead of failing the request.
      modelConfig = getQoderStaticModelConfig(qoderKey);
      if (modelConfig) {
        log?.info?.(
          "QODER",
          `model_config for "${qoderKey}" missing from catalog; using static fallback (${modelConfig.display_name})`,
        );
      }
    }
    if (!modelConfig) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
  }

  const incoming = Array.isArray(body.messages)
    ? body.messages.map((m) => {
      if (!m || typeof m !== "object") return m;
      return {
        ...m,
        content: Array.isArray(m.content)
          ? m.content.map((b) => (b && typeof b === "object" ? { ...b } : b))
          : m.content,
      };
    })
    : [];
  try {
    await rewriteQoderMessageAttachments(incoming, {
      credentials,
      log,
      proxyOptions,
      signal,
      uploadFn,
    });
  } catch (err) {
    log?.warn?.("QODER", `attachment rewrite failed: ${err.message}`);
  }

  const { messages, systemText: callerSystemText } = normalizeMessages(incoming);
  const tools = body.tools;

  // Ground the request in the qodercli persona. A plain-chat client arrives with
  // `system: ""` and `tools: []`, so without this the model gets none of the
  // framing qodercli always sends and reads as design-blind. See
  // shared/qoder/persona.js (QODER_PERSONA=off|append|replace).
  const persona = buildQoderPersona({
    systemText: callerSystemText,
    tools,
    mode: resolvePersonaMode(),
  });
  const systemText = persona.system;
  if (persona.persona) {
    log?.info?.(
      "QODER",
      `persona injected (+${Math.max(0, systemText.length - callerSystemText.length)} chars, ${persona.skillCount} skills listed)`,
    );
  }
  let isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  // qodercli derives `parameters` from a generation config; honour the same
  // thinking intent here instead of silently dropping the client's effort, and
  // fall back to the gateway default (xhigh for Sonus/Cantus) when the client
  // expressed none — a plain chat client should still get deep thinking.
  const thinking = resolveQoderThinking(body, { key: qoderKey, modelConfig });
  const parameters = buildQoderParameters({ maxTokens, thinking });
  if (parameters.reasoning_effort || parameters.enable_thinking !== undefined) {
    log?.info?.(
      "QODER",
      `thinking: effort=${parameters.reasoning_effort ?? "(unset)"} source=${thinking?.source ?? "client"} enable_thinking=${parameters.enable_thinking ?? "(unset)"}${parameters.reasoning_budget_tokens ? ` budget=${parameters.reasoning_budget_tokens}` : ""}`,
    );
  }
  if (qoderThinkingDisablesReasoning(parameters)) {
    isReasoning = false;
    // Reassign rather than mutate: the catalog entry is shared/cached.
    modelConfig = { ...modelConfig, is_reasoning: false };
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens);

  // Context-window tier (200K/400K/1M): the IDE picks one from model_config.context_config;
  // qodercli-style requests default to the smallest. Escalate when the prompt no longer fits.
  const tierChoice = resolveQoderContextTier(
    modelConfig,
    { system: systemText, messages, tools },
    { preference: process.env[QODER_CONTEXT_TIER_ENV] },
  );
  if (tierChoice) {
    log?.info?.(
      "QODER",
      `context tier ${tierChoice.tier.name} (${tierChoice.tier.tokenCount} tokens, ${tierChoice.reason}) for ~${tierChoice.estimatedTokens} prompt tokens`,
    );
  }

  const built = {
    qoderKey,
    payload: {
      request_id: uuidv4(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters,
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: uuidv4(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
  if (tierChoice) applyQoderContextTier(built.payload, tierChoice.tier);
  return built;
}

/**
 * Check if a qoder error message indicates a billing/quota block.
 * Signatures: code 110 (billing daily count exceeded), code 112 (quota
 * exhausted), pricingUrl field.
 *
 * NOTE: code 10605 (model queued) is deliberately NOT a billing block. It is a
 * transient queue signal handled by the model-queue path (see
 * shared/qoder/queue.js plus wrapQoderSSE/execute below); treating it as
 * billing locked the model out for a full cooldown on a recoverable state.
 */
function isBillingBlock(inner) {
  if (!inner || typeof inner !== "string") return false;
  const lowerMsg = inner.toLowerCase();
  if (lowerMsg.includes("pricingurl")) return true;
  // Parsed code preferred over regex: matches numeric or string "110"/"112".
  try {
    const parsed = JSON.parse(inner);
    const code = String(parsed?.code ?? "");
    if (code === "110" || code === "112") return true;
  } catch { /* not JSON — fall through to legacy shape match */ }
  // Match legacy exact shapes: {"code":"110",...}, {"code":"112",...}.
  return /"code"\s*:\s*"(110|112)"/.test(inner);
}

/**
 * Peek the first SSE data line to detect upstream errors before piping.
 * Returns { isError, isBilling, statusVal, message, consumed } — `consumed` is every
 * byte read so far (including the peeked line) so the caller can re-process
 * it and nothing is dropped from the stream.
 */
async function peekFirstQoderFrame(reader, decoder) {
  let consumed = "";
  let offset = 0;
  let upstreamDone = false;
  while (true) {
    let nl = consumed.indexOf("\n", offset);
    if (nl === -1 && !upstreamDone) {
      const { done, value } = await reader.read();
      upstreamDone = done;
      consumed += done ? decoder.decode() : decoder.decode(value, { stream: true });
      continue;
    }
    if (offset >= consumed.length) return { isError: false, consumed, upstreamDone };
    if (nl === -1) nl = consumed.length;

    const line = consumed.slice(offset, nl).replace(/\r$/, "").trim();
    offset = nl + 1;
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trimStart();
    if (data === "[DONE]") return { isError: false, consumed, upstreamDone };

    let envelope;
    try { envelope = JSON.parse(data); } catch { return { isError: false, consumed, upstreamDone }; }

    // statusCodeValue is documented numeric, but accept numeric strings defensively.
    const raw = Number(envelope?.statusCodeValue);
    const statusVal = Number.isNaN(raw) ? 200 : raw;
    const inner = typeof envelope?.body === "string"
      ? envelope.body
      : envelope?.body != null ? JSON.stringify(envelope.body) : "";

    if (statusVal !== 200) {
      // A queued model (code 10605 / isQueued) is transient, not a quota
      // failure — flag it separately so callers can wait and retry.
      const queued = isQoderQueuedBody(inner);
      return {
        isError: true,
        isQueued: queued,
        queueInfo: queued ? parseQoderQueueInfo(inner) : null,
        isBilling: !queued && isBillingBlock(inner),
        statusVal,
        message: inner || `upstream status ${statusVal}`,
        consumed,
        upstreamDone,
      };
    }
    return { isError: false, consumed, upstreamDone };
  }
}

/**
 * Wrap the upstream's `{statusCodeValue, body}` SSE envelope into plain
 * OpenAI SSE chunks the rest of the chatCore pipeline understands.
 *
 * Each upstream line looks like:
 *   data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{...}}]}"}
 * The inner body is an OpenAI streaming chunk (or "[DONE]"). We unwrap it
 * and re-emit as `data: <inner>\n\n`. First-frame errors become HTTP errors;
 * errors after streaming starts retain the synthetic chunk + [DONE] path.
 *
 * Critical: Qoder's SSE often keeps the socket open after the terminal
 * [DONE]/error frame (agent keepalive). Non-streaming clients drain via
 * response.text() which hangs until the socket closes — so on terminal
 * events we cancel the upstream reader and close our stream immediately.
 *
 * Usage: Qoder puts finish_reason on `delta` and sends token counts on a
 * later `choices: []` frame. Downstream OpenAI/Claude clients only read
 * usage from the finish chunk, so we coalesce those two frames (see
 * createQoderSseCoalescer) before forwarding.
 *
 * Peek the first frame for errors before committing to HTTP 200. Preserve
 * upstream error statuses so chatCore can handle failures instead of recording
 * error text as a successful completion. Billing blocks retain the existing
 * 403 mapping for quota/account fallback.
 */
async function wrapQoderSSE(response, model, log = null) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  // Detect errors before returning a successful streaming response.
  const peek = await peekFirstQoderFrame(reader, decoder);
  if (peek.isError) {
    await reader.cancel().catch(() => {});
    if (peek.isQueued) {
      // A queued model is reclaimable, not exhausted. Surface a retryable 429
      // (with the queue's own wait hint) instead of a quota-style 403, so the
      // connection isn't locked out for a full cooldown. execute() normally
      // intercepts this earlier and holds the request open until it is ready.
      const retryAfterSec = Math.max(1, Math.ceil(computeQoderQueueDelayMs(peek.queueInfo) / 1000));
      return new Response(
        JSON.stringify({ error: { message: peek.message, code: "qoder_model_queue", type: "rate_limit_error" } }),
        { status: HTTP_STATUS.RATE_LIMITED, headers: { "Content-Type": "application/json", "retry-after": String(retryAfterSec) } }
      );
    }
    const status = peek.isBilling
      ? HTTP_STATUS.FORBIDDEN
      : Number.isInteger(peek.statusVal) && peek.statusVal >= HTTP_STATUS.BAD_REQUEST && peek.statusVal <= 599
        ? peek.statusVal : HTTP_STATUS.BAD_GATEWAY;
    return new Response(
      JSON.stringify({ error: { message: peek.message, code: peek.statusVal } }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }

  // Normal flow: re-process every byte the peek consumed, then continue.
  let buffer = peek.consumed || "";
  const upstreamDrained = peek.upstreamDone === true;
  const encoder = new TextEncoder();
  let doneEmitted = false;
  const coalescer = createQoderSseCoalescer({ model, encoder, sseDone: SSE_DONE });

  const syncDone = () => {
    if (coalescer.doneEmitted) doneEmitted = true;
  };

  // Process one already-extracted SSE line (no trailing newline).
  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted) return;

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      coalescer.flush(controller);
      syncDone();
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = Number(envelope.statusCodeValue) || 200;
    const inner = typeof envelope.body === "string"
      ? envelope.body
      : envelope.body != null ? JSON.stringify(envelope.body) : "";
    if (statusVal !== 200) {
      // Always visible: error envelopes are rare and worth one stderr line at
        // any log level (response bodies carry no credentials).
      try {
        console.error(`[QODER] error envelope status=${statusVal} statusType=${typeof envelope.statusCodeValue} bodyType=${typeof envelope.body} body=${truncate(inner, 300)}`);
      } catch { /* logging must not break the stream */ }
      if (isQoderQueuedBody(inner)) {
        // Mid-stream queue signal: emit a structured rate-limit error, never
        // fake assistant text, so chatCore can fall back cleanly.
        const errObj = JSON.stringify({
          error: {
            message: inner || `qoder model queued (${statusVal})`,
            code: "qoder_model_queue",
            status: HTTP_STATUS.RATE_LIMITED,
            type: "rate_limit_error",
          },
        });
        controller.enqueue(encoder.encode(`data: ${errObj}\n\n`));
        controller.enqueue(encoder.encode(SSE_DONE));
        doneEmitted = true;
        return;
      }
      if (isBillingBlock(inner)) {
        // Billing/quota envelope at any stream position (peek only covers the
        // first frame): emit a structured error chunk, not fake assistant text.
        // parseSSEToOpenAIResponse understands chunk.error and turns it into a
        // non-200 result so chat.js locks the model and falls back. Streaming
        // clients receive a real SSE error instead of "[qoder error ...]" text.
        const errObj = JSON.stringify({
          error: {
            message: inner || `qoder billing block (${statusVal})`,
            code: "qoder_billing_block",
            status: 403,
            type: "quota_error",
          },
        });
        controller.enqueue(encoder.encode(`data: ${errObj}\n\n`));
        controller.enqueue(encoder.encode(SSE_DONE));
        doneEmitted = true;
        return;
      }
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    coalescer.handleInner(inner, controller);
    syncDone();
  };

  const stream = new ReadableStream({
    // Use start()+loop (not pull): a pull that buffers a partial line without
    // enqueueing would never be re-invoked, hanging consumers like .text().
    async start(controller) {
      try {
        // Drain whatever the peek already pulled off the socket first.
        let nlSeed;
        while ((nlSeed = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlSeed);
          buffer = buffer.slice(nlSeed + 1);
          processLine(line, controller);
          if (doneEmitted) {
            await reader.cancel().catch(() => {});
            controller.close();
            return;
          }
        }
        if (upstreamDrained) {
          // Peek hit end-of-stream: flush any trailing partial line.
          buffer += decoder.decode();
          if (buffer.length > 0) {
            processLine(buffer, controller);
            buffer = "";
          }
        }

        while (!doneEmitted && !upstreamDrained) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
              processLine(buffer, controller);
              buffer = "";
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            processLine(line, controller);
            if (doneEmitted) {
              // Terminal frame received — drop upstream keepalive and end.
              await reader.cancel().catch(() => {});
              controller.close();
              return;
            }
          }
        }
      } catch {
        // fall through to terminal [DONE] + close
      } finally {
        if (!doneEmitted) {
          try {
            coalescer.flush(controller);
            doneEmitted = true;
          } catch { /* already closed */ }
        }
        try { controller.close(); } catch { /* already closed */ }
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Re-emit a peeked response body: the already-decoded prefix plus the rest of
 * the upstream reader. Lets execute() peek for a queue signal and still hand a
 * complete, replayable Response to wrapQoderSSE.
 */
function replayQoderStream(reader, consumed) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        if (consumed) controller.enqueue(encoder.encode(consumed));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch { /* fall through to close */ }
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });
}

/**
 * Peek the first SSE frame of a response. When it signals a queued model,
 * cancel the upstream body and report the queue info; otherwise rebuild a
 * replayable Response so a later wrapQoderSSE() re-reads the same bytes.
 */
async function detectQoderQueue(response) {
  if (!response.ok || !response.body) return { queued: false, response };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let peek;
  try {
    peek = await peekFirstQoderFrame(reader, decoder);
  } catch {
    return { queued: false, response };
  }
  if (peek.isQueued) {
    await reader.cancel().catch(() => {});
    return { queued: true, queueInfo: peek.queueInfo || null };
  }
  let consumed = peek.consumed || "";
  if (!peek.upstreamDone) {
    // Flush any multibyte bytes the decoder buffered so no data is dropped.
    try { consumed += decoder.decode(); } catch { /* ignore */ }
  }
  const rebuilt = new Response(replayQoderStream(reader, consumed), {
    status: response.status,
    statusText: response.statusText,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
  return { queued: false, response: rebuilt };
}

/** Sleep that rejects promptly when the request signal aborts. */
function sleepAbortable(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("aborted"));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** 503 the caller can retry, carrying the queue's wait hint. */
function buildQoderQueueTimeoutResponse(qoderKey, queueInfo, waitedMs, maxWaitMs) {
  const detail = [
    `queueType=${queueInfo?.queueType ?? "?"}`,
    `serviceAvailable=${queueInfo?.serviceAvailable ?? "?"}`,
  ].join(", ");
  const retryAfterSec = Math.max(1, Math.ceil(computeQoderQueueDelayMs(queueInfo) / 1000));
  return new Response(
    JSON.stringify({
      error: {
        message: `qoder model queue wait timed out for "${qoderKey}" after ${Math.round(waitedMs / 1000)}s (${detail}, max ${Math.round(maxWaitMs / 1000)}s)`,
        code: "qoder_model_queue_timeout",
        type: "rate_limit_error",
      },
    }),
    {
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      headers: { "Content-Type": "application/json", "retry-after": String(retryAfterSec) },
    },
  );
}

export class QoderExecutor extends BaseExecutor {
  constructor(provider = "qoder") {
    super(provider, PROVIDERS[provider]);
    this.region = provider === "qoder-cn" ? "cn" : "intl";
  }

  buildUrl(credentials) {
    return `${qoderInferenceBase(credentials, this.region)}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
  }

  // Override execute entirely — Qoder needs:
  //   - body built from translated chat completion payload
  //   - body encoded with QoderEncodeBody before signing
  //   - COSY headers built from the *encoded* body bytes
  //   - response stream re-wrapped from {statusCodeValue, body} to OpenAI SSE
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // PAT (pt-...) → exchange for short-lived job token + resolve userId so
    // downstream COSY signing + catalog fetch work. Device tokens (dt-...) and
    // job tokens (jt-...) skip this and are used directly.
    const rawToken = credentials?.apiKey || credentials?.accessToken;
    if (isQoderPat(rawToken)) {
      try {
        credentials = await resolveQoderCredentials(credentials, proxyOptions, signal, this.region);
      } catch (err) {
        log?.error?.("QODER", `PAT exchange failed: ${err.message}`);
        const fakeResp = new Response(
          JSON.stringify({ error: { message: `qoder PAT exchange failed: ${err.message}` } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
        return { response: fakeResp, url: this.buildUrl(credentials), headers: {}, transformedBody: body };
      }
    }

    const url = this.buildUrl(credentials);
    const psd = credentials?.providerSpecificData || {};
    if (!psd.userId) {
      // No user id → no way to sign. Surface a 401 so the dashboard nudges
      // the user back to OAuth.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing userId; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    if (!credentials?.accessToken) {
      // Same shape as the userId guard — clean 401 so chatCore reports
      // "reconnect" rather than bubbling cosy.js's synchronous throw as 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing accessToken; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    // Build + sign + send one inference attempt. Rebuilt per attempt so the
    // COSY signature/timestamp and request_id are fresh each time, while the
    // derived request_set_id/chat_record_id stay stable across queue retries
    // (buildQoderRequestBody hashes them from the prompt; Qoder correlates
    // queue state by request_set_id).
    const sendOnce = async () => {
      let qoderKey;
      let payload;
      try {
        ({ qoderKey, payload } = await buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal, region: this.region }));
      } catch (err) {
        return {
          error: new Response(
            JSON.stringify({ error: { message: err.message } }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
          url, headers: {}, transformedBody: body,
        };
      }

      const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
      const encodedBodyStr = qoderEncodeBody(plainBody);
      const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

      let cosyHeaders;
      try {
        cosyHeaders = buildCosyHeaders(
          encodedBodyBuf,
          url,
          {
            userId: psd.userId,
            authToken: credentials.accessToken,
            name: credentials.displayName || "",
            email: credentials.email || "",
            machineId: psd.machineId || "",
          },
        );
      } catch (err) {
        // cosy.js throws synchronously on missing userId/authToken — surface
        // as 401 so chatCore prompts re-auth instead of returning a 500.
        return {
          error: new Response(
            JSON.stringify({ error: { message: `qoder cosy signing failed: ${err.message}` } }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          ),
          url, headers: {}, transformedBody: body,
        };
      }

      const modelSource = (payload.model_config && payload.model_config.source) || "system";
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Model-Key": qoderKey,
        "X-Model-Source": modelSource,
        // gzip triggers signature validation on Qoder's CDN; force identity.
        "Accept-Encoding": "identity",
        ...cosyHeaders,
      };

      // Abort if upstream doesn't return response headers within connect timeout.
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      let response;
      try {
        response = await proxyAwareFetch(
          url,
          { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal },
          // A failed proxy request may already have reached Qoder. Replaying
          // the same COSY signature directly reuses its requestId and returns
          // 403/code 103. Let the caller retry through execute() with fresh signing.
          { ...proxyOptions, strictProxy: true },
        );
      } catch (err) {
        // strictProxy wraps transport errors; retain caller cancellation semantics.
        if (mergedSignal.aborted) throw mergedSignal.reason;
        throw err;
      } finally {
        clearTimeout(connectTimer);
      }
      return { response, url, headers, transformedBody: payload, qoderKey };
    };

    const qoderLabel = `${this.provider}/${String(model || "").replace(/^qoder\//, "")}`;
    const maxQueueWaitMs = qoderQueueMaxWaitMs();
    let queueWaitStartedAt = null;
    let lastQueueInfo = null;

    // Qoder's model queue: a temporarily-unavailable model answers with a
    // non-200 envelope whose body carries code 10605 / isQueued:true. Rather
    // than surfacing a hard 403 (which locks the connection for a full
    // cooldown on a state that clears itself) hold the request open and replay
    // the inference call once the model is ready — matching qodercli, which
    // waits out the queue instead of failing. Bounded by QODER_MODEL_QUEUE_MAX_WAIT_MS.
    for (;;) {
      const sent = await sendOnce();
      if (sent.error) {
        return { response: sent.error, url: sent.url, headers: sent.headers, transformedBody: sent.transformedBody };
      }
      if (!sent.response.ok) {
        // Pass error response through unchanged so chatCore can capture it.
        return { response: sent.response, url: sent.url, headers: sent.headers, transformedBody: sent.transformedBody };
      }

      const detected = await detectQoderQueue(sent.response);
      if (!detected.queued) {
        const wrapped = await wrapQoderSSE(detected.response, qoderLabel, log);
        return { response: wrapped, url: sent.url, headers: sent.headers, transformedBody: sent.transformedBody };
      }

      lastQueueInfo = detected.queueInfo || lastQueueInfo;
      if (queueWaitStartedAt === null) queueWaitStartedAt = Date.now();
      const waitedMs = Date.now() - queueWaitStartedAt;
      if (waitedMs >= maxQueueWaitMs) {
        log?.warn?.(
          "QODER",
          `model queue wait timed out after ${Math.round(waitedMs / 1000)}s (${qoderLabel}, queueType=${lastQueueInfo?.queueType ?? "?"}, serviceAvailable=${lastQueueInfo?.serviceAvailable ?? "?"})`,
        );
        return {
          response: buildQoderQueueTimeoutResponse(sent.qoderKey, lastQueueInfo, waitedMs, maxQueueWaitMs),
          url: sent.url, headers: sent.headers, transformedBody: sent.transformedBody,
        };
      }

      const delayMs = Math.min(computeQoderQueueDelayMs(lastQueueInfo), maxQueueWaitMs - waitedMs);
      log?.info?.(
        "QODER",
        `model "${sent.qoderKey}" queued (queueType=${lastQueueInfo?.queueType ?? "?"}, queueCount=${lastQueueInfo?.queueCount ?? "?"}, serviceAvailable=${lastQueueInfo?.serviceAvailable ?? "?"}); waiting ${Math.round(delayMs / 1000)}s then retrying`,
      );
      await sleepAbortable(delayMs, signal);
    }
  }

  // Qoder device tokens don't refresh through OAuth — the upstream returns
  // 403 for our flow. Surfacing failure via 401-on-chat is enough; the
  // dashboard tells users to re-login when their token expires (~30 days).
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderExecutor;

// Internals exposed for unit tests. Not part of the public API — callers
// should import QoderExecutor and use its public methods.
export const __test__ = {
  normalizeMessages,
  wrapQoderSSE,
  buildQoderRequestBody,
  isBillingBlock,
  detectQoderQueue,
  peekFirstQoderFrame,
};

// CamberExecutor — POST /api/cli/chat, streamed back as OpenAI SSE.
//
// Camber is an AGENT platform, so a "chat" here is not a bare model call: the
// request names an agent (`context_agent`) and the server may run tools, warm a
// sandbox and only then answer. Three consequences shape this executor:
//
//   1. THE STREAM IS NOT SSE. The request asks for text/event-stream and the
//      server answers `text/plain` + chunked, with Vercel AI SDK v4 data-stream
//      frames (`0:` text, `g:` reasoning, `d:` finish+usage, `3:` error,
//      `9:/a:/b:/c:` tool traffic). We parse that and re-emit OpenAI chat
//      chunks. Tool frames are dropped: this provider is a text surface, and
//      forwarding tool calls the client never declared would be worse than
//      hiding them.
//
//      `g:` frames are the model's chain of thought and are forwarded as
//      `delta.reasoning_content` (the repo-wide convention — see
//      executors/grok-web.js, perplexity-web.js, cursor.js). They must NOT be
//      merged into `content`: a client that renders reasoning separately would
//      otherwise show the thinking twice, and one that does not would show the
//      model apparently talking to itself.
//
//   2. COLD STARTS ARE REAL. A brand-new conversation measured ~2 minutes before
//      the first frame (sandbox provisioning), while later turns in the same
//      conversation are fast. Timeouts therefore come from the registry
//      (timeoutMs/stallTimeoutMs = 300s), not from a streaming heuristic.
//
//   3. THERE IS AN ASYNC JOB PATH. /conversations/init → /chat → poll
//      /conversations/{id}/status → /conversations/{id}/reply. It is used as a
//      FALLBACK only, and only when the sync attempt failed before any output
//      reached the client (a refused request, or a network/5xx failure). Once
//      text has been streamed, re-running would duplicate the answer, so we
//      surface the error instead.
//
// Wire facts, field types and the error taxonomy are documented in
// open-sse/shared/camberAuth.js.

import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../providers/index.js";
import {
  CAMBER_PROVIDER_ID,
  buildCamberContent,
  classifyCamberError,
  decodeCamberFrames,
  fetchCamberConversationReply,
  fetchCamberConversationStatus,
  fetchCamberMe,
  initCamberConversation,
  resolveCamberAgent,
  startCamberChat,
} from "../shared/camberAuth.js";

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;

/** How often the async fallback asks whether the run finished (the CLI uses 5s). */
export const CAMBER_ASYNC_POLL_INTERVAL_MS = 5000;
/** Hard ceiling for the async fallback: cold start + tool use, generously. */
export const CAMBER_ASYNC_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Is a failed sync attempt worth re-running through the async job path?
 *
 * Only transient/transport failures qualify. A refusal is a decision, not an
 * outage: 400 (validation / model not in the plan), 401/403 (bad key), 404
 * (unknown agent) and Camber's own 500 both mean "the same request would fail
 * the same way", and re-running it would just burn a second attempt.
 */
export function isCamberAsyncFallbackWorthwhile(status) {
  if (!Number.isFinite(status)) return true; // network error, no status at all
  return (
    status === HTTP_REQUEST_TIMEOUT ||
    status === HTTP_TOO_MANY_REQUESTS ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/** Registry transport + oauth block, merged so callers can override either. */
function resolveConfig(self) {
  const transport = PROVIDERS[CAMBER_PROVIDER_ID] || {};
  const oauth = PROVIDER_OAUTH[CAMBER_PROVIDER_ID] || {};
  return { ...oauth, ...transport, ...(self?.config || {}) };
}

function sseChunk({ id, created, model, delta, finishReason = null, usage = null }) {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function jsonErrorResponse({ status, message, code }) {
  return new Response(
    JSON.stringify({ error: { message, type: "camber_error", code } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Translate the AI SDK data-stream body into OpenAI chat chunks.
 *
 * Exported so the whole translation can be unit-tested against a fake Response
 * without touching the network.
 */
export function translateCamberStream(response, model) {
  if (!response?.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-camber-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let finished = false;
  let sawText = false;
  let sawReasoning = false;
  let usage = null;

  const finish = (controller) => {
    if (finished) return;
    finished = true;
    if (!sawText && !sawReasoning) {
      // A conversation that produced no text still needs a well-formed stream.
      controller.enqueue(
        encoder.encode(sseChunk({ id, created, model, delta: { role: "assistant", content: "" } })),
      );
    }
    controller.enqueue(
      encoder.encode(sseChunk({ id, created, model, delta: {}, finishReason: "stop", usage })),
    );
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };

  const emit = (event, controller) => {
    if (finished) return;
    if (event.type === "text") {
      sawText = true;
      controller.enqueue(
        encoder.encode(sseChunk({ id, created, model, delta: { content: event.text } })),
      );
      return;
    }
    if (event.type === "reasoning") {
      // Thinking is forwarded, not swallowed and not folded into content: the
      // client decides whether to show it (Hermes/9router render
      // `reasoning_content` as a separate block).
      sawReasoning = true;
      controller.enqueue(
        encoder.encode(
          sseChunk({ id, created, model, delta: { reasoning_content: event.text } }),
        ),
      );
      return;
    }
    if (event.type === "error") {
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id,
            created,
            model,
            delta: { content: `[Camber error] ${event.message}` },
          }),
        ),
      );
      finished = true;
      controller.enqueue(encoder.encode(sseChunk({ id, created, model, delta: {}, finishReason: "stop" })));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    if (event.type === "finish") {
      if (event.usage) usage = event.usage;
      finish(controller);
      return;
    }
    if (event.type === "end") finish(controller);
  };

  const transformed = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const { events, rest } = decodeCamberFrames(buffer);
        buffer = rest;
        for (const event of events) emit(event, controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) {
          const { events } = decodeCamberFrames(`${buffer}\n`);
          for (const event of events) emit(event, controller);
          buffer = "";
        }
        finish(controller);
      },
    }),
  );

  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

/**
 * Turn an already-finished async reply into the same OpenAI SSE shape, so the
 * client cannot tell which path served it.
 */
export function synthesizeCamberStream(content, model, usage = null) {
  const encoder = new TextEncoder();
  const id = `chatcmpl-camber-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const text = typeof content === "string" ? content : "";
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk({ id, created, model, delta: { role: "assistant", content: "" } })));
      if (text) {
        controller.enqueue(encoder.encode(sseChunk({ id, created, model, delta: { content: text } })));
      }
      controller.enqueue(encoder.encode(sseChunk({ id, created, model, delta: {}, finishReason: "stop", usage })));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

class CamberExecutor extends BaseExecutor {
  constructor() {
    super(CAMBER_PROVIDER_ID);
  }

  /**
   * Camber has no catalog endpoint, so nothing to fetch: the registry list is
   * the floor and the server validates. Kept so the models route can call the
   * same surface as other providers.
   */
  async resolveModels() {
    return null;
  }

  /** Pre-flight: is the credential even usable? One cheap GET /me. */
  async assertCredentialUsable(credentials, { signal, log, proxyOptions, config }) {
    try {
      const me = await fetchCamberMe(credentials, { signal, proxyOptions, config });
      return { ok: true, me };
    } catch (error) {
      const status = error?.status || 0;
      if (status === 401 || status === 403) {
        log?.warn?.("CAMBER", "credential rejected by /me");
        return { ok: false, status, message: error.message };
      }
      // Anything else (network, 5xx) degrades OPEN: better to try the real call
      // than to refuse a healthy account over a probe failure.
      log?.debug?.("CAMBER", `identity probe skipped: ${error.message}`);
      return { ok: true, me: null };
    }
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const config = resolveConfig(this);
    const providerSpecificData = credentials?.providerSpecificData || {};
    const messages = body?.messages || body?.input || [];
    const content = buildCamberContent(messages);
    const reasoningEffort = body?.reasoning_effort ?? body?.effort ?? null;

    const context = {
      model,
      messages,
      content,
      credentials,
      providerSpecificData,
      reasoningEffort,
      signal,
      proxyOptions,
      config,
    };

    // 1) Sync stream — the primary path.
    let failure = null;
    try {
      const { response, body: sentBody } = await startCamberChat(context);
      if (response.ok) {
        const headers = { "Content-Type": "application/json" };
        const url = `${config.apiBaseUrl || ""}/chat`;
        if (stream === false) {
          // The client asked for a single JSON answer: drain the stream and
          // assemble it with the usage the `d:` frame carried.
          const assembled = await collectCamberStream(response);
          return {
            response: new Response(
              JSON.stringify({
                id: `chatcmpl-camber-${Date.now().toString(36)}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: assembled.content,
                      ...(assembled.reasoning ? { reasoning_content: assembled.reasoning } : {}),
                    },
                    finish_reason: "stop",
                  },
                ],
                ...(assembled.usage ? { usage: assembled.usage } : {}),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
            url,
            headers,
            transformedBody: sentBody,
          };
        }
        return {
          response: translateCamberStream(response, model),
          url,
          headers,
          transformedBody: sentBody,
        };
      }

      const text = await response.text().catch(() => "");
      failure = classifyCamberError(response.status, text);
      failure.status = response.status;
      if (!isCamberAsyncFallbackWorthwhile(response.status)) {
        log?.warn?.("CAMBER", `refused (${response.status}): ${failure.message}`);
        return {
          response: jsonErrorResponse(failure),
          url: `${config.apiBaseUrl || ""}/chat`,
          headers: { "Content-Type": "application/json" },
          transformedBody: null,
        };
      }
      log?.warn?.("CAMBER", `sync attempt failed (${response.status}), trying the async job path`);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      failure = { status: error?.status || 502, message: error?.message || String(error), code: error?.camberCode || null };
      log?.warn?.("CAMBER", `sync attempt errored (${failure.status}), trying the async job path`);
    }

    // 2) Async fallback — only reached when nothing was streamed to the client.
    try {
      const reply = await this.runAsyncJob(context, log);
      return {
        response: synthesizeCamberStream(reply.content, model),
        url: `${config.apiBaseUrl || ""}/conversations/init`,
        headers: { "Content-Type": "application/json" },
        transformedBody: null,
      };
    } catch (error) {
      const message = `${failure?.message ? `${failure.message} — ` : ""}async fallback failed: ${error.message}`;
      log?.warn?.("CAMBER", message);
      return {
        response: jsonErrorResponse({
          status: error?.status || 502,
          message,
          code: error?.camberCode || failure?.code || null,
        }),
        url: `${config.apiBaseUrl || ""}/chat`,
        headers: { "Content-Type": "application/json" },
        transformedBody: null,
      };
    }
  }

  /**
   * The async job path: create the conversation, fire the run, wait for the
   * status to leave "running", then read the assembled reply.
   */
  async runAsyncJob(context, log) {
    const { content, credentials, providerSpecificData, signal, proxyOptions, config } = context;

    const conversation = await initCamberConversation({
      content,
      providerSpecificData,
      credentials,
      signal,
      proxyOptions,
      config,
    });
    const conversationId = conversation?.id;
    if (!conversationId) throw new Error("Camber did not return a conversation id");

    // Fire the run. Its response body is a stream we do not read — cancel it so
    // the connection is released instead of dangling for the whole turn.
    const { response } = await startCamberChat({ ...context, conversationId });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const classified = classifyCamberError(response.status, text);
      const error = new Error(classified.message);
      error.status = response.status;
      error.camberCode = classified.code;
      throw error;
    }
    if (response.body?.cancel) {
      await response.body.cancel().catch(() => {});
    }

    const deadline = Date.now() + CAMBER_ASYNC_TIMEOUT_MS;
    for (;;) {
      const { status } = await fetchCamberConversationStatus(conversationId, credentials, {
        signal,
        proxyOptions,
        config,
      });
      if (status !== "running") break;
      if (Date.now() >= deadline) throw new Error("Camber async run did not finish in time");
      log?.debug?.("CAMBER", `async run ${conversationId} still running`);
      await sleep(CAMBER_ASYNC_POLL_INTERVAL_MS, signal);
    }

    return fetchCamberConversationReply(conversationId, credentials, { signal, proxyOptions, config });
  }

  parseError(response, bodyText) {
    const classified = classifyCamberError(response.status, bodyText);
    return { status: response.status, message: classified.message, code: classified.code };
  }

  async refreshCredentials() {
    // The credential is a long-lived API key: there is nothing to refresh.
    return null;
  }

  needsRefresh() {
    return false;
  }
}

/** Drain a streaming response into { content, reasoning, usage } (non-stream case). */
export async function collectCamberStream(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  const reader = response.body?.getReader?.();
  if (!reader) return { content, reasoning, usage };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = decodeCamberFrames(buffer);
    buffer = rest;
    for (const event of events) {
      if (event.type === "text") content += event.text;
      else if (event.type === "reasoning") reasoning += event.text;
      else if (event.type === "finish" && event.usage) usage = event.usage;
      else if (event.type === "error") {
        const error = new Error(event.message);
        error.status = 502;
        throw error;
      }
    }
  }
  return { content: content || (buffer ? stripUnknownFrames(buffer) : ""), reasoning, usage };
}

/** Last-resort text extraction if the stream ended without a newline. */
function stripUnknownFrames(text) {
  const { events } = decodeCamberFrames(`${text}\n`);
  return events
    .filter((event) => event.type === "text")
    .map((event) => event.text)
    .join("");
}

export { CamberExecutor };
export { resolveCamberAgent };
export default CamberExecutor;

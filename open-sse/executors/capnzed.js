// CapnZedExecutor — 9capn's own Zed hosted-models provider, trial-account edition.
//
// Upstream ships a `zed` provider (see executors/zed.js) that speaks the same
// protocol but treats the account as a normal BYO credential. CapnZed is the
// opposite trade: it assumes EVERY connection is a throwaway Zed account on the
// free Pro trial, and it is built to survive that assumption:
//
//   1. PRE-FLIGHT PLAN GATE. Before spending an upstream request it reads the
//      account's plan from /client/users/me and refuses anything that is not
//      zed_pro_trial / zed_pro (or that Zed flags as too-young / overdue). A
//      refused account returns a non-ok Response carrying `resetsAtMs`, which is
//      what makes the engine park it and move to the next account.
//
//   2. TRIAL EXHAUSTION == ROTATE. The trial is "$5 of GPT Luna ... for 14 days";
//      running out returns HTTP 402. We turn that into a whole-account lock until
//      the trial window ends instead of a 2-minute retry, because the credit never
//      refills. Also handles Zed's in-stream `{"status":{"failed":…}}` frame, which
//      arrives AFTER a 200 and would otherwise surface as a truncated stream.
//
//   3. STICKY EGRESS. Zed gates trials per IP as well as per account, so the
//      connection's proxy MUST reach the wire. `proxyOptions` is threaded into
//      every fetch — the account API, the model catalog, the LLM-token exchange
//      and /completions. (Upstream's zed executor passes a signal into
//      proxyAwareFetch's proxyOptions slot, silently dropping the proxy.)
//
// Protocol notes: POST /completions is a pass-through relay — we send
// { thread_id, prompt_id, provider, model, provider_request } where
// provider_request is the raw provider-native body — and the response is NDJSON
// whose `event` payload is shaped like whichever upstream Zed fronts for the
// model (Anthropic / OpenAI Responses / Google / xAI / Baseten). The existing
// translators convert both directions.

import { BaseExecutor } from "./base.js";
import { FORMATS } from "../translator/formats.js";
import { initState } from "../translator/index.js";
import { openaiToClaudeRequest } from "../translator/request/openai-to-claude.js";
import { openaiToGeminiRequest } from "../translator/request/openai-to-gemini.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { claudeToOpenAIResponse } from "../translator/response/claude-to-openai.js";
import { geminiToOpenAIResponse } from "../translator/response/gemini-to-openai.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import {
  CAPNZED_HEADERS,
  CAPNZED_LOCK_CODES,
  capnZedLockUntilMs,
  capnZedLlmFetch,
  isCapnZedAccountExhausted,
  isCapnZedInStreamAccountFailure,
  loadCapnZedPlan,
  markCapnZedAccountSpent,
  resolveCapnZedModels,
} from "../shared/capnzedAuth.js";

const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_FORBIDDEN = 403;

/** Zed's LanguageModelProvider enum — snake_case names as sent on the wire. */
const PROVIDERS = {
  anthropic: "Anthropic",
  baseten: "Baseten",
  openai: "OpenAi",
  google: "Google",
  xai: "XAi",
};

/** How many prefix bytes to inspect for an immediate account failure. */
const PREFIX_PEEK_BYTES = 64 * 1024;

/**
 * Model families Zed relays through Baseten (open weights). Needed only as a
 * fallback: the live catalog carries an explicit `provider` per model, and that
 * always wins. Keep in sync with the static catalog in registry/capnzed.js.
 */
const BASETEN_FAMILIES = [
  "baseten",
  "deepseek",
  "glm",
  "kimi",
  "minimax",
  "mimo",
  "qwen",
  "muse-spark",
  "hy3",
];

/**
 * Map a catalog `provider` (or a model id) to Zed's relay provider enum.
 * Baseten relays an OpenAI Chat Completions body — it must NOT fall through to
 * OpenAi, which would send a Responses-shaped body and get rejected.
 */
export function normalizeCapnZedProvider(value, model) {
  const raw = String(value || "").toLowerCase();
  if (raw === "anthropic") return PROVIDERS.anthropic;
  if (raw === "baseten") return PROVIDERS.baseten;
  if (raw === "openai" || raw === "open_ai") return PROVIDERS.openai;
  if (raw === "google" || raw === "gemini") return PROVIDERS.google;
  if (raw === "xai" || raw === "x_ai" || raw === "x-ai") return PROVIDERS.xai;

  const m = String(model || "").toLowerCase();
  if (m.includes("claude")) return PROVIDERS.anthropic;
  if (m.includes("gemini")) return PROVIDERS.google;
  if (m.includes("grok") || m.includes("xai")) return PROVIDERS.xai;
  if (BASETEN_FAMILIES.some((family) => m.includes(family))) return PROVIDERS.baseten;
  return PROVIDERS.openai;
}

function buildProviderRequest(provider, model, body, stream, credentials) {
  if (provider === PROVIDERS.anthropic) return openaiToClaudeRequest(model, body, true);
  if (provider === PROVIDERS.google) return openaiToGeminiRequest(model, body, true);
  if (provider === PROVIDERS.openai) {
    return openaiToOpenAIResponsesRequest(model, body, true, credentials);
  }
  // xAI and Baseten are OpenAI Chat-Completions shaped — forward as-is.
  return { ...(body || {}), model, stream: stream !== false };
}

function initProviderState(provider, model) {
  if (provider === PROVIDERS.anthropic) return initState(FORMATS.CLAUDE);
  if (provider === PROVIDERS.google) return initState(FORMATS.GEMINI);
  if (provider === PROVIDERS.openai) return initState(FORMATS.OPENAI_RESPONSES);
  const state = initState(FORMATS.OPENAI);
  state.model = model;
  return state;
}

function convertProviderEvent(provider, event, state) {
  if (provider === PROVIDERS.anthropic) return claudeToOpenAIResponse(event, state);
  if (provider === PROVIDERS.google) return geminiToOpenAIResponse(event, state);
  if (provider === PROVIDERS.openai) return openaiResponsesToOpenAIResponse(event, state);
  return event;
}

function enqueueSseObject(controller, encoder, chunk) {
  if (!chunk) return;
  const items = Array.isArray(chunk) ? chunk : [chunk];
  for (const item of items) {
    if (!item) continue;
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
  }
}

function createErrorChunk(model, message) {
  return {
    id: `chatcmpl-capnzed-error-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, delta: { content: `[CapnZed error] ${message}` }, finish_reason: "stop" },
    ],
  };
}

/** Parse one NDJSON line into { event } | { status } | { done }. */
function unwrapLine(line) {
  let text = line.replace(/\r$/, "").trim();
  if (!text) return null;
  if (text.startsWith("data:")) text = text.slice(5).trimStart();
  if (text === "[DONE]") return { done: true };
  try {
    const parsed = JSON.parse(text);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "event")) {
      return { event: parsed.event };
    }
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "status")) {
      return { status: parsed.status };
    }
    return { event: parsed };
  } catch {
    return null;
  }
}

function normalizeStatus(status) {
  if (!status) return null;
  if (typeof status === "string") return { type: status };
  if (typeof status === "object") {
    const key = Object.keys(status)[0];
    if (key && typeof status[key] === "object") return { type: key, ...status[key] };
    return status;
  }
  return null;
}

/** Rebuild a Response whose body first replays `buffered` then the live reader. */
function rewrapResponse(response, buffered, reader) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
      if (!reader) {
        controller.close();
        return;
      }
      return (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      })();
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Peek the first frames of a 200 response for an immediate account failure.
 *
 * Zed can accept the request (HTTP 200) and then immediately stream
 * `{"status":{"failed":{code,message}}}` when the credit check fails. Returning
 * that as a truncated stream would look like a model bug, so we detect it and
 * convert it into a real 402 so the account rotates.
 *
 * Returns { failure: object|null, response: Response } — `response` is always
 * safe to consume (prefix bytes are replayed).
 */
async function peekAccountFailure(response, model, log) {
  if (!response?.ok || !response.body) return { failure: null, response };

  const reader = response.body.getReader();
  const buffered = [];
  let total = 0;
  let text = "";
  let failure = null;

  try {
    while (total < PREFIX_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffered.push(value);
      total += value.byteLength;
      text += new TextDecoder().decode(value, { stream: true });

      let nl;
      while ((nl = text.indexOf("\n")) !== -1) {
        const line = text.slice(0, nl);
        text = text.slice(nl + 1);
        const payload = unwrapLine(line);
        if (!payload) continue;
        if (payload.status) {
          const status = normalizeStatus(payload.status);
          if (status?.type === "failed" || status?.failed) {
            const failed = status.failed || status;
            if (isCapnZedInStreamAccountFailure(status)) {
              failure = {
                code: failed.code || CAPNZED_LOCK_CODES.trialExhausted,
                message: String(
                  failed.message || failed.error || failed.code || "account is out of trial credit",
                ),
              };
            }
          }
        } else if (payload.event) {
          // First real model event — the turn is genuinely streaming.
          break;
        }
      }
      if (failure) break;
      if (text && text.trim() && !text.trim().startsWith("{") && !text.trim().startsWith("data:")) {
        // Non-JSON content: not our envelope, stop probing.
        break;
      }
    }
  } catch (error) {
    log?.warn?.("CAPNZED", `prefix peek failed: ${error.message}`);
    return { failure: null, response: rewrapResponse(response, buffered, reader) };
  }

  if (!failure) return { failure: null, response: rewrapResponse(response, buffered, reader) };

  reader.cancel().catch(() => {});
  log?.warn?.("CAPNZED", `account out of trial credit mid-stream: ${failure.message}`);
  return { failure, response: null, model };
}

function accountFailureResponse({ status, message, code, resetsAtMs }) {
  return new Response(
    JSON.stringify({
      error: { message, type: "billing_error", code: code || CAPNZED_LOCK_CODES.trialExhausted },
      code: code || CAPNZED_LOCK_CODES.trialExhausted,
      resetsAtMs: resetsAtMs || null,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

class CapnZedExecutor extends BaseExecutor {
  constructor() {
    super("capnzed");
  }

  /** Resolve the relay provider Zed uses for this model, from the live catalog. */
  async resolveModel(model, credentials, signal, log, proxyOptions = null) {
    try {
      const catalog = await resolveCapnZedModels(credentials, {
        config: this.config,
        signal,
        proxyOptions,
      });
      let raw = catalog?.rawById?.get(model) ?? null;
      if (!raw) {
        const refreshed = await resolveCapnZedModels(credentials, {
          config: this.config,
          signal,
          proxyOptions,
          forceRefresh: true,
        });
        raw = refreshed?.rawById?.get(model) ?? null;
      }
      return { raw, provider: normalizeCapnZedProvider(raw?.provider, model) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.warn?.("CAPNZED", `catalog unavailable, inferring provider for ${model}: ${message}`);
      return { raw: null, provider: normalizeCapnZedProvider(null, model) };
    }
  }

  /**
   * Pre-flight plan gate. Degrades OPEN on any failure: if we cannot read the
   * plan we would rather spend one upstream request (and let the 402 path handle
   * it) than refuse a healthy account because of a transient network blip.
   */
  async assertPlanAllowed(credentials, { signal, log, proxyOptions }) {
    if (!credentials?.accessToken && !credentials?.apiKey) {
      return { allowed: false, status: HTTP_FORBIDDEN, code: "no_credentials", message: "CapnZed connection is missing an access token." };
    }

    try {
      const plan = await loadCapnZedPlan(credentials, {
        config: this.config,
        signal,
        proxyOptions,
      });
      if (plan.allowed) return { allowed: true };
      log?.warn?.("CAPNZED", `account not eligible [${plan.code}]: ${plan.reason}`);
      return {
        allowed: false,
        status: HTTP_FORBIDDEN,
        code: plan.code,
        message: plan.reason,
        resetsAtMs: plan.lockUntilMs,
      };
    } catch (error) {
      log?.warn?.("CAPNZED", `plan check failed, proceeding: ${error.message}`);
      return { allowed: true };
    }
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const plan = await this.assertPlanAllowed(credentials, { signal, log, proxyOptions });
    if (!plan.allowed) {
      return {
        response: accountFailureResponse({
          status: plan.status,
          message: plan.message,
          code: plan.code,
          resetsAtMs: plan.resetsAtMs,
        }),
        url: "capnzed://plan-gate",
        headers: { "Content-Type": "application/json" },
        transformedBody: null,
      };
    }

    const { provider } = await this.resolveModel(model, credentials, signal, log, proxyOptions);
    const providerRequest = buildProviderRequest(provider, model, body, stream, credentials);
    const bodyRecord = body || {};
    const payload = {
      thread_id:
        bodyRecord.thread_id || credentials?._clientSessionId || credentials?.connectionId,
      prompt_id: bodyRecord.prompt_id,
      provider,
      model,
      provider_request: providerRequest,
    };

    const response = await capnZedLlmFetch(credentials, "/completions", {
      config: this.config,
      signal,
      proxyOptions,
      fetchOptions: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson, text/event-stream, */*",
          "User-Agent": "9capn/capnzed",
          [CAPNZED_HEADERS.version]: String(this.config?.appVersion || "1.19.2"),
          [CAPNZED_HEADERS.clientSupportsStatus]: "true",
          [CAPNZED_HEADERS.clientSupportsStreamEnded]: "true",
        },
        body: JSON.stringify(payload),
      },
    });

    const base = {
      url: `${this.config?.llmBaseUrl || "https://cloud.zed.dev"}/completions`,
      headers: { "Content-Type": "application/json" },
      transformedBody: payload,
    };

    if (!response.ok) return { ...base, response };

    const peeked = await peekAccountFailure(response, model, log);
    if (peeked.failure) {
      const lockUntilMs = await this.resolveLockUntilMs(credentials, {
        signal,
        log,
        proxyOptions,
      });
      await this.noteSpent(credentials, peeked.failure.message, lockUntilMs, log);
      return {
        ...base,
        response: accountFailureResponse({
          status: HTTP_PAYMENT_REQUIRED,
          message: `CapnZed: ${peeked.failure.message}`,
          code: CAPNZED_LOCK_CODES.trialExhausted,
          resetsAtMs: lockUntilMs,
        }),
      };
    }

    return { ...base, response: wrapCompletionStream(peeked.response, provider, model) };
  }

  /** Best-effort trial-window end for parking this account. */
  async resolveLockUntilMs(credentials, { signal, log, proxyOptions }) {
    try {
      const userInfo = await loadCapnZedPlan(credentials, {
        config: this.config,
        signal,
        proxyOptions,
        forceRefresh: true,
      });
      if (userInfo?.userInfo) return capnZedLockUntilMs(userInfo.userInfo);
      if (userInfo?.lockUntilMs) return userInfo.lockUntilMs;
    } catch (error) {
      log?.warn?.("CAPNZED", `could not read trial window for lock: ${error.message}`);
    }
    return capnZedLockUntilMs(null);
  }

  async noteSpent(credentials, reason, lockUntilMs, log) {
    markCapnZedAccountSpent(credentials, {
      reason,
      code: CAPNZED_LOCK_CODES.trialExhausted,
      lockUntilMs,
    });
    log?.warn?.(
      "CAPNZED",
      `trial credit spent — parking account for ${Math.round((lockUntilMs - Date.now()) / 3600000)}h`,
    );
  }

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "{}");
    } catch {
      parsed = null;
    }

    const errorObj = parsed?.error || undefined;
    const code = parsed?.code || errorObj?.code || "";
    const resetsAtMs = Number.isFinite(parsed?.resetsAtMs) ? parsed.resetsAtMs : undefined;
    const rawMessage =
      parsed?.message || errorObj?.message || bodyText || response.statusText;

    if (isCapnZedAccountExhausted(response.status, bodyText)) {
      return {
        status: HTTP_PAYMENT_REQUIRED,
        message:
          "CapnZed: this Zed account has used up its trial credit ($5 / 14 days). " +
          `Rotating to the next account. Zed said: ${rawMessage}`,
        resetsAtMs,
      };
    }

    if (code === CAPNZED_LOCK_CODES.trialBlocked || /trial access is blocked/i.test(rawMessage)) {
      return {
        status: HTTP_FORBIDDEN,
        message:
          "CapnZed: Zed is blocking trial access for this egress IP. " +
          "Give the connection its own proxy pool so each account leaves from a unique IP. " +
          `Zed said: ${rawMessage}`,
        resetsAtMs,
      };
    }

    if (resetsAtMs || code) {
      return { status: response.status, message: `CapnZed ${code || ""}: ${rawMessage}`.trim(), resetsAtMs };
    }

    return { status: response.status, message: rawMessage || `CapnZed upstream error: ${response.status}` };
  }

  async refreshCredentials() {
    // A Zed access token is long-lived; the short-lived LLM token is refreshed
    // inside capnZedAuth (on 401 or the x-zed-expired-token header).
    return null;
  }

  needsRefresh() {
    return false;
  }
}

/** NDJSON → OpenAI SSE, terminating exactly once on `stream_ended`. */
function wrapCompletionStream(response, provider, model) {
  if (!response?.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = initProviderState(provider, model);
  let buffer = "";
  let done = false;

  const finish = (controller) => {
    if (done) return;
    done = true;
    enqueueSseObject(controller, encoder, convertProviderEvent(provider, null, state));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };

  const processLine = (line, controller) => {
    if (done) return;
    const payload = unwrapLine(line);
    if (!payload) return;

    if (payload.done) return finish(controller);

    if (payload.status) {
      const status = normalizeStatus(payload.status);
      if (status?.type === "failed" || status?.failed) {
        const failed = status.failed || status;
        enqueueSseObject(
          controller,
          encoder,
          createErrorChunk(model, String(failed.message || failed.error || failed.code || "request failed")),
        );
        finish(controller);
      } else if (status?.type === "stream_ended" || status === "stream_ended") {
        finish(controller);
      }
      return;
    }

    enqueueSseObject(controller, encoder, convertProviderEvent(provider, payload.event, state));
  };

  const transformed = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          processLine(line, controller);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) {
          processLine(buffer, controller);
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

export default CapnZedExecutor;
export { CapnZedExecutor };

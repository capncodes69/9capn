import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the CapnZed protocol layer so the executor is exercised without a live
// Zed account. Everything below the executor (translators, BaseExecutor) stays real.
vi.mock("../../open-sse/shared/capnzedAuth.js", () => ({
  CAPNZED_HEADERS: {
    version: "x-zed-version",
    clientSupportsStatus: "x-zed-client-supports-status-messages",
    clientSupportsStreamEnded: "x-zed-client-supports-stream-ended-request-completion-status",
    clientSupportsXai: "x-zed-client-supports-x-ai",
  },
  CAPNZED_LOCK_CODES: {
    planNotEligible: "capnzed_plan_not_eligible",
    trialExhausted: "capnzed_trial_exhausted",
    accountTooYoung: "capnzed_account_too_young",
    overdueInvoices: "capnzed_overdue_invoices",
    trialBlocked: "capnzed_trial_blocked",
  },
  capnZedLockUntilMs: vi.fn(() => Date.now() + 14 * 24 * 60 * 60 * 1000),
  capnZedLlmFetch: vi.fn(),
  isCapnZedAccountExhausted: vi.fn(
    (status, body) =>
      Number(status) === 402 || /payment required|free usage limit/i.test(String(body || "")),
  ),
  isCapnZedInStreamAccountFailure: vi.fn((status) => {
    const failed = status?.failed || status || {};
    const text = [failed.code, failed.message, status?.type].filter(Boolean).join(" ").toLowerCase();
    return text.includes("payment required") || text.includes("payment_required");
  }),
  loadCapnZedPlan: vi.fn(),
  markCapnZedAccountSpent: vi.fn(),
  resolveCapnZedModels: vi.fn(async () => ({ rawById: new Map() })),
}));

import CapnZedExecutor, {
  normalizeCapnZedProvider,
} from "../../open-sse/executors/capnzed.js";
import {
  capnZedLlmFetch,
  loadCapnZedPlan,
  markCapnZedAccountSpent,
  resolveCapnZedModels,
} from "../../open-sse/shared/capnzedAuth.js";

const CREDENTIALS = {
  accessToken: "zed-access-token",
  providerSpecificData: { userId: "42", systemId: "sys-1", organizationId: "org-1" },
};

const LOG = { warn: vi.fn(), debug: vi.fn(), errorLine: vi.fn() };

function ndjsonResponse(lines, status = 200) {
  const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

async function drain(response) {
  if (!response?.body) return "";
  return await new Response(response.body).text();
}

let executor;

beforeEach(() => {
  vi.clearAllMocks();
  executor = new CapnZedExecutor();
  loadCapnZedPlan.mockResolvedValue({ allowed: true, userInfo: { plan: { plan_v3: "zed_pro_trial" } } });
  resolveCapnZedModels.mockResolvedValue({ rawById: new Map() });
});

describe("normalizeCapnZedProvider", () => {
  it("maps every provider in Zed's LanguageModelProvider enum", () => {
    expect(normalizeCapnZedProvider("anthropic")).toBe("Anthropic");
    expect(normalizeCapnZedProvider("baseten")).toBe("Baseten");
    expect(normalizeCapnZedProvider("open_ai")).toBe("OpenAi");
    expect(normalizeCapnZedProvider("google")).toBe("Google");
    expect(normalizeCapnZedProvider("x_ai")).toBe("XAi");
  });

  it("maps Baseten to Baseten, never to OpenAi (wrong body shape)", () => {
    // The regression this guards: Baseten relays a Chat Completions body, so
    // falling through to OpenAi would send a Responses-shaped request.
    expect(normalizeCapnZedProvider("baseten", "some-baseten-model")).toBe("Baseten");
  });

  it("infers from the model id when the catalog has no provider", () => {
    expect(normalizeCapnZedProvider(null, "claude-sonnet-4-5")).toBe("Anthropic");
    expect(normalizeCapnZedProvider(null, "gemini-2.5-pro")).toBe("Google");
    expect(normalizeCapnZedProvider(null, "grok-4")).toBe("XAi");
    expect(normalizeCapnZedProvider(null, "gpt-5")).toBe("OpenAi");
  });
});

describe("pre-flight plan gate", () => {
  it("refuses a non-eligible account and carries resetsAtMs for rotation", async () => {
    const lockUntilMs = Date.now() + 5 * 24 * 60 * 60 * 1000;
    loadCapnZedPlan.mockResolvedValue({
      allowed: false,
      code: "capnzed_plan_not_eligible",
      reason: "CapnZed only serves Zed Pro Trial or Zed Pro accounts; this one is on Zed Free.",
      lockUntilMs,
    });

    const result = await executor.execute({
      model: "claude-sonnet-4-5",
      body: { messages: [] },
      stream: true,
      credentials: CREDENTIALS,
      log: LOG,
    });

    expect(result.response.ok).toBe(false);
    expect(result.response.status).toBe(403);
    // No upstream request was burned.
    expect(capnZedLlmFetch).not.toHaveBeenCalled();

    const parsed = executor.parseError(result.response, await result.response.text());
    expect(parsed.status).toBe(403);
    expect(parsed.resetsAtMs).toBe(lockUntilMs);
  });

  it("degrades OPEN when the plan cannot be read (never blocks a healthy account)", async () => {
    loadCapnZedPlan.mockRejectedValue(new Error("network down"));
    capnZedLlmFetch.mockResolvedValue(
      ndjsonResponse([{ status: "stream_ended" }]),
    );

    const result = await executor.execute({
      model: "claude-sonnet-4-5",
      body: { messages: [] },
      stream: true,
      credentials: CREDENTIALS,
      log: LOG,
    });

    expect(capnZedLlmFetch).toHaveBeenCalled();
    expect(result.response.ok).toBe(true);
  });

  it("refuses when the connection has no credentials at all", async () => {
    const result = await executor.execute({
      model: "claude-sonnet-4-5",
      body: {},
      stream: true,
      credentials: {},
      log: LOG,
    });
    expect(result.response.status).toBe(403);
    expect(capnZedLlmFetch).not.toHaveBeenCalled();
  });
});

describe("execute — relay envelope", () => {
  it("sends the {thread_id, provider, model, provider_request} relay body", async () => {
    resolveCapnZedModels.mockResolvedValue({
      rawById: new Map([["claude-sonnet-4-5", { id: "claude-sonnet-4-5", provider: "anthropic" }]]),
    });
    capnZedLlmFetch.mockResolvedValue(ndjsonResponse([{ status: "stream_ended" }]));

    const result = await executor.execute({
      model: "claude-sonnet-4-5",
      body: { messages: [{ role: "user", content: "hi" }], thread_id: "thread-1" },
      stream: true,
      credentials: { ...CREDENTIALS, _clientSessionId: "sess-9" },
      log: LOG,
    });

    const payload = result.transformedBody;
    expect(payload.thread_id).toBe("thread-1");
    expect(payload.provider).toBe("Anthropic");
    expect(payload.model).toBe("claude-sonnet-4-5");
    // provider_request is the raw provider-native body (Anthropic-shaped here).
    expect(payload.provider_request.messages).toBeDefined();
    expect(payload.provider_request.max_tokens).toBeDefined();
  });

  it("falls back to the client session id for thread_id", async () => {
    capnZedLlmFetch.mockResolvedValue(ndjsonResponse([{ status: "stream_ended" }]));

    const result = await executor.execute({
      model: "grok-4",
      body: { messages: [] },
      stream: true,
      credentials: { ...CREDENTIALS, _clientSessionId: "sess-9" },
      log: LOG,
    });

    expect(result.transformedBody.thread_id).toBe("sess-9");
  });

  it("forwards the connection proxy to every LLM fetch (the sticky-egress bug)", async () => {
    capnZedLlmFetch.mockResolvedValue(ndjsonResponse([{ status: "stream_ended" }]));
    const proxyOptions = { enabled: true, url: "http://proxy.local:8080", strictProxy: true };

    await executor.execute({
      model: "grok-4",
      body: { messages: [] },
      stream: true,
      credentials: CREDENTIALS,
      log: LOG,
      proxyOptions,
    });

    expect(capnZedLlmFetch).toHaveBeenCalledWith(
      CREDENTIALS,
      "/completions",
      expect.objectContaining({ proxyOptions }),
    );
    // The catalog lookup must egress the same way.
    expect(resolveCapnZedModels).toHaveBeenCalledWith(
      CREDENTIALS,
      expect.objectContaining({ proxyOptions }),
    );
  });

  it("sends Zed's status-message headers", async () => {
    capnZedLlmFetch.mockResolvedValue(ndjsonResponse([{ status: "stream_ended" }]));

    await executor.execute({
      model: "grok-4", body: { messages: [] }, stream: true, credentials: CREDENTIALS, log: LOG,
    });

    const fetchOptions = capnZedLlmFetch.mock.calls[0][2].fetchOptions;
    expect(fetchOptions.headers["x-zed-client-supports-status-messages"]).toBe("true");
    expect(fetchOptions.headers["Content-Type"]).toBe("application/json");
  });
});

describe("trial exhaustion → rotate the whole account", () => {
  it("maps a 402 to a clear message plus resetsAtMs", async () => {
    capnZedLlmFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: "payment required to use this language model" }), {
        status: 402,
      }),
    );

    const result = await executor.execute({
      model: "claude-sonnet-4-5",
      body: { messages: [] },
      stream: true,
      credentials: CREDENTIALS,
      log: LOG,
    });
    expect(result.response.status).toBe(402);

    const body = await result.response.text();
    const parsed = executor.parseError(result.response, body);
    expect(parsed.status).toBe(402);
    expect(parsed.message).toMatch(/trial credit/);
    expect(parsed.message).toMatch(/Rotating to the next account/);
  });

  it("converts an in-stream failure frame into a 402 so the account rotates", async () => {
    capnZedLlmFetch.mockResolvedValue(
      ndjsonResponse([
        { status: { failed: { code: "payment_required", message: "payment required" } } },
      ]),
    );

    const result = await executor.execute({
      model: "claude-sonnet-4-5",
      body: { messages: [] },
      stream: true,
      credentials: CREDENTIALS,
      log: LOG,
    });

    expect(result.response.status).toBe(402);
    expect(capnZedLlmFetch).toHaveBeenCalledTimes(1);
    // The account is recorded as spent so the next request parks it outright.
    expect(markCapnZedAccountSpent).toHaveBeenCalledWith(
      CREDENTIALS,
      expect.objectContaining({ code: "capnzed_trial_exhausted" }),
    );
  });

  it("explains the per-IP trial block when Zed refuses the egress IP", async () => {
    const body = JSON.stringify({
      message: "Trial access is blocked. Please reach out to billing-support@zed.dev",
    });
    const parsed = executor.parseError(new Response(body, { status: 403 }), body);

    expect(parsed.status).toBe(403);
    expect(parsed.message).toMatch(/egress IP/);
    expect(parsed.message).toMatch(/proxy pool/);
  });
});

describe("stream wrapping", () => {
  it("terminates exactly once on stream_ended (single [DONE])", async () => {
    capnZedLlmFetch.mockResolvedValue(
      ndjsonResponse([
        { event: { type: "message_start", message: { usage: { input_tokens: 3 } } } },
        { event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
        { event: { type: "message_stop" } },
        { status: "stream_ended" },
      ]),
    );

    const result = await executor.execute({
      model: "claude-sonnet-4-5",
      body: { messages: [] },
      stream: true,
      credentials: CREDENTIALS,
      log: LOG,
    });

    const text = await drain(result.response);
    // Exactly one terminator, no matter how many status frames preceded it.
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    // The Anthropic event was translated into OpenAI chunks.
    expect(text).toContain('"content":"hi"');
    expect(text).toContain('"finish_reason":"stop"');
  });

  it("also terminates when the body ends without an explicit stream_ended", async () => {
    capnZedLlmFetch.mockResolvedValue(
      ndjsonResponse([{ event: { type: "message_start", message: { usage: { input_tokens: 1 } } } }]),
    );

    const result = await executor.execute({
      model: "claude-sonnet-4-5",
      body: { messages: [] },
      stream: true,
      credentials: CREDENTIALS,
      log: LOG,
    });

    const text = await drain(result.response);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("passes a successful non-stream body straight through", async () => {
    const upstream = ndjsonResponse([{ status: "stream_ended" }]);
    capnZedLlmFetch.mockResolvedValue(upstream);

    const result = await executor.execute({
      model: "grok-4",
      body: { messages: [] },
      stream: true,
      credentials: CREDENTIALS,
      log: LOG,
    });

    expect(result.response.headers.get("Content-Type")).toBe("text/event-stream");
  });
});

describe("refresh contract", () => {
  it("never claims a refresh is needed (Zed tokens are long-lived)", () => {
    expect(executor.needsRefresh(CREDENTIALS)).toBe(false);
  });

  it("returns null from refreshCredentials", async () => {
    await expect(executor.refreshCredentials()).resolves.toBeNull();
  });
});

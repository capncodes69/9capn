import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only the network-facing helpers are stubbed; every pure protocol function
// (frame decoding, error classification, body building) stays real so the
// executor is exercised against the actual wire format.
const startCamberChat = vi.fn();
const initCamberConversation = vi.fn();
const fetchCamberConversationStatus = vi.fn();
const fetchCamberConversationReply = vi.fn();
const fetchCamberMe = vi.fn();

vi.mock("../../open-sse/shared/camberAuth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    startCamberChat: (...args) => startCamberChat(...args),
    initCamberConversation: (...args) => initCamberConversation(...args),
    fetchCamberConversationStatus: (...args) => fetchCamberConversationStatus(...args),
    fetchCamberConversationReply: (...args) => fetchCamberConversationReply(...args),
    fetchCamberMe: (...args) => fetchCamberMe(...args),
  };
});

const {
  CAMBER_ASYNC_POLL_INTERVAL_MS,
  CamberExecutor,
  collectCamberStream,
  isCamberAsyncFallbackWorthwhile,
  synthesizeCamberStream,
  translateCamberStream,
} = await import("../../open-sse/executors/camber.js");

const encoder = new TextEncoder();

/** A Response whose body emits the given raw protocol text. */
function frameResponse(text, status = 200) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status });
}

function okStream(text) {
  return { response: frameResponse(text), body: { content: "hi", model_name: "bedrock:claude-opus-5" } };
}

const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };

function makeExecutor() {
  return new CamberExecutor();
}

function ssePayloads(text) {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length));
}

beforeEach(() => {
  for (const fn of [
    startCamberChat,
    initCamberConversation,
    fetchCamberConversationStatus,
    fetchCamberConversationReply,
    fetchCamberMe,
  ]) {
    fn.mockReset();
  }
  log.warn.mockReset();
  log.debug.mockReset();
});

describe("isCamberAsyncFallbackWorthwhile", () => {
  it("retries only transient transport failures", () => {
    for (const status of [408, 429, 502, 503, 504]) {
      expect(isCamberAsyncFallbackWorthwhile(status)).toBe(true);
    }
  });

  it("does NOT retry a refusal — the answer would be identical", () => {
    for (const status of [400, 401, 403, 404, 422, 500]) {
      expect(isCamberAsyncFallbackWorthwhile(status)).toBe(false);
    }
  });

  it("treats a network error (no status at all) as retryable", () => {
    expect(isCamberAsyncFallbackWorthwhile(NaN)).toBe(true);
  });
});

describe("translateCamberStream", () => {
  it("turns text frames into OpenAI chunks with real usage and ONE [DONE]", async () => {
    const translated = translateCamberStream(
      frameResponse(
        'f:{"messageId":"m1"}\n0:"OK"\nd:{"finishReason":"stop","usage":{"promptTokens":1134,"completionTokens":4}}\nz:[]\n',
      ),
      "claude-opus-5",
    );
    const text = await translated.text();
    expect(translated.headers.get("Content-Type")).toBe("text/event-stream");

    const payloads = ssePayloads(text).map((p) => (p === "[DONE]" ? p : JSON.parse(p)));
    const content = payloads
      .filter((p) => p !== "[DONE]")
      .map((p) => p.choices[0].delta.content)
      .filter(Boolean);
    expect(content).toEqual(["OK"]);

    const finish = payloads.find((p) => p !== "[DONE]" && p.choices[0].finish_reason === "stop");
    expect(finish.usage).toEqual({ prompt_tokens: 1134, completion_tokens: 4, total_tokens: 1138 });

    // Exactly one terminator: the z: frame arrives after d: and must not add a
    // second one.
    expect(payloads.filter((p) => p === "[DONE]")).toHaveLength(1);
    expect(payloads[payloads.length - 1]).toBe("[DONE]");
  });

  it("drops tool traffic and step frames instead of leaking them as text", async () => {
    const translated = translateCamberStream(
      frameResponse(
        '9:{"toolCallId":"t1","toolName":"jupyter_start_server","args":{}}\na:{"toolCallId":"t1","result":{"ok":true}}\nb:{"toolCallId":"t1","toolName":"x"}\ne:{"finishReason":"tool-calls","usage":{"promptTokens":null,"completionTokens":null}}\n0:"done"\nd:{"finishReason":"stop"}\n',
      ),
      "claude-opus-5",
    );
    const payloads = ssePayloads(await translated.text()).filter((p) => p !== "[DONE]");
    const content = payloads.map((p) => JSON.parse(p).choices[0].delta.content).filter(Boolean);
    expect(content).toEqual(["done"]);
  });

  it("still emits a well-formed stream when the run produced no text", async () => {
    const translated = translateCamberStream(frameResponse("z:[]\n"), "claude-opus-5");
    const payloads = ssePayloads(await translated.text());
    expect(payloads).toHaveLength(3); // role chunk + finish + [DONE]
    expect(JSON.parse(payloads[0]).choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(JSON.parse(payloads[1]).choices[0].finish_reason).toBe("stop");
    expect(payloads[2]).toBe("[DONE]");
  });

  it("surfaces an error frame as text, then closes the stream once", async () => {
    const translated = translateCamberStream(frameResponse('3:"model unavailable"\n'), "claude-opus-5");
    const text = await translated.text();
    expect(text).toContain("[Camber error] model unavailable");
    expect(text).not.toContain("Unhandled");
    expect(ssePayloads(text).filter((p) => p === "[DONE]")).toHaveLength(1);
  });

  it("handles a frame split across two network chunks", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('0:"part'));
        controller.enqueue(encoder.encode('ial"\nd:{"finishReason":"stop"}\n'));
        controller.close();
      },
    });
    const translated = translateCamberStream(new Response(body, { status: 200 }), "claude-opus-5");
    const payloads = ssePayloads(await translated.text()).filter((p) => p !== "[DONE]");
    const content = payloads.map((p) => JSON.parse(p).choices[0].delta.content).filter(Boolean);
    expect(content).toEqual(["partial"]);
  });

  it("forwards g: frames as delta.reasoning_content, not as content", async () => {
    // Live capture for a "47*89" prompt. Before this, the thinking was silently
    // dropped and clients showed no reasoning at all.
    const translated = translateCamberStream(
      frameResponse(
        'g:"47"\ng:"*"\ng:"89"\n0:"4183"\nd:{"finishReason":"stop","usage":{"promptTokens":9,"completionTokens":1}}\nz:[]\n',
      ),
      "claude-opus-5",
    );
    const payloads = ssePayloads(await translated.text())
      .filter((p) => p !== "[DONE]")
      .map((p) => JSON.parse(p));

    const reasoning = payloads
      .map((p) => p.choices[0].delta.reasoning_content)
      .filter(Boolean);
    const content = payloads.map((p) => p.choices[0].delta.content).filter(Boolean);

    expect(reasoning).toEqual(["47", "*", "89"]);
    expect(content).toEqual(["4183"]);
    // The chain of thought must never be folded into the answer.
    expect(content.join("")).not.toContain("47*89");
    expect(payloads.filter((p) => p.choices[0].finish_reason === "stop")).toHaveLength(1);
  });

  it("keeps a reasoning-only turn well formed", async () => {
    // A truncated turn can carry thinking and no answer. The client must still
    // get the thinking, exactly one finish chunk and one terminator — and no
    // phantom empty-content chunk, because something WAS emitted.
    const translated = translateCamberStream(frameResponse('g:"thinking"\nd:{"finishReason":"stop"}\n'), "m");
    const payloads = ssePayloads(await translated.text());
    const parsed = payloads.filter((p) => p !== "[DONE]").map((p) => JSON.parse(p));
    expect(parsed.some((p) => p.choices[0].delta.reasoning_content === "thinking")).toBe(true);
    expect(parsed.filter((p) => p.choices[0].finish_reason === "stop")).toHaveLength(1);
    expect(payloads.filter((p) => p === "[DONE]")).toHaveLength(1);
  });

  it("still emits a role chunk when the run produced NOTHING at all", async () => {
    const translated = translateCamberStream(frameResponse('d:{"finishReason":"stop"}\n'), "m");
    const parsed = ssePayloads(await translated.text())
      .filter((p) => p !== "[DONE]")
      .map((p) => JSON.parse(p));
    expect(parsed[0].choices[0].delta.role).toBe("assistant");
  });

  it("passes an already-failed response straight through", async () => {
    const failed = new Response('{"code":2}', { status: 502 });
    expect(translateCamberStream(failed, "claude-opus-5")).toBe(failed);
  });
});

describe("collectCamberStream / synthesizeCamberStream", () => {
  it("assembles content and usage for the non-stream case", async () => {
    const assembled = await collectCamberStream(
      frameResponse('0:"Hello"\n0:" world"\nd:{"finishReason":"stop","usage":{"promptTokens":5,"completionTokens":2}}\n'),
    );
    expect(assembled.content).toBe("Hello world");
    expect(assembled.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("keeps reasoning out of the assembled content", async () => {
    const assembled = await collectCamberStream(
      frameResponse('g:"47*89 = "\ng:"4183"\n0:"4183"\nd:{"finishReason":"stop"}\n'),
    );
    expect(assembled.content).toBe("4183");
    expect(assembled.reasoning).toBe("47*89 = 4183");
  });

  it("raises a 502 when the stream carries an error frame", async () => {
    await expect(collectCamberStream(frameResponse('3:"boom"\n'))).rejects.toThrow("boom");
  });

  it("re-serialises an async reply into the same SSE shape", async () => {
    const synthesized = synthesizeCamberStream("async answer", "claude-opus-5");
    const payloads = ssePayloads(await synthesized.text());
    expect(payloads[payloads.length - 1]).toBe("[DONE]");
    const content = payloads
      .filter((p) => p !== "[DONE]")
      .map((p) => JSON.parse(p).choices[0].delta.content)
      .filter(Boolean);
    expect(content).toEqual(["async answer"]);
  });
});

describe("execute — success paths", () => {
  it("streams the translated body and reports the upstream URL", async () => {
    startCamberChat.mockResolvedValue(okStream('0:"hi"\nd:{"finishReason":"stop"}\n'));
    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k" },
      log,
    });
    expect(await result.response.text()).toContain('"content":"hi"');
    expect(result.url).toContain("/chat");
    expect(result.transformedBody.model_name).toBe("bedrock:claude-opus-5");
    expect(fetchCamberMe).not.toHaveBeenCalled(); // no extra round-trip on the hot path
  });

  it("returns a single JSON answer when the client asked for stream:false", async () => {
    startCamberChat.mockResolvedValue(
      okStream('0:"hi there"\nd:{"finishReason":"stop","usage":{"promptTokens":3,"completionTokens":2}}\n'),
    );
    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "k" },
      log,
    });
    const parsed = await result.response.json();
    expect(parsed.object).toBe("chat.completion");
    expect(parsed.choices[0].message.content).toBe("hi there");
    expect(parsed.usage.total_tokens).toBe(5);
  });

  it("carries reasoning_content on the non-streaming message", async () => {
    startCamberChat.mockResolvedValue(okStream('g:"2+2"\n0:"4"\nd:{"finishReason":"stop"}\n'));
    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "2+2?" }] },
      stream: false,
      credentials: { apiKey: "k" },
      log,
    });
    const parsed = await result.response.json();
    expect(parsed.choices[0].message.content).toBe("4");
    expect(parsed.choices[0].message.reasoning_content).toBe("2+2");
  });


  it("forwards the client's reasoning effort onto the wire", async () => {
    startCamberChat.mockResolvedValue(okStream('0:"x"\n'));
    await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      stream: true,
      credentials: { apiKey: "k" },
      log,
    });
    expect(startCamberChat.mock.calls[0][0].reasoningEffort).toBe("high");
  });

  it("carries the per-connection agent and proxy through", async () => {
    startCamberChat.mockResolvedValue(okStream('0:"x"\n'));
    await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k", providerSpecificData: { camberAgent: "@reze.my_agent" } },
      proxyOptions: "socks5://127.0.0.1:1080",
      log,
    });
    const context = startCamberChat.mock.calls[0][0];
    expect(context.proxyOptions).toBe("socks5://127.0.0.1:1080");
    expect(context.providerSpecificData.camberAgent).toBe("@reze.my_agent");
  });
});

describe("execute — refusals must not be retried", () => {
  it("400 model not in plan → 400 to the client, no async attempt", async () => {
    startCamberChat.mockResolvedValue({
      response: new Response('{"code":2,"message":"Model not supported by the current plan"}', { status: 400 }),
    });
    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k" },
      log,
    });
    expect(result.response.status).toBe(400);
    expect((await result.response.json()).error.message).toContain("Model not supported");
    expect(initCamberConversation).not.toHaveBeenCalled();
  });

  it("404 unknown agent → no async attempt", async () => {
    startCamberChat.mockResolvedValue({
      response: new Response('{"code":10,"message":"Agent not found"}', { status: 404 }),
    });
    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k", providerSpecificData: { camberAgent: "nope" } },
      log,
    });
    expect(result.response.status).toBe(404);
    expect(initCamberConversation).not.toHaveBeenCalled();
  });

  it("401 bad key → no async attempt", async () => {
    startCamberChat.mockResolvedValue({ response: new Response("", { status: 401 }) });
    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k" },
      log,
    });
    expect(result.response.status).toBe(401);
    expect(initCamberConversation).not.toHaveBeenCalled();
  });
});

describe("execute — async fallback", () => {
  it("recovers from a 503 by creating a conversation and polling", async () => {
    startCamberChat
      .mockResolvedValueOnce({ response: new Response("upstream hiccup", { status: 503 }) })
      // The fire-and-poll run answers 200 (nothing is read from its body).
      .mockResolvedValueOnce(okStream("z:[]\n"));
    initCamberConversation.mockResolvedValue({ id: "conv-1", status: "idle" });
    fetchCamberConversationStatus.mockResolvedValue({ conversationId: "conv-1", status: "idle" });
    fetchCamberConversationReply.mockResolvedValue({
      conversationId: "conv-1",
      content: "recovered answer",
      outputStashFiles: [],
    });

    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k" },
      log,
    });

    const text = await result.response.text();
    expect(text).toContain("recovered answer");
    expect(ssePayloads(text).filter((p) => p === "[DONE]")).toHaveLength(1);
    expect(initCamberConversation).toHaveBeenCalledTimes(1);
    expect(fetchCamberConversationReply).toHaveBeenCalledWith("conv-1", { apiKey: "k" }, expect.anything());
    // The second /chat call must be bound to the new conversation.
    expect(startCamberChat.mock.calls[1][0].conversationId).toBe("conv-1");
  });

  it("keeps polling while the run is still running", async () => {
    // The poll interval is real; collapsing setTimeout makes the loop spin so the
    // "running" branch is covered without a 5s test.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => {
      fn();
      return 0;
    };
    try {
      startCamberChat
        .mockResolvedValueOnce({ response: new Response("", { status: 502 }) })
        .mockResolvedValueOnce(okStream("z:[]\n"));
      initCamberConversation.mockResolvedValue({ id: "conv-2" });
      fetchCamberConversationStatus
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ status: "idle" });
      fetchCamberConversationReply.mockResolvedValue({ content: "late answer" });

      const result = await makeExecutor().execute({
        model: "claude-opus-5",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: { apiKey: "k" },
        log,
      });

      expect(await result.response.text()).toContain("late answer");
      expect(fetchCamberConversationStatus).toHaveBeenCalledTimes(2);
      expect(CAMBER_ASYNC_POLL_INTERVAL_MS).toBe(5000);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  it("retries after a transport error with no HTTP status", async () => {
    startCamberChat
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(okStream("z:[]\n"));
    initCamberConversation.mockResolvedValue({ id: "conv-3" });
    fetchCamberConversationStatus.mockResolvedValue({ status: "idle" });
    fetchCamberConversationReply.mockResolvedValue({ content: "after reset" });

    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k" },
      log,
    });
    expect(await result.response.text()).toContain("after reset");
  });

  it("reports both failures when the fallback dies too", async () => {
    startCamberChat
      .mockResolvedValueOnce({ response: new Response("", { status: 503 }) })
      .mockRejectedValueOnce(Object.assign(new Error("agent exploded"), { status: 500 }));
    initCamberConversation.mockResolvedValue({ id: "conv-4" });

    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k" },
      log,
    });
    const parsed = await result.response.json();
    expect(parsed.error.message).toContain("async fallback failed");
    expect(parsed.error.message).toContain("agent exploded");
  });

  it("gives up clearly when the conversation id is missing", async () => {
    startCamberChat.mockResolvedValueOnce({ response: new Response("", { status: 503 }) });
    initCamberConversation.mockResolvedValue({});

    const result = await makeExecutor().execute({
      model: "claude-opus-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k" },
      log,
    });
    expect((await result.response.json()).error.message).toContain("conversation id");
  });
});

describe("execute — credential pre-flight", () => {
  it("fails fast when /me rejects the key", async () => {
    const error = Object.assign(new Error("Camber rejected the API key. Re-connect the account."), { status: 401 });
    fetchCamberMe.mockRejectedValue(error);
    const result = await makeExecutor().assertCredentialUsable({ apiKey: "bad" }, { log });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("degrades OPEN on a probe failure (a healthy account must not be refused)", async () => {
    fetchCamberMe.mockRejectedValue(new Error("network down"));
    const result = await makeExecutor().assertCredentialUsable({ apiKey: "k" }, { log });
    expect(result.ok).toBe(true);
    expect(result.me).toBeNull();
  });
});

describe("executor surface", () => {
  it("has no model endpoint to fetch and nothing to refresh", async () => {
    const executor = makeExecutor();
    expect(await executor.resolveModels()).toBeNull();
    expect(await executor.refreshCredentials()).toBeNull();
    expect(executor.needsRefresh()).toBe(false);
  });

  it("maps an upstream error onto a classified status", () => {
    const parsed = new CamberExecutor().parseError(
      new Response("", { status: 401 }),
      '{"code":2,"message":"unauthorized"}',
    );
    expect(parsed.status).toBe(401);
    expect(parsed.code).toBe("camber_bad_api_key");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

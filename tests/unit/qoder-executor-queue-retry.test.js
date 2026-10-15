/**
 * End-to-end tests for the Qoder executor's model-queue recovery.
 *
 * The upstream is mocked (proxyAwareFetch). A queued model answers the
 * inference POST with a code-10605 envelope; the executor must then ask the
 * model-queue status endpoint (the same GET qodercli polls) whether the model
 * is ready, wait out its retry hint, and replay the inference — never
 * surfacing a hard 403 for a state that clears itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.fetch,
}));

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  isQoderPat: () => false,
  resolveQoderCredentials: async (c) => c,
  getQoderModelConfig: async () => ({
    key: "auto",
    display_name: "Auto",
    is_reasoning: false,
    max_output_tokens: 8192,
    source: "system",
  }),
  resolveQoderModels: async () => ({ rawConfigs: new Map() }),
}));

const { QoderExecutor, __test__ } = await import("../../open-sse/executors/qoder.js");

const QUEUE_INNER = JSON.stringify({
  isQueued: true,
  modelKey: "auto",
  queueCount: 0,
  queueType: "p3",
  retryAfterSeconds: 0.001, // -> clamped to the 500ms floor
  serviceAvailable: false,
  waitTime: 0.001,
});
const QUEUE_ENVELOPE = `data: ${JSON.stringify({
  statusCodeValue: 403,
  body: JSON.stringify({ code: "403", message: QUEUE_INNER, subCode: "RESOURCE_LIMIT" }),
})}\n\n`;

const SUCCESS_INNER = JSON.stringify({ choices: [{ delta: { content: "pong" } }] });
const SUCCESS_ENVELOPE = `data: ${JSON.stringify({ statusCodeValue: 200, body: SUCCESS_INNER })}\n\ndata: [DONE]\n\n`;

const STATUS_QUEUED = JSON.stringify({
  subCode: "RESOURCE_LIMIT",
  isQueued: true,
  modelKey: "auto",
  queueType: "p3",
  queueCount: 0,
  waitTime: 0.001,
  retryAfterSeconds: 0.001,
  serviceAvailable: false,
});
const STATUS_READY = JSON.stringify({
  isQueued: false,
  modelKey: "auto",
  queueType: "p3",
  queueCount: 0,
  waitTime: 0,
  retryAfterSeconds: 0.001,
  serviceAvailable: true,
});

function sseResponse(lines) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function jsonResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

async function readAll(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf + decoder.decode();
}

const credentials = {
  accessToken: "dt-test-token",
  apiKey: "dt-test-token",
  providerSpecificData: { userId: "user-1", machineId: "machine-1" },
};

function runExecute() {
  const executor = new QoderExecutor("qoder");
  return executor.execute({
    model: "qoder/auto",
    body: { messages: [{ role: "user", content: "hi" }], max_tokens: 32 },
    stream: true,
    credentials,
    signal: new AbortController().signal,
    log: null,
    proxyOptions: null,
  });
}

/** Calls made to the queue-status endpoint. */
const statusCalls = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "GET");
/** Calls that were inference POSTs. */
const inferenceCalls = () => mocks.fetch.mock.calls.filter(([url]) => url.includes("agent_chat_generation"));

beforeEach(() => {
  mocks.fetch.mockReset();
  delete process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
});

describe("QoderExecutor model-queue recovery", () => {
  it("polls the status endpoint, then replays once it reports ready", async () => {
    let posts = 0;
    mocks.fetch.mockImplementation((url, init) => {
      if (init?.method === "GET") {
        expect(url).toContain("/algo/api/v2/service/ask/queue/status?");
        expect(url).toContain("requestSetId=");
        return Promise.resolve(jsonResponse(STATUS_READY));
      }
      posts++;
      return Promise.resolve(sseResponse([posts === 1 ? QUEUE_ENVELOPE : SUCCESS_ENVELOPE]));
    });

    const result = await runExecute();

    expect(statusCalls().length).toBe(1);
    expect(inferenceCalls().length).toBe(2);
    const text = await readAll(result.response);
    expect(text).toContain("pong");
    expect(text).toContain("data: [DONE]");
  });

  it("keeps polling while the status still reports queued", async () => {
    let polls = 0;
    let posts = 0;
    mocks.fetch.mockImplementation((url, init) => {
      if (init?.method === "GET") {
        polls++;
        return Promise.resolve(jsonResponse(polls === 1 ? STATUS_QUEUED : STATUS_READY));
      }
      posts++;
      return Promise.resolve(sseResponse([posts === 1 ? QUEUE_ENVELOPE : SUCCESS_ENVELOPE]));
    });

    const result = await runExecute();

    expect(polls).toBe(2);
    expect(inferenceCalls().length).toBe(2);
    expect(await readAll(result.response)).toContain("pong");
  });

  it("falls back to timed replays when the status endpoint is unavailable", async () => {
    let posts = 0;
    mocks.fetch.mockImplementation((url, init) => {
      if (init?.method === "GET") return Promise.resolve(jsonResponse("not found", 404));
      posts++;
      return Promise.resolve(sseResponse([posts === 1 ? QUEUE_ENVELOPE : SUCCESS_ENVELOPE]));
    });

    const result = await runExecute();

    expect(statusCalls().length).toBe(1); // one probe, then disabled
    expect(inferenceCalls().length).toBe(2);
    expect(await readAll(result.response)).toContain("pong");
  });

  it("does not retry a normal completion", async () => {
    mocks.fetch.mockResolvedValueOnce(sseResponse([SUCCESS_ENVELOPE]));

    const result = await runExecute();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
    expect(await readAll(result.response)).toContain("pong");
  });

  it("gives up with a retryable 503 once the queue wait budget is exhausted", async () => {
    process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS = "1";
    mocks.fetch.mockImplementation((url, init) => {
      if (init?.method === "GET") return Promise.resolve(jsonResponse(STATUS_QUEUED));
      return Promise.resolve(sseResponse([QUEUE_ENVELOPE]));
    });

    const result = await runExecute();

    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("retry-after")).toBeTruthy();
    const json = await result.response.json();
    expect(json.error.code).toBe("qoder_model_queue_timeout");
  });
});

describe("buildQoderRequestBody request id", () => {
  it("reuses an explicit request_id so queue replays look like one request", async () => {
    const { payload } = await __test__.buildQoderRequestBody({
      model: "auto",
      body: { messages: [{ role: "user", content: "hi" }], max_tokens: 32 },
      credentials,
      log: null,
      proxyOptions: null,
      signal: new AbortController().signal,
      region: "intl",
      requestId: "fixed-request-id",
    });
    expect(payload.request_id).toBe("fixed-request-id");
  });

  it("mints a fresh request_id when none is supplied", async () => {
    const { payload } = await __test__.buildQoderRequestBody({
      model: "auto",
      body: { messages: [{ role: "user", content: "hi" }], max_tokens: 32 },
      credentials,
      log: null,
      proxyOptions: null,
      signal: new AbortController().signal,
      region: "intl",
    });
    expect(payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

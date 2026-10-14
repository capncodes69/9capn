/**
 * End-to-end test for the Qoder executor's model-queue wait+retry.
 *
 * The upstream is mocked (proxyAwareFetch): the first inference call answers
 * with a code-10605 queue envelope, the second with a normal completion. The
 * executor must detect the queue signal, wait, replay the request, and return
 * the second (successful) response instead of surfacing a hard 403.
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

const { QoderExecutor } = await import("../../open-sse/executors/qoder.js");

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

beforeEach(() => {
  mocks.fetch.mockReset();
  delete process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
});

describe("QoderExecutor model-queue wait+retry", () => {
  it("waits out a queued first attempt and returns the retried success", async () => {
    mocks.fetch.mockResolvedValueOnce(sseResponse([QUEUE_ENVELOPE]));
    mocks.fetch.mockResolvedValueOnce(sseResponse([SUCCESS_ENVELOPE]));

    const result = await runExecute();

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
    const text = await readAll(result.response);
    expect(text).toContain("pong");
    expect(text).toContain("data: [DONE]");
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
    // Fresh Response per call: each attempt gets its own (unlocked) body.
    mocks.fetch.mockImplementation(() => sseResponse([QUEUE_ENVELOPE]));

    const result = await runExecute();

    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("retry-after")).toBeTruthy();
    expect(mocks.fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
    const json = await result.response.json();
    expect(json.error.code).toBe("qoder_model_queue_timeout");
  });
});

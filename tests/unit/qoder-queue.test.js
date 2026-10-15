/**
 * Unit tests for Qoder model-queue handling.
 *
 * Qoder answers a temporarily-unavailable model with a non-200 SSE envelope
 * whose body carries code 10605 / `isQueued:true` (often double-encoded inside
 * `message`). 9router must treat that as a transient, retryable condition —
 * waiting and replaying instead of locking the model with a quota-style 403.
 * Behavior modelled on qodercli's ModelQueue (shared/qoder/queue.js).
 */

import { describe, it, expect, afterEach } from "vitest";
import { __test__ as qoderExecutorInternals } from "../../open-sse/executors/qoder.js";
import {
  QODER_MODEL_QUEUE_MAX_WAIT_ENV,
  computeQoderQueueDelayMs,
  isQoderQueuedBody,
  parseQoderQueueInfo,
  parseQoderQueueStatus,
  qoderQueueMaxWaitMs,
  qoderQueueStatusUrl,
} from "../../open-sse/shared/qoder/queue.js";

// The exact nested shape observed from api3.qoder.sh (queueType p3, 30s wait).
const QUEUE_INNER =
  '{"isQueued":true,"modelKey":"auto","queueCount":0,"queueType":"p3","retryAfterSeconds":30,"serviceAvailable":false,"subCode":"RESOURCE_LIMIT","waitTime":30}';
const QUEUE_BODY_NESTED = `{"code":"403","message":${JSON.stringify(QUEUE_INNER)},"subCode":"RESOURCE_LIMIT"}`;
const QUEUE_BODY_DIRECT = '{"code":"10605","message":"Queue limit","retryAfterSeconds":30}';

function sse(...lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function makeResponse(lines, { status = 200 } = {}) {
  return new Response(sse(...lines), { status });
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

afterEach(() => {
  delete process.env[QODER_MODEL_QUEUE_MAX_WAIT_ENV];
});

describe("isQoderQueuedBody", () => {
  it("detects code 10605 at the top level", () => {
    expect(isQoderQueuedBody(QUEUE_BODY_DIRECT)).toBe(true);
  });

  it("detects isQueued:true nested inside a double-encoded message", () => {
    expect(isQoderQueuedBody(QUEUE_BODY_NESTED)).toBe(true);
  });

  it("detects isQueued:true from an object body", () => {
    expect(isQoderQueuedBody({ code: "403", message: QUEUE_INNER })).toBe(true);
  });

  it("returns false for billing/quota codes", () => {
    expect(isQoderQueuedBody('{"code":"112","message":"Quota exhausted"}')).toBe(false);
    expect(isQoderQueuedBody('{"code":"110","message":"Billing daily count exceeded"}')).toBe(false);
  });

  it("returns false for ordinary errors and non-JSON", () => {
    expect(isQoderQueuedBody('{"code":"500","message":"Internal error"}')).toBe(false);
    expect(isQoderQueuedBody("Internal server error")).toBe(false);
    expect(isQoderQueuedBody(null)).toBe(false);
  });
});

describe("parseQoderQueueInfo", () => {
  it("extracts the queue fields from the nested envelope", () => {
    expect(parseQoderQueueInfo(QUEUE_BODY_NESTED)).toEqual({
      isQueued: true,
      modelKey: "auto",
      queueCount: 0,
      queueType: "p3",
      serviceAvailable: false,
      retryAfterSeconds: 30,
      waitTime: 30,
    });
  });

  it("returns null when no queue fields are present", () => {
    expect(parseQoderQueueInfo('{"code":"500","message":"Internal error"}')).toBeNull();
    expect(parseQoderQueueInfo("not json")).toBeNull();
  });
});

describe("computeQoderQueueDelayMs", () => {
  it("uses retryAfterSeconds (clamped to [500ms, 30s])", () => {
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 30 })).toBe(30000);
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 1 })).toBe(1000);
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 600 })).toBe(30000);
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 0.1 })).toBe(500);
  });

  it("falls back to waitTime, then a 30s default", () => {
    expect(computeQoderQueueDelayMs({ waitTime: 12 })).toBe(12000);
    expect(computeQoderQueueDelayMs({})).toBe(30000);
    expect(computeQoderQueueDelayMs(null)).toBe(30000);
  });
});

describe("qoderQueueMaxWaitMs", () => {
  it("defaults to three minutes (not qodercli's one hour)", () => {
    expect(qoderQueueMaxWaitMs()).toBe(180_000);
  });

  it("honours the env override and ignores invalid values", () => {
    process.env[QODER_MODEL_QUEUE_MAX_WAIT_ENV] = "45000";
    expect(qoderQueueMaxWaitMs()).toBe(45000);
    process.env[QODER_MODEL_QUEUE_MAX_WAIT_ENV] = "nonsense";
    expect(qoderQueueMaxWaitMs()).toBe(180_000);
  });
});

describe("qoderQueueStatusUrl", () => {
  it("builds the live-endpoint path (under /algo) with the queue key", () => {
    const url = qoderQueueStatusUrl("https://api2.qoder.sh", {
      requestSetId: "rs-1",
      modelKey: "auto",
      queueType: "p3",
    });
    expect(url).toBe(
      "https://api2.qoder.sh/algo/api/v2/service/ask/queue/status?requestSetId=rs-1&modelKey=auto&queueType=p3",
    );
  });

  it("omits optional query parameters when absent", () => {
    expect(qoderQueueStatusUrl("https://api3.qoder.sh", { requestSetId: "rs-2" })).toBe(
      "https://api3.qoder.sh/algo/api/v2/service/ask/queue/status?requestSetId=rs-2",
    );
  });
});

describe("parseQoderQueueStatus", () => {
  it("reads the flat ready response the endpoint returns", () => {
    const info = parseQoderQueueStatus(
      '{"isQueued":false,"modelKey":"auto","queueType":"p3","queueCount":0,"waitTime":0,"retryAfterSeconds":2,"serviceAvailable":true}',
    );
    expect(info).toMatchObject({ isQueued: false, serviceAvailable: true, retryAfterSeconds: 2 });
  });

  it("reads a still-queued response", () => {
    const info = parseQoderQueueStatus(
      '{"subCode":"RESOURCE_LIMIT","isQueued":true,"modelKey":"auto","queueType":"p3","queueCount":0,"waitTime":30,"retryAfterSeconds":30,"serviceAvailable":false}',
    );
    expect(info).toMatchObject({ isQueued: true, serviceAvailable: false, waitTime: 30 });
  });

  it("returns null for a body without queue fields", () => {
    expect(parseQoderQueueStatus("<html>404</html>")).toBeNull();
    expect(parseQoderQueueStatus('{"ok":true}')).toBeNull();
  });
});

describe("detectQoderQueue", () => {
  const { detectQoderQueue } = qoderExecutorInternals;

  it("flags a queued first frame and reports the queue info", async () => {
    const envelope = JSON.stringify({ statusCodeValue: 403, body: QUEUE_BODY_NESTED });
    const result = await detectQoderQueue(makeResponse([`data: ${envelope}\n\n`]));
    expect(result.queued).toBe(true);
    expect(result.queueInfo.queueType).toBe("p3");
    expect(result.queueInfo.retryAfterSeconds).toBe(30);
  });

  it("passes a normal stream through intact (rebuilt, still streams)", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "hello" } }] });
    const envelope = JSON.stringify({ statusCodeValue: 200, body: inner });
    const result = await detectQoderQueue(makeResponse([`data: ${envelope}\n\n`]));
    expect(result.queued).toBe(false);

    const wrapped = await qoderExecutorInternals.wrapQoderSSE(result.response, "qoder/auto");
    expect(wrapped.status).toBe(200);
    const buf = await readAll(wrapped);
    expect(buf).toContain("hello");
    expect(buf).toContain("data: [DONE]");
  });

  it("returns the original response when there is no body to peek", async () => {
    const empty = new Response(null, { status: 200 });
    const result = await detectQoderQueue(empty);
    expect(result.queued).toBe(false);
    expect(result.response).toBe(empty);
  });
});

describe("wrapQoderSSE queue envelope", () => {
  const { wrapQoderSSE } = qoderExecutorInternals;

  it("returns a retryable 429 with retry-after for a queued first frame", async () => {
    const envelope = JSON.stringify({ statusCodeValue: 403, body: QUEUE_BODY_NESTED });
    const wrapped = await wrapQoderSSE(makeResponse([`data: ${envelope}\n\n`]), "qoder/auto");
    expect(wrapped.status).toBe(429);
    expect(wrapped.headers.get("retry-after")).toBe("30");
    const json = await wrapped.json();
    expect(json.error.code).toBe("qoder_model_queue");
  });
});

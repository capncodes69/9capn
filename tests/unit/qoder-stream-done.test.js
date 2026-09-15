/**
 * Regression tests for the passthrough SSE terminator.
 *
 * Bug: in PASSTHROUGH mode the transform() loop forwarded an upstream
 * `data: [DONE]` sentinel but never set `streamDoneSent`, so flush() appended a
 * second terminator. Providers whose executor already emits its own [DONE] on
 * the wire (Qoder does — see open-sse/executors/qoder.js wrapQoderSSE) therefore
 * shipped two `data: [DONE]` frames per stream.
 *
 * These tests pin "exactly one terminator" for every arrival shape.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");

const enc = new TextEncoder();
const dec = new TextDecoder();

const CONTENT = `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`;

/** Run `upstreamText` through the passthrough stream and return the output. */
async function runPassthrough(provider, upstreamText) {
  const transform = createPassthroughStreamWithLogger(provider, null, "sonus", "conn", null, null, null);
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(upstreamText));
      controller.close();
    },
  });
  const reader = source.pipeThrough(transform).getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

const countDone = (out) => (out.match(/data: \[DONE\]/g) || []).length;

describe("passthrough [DONE] terminator", () => {
  it("emits exactly one [DONE] when upstream already sends one (Qoder case)", async () => {
    const out = await runPassthrough("qoder", `${CONTENT}data: [DONE]\n\n`);
    expect(countDone(out)).toBe(1);
  });

  it("still emits exactly one [DONE] when upstream sends none (flush adds it)", async () => {
    const out = await runPassthrough("some-openai-provider", CONTENT);
    expect(countDone(out)).toBe(1);
  });

  it("collapses a duplicated upstream [DONE] to a single frame", async () => {
    const out = await runPassthrough("qoder", `${CONTENT}data: [DONE]\n\ndata: [DONE]\n\n`);
    expect(countDone(out)).toBe(1);
  });

  it("handles a trailing [DONE] with no blank line before flush", async () => {
    const out = await runPassthrough("qoder", `${CONTENT}data: [DONE]`);
    expect(countDone(out)).toBe(1);
  });

  it("normalizes the no-space sentinel form to data: [DONE]", async () => {
    const out = await runPassthrough("qoder", `${CONTENT}data:[DONE]\n\n`);
    expect(countDone(out)).toBe(1);
  });

  it("keeps the Gemini-family exemption (no [DONE] injected)", async () => {
    const out = await runPassthrough("gemini", CONTENT);
    expect(countDone(out)).toBe(0);
  });

  it("keeps clean framing: exactly one DONE frame terminated by one blank line", async () => {
    const out = await runPassthrough("qoder", `${CONTENT}data: [DONE]\n\n`);
    // The stream must end with `data: [DONE]\n\n` — no trailing extra blank line.
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(out.slice(0, -"data: [DONE]\n\n".length).endsWith("\n\n")).toBe(true);
  });
});

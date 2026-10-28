// Per-request headers the official client generates: the trace family, a request id that
// X-Conversation-Request-ID mirrors, a fresh message id, X-User-Id from the credential,
// and X-Model-ID. Shapes are taken from the client's own header builder.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "open-sse/executors/codebuddy-intl.js";

const URL_CB = "https://www.codebuddy.ai/v2/chat/completions";
const creds = (psd = {}) => ({ accessToken: "tok-1", providerSpecificData: psd });
const turn = () => ({ messages: [{ role: "user", content: "hi" }] });

const build = ({ psd, body = turn(), model = "glm-5.2", url = URL_CB } = {}) =>
  new CodeBuddyIntlExecutor().buildHeaders(creds(psd), true, url, model, body);

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("per-request identity", () => {
  it("sends the full W3C/B3 trace family", () => {
    const h = build();
    expect(h["X-Trace-ID"]).toMatch(HEX32);
    expect(h["X-B3-TraceId"]).toBe(h["X-Trace-ID"]);
    expect(h["X-B3-SpanId"]).toMatch(/^[0-9a-f]{16}$/);
    expect(h["X-B3-Sampled"]).toBe("1");
    expect(h.b3).toBe(`${h["X-Trace-ID"]}-${h["X-B3-SpanId"]}-1-${h["X-B3-ParentSpanId"]}`);
    expect(h["X-B3-ParentSpanId"]).toMatch(HEX32);
  });

  it("X-Conversation-Request-ID mirrors X-Request-ID, as the client does", () => {
    // The client assigns the same ir.requestId to both headers.
    const h = build();
    expect(h["X-Conversation-Request-ID"]).toBe(h["X-Request-ID"]);
  });

  it("X-Conversation-Message-ID is a dashed UUID, fresh per request", () => {
    const a = build();
    const b = build();
    expect(a["X-Conversation-Message-ID"]).toMatch(UUID);
    expect(a["X-Conversation-Message-ID"]).not.toBe(b["X-Conversation-Message-ID"]);
  });

  it("keeps the conversation id stable across turns of one conversation", () => {
    const a = build({ body: { session_id: "sess-1", messages: [] } });
    const b = build({ body: { session_id: "sess-1", messages: [] } });
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
  });

  it("sends X-User-Id from the credential when known", () => {
    const h = build({ psd: { userId: "24eae021-0b18-4b92-9757-e9fd1fde701f" } });
    expect(h["X-User-Id"]).toBe("24eae021-0b18-4b92-9757-e9fd1fde701f");
  });

  it("omits X-User-Id rather than sending an empty one", () => {
    const h = build({ psd: {} });
    expect(h["X-User-Id"]).toBeUndefined();
  });

  it("sends X-Model-ID from the model argument", () => {
    expect(build({ model: "glm-5.2" })["X-Model-ID"]).toBe("glm-5.2");
    expect(build({ model: "deepseek-v4.1-flash" })["X-Model-ID"]).toBe("deepseek-v4.1-flash");
  });

  it("generates fresh trace ids per request", () => {
    const a = build();
    const b = build();
    expect(a["X-Trace-ID"]).not.toBe(b["X-Trace-ID"]);
  });
});

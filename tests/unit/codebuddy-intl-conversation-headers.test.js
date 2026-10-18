// CodeBuddy intl: the X-Conversation-* family the gateway's channel verification
// demands, and the identity handling that stops a re-import from duplicating a row.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { withConversationHeaders, CodeBuddyIntlExecutor } from "open-sse/executors/codebuddy-intl.js";

const CONV_ID = "X-Conversation-ID";
const CONV_REQ = "X-Conversation-Request-ID";
const CONV_MSG = "X-Conversation-Message-ID";
const REQ_ID = "X-Request-ID";

const lower = (headers) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

describe("withConversationHeaders", () => {
  it("attaches the full family when the caller sent none", () => {
    const out = withConversationHeaders({}, "https://www.codebuddy.ai/v2/chat/completions", {
      messages: [{ role: "user", content: "hello" }],
    });
    for (const name of [CONV_ID, CONV_REQ, CONV_MSG, REQ_ID]) {
      expect(out[name], `${name} missing`).toBeTruthy();
    }
    // The request id mirrors the message id, as the official client sends it.
    expect(out[REQ_ID]).toBe(out[CONV_MSG]);
  });

  it("keeps a conversation id stable across turns of one conversation", () => {
    const url = "https://www.codebuddy.ai/v2/chat/completions";
    const first = withConversationHeaders({}, url, {
      messages: [{ role: "user", content: "turn one" }],
    });
    const second = withConversationHeaders({}, url, {
      messages: [{ role: "user", content: "turn one" }],
    });
    expect(second[CONV_ID]).toBe(first[CONV_ID]);
    // …while the per-call ids are fresh every request.
    expect(second[CONV_REQ]).not.toBe(first[CONV_REQ]);
    expect(second[CONV_MSG]).not.toBe(first[CONV_MSG]);
  });

  it("derives the conversation id from an explicit session key when present", () => {
    const url = "https://www.codebuddy.ai/v2/chat/completions";
    const a = withConversationHeaders({}, url, { session_id: "sess-1", messages: [] });
    const b = withConversationHeaders({}, url, { session_id: "sess-1", messages: [] });
    const c = withConversationHeaders({}, url, { session_id: "sess-2", messages: [] });
    expect(b[CONV_ID]).toBe(a[CONV_ID]);
    expect(c[CONV_ID]).not.toBe(a[CONV_ID]);
  });

  it("preserves caller-supplied values instead of overwriting them", () => {
    const out = withConversationHeaders(
      { "X-Conversation-ID": "mine", "X-Conversation-Request-ID": "req-mine", "X-Request-ID": "rid-mine" },
      "https://www.codebuddy.ai/v2/chat/completions",
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(out[CONV_ID]).toBe("mine");
    expect(out[CONV_REQ]).toBe("req-mine");
    // The message id was absent, so it is generated; the request id keeps the
    // caller's value rather than being re-mirrored over it.
    expect(out[REQ_ID]).toBe("rid-mine");
    expect(out[CONV_MSG]).toBeTruthy();
  });

  it("finds a caller's header written in a different case, without duplicating it", () => {
    // A duplicate key would make undici join both values into "mine, ours" and
    // corrupt the id we are supposed to preserve.
    const out = withConversationHeaders(
      { "x-conversation-id": "lowercase-mine" },
      "https://www.codebuddy.ai/v2/chat/completions",
      { messages: [{ role: "user", content: "hi" }] },
    );
    const keys = Object.keys(out).map((k) => k.toLowerCase()).filter((k) => k === "x-conversation-id");
    expect(keys).toHaveLength(1);
    expect(out["x-conversation-id"]).toBe("lowercase-mine");
  });

  it("treats a blank caller value as absent", () => {
    const out = withConversationHeaders(
      { [CONV_ID]: "   " },
      "https://www.codebuddy.ai/v2/chat/completions",
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(out[CONV_ID].trim()).not.toBe("");
  });

  it("uses hyphen-less v7 ids on the workbuddy brand host", () => {
    const out = withConversationHeaders({}, "https://www.workbuddy.ai/v2/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out[CONV_REQ]).not.toContain("-");
    expect(out[CONV_MSG]).not.toContain("-");
  });

  it("works on a fetch Headers instance", () => {
    const headers = new Headers();
    withConversationHeaders(headers, "https://www.codebuddy.ai/v2/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(headers.get(CONV_ID)).toBeTruthy();
    expect(headers.get(CONV_REQ)).toBeTruthy();
    expect(headers.get(CONV_MSG)).toBeTruthy();
  });

  it("survives a body that is not an object", () => {
    expect(() => withConversationHeaders({}, "https://www.codebuddy.ai/x", null)).not.toThrow();
    expect(() => withConversationHeaders({}, "not-a-url", undefined)).not.toThrow();
  });
});

describe("CodeBuddyIntlExecutor.buildHeaders", () => {
  const creds = { accessToken: "tok-1" };

  it("adds the family on top of the registry headers", () => {
    const executor = new CodeBuddyIntlExecutor();
    const headers = executor.buildHeaders(
      creds, true, "https://www.codebuddy.ai/v2/chat/completions", "glm-5.2",
      { messages: [{ role: "user", content: "hi" }] },
    );
    const flat = lower(headers);
    expect(flat.authorization).toBe("Bearer tok-1");
    expect(flat["x-conversation-id"]).toBeTruthy();
    expect(flat["x-conversation-request-id"]).toBeTruthy();
    expect(flat["x-conversation-message-id"]).toBeTruthy();
  });

  it("fails closed with a message naming the gate", () => {
    const executor = new CodeBuddyIntlExecutor();
    // A getter that throws is the one input that can break the derivation; the
    // executor must surface it rather than send a request the gateway refuses.
    const body = {
      messages: [{ role: "user", content: "hi" }],
      get session_id() { throw new Error("boom"); },
    };
    expect(() =>
      executor.buildHeaders(creds, true, "https://www.codebuddy.ai/v2/chat/completions", "glm-5.2", body),
    ).toThrow(/channel verification/i);
  });
});

describe("parseError surfaces the gate", () => {
  const executor = new CodeBuddyIntlExecutor();

  it("names channel verification for the conversation-id variant of 11128", () => {
    const parsed = executor.parseError(
      { status: 400 },
      JSON.stringify({ code: 11128, msg: "conversation id missing" }),
    );
    expect(parsed.status).toBe(400);
    expect(parsed.message).toMatch(/channel verification/i);
  });

  it("does not claim channel verification for the other 11128 variant", () => {
    // Same code, different cause (body shape). Branching on the code alone used
    // to mislabel this one.
    const parsed = executor.parseError(
      { status: 400 },
      JSON.stringify({ code: 11128, msg: "first message is not system prompt" }),
    );
    expect(parsed.message).not.toMatch(/channel verification/i);
  });
});

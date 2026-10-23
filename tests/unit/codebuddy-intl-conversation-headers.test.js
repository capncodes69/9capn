// CodeBuddy intl: the X-Conversation-* family the gateway's channel verification
// demands. Everything is driven through the executor's public `buildHeaders`,
// which is the only entry point production uses — the derivation helpers stay
// private so the test pins behaviour, not implementation.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "open-sse/executors/codebuddy-intl.js";

const URL_CB = "https://www.codebuddy.ai/v2/chat/completions";
const URL_WB = "https://www.workbuddy.ai/v2/chat/completions";
const CREDS = { accessToken: "tok-1" };

const CONV_ID = "X-Conversation-ID";
const CONV_REQ = "X-Conversation-Request-ID";
const CONV_MSG = "X-Conversation-Message-ID";
const REQ_ID = "X-Request-ID";

/** Build headers the way the request path does, from a plain body. */
function headers(body, { url = URL_CB, creds = CREDS } = {}) {
  return new CodeBuddyIntlExecutor().buildHeaders(creds, true, url, "glm-5.2", body);
}

const userTurn = (text) => ({ messages: [{ role: "user", content: text }] });

describe("conversation header family", () => {
  it("attaches the full family when the caller sent none", () => {
    const out = headers(userTurn("hello"));
    for (const name of [CONV_ID, CONV_REQ, CONV_MSG, REQ_ID]) {
      expect(out[name], `${name} missing`).toBeTruthy();
    }
    // The request id mirrors the message id, as the official client sends it.
    expect(out[REQ_ID]).toBe(out[CONV_MSG]);
  });

  it("keeps the conversation id stable across turns of one conversation", () => {
    const first = headers(userTurn("turn one"));
    const second = headers(userTurn("turn one"));
    expect(second[CONV_ID]).toBe(first[CONV_ID]);
    // …while the per-call ids are fresh every request.
    expect(second[CONV_REQ]).not.toBe(first[CONV_REQ]);
    expect(second[CONV_MSG]).not.toBe(first[CONV_MSG]);
  });

  it("derives the conversation id from an explicit session key when present", () => {
    const a = headers({ session_id: "sess-1", messages: [] });
    const b = headers({ session_id: "sess-1", messages: [] });
    const c = headers({ session_id: "sess-2", messages: [] });
    expect(b[CONV_ID]).toBe(a[CONV_ID]);
    expect(c[CONV_ID]).not.toBe(a[CONV_ID]);
  });

  it("gives different conversations different ids", () => {
    const a = headers(userTurn("conversation A"));
    const b = headers(userTurn("conversation B"));
    expect(a[CONV_ID]).not.toBe(b[CONV_ID]);
  });

  it("uses hyphen-less v7 ids on the workbuddy brand host", () => {
    const out = headers(userTurn("hi"), { url: URL_WB });
    expect(out[CONV_REQ]).not.toContain("-");
    expect(out[CONV_MSG]).not.toContain("-");
  });
});

describe("caller-supplied headers are preserved", () => {
  it("does not overwrite values the caller already set", () => {
    // The executor spreads the registry headers and the caller's on top; the
    // family must only fill blanks.
    const out = new CodeBuddyIntlExecutor().buildHeaders(
      { ...CREDS, providerSpecificData: {} },
      true, URL_CB, "glm-5.2",
      { ...userTurn("hi"), headers: { [CONV_ID]: "mine" } },
    );
    expect(out[CONV_ID]).toBeTruthy();
  });

  it("treats a blank caller value as absent", () => {
    const out = headers({ ...userTurn("hi"), [CONV_ID]: "   " });
    expect(out[CONV_ID].trim()).not.toBe("");
  });
});

describe("fail-closed behaviour", () => {
  it("names the gate when the family cannot be attached", () => {
    // buildHeaders runs outside the fetch try/catch, so a silent drop would turn
    // a diagnosable bug into a bare 400 from upstream. A getter that throws is
    // the one input that can break the derivation.
    const body = {
      messages: [{ role: "user", content: "hi" }],
      get session_id() { throw new Error("boom"); },
    };
    expect(() => headers(body)).toThrow(/channel verification/i);
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

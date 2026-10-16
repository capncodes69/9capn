// The intl gateway's channel verification rejects requests without the
// X-Conversation-* header family with HTTP 400 code 11128 "conversation id
// missing". The official IDE sends a conversation id derived stably from the
// session key plus fresh per-request/per-message ids, and mirrors the message
// id on X-Request-ID.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor, withConversationHeaders } from "../../open-sse/executors/codebuddy-intl.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HYPHENLESS_RE = /^[0-9a-f]{32}$/;

describe("CodeBuddyIntlExecutor sends the X-Conversation-* family", () => {
  const exec = new CodeBuddyIntlExecutor();
  const creds = { accessToken: "***" };

  it("always sets the three headers", () => {
    const h = exec.buildHeaders(creds, true, "https://www.codebuddy.ai/v2/chat/completions", "deepseek-v4.1-flash", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(h["X-Conversation-ID"]).toMatch(UUID_RE);
    expect(h["X-Conversation-Request-ID"]).toMatch(UUID_RE);
    expect(h["X-Conversation-Message-ID"]).toMatch(UUID_RE);
  });

  it("keeps the conversation id stable across retries of the same turn", () => {
    const body = { messages: [{ role: "user", content: "same opening message" }] };
    const a = exec.buildHeaders(creds, true, "u", "m", body);
    const b = exec.buildHeaders(creds, true, "u", "m", body);
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
    // per-request ids must stay fresh
    expect(a["X-Conversation-Request-ID"]).not.toBe(b["X-Conversation-Request-ID"]);
    expect(a["X-Conversation-Message-ID"]).not.toBe(b["X-Conversation-Message-ID"]);
  });

  it("prefers an explicit session id over message-derived key", () => {
    const body = {
      session_id: "sess-123",
      messages: [{ role: "user", content: "hi" }],
    };
    const a = exec.buildHeaders(creds, true, "u", "m", body);
    const b = exec.buildHeaders(creds, true, "u", "m", body);
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
    const c = exec.buildHeaders(creds, true, "u", "m", {
      session_id: "sess-456",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(c["X-Conversation-ID"]).not.toBe(a["X-Conversation-ID"]);
  });

  it("supports typed-block user content for the derived key", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "typed block" }] }],
    };
    const h = exec.buildHeaders(creds, true, "u", "m", body);
    expect(h["X-Conversation-ID"]).toMatch(UUID_RE);
  });

  it("falls back to a random uuid when there is nothing to derive from", () => {
    const h = exec.buildHeaders(creds, true, "u", "m", { messages: [] });
    expect(h["X-Conversation-ID"]).toMatch(UUID_RE);
  });
});

describe("X-Request-ID mirrors the message id", () => {
  const exec = new CodeBuddyIntlExecutor();
  const creds = { accessToken: "***" };
  const body = { session_id: "sess-1", messages: [{ role: "user", content: "hi" }] };

  it("on the default codebuddy.ai host with dashed ids", () => {
    const h = exec.buildHeaders(creds, true, "https://www.codebuddy.ai/v2/chat/completions", "m", body);
    expect(h["X-Request-ID"]).toBe(h["X-Conversation-Message-ID"]);
    expect(h["X-Request-ID"]).toMatch(UUID_RE);
    expect(h["X-Conversation-Request-ID"]).not.toBe(h["X-Request-ID"]);
  });

  it("on the workbuddy.ai brand host with hyphen-less per-call v7 ids", () => {
    const url = "https://www.workbuddy.ai/v2/chat/completions";
    const h = exec.buildHeaders(creds, true, url, "m", body);
    expect(h["X-Conversation-ID"]).toMatch(UUID_RE);
    expect(h["X-Conversation-Request-ID"]).toMatch(HYPHENLESS_RE);
    expect(h["X-Conversation-Message-ID"]).toMatch(HYPHENLESS_RE);
    expect(h["X-Request-ID"]).toBe(h["X-Conversation-Message-ID"]);

    // the conversation id survives turns of the same session; per-call ids don't
    const again = exec.buildHeaders(creds, true, url, "m", body);
    expect(again["X-Conversation-ID"]).toBe(h["X-Conversation-ID"]);
    expect(again["X-Conversation-Request-ID"]).not.toBe(h["X-Conversation-Request-ID"]);
    expect(again["X-Conversation-Message-ID"]).not.toBe(h["X-Conversation-Message-ID"]);
  });
});

describe("caller-supplied ids are preserved", () => {
  const url = "https://www.codebuddy.ai/v2/chat/completions";
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("keeps non-empty values and only fills the gaps", () => {
    const out = withConversationHeaders(
      {
        "X-Conversation-ID": "11111111-1111-1111-1111-111111111111",
        "X-Conversation-Message-ID": "fixed-message-id",
      },
      url,
      body,
    );
    expect(out["X-Conversation-ID"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(out["X-Conversation-Message-ID"]).toBe("fixed-message-id");
    expect(out["X-Request-ID"]).toBe("fixed-message-id");
    expect(out["X-Conversation-Request-ID"]).toMatch(UUID_RE);
  });

  it("treats blank values as absent", () => {
    const out = withConversationHeaders({ "X-Conversation-ID": "   " }, url, body);
    expect(out["X-Conversation-ID"]).toMatch(UUID_RE);
  });
});

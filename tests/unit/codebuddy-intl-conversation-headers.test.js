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

// HTTP header names are case-insensitive. A caller that already sent a
// lowercase key must be recognised, or a second key is added and undici joins
// both into one comma-separated value — corrupting the id the caller supplied.
describe("header lookup is case-insensitive", () => {
  const url = "https://www.codebuddy.ai/v2/chat/completions";
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("does not duplicate a caller's lowercase conversation id", () => {
    const out = withConversationHeaders({ "x-conversation-id": "caller-lower" }, url, body);
    const idKeys = Object.keys(out).filter((k) => k.toLowerCase() === "x-conversation-id");
    expect(idKeys).toHaveLength(1);
    expect(out["x-conversation-id"]).toBe("caller-lower");
  });

  it("does not duplicate a caller's mixed-case message id", () => {
    const out = withConversationHeaders({ "X-Conversation-Message-Id": "caller-mixed" }, url, body);
    const msgKeys = Object.keys(out).filter((k) => k.toLowerCase() === "x-conversation-message-id");
    expect(msgKeys).toHaveLength(1);
    // X-Request-ID mirrors the caller's message id, not a fresh one
    expect(out["X-Request-ID"]).toBe("caller-mixed");
  });

  it("recognises a lowercase X-Request-ID when mirroring", () => {
    const out = withConversationHeaders({ "x-request-id": "caller-trace" }, url, body);
    expect(out["x-request-id"]).toBe("caller-trace");
    expect(out["X-Conversation-Message-ID"]).toBe("caller-trace");
  });

  it("never produces two keys for one header name", () => {
    const out = withConversationHeaders(
      {
        "x-conversation-id": "a",
        "X-CONVERSATION-REQUEST-ID": "b",
        "X-Conversation-Message-Id": "c",
      },
      url,
      body,
    );
    for (const name of [
      "x-conversation-id",
      "x-conversation-request-id",
      "x-conversation-message-id",
      "x-request-id",
    ]) {
      const matching = Object.keys(out).filter((k) => k.toLowerCase() === name);
      expect(matching.length, `${name} appears ${matching.length}x`).toBeLessThanOrEqual(1);
    }
  });
});

// The three-header family is the measured minimum: any two of them are still
// answered 11128 by the live gateway. This test fails if someone trims the
// family down to a pair.
describe("the full three-header family is always sent", () => {
  const exec = new CodeBuddyIntlExecutor();
  const creds = { accessToken: "***" };
  const urls = [
    "https://www.codebuddy.ai/v2/chat/completions",
    "https://www.workbuddy.ai/v2/chat/completions",
  ];

  for (const url of urls) {
    it(`sets all three on ${new URL(url).hostname}, even with an empty body`, () => {
      const h = exec.buildHeaders(creds, true, url, "m", undefined);
      expect(h["X-Conversation-ID"]).toBeTruthy();
      expect(h["X-Conversation-Request-ID"]).toBeTruthy();
      expect(h["X-Conversation-Message-ID"]).toBeTruthy();
    });
  }

  it("still sends all three when the caller supplied only one", () => {
    const h = exec.buildHeaders(creds, true, urls[0], "m", {
      messages: [{ role: "user", content: "hi" }],
    });
    h["X-Conversation-ID"] = "caller-id";
    const again = withConversationHeaders(
      { ...h },
      urls[0],
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(again["X-Conversation-ID"]).toBe("caller-id");
    expect(again["X-Conversation-Request-ID"]).toBeTruthy();
    expect(again["X-Conversation-Message-ID"]).toBeTruthy();
  });

  it("tolerates a null body without throwing", () => {
    const h = exec.buildHeaders(creds, true, urls[0], "m", null);
    expect(h["X-Conversation-ID"]).toMatch(UUID_RE);
  });

  it("does not throw on a missing or null header bag", () => {
    for (const bag of [undefined, null]) {
      expect(() => withConversationHeaders(bag, urls[0], null)).not.toThrow();
    }
  });

  it("fills a fetch Headers instance instead of adding plain properties", () => {
    const h = new Headers({ "x-conversation-id": "caller-lower" });
    const out = withConversationHeaders(h, urls[0], { messages: [{ role: "user", content: "hi" }] });
    // get() is case-insensitive on a Headers instance, so the caller's value wins
    expect(out.get("X-Conversation-ID")).toBe("caller-lower");
    expect(out.get("X-Conversation-Request-ID")).toBeTruthy();
    expect(out.get("X-Conversation-Message-ID")).toBeTruthy();
    // and no stray plain property was attached
    expect(out["X-Conversation-ID"]).toBeUndefined();
  });
});

// An operator header override is merged over the executor's headers AFTER
// buildHeaders (base.js, Object.assign). That merge is key-exact, so an
// override whose casing differs from the canonical name adds a SECOND key, and
// undici then joins the two into one comma-separated value. This is a real
// hazard of the merge site, not of withConversationHeaders — pinned here so the
// behaviour is documented rather than discovered in production.
describe("case-insensitive reads survive a key-exact override merge", () => {
  const url = "https://www.codebuddy.ai/v2/chat/completions";
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("still reads the canonical id when an override adds a lowercase twin", () => {
    const merged = withConversationHeaders({}, url, body);
    const canonical = merged["X-Conversation-ID"];
    // simulate base.js: Object.assign(headers, providerOverrides.headers)
    Object.assign(merged, { "x-conversation-id": "operator-value" });

    // The executor's own reads are case-insensitive, so a later pass still sees
    // a value (the first match wins) instead of concluding the header is absent.
    const idKeys = Object.keys(merged).filter((k) => k.toLowerCase() === "x-conversation-id");
    expect(idKeys.length).toBe(2); // documents the merge-site hazard
    expect(merged["X-Conversation-ID"]).toBe(canonical);

    // Re-running the family over the merged headers must not throw and must not
    // add a third key.
    const again = withConversationHeaders(merged, url, body);
    const idKeysAgain = Object.keys(again).filter((k) => k.toLowerCase() === "x-conversation-id");
    expect(idKeysAgain.length).toBe(2);
  });
});

describe("parseError classifies the 11128 variants", () => {
  const exec = new CodeBuddyIntlExecutor();
  const res = (status = 400) => ({ status });

  it("names channel verification for the conversation-id variant", () => {
    const body = JSON.stringify({
      code: 11128,
      msg: "conversation id missing",
      displayTips: { en: "This call failed channel verification" },
    });
    const out = exec.parseError(res(), body);
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/channel verification/i);
    expect(out.message).toMatch(/X-Conversation/);
  });

  it("does NOT claim channel verification for the system-prompt variant", () => {
    const body = JSON.stringify({ code: 11128, msg: "first message is not system prompt" });
    const out = exec.parseError(res(), body);
    expect(out.message).not.toMatch(/channel verification/i);
  });

  it("still maps the frequency-limit code to 429", () => {
    const body = JSON.stringify({ code: 6004, msg: "超出频率限制 2026-10-16 10:00:00 UTC+8" });
    const out = exec.parseError(res(429), body);
    expect(out.status).toBe(429);
    expect(out.resetsAtMs).toBeGreaterThan(0);
  });
});

// buildHeaders fails CLOSED. A request without the family is refused by the
// gateway every time, so a silent fall-through would turn a bug into a
// 100%-failure with no cause; the throw must name the gate instead.
describe("buildHeaders fails closed when the family cannot be attached", () => {
  const exec = new CodeBuddyIntlExecutor();
  const url = "https://www.codebuddy.ai/v2/chat/completions";

  it("throws a message that names the gate, not a bare TypeError", () => {
    const realKeys = Object.keys;
    try {
      // Simulate any unexpected failure inside withConversationHeaders.
      Object.keys = () => { throw new Error("simulated hostile headers"); };
      let caught = null;
      try {
        exec.buildHeaders({ accessToken: "x" }, true, url, "m", { messages: [] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/channel verification/i);
      expect(caught.message).toMatch(/X-Conversation/);
      expect(caught.message).toMatch(/11128/);
    } finally {
      Object.keys = realKeys;
    }
  });

  it("returns the family normally when nothing goes wrong", () => {
    const h = exec.buildHeaders({ accessToken: "x" }, true, url, "m", { messages: [] });
    expect(h["X-Conversation-ID"]).toBeTruthy();
  });
});

// The per-request ids are fresh per *call*, and a re-run over an already-built
// bag must NOT rotate them: base.js builds headers once per attempt and retries
// the same attempt on 429/network, where a stable pair is what the gateway
// expects. Pinned so this deliberate choice cannot change unnoticed.
describe("idempotency of a second pass over the same header bag", () => {
  const url = "https://www.codebuddy.ai/v2/chat/completions";
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("keeps the conversation and per-call ids when re-run on the same bag", () => {
    const first = withConversationHeaders({}, url, body);
    const second = withConversationHeaders({ ...first }, url, body);
    expect(second["X-Conversation-ID"]).toBe(first["X-Conversation-ID"]);
    expect(second["X-Conversation-Request-ID"]).toBe(first["X-Conversation-Request-ID"]);
    expect(second["X-Conversation-Message-ID"]).toBe(first["X-Conversation-Message-ID"]);
    expect(second["X-Request-ID"]).toBe(first["X-Request-ID"]);
  });

  it("rotates the per-call ids between separate builds", () => {
    const a = withConversationHeaders({}, url, body);
    const b = withConversationHeaders({}, url, body);
    // same conversation (same opening message), different call ids
    expect(b["X-Conversation-ID"]).toBe(a["X-Conversation-ID"]);
    expect(b["X-Conversation-Request-ID"]).not.toBe(a["X-Conversation-Request-ID"]);
    expect(b["X-Conversation-Message-ID"]).not.toBe(a["X-Conversation-Message-ID"]);
  });
});

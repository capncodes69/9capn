// codebuddy-intl refuses a call for two different reasons, and both arrive as
// HTTP 400 with code 11128:
//
//   "request illegal"          the gateway's WAF refusing the call outright
//   "conversation id missing"  the channel-verification gate
//
// Neither text matched any ERROR_RULES entry, so both fell through to the
// request-scoped catch-all in accountFallback.js and got cooldownMs: 0 — no
// cooldown, no backoff, no account lock. The router then re-fired into the
// refusal on every request, so it never got the idle time it needed to expire.
// Reported in decolua/9router#5024: still blocked after 4+ minutes with requests
// spaced 60-120s apart.
//
// The catch-all is correct for a genuine per-request 400. These two are not
// per-request: the identical payload succeeds again minutes later, and every
// session stays refused for the duration. So the fix is a provider-scoped rule,
// not a change to the catch-all.
import { describe, it, expect } from "vitest";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import { parseUpstreamError } from "open-sse/utils/error.js";
import { CodeBuddyIntlExecutor } from "open-sse/executors/codebuddy-intl.js";

/** The exact message the fallback classifier sees for a given upstream body. */
async function classify(bodyText, { status = 400, provider = "codebuddy-intl" } = {}) {
  const executor = new CodeBuddyIntlExecutor();
  const response = new Response(bodyText, { status });
  const parsed = await parseUpstreamError(response, executor);
  const result = checkFallbackError(parsed.statusCode, parsed.message, 0, provider);
  return { ...parsed, ...result };
}

describe("codebuddy-intl WAF block gets a cooldown", () => {
  it("cools down on 400 code 11128 \"request illegal\"", async () => {
    const r = await classify(JSON.stringify({ code: 11128, msg: "11128:request illegal" }));
    // Before the rule: shouldFallback=false, cooldownMs=0 — the block never expired.
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
  });

  it("cools down on the channel-verification gate", async () => {
    const r = await classify(JSON.stringify({
      code: 11128,
      msg: "11128:conversation id missing",
      displayTips: { en: "This call failed channel verification" },
    }));
    // The executor rewrites this one into a long diagnostic message; the rule
    // matches on the substring, not the exact wording.
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
  });

  it("escalates across consecutive failures", async () => {
    const body = JSON.stringify({ code: 11128, msg: "11128:request illegal" });
    const executor = new CodeBuddyIntlExecutor();
    const parsed = await parseUpstreamError(new Response(body, { status: 400 }), executor);

    let level = 0;
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const r = checkFallbackError(parsed.statusCode, parsed.message, level, "codebuddy-intl");
      seen.push(r.cooldownMs);
      level = r.newBackoffLevel ?? level;
    }
    // Each retry waits longer than the last, so a sustained block eventually
    // leaves the upstream alone long enough to expire.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `attempt ${i + 1} vs ${i}`).toBeGreaterThan(seen[i - 1]);
    }
  });
});

describe("the rule stays scoped", () => {
  it("leaves the request-scoped 11128 variant at zero cooldown", async () => {
    // Same code, different cause: a body-shape bug fixed in transformRequest.
    // Cooling the account for it would remove a healthy connection from rotation.
    const r = await classify(JSON.stringify({
      code: 11128,
      msg: "11128:first message is not system prompt",
    }));
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("leaves a generic 400 at zero cooldown", async () => {
    const r = await classify("some malformed body");
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("does not apply to another provider carrying the same text", async () => {
    const r = await classify(
      JSON.stringify({ code: 11128, msg: "11128:request illegal" }),
      { provider: "glm" },
    );
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("does not apply when no provider is supplied", async () => {
    // checkFallbackError's provider argument defaults to null; a scoped rule must
    // not match then, or it would leak to every caller that omits it.
    const body = JSON.stringify({ code: 11128, msg: "11128:request illegal" });
    const parsed = await parseUpstreamError(new Response(body, { status: 400 }), new CodeBuddyIntlExecutor());
    const r = checkFallbackError(parsed.statusCode, parsed.message);
    expect(r.shouldFallback).toBe(false);
  });
});

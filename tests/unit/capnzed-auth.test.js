import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  CAPNZED_LOCK_CODES,
  CAPNZED_MAX_LOCK_MS,
  CAPNZED_TRIAL_DAYS,
  buildCapnZedAccountAuthHeader,
  capnZedLockUntilMs,
  classifyCapnZedUser,
  createCapnZedNativeAuthData,
  decodeCapnZedPrivateKeyVerifier,
  decryptCapnZedAccessToken,
  isCapnZedAccountExhausted,
  isCapnZedInStreamAccountFailure,
  parseCapnZedCallbackPayload,
  parseCapnZedPlanInfo,
  parseCapnZedTimestamp,
  resolveCapnZedOrganizationId,
} from "../../open-sse/shared/capnzedAuth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-15T00:00:00.000Z");

/** Shape of GET /client/users/me, trimmed to the fields we reason about. */
function planResponse(plan = {}, overrides = {}) {
  return {
    user: { id: 42 },
    organizations: [{ id: "org-personal", is_personal: true }],
    default_organization_id: "org-personal",
    plan: { plan_v3: "zed_pro_trial", ...plan },
    ...overrides,
  };
}

describe("parseCapnZedTimestamp", () => {
  it("parses Zed's RFC3339 timestamp format (what Timestamp serializes to)", () => {
    expect(parseCapnZedTimestamp("2023-12-25T14:30:45.123Z")).toBe(
      Date.parse("2023-12-25T14:30:45.123Z"),
    );
  });

  it("accepts a plain epoch number and rejects junk", () => {
    expect(parseCapnZedTimestamp(1700000000000)).toBe(1700000000000);
    expect(parseCapnZedTimestamp("not-a-date")).toBeNull();
    expect(parseCapnZedTimestamp(null)).toBeNull();
  });
});

describe("parseCapnZedPlanInfo", () => {
  it("maps snake_case plan_v3 + trial window", () => {
    const info = parseCapnZedPlanInfo(
      planResponse({
        trial_started_at: "2026-09-01T00:00:00.000Z",
        subscription_period: {
          started_at: "2026-09-01T00:00:00.000Z",
          ended_at: "2026-09-15T00:00:00.000Z",
        },
      }),
    );

    expect(info.planId).toBe("zed_pro_trial");
    expect(info.planLabel).toBe("Zed Pro Trial");
    expect(info.trialStartedAtMs).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
    expect(info.periodEndedAtMs).toBe(Date.parse("2026-09-15T00:00:00.000Z"));
    expect(info.accountTooYoung).toBe(false);
    expect(info.hasOverdueInvoices).toBe(false);
  });

  it("also accepts camelCase (defensive)", () => {
    const info = parseCapnZedPlanInfo({
      plan: { planV3: "zed_pro", trialStartedAt: "2026-09-01T00:00:00.000Z" },
    });
    expect(info.planId).toBe("zed_pro");
    expect(info.trialStartedAtMs).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
  });

  it("defaults to an unknown label when there is no plan at all", () => {
    const info = parseCapnZedPlanInfo({});
    expect(info.planId).toBeNull();
    expect(info.planLabel).toBe("Unknown");
  });
});

describe("classifyCapnZedUser — trial preferred, Pro allowed", () => {
  it("allows zed_pro_trial", () => {
    expect(classifyCapnZedUser(planResponse(), NOW).allowed).toBe(true);
  });

  it("allows zed_pro", () => {
    const verdict = classifyCapnZedUser(planResponse({ plan_v3: "zed_pro" }), NOW);
    expect(verdict.allowed).toBe(true);
  });

  it.each(["zed_free", "zed_student", "zed_business", "zed_vip"])(
    "refuses %s with a plan-not-eligible code",
    (planId) => {
      const verdict = classifyCapnZedUser(planResponse({ plan_v3: planId }), NOW);
      expect(verdict.allowed).toBe(false);
      expect(verdict.code).toBe(CAPNZED_LOCK_CODES.planNotEligible);
      expect(verdict.reason).toMatch(/only serves Zed Pro Trial or Zed Pro/);
    },
  );

  it("refuses an account Zed flags as too young, even on a trial", () => {
    const verdict = classifyCapnZedUser(
      planResponse({ is_account_too_young: true, trial_started_at: "2026-09-14T00:00:00.000Z" }),
      NOW,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe(CAPNZED_LOCK_CODES.accountTooYoung);
  });

  it("refuses an account with overdue invoices, even on a trial", () => {
    const verdict = classifyCapnZedUser(
      planResponse({ has_overdue_invoices: true, trial_started_at: "2026-09-14T00:00:00.000Z" }),
      NOW,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe(CAPNZED_LOCK_CODES.overdueInvoices);
  });
});

describe("capnZedLockUntilMs — park a spent account until the trial window ends", () => {
  it("prefers subscription_period.ended_at when it is still in the future", () => {
    const endedAt = "2026-09-20T00:00:00.000Z";
    expect(
      capnZedLockUntilMs(
        planResponse({
          trial_started_at: "2026-09-01T00:00:00.000Z",
          subscription_period: { started_at: "2026-09-01T00:00:00.000Z", ended_at: endedAt },
        }),
        NOW,
      ),
    ).toBe(Date.parse(endedAt));
  });

  it("falls back to trial_started_at + 14 days (Zed's documented trial length)", () => {
    const started = "2026-09-10T00:00:00.000Z";
    expect(capnZedLockUntilMs(planResponse({ trial_started_at: started }), NOW)).toBe(
      Date.parse(started) + CAPNZED_TRIAL_DAYS * DAY_MS,
    );
  });

  it("uses the 30-day fallback when the trial window is already in the past", () => {
    expect(
      capnZedLockUntilMs(
        planResponse({
          plan_v3: "zed_free",
          trial_started_at: "2026-01-01T00:00:00.000Z",
          subscription_period: {
            started_at: "2026-01-01T00:00:00.000Z",
            ended_at: "2026-01-15T00:00:00.000Z",
          },
        }),
        NOW,
      ),
    ).toBe(NOW + 30 * DAY_MS);
  });

  it("clamps a hostile far-future value to the 31-day ceiling", () => {
    const lock = capnZedLockUntilMs(
      planResponse({
        subscription_period: {
          started_at: "2026-09-01T00:00:00.000Z",
          ended_at: "2030-01-01T00:00:00.000Z",
        },
      }),
      NOW,
    );
    expect(lock).toBe(NOW + CAPNZED_MAX_LOCK_MS);
  });
});

describe("exhaustion detection", () => {
  it("treats HTTP 402 as account exhaustion regardless of body", () => {
    expect(isCapnZedAccountExhausted(402, "")).toBe(true);
    expect(isCapnZedAccountExhausted(402, "{}")).toBe(true);
  });

  it("recognises the payment/trial wordings Zed uses", () => {
    expect(
      isCapnZedAccountExhausted(403, "Trial access is blocked. Please reach out to billing-support@zed.dev"),
    ).toBe(true);
    expect(
      isCapnZedAccountExhausted(400, "payment required to use this language model"),
    ).toBe(true);
    expect(isCapnZedAccountExhausted(500, "upstream unavailable")).toBe(false);
  });

  it("does not flag a normal 200 stream", () => {
    expect(isCapnZedAccountExhausted(200, '{"event":{"type":"message_start"}}')).toBe(false);
  });

  it("detects an in-stream failed frame that means the ACCOUNT is done", () => {
    expect(
      isCapnZedInStreamAccountFailure({
        type: "failed",
        failed: { code: "payment_required", message: "payment required" },
      }),
    ).toBe(true);
  });

  it("ignores an unrelated in-stream failure", () => {
    expect(
      isCapnZedInStreamAccountFailure({
        type: "failed",
        failed: { code: "upstream_http_500", message: "bad gateway" },
      }),
    ).toBe(false);
  });
});

describe("account auth header", () => {
  it("uses Zed's '{user_id} {access_token}' scheme, not Bearer", () => {
    expect(
      buildCapnZedAccountAuthHeader({
        accessToken: "tok",
        providerSpecificData: { userId: "123" },
      }),
    ).toBe("123 tok");
  });

  it("throws when the user id is missing", () => {
    expect(() => buildCapnZedAccountAuthHeader({ accessToken: "tok" })).toThrow(/userId/);
  });
});

describe("organization resolution", () => {
  it("prefers the explicit providerSpecificData value", () => {
    expect(
      resolveCapnZedOrganizationId(
        { providerSpecificData: { organizationId: "org-explicit" } },
        { default_organization_id: "org-default" },
      ),
    ).toBe("org-explicit");
  });

  it("falls back to the personal organization", () => {
    expect(
      resolveCapnZedOrganizationId(
        {},
        {
          organizations: [{ id: "org-biz", is_personal: false }, { id: "org-me", is_personal: true }],
        },
      ),
    ).toBe("org-me");
  });
});

describe("RSA native-app flow", () => {
  it("emits a native_app_signin URL bound to the callback port and public key", () => {
    const auth = createCapnZedNativeAuthData(
      { webBaseUrl: "https://zed.dev" },
      { nativeAppPort: 58444, systemId: "sys-1" },
    );
    const url = new URL(auth.authUrl);

    expect(url.pathname).toBe("/native_app_signin");
    expect(url.searchParams.get("native_app_port")).toBe("58444");
    expect(url.searchParams.get("system_id")).toBe("sys-1");
    expect(url.searchParams.get("native_app_public_key")).toBe(auth.publicKey);
    expect(auth.privateKeyVerifier.startsWith("capnzed-rsa-pkcs1:")).toBe(true);
  });

  it("decodes the verifier back into the original PEM private key", () => {
    const auth = createCapnZedNativeAuthData({}, { nativeAppPort: 1 });
    const pem = decodeCapnZedPrivateKeyVerifier(auth.privateKeyVerifier);
    expect(pem).toMatch(/-----BEGIN RSA PRIVATE KEY-----/);
  });

  it("round-trips a token encrypted with the generated public key (OAEP-SHA256)", () => {
    const auth = createCapnZedNativeAuthData({}, { nativeAppPort: 1 });
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(auth.publicKey, "base64url"),
      format: "der",
      type: "pkcs1",
    });
    const plaintext = "zed-access-token-abc123";
    const encrypted = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(plaintext, "utf8"),
    );

    const decrypted = decryptCapnZedAccessToken(
      encrypted.toString("base64url"),
      auth.privateKeyVerifier,
    );
    expect(decrypted).toBe(plaintext);
  });

  it("still decrypts a PKCS#1 v1.5 payload (the documented fallback)", () => {
    const auth = createCapnZedNativeAuthData({}, { nativeAppPort: 1 });
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(auth.publicKey, "base64url"),
      format: "der",
      type: "pkcs1",
    });
    const encrypted = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from("legacy-token", "utf8"),
    );

    expect(
      decryptCapnZedAccessToken(encrypted.toString("base64url"), auth.privateKeyVerifier),
    ).toBe("legacy-token");
  });

  it("rejects a verifier that is not a CapnZed private key", () => {
    expect(() => decryptCapnZedAccessToken("AAAA", "pkce-verifier")).toThrow(
      /Missing CapnZed private key verifier/,
    );
  });
});

describe("parseCapnZedCallbackPayload", () => {
  it("accepts a raw callback URL", () => {
    expect(
      parseCapnZedCallbackPayload("http://127.0.0.1:58444/?user_id=7&access_token=ENC"),
    ).toEqual({ userId: "7", encryptedAccessToken: "ENC" });
  });

  it("accepts a bare query string", () => {
    expect(parseCapnZedCallbackPayload("user_id=7&access_token=ENC")).toEqual({
      userId: "7",
      encryptedAccessToken: "ENC",
    });
  });

  it("accepts the JSON form", () => {
    expect(parseCapnZedCallbackPayload('{"user_id":"7","access_token":"ENC"}')).toEqual({
      userId: "7",
      encryptedAccessToken: "ENC",
    });
  });

  it("rejects a payload without a token", () => {
    expect(() => parseCapnZedCallbackPayload("user_id=7")).toThrow(/user_id and access_token/);
  });
});

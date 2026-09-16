import { describe, it, expect, vi, beforeEach } from "vitest";

// The wire layer funnels every request through proxyAwareFetch; mocking it (and
// nothing else) keeps the protocol logic under test while staying offline.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const {
  CAMBER_ERROR_CODES,
  CamberApiError,
  camberAuthToken,
  camberModelIdFromWire,
  classifyCamberError,
  decodeCamberLoginToken,
  describeCamberKeyProblem,
  fetchCamberMe,
  initiateCamberLogin,
  normalizeCamberApiKey,
  pollCamberLogin,
} = await import("../../open-sse/shared/camberAuth.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A login blob with the shape a live login returns. The IDs here are
 * synthetic — only the JSON shape is taken from the verified capture.
 */
function loginBlob(overrides = {}) {
  const payload = {
    profile: { username: "reze", email: "user@example.com", token: "3bd93536c54b5f72da789d41d68bb1a912ec4d34" },
    teams: [{ id: 12, uniqueName: "habibateam45905733", name: "habibateam" }],
    ...overrides,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("normalizeCamberApiKey", () => {
  it("trims a normal key", () => {
    expect(normalizeCamberApiKey("  3bd93536c54b5f72da789d41d68bb1a912ec4d34  ")).toBe(
      "3bd93536c54b5f72da789d41d68bb1a912ec4d34",
    );
  });

  it("rejects the things that are certainly user error", () => {
    expect(normalizeCamberApiKey("")).toBe("");
    expect(normalizeCamberApiKey(null)).toBe("");
    expect(normalizeCamberApiKey("has space")).toBe("");
    expect(normalizeCamberApiKey("https://app.cambercloud.com/auth-cli?session_id=x")).toBe("");
    expect(normalizeCamberApiKey('{"code":0,"data":{"token":"x"}}')).toBe("");
  });

  it("keeps keys that merely look unusual, so other tiers still work", () => {
    expect(normalizeCamberApiKey("sk-live-abc.def-123_xyz")).toBe("sk-live-abc.def-123_xyz");
  });
});

describe("describeCamberKeyProblem — say what is wrong, don't probe upstream", () => {
  it("asks for the key when nothing was pasted", () => {
    expect(describeCamberKeyProblem("")).toMatch(/Enter the Camber API key/);
    expect(describeCamberKeyProblem(undefined)).toMatch(/Enter the Camber API key/);
  });

  it("names the sign-in URL for what it is", () => {
    // Probing this upstream returns "user not found", which reads like a
    // wrong-account problem instead of a paste mistake.
    expect(describeCamberKeyProblem("https://app.cambercloud.com/auth-cli?session_id=x")).toMatch(
      /sign-in URL, not an API key/,
    );
  });

  it("catches a copied JSON blob", () => {
    expect(describeCamberKeyProblem('{"code":0,"data":{"token":"x"}}')).toMatch(/JSON/);
  });

  it("catches a wrapped or partial paste", () => {
    expect(describeCamberKeyProblem("3bd93536c54b5f72\nda789d41d68bb1a912ec4d34")).toMatch(/no spaces/);
  });

  it("clears anything key-shaped, including a padded paste", () => {
    expect(describeCamberKeyProblem("3bd93536c54b5f72da789d41d68bb1a912ec4d34")).toBeNull();
    expect(describeCamberKeyProblem("  3bd93536c54b5f72da789d41d68bb1a912ec4d34  ")).toBeNull();
    expect(describeCamberKeyProblem("dev-tier_key.with-punctuation")).toBeNull();
  });
});

describe("camberAuthToken", () => {
  it("prefers apiKey and falls back to an OAuth access token", () => {
    expect(camberAuthToken({ apiKey: "aaa" })).toBe("aaa");
    expect(camberAuthToken({ accessToken: "bbb" })).toBe("bbb");
    expect(camberAuthToken({ apiKey: "", accessToken: "bbb" })).toBe("bbb");
  });

  it("returns empty when the connection carries nothing usable", () => {
    expect(camberAuthToken({})).toBe("");
    expect(camberAuthToken(null)).toBe("");
  });
});

describe("decodeCamberLoginToken", () => {
  it("reads the profile and teams out of the base64 blob", () => {
    const decoded = decodeCamberLoginToken(loginBlob());
    expect(decoded).toEqual({
      apiKey: "3bd93536c54b5f72da789d41d68bb1a912ec4d34",
      username: "reze",
      email: "user@example.com",
      teams: [{ id: 12, uniqueName: "habibateam45905733", name: "habibateam" }],
    });
  });

  it("returns null for anything that is not a login blob", () => {
    expect(decodeCamberLoginToken("")).toBeNull();
    expect(decodeCamberLoginToken("not base64 at all !!!")).toBeNull();
    expect(decodeCamberLoginToken(Buffer.from("plain text").toString("base64"))).toBeNull();
    // Valid JSON but the wrong shape (e.g. the API envelope) must not pass.
    expect(decodeCamberLoginToken(Buffer.from('{"code":0}').toString("base64"))).toBeNull();
  });

  it("requires a usable token inside the profile", () => {
    const noToken = loginBlob({ profile: { username: "reze", email: "e", token: "" } });
    expect(decodeCamberLoginToken(noToken)).toBeNull();
  });

  it("tolerates a missing teams list", () => {
    const decoded = decodeCamberLoginToken(loginBlob({ teams: undefined }));
    expect(decoded.teams).toEqual([]);
    expect(decoded.apiKey).toHaveLength(40);
  });
});

describe("classifyCamberError — the taxonomy verified against the live API", () => {
  it("401/403 → bad API key", () => {
    expect(classifyCamberError(401, "").code).toBe(CAMBER_ERROR_CODES.badApiKey);
    expect(classifyCamberError(403, "").code).toBe(CAMBER_ERROR_CODES.badApiKey);
  });

  it("404 Agent not found → unknown agent", () => {
    const classified = classifyCamberError(404, '{"code":10,"message":"Agent not found"}');
    expect(classified.code).toBe(CAMBER_ERROR_CODES.unknownAgent);
    expect(classified.message).toContain("Agent not found");
  });

  it("400 Model not supported by the current plan → not in plan", () => {
    const classified = classifyCamberError(
      400,
      '{"code":2,"message":"Model not supported by the current plan"}',
    );
    expect(classified.code).toBe(CAMBER_ERROR_CODES.modelNotInPlan);
  });

  it("500 Failed to get conversation → unknown conversation", () => {
    const classified = classifyCamberError(500, '{"code":2,"message":"Failed to get conversation"}');
    expect(classified.code).toBe(CAMBER_ERROR_CODES.unknownConversation);
  });

  it("validation failures carry the Camber message", () => {
    const classified = classifyCamberError(
      400,
      '{"code":1,"message":"Validation failed","error_details":[{"key":"CLIInitConversationRequest.Content"}]}',
    );
    expect(classified.code).toBe(CAMBER_ERROR_CODES.validation);
    expect(classified.message).toContain("Validation failed");
  });

  it("429 → rate limited", () => {
    expect(classifyCamberError(429, '{"code":2,"message":"slow down"}').code).toBe(
      CAMBER_ERROR_CODES.rateLimited,
    );
  });

  it("passes an unparseable upstream body along, truncated, and keeps the status", () => {
    // A gateway HTML page carries no envelope but is often the only diagnostic
    // we have, so it is forwarded — just never whole.
    const classified = classifyCamberError(503, `<html>${"x".repeat(600)}bad gateway</html>`);
    expect(classified.status).toBe(503);
    expect(classified.message.length).toBeLessThanOrEqual(400);
  });

  it("names the HTTP status when the upstream body is empty", () => {
    const classified = classifyCamberError(503, "");
    expect(classified.status).toBe(503);
    expect(classified.message).toMatch(/503/);
  });
});

describe("initiateCamberLogin", () => {
  it("returns the login URL the user is sent to", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, message: "ok", data: { session_id: "sess-123" } }));
    const result = await initiateCamberLogin();
    expect(result.sessionId).toBe("sess-123");
    expect(result.loginUrl).toBe("https://app.cambercloud.com/auth-cli?session_id=sess-123");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api-v2.cambercloud.com/api/cli/auth/initiate");
    expect(init.method).toBe("POST");
  });

  it("honours a per-connection base URL override (dev/staging builds)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { session_id: "s2" } }));
    const result = await initiateCamberLogin({
      config: { apiBaseUrl: "https://api.staging.camber.cloud/", webBaseUrl: "https://staging.camber.cloud/" },
    });
    expect(result.loginUrl).toBe("https://staging.camber.cloud/auth-cli?session_id=s2");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.staging.camber.cloud/auth/initiate");
  });

  it("throws when the response has no session id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, data: {} }));
    await expect(initiateCamberLogin()).rejects.toBeInstanceOf(CamberApiError);
  });

  it("throws on a non-2xx answer instead of returning a broken URL", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
    await expect(initiateCamberLogin()).rejects.toThrow(/HTTP 502/);
  });
});

describe("pollCamberLogin", () => {
  it("reports pending on 202", async () => {
    fetchMock.mockResolvedValue(new Response('{"data":"pending"}', { status: 202 }));
    expect(await pollCamberLogin("sess-123")).toEqual({ pending: true });
  });

  it("also treats a literal 'pending' body as pending", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, data: "pending" }));
    expect(await pollCamberLogin("sess-123")).toEqual({ pending: true });
  });

  it("decodes the credential once the user authorises", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, data: { token: loginBlob() } }));
    const result = await pollCamberLogin("sess-123");
    expect(result.apiKey).toBe("3bd93536c54b5f72da789d41d68bb1a912ec4d34");
    expect(result.username).toBe("reze");
    expect(result.pending).toBeUndefined();

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/auth/poll");
    expect(url).toContain("session_id=sess-123");
  });

  it("refuses a session id-less call rather than polling nothing", async () => {
    await expect(pollCamberLogin("")).rejects.toThrow(/session is missing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an unreadable token instead of saving a blank connection", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, data: { token: Buffer.from("junk").toString("base64") } }));
    await expect(pollCamberLogin("sess-123")).rejects.toThrow(/could not read/);
  });

  it("maps a 500 from the poll onto a classified error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 2, message: "Failed to get conversation" }, 500));
    await expect(pollCamberLogin("sess-123")).rejects.toThrow(/Failed to get conversation/);
  });
});

describe("fetchCamberMe", () => {
  it("unwraps the { code, message, data } envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, data: { username: "reze", teams: [] } }));
    expect(await fetchCamberMe({ apiKey: "k" })).toEqual({ username: "reze", teams: [] });
  });

  it("throws on a non-zero envelope code so callers see a real failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 2, message: "Failed to get conversation" }));
    await expect(fetchCamberMe({ apiKey: "k" })).rejects.toThrow(/Failed to get conversation/);
  });

  it("throws before any request when the connection has no key", async () => {
    await expect(fetchCamberMe({})).rejects.toThrow(/no API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the bearer header the CLI uses", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, data: {} }));
    await fetchCamberMe({ apiKey: "secret-key" });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer secret-key");
  });
});

describe("proxy threading", () => {
  it("passes proxyOptions as the THIRD argument of proxyAwareFetch", async () => {
    // Getting this argument position wrong silently drops the connection's
    // proxy — a live bug in the upstream zed executor worth not repeating.
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, data: {} }));
    await fetchCamberMe({ apiKey: "k" }, { proxyOptions: "socks5://127.0.0.1:1080" });
    expect(fetchMock.mock.calls[0][2]).toBe("socks5://127.0.0.1:1080");
  });
});

describe("camberModelIdFromWire", () => {
  it("maps the wire id back to the picker id", () => {
    expect(camberModelIdFromWire("bedrock:claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

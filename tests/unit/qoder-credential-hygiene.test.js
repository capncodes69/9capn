import { describe, expect, it, vi, beforeEach } from "vitest";

// Deterministic network: exchange returns a jt-, userinfo returns an id.
const calls = [];
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url) => {
    calls.push(url);
    if (url.includes("jobToken/exchange")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "jt-derived-token", expires_at: null }),
        text: async () => "",
      };
    }
    if (url.includes("userinfo")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "01a18146-d651-7730-acd6-b56da1734fb9" }),
        text: async () => "",
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  },
}));

vi.mock("../../src/lib/db/repos/connectionsRepo.js", () => ({
  updateProviderConnection: async () => ({}),
}));

const { resolveQoderCredentials } = await import(
  "../../open-sse/services/qoderModels.js"
);

/**
 * After a PAT is exchanged for a job token, the raw PAT must not survive on the
 * credential object. The PAT is a year-long secret; the job token is a 24h
 * derivative. Carrying both means the PAT can leak into logs or into any
 * consumer that reads `apiKey` and skips `accessToken`.
 */
describe("resolveQoderCredentials secret hygiene", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("drops the raw PAT from apiKey once exchanged", async () => {
    const out = await resolveQoderCredentials(
      {
        connectionId: "conn-hygiene",
        provider: "qoder",
        apiKey: "pt-raw-secret-value",
        accessToken: null,
        providerSpecificData: {},
      },
      null,
      null,
      "intl",
    );

    expect(out.accessToken).toBe("jt-derived-token");
    expect(out.apiKey).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("pt-raw-secret-value");
  });

  it("stores the resolved user id and a stable machine id", async () => {
    const out = await resolveQoderCredentials(
      {
        connectionId: "conn-hygiene",
        provider: "qoder",
        apiKey: "pt-raw-secret-value",
        accessToken: null,
        providerSpecificData: {},
      },
      null,
      null,
      "intl",
    );

    expect(out.providerSpecificData.userId).toBe("01a18146-d651-7730-acd6-b56da1734fb9");
    expect(out.providerSpecificData.machineId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

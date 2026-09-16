import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseCamberUsage } from "../../open-sse/services/usage/camber.js";
import { getProvider, getProviderNames, generateAuthData } from "@/lib/oauth/providers";

// Only the two login calls are stubbed; the rest of the wire layer stays real so
// the provider module is exercised against actual code.
const initiateCamberLogin = vi.fn();
const pollCamberLogin = vi.fn();
vi.mock("../../open-sse/shared/camberAuth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initiateCamberLogin: (...args) => initiateCamberLogin(...args),
    pollCamberLogin: (...args) => pollCamberLogin(...args),
  };
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

function resolveModule(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, resolve(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Import specifiers of a module, without parsing comments.
 *
 * Comments in this repo name modules freely (that is how it documents itself),
 * so a plain substring search both over- and under-reports. Only lines that are
 * not comment lines are scanned, and a multi-line `import { … } from "…"` still
 * puts its specifier on a line of its own. This FAILS CLOSED: a mention inside
 * a block comment is read as a real import, which only makes the check stricter.
 */
function importSpecifiers(text) {
  const specs = [];
  for (const line of text.split("\n")) {
    if (/^\s*\/\//.test(line)) continue;
    for (const [, spec] of line.matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)) {
      specs.push(spec);
    }
  }
  return specs;
}

/** A line-start import statement — the shape a bundler actually follows. */
const hasImportStatements = (text) => /^\s*import\s/m.test(text);
const importsProxyFetch = (text) =>
  /^\s*import[^;]*from\s+["'][^"']*proxyFetch[^"']*["']/m.test(text);

beforeEach(() => {
  initiateCamberLogin.mockReset();
  pollCamberLogin.mockReset();
});

describe("Camber is wired end to end", () => {
  it("registers as a VISIBLE oauth provider with the cbr alias", () => {
    const entry = REGISTRY.find((r) => r.id === "camber");

    expect(entry).toBeDefined();
    expect(entry.hidden).toBeFalsy();
    expect(entry.category).toBe("oauth");
    expect(entry.alias).toBe("cbr");
    expect(entry.uiAlias).toBe("cbr");
    expect(entry.display.name).toBe("Camber");
    expect(entry.display.textIcon).toBe("CB");
    // Dual auth: browser login AND a pasted API key (both end up as a bearer key).
    expect(entry.authModes).toEqual(["oauth", "apikey"]);
    expect(entry.hasOAuth).toBe(true);
  });

  it("ships the provider icon at the path the dashboard resolves", () => {
    // ProviderIcon builds /providers/{id}.png, and a miss falls back to the
    // text badge for the whole session — so the file has to exist and be real.
    const icon = resolve(ROOT, "public/providers/camber.png");
    expect(existsSync(icon)).toBe(true);
    const head = readFileSync(icon).subarray(0, 8);
    expect([...head.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    // Inline PNG IHDR: width/height at bytes 16-23.
    const view = readFileSync(icon);
    expect(view.readUInt32BE(16)).toBe(128);
    expect(view.readUInt32BE(20)).toBe(128);
  });

  it("ships the Bedrock catalog as the static floor, with passthrough on", async () => {
    const entry = REGISTRY.find((r) => r.id === "camber");
    const { CAMBER_MODELS } = await import("open-sse/shared/camberCatalog.js");

    // Camber has no /models endpoint, so the list is a floor and the server is
    // the authority; an id it adds later must still route.
    expect(entry.models.map((m) => m.id).sort()).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
    ]);
    expect(entry.models.some((m) => m.name === "Claude Opus 5")).toBe(true);
    expect(entry.passthroughModels).toBe(true);
    // One source of truth: the registry reads the catalog, so the picker can
    // never drift from what the wire layer maps.
    expect(entry.models).toEqual(CAMBER_MODELS.map((m) => ({ id: m.id, name: m.name })));
  });

  it("keeps the client-bundled registry out of the wire layer", () => {
    // Registry entries are imported by src/shared/constants/providers.js, which
    // the dashboard shell renders in the browser. Importing anything that
    // reaches proxyFetch drags `await import("dns")` into the client graph and
    // makes Next warn on every build. camberCatalog.js exists to avoid that, so
    // guard the whole directory and not just this provider: a shared module a
    // registry may pull in has to be import-free.
    const registryDir = resolve(ROOT, "open-sse/providers/registry");
    const sharedDir = resolve(ROOT, "open-sse/shared");
    const offenders = [];

    for (const file of readdirSync(registryDir).filter((name) => name.endsWith(".js"))) {
      const text = readFileSync(resolve(registryDir, file), "utf8");
      for (const spec of importSpecifiers(text)) {
        const dep = spec.startsWith(".") ? resolveModule(resolve(registryDir, file), spec) : null;
        if (!dep) continue;
        const depText = readFileSync(dep, "utf8");
        if (importsProxyFetch(depText)) offenders.push(`${file} -> ${spec} (imports proxyFetch)`);
        // A dependency under open-sse/shared is in the client graph too, so it
        // must not import anything.
        if (dep.startsWith(sharedDir) && hasImportStatements(depText)) {
          offenders.push(`${file} -> ${spec} (shared module with imports)`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("allows for the cold-start warm-up instead of the streaming speed", () => {
    const entry = REGISTRY.find((r) => r.id === "camber");

    // A new conversation measured ~2 minutes before its first frame; a short
    // timeout would kill healthy runs.
    expect(entry.transport.timeoutMs).toBeGreaterThanOrEqual(300000);
    expect(entry.transport.stallTimeoutMs).toBeGreaterThanOrEqual(300000);
    expect(entry.transport.forceStream).toBe(true);
    expect(entry.transport.auth.header).toBe("Authorization");
  });

  it("reports usage for both oauth and pasted-key connections", () => {
    const entry = REGISTRY.find((r) => r.id === "camber");
    expect(entry.features?.usage).toBe(true);
    expect(entry.features?.usageApikey).toBe(true);
    expect(entry.transport.usage.url).toContain("/cli/me");
  });

  it("lands in the dashboard's provider lists (the hidden filter passes)", async () => {
    const { OAUTH_PROVIDERS, AI_PROVIDERS } = await import("@/shared/constants/providers.js");

    expect(OAUTH_PROVIDERS.camber).toBeDefined();
    expect(AI_PROVIDERS.camber?.hidden).toBeFalsy();
    expect(OAUTH_PROVIDERS.camber.name).toBe("Camber");
    expect(OAUTH_PROVIDERS.camber.alias).toBe("cbr");
  });

  it("routes to its own executor instead of the default one", () => {
    expect(hasSpecializedExecutor("camber")).toBe(true);
    expect(getExecutor("camber").constructor.name).toBe("CamberExecutor");
  });
});

describe("Camber login is a device-flow, not an OAuth2 redirect", () => {
  it("registers the provider and exposes no upfront auth URL", async () => {
    expect(getProviderNames()).toContain("camber");

    const auth = await generateAuthData("camber");
    expect(auth.flowType).toBe("device_code");
    // The session id only exists after /auth/initiate, so there is no URL yet.
    expect(auth.authUrl).toBeNull();
  });

  it("returns the session id in the shape OAuthModal expects", async () => {
    initiateCamberLogin.mockResolvedValue({
      sessionId: "sess-123",
      loginUrl: "https://app.cambercloud.com/auth-cli?session_id=sess-123",
    });

    const device = await getProvider("camber").requestDeviceCode({ pollIntervalSeconds: 5 });

    expect(device.device_code).toBe("sess-123");
    expect(device.verification_uri_complete).toContain("session_id=sess-123");
    expect(device.expires_in).toBeGreaterThan(0);
    expect(device.interval).toBe(5);
    // No code to type: the authorisation happens on the page the user opens.
    // OAuthModal hides the "Your Code" block when this is empty.
    expect(device.user_code).toBe("");
  });

  it("reports 'pending' in the shape the modal's poller understands", async () => {
    pollCamberLogin.mockResolvedValue({ pending: true });
    const result = await getProvider("camber").pollToken({}, "sess-123");
    expect(result).toEqual({ ok: false, data: { error: "authorization_pending" } });
  });

  it("never crashes the poller when the poll throws", async () => {
    pollCamberLogin.mockRejectedValue(new Error("network down"));
    const result = await getProvider("camber").pollToken({}, "sess-123");
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe("poll_failed");
    expect(result.data.error_description).toContain("network down");
  });

  it("maps the issued key onto a non-refreshable credential", async () => {
    pollCamberLogin.mockResolvedValue({
      apiKey: "3bd93536c54b5f72da789d41d68bb1a912ec4d34",
      username: "reze",
      email: "user@example.com",
      teams: [{ id: 1, uniqueName: "team", name: "Team" }],
    });

    const provider = getProvider("camber");
    const tokens = await provider.pollToken({}, "sess-123");
    expect(tokens.ok).toBe(true);

    const mapped = provider.mapTokens(tokens.data);
    expect(mapped.accessToken).toHaveLength(40);
    // A long-lived API key: nothing to refresh and no expiry to track.
    expect(mapped.refreshToken).toBeNull();
    expect(mapped.expiresIn).toBeNull();
    expect(mapped.email).toBe("user@example.com");
    expect(mapped.displayName).toBe("reze");
    expect(mapped.providerSpecificData.authMethod).toBe("device_code");
    expect(mapped.providerSpecificData.camberUsername).toBe("reze");
  });

  it("keeps a login without an email from breaking deduplication", async () => {
    const mapped = getProvider("camber").mapTokens({
      access_token: "k",
      _camberUsername: "",
      _camberEmail: "",
      _camberTeams: null,
    });
    // An empty string would look like a real (blank) email to the connection
    // deduper; null is what it expects for "unknown".
    expect(mapped.email).toBeNull();
    expect(mapped.displayName).toBeUndefined();
    expect(mapped.providerSpecificData.camberTeams).toEqual([]);
  });

  it("is listed in the modal's device-code allowlist (the bug that broke Connect)", async () => {
    // OAuthModal keeps a HARDCODED list of device-code providers while the route
    // serves /device-code for anyone whose provider declares flowType
    // "device_code". Camber was in the route and missing from the modal, so
    // Connect died with "uses device-code login but is not wired in the OAuth
    // modal device-code list". This is the general form of that bug.
    const { PROVIDERS } = await import("@/lib/oauth/providers");
    const block = source("src/shared/components/OAuthModal.js").match(
      /const deviceCodeProviders = \[([\s\S]*?)\];/,
    );
    expect(block).not.toBeNull();
    const wired = new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

    const deviceFlow = Object.entries(PROVIDERS)
      .filter(([, p]) => p.flowType === "device_code")
      .map(([name]) => name);

    expect(deviceFlow).toContain("camber");
    for (const name of deviceFlow) {
      expect(wired.has(name), `${name} is missing from the modal's device-code list`).toBe(true);
    }

    // And nothing stale: every wired name must still be a device-flow provider
    // (kimi-coding is the documented legacy alias of kimi).
    const legacyAliases = new Set(["kimi-coding"]);
    for (const name of wired) {
      if (legacyAliases.has(name)) continue;
      expect(deviceFlow, `${name} is stale in the modal's device-code list`).toContain(name);
    }
  });

  it("treats camber as a session-id flow in the oauth route", () => {
    // It has no PKCE and no redirect_uri: the callback carries the session id.
    const route = source("src/app/api/oauth/[provider]/[action]/route.js");
    expect(route).toContain('"camber"');
    expect(route).toMatch(/provider === "camber"/);
  });
});

describe("Camber usage reports identity, never a fabricated quota", () => {
  it("returns a clean message when the connection has no key (no network)", async () => {
    const usage = await getUsageForProvider({ provider: "camber", accessToken: null });
    expect(usage.message).toMatch(/API key not available/);
  });

  it("maps /me onto the card, naming the account and the pinned agent", () => {
    const usage = parseCamberUsage(
      {
        user_id: "u-1",
        username: "reze",
        email: "user@example.com",
        teams: [{ team_name: "habibateam", is_selected: true }, { team_name: "other" }],
      },
      { camberAgent: "@reze.my_agent" },
    );

    expect(usage.plan).toBe("Camber");
    // No bar to draw: Camber publishes no quota.
    expect(usage.quotas).toEqual({});
    expect(usage.identity).toEqual({
      userId: "u-1",
      username: "reze",
      email: "user@example.com",
      teamCount: 2,
    });
    expect(usage.message).toContain("Agent: reze.my_agent");
    expect(usage.message).toContain("Selected team: habibateam");
    // The card must NOT claim Camber has no usage API — it has one, scoped to
    // the web session. Getting this wrong sends the user looking for a meter
    // that does exist.
    expect(usage.message).not.toMatch(/no quota or credit API/i);
    expect(usage.message).toMatch(/scoped to the web\s+session/i);
  });

  it("merges the local message count in the usage route, for camber only", () => {
    const route = source("src/app/api/usage/[connectionId]/route.js");
    expect(route).toContain("applyCamberMessageCount");
    expect(route).toContain("CAMBER_PROVIDER_ID");
    // The merge must be gated: another provider's payload has no window/limit.
    expect(route).toMatch(/connection\.provider === CAMBER_PROVIDER_ID/);
  });

  it("registers a camber branch in the dashboard quota parser", () => {
    // Without an explicit case the generic fallback drops remainingPercentage,
    // so the row would render as a bare count with no bar.
    const utils = source("src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js");
    expect(utils).toContain('case "camber"');
    expect(utils).toMatch(/case "camber":[\s\S]{0,700}remainingPercentage: quota\.remainingPercentage/);
  });

  it("lets the connection set the plan and limit the meter uses", () => {
    const modal = source("src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js");
    expect(modal).toContain("CAMBER_PLAN_LIMITS");
    for (const key of ["camberPlan", "camberMessageLimit", "camberPeriodStart"]) {
      expect(modal).toContain(key);
    }
    // Client component: the catalog is fine, the wire layer is not (asserted above).
    expect(modal).toContain('from "open-sse/shared/camberCatalog.js"');
  });

  it("reports no agent rather than inventing one the connection never pinned", () => {
    const usage = parseCamberUsage({}, {});
    expect(usage.message).toContain("Agent: none pinned");
    expect(usage.message).not.toContain("nova.cli");
    expect(usage.message).not.toContain("team");
    expect(usage.identity.username).toBeNull();
  });
});

describe("the dashboard surfaces the agent as a per-connection setting", () => {
  it("asks for the agent alias (stripping any @) in the API-key modal", () => {
    const modal = source("src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js");
    expect(modal).toContain('provider === "camber"');
    expect(modal).toContain("camberAgent");
    // The wire takes the alias WITHOUT the @, so the modal normalises it.
    expect(modal).toMatch(/replace\(\/\^@\//);
    expect(modal).toMatch(/Camber Agent/);
  });

  it("does NOT pin the CLI agent by default — that is what broke local tool use", () => {
    // A live turn with context_agent="nova.cli" answers "Camber CLI agent for
    // coding environments" and hunts for files in a Camber sandbox, because the
    // server prepends that agent's system prompt. The form must not default to
    // it, and the empty state must mean "send no context_agent at all".
    const modal = source("src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js");
    expect(modal).toMatch(/const \[camberAgent, setCamberAgent\] = useState\(""\)/);
    expect(modal).not.toMatch(/(camberAgent|\|\|)\s*(\?\?|\|\|)?\s*"nova\.cli"/);

    // The registry's advertised default must be the same "no agent" sentinel.
    const registry = source("open-sse/providers/registry/camber.js");
    expect(registry).toMatch(/defaultAgent: CAMBER_DEFAULT_AGENT/);
  });

  it("warns that a Camber agent cannot touch the caller's machine", () => {
    // Verified live: every agent available runs in a Camber-hosted Jupyter
    // sandbox, the orchestrator's own pick writes to ./outputs/, and a forceful
    // client [system] override still answered SANDBOX-ONLY. Users otherwise read
    // "agent" as "local coding agent" and lose an afternoon to it.
    const modal = source("src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js");
    expect(modal).toMatch(/cannot read or edit\s+\n?\s*files on this machine/);
    expect(modal).toMatch(/sandbox/i);
  });

  it("hides the 'Your Code' block for providers that have no user code", () => {
    const modalSource = source("src/shared/components/OAuthModal.js");
    expect(modalSource).toContain("{deviceData.user_code && (");
  });

  it("validates a pasted key against /me before saving it", () => {
    const route = source("src/app/api/providers/validate/route.js");
    expect(route).toContain('case "camber"');
    expect(route).toContain("fetchCamberMe");
    // A wrong paste must be reported as a paste error, not as whatever vague
    // answer the upstream gives for an unknown bearer.
    expect(route).toContain("describeCamberKeyProblem");
  });

  it("keeps the wire layer out of client components", () => {
    // The rule the registry obeys applies to every client component: adding
    // camberAuth.js to AddApiKeyModal (an obvious next step for inline key
    // validation) would break the build the same way.
    for (const client of [
      "src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js",
      "src/shared/components/OAuthModal.js",
    ]) {
      expect(importSpecifiers(source(client))).not.toContain("open-sse/shared/camberAuth.js");
    }
  });
});

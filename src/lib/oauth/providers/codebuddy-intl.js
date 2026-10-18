import { CODEBUDDY_INTL_CONFIG } from "../constants/oauth.js";
import { decodeJwtPayload } from "../providerHelpers.js";

// CodeBuddy's device flow answers with JWTs and no profile object, so the
// account identity has to come from somewhere else. There are two sources and
// they are tried in this order:
//
//  1. The token's own claims (`email`, `preferred_username`, `sub`). This is
//     always available and costs no request — the gateway signs the identity
//     into the token, so it is the authoritative answer.
//  2. A profile lookup against the gateway, for the fields the token omits
//     (a display name, an organisation). Best-effort: a failure here must never
//     fail the login, because the token alone is enough to dedup.
//
// Without this, every login stored a bare "Account N" with no email, and
// `createProviderConnection` only dedups on a non-empty email — so importing the
// same account twice produced two rows, and the second one shadowed the first
// on rotation.
const PROFILE_TIMEOUT_MS = 8000;

// WorkBuddy and CodeBuddy are one Keycloak realm and answer the same plugin-auth
// paths — only the host differs. A caller attaching a WorkBuddy account
// therefore rides this provider and names the host its two calls belong on:
// `?domain=workbuddy.ai` on the device-code request and `extraData.domain` on
// the poll. With no hint the config's own host is used, so a CodeBuddy attach is
// unchanged.
const BRAND_HOST_RE = /(?:^|\.)(?:codebuddy|workbuddy)\.ai$/;

/** The `www.` host a caller asked for, or "" when it isn't one of the brands. */
function brandHost(domain) {
  const d = String(domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!d || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || !BRAND_HOST_RE.test(d)) return "";
  return `www.${d}`;
}

/**
 * Best-effort profile lookup. Returns `{}` on any failure — never throws, never
 * blocks a login. The response shape is not contractual, so every field is read
 * defensively and a payload we don't recognise simply contributes nothing.
 */
async function fetchProfile(host, accessToken) {
  if (!accessToken) return {};
  try {
    const response = await fetch(`https://${host}/v2/plugin/auth/user`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": CODEBUDDY_INTL_CONFIG.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": host,
        "X-Product": "SaaS",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!response.ok) return {};
    const payload = await response.json();
    // The gateway wraps its answers as { code, msg, data }. Unwrap when present
    // so a wrapped payload and a bare one are read the same way.
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    return {
      email: data?.email || data?.mail || null,
      username: data?.username || data?.nickname || data?.name || null,
      displayName: data?.displayName || data?.nickname || data?.name || null,
      userId: data?.userId || data?.id || data?.sub || null,
      organizationId: data?.organizationId || data?.orgId || null,
    };
  } catch {
    return {};
  }
}

// CodeBuddy International — mirrors codebuddy-cn flow against the .ai domain.
const codebuddyIntl = {
  config: CODEBUDDY_INTL_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config, _codeChallenge, options = {}) => {
    const host = brandHost(options.domain);
    const stateUrl = host ? `https://${host}/v2/plugin/auth/state` : config.stateUrl;
    const response = await fetch(`${stateUrl}?platform=${config.platform}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": host || "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`CodeBuddy Intl state request failed: ${await response.text()}`);
    const data = await response.json();
    if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
      throw new Error(`CodeBuddy Intl state error: ${data.msg || "missing state/authUrl"}`);
    }
    return {
      device_code: data.data.state,
      verification_uri: data.data.authUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
      _isCodeBuddy: true,
      _brandHost: host || "www.codebuddy.ai",
    };
  },
  pollToken: async (config, deviceCode, _codeVerifier, extraData = {}) => {
    const host = brandHost(extraData?.domain) || extraData?._brandHost || "www.codebuddy.ai";
    const tokenUrl = host ? `https://${host}/v2/plugin/auth/token` : config.tokenUrl;
    const response = await fetch(`${tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": host,
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "SaaS",
      },
    });
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const data = await response.json();
    if (data.code === 0 && data.data?.accessToken) {
      // Enrich from the gateway, then let mapTokens merge: claims win, the
      // profile only fills what the token left empty.
      const profile = await fetchProfile(host, data.data.accessToken);
      return {
        ok: true,
        data: {
          access_token: data.data.accessToken,
          refresh_token: data.data.refreshToken || "",
          token_type: data.data.tokenType || "Bearer",
          expires_in: data.data.expiresIn,
          _profile: profile,
        },
      };
    }
    if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: false, data: { error: data.msg || "unknown_error" } };
  },
  mapTokens: (tokens) => {
    // The identity lives in the token, not in the request: CodeBuddy answers the
    // device flow with JWTs and no profile object. Reading `sub`/`email`/
    // `preferred_username` here is what lets a re-login update the existing row
    // instead of adding another "Account N".
    const jwt = decodeJwtPayload(tokens.access_token) || decodeJwtPayload(tokens.refresh_token);
    const profile = tokens._profile || {};

    // Token claims are authoritative; the profile lookup only fills the gaps.
    const email = jwt?.email || profile.email || null;
    const username = jwt?.preferred_username || profile.username || null;
    const userId = jwt?.sub || profile.userId || null;
    const displayName = profile.displayName || username || email || null;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || 86400,
      // `createProviderConnection` only dedups on a non-empty email, so a token
      // without one falls back to a stable synthetic id derived from `sub` —
      // without that, the same account could be imported twice.
      email: email || (userId ? `cb-${userId}` : null),
      name: displayName || (userId ? `cb-${userId.slice(0, 8)}` : null),
      displayName,
      providerSpecificData: {
        userId,
        username,
        ...(profile.organizationId ? { organizationId: profile.organizationId } : {}),
      },
    };
  },
};

export default codebuddyIntl;

import { CODEBUDDY_INTL_CONFIG } from "../constants/oauth.js";
import { decodeJwtPayload } from "../providerHelpers.js";

// 9router has no WorkBuddy provider, and it does not need one: WorkBuddy and
// CodeBuddy are one Keycloak realm and answer the same plugin-auth paths — only
// the host differs. A caller attaching a WorkBuddy account therefore rides this
// provider and names the host its two calls belong on: `?domain=workbuddy.ai`
// on the device-code request and `extraData.domain` on the poll. With no hint
// the config's own host is used, so a CodeBuddy attach is unchanged.
const BRAND_HOST_RE = /(?:^|\.)(?:codebuddy|workbuddy)\.ai$/;

/** The `www.` host a caller asked for, or "" when it isn't one of the brands. */
function brandHost(domain) {
  const d = String(domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!d || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || !BRAND_HOST_RE.test(d)) return "";
  return `www.${d}`;
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
    };
  },
  pollToken: async (config, deviceCode, _codeVerifier, extraData = {}) => {
    const host = brandHost(extraData?.domain);
    const tokenUrl = host ? `https://${host}/v2/plugin/auth/token` : config.tokenUrl;
    const response = await fetch(`${tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": host || "www.codebuddy.ai",
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
      return {
        ok: true,
        data: {
          access_token: data.data.accessToken,
          refresh_token: data.data.refreshToken || "",
          token_type: data.data.tokenType || "Bearer",
          expires_in: data.data.expiresIn,
        },
      };
    }
    if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: false, data: { error: data.msg || "unknown_error" } };
  },
  mapTokens: (tokens) => {
    // The identity lives in the token, not in the request: CodeBuddy answers
    // the device flow with JWTs and no profile object. Reading `sub`/
    // `preferred_username` here is what lets a re-login update the existing
    // row instead of adding another "Account N".
    const jwt = decodeJwtPayload(tokens.access_token) || decodeJwtPayload(tokens.refresh_token);
    const email = jwt?.email || null;
    const username = jwt?.preferred_username || null;
    const userId = jwt?.sub || null;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || 86400,
      // `createProviderConnection` only dedups on a non-empty email, so a token
      // without one falls back to a stable synthetic id derived from `sub`.
      email: email || (userId ? `cb-${userId}` : null),
      name: username || email || (userId ? `cb-${userId.slice(0, 8)}` : null),
      displayName: username || email || null,
      providerSpecificData: {
        userId,
        username,
      },
    };
  },
};

export default codebuddyIntl;

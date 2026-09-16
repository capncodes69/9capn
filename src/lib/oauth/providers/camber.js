import { CAMBER_CONFIG } from "../constants/oauth.js";
import {
  initiateCamberLogin,
  pollCamberLogin,
} from "open-sse/shared/camberAuth.js";

// Camber — browser login (device-flow shaped, NOT OAuth2/PKCE).
//
// The flow mirrors the official CLI exactly:
//   1. POST /api/cli/auth/initiate (empty body) → { session_id }
//   2. the user authorises at https://app.cambercloud.com/auth-cli?session_id=…
//   3. GET /api/cli/auth/poll?session_id=… answers 202 {"data":"pending"} until it
//      returns 200 {"data":{"token":"<base64>"}}
//   4. the base64 blob decodes to { profile: { username, email, token }, teams }
//      and profile.token is the Bearer credential.
//
// There is no user code to type: everything happens on the page the user opens,
// so `user_code` stays empty and OAuthModal hides that block.
const camber = {
  config: CAMBER_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const { sessionId, loginUrl } = await initiateCamberLogin({ config });
    // Shape the rest of OAuthModal expects (device_code, user_code,
    // verification_uri[_complete], interval). verification_uri_complete is the
    // URL actually shown/opened — it already carries the session id.
    return {
      device_code: sessionId,
      user_code: "",
      verification_uri: loginUrl,
      verification_uri_complete: loginUrl,
      expires_in: 900,
      interval: config.pollIntervalSeconds || 5,
    };
  },
  pollToken: async (config, deviceCode) => {
    let result;
    try {
      result = await pollCamberLogin(deviceCode, { config });
    } catch (error) {
      return {
        ok: false,
        data: { error: "poll_failed", error_description: error.message },
      };
    }

    if (result.pending) {
      return { ok: false, data: { error: "authorization_pending" } };
    }

    return {
      ok: true,
      data: {
        access_token: result.apiKey,
        // No refresh token and no expiry: the token is a long-lived API key,
        // exactly like the one `camber login` writes to disk.
        refresh_token: null,
        expires_in: null,
        _camberUsername: result.username,
        _camberEmail: result.email,
        _camberTeams: result.teams,
      },
    };
  },
  mapTokens: (tokens) => {
    const email = (tokens._camberEmail || "").trim() || null;
    const username = (tokens._camberUsername || "").trim() || null;
    return {
      accessToken: tokens.access_token,
      refreshToken: null,
      expiresIn: null,
      // A real email comes back from the login blob, which keeps re-logins
      // deduplicated by createProviderConnection.
      email,
      displayName: username || undefined,
      providerSpecificData: {
        authMethod: "device_code",
        camberUsername: username,
        // Cached only for display; the executor always re-reads /me.
        camberTeams: Array.isArray(tokens._camberTeams) ? tokens._camberTeams : [],
      },
    };
  },
};

export default camber;

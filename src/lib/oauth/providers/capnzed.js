import { CAPNZED_HOSTED_CONFIG } from "../constants/oauth.js";
import {
  createCapnZedNativeAuthData,
  parseCapnZedCallbackPayload,
  decryptCapnZedAccessToken,
  fetchCapnZedUser,
  resolveCapnZedOrganizationId,
  classifyCapnZedUser,
  parseCapnZedPlanInfo,
} from "open-sse/shared/capnzedAuth.js";

// CapnZed — RSA keypair native-app flow (NOT OAuth2).
//
// This is deliberately its own implementation rather than a re-export of the
// upstream `zed` provider: CapnZed's whole purpose is trial farming, so the
// connection is also annotated with the account's plan snapshot at connect time
// (which plan, when the trial window ends, whether it is even eligible). That
// snapshot is what the dashboard shows and what the executor's gate reasons from.
//
// prepareConfig       → fresh RSA keypair + native_app_signin URL
// buildAuthUrl        → that URL
// exchangeToken       → decrypt the RSA-encrypted access_token from the callback
// postExchange        → read /client/users/me, record plan + organization
const capnzed = {
  config: CAPNZED_HOSTED_CONFIG,
  flowType: "authorization_code",
  callbackPath: "/",
  prepareConfig: async (config, meta) => {
    const nativeAppPort = Number(meta?.nativeAppPort) || CAPNZED_HOSTED_CONFIG.defaultNativeAppPort;
    const auth = createCapnZedNativeAuthData(config, { nativeAppPort });
    return { ...config, ...auth };
  },
  buildAuthUrl: (config) => config.authUrl,
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    // code = raw callback URL/query; codeVerifier = encoded RSA private key.
    const { userId, encryptedAccessToken } = parseCapnZedCallbackPayload(code);
    const accessToken = decryptCapnZedAccessToken(encryptedAccessToken, codeVerifier);
    return { accessToken, userId, systemId: config.systemId };
  },
  postExchange: async (tokens) => {
    const credentials = {
      accessToken: tokens.accessToken,
      providerSpecificData: { userId: tokens.userId, systemId: tokens.systemId },
    };

    let userInfo = null;
    let plan = null;
    try {
      userInfo = await fetchCapnZedUser(credentials, { config: CAPNZED_HOSTED_CONFIG });
      plan = classifyCapnZedUser(userInfo);
    } catch {
      /* best-effort: the executor's gate re-reads the plan on first request */
    }

    const organizationId = resolveCapnZedOrganizationId(credentials, userInfo);
    const planInfo = parseCapnZedPlanInfo(userInfo);

    return {
      userInfo,
      organizationId,
      planId: planInfo.planId,
      planLabel: planInfo.planLabel,
      trialEndsAtMs: plan?.lockUntilMs || null,
      eligible: plan ? plan.allowed : null,
      ineligibleReason: plan && !plan.allowed ? plan.reason : null,
      displayName:
        userInfo?.user?.github_login || userInfo?.user?.name || userInfo?.name || null,
    };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.accessToken,
    refreshToken: null,
    expiresIn: null,
    // Zed's /client/users/me does not expose an email, so identify by handle.
    displayName: extra?.displayName || undefined,
    providerSpecificData: {
      authMethod: "oauth",
      userId: tokens.userId,
      systemId: tokens.systemId,
      organizationId: extra?.organizationId || "",
      // Plan snapshot at connect time (display + diagnostics only; the executor
      // always re-checks the live plan before serving).
      capnzedPlan: extra?.planId || null,
      capnzedPlanLabel: extra?.planLabel || null,
      capnzedTrialEndsAt: extra?.trialEndsAtMs
        ? new Date(extra.trialEndsAtMs).toISOString()
        : null,
      capnzedEligible: extra?.eligible ?? null,
      capnzedPlanWarning: extra?.ineligibleReason || null,
    },
  }),
};

export default capnzed;

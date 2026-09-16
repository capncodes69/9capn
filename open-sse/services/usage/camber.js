/**
 * Camber usage — GET https://api-v2.cambercloud.com/api/cli/me
 * Auth: Authorization: Bearer <api-key>
 *
 * What is observable, and what is not
 * ----------------------------------
 * Camber exposes NO quota, credit or balance endpoint. /me returns identity only
 * (user_id, email, username, teams[]), and every other candidate path was probed
 * and 404s — see the header of shared/camberAuth.js for the list. There is also
 * no per-account allowance to draw a progress bar against: the platform meters
 * compute jobs, not chat tokens.
 *
 * So this handler deliberately reports IDENTITY, not a fabricated limit. What it
 * does tell you is which account and which agent a connection is bound to, which
 * is the thing that actually goes wrong in practice (a key pasted from the wrong
 * account, an agent alias that does not exist).
 *
 * Token usage for the requests 9capn itself served is still recorded in the local
 * usage ledger (the `d:` frame carries real prompt/completion counts) — that lives
 * in the request logs, not here.
 */

import { fetchCamberMe, resolveCamberAgent } from "../../shared/camberAuth.js";

/**
 * Pure mapping from the /me payload → dashboard payload.
 * Exported so it can be unit-tested without a live account.
 */
export function parseCamberUsage(me, providerSpecificData = {}) {
  const username = me?.username ? String(me.username) : null;
  const email = me?.email ? String(me.email) : null;
  const teams = Array.isArray(me?.teams) ? me.teams : [];
  const agent = resolveCamberAgent(providerSpecificData);

  const messages = [];
  messages.push(
    "Camber publishes no quota or credit API — this card shows which account and agent the connection is bound to. " +
      "Compute jobs are metered on Camber's own dashboard.",
  );
  if (agent) messages.push(`Agent: ${agent}.`);
  if (teams.length) {
    const selected = teams.find((team) => team?.is_selected) || null;
    messages.push(
      selected?.team_name
        ? `Selected team: ${selected.team_name}.`
        : `${teams.length} team${teams.length === 1 ? "" : "s"} available.`,
    );
  }

  return {
    plan: "Camber",
    quotas: {},
    message: messages.join(" "),
    identity: {
      userId: me?.user_id || null,
      username,
      email,
      teamCount: teams.length,
    },
  };
}

/**
 * @param {string|null|undefined} accessToken
 * @param {object|null|undefined} providerSpecificData
 * @param {object|null|undefined} proxyOptions
 */
export async function getCamberUsage(
  accessToken = null,
  providerSpecificData = {},
  proxyOptions = null,
  apiKey = null,
) {
  const token = apiKey || accessToken;
  if (!token || typeof token !== "string" || !token.trim()) {
    return { message: "Camber API key not available. Re-connect the account to view account details." };
  }

  try {
    const me = await fetchCamberMe(
      { apiKey: token.trim(), accessToken: token.trim() },
      { proxyOptions },
    );
    return parseCamberUsage(me, providerSpecificData);
  } catch (error) {
    const status = error?.status;
    if (status === 401 || status === 403) {
      return { message: "Camber rejected the API key. Re-connect the account." };
    }
    return { message: `Camber error: ${error.message || "Failed to read the account"}` };
  }
}

/**
 * CapnZed usage — GET https://cloud.zed.dev/client/users/me
 * Auth: Authorization: {user_id} {access_token}
 *
 * What is observable, and what is not
 * ----------------------------------
 * Zed meters the Pro trial as "$5 of GPT Luna ... for 14 days from trial start"
 * and enforces it server-side against the account's organization. There is NO
 * balance or remaining-credit endpoint anywhere in the Zed client
 * (crates/cloud_api_client has only /client/users/me, /client/llm_tokens,
 * /client/system_settings and the feedback endpoints), and PlanInfo.usage only
 * covers edit predictions. So we can show the plan and the trial WINDOW, and we
 * learn about spend only when a completion returns HTTP 402 — at which point the
 * executor parks the account until the window closes.
 */

import {
  fetchCapnZedUser,
  parseCapnZedPlanInfo,
  classifyCapnZedUser,
  CAPNZED_TRIAL_DAYS,
  CAPNZED_TRIAL_CREDIT_USD,
} from "../../shared/capnzedAuth.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Map plan_v3 ids to dashboard labels. */
export function formatCapnZedPlanLabel(rawPlan) {
  const raw = String(rawPlan || "").trim();
  if (!raw) return "CapnZed";
  switch (raw.toLowerCase()) {
    case "zed_free":
      return "Zed Free";
    case "zed_pro":
      return "Zed Pro";
    case "zed_pro_trial":
      return "Zed Pro Trial";
    case "zed_student":
      return "Zed Student";
    case "zed_business":
      return "Zed Business";
    case "zed_vip":
      return "Zed VIP";
    default:
      return raw
        .replace(/_/g, " ")
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");
  }
}

function parseUsageLimit(limit) {
  if (limit == null) return { unlimited: false, total: 0 };
  if (limit === "unlimited" || limit?.unlimited === true) return { unlimited: true, total: 0 };
  if (typeof limit === "number" && Number.isFinite(limit)) {
    return { unlimited: false, total: Math.max(0, limit) };
  }
  if (typeof limit === "string") {
    const trimmed = limit.trim();
    if (trimmed === "unlimited") return { unlimited: true, total: 0 };
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return { unlimited: false, total: Math.max(0, parsed) };
  }
  const limited = limit.limited ?? limit.Limited;
  if (typeof limited === "number" && Number.isFinite(limited)) {
    return { unlimited: false, total: Math.max(0, limited) };
  }
  return { unlimited: false, total: 0 };
}

/**
 * Pure mapping from /client/users/me JSON → dashboard payload.
 * Exported so it can be unit-tested without a live account.
 */
export function parseCapnZedUsage(userInfo, now = Date.now()) {
  const planInfo = parseCapnZedPlanInfo(userInfo);
  const verdict = classifyCapnZedUser(userInfo, now);

  const quotas = {};
  const usage = userInfo?.plan?.usage || {};

  const editPredictions = usage.edit_predictions || usage.editPredictions;
  if (editPredictions) {
    const limitInfo = parseUsageLimit(editPredictions.limit);
    const used = Math.max(0, toFiniteNumber(editPredictions.used, 0));
    quotas["Edit Predictions"] = limitInfo.unlimited
      ? { used, total: 0, remainingPercentage: 100, resetAt: null, unlimited: true }
      : {
          used,
          total: limitInfo.total,
          remainingPercentage:
            limitInfo.total > 0
              ? (Math.max(0, limitInfo.total - Math.min(used, limitInfo.total)) / limitInfo.total) * 100
              : 0,
          resetAt: null,
          unlimited: false,
        };
  }

  // Trial window progress. We cannot see the $ balance, so the honest signal is
  // elapsed time against the documented trial length.
  const startedAtMs = planInfo.trialStartedAtMs;
  let trialEndsAtMs = planInfo.periodEndedAtMs;
  if (!trialEndsAtMs && startedAtMs) trialEndsAtMs = startedAtMs + CAPNZED_TRIAL_DAYS * DAY_MS;

  if (startedAtMs && trialEndsAtMs) {
    const total = Math.max(1, trialEndsAtMs - startedAtMs);
    const elapsed = Math.min(Math.max(now - startedAtMs, 0), total);
    quotas["Trial Window"] = {
      used: Math.round(elapsed / DAY_MS),
      total: Math.round(total / DAY_MS),
      remainingPercentage: Math.max(0, ((total - elapsed) / total) * 100),
      resetAt: new Date(trialEndsAtMs).toISOString(),
      unlimited: false,
    };
  }

  const messages = [];
  if (verdict.allowed) {
    messages.push(
      `Zed meters this trial as $${CAPNZED_TRIAL_CREDIT_USD} of hosted-model spend over ` +
        `${CAPNZED_TRIAL_DAYS} days. The remaining credit is only visible server-side, so an account is ` +
        "parked automatically on the first HTTP 402.",
    );
  } else {
    messages.push(verdict.reason);
  }
  if (planInfo.accountTooYoung) messages.push("Zed flags this account as too new for hosted models.");
  if (planInfo.hasOverdueInvoices) messages.push("Zed reports overdue invoices for this account.");

  return {
    plan: formatCapnZedPlanLabel(planInfo.planId),
    quotas,
    message: messages.filter(Boolean).join(" "),
    eligible: verdict.allowed,
    planId: planInfo.planId,
    trialStartedAtMs: startedAtMs,
    trialEndsAtMs,
    periodStartedAtMs: planInfo.periodStartedAtMs,
    lockedUntilMs: verdict.allowed ? null : verdict.lockUntilMs,
    resetAt: parseResetTime(
      planInfo.periodEndedAtMs ? new Date(planInfo.periodEndedAtMs).toISOString() : null,
    ),
  };
}

/**
 * @param {string|null|undefined} accessToken
 * @param {object|null|undefined} providerSpecificData
 * @param {object|null|undefined} proxyOptions
 */
export async function getCapnZedUsage(
  accessToken = null,
  providerSpecificData = {},
  proxyOptions = null,
) {
  const psd = providerSpecificData || {};
  if (!psd.userId) {
    return { message: "CapnZed credential is missing its Zed user id. Re-connect the account." };
  }
  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    return { message: "CapnZed access token not available. Re-connect the account to view quota." };
  }

  const credentials = { accessToken: accessToken.trim(), providerSpecificData: psd };

  try {
    const userInfo = await fetchCapnZedUser(credentials, { proxyOptions });
    return parseCapnZedUsage(userInfo);
  } catch (error) {
    const status = error?.status;
    if (status === 401 || status === 403) {
      return { message: "CapnZed authentication failed. Sign in again from the dashboard." };
    }
    return { message: `CapnZed error: ${error.message || "Failed to fetch quota"}` };
  }
}

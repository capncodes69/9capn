/**
 * Camber usage — GET https://api-v2.cambercloud.com/api/cli/me
 * Auth: Authorization: Bearer <api-key>
 *
 * What is observable, and what is not
 * ----------------------------------
 * Camber DOES meter usage — the web app renders four resources
 * (`cpu_seconds`, `gpu_seconds`, `llm_messages`, `storage_gb`, ids read from the
 * `personal-usage` bundle) and the pricing page documents per-plan grants. The
 * problem is the credential:
 *
 *   GET https://api-v2.cambercloud.com/api/credit-usage/me   ← the real numbers
 *   → 401 "unauthorized - invalid token" with a CLI API key, or with no token
 *
 * That endpoint is scoped to the web session. Both credentials a 9capn
 * connection can hold (a pasted API key, and the one the browser login issues)
 * are CLI-scoped, and `/api/cli/me` below returns identity only — no plan, no
 * quota, no balance. So the only honest number this card can own is 9capn's own
 * tally: ONE REQUEST SERVED = ONE LLM MESSAGE, which is how Camber counts them
 * too. That count is folded in by the usage route (see `applyCamberMessageCount`)
 * from the local ledger, and it is labelled as a local count everywhere it
 * appears — never presented as Camber's number.
 *
 * The limit is deliberately a per-connection choice (`camberPlan`, or an
 * explicit `camberMessageLimit`) rather than a hardcoded table, because grants
 * differ from the public pricing rows: a Pro *trial* was observed with 500
 * messages, where paid Pro publishes 200. With no limit configured the card
 * reports the count as text and names the options instead of drawing a bar
 * against a denominator nobody verified.
 */

import { fetchCamberMe, resolveCamberAgent } from "../../shared/camberAuth.js";
import { CAMBER_PLAN_LIMITS, CAMBER_WEB_USAGE_URL } from "../../shared/camberCatalog.js";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Env fallback so an operator can set the grant once for every connection. */
export const CAMBER_MESSAGE_LIMIT_ENV = "CAMBER_LLM_MESSAGE_LIMIT";

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Resolve the monthly LLM-message grant for a connection.
 * Precedence: explicit number → named plan → env → unknown (null).
 */
export function resolveCamberMessageLimit(providerSpecificData = {}, env = process.env) {
  const explicit = toPositiveInt(providerSpecificData?.camberMessageLimit);
  if (explicit) return explicit;

  const planKey = String(providerSpecificData?.camberPlan || "").trim().toLowerCase();
  const plan = CAMBER_PLAN_LIMITS[planKey];
  if (plan) return plan.llmMessages;

  return toPositiveInt(env?.[CAMBER_MESSAGE_LIMIT_ENV]);
}

/** Human label for the configured plan, for the card header. */
export function resolveCamberPlanLabel(providerSpecificData = {}) {
  const planKey = String(providerSpecificData?.camberPlan || "").trim().toLowerCase();
  const plan = CAMBER_PLAN_LIMITS[planKey];
  if (plan) return plan.label;
  return toPositiveInt(providerSpecificData?.camberMessageLimit) ? "Custom limit" : null;
}

/**
 * The window the local count covers. Camber's card is titled "usage this month",
 * so a calendar month (UTC) is the default; `camberPeriodStart` overrides it for
 * a trial, whose 14 days do not line up with the month.
 */
export function resolveCamberUsageWindow(providerSpecificData = {}, now = Date.now()) {
  const raw = providerSpecificData?.camberPeriodStart;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Date.parse(raw) : NaN;
  if (Number.isFinite(parsed)) {
    const d = new Date(parsed);
    return {
      startMs: parsed,
      label: `since ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      // A pinned start is typically a trial: it does not refill monthly.
      recurring: false,
    };
  }
  const nowDate = new Date(now);
  return {
    startMs: Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1),
    label: "this month",
    recurring: true,
  };
}

/** First instant of the next calendar month (UTC) — when a monthly grant resets. */
export function nextMonthStartMs(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Pure mapping from the /me payload → dashboard payload.
 * Exported so it can be unit-tested without a live account.
 *
 * No quota rows are produced here: the server side has none to give. The rows
 * come from `applyCamberMessageCount`, which the route feeds the local tally.
 * `messageLimit`/`windowStartMs`/`windowLabel` are carried forward for it.
 */
export function parseCamberUsage(me, providerSpecificData = {}, now = Date.now()) {
  const username = me?.username ? String(me.username) : null;
  const email = me?.email ? String(me.email) : null;
  const teams = Array.isArray(me?.teams) ? me.teams : [];
  const agent = resolveCamberAgent(providerSpecificData);
  const planLabel = resolveCamberPlanLabel(providerSpecificData);
  const window = resolveCamberUsageWindow(providerSpecificData, now);

  const messages = [];
  messages.push(
    "Camber's usage API (cpu_seconds / gpu_seconds / llm_messages / storage_gb) is scoped to the web " +
      "session, so a CLI key cannot read it — see the real meter at " +
      `${CAMBER_WEB_USAGE_URL} .`,
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
    plan: planLabel ? `Camber · ${planLabel}` : "Camber",
    quotas: {},
    message: messages.join(" "),
    identity: {
      userId: me?.user_id || null,
      username,
      email,
      teamCount: teams.length,
    },
    // Consumed by applyCamberMessageCount (route merges the ledger count in).
    messageLimit: resolveCamberMessageLimit(providerSpecificData),
    windowStartMs: window.startMs,
    windowLabel: window.label,
    windowRecurring: window.recurring,
  };
}

/**
 * Fold 9capn's own request count into the card.
 *
 * One request served = one LLM message (Camber's own unit). With a limit
 * configured the count becomes a row with a bar; without one it stays a note,
 * because a bar needs a denominator we did not verify.
 */
export function applyCamberMessageCount(usage, { requests = 0, now = Date.now() } = {}) {
  if (!usage || typeof usage !== "object") return usage;
  // A refusal/error payload carries only a message — nothing to meter.
  if (!usage.quotas || typeof usage.quotas !== "object") return usage;

  const count = Math.max(0, Math.round(Number(requests) || 0));
  const limit = toPositiveInt(usage.messageLimit);
  const where = usage.windowLabel || "this period";
  const quotas = { ...usage.quotas };
  const notes = [];

  if (limit) {
    const remaining = Math.max(0, limit - Math.min(count, limit));
    quotas["LLM messages"] = {
      used: count,
      total: limit,
      remainingPercentage: (remaining / limit) * 100,
      // A monthly grant refills; a pinned trial window does not.
      recurring: usage.windowRecurring !== false,
      resetAt: usage.windowRecurring === false ? null : new Date(nextMonthStartMs(now)).toISOString(),
      unlimited: false,
    };
    notes.push(
      `Local count: ${count} of ${limit} LLM messages ${where} (9capn's own tally — Camber's meter is authoritative).`,
    );
    if (count > limit) {
      notes.push(
        `That is past the ${limit}-message grant: Camber refuses further messages until the window resets, or the plan is raised.`,
      );
    }
  } else {
    notes.push(
      `Local count: ${count} LLM message${count === 1 ? "" : "s"} ${where} ` +
        "(9capn's own tally; message count only appends rows when a limit is configured).",
    );
    notes.push(
      "Set a plan (Student 50 / Pro 200 / Teams 500 messages a month) or an explicit limit on the " +
        "connection to turn this into a progress bar.",
    );
  }

  return {
    ...usage,
    quotas,
    message: [usage.message, ...notes].filter(Boolean).join(" "),
  };
}

/**
 * @param {string|null|undefined} accessToken
 * @param {object|null|undefined} providerSpecificData
 * @param {object|null|undefined} proxyOptions
 * @param {string|null|undefined} apiKey
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

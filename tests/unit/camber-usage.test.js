import { describe, it, expect } from "vitest";

import {
  CAMBER_MESSAGE_LIMIT_ENV,
  applyCamberMessageCount,
  nextMonthStartMs,
  parseCamberUsage,
  resolveCamberMessageLimit,
  resolveCamberPlanLabel,
  resolveCamberUsageWindow,
} from "../../open-sse/services/usage/camber.js";
import { CAMBER_PLAN_LIMITS, CAMBER_WEB_USAGE_URL } from "../../open-sse/shared/camberCatalog.js";

const ME = {
  user_id: "8c9e7050-8698-49df-9db6-c7b432968585",
  username: "reze",
  email: "thomaswilkerson4986@gmail.com",
  teams: [
    { team_id: "a", team_name: "Habiba Default Team", is_default: true, is_selected: false },
    { team_id: "b", team_name: "reze", is_default: false, is_selected: true },
  ],
};

describe("resolveCamberMessageLimit", () => {
  it("lets an explicit limit win over the plan", () => {
    expect(resolveCamberMessageLimit({ camberPlan: "pro", camberMessageLimit: 500 }, {})).toBe(500);
  });

  it("maps the published plan grants", () => {
    expect(resolveCamberMessageLimit({ camberPlan: "student" }, {})).toBe(50);
    expect(resolveCamberMessageLimit({ camberPlan: "pro" }, {})).toBe(200);
    expect(resolveCamberMessageLimit({ camberPlan: "teams" }, {})).toBe(500);
    // Case/space tolerant: the value round-trips through a form.
    expect(resolveCamberMessageLimit({ camberPlan: " Teams " }, {})).toBe(500);
  });

  it("falls back to the env grant", () => {
    expect(resolveCamberMessageLimit({}, { [CAMBER_MESSAGE_LIMIT_ENV]: "750" })).toBe(750);
    // The env value is a fallback, not an override of a chosen plan.
    expect(
      resolveCamberMessageLimit({ camberPlan: "pro" }, { [CAMBER_MESSAGE_LIMIT_ENV]: "750" }),
    ).toBe(200);
  });

  it("returns null when nothing is configured — no invented denominator", () => {
    expect(resolveCamberMessageLimit({}, {})).toBeNull();
    expect(resolveCamberMessageLimit({ camberPlan: "enterprise-unknown" }, {})).toBeNull();
    expect(resolveCamberMessageLimit({ camberMessageLimit: "abc" }, {})).toBeNull();
    expect(resolveCamberMessageLimit({ camberMessageLimit: 0 }, {})).toBeNull();
    expect(resolveCamberMessageLimit({ camberMessageLimit: -5 }, {})).toBeNull();
    expect(resolveCamberMessageLimit({}, { [CAMBER_MESSAGE_LIMIT_ENV]: "0" })).toBeNull();
  });

  it("labels the plan, and a bare limit as custom", () => {
    expect(resolveCamberPlanLabel({ camberPlan: "teams" })).toBe("Teams");
    expect(resolveCamberPlanLabel({ camberMessageLimit: 500 })).toBe("Custom limit");
    expect(resolveCamberPlanLabel({})).toBeNull();
  });
});

describe("resolveCamberUsageWindow", () => {
  it("defaults to the current calendar month, and says it refills", () => {
    const now = Date.UTC(2026, 8, 16, 3, 4, 5); // 16 Sep 2026
    const window = resolveCamberUsageWindow({}, now);
    expect(window.startMs).toBe(Date.UTC(2026, 8, 1));
    expect(window.label).toBe("this month");
    expect(window.recurring).toBe(true);
  });

  it("honours a pinned period start (a trial does not line up with the month)", () => {
    const window = resolveCamberUsageWindow({ camberPeriodStart: "2026-09-03" });
    expect(window.startMs).toBe(Date.parse("2026-09-03"));
    expect(window.label).toBe("since 3 Sep 2026");
    expect(window.recurring).toBe(false);
  });

  it("ignores an unparsable period start instead of counting from epoch", () => {
    const now = Date.UTC(2026, 8, 16);
    expect(resolveCamberUsageWindow({ camberPeriodStart: "last tuesday" }, now).startMs).toBe(
      Date.UTC(2026, 8, 1),
    );
  });

  it("knows when a monthly grant resets", () => {
    expect(nextMonthStartMs(Date.UTC(2026, 8, 16))).toBe(Date.UTC(2026, 9, 1));
    // December rolls the year over.
    expect(nextMonthStartMs(Date.UTC(2026, 11, 31))).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("parseCamberUsage — identity only, no invented quota", () => {
  it("reports the account, the selected team and the pinned agent", () => {
    const usage = parseCamberUsage(ME, { camberAgent: "@reze.my_agent" });
    expect(usage.identity).toEqual({
      userId: "8c9e7050-8698-49df-9db6-c7b432968585",
      username: "reze",
      email: "thomaswilkerson4986@gmail.com",
      teamCount: 2,
    });
    expect(usage.message).toContain("Agent: reze.my_agent");
    expect(usage.message).toContain("Selected team: reze");
  });

  it("says where the real meter lives instead of claiming none exists", () => {
    const usage = parseCamberUsage(ME, {});
    // Camber DOES meter usage; the point is that a CLI key cannot read it.
    expect(usage.message).toContain(CAMBER_WEB_USAGE_URL);
    expect(usage.message).toMatch(/scoped to the web\s+session/i);
    expect(usage.message).toContain("llm_messages");
  });

  it("produces no server-side quota rows", () => {
    expect(parseCamberUsage(ME, {}).quotas).toEqual({});
  });

  it("carries the meter config forward for the route to merge the count into", () => {
    const now = Date.UTC(2026, 8, 16);
    const usage = parseCamberUsage(ME, { camberPlan: "pro" }, now);
    expect(usage.plan).toBe("Camber · Pro");
    expect(usage.messageLimit).toBe(200);
    expect(usage.windowStartMs).toBe(Date.UTC(2026, 8, 1));
    expect(usage.windowLabel).toBe("this month");
    expect(usage.windowRecurring).toBe(true);
  });
});

describe("applyCamberMessageCount — one request is one LLM message", () => {
  const base = () => parseCamberUsage(ME, { camberPlan: "teams" }, Date.UTC(2026, 8, 16));

  it("turns the local count into a row with a bar when a limit exists", () => {
    const merged = applyCamberMessageCount(base(), { requests: 125, now: Date.UTC(2026, 8, 16) });
    const row = merged.quotas["LLM messages"];

    expect(row.used).toBe(125);
    expect(row.total).toBe(500);
    expect(row.remainingPercentage).toBeCloseTo(75, 5);
    // A monthly grant refills, so the UI should word resetAt as "resets in".
    expect(row.recurring).toBe(true);
    expect(row.resetAt).toBe(new Date(Date.UTC(2026, 9, 1)).toISOString());
    expect(merged.message).toContain("Local count: 125 of 500 LLM messages this month");
    expect(merged.message).toMatch(/9capn's own tally/);
  });

  it("never presents the local tally as Camber's own number", () => {
    const merged = applyCamberMessageCount(base(), { requests: 3 });
    expect(merged.message).toMatch(/Camber's meter is authoritative/);
  });

  it("clamps at zero and warns once the grant is used up", () => {
    const over = applyCamberMessageCount(base(), { requests: 620 });
    expect(over.quotas["LLM messages"].remainingPercentage).toBe(0);
    expect(over.quotas["LLM messages"].used).toBe(620);
    expect(over.message).toMatch(/past the 500-message grant/);

    const exact = applyCamberMessageCount(base(), { requests: 500 });
    expect(exact.quotas["LLM messages"].remainingPercentage).toBe(0);
    // Spending the grant exactly is not "past" it.
    expect(exact.message).not.toMatch(/past the/);
  });

  it("keeps a pinned trial window from claiming a monthly reset", () => {
    const trial = parseCamberUsage(ME, { camberPlan: "teams", camberPeriodStart: "2026-09-03" });
    const merged = applyCamberMessageCount(trial, { requests: 10, now: Date.UTC(2026, 8, 16) });
    expect(merged.quotas["LLM messages"].recurring).toBe(false);
    expect(merged.quotas["LLM messages"].resetAt).toBeNull();
    expect(merged.message).toContain("since 3 Sep 2026");
  });

  it("reports the count as text and names the options when no limit is set", () => {
    const noPlan = parseCamberUsage(ME, {}, Date.UTC(2026, 8, 16));
    const merged = applyCamberMessageCount(noPlan, { requests: 7 });

    // No denominator was verified, so there is no bar to draw.
    expect(merged.quotas).toEqual({});
    expect(merged.message).toContain("Local count: 7 LLM messages this month");
    expect(merged.message).toMatch(/Student 50 \/ Pro 200 \/ Teams 500/);
  });

  it("handles the empty case without pretending a request happened", () => {
    const merged = applyCamberMessageCount(base(), { requests: 0 });
    expect(merged.quotas["LLM messages"].used).toBe(0);
    expect(merged.quotas["LLM messages"].remainingPercentage).toBe(100);
  });

  it("leaves a refusal payload alone (message only, nothing to meter)", () => {
    const refusal = { message: "Camber rejected the API key. Re-connect the account." };
    expect(applyCamberMessageCount(refusal, { requests: 9 })).toBe(refusal);
    expect(applyCamberMessageCount(null, { requests: 9 })).toBeNull();
  });

  it("the published plan table stays ordered Student < Pro < Teams", () => {
    const grants = [
      CAMBER_PLAN_LIMITS.student.llmMessages,
      CAMBER_PLAN_LIMITS.pro.llmMessages,
      CAMBER_PLAN_LIMITS.teams.llmMessages,
    ];
    expect(grants).toEqual([...grants].sort((a, b) => a - b));
  });
});

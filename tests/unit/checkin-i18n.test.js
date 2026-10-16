/**
 * Guards that "user-facing strings must be English".
 *
 * ## Why this case exists
 *
 * Runtime i18n looks up **by English source text** (`src/i18n/runtime.js`:
 * `translationMap[English]` → translation). Therefore any Chinese source text that
 * reaches the UI is **never translated** and stays verbatim in the English UI.
 *
 * The first version hit this pitfall in practice: the dashboard showed
 * "Last: 已签到 7" and an entire Chinese hint (see the note in docs/checkin-feature.md).
 * Manual acceptance testing easily misses this kind of mixed output.
 *
 * ## Rules
 *
 * - **String literals in code**: must be English (they flow into HTTP responses / state files / UI).
 * - **Comments**: Chinese is allowed (for maintainers; not rendered).
 * - **Arguments to `logLine(...)`**: Chinese is allowed — those only write to
 *   `process.stdout` (docker logs) and the reader is an operator.
 *
 * The scanner is in `tests/helpers/check-user-facing-strings.mjs` (a hand-written
 * state machine rather than a regex: a regex cannot tell `//` inside a string from a
 * real comment and gives confident but wrong results).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const checker = join(here, "..", "helpers", "check-user-facing-strings.mjs");

const FILES = [
  "src/shared/services/checkinProviders.js",
  "src/shared/services/checkinScheduler.js",
  "src/app/api/checkin/route.js",
  "src/app/(dashboard)/dashboard/checkin/CheckinClient.js",
].map((f) => join(repoRoot, f));

test("all user-facing check-in strings are English (Chinese is allowed only in comments and logLine)", () => {
  let out = "";
  let ok = true;
  try {
    out = execFileSync(process.execPath, [checker, ...FILES], { encoding: "utf8" });
  } catch (e) {
    ok = false;
    out = (e.stdout || "") + (e.stderr || "");
  }
  assert.equal(
    ok,
    true,
    `Found user-facing Chinese strings (i18n only translates English source text):\n${out}`
  );
});

test("describeOutcome never returns Chinese (an upstream echo must go through detail, not into the displayed text)", async () => {
  const { describeOutcome } = await import("../../src/shared/services/checkinProviders.js");
  const CJK = /[\u4e00-\u9fff]/;
  // An upstream returning a Chinese msg is the easiest path for Chinese to leak into the UI (both codebuddy and minimax do this).
  const cases = [
    { kind: "claimed", credit: 100, message: "今天已签到" },
    { kind: "already-claimed", message: "今天已签到，请明天再来" },
    { kind: "inactive", message: "无资格" },
    { kind: "failed", code: 1, message: "领取失败" },
    { kind: "unknown-future-kind", message: "新情况" },
    null,
    {},
  ];
  for (const c of cases) {
    const text = describeOutcome(c);
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, CJK, `describeOutcome(${JSON.stringify(c)}) contains Chinese: ${text}`);
  }
});

import { describe, expect, it } from "vitest";
import { isQueueProgressing } from "../../open-sse/shared/qoder/queue.js";

describe("qoder queue progress", () => {
  it("treats a shrinking queue as progress", () => {
    expect(isQueueProgressing({ queueCount: 5 }, { queueCount: 2 })).toBe(true);
  });

  it("treats a falling waitTime as progress", () => {
    expect(isQueueProgressing({ waitTime: 120 }, { waitTime: 30 })).toBe(true);
  });

  it("treats a changed queueType as progress", () => {
    expect(isQueueProgressing({ queueType: "p3" }, { queueType: "p1" })).toBe(true);
  });

  it("treats an identical snapshot as no progress", () => {
    expect(
      isQueueProgressing({ queueCount: 0, waitTime: 30 }, { queueCount: 0, waitTime: 30 }),
    ).toBe(false);
  });

  it("treats a missing previous snapshot as progress (first poll)", () => {
    expect(isQueueProgressing(null, { queueCount: 0, waitTime: 30 })).toBe(true);
  });
});

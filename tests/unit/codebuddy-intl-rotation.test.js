// The 310-account pool is sorted by priority ascending and used in order, so the lowest
// priority accounts are drained first and die. Measured on the live instance: the three
// banned accounts had 6/13/14 model locks and were 56-62 days old, while the only healthy
// accounts were 0-3 hours old and untouched. Rotation, not credentials, is what burns them.
import { describe, it, expect } from "vitest";
import { pickNextConnection, shouldSkipForBackoff } from "@/lib/db/repos/connectionsRepo.js";

const conn = (over = {}) => ({
  id: "c1", provider: "codebuddy-intl", authType: "oauth", isActive: true,
  priority: 1, backoffLevel: 0, consecutiveUseCount: 0, ...over,
});

describe("backoff gate", () => {
  it("skips a connection at the maximum backoff level", () => {
    expect(shouldSkipForBackoff(conn({ backoffLevel: 15 }))).toBe(true);
  });
  it("allows a connection with no backoff", () => {
    expect(shouldSkipForBackoff(conn({ backoffLevel: 0 }))).toBe(false);
  });
  it("skips an inactive connection", () => {
    expect(shouldSkipForBackoff(conn({ isActive: false }))).toBe(true);
  });
  it("treats a missing connection as skippable", () => {
    expect(shouldSkipForBackoff(null)).toBe(true);
  });
});

describe("rotation", () => {
  it("prefers the least-recently-used connection over the lowest priority", () => {
    const a = conn({ id: "a", priority: 1, consecutiveUseCount: 9, lastUsedAt: "2026-10-27T20:00:00Z" });
    const b = conn({ id: "b", priority: 50, consecutiveUseCount: 0, lastUsedAt: "2026-10-01T00:00:00Z" });
    expect(pickNextConnection([a, b]).id).toBe("b");
  });

  it("never picks a connection that is in backoff", () => {
    const hot = conn({ id: "hot", priority: 1, backoffLevel: 15 });
    const cold = conn({ id: "cold", priority: 9, backoffLevel: 0 });
    expect(pickNextConnection([hot, cold]).id).toBe("cold");
  });

  it("returns null when every connection is skipped", () => {
    expect(pickNextConnection([conn({ backoffLevel: 15 }), conn({ isActive: false })])).toBe(null);
  });

  it("treats a never-used connection as the oldest", () => {
    const never = conn({ id: "never", priority: 99 });
    const used = conn({ id: "used", priority: 1, lastUsedAt: "2026-10-27T20:00:00Z" });
    expect(pickNextConnection([used, never]).id).toBe("never");
  });
});

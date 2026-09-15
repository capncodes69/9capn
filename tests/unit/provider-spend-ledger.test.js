// getProviderSpend is the ledger read behind CapnZed's trial meter: it must sum
// only the provider's own rows, only this connection's, and only inside the
// window it is given. Runs against a real (temp) SQLite DB because the SQL is
// the thing under test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provider-spend-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// gpt-5.6-luna is priced 1.00 in / 6.00 out per 1M tokens → exactly $7.00 per row.
const MILLION = 1_000_000;
const TOKENS = { prompt_tokens: MILLION, completion_tokens: MILLION };
const ROW_COST = 7;

describe("getProviderSpend", () => {
  beforeAll(async () => {
    await db.saveRequestUsage({
      provider: "capnzed",
      model: "gpt-5.6-luna",
      connectionId: "conn-a",
      timestamp: "2026-09-11T00:00:00.000Z",
      tokens: TOKENS,
    });
    await db.saveRequestUsage({
      provider: "capnzed",
      model: "gpt-5.6-luna",
      connectionId: "conn-a",
      timestamp: "2026-09-01T00:00:00.000Z", // before the trial window
      tokens: TOKENS,
    });
    await db.saveRequestUsage({
      provider: "capnzed",
      model: "gpt-5.6-luna",
      connectionId: "conn-b", // a second account on the same provider
      timestamp: "2026-09-12T00:00:00.000Z",
      tokens: TOKENS,
    });
    await db.saveRequestUsage({
      provider: "zed", // upstream provider, must never be counted
      model: "gpt-5.6-luna",
      connectionId: "conn-a",
      timestamp: "2026-09-12T00:00:00.000Z",
      tokens: TOKENS,
    });
  });

  it("prices each row from the local pricing table", async () => {
    const spend = await db.getProviderSpend({ provider: "capnzed" });
    expect(spend.requests).toBe(3);
    expect(spend.costUsd).toBeCloseTo(3 * ROW_COST, 6);
  });

  it("scopes to one connection", async () => {
    const spend = await db.getProviderSpend({ provider: "capnzed", connectionId: "conn-a" });
    expect(spend.requests).toBe(2);
    expect(spend.costUsd).toBeCloseTo(2 * ROW_COST, 6);
  });

  it("scopes to the window and reports its bounds", async () => {
    const spend = await db.getProviderSpend({
      provider: "capnzed",
      connectionId: "conn-a",
      since: "2026-09-10T00:00:00.000Z",
    });

    expect(spend.requests).toBe(1);
    expect(spend.costUsd).toBeCloseTo(ROW_COST, 6);
    expect(spend.firstAt).toBe("2026-09-11T00:00:00.000Z");
    expect(spend.lastAt).toBe("2026-09-11T00:00:00.000Z");
  });

  it("returns zeros instead of throwing when there is nothing to sum", async () => {
    const spend = await db.getProviderSpend({ provider: "nope", connectionId: "conn-a" });
    expect(spend).toEqual({ costUsd: 0, requests: 0, firstAt: null, lastAt: null });

    expect(await db.getProviderSpend({})).toEqual({
      costUsd: 0,
      requests: 0,
      firstAt: null,
      lastAt: null,
    });
  });
});

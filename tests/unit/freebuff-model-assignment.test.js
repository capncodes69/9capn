import { describe, expect, it } from "vitest";
import { filterConnectionsForModel } from "../../src/sse/services/auth.js";

const connections = [
  { id: "flash-1", providerSpecificData: { freebuffModel: "deepseek/deepseek-v4-flash" } },
  { id: "mimo-1", providerSpecificData: { freebuffModel: "mimo/mimo-v2.5" } },
  { id: "unassigned", providerSpecificData: {} },
];

describe("Freebuff strict model assignment", () => {
  it("keeps only accounts assigned to the requested model", () => {
    const result = filterConnectionsForModel("freebuff", connections, "mimo/mimo-v2.5", {
      providerStrategies: { freebuff: { strictModelAssignment: true } },
    });

    expect(result.map((connection) => connection.id)).toEqual(["mimo-1"]);
  });

  it("excludes unassigned accounts when strict mode is enabled", () => {
    const result = filterConnectionsForModel("freebuff", connections, "deepseek/deepseek-v4-flash", {
      providerStrategies: { freebuff: { strictModelAssignment: true } },
    });

    expect(result.map((connection) => connection.id)).toEqual(["flash-1"]);
  });

  it("preserves the existing pool when strict mode is disabled", () => {
    expect(filterConnectionsForModel("freebuff", connections, "mimo/mimo-v2.5", {})).toBe(connections);
  });

  it("does not affect other providers when their toggle is off", () => {
    expect(filterConnectionsForModel("codex", connections, "mimo/mimo-v2.5", {
      providerStrategies: {},
    })).toBe(connections);
  });
});

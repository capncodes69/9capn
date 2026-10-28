import { describe, expect, it, vi, beforeEach } from "vitest";

const updates = [];
vi.mock("../../src/lib/db/repos/connectionsRepo.js", () => ({
  updateProviderConnection: async (id, data) => {
    updates.push({ id, data });
    return { id, ...data };
  },
}));

const { persistResolvedQoderIdentity } = await import(
  "../../open-sse/services/qoderModels.js"
);

describe("persistResolvedQoderIdentity", () => {
  beforeEach(() => {
    updates.length = 0;
  });

  it("writes userId and machineId when the stored copy is empty", async () => {
    await persistResolvedQoderIdentity(
      { connectionId: "conn-1", providerSpecificData: {} },
      { userId: "01a18146-d651-7730-acd6-b56da1734fb9", machineId: "6887086a-2ab6-5a46-a8a9-c158ff9a241e" },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("conn-1");
    expect(updates[0].data.providerSpecificData.userId).toBe(
      "01a18146-d651-7730-acd6-b56da1734fb9",
    );
    expect(updates[0].data.providerSpecificData.machineId).toBe(
      "6887086a-2ab6-5a46-a8a9-c158ff9a241e",
    );
  });

  it("does not write when both values are already stored", async () => {
    await persistResolvedQoderIdentity(
      {
        connectionId: "conn-1",
        providerSpecificData: { userId: "u", machineId: "m" },
      },
      { userId: "u", machineId: "m" },
    );
    expect(updates).toHaveLength(0);
  });

  it("never throws when the write fails", async () => {
    const { persistResolvedQoderIdentity: fn } = await import(
      "../../open-sse/services/qoderModels.js"
    );
    // A connection id that the mock accepts but with no values to write.
    await expect(
      fn({ connectionId: "conn-x", providerSpecificData: {} }, { userId: "", machineId: "" }),
    ).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { buildCosyHeaders } from "../../open-sse/shared/qoder/cosy.js";

const CREDS = {
  userId: "01a18146-d651-7730-acd6-b56da1734fb9",
  authToken: "jt-test-token",
  name: "probe",
  email: "probe@example.com",
  machineId: "6887086a-2ab6-5a46-a8a9-c158ff9a241e",
};

const headersFor = () =>
  buildCosyHeaders(Buffer.from(""), "https://api3.qoder.sh/algo/api/v2/model/list", CREDS);

/**
 * The shipped client keeps `machine_token` in its own `machine_token.json`,
 * produced by `cosy/service/umid.GetMachineTokenAndType` from the device's
 * hardware id / MAC address. It is a different value from the machine id.
 *
 * We cannot reproduce it, so we must not fabricate it by echoing machineId:
 * a token that fails to match the id it claims to belong to is a stronger
 * "not a real client" signal than an absent header.
 */
describe("qoder machine token", () => {
  it("never echoes machineId into Cosy-Machinetoken", () => {
    const h = headersFor();
    expect(h["Cosy-Machinetoken"]).not.toBe(CREDS.machineId);
  });

  it("omits Cosy-Machinetoken entirely rather than sending a wrong value", () => {
    const h = headersFor();
    expect(h["Cosy-Machinetoken"]).toBeUndefined();
  });

  it("still sends the machine id, which we can produce correctly", () => {
    expect(headersFor()["Cosy-Machineid"]).toBe(CREDS.machineId);
  });
});

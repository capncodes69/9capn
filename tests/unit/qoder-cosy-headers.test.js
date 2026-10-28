import { describe, expect, it } from "vitest";
import { buildCosyHeaders } from "../../open-sse/shared/qoder/cosy.js";
import {
  QODER_IDE_VERSION,
  QODER_MACHINE_OS,
} from "../../open-sse/shared/qoder/constants.js";

const CREDS = {
  userId: "01a18146-d651-7730-acd6-b56da1734fb9",
  authToken: "jt-test-token",
  name: "probe",
  email: "probe@example.com",
  machineId: "6887086a-2ab6-5a46-a8a9-c158ff9a241e",
};

const headersFor = (url = "https://api3.qoder.sh/algo/api/v2/model/list") =>
  buildCosyHeaders(Buffer.from(""), url, CREDS);

describe("qoder cosy headers", () => {
  it("advertises the shipped IDE version", () => {
    const h = headersFor();
    expect(h["Cosy-Version"]).toBe(QODER_IDE_VERSION);
    expect(h["Cosy-Version"]).toBe("1.37.0");
  });

  it("advertises the shipped machine os", () => {
    expect(headersFor()["Cosy-Machineos"]).toBe(QODER_MACHINE_OS);
  });

  it("sends the X-Version header the shipped client sends", () => {
    const h = headersFor();
    expect(h["X-Version"]).toBe(QODER_IDE_VERSION);
  });

  it("keeps the machine id stable across calls so the device stays one device", () => {
    const h = headersFor();
    expect(h["Cosy-Machineid"]).toBe(CREDS.machineId);
  });
});

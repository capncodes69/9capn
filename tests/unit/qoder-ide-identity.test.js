import { describe, expect, it } from "vitest";
import {
  QODER_IDE_VERSION,
  QODER_MACHINE_OS,
  QODER_MACHINE_TYPE,
  QODER_CLIENT_TYPE,
  QODER_LOGIN_VERSION,
} from "../../open-sse/shared/qoder/constants.js";

describe("qoder IDE identity", () => {
  it("reports the shipped IDE version, not a fabricated one", () => {
    // From qoder-ide 1.37.0 resources/app/package.json -> "version": "1.37.0"
    expect(QODER_IDE_VERSION).toBe("1.37.0");
  });

  it("reports the linux machine os the shipped client reports", () => {
    // Go agent string table: "machine-info" "x86_64_linux" "machine_info"
    expect(QODER_MACHINE_OS).toBe("x86_64_linux");
  });

  it("keeps the client type and login version the gateway accepts", () => {
    expect(QODER_CLIENT_TYPE).toBe("5");
    expect(QODER_MACHINE_TYPE).toBe("5");
    expect(QODER_LOGIN_VERSION).toBe("v2");
  });
});

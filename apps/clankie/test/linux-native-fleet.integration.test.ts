import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { nativeProcessReceipt, nativeProcessStart } from "../src/local-fleet-process.ts";

const linuxIt = it.skipIf(process.platform !== "linux" || process.env.LINUX_FLEET_PROOF_TEST !== "1");

it("retains the complete Linux kernel birth in existing private-seat comparisons", () => {
  const kernelIdentity = "12345678-abcd-abcd-abcd-123456789abc:9001:12345";
  const birth = Object.assign(["1791690000", "120000"] as const, { kernelIdentity });
  const receipt = `1791690000.120000@${kernelIdentity}`;
  expect(nativeProcessStart(birth)).toBe(receipt);
  expect(nativeProcessReceipt(birth, "Sun Oct 11 00:00:00 2026")).toBe(receipt);
  expect(nativeProcessStart(["1791690000", "120000"])).toBe("1791690000.120000");
});

linuxIt(
  "proves kernel socket/process boundaries in the initial host PID namespace",
  async () => {
    const helper = fileURLToPath(
      new URL("../../../integrations/fleet-proof/linux-process-proof.py", import.meta.url),
    );
    const fixture = fileURLToPath(
      new URL("../../../integrations/fleet-proof/test/linux-proof.py", import.meta.url),
    );
    const { stderr } = await promisify(execFile)("/usr/bin/python3", ["-I", "-B", fixture, helper], {
      timeout: 20_000,
      maxBuffer: 1_000_000,
    });
    expect(stderr).toMatch(/Ran \d+ tests/u);
    expect(stderr).toContain("OK");
  },
  25_000,
);

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("support bundle environment redaction", () => {
  it("records operator credential presence without admitting its value", async () => {
    const secret = "clankie_op_secret-that-must-never-enter-support-data";
    const helper = resolve(import.meta.dirname, "../../../scripts/support-bundle-environment.mjs");
    const source = [
      `import { configuredEnvironmentKeys } from ${JSON.stringify(helper)};`,
      `console.log(JSON.stringify(configuredEnvironmentKeys(${JSON.stringify({
        CLANKIE_OPERATOR_TOKEN: secret,
        CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310",
        PATH: "/bin",
      })})));`,
    ].join("\n");

    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source]);
    expect(JSON.parse(stdout)).toEqual(["CLANKIE_CONTROL_PLANE_URL", "CLANKIE_OPERATOR_TOKEN"]);
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain("clankie_op_");
  });
});

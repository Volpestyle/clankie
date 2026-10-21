import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// The release smoke runs the same script on the bundled Node (VUH-2516).
it("every generated Windows probe command keeps headroom under the Windows command-line cap", () => {
  const result = spawnSync(process.execPath, [new URL("./windows-probe-size.ts", import.meta.url).pathname], {
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
});

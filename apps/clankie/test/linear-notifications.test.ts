import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retireLinearNotifications } from "../src/linear-notifications.ts";

it("retires the old notification checkpoint once with an explicit drop log", () => {
  const root = mkdtempSync(join(tmpdir(), "linear-checkpoint-retirement-"));
  const path = join(root, "linear-notifications.json");
  const logs: string[] = [];
  try {
    writeFileSync(
      path,
      JSON.stringify({ account: "org:bot", since: new Date().toISOString(), ids: ["seen"] }),
    );
    retireLinearNotifications(path, (message) => logs.push(message));
    expect(existsSync(path)).toBe(false);
    expect(logs).toEqual([
      "Retired Linear notification inbox checkpoint; previous account notification history dropped.",
    ]);
    retireLinearNotifications(path, (message) => logs.push(message));
    expect(logs).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

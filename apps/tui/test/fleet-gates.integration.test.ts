import { fleetSettingsClient } from "./fixtures/fleet-settings-client.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { runFleetCommand, formatFleetLines } from "../src/command/fleet.ts";

it("persists CLI gate presets and individual overrides without changing push or release", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-gates-cli-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    await runFleetCommand(["set", "--push", "owner", "--release", "owner"], fleetSettingsClient(settings));
    const result = await runFleetCommand(["set", "--gate-preset", "hands-off", "--hard-to-undo", "owner"], {
      ...fleetSettingsClient(settings),
    });
    const disk = await new SettingsStore(settings.path).load();
    expect(disk.autonomy.fleet).toMatchObject({
      everydayWork: "allow",
      leavesMac: "lead",
      hardToUndo: "owner",
      moneyAndAccounts: "owner",
      push: "owner",
      release: { mode: "owner" },
    });
    expect(formatFleetLines(result.fleet).join("\n")).toContain("Money and accounts");
    await expect(
      runFleetCommand(["set", "--money-and-accounts", "allow"], fleetSettingsClient(settings)),
    ).rejects.toThrow();
    expect((await settings.load()).autonomy.fleet.moneyAndAccounts).toBe("owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

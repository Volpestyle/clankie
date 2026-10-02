import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";

it.each([
  "restart",
  "reset",
  "deprovision",
  "remote-access",
  "down",
  "autostart",
  "herdr",
  "discord",
  "gateway",
  "seat",
  "mcp",
])("hosted %s never reaches Mac processes, sockets or credentials", async (command) => {
  const root = await mkdtemp(join(tmpdir(), "hosted-command-"));
  try {
    const settingsFile = join(root, "settings.json");
    await new SettingsStore(settingsFile).update((value) => ({
      ...value,
      client: { mode: "hosted", gatewayUrl: "https://api.example.test", hostId: "host_1234567890123456" },
    }));
    const spawnImpl = vi.fn(),
      killImpl = vi.fn();
    let error = "";
    expect(
      await runHeadlessCaptainCommand([command], {
        repoRoot: root,
        env: { CLANKIE_SETTINGS_FILE: settingsFile },
        spawnImpl,
        killImpl,
        stdout: { write() {} },
        stderr: {
          write(value) {
            error += value;
          },
        },
      }),
    ).toBe(1);
    expect(error).toContain("managed by the hosted service");
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(killImpl).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

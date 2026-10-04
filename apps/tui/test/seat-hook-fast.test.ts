import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SETTINGS_SCHEMA_VERSION } from "@clankie/settings";
import { runFastSeatHook } from "../bin/seat-hook-fast.ts";

afterEach(() => vi.unstubAllEnvs());

it("leaves every command but the per-turn seat hooks to the launcher", async () => {
  expect(await runFastSeatHook([])).toBeUndefined();
  expect(await runFastSeatHook(["status"])).toBeUndefined();
  expect(await runFastSeatHook(["memory-card", "--chat", "c1"])).toBeUndefined();
});

it("leaves a hosted install's seat hooks to the launcher's device transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-fast-hook-"));
  try {
    const settings = join(root, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        client: { mode: "hosted", gatewayUrl: "https://gateway.example", hostId: "host_0123456789abcdef" },
      }),
    );
    vi.stubEnv("CLANKIE_SETTINGS_FILE", settings);
    expect(await runFastSeatHook(["seat-sync"])).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

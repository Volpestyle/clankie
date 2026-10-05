import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MinecraftPlaySettingsSchema, SettingsStore } from "@clankie/settings";
import {
  FileCredentialStore,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
  mintOperatorToken,
} from "@clankie/credential-broker";
import { runMinecraftCommand } from "../src/command/minecraft.ts";

it("configures offline profiles/allowlist locally and sends only approved profile references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minecraft-command-"));
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    const store = new FileCredentialStore(join(dir, "auth.json"));
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: mintOperatorToken() });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ outcome: "ok" }));
    const options = { settings, operatorCredentialStore: store, env: {}, fetchImpl };
    await runMinecraftCommand(
      ["configure", "paper", "127.0.0.1", "--version", "1.21.4", "--username", "ClankieTest"],
      options,
    );
    expect((await settings.load()).minecraft.profiles[0]).toMatchObject({
      host: "127.0.0.1",
      version: "1.21.4",
      username: "ClankieTest",
      auth: "offline",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await runMinecraftCommand(["configure", "allow-public", "world.example", "25566"], options);
    expect((await settings.load()).minecraft.publicAllowlist).toEqual([
      { host: "world.example", port: 25566 },
    ]);
    await runMinecraftCommand(["join", "paper", "--conversation", "operator-friends"], options);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      action: "join",
      profileId: "paper",
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-clankie-conversation-id": "operator-friends",
    });
    await runMinecraftCommand(["follow", "James", "3"], options);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      action: "act",
      request: { type: "follow", player: "James", distance: 3 },
    });
    await runMinecraftCommand(["cancel"], options);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({ action: "cancel" });
    await runMinecraftCommand(["driver"], options);
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual({ action: "driver" });
    await runMinecraftCommand(["driver", "owner"], options);
    expect(JSON.parse(String(fetchImpl.mock.calls[4]?.[1]?.body))).toEqual({
      action: "driver",
      driver: { kind: "owner" },
    });
    await runMinecraftCommand(["driver", "worker", "fleet:default:pane:w42:p2"], options);
    expect(JSON.parse(String(fetchImpl.mock.calls[5]?.[1]?.body))).toEqual({
      action: "driver",
      driver: { kind: "worker", principalId: "fleet:default:pane:w42:p2" },
    });
    await runMinecraftCommand(["driver", "mind"], options);
    expect(JSON.parse(String(fetchImpl.mock.calls[6]?.[1]?.body))).toEqual({
      action: "driver",
      driver: { kind: "mind" },
    });
    await runMinecraftCommand(["configure", "revoke-public", "world.example", "25566"], options);
    await runMinecraftCommand(["configure", "remove", "paper"], options);
    expect((await settings.load()).minecraft).toEqual({
      profiles: [],
      publicAllowlist: [],
      play: MinecraftPlaySettingsSchema.parse({}),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("persists bounded play controls and preserves them when profile destinations change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minecraft-play-command-"));
  try {
    const path = join(dir, "settings.json");
    const settings = new SettingsStore(path);
    const options = { settings, env: {} };
    expect(await runMinecraftCommand(["configure", "play"], options)).toEqual({
      play: MinecraftPlaySettingsSchema.parse({}),
    });
    expect(
      await runMinecraftCommand(
        [
          "configure",
          "play",
          "--enabled",
          "off",
          "--model",
          "xai/grok-4.3",
          "--max-tokens",
          "40000",
          "--max-cost-usd",
          "0.25",
          "--turn-interval-ms",
          "5000",
          "--idle-backoff-ms",
          "30000",
          "--idle-stop-ms",
          "120000",
        ],
        options,
      ),
    ).toEqual({
      outcome: "ok",
      play: {
        enabled: false,
        model: "xai/grok-4.3",
        maxTokens: 40_000,
        maxCostUsd: 0.25,
        turnIntervalMs: 5_000,
        idleBackoffMs: 30_000,
        idleStopMs: 120_000,
      },
    });
    await runMinecraftCommand(["configure", "paper", "127.0.0.1", "--version", "1.21.4"], options);
    expect((await new SettingsStore(path).load()).minecraft.play).toMatchObject({
      enabled: false,
      model: "xai/grok-4.3",
      maxCostUsd: 0.25,
    });
    for (const args of [
      ["--enabled", "maybe"],
      ["--model", "invalid-model-ref"],
      ["--max-tokens", "0"],
      ["--max-cost-usd", "-1"],
      ["--idle-backoff-ms", "NaN"],
      ["--enabled", "on", "--enabled", "off"],
    ]) {
      await expect(runMinecraftCommand(["configure", "play", ...args], options)).rejects.toThrow("Usage");
    }
    expect((await settings.load()).minecraft.play.maxCostUsd).toBe(0.25);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses malformed primitives and arbitrary endpoint overrides before contacting the service", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const args of [
    ["goto", "NaN", "1", "2"],
    ["dig", "1.5", "64", "0"],
    ["join", "paper", "world.example"],
    ["action", '{"type":"chat","text":"hi","host":"world.example"}'],
    ["action", "bad json"],
    ["driver", "worker", "seat-7"],
    ["driver", "worker"],
    ["driver", "mind", "extra"],
  ]) {
    await expect(runMinecraftCommand(args, { env: {}, fetchImpl })).rejects.toThrow("Usage");
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

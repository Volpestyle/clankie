import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
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
    await runMinecraftCommand(["configure", "revoke-public", "world.example", "25566"], options);
    await runMinecraftCommand(["configure", "remove", "paper"], options);
    expect((await settings.load()).minecraft).toEqual({ profiles: [], publicAllowlist: [] });
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
  ]) {
    await expect(runMinecraftCommand(args, { env: {}, fetchImpl })).rejects.toThrow("Usage");
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

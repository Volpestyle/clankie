import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { DiscordSettingsSchema, parseProtocolResponse } from "@clankie/protocol";
import {
  SettingsStore,
  applyDiscordSettingsToEnvironment,
  discordManagedGuildId,
  discordSettingsToEnvironment,
  resolveDiscordSettings,
  readDiscordServerSettings,
} from "@clankie/settings";
import { runDiscordCommand } from "../../tui/src/command/discord.ts";
import { createDiscordRoomRoutes } from "../src/discord-room-routes.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
// The response shape before VUH-1624. Deliberately knows nothing of `setup`.
const OldSettingsSnapshot = z
  .object({
    settings: DiscordSettingsSchema.omit({
      serverId: true,
      role: true,
      fleetEnabled: true,
      fleetChannelId: true,
      trackingLevel: true,
      teamVisible: true,
    }),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
function fixture(machineName = "James’s Mac") {
  const root = mkdtempSync(join(tmpdir(), "discord-definition-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const app = createDiscordRoomRoutes({
    settings,
    machineName,
    observations: new DiscordRoomObservations(join(root, "rooms.json")),
    authorize: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-operator"
        ? { guard: async () => {}, current: () => true }
        : undefined,
    captain: { serveOperatorConversation: async () => ({ schemaVersion: 1, op: "list", conversations: [] }) },
  });
  const fetchImpl: typeof fetch = async (url, init) => app.request(new Request(String(url), init));
  const client = new ClankieApiClient({
    baseUrl: "http://fixture.invalid",
    operatorToken: "fixture-operator",
    fetchImpl,
  });
  return { app, settings, client, fetchImpl };
}
it("an old-shape client reads the new host definition response and still revision-checks writes", async () => {
  const { client, fetchImpl, settings } = fixture();
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      role: "admin",
      fleetEnabled: true,
      trackingLevel: "project_activity",
      teamVisible: false,
    },
  }));
  const response = await fetchImpl("http://fixture.invalid/v1/discord/settings", {
    headers: { authorization: "Bearer fixture-operator" },
  });
  const wire = await response.json();
  expect(wire.setup.definition.schemaVersion).toBe(2);
  expect(wire.setup.machineName).toBe("James’s Mac");
  expect(OldSettingsSnapshot.safeParse(wire).success).toBe(false);
  const old = parseProtocolResponse(OldSettingsSnapshot, wire);
  expect(old.settings).not.toHaveProperty("teamVisible");
  expect(wire.settings.teamVisible).toBe(false);
  expect(old.revision).toBe(wire.revision);
  const changed = { ...old.settings, guildId: "12345" };
  const write = async (expectedRevision: string, next: unknown) => {
    const response = await fetchImpl("http://fixture.invalid/v1/discord/settings", {
      method: "POST",
      headers: { authorization: "Bearer fixture-operator", "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision, settings: next }),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  const saved = await write(old.revision, changed);
  expect(parseProtocolResponse(OldSettingsSnapshot, saved).settings.guildId).toBe("12345");
  expect(saved.settings.teamVisible).toBe(false);
  expect(saved.settings.role).toBe("admin");
  expect(saved.settings.fleetEnabled).toBe(true);
  expect(saved.settings.trackingLevel).toBe("project_activity");
  await expect(
    client.updateDiscordSettings({
      expectedRevision: old.revision,
      settings: { ...saved.settings, guildId: "12345" },
    }),
  ).rejects.toThrow();
  await expect(
    client.updateDiscordSettings({
      expectedRevision: saved.revision,
      settings: { ...saved.settings, futureGrant: true },
    }),
  ).rejects.toThrow();
  const invalidInput = await fetchImpl("http://fixture.invalid/v1/discord/settings", {
    method: "POST",
    headers: { authorization: "Bearer fixture-operator", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: saved.revision, settings: { ...changed, futureGrant: true } }),
  });
  expect(invalidInput.status).toBe(400);
  expect((await settings.load()).discord.systemActorUserIds).toEqual([]);
  expect((await settings.load()).discord.systemActorGuildIds).toEqual([]);
});
it("API and CLI receive the same server, role, fleet and tracking setup and all Advanced fields from the host", async () => {
  const { client, fetchImpl } = fixture("his cloud computer");
  const setup = (await client.discordSettings()).setup!;
  expect(
    await runDiscordCommand(["definition"], {
      host: "http://fixture.invalid",
      fetchImpl,
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-operator" },
    }),
  ).toEqual(setup);
  expect(setup.machineName).toBe("his cloud computer");
  expect(
    setup.definition.advancedGroups.flatMap((group) => group.fields.map((field) => field.key)).sort(),
  ).toEqual(
    Object.keys(DiscordSettingsSchema.shape)
      .filter((key) => !["systemActorGuildIds", "systemActorChannelIds"].includes(key))
      .sort(),
  );
  const sentences = setup.definition.sentences.map((sentence) =>
    sentence.parts
      .map((part) =>
        part.kind === "text"
          ? part.text
          : part.kind === "machine"
            ? setup.machineName
            : `[${part.placeholder}]`,
      )
      .join(""),
  );
  expect(sentences).toEqual([
    "Connect [server] with Clankie as [Participant / Admin].",
    "Fleet in Discord is [on / off].",
    "Project tracking is [off / project updates / project activity / every issue].",
  ]);
  expect(setup.definition.schemaVersion).toBe(2);
  expect(
    setup.definition.sentences
      .flatMap((sentence) => sentence.parts)
      .filter((part) => part.kind === "picker")
      .map((part) => part.picker),
  ).toEqual(["server", "role", "fleet", "tracking"]);
  expect(setup.definition.sentences.some((sentence) => sentence.explicitComputerAccess)).toBe(false);
  expect(JSON.stringify(setup)).not.toMatch(/swarm home|swarm-home|this computer/iu);
});
it("shared-definition reads retain the settings authorization boundary", async () => {
  const { app } = fixture();
  expect((await app.request("/v1/discord/settings")).status).toBe(403);
});
it("the preferred managed-server environment name preserves stored and legacy wire settings", async () => {
  const { settings } = fixture();
  const stored = (
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, swarmGuildId: "11111" },
    }))
  ).discord;
  expect(discordSettingsToEnvironment(stored).DISCORD_MANAGED_GUILD_ID).toBe("11111");
  const legacyEnv = { DISCORD_SWARM_GUILD_ID: "22222" };
  applyDiscordSettingsToEnvironment(stored, legacyEnv);
  expect(discordManagedGuildId(legacyEnv)).toBe("22222");
  expect(resolveDiscordSettings(stored, legacyEnv).settings.swarmGuildId).toBe("22222");
  const both = { ...legacyEnv, DISCORD_MANAGED_GUILD_ID: "33333" };
  expect(discordManagedGuildId(both)).toBe("33333");
  expect(resolveDiscordSettings(stored, both).settings.swarmGuildId).toBe("33333");
  const empty = {};
  applyDiscordSettingsToEnvironment(stored, empty);
  expect(discordManagedGuildId(empty)).toBe("11111");
});

it("the independent visibility setting keeps the team's selected server across hide and show", async () => {
  const { client, settings, fetchImpl } = fixture();
  const initial = await client.discordSettings();
  expect(initial.settings.teamVisible ?? true).toBe(true);
  const command = await runDiscordCommand(["set", "--team-visible", "off"], {
    settings,
    env: { CLANKIE_OPERATOR_TOKEN: "fixture-operator" },
    host: "http://fixture.invalid",
    fetchImpl,
  });
  expect("discord" in command && command.discord.teamVisible).toBe(false);
  const refreshed = await client.discordSettings();
  const hidden = await client.updateDiscordSettings({
    expectedRevision: refreshed.revision,
    settings: { ...refreshed.settings, swarmGuildId: "12345", teamVisible: false },
  });
  const visible = await client.updateDiscordSettings({
    expectedRevision: hidden.revision,
    settings: { ...hidden.settings, teamVisible: true },
  });
  expect(hidden.settings.swarmGuildId).toBe("12345");
  expect(visible.settings.swarmGuildId).toBe("12345");
  const fleet = visible.setup!.definition.sentences.find((sentence) => sentence.id === "fleet")!;
  expect(fleet.parts.filter((part) => part.kind === "picker").map((part) => part.fields)).toEqual([
    ["fleetEnabled"],
  ]);
});

it("fresh body authority observes persisted role and fleet changes despite startup materialized settings", async () => {
  const { settings } = fixture();
  const admin = (
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, serverId: "10001", role: "admin", fleetEnabled: true },
    }))
  ).discord;
  const env: NodeJS.ProcessEnv = { CLANKIE_SETTINGS_FILE: settings.path };
  applyDiscordSettingsToEnvironment(admin, env);
  expect((await readDiscordServerSettings(env)).role).toBe("admin");
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, role: "participant", fleetEnabled: false },
  }));
  expect(env.DISCORD_ROLE).toBe("admin");
  const fresh = await readDiscordServerSettings(env);
  expect(fresh.role).toBe("participant");
  expect(fresh.fleetEnabled).toBe(false);
  expect(fresh.swarmGuildId).toBeUndefined();
  const explicit: NodeJS.ProcessEnv = { CLANKIE_SETTINGS_FILE: settings.path, DISCORD_ROLE: "admin" };
  applyDiscordSettingsToEnvironment(fresh, explicit);
  expect((await readDiscordServerSettings(explicit)).role).toBe("admin");
});

it("clearing the connected server in Advanced disconnects its projected body settings", async () => {
  const { client } = fixture();
  const initial = await client.discordSettings();
  const connected = await client.updateDiscordSettings({
    expectedRevision: initial.revision,
    settings: {
      ...initial.settings,
      serverId: "10001",
      role: "admin",
      fleetEnabled: true,
      fleetChannelId: "20001",
    },
  });
  expect(connected.settings.ingressGuildIds).toEqual(["10001"]);
  const disconnected = await client.updateDiscordSettings({
    expectedRevision: connected.revision,
    settings: { ...connected.settings, serverId: undefined, fleetChannelId: undefined },
  });
  expect(disconnected.settings.serverId).toBeUndefined();
  expect(disconnected.settings.fleetChannelId).toBeUndefined();
  expect(disconnected.settings.guildId).toBeUndefined();
  expect(disconnected.settings.swarmGuildId).toBeUndefined();
  expect(disconnected.settings.ingressGuildIds).toEqual([]);
  expect(disconnected.settings.voiceGuildIds).toEqual([]);
  expect(disconnected.settings.presenceGuildIds).toEqual([]);
  expect(disconnected.settings.textIngressEnabled).toBe(false);
  expect(disconnected.settings.voiceEnabled).toBe(false);
});

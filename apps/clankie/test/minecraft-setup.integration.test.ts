import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore } from "@clankie/credential-broker";
import { BodyLeaseStore } from "../src/body-leases.ts";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
import { createMinecraftHostAuthority } from "../src/minecraft-host-authority.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { MinecraftMcpPort } from "../src/minecraft-mcp.ts";
import { MinecraftService } from "../src/minecraft.ts";
import { minecraftTools } from "../src/captain/minecraft-tools.ts";

it("configures approved profiles through captain tools with persisted settings and owner authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minecraft-setup-"));
  const settings = new SettingsStore(join(dir, "settings.json"));
  await settings.update((value) => ({
    ...value,
    discord: { ...value.discord, ownerUserId: "100000", systemActorUserIds: ["200000"] },
  }));
  const host = createMcpHost({
    settings,
    credentials: new FileCredentialStore(join(dir, "credentials.json")),
    curated: [],
    logger: { info() {}, warn() {} },
  });
  try {
    const guard = createMinecraftHostAuthority({
      settings: async () => (await settings.load()).discord,
      routeAuthorized: () => true,
    });
    const service = new MinecraftService({
      port: new MinecraftMcpPort({
        host,
        profiles: async () =>
          (await settings.load()).minecraft.profiles.map(({ id, name }) => ({ id, name })),
        resolveProfile: async () => {
          throw new Error("No join requested");
        },
      }),
      store: new BodyLeaseStore(join(dir, "leases")),
      path: join(dir, "session.json"),
      configuration: { settings, guard: (identity) => guard(identity, { admin: true }) },
    });
    let current = true;
    const actor = (actorId: string): BodyConversationIdentity => ({
      conversationId: "setup",
      current: () => current,
      authorize: async () => false,
      route: {
        mode: "social",
        owner: {
          conversationId: "setup",
          discord: {
            baseSessionKey: "discord-test",
            targetId: "300000:400000",
            actorId,
            guildId: "300000",
            channelId: "400000",
            messageId: "500000",
            transportKind: "bot",
          },
        },
      },
    });
    const turn = { bodyIdentity: actor("100000") };
    const tools = minecraftTools(service, turn);
    const call = (name: string, input: Record<string, unknown> = {}) =>
      tools.find((tool) => tool.name === name)!.execute("setup", input, undefined, undefined, {} as never);
    const configured = {
      profiles: [{ id: "friends", name: "Friends", host: "mc.example.com", version: "1.21.4" }],
      publicAllowlist: [{ host: "mc.example.com", port: 25565 }],
    };
    expect(await call("minecraft_configure", { settings: configured })).toMatchObject({
      details: configured,
    });
    expect((await new SettingsStore(join(dir, "settings.json")).load()).minecraft.profiles[0]).toMatchObject({
      id: "friends",
      auth: "offline",
    });
    expect(await call("minecraft_configuration")).toMatchObject({ details: configured });
    turn.bodyIdentity = actor("700000");
    expect(await call("minecraft_configure", { settings: { profiles: [] } })).toMatchObject({
      details: { outcome: "refused" },
    });
    expect((await settings.load()).minecraft.profiles).toHaveLength(1);
    turn.bodyIdentity = actor("200000");
    expect(await call("minecraft_configuration")).toMatchObject({ details: configured });
    current = false;
    expect(await call("minecraft_configure", { settings: { profiles: [] } })).toMatchObject({
      details: { outcome: "refused" },
    });
    expect((await settings.load()).minecraft.profiles).toHaveLength(1);
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

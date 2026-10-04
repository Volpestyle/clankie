import { DiscordSettingsSchema } from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
import { createMinecraftHostAuthority } from "../src/minecraft-host-authority.ts";

function fixture(actorId = "100000", discord = true) {
  let current = true;
  let settings = DiscordSettingsSchema.parse({
    ownerUserId: "100000",
    systemActorUserIds: ["200000"],
    systemActorGuildIds: ["300000"],
  });
  const identity: BodyConversationIdentity = {
    conversationId: "room-test",
    current: () => current,
    authorize: vi.fn(async () => false),
    route: {
      mode: "social",
      owner: {
        conversationId: "room-test",
        ...(discord
          ? {
              discord: {
                baseSessionKey: "discord-test",
                targetId: "300000:400000",
                actorId,
                guildId: "300000",
                channelId: "400000",
                messageId: "500000",
                transportKind: "bot" as const,
              },
            }
          : {}),
      },
    },
  };
  const routeAuthorized = vi.fn(async () => true);
  const operatorAuthorized = vi.fn(async () => false);
  const guard = createMinecraftHostAuthority({
    settings: async () => settings,
    routeAuthorized,
    operatorAuthorized,
  });
  return {
    identity,
    guard,
    routeAuthorized,
    operatorAuthorized,
    stale: () => {
      current = false;
    },
    revoke: () => {
      settings = { ...settings, ownerUserId: "600000", systemActorUserIds: [] };
    },
  };
}

describe("Minecraft host final conversation authority", () => {
  it.each(["100000", "200000"])(
    "admits owner or individual operator %s without requiring a shell",
    async (actor) => {
      const f = fixture(actor);
      (await f.guard(f.identity, { admin: true }))();
      expect(f.identity.authorize).not.toHaveBeenCalled();
    },
  );

  it("rejects trusted-guild-only actors for admin while permitting an admitted self request", async () => {
    const f = fixture("700000");
    await expect(f.guard(f.identity, { admin: true })).rejects.toThrow("minecraft_host_not_authorized");
    (await f.guard(f.identity, { admin: false }))();
  });

  it("reloads a grant after awaiting admission", async () => {
    const f = fixture("200000");
    f.routeAuthorized.mockImplementation(async () => {
      f.revoke();
      return true;
    });
    await expect(f.guard(f.identity, { admin: true })).rejects.toThrow("minecraft_host_not_authorized");
  });

  it("rejects stale identities both before admission and synchronously at dispatch", async () => {
    const f = fixture();
    const current = await f.guard(f.identity, { admin: true });
    f.stale();
    expect(current).toThrow("minecraft_host_not_authorized");
    await expect(f.guard(f.identity, { admin: false })).rejects.toThrow("minecraft_host_not_authorized");
  });

  it("requires explicit console proof for identities with no Discord origin", async () => {
    const f = fixture("100000", false);
    await expect(f.guard(f.identity, { admin: true })).rejects.toThrow("minecraft_host_not_authorized");
    f.operatorAuthorized.mockResolvedValue(true);
    (await f.guard(f.identity, { admin: true }))();
  });

  it("denies absent identities, revoked admission, and mismatched conversation attribution", async () => {
    const f = fixture();
    await expect(f.guard(undefined, { admin: true })).rejects.toThrow("minecraft_host_not_authorized");
    f.routeAuthorized.mockResolvedValue(false);
    await expect(f.guard(f.identity, { admin: true })).rejects.toThrow("minecraft_host_not_authorized");
    await expect(f.guard({ ...f.identity, conversationId: "other" }, { admin: true })).rejects.toThrow(
      "minecraft_host_not_authorized",
    );
  });
});

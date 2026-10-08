import { describe, expect, it } from "vitest";
import { planDiscordTurnSession } from "../src/captain/system-authority.ts";

const ACTOR = "555555555555555555";
const GUILD = "666666666666666666";
const CHANNEL = "777777777777777777";
const BASE = `discord:clankie:discord:${GUILD}:${CHANNEL}`;

const settings = (
  overrides: Partial<{
    systemActorUserIds: string[];
    systemActorGuildIds: string[];
    systemActorChannelIds: string[];
  }> = {},
) => ({
  systemActorUserIds: [],
  systemActorGuildIds: [],
  systemActorChannelIds: [],
  ...overrides,
});

describe("Discord turn authority", () => {
  it("keeps an ungranted room on its durable social lane", () => {
    expect(plan()).toEqual({
      kind: "social",
      durable: true,
      systemTools: false,
      sessionKey: BASE,
    });
  });

  it("keeps an individually granted actor one-shot inside a shared room", () => {
    expect(plan({ settings: settings({ systemActorUserIds: [ACTOR] }) })).toEqual({
      kind: "system_turn",
      durable: false,
      systemTools: true,
      sessionKey: BASE,
    });
  });

  it("gives an individually granted actor a separate durable official-bot DM", () => {
    const input = {
      baseSessionKey: "discord:clankie:discord:dm:dm-1",
      actorId: ACTOR,
      channelId: "dm-1",
      settings: settings({ systemActorUserIds: [ACTOR] }),
    };
    expect(planDiscordTurnSession({ ...input, durable: true, transportKind: "bot" })).toEqual({
      kind: "system_lane",
      durable: true,
      systemTools: true,
      sessionKey: `${input.baseSessionKey}:authority:system-v2:null`,
      grant: "dm_user",
    });
    // The lab user body can observe group DMs, so actor identity alone cannot
    // prove that everyone sharing the lane has the same grant.
    expect(planDiscordTurnSession({ ...input, durable: true, transportKind: "user_session" }).kind).toBe(
      "system_turn",
    );
  });

  it("retired trusted guild and channel ids never grant a machine", () => {
    expect(
      plan({ settings: settings({ systemActorGuildIds: [GUILD], systemActorChannelIds: [CHANNEL] }) }),
    ).toMatchObject({
      kind: "social",
      systemTools: false,
    });
  });

  it("Everyone ownership grants a durable lane shared by admitted members", () => {
    const trusted = {
      ...settings(),
      servers: [{ serverId: GUILD, role: "participant" as const, owners: "everyone" as const }],
    };
    const first = plan({ settings: trusted });
    expect(first).toMatchObject({ kind: "system_lane", systemTools: true, grant: "guild" });
    expect(plan({ actorId: "111111111111111111", settings: trusted })).toEqual(first);
    expect(plan({ durable: false, settings: trusted }).durable).toBe(false);
    expect(plan().sessionKey).not.toBe(first.sessionKey);
  });

  it("a role owner needs host-proven membership, and mixed audiences stay one-shot", () => {
    const trusted = {
      ...settings(),
      servers: [{ serverId: GUILD, role: "admin" as const, owners: "role" as const, ownerRoleId: "12345" }],
    };
    expect(plan({ settings: trusted }).systemTools).toBe(false);
    expect(plan({ settings: trusted, serverOwner: true }).kind).toBe("system_turn");
    expect(plan({ settings: trusted, serverOwner: true, ownerAudience: true }).kind).toBe("system_lane");
  });
});

function plan(
  overrides: Partial<Parameters<typeof planDiscordTurnSession>[0]> = {},
): ReturnType<typeof planDiscordTurnSession> {
  return planDiscordTurnSession({
    baseSessionKey: BASE,
    durable: true,
    actorId: ACTOR,
    guildId: GUILD,
    channelId: CHANNEL,
    transportKind: "bot",
    settings: settings(),
    ...overrides,
  });
}

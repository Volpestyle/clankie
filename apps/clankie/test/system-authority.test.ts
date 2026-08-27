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
      sessionKey: `${input.baseSessionKey}:authority:system`,
      grant: "dm_user",
    });
    // The lab user body can observe group DMs, so actor identity alone cannot
    // prove that everyone sharing the lane has the same grant.
    expect(planDiscordTurnSession({ ...input, durable: true, transportKind: "user_session" }).kind).toBe(
      "system_turn",
    );
  });

  it("grants every actor in a trusted guild room one durable system lane", () => {
    const trusted = settings({ systemActorGuildIds: [GUILD] });
    const first = plan({ settings: trusted });
    const second = plan({ actorId: "111111111111111111", settings: trusted });
    expect(first).toMatchObject({
      kind: "system_lane",
      durable: true,
      systemTools: true,
      grant: "guild",
    });
    expect(second).toEqual(first);
    expect(first.sessionKey).toBe(`${BASE}:authority:system`);
  });

  it("uses the optional channel list as refinement below a trusted guild", () => {
    const trusted = settings({
      systemActorGuildIds: [GUILD],
      systemActorChannelIds: [CHANNEL],
    });
    expect(plan({ settings: trusted }).kind).toBe("system_lane");
    expect(plan({ channelId: "888888888888888888", settings: trusted }).kind).toBe("social");
    expect(plan({ guildId: "999999999999999999", settings: trusted }).kind).toBe("social");
  });

  it("never makes a source-declared one-shot durable", () => {
    expect(plan({ durable: false, settings: settings({ systemActorGuildIds: [GUILD] }) })).toMatchObject({
      kind: "system_turn",
      durable: false,
      systemTools: true,
    });
  });

  it("routes the next message away from a revoked tool-bearing lane", () => {
    const granted = plan({ settings: settings({ systemActorGuildIds: [GUILD] }) });
    const revoked = plan();
    expect(granted.sessionKey).not.toBe(revoked.sessionKey);
    expect(revoked).toMatchObject({ kind: "social", systemTools: false });
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

import type { JoinDiscordVoiceInput } from "@clankie/discord-presence-core";
import { describe, expect, it } from "vitest";
import {
  executeVoicePresenceIntent,
  type VoicePresenceExecutionConfig,
  type VoicePresenceSessionPort,
} from "../src/voice-presence.ts";

const ADAPTER = (() => ({
  sendPayload: () => true,
  destroy: () => undefined,
})) as unknown as JoinDiscordVoiceInput["adapterCreator"];

class FakeVoiceSession implements VoicePresenceSessionPort {
  public readonly joins: { guildId: string; channelId: string }[] = [];
  public readonly heardUserIds = new Set<string>();
  public leaves = 0;
  public state: { active: boolean; guildId?: string; channelId?: string } = { active: false };

  public status() {
    return this.state;
  }

  public canHear(userId: string): boolean {
    return this.heardUserIds.has(userId);
  }

  public join(input: { guildId: string; channelId: string }): Promise<void> {
    this.joins.push({ guildId: input.guildId, channelId: input.channelId });
    this.state = { active: true, guildId: input.guildId, channelId: input.channelId };
    return Promise.resolve();
  }

  public leave(): Promise<void> {
    this.leaves += 1;
    this.state = { active: false };
    return Promise.resolve();
  }
}

function config(session: VoicePresenceSessionPort): VoicePresenceExecutionConfig {
  return {
    bindings: { ambientRoleIds: new Set(["voice-role"]), ambientUserIds: new Set() },
    joinPolicy: "ambient",
    voiceGuildIds: new Set(["guild-1"]),
    voiceChannelIds: new Set(["voice-1"]),
    voiceSession: session,
    transcriptLoggingEnabled: true,
  };
}

function input(intent: "join" | "leave", roleIds: readonly string[] = ["voice-role"]) {
  return {
    intent,
    guildId: "guild-1",
    principal: { userId: "user-1", roleIds: new Set(roleIds) },
    memberVoiceChannelId: "voice-1",
    adapterCreator: ADAPTER,
  };
}

describe("captain voice presence execution", () => {
  it("keeps authority and the join target in the live Discord body", async () => {
    const session = new FakeVoiceSession();
    session.heardUserIds.add("user-1");
    await expect(executeVoicePresenceIntent(config(session), input("join", []))).resolves.toEqual({
      action: "join_refused",
      reason: "authority",
    });
    expect(session.joins).toEqual([]);

    await expect(executeVoicePresenceIntent(config(session), input("join"))).resolves.toEqual({
      action: "joined",
      channelId: "voice-1",
      actorCanBeHeard: true,
      transcriptLoggingEnabled: true,
    });
    expect(session.joins).toEqual([{ guildId: "guild-1", channelId: "voice-1" }]);

    // Idempotent: a second agent call does not reset the room's consent state.
    await executeVoicePresenceIntent(config(session), input("join"));
    expect(session.joins).toHaveLength(1);
  });

  it("refuses cross-server leave and otherwise leaves once", async () => {
    const session = new FakeVoiceSession();
    session.state = { active: true, guildId: "guild-2", channelId: "voice-2" };
    await expect(executeVoicePresenceIntent(config(session), input("leave"))).resolves.toEqual({
      action: "leave_refused",
      reason: "other_guild",
    });
    expect(session.leaves).toBe(0);

    session.state = { active: true, guildId: "guild-1", channelId: "voice-1" };
    await expect(executeVoicePresenceIntent(config(session), input("leave"))).resolves.toEqual({
      action: "left",
      channelId: "voice-1",
    });
    expect(session.leaves).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { captainTools } from "../src/captain/tools.ts";

describe("captain voice presence tools", () => {
  it("presents Pokemon play as one PokeAgent tool family", () => {
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
    } as unknown as CaptainDeps;
    const names = (gameplay?: { pokeagentMmoEnabled: boolean }) =>
      captainTools(deps, {}, {} as LaneLog, "operator", gameplay)
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("pokeagent_"));

    const family = [
      "pokeagent_join_mmo",
      "pokeagent_world",
      "pokeagent_stop",
      "pokeagent_observe",
      "pokeagent_recall",
    ];
    expect(names()).toEqual(family);
    expect(names({ pokeagentMmoEnabled: true })).toEqual(family);
    expect(names({ pokeagentMmoEnabled: false })).toEqual([]);
  });

  // He read the old description into a group chat word for word: "your audio is
  // transcribed live and may stay with the configured provider for this call."
  // A tool description is read by the character who has to speak it, so it
  // describes the consent situation and never what to say about it.
  it("describes the join consent situation without scripting a line", () => {
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.reject(new Error("unused")),
        getLiveSession: () => Promise.reject(new Error("unused")),
      },
      discordVoicePresence: { join: () => Promise.reject(new Error("unused")) },
    } as unknown as CaptainDeps;
    for (const lane of ["discord_presence", "operator"] as const) {
      const join = captainTools(deps, {}, {} as LaneLog, lane).find((tool) => tool.name === "voice_join");
      if (join === undefined) throw new Error(`voice_join is missing on ${lane}`);
      const description = join.description ?? "";
      // The situation: what consent blocks, and what the room does not know.
      expect(description).toContain("/clankie voice-consent opt-in");
      expect(description).toContain("you are transcribing them");
      expect(description).toContain("they have not been told");
      // No sentence he can lift into the room, and no order to say one.
      expect(description).not.toMatch(/their audio is transcribed/i);
      expect(description).not.toMatch(/may remain with|may stay with/i);
      expect(description).not.toMatch(/\bdisclose\b|\btell them\b|\bin your own words\b/i);
    }

    const join = captainTools(deps, {}, {} as LaneLog, "operator").find((tool) => tool.name === "voice_join");
    expect(join?.description).toContain("transcriptLoggingEnabled");
    expect(join?.description).toContain("private local development log");
  });

  it("lets the captain decide while the host supplies identity", async () => {
    const calls: unknown[] = [];
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.reject(new Error("unused")),
        getLiveSession: () => Promise.reject(new Error("unused")),
      },
      discordVoicePresence: {
        join: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({
            action: "joined" as const,
            channelId: "voice-1",
            actorCanBeHeard: false,
            transcriptLoggingEnabled: true,
          });
        },
      },
    } as unknown as CaptainDeps;
    const tools = captainTools(
      deps,
      { guildId: "guild-1", actorId: "user-1" },
      {} as LaneLog,
      "discord_presence",
    );
    const join = tools.find((tool) => tool.name === "voice_join");
    if (join === undefined) throw new Error("voice_join is missing");

    await join.execute("call-1", {}, undefined, undefined, {} as never);

    expect(calls).toEqual([{ guildId: "guild-1", actorId: "user-1" }]);
    const operatorJoin = captainTools(deps, {}, {} as LaneLog, "operator").find(
      (tool) => tool.name === "voice_join",
    );
    if (operatorJoin === undefined) throw new Error("operator voice_join is missing");
    await operatorJoin.execute("call-2", {}, undefined, undefined, {} as never);
    expect(calls).toEqual([{ guildId: "guild-1", actorId: "user-1" }, {}]);
  });

  it("host-stamps the asker on play intents", async () => {
    const calls: unknown[] = [];
    const deps = {
      embodiment: {
        submitIntent: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({ outcome: "refused" as const, reason: "policy" as const });
        },
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
    } as unknown as CaptainDeps;
    const join = captainTools(deps, { actorId: "user-1" }, {} as LaneLog, "discord_presence").find(
      (tool) => tool.name === "pokeagent_join_mmo",
    );
    if (join === undefined) throw new Error("pokeagent_join_mmo is missing");

    await join.execute("call-1", { environmentId: "pokemon-firered" }, undefined, undefined, {} as never);

    expect(join.parameters).toMatchObject({ properties: { environmentId: expect.any(Object) } });
    // The asker is stamped by the host, never chosen by the model.
    expect(JSON.stringify(join.parameters)).not.toContain("requestedBy");
    expect(calls).toEqual([
      expect.objectContaining({ originLane: "discord_presence", requestedBy: "user-1" }),
    ]);
    expect(calls[0]).not.toHaveProperty("venue");
  });

  it("lists granted world operations and refuses travel when ungranted", async () => {
    const hostedWorld = {
      inspect: () => ({
        outcome: "playing" as const,
        grantedOperations: ["world.session", "world.who"],
        session: {
          worldId: "pallet",
          playerId: "player-clankie",
          sessionId: "session-clankie",
          gameId: "firered",
        },
      }),
      invoke: async (name: string) =>
        name === "world.who"
          ? { outcome: "ok", result: { ok: true, worldId: "pallet", players: [] } }
          : {
              outcome: "refused",
              reason: "capability_unavailable",
              detail: `The world did not grant ${name}`,
            },
    };
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
      hostedWorld,
    } as unknown as CaptainDeps;
    const world = captainTools(deps, {}, {} as LaneLog, "operator").find(
      (tool) => tool.name === "pokeagent_world",
    );
    if (world === undefined) throw new Error("pokeagent_world is missing");
    const listed = await world.execute("call-1", {}, undefined, undefined, {} as never);
    expect(JSON.parse((listed.content[0] as { text: string }).text)).toMatchObject({
      outcome: "playing",
      grantedOperations: ["world.session", "world.who"],
    });
    const who = await world.execute("call-2", { operation: "world.who" }, undefined, undefined, {} as never);
    expect(JSON.parse((who.content[0] as { text: string }).text)).toMatchObject({
      outcome: "ok",
      result: { ok: true, players: [] },
    });
    const travel = await world.execute(
      "call-3",
      { operation: "world.travel", destination: "emerald" },
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.parse((travel.content[0] as { text: string }).text)).toMatchObject({
      outcome: "refused",
      reason: "capability_unavailable",
    });
  });

  it("reserves text updates for people waiting on slow work", () => {
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
      discordActions: { execute: () => Promise.reject(new Error("unused")) },
    } as unknown as CaptainDeps;
    const update = captainTools(deps, {}, {} as LaneLog, "discord_presence").find(
      (tool) => tool.name === "send_text_update",
    );

    expect(update?.description).toContain("someone is actually waiting");
    expect(update?.description).toContain("unsolicited link");
  });

  it("grounds social actions in the trigger message", async () => {
    const calls: unknown[] = [];
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
      discordActions: {
        execute: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({ ok: true, message: "I reacted." });
        },
      },
    } as unknown as CaptainDeps;
    const react = captainTools(
      deps,
      { actorId: "user-1", guildId: "guild-1", channelId: "channel-1", messageId: "message-1" },
      {} as LaneLog,
      "discord_presence",
    ).find((tool) => tool.name === "discord_react");
    if (react === undefined) throw new Error("discord_react is missing");

    await react.execute("call-1", { emoji: "👍" }, undefined, undefined, {} as never);

    expect(JSON.stringify(react.parameters)).not.toMatch(/actorId|guildId|channelId|messageId/u);
    expect(calls).toEqual([
      {
        action: "react",
        callId: "call-1",
        actorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        emoji: "👍",
      },
    ]);
    const voiceToolNames = captainTools(
      deps,
      { actorId: "user-1", guildId: "guild-1", channelId: "voice-1", messageId: "utterance-1" },
      {} as LaneLog,
      "discord_voice",
    ).map((tool) => tool.name);
    expect(voiceToolNames).toContain("discord_watch_start");
    expect(voiceToolNames).not.toContain("discord_react");
  });
});

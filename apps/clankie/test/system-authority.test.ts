import { describe, expect, it } from "vitest";
import { discordTurnHasSystemTools } from "../src/captain/system-authority.ts";

const ACTOR = "555555555555555555";

describe("discordTurnHasSystemTools", () => {
  it("grants a Discord text turn only when the trigger actor is allowlisted", () => {
    expect(
      discordTurnHasSystemTools({
        lane: "discord_presence",
        actorId: ACTOR,
        systemActorUserIds: [ACTOR],
      }),
    ).toBe(true);
    expect(
      discordTurnHasSystemTools({
        lane: "discord_presence",
        actorId: "111111111111111111",
        systemActorUserIds: [ACTOR],
      }),
    ).toBe(false);
  });

  it("denies everyone when the allowlist is empty", () => {
    expect(
      discordTurnHasSystemTools({
        lane: "discord_presence",
        actorId: ACTOR,
        systemActorUserIds: [],
      }),
    ).toBe(false);
  });

  it("never grants voice, even to an allowlisted speaker", () => {
    // Voice sessions are durable and shared; builtins on that session would
    // let anyone in the call drive the machine.
    expect(
      discordTurnHasSystemTools({
        lane: "discord_voice",
        actorId: ACTOR,
        systemActorUserIds: [ACTOR],
      }),
    ).toBe(false);
  });

  it("does not treat the operator lane as a Discord grant", () => {
    // The console is privileged by being the console, not by this list.
    expect(
      discordTurnHasSystemTools({
        lane: "operator",
        actorId: ACTOR,
        systemActorUserIds: [ACTOR],
      }),
    ).toBe(false);
  });
});

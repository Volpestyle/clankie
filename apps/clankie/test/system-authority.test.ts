import { describe, expect, it } from "vitest";
import { discordTurnHasSystemTools, discordTurnUsesDurableSession } from "../src/captain/system-authority.ts";

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

  it("grants voice on the same allowlist, and to nobody else in the call", () => {
    expect(
      discordTurnHasSystemTools({
        lane: "discord_voice",
        actorId: ACTOR,
        systemActorUserIds: [ACTOR],
      }),
    ).toBe(true);
    // Another speaker in the same channel earns nothing from the first's grant.
    expect(
      discordTurnHasSystemTools({
        lane: "discord_voice",
        actorId: "111111111111111111",
        systemActorUserIds: [ACTOR],
      }),
    ).toBe(false);
    expect(discordTurnHasSystemTools({ lane: "discord_voice", actorId: ACTOR, systemActorUserIds: [] })).toBe(
      false,
    );
  });

  it("does not treat the operator or gameplay lanes as a Discord grant", () => {
    // The console is privileged by being the console, not by this list.
    for (const lane of ["operator", "gameplay"] as const) {
      expect(discordTurnHasSystemTools({ lane, actorId: ACTOR, systemActorUserIds: [ACTOR] })).toBe(false);
    }
  });
});

describe("discordTurnUsesDurableSession", () => {
  it("takes a privileged turn off the shared voice session", () => {
    // The grant must not outlive the speaker who earned it: builtins bound to
    // the channel's durable session would still be there for whoever talks next.
    expect(discordTurnUsesDurableSession({ durable: true, systemTools: true })).toBe(false);
    expect(discordTurnUsesDurableSession({ durable: true, systemTools: false })).toBe(true);
  });

  it("leaves one-shot text turns one-shot either way", () => {
    expect(discordTurnUsesDurableSession({ durable: false, systemTools: true })).toBe(false);
    expect(discordTurnUsesDurableSession({ durable: false, systemTools: false })).toBe(false);
  });
});

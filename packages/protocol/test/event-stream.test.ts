import { describe, expect, it } from "vitest";
import {
  DomainEventSchema,
  EVENT_STREAM_KINDS,
  RESERVED_EVENT_STREAM_PREFIXES,
  classifyEventStream,
  eventStreamKindForId,
  isMissionEventStream,
} from "../src/index.ts";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-1",
    occurredAt: "2026-07-26T00:00:00.000Z",
    missionId: "mission-1",
    correlationId: "mission-1",
    profileHash: "profile-1",
    type: "mission.drafted",
    data: {},
    ...overrides,
  };
}

describe("event stream identity", () => {
  it("maps every reserved namespace to its kind", () => {
    expect(eventStreamKindForId("captain-presence")).toBe("captain_presence");
    expect(eventStreamKindForId("captain:episodes")).toBe("captain_episodes");
    expect(eventStreamKindForId("captain-project:clankie")).toBe("captain_project");
    expect(eventStreamKindForId("discord-presence:discord:bot:app:uuid")).toBe("discord_presence");
    expect(eventStreamKindForId("discord-user-session:opt-in")).toBe("discord_user_session");
    expect(eventStreamKindForId("discord-person:guild-1:user-1")).toBe("person_memory");
    expect(eventStreamKindForId("embodiment:session-1")).toBe("embodiment");
    expect(eventStreamKindForId("memory:retention")).toBe("memory_retention");
    expect(eventStreamKindForId("trigger:trigger-1")).toBe("trigger");
    expect(eventStreamKindForId("pairing:offer-1")).toBe("pairing");
    expect(eventStreamKindForId("device:device-1")).toBe("device");
    expect(eventStreamKindForId("character:clankie")).toBe("character");
    expect(eventStreamKindForId("provider-readiness")).toBe("diagnostic");
  });

  it("treats an unreserved id as a mission", () => {
    expect(eventStreamKindForId("mission-3280ef37-add")).toBe("mission");
    expect(eventStreamKindForId("captain-presence-but-not-really")).toBe("mission");
  });

  it("matches an exact namespace without swallowing its siblings", () => {
    expect(eventStreamKindForId("memory:retention")).toBe("memory_retention");
    expect(eventStreamKindForId("memory:retention:extra")).toBe("mission");
  });

  it("prefers the stamped kind over namespace inference", () => {
    // A stamped event is authoritative even when its id looks like a mission,
    // so the namespace table never has to stay in sync with future writers.
    expect(classifyEventStream({ missionId: "opaque-id", streamKind: "embodiment" })).toBe("embodiment");
    expect(isMissionEventStream({ missionId: "opaque-id", streamKind: "embodiment" })).toBe(false);
  });

  it("classifies a legacy event that predates the stamped field", () => {
    expect(classifyEventStream({ missionId: "discord-presence:discord:bot:x" })).toBe("discord_presence");
    expect(isMissionEventStream({ missionId: "discord-presence:discord:bot:x" })).toBe(false);
    expect(isMissionEventStream({ missionId: "mission-1" })).toBe(true);
  });

  it("exposes reserved prefixes so a mission id can never collide", () => {
    expect(RESERVED_EVENT_STREAM_PREFIXES).toContain("discord-presence:");
    for (const prefix of RESERVED_EVENT_STREAM_PREFIXES) {
      expect(eventStreamKindForId(`${prefix}anything`)).not.toBe("mission");
    }
  });

  it("declares every kind the namespace table can produce", () => {
    const produced = new Set(
      [
        "captain-presence",
        "captain:episodes",
        "captain-project:a",
        "discord-presence:a",
        "discord-user-session:a",
        "discord-person:a",
        "embodiment:a",
        "memory:retention",
        "trigger:a",
        "pairing:a",
        "device:a",
        "character:a",
        "provider-readiness",
        "mission-a",
      ].map(eventStreamKindForId),
    );
    expect([...produced].sort()).toEqual([...EVENT_STREAM_KINDS].sort());
  });
});

describe("DomainEvent envelope", () => {
  it("accepts an event with no streamKind so historical events stay readable", () => {
    const parsed = DomainEventSchema.parse(envelope());
    expect(parsed.streamKind).toBeUndefined();
    expect("streamKind" in parsed).toBe(false);
  });

  it("round-trips a stamped kind", () => {
    const parsed = DomainEventSchema.parse(envelope({ streamKind: "discord_presence" }));
    expect(parsed.streamKind).toBe("discord_presence");
  });

  it("rejects an unknown kind", () => {
    expect(() => DomainEventSchema.parse(envelope({ streamKind: "not-a-kind" }))).toThrow();
  });

  it("never materializes streamKind on parse, so sealed hashes stay stable", () => {
    // `seal()` re-parses before hashing. A default here would change the hash of
    // every event already on disk and break verifyChain.
    const before = envelope();
    expect(JSON.stringify(DomainEventSchema.parse(before))).toBe(
      JSON.stringify(DomainEventSchema.parse(DomainEventSchema.parse(before))),
    );
  });
});

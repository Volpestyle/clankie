import { describe, expect, it } from "vitest";
import { DiscordVoiceConsentRegistry } from "../src/voice-consent.ts";

describe("Discord group voice consent", () => {
  it("permits only explicit session-bound participants and forgets them on exit", () => {
    const consent = new DiscordVoiceConsentRegistry();
    consent.open("guild-1", "voice-1", "user-1");
    expect(consent.permits("guild-1", "voice-1", "user-1")).toBe(true);
    expect(consent.permits("guild-1", "voice-1", "user-2")).toBe(false);
    consent.set("guild-1", "voice-1", "user-2", true);
    expect(consent.current()?.consentedUserIds).toEqual(new Set(["user-1", "user-2"]));

    consent.memberChannelChanged("user-2", "voice-2");
    expect(consent.permits("guild-1", "voice-1", "user-2")).toBe(false);
    consent.close();
    expect(consent.current()).toBeUndefined();
    expect(consent.permits("guild-1", "voice-1", "user-1")).toBe(false);
  });

  it("an open with no invoker permits nobody — the asker included — until explicit opt-in", () => {
    // The asked-join path (ADR 0062): asking him into the channel grants
    // nothing; consent still arrives only through /clankie voice-consent.
    const consent = new DiscordVoiceConsentRegistry();
    const session = consent.open("guild-1", "voice-1");
    expect(session.consentedUserIds.size).toBe(0);
    expect(consent.permits("guild-1", "voice-1", "asker")).toBe(false);
    consent.set("guild-1", "voice-1", "asker", true);
    expect(consent.permits("guild-1", "voice-1", "asker")).toBe(true);
  });

  it("refuses consent outside the active guild/channel", () => {
    const consent = new DiscordVoiceConsentRegistry();
    consent.open("guild-1", "voice-1", "user-1");
    expect(() => consent.set("guild-2", "voice-1", "user-2", true)).toThrow("active guild");
    expect(() => consent.set("guild-1", "voice-2", "user-2", true)).toThrow("active guild");
  });

  it("presence policy consents the room, only in the active channel, and never a refuser", () => {
    // The owner's call for a private room whose participants know he
    // transcribes when he is in it: presence implies yes.
    const consent = new DiscordVoiceConsentRegistry("presence");
    consent.open("guild-1", "voice-1");
    expect(consent.permits("guild-1", "voice-1", "anyone")).toBe(true);
    // Only the room he is actually in; a closed session permits nobody.
    expect(consent.permits("guild-1", "voice-2", "anyone")).toBe(false);

    // Saying no always wins over presence, and rejoining must not undo it.
    consent.set("guild-1", "voice-1", "objector", false);
    expect(consent.permits("guild-1", "voice-1", "objector")).toBe(false);
    consent.memberChannelChanged("objector", undefined);
    consent.memberChannelChanged("objector", "voice-1");
    expect(consent.permits("guild-1", "voice-1", "objector")).toBe(false);
    // Opting back in clears the refusal.
    consent.set("guild-1", "voice-1", "objector", true);
    expect(consent.permits("guild-1", "voice-1", "objector")).toBe(true);

    consent.close();
    expect(consent.permits("guild-1", "voice-1", "anyone")).toBe(false);
  });

  it("reports the room as permitted under presence, not the empty opt-in list", () => {
    // The bug this exists to stop: person memory resolves for whoever may be
    // heard, and under `presence` the explicit opt-in set is empty forever — so
    // reading it answered "nobody" about a room he was lawfully listening to.
    const consent = new DiscordVoiceConsentRegistry("presence");
    consent.open("guild-1", "voice-1");
    expect(consent.current()?.consentedUserIds.size).toBe(0);

    expect(consent.permitted("guild-1", "voice-1", ["alice", "bob"])).toEqual(["alice", "bob"]);
    // A refusal still removes someone from the room's permitted set.
    consent.set("guild-1", "voice-1", "bob", false);
    expect(consent.permitted("guild-1", "voice-1", ["alice", "bob"])).toEqual(["alice"]);
    // Never a room he is not in.
    expect(consent.permitted("guild-1", "voice-2", ["alice"])).toEqual([]);
  });

  it("keeps explicit consent authoritative regardless of who is in the room", () => {
    // Under `explicit`, presence is not consent and an occupant list must not
    // become a back door into being heard.
    const consent = new DiscordVoiceConsentRegistry("explicit");
    consent.open("guild-1", "voice-1", "invoker");
    expect(consent.permitted("guild-1", "voice-1", ["invoker", "lurker"])).toEqual(["invoker"]);
  });

  it("explicit policy still honours a refusal after a later accidental opt-in path", () => {
    const consent = new DiscordVoiceConsentRegistry();
    consent.open("guild-1", "voice-1", "user-1");
    consent.set("guild-1", "voice-1", "user-1", false);
    expect(consent.permits("guild-1", "voice-1", "user-1")).toBe(false);
  });
});

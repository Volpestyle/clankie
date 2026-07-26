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
});

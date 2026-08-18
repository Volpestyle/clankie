import { describe, expect, it, vi } from "vitest";
import { DiscordVoiceIngress } from "../src/voice-ingress.ts";

const turn = {
  deliveryId: "utterance-1",
  guildId: "12345",
  channelId: "67890",
  userId: "24680",
  transcript: " hello   Clankie ",
  presenceSessionId: "presence-1",
};

describe("Discord voice ingress", () => {
  it("attributes a bounded transcript to the durable voice lane", async () => {
    const submit = vi.fn().mockResolvedValue({
      state: "settled",
      captainSessionId: "session-1",
      turnId: "turn-1",
      response: "Hello everyone.",
    });
    const ingress = new DiscordVoiceIngress(
      {
        getHealth: vi.fn().mockResolvedValue({ profileHash: "profile-1" }),
        submitDiscordCaptainChannelTurn: submit,
      },
      { characterId: "clankie", credentialRef: "discord_bot", transportKind: "bot" },
    );

    await expect(ingress.handle(turn)).resolves.toEqual({
      state: "settled",
      turnId: "turn-1",
      response: "Hello everyone.",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "utterance-1",
        identity: expect.objectContaining({
          presenceSessionId: "presence-1",
          profileHash: "profile-1",
        }),
        trigger: {
          kind: "voice_event",
          id: "utterance-1",
          guildId: "12345",
          channelId: "67890",
          actorId: "24680",
          body: "hello Clankie",
          // Spoken audio carries no attachments; the schema default applies to
          // every trigger kind so one shape covers both planes.
          attachments: [],
        },
      }),
    );
  });

  it("never speaks an approval payload into ambient voice", async () => {
    const ingress = new DiscordVoiceIngress(
      {
        getHealth: vi.fn().mockResolvedValue({ profileHash: "profile-1" }),
        submitDiscordCaptainChannelTurn: vi.fn().mockResolvedValue({
          state: "waiting_user",
          captainSessionId: "session-1",
          turnId: "turn-2",
          prompt: "Approve secret operation abc?",
          approvalRequired: true,
        }),
      },
      { characterId: "clankie", credentialRef: "discord_bot", transportKind: "bot" },
    );
    const outcome = await ingress.handle(turn);
    expect(outcome).toEqual({
      state: "waiting_user",
      turnId: "turn-2",
      approvalRequired: true,
      response: "I need you to continue that request on the authenticated operator surface.",
    });
    expect(JSON.stringify(outcome)).not.toContain("secret operation");
  });

  it("keeps absorbed distinct from a captain decline", async () => {
    const ingress = new DiscordVoiceIngress(
      {
        getHealth: vi.fn().mockResolvedValue({ profileHash: "profile-1" }),
        submitDiscordCaptainChannelTurn: vi.fn().mockResolvedValue({
          state: "absorbed",
          captainSessionId: "session-1",
          turnId: "turn-absorbed",
        }),
      },
      { characterId: "clankie", credentialRef: "discord_bot", transportKind: "bot" },
    );
    await expect(ingress.handle(turn)).resolves.toEqual({
      state: "absorbed",
      turnId: "turn-absorbed",
    });
  });

  it("rejects an empty transcript before a captain call", async () => {
    const submit = vi.fn();
    const ingress = new DiscordVoiceIngress(
      { getHealth: vi.fn(), submitDiscordCaptainChannelTurn: submit },
      { characterId: "clankie", credentialRef: "discord_bot", transportKind: "bot" },
    );
    await expect(ingress.handle({ ...turn, transcript: "   " })).resolves.toEqual({
      state: "failed",
      code: "voice_transcript_empty",
    });
    expect(submit).not.toHaveBeenCalled();
  });
});

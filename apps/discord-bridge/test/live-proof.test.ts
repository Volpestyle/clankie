import type { DiscordBridgeReceipt } from "@clankie/discord-presence-core";
import { describe, expect, it } from "vitest";
import {
  evaluateDiscordLiveProof,
  evaluateDiscordPersonMemoryLiveProof,
  evaluateDiscordVoiceLiveProof,
} from "../src/live-proof.ts";

describe("Discord text live proof", () => {
  it("requires a real settled reply", () => {
    const receipts = [
      receipt("discord.bridge.ready", {}),
      receipt("discord.text.ingress", { deliveryId: "m1", outcome: "accepted" }),
      receipt("discord.text.ingress", { deliveryId: "m1", outcome: "settled" }),
      receipt("discord.text.reply", { deliveryId: "m1", responseMessageId: "r1" }),
    ];

    expect(evaluateDiscordLiveProof(receipts)).toMatchObject({
      passed: true,
      receiptCount: 4,
    });
  });

  it("does not mistake unit-level or partial receipts for live completion", () => {
    const report = evaluateDiscordLiveProof([
      receipt("discord.bridge.ready", {}),
      receipt("discord.text.ingress", { deliveryId: "m1", outcome: "accepted" }),
    ]);

    expect(report.passed).toBe(false);
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "bounded text round trip",
    ]);
  });
});

describe("Discord person-memory live proof", () => {
  it("requires the exact proposed fact to survive a service restart", () => {
    const report = evaluateDiscordPersonMemoryLiveProof([
      receipt("discord.person-memory.proposed", {
        guildId: "guild-1",
        userId: "user-1",
        channelId: "channel-1",
        controlPlaneInstanceId: "boot-1",
        proposalId: "proposal-1",
        factId: "fact-1",
      }),
      receipt("discord.person-memory.recalled", {
        guildId: "guild-1",
        userId: "user-1",
        channelId: "channel-1",
        controlPlaneInstanceId: "boot-2",
        factId: "fact-1",
        factCount: 1,
      }),
    ]);

    expect(report.passed).toBe(true);
  });

  it("rejects RAM-only recall and unrelated facts", () => {
    const proposal = receipt("discord.person-memory.proposed", {
      guildId: "guild-1",
      userId: "user-1",
      controlPlaneInstanceId: "boot-1",
      proposalId: "proposal-1",
      factId: "fact-1",
    });
    const sameBoot = evaluateDiscordPersonMemoryLiveProof([
      proposal,
      receipt("discord.person-memory.recalled", {
        guildId: "guild-1",
        userId: "user-1",
        controlPlaneInstanceId: "boot-1",
        factId: "fact-1",
      }),
    ]);
    const unrelated = evaluateDiscordPersonMemoryLiveProof([
      proposal,
      receipt("discord.person-memory.recalled", {
        guildId: "guild-1",
        userId: "user-1",
        controlPlaneInstanceId: "boot-2",
        factId: "fact-2",
      }),
    ]);

    expect(sameBoot.checks.find((check) => check.name === "service restart durability")?.ok).toBe(false);
    expect(unrelated.checks.find((check) => check.name === "fact recalled")?.ok).toBe(false);
  });
});

describe("Discord group voice live proof", () => {
  it("requires DAVE plus three consented, attributed, answered speakers and a clean leave", () => {
    const receipts: DiscordBridgeReceipt[] = [
      voxReadyReceipt(),
      receipt("discord.voice.joined", {
        guildId: "guild-1",
        channelId: "voice-1",
        daveProtocolVersion: 1,
      }),
    ];
    receipts.push(...playSeamReceipts());
    for (const [index, userId] of ["user-1", "user-2", "user-3"].entries()) {
      receipts.push(
        receipt("discord.voice.consent", {
          guildId: "guild-1",
          channelId: "voice-1",
          userId,
          consented: true,
          participantCount: index + 1,
        }),
        receipt("discord.voice.utterance", {
          guildId: "guild-1",
          channelId: "voice-1",
          userId,
          deliveryId: `delivery-${String(index + 1)}`,
          durationMs: 1_000,
        }),
        receipt("discord.voice.response", {
          guildId: "guild-1",
          channelId: "voice-1",
          deliveryId: `delivery-${String(index + 1)}`,
          turnId: `turn-${String(index + 1)}`,
          state: "settled",
        }),
      );
    }
    receipts.push(
      receipt("discord.voice.overlap", {
        guildId: "guild-1",
        channelId: "voice-1",
        userId: "user-2",
        activeCaptureCount: 2,
      }),
      receipt("discord.voice.interrupted", {
        guildId: "guild-1",
        channelId: "voice-1",
        userId: "user-3",
        phase: "playing",
      }),
    );
    receipts.push(...cleanLeaveReceipts());
    receipts.push(
      receipt("discord.voice.joined", {
        guildId: "guild-1",
        channelId: "voice-1",
        daveProtocolVersion: 1,
      }),
      ...cleanLeaveReceipts(),
    );

    expect(evaluateDiscordVoiceLiveProof(receipts)).toMatchObject({ passed: true });
  });

  it("evaluates the latest complete qualifying session in a cumulative receipt log", () => {
    const receipts: DiscordBridgeReceipt[] = [
      voxReadyReceipt(),
      receipt("discord.voice.joined", {
        guildId: "guild-1",
        channelId: "voice-1",
        daveProtocolVersion: 1,
      }),
      receipt("discord.voice.consent", {
        guildId: "guild-1",
        channelId: "voice-1",
        userId: "historical-user",
        consented: true,
        participantCount: 1,
      }),
      receipt("discord.voice.failed", {
        guildId: "guild-1",
        channelId: "voice-1",
        stage: "playback",
        code: "voice_playback_timeout",
      }),
      ...cleanLeaveReceipts(),
      // This abandoned join used to poison proof selection because the first
      // historical join was treated as the active session. It is replaced by
      // the following coherent session rather than borrowing its leave.
      receipt("discord.voice.joined", {
        guildId: "guild-1",
        channelId: "voice-1",
        daveProtocolVersion: 1,
      }),
      receipt("discord.voice.joined", {
        guildId: "guild-1",
        channelId: "voice-1",
        daveProtocolVersion: 1,
      }),
      ...playSeamReceipts(),
    ];
    for (const [index, userId] of ["user-1", "user-2", "user-3"].entries()) {
      receipts.push(
        receipt("discord.voice.consent", {
          guildId: "guild-1",
          channelId: "voice-1",
          userId,
          consented: true,
          participantCount: index + 1,
        }),
        receipt("discord.voice.utterance", {
          guildId: "guild-1",
          channelId: "voice-1",
          userId,
          deliveryId: `latest-delivery-${String(index + 1)}`,
          durationMs: 1_000,
        }),
        receipt("discord.voice.response", {
          guildId: "guild-1",
          channelId: "voice-1",
          deliveryId: `latest-delivery-${String(index + 1)}`,
          turnId: `latest-turn-${String(index + 1)}`,
          state: "settled",
        }),
      );
    }
    receipts.push(
      receipt("discord.voice.overlap", {
        guildId: "guild-1",
        channelId: "voice-1",
        userId: "user-2",
        activeCaptureCount: 2,
      }),
      receipt("discord.voice.interrupted", {
        guildId: "guild-1",
        channelId: "voice-1",
        userId: "user-3",
        phase: "playing",
      }),
      ...cleanLeaveReceipts(),
      // Reconnect proof: complete, but no participant activity, so it must not
      // be selected as the main proof session.
      receipt("discord.voice.joined", {
        guildId: "guild-1",
        channelId: "voice-1",
        daveProtocolVersion: 1,
      }),
      ...cleanLeaveReceipts(),
    );

    const report = evaluateDiscordVoiceLiveProof(receipts);
    expect(report.passed).toBe(true);
    expect(report.checks.find((check) => check.name === "DAVE voice session")?.detail).toContain(
      "latest complete qualifying",
    );
  });

  it("rejects a synthetic single-speaker or failed media path", () => {
    const report = evaluateDiscordVoiceLiveProof([
      voxReadyReceipt(),
      receipt("discord.voice.joined", {
        guildId: "guild-1",
        channelId: "voice-1",
        daveProtocolVersion: 1,
      }),
      receipt("discord.voice.consent", {
        guildId: "guild-1",
        channelId: "voice-1",
        userId: "user-1",
        consented: true,
        participantCount: 1,
      }),
      receipt("discord.voice.failed", {
        guildId: "guild-1",
        channelId: "voice-1",
        stage: "speech_to_text",
        code: "voice_transcription_failed",
      }),
    ]);
    expect(report.passed).toBe(false);
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "three explicit participants",
      "three attributed speakers",
      "speech round trips",
      "overlap and barge-in",
      "clean leave",
      "play room state",
      "play two-way delivery",
      "DAVE reconnect",
    ]);
  });

  it("does not let an older ceremony hide a newer failed DAVE session", () => {
    const receipts = passingVoiceCeremony();
    receipts.push(
      receipt("discord.voice.joined", {
        guildId: "guild-1",
        channelId: "voice-1",
        daveProtocolVersion: 1,
      }),
      receipt("discord.voice.failed", {
        guildId: "guild-1",
        channelId: "voice-1",
        stage: "playback",
        code: "voice_playback_timeout",
      }),
    );

    const report = evaluateDiscordVoiceLiveProof(receipts);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === "DAVE voice session")).toMatchObject({
      ok: true,
      detail: expect.stringContaining("no matching leave"),
    });
    expect(report.checks.find((check) => check.name === "speech round trips")?.detail).toContain(
      "1 failure receipt",
    );
  });

  it("does not count a refused play narration as two-way delivery", () => {
    const receipts = passingVoiceCeremony();
    const submission = receipts.find((entry) => entry.type === "discord.voice.play_narration_submission");
    expect(submission).toBeDefined();
    const deliveryId = submission?.data.deliveryId;
    if (typeof deliveryId !== "string") throw new Error("passing fixture has no narration delivery id");
    const mainLeaveIndex = receipts.findIndex((entry) => entry.type === "discord.voice.left");
    receipts.splice(
      mainLeaveIndex,
      0,
      receipt("discord.voice.play_refusal", {
        deliveryId,
        attachedCount: 1,
        reason: "voice_narration_not_in_channel",
      }),
    );

    const report = evaluateDiscordVoiceLiveProof(receipts);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === "play two-way delivery")?.detail).toContain(
      "1 refusal",
    );
  });

  it("rejects a ceremony whose bridge receipt does not prove Vox owns media", () => {
    const receipts = passingVoiceCeremony().filter((entry) => entry.type !== "discord.bridge.ready");
    const report = evaluateDiscordVoiceLiveProof(receipts);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === "Vox media owner")?.ok).toBe(false);
  });

  it("does not accept the session's early internal left receipt as clean leave proof", () => {
    const receipts = passingVoiceCeremony().filter(
      (entry) => entry.type !== "discord.voice.left" || entry.data.gatewayConfirmed !== true,
    );
    const report = evaluateDiscordVoiceLiveProof(receipts);

    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === "clean leave")).toMatchObject({
      ok: false,
      detail: "no matching gateway-confirmed Vox-owned leave receipt",
    });
  });
});

function passingVoiceCeremony(): DiscordBridgeReceipt[] {
  const receipts: DiscordBridgeReceipt[] = [
    voxReadyReceipt(),
    receipt("discord.voice.joined", {
      guildId: "guild-1",
      channelId: "voice-1",
      daveProtocolVersion: 1,
    }),
    ...playSeamReceipts(),
  ];
  for (const [index, userId] of ["user-1", "user-2", "user-3"].entries()) {
    receipts.push(
      receipt("discord.voice.consent", {
        guildId: "guild-1",
        channelId: "voice-1",
        userId,
        consented: true,
        participantCount: index + 1,
      }),
      receipt("discord.voice.utterance", {
        guildId: "guild-1",
        channelId: "voice-1",
        userId,
        deliveryId: `passing-delivery-${String(index + 1)}`,
        durationMs: 1_000,
      }),
      receipt("discord.voice.response", {
        guildId: "guild-1",
        channelId: "voice-1",
        deliveryId: `passing-delivery-${String(index + 1)}`,
        turnId: `passing-turn-${String(index + 1)}`,
        state: "settled",
      }),
    );
  }
  receipts.push(
    receipt("discord.voice.overlap", {
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-2",
      activeCaptureCount: 2,
    }),
    receipt("discord.voice.interrupted", {
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-3",
      phase: "playing",
    }),
    ...cleanLeaveReceipts(),
    receipt("discord.voice.joined", {
      guildId: "guild-1",
      channelId: "voice-1",
      daveProtocolVersion: 1,
    }),
    ...cleanLeaveReceipts(),
  );
  return receipts;
}

function voxReadyReceipt(): DiscordBridgeReceipt {
  return receipt("discord.bridge.ready", { mediaOwner: "vox", voxProcessReady: true });
}

function cleanLeaveReceipts(): DiscordBridgeReceipt[] {
  return [
    receipt("discord.voice.left", { guildId: "guild-1", channelId: "voice-1" }),
    receipt("discord.voice.left", {
      guildId: "guild-1",
      channelId: "voice-1",
      gatewayConfirmed: true,
      mediaOwner: "vox",
    }),
  ];
}

function playSeamReceipts(): DiscordBridgeReceipt[] {
  return [
    receipt("discord.voice.play_connection", { phase: "attached", attachedCount: 1 }),
    receipt("discord.voice.play_room", { listening: true, attachedCount: 1, deliveredCount: 1 }),
    receipt("discord.voice.play_transcript_delivery", {
      deliveryId: "play-heard-1",
      attachedCount: 1,
      deliveredCount: 1,
    }),
    receipt("discord.voice.play_narration_submission", {
      deliveryId: "play-narration-1",
      attachedCount: 1,
    }),
  ];
}

function receipt(
  type: DiscordBridgeReceipt["type"],
  data: DiscordBridgeReceipt["data"],
): DiscordBridgeReceipt {
  receiptOrdinal += 1;
  return {
    schemaVersion: 1,
    id: `receipt-${receiptOrdinal.toString()}`,
    occurredAt: `2026-07-25T16:20:${receiptOrdinal.toString().padStart(2, "0")}.000Z`,
    type,
    data,
  };
}

let receiptOrdinal = 0;

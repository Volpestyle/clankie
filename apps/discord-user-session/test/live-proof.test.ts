import type { DiscordBridgeReceipt } from "@clankie/discord-presence-core";
import { VOX_IPC_PROTOCOL_VERSION } from "@clankie/vox-client";
import { describe, expect, it } from "vitest";
import { evaluateStreamPublishLiveProof, evaluateStreamWatchLiveProof } from "../src/live-proof.ts";

function receipt(
  type: DiscordBridgeReceipt["type"],
  data: DiscordBridgeReceipt["data"],
  second: number,
): DiscordBridgeReceipt {
  return {
    schemaVersion: 1,
    id: `r-${type}-${String(second)}`,
    occurredAt: `2026-08-15T00:00:${String(second).padStart(2, "0")}.000Z`,
    type,
    data,
  };
}

const readyData = {
  readyId: "ready-1",
  readySequence: 1,
  mediaOwner: "vox",
  voxProcessReady: true,
  protocolVersion: VOX_IPC_PROTOCOL_VERSION,
  gatewayReadyAt: "2026-08-15T00:00:00.000Z",
  voxProcessReadyAt: "2026-08-15T00:00:00.000Z",
} as const;

const watchReadyData = {
  readyId: "ready-1",
  userId: "777777777777777777",
  channelId: "444444444444444444",
  decoder: "ready",
  transportReady: true,
  daveReady: true,
  daveProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
} as const;

describe("stream live proof", () => {
  it("passes watch proof only after fresh process, transport, DAVE, and still evidence", () => {
    const report = evaluateStreamWatchLiveProof([
      receipt("discord.user_session.ready", readyData, 1),
      receipt("discord.stream.watch_connected", watchReadyData, 2),
      receipt(
        "discord.stream.frame",
        { readyId: "ready-1", userId: "777777777777777777", width: 1280, height: 720 },
        3,
      ),
    ]);
    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("does not treat transport readiness without positive role DAVE as watch or publish proof", () => {
    const receipts = [
      receipt("discord.user_session.ready", readyData, 1),
      receipt(
        "discord.stream.watch_connected",
        { ...watchReadyData, daveReady: false, daveProtocolVersion: 0 },
        2,
      ),
      receipt(
        "discord.stream.publish_started",
        {
          readyId: "ready-1",
          transportReady: true,
          daveReady: false,
          daveProtocolVersion: 0,
        },
        3,
      ),
    ];
    expect(
      evaluateStreamWatchLiveProof(receipts).checks.find((check) => check.name.includes("DAVE"))?.ok,
    ).toBe(false);
    expect(evaluateStreamPublishLiveProof(receipts).passed).toBe(false);
  });

  it("rejects stale pre-migration ready receipts", () => {
    const report = evaluateStreamWatchLiveProof([
      receipt("discord.user_session.ready", { userId: "legacy" }, 1),
      receipt("discord.stream.watch_connected", watchReadyData, 2),
      receipt(
        "discord.stream.frame",
        { readyId: "ready-1", userId: "777777777777777777", width: 1280, height: 720 },
        3,
      ),
    ]);
    expect(report.passed).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "user session ready", ok: false });
  });

  it("rejects a still before the watch or from another ready process or user", () => {
    const stale = evaluateStreamWatchLiveProof([
      receipt("discord.user_session.ready", readyData, 1),
      receipt(
        "discord.stream.frame",
        { readyId: "ready-1", userId: "777777777777777777", width: 1280, height: 720 },
        2,
      ),
      receipt("discord.stream.watch_connected", watchReadyData, 3),
    ]);
    expect(stale.passed).toBe(false);

    const mismatched = evaluateStreamWatchLiveProof([
      receipt("discord.user_session.ready", readyData, 1),
      receipt("discord.stream.watch_connected", watchReadyData, 2),
      receipt(
        "discord.stream.frame",
        { readyId: "other-ready", userId: "888888888888888888", width: 1280, height: 720 },
        3,
      ),
    ]);
    expect(mismatched.passed).toBe(false);
  });

  it("evaluates content-free publish proof with matching transport and DAVE evidence", () => {
    const report = evaluateStreamPublishLiveProof([
      receipt("discord.user_session.ready", readyData, 1),
      receipt(
        "discord.stream.publish_started",
        {
          readyId: "ready-1",
          guildId: "222222222222222222",
          channelId: "444444444444444444",
          source: "activity",
          transportReady: true,
          daveReady: true,
          daveProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
          op18Accepted: true,
          op22Accepted: true,
          mediaStarted: true,
          connectionGeneration: 1,
          sourceGeneration: 1,
        },
        2,
      ),
    ]);
    expect(report.passed).toBe(true);
  });

  it("rejects publish evidence before fresh readiness or without first-media acceptance", () => {
    const publish = receipt(
      "discord.stream.publish_started",
      {
        readyId: "ready-1",
        transportReady: true,
        daveReady: true,
        daveProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
        op18Accepted: true,
        op22Accepted: true,
        mediaStarted: true,
        connectionGeneration: 1,
        sourceGeneration: 1,
      },
      1,
    );
    expect(
      evaluateStreamPublishLiveProof([publish, receipt("discord.user_session.ready", readyData, 2)]).passed,
    ).toBe(false);
    expect(
      evaluateStreamPublishLiveProof([
        receipt("discord.user_session.ready", readyData, 1),
        receipt(
          "discord.stream.publish_started",
          {
            readyId: "ready-1",
            transportReady: true,
            daveReady: true,
            daveProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
            op18Accepted: true,
            op22Accepted: true,
          },
          2,
        ),
      ]).checks.find((check) => check.name === "first H264 accepted")?.ok,
    ).toBe(false);
  });
});

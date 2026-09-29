import { expect, it } from "vitest";
import { gatewayDiagnostic } from "../src/gateway-diagnostics.ts";

it.each([
  ["Zombie connection", "heartbeat_ack_missing"],
  ["Told to reconnect by Discord", "discord_requested_reconnect"],
  ["Got disconnected by Discord", "discord_closed"],
])("classifies %s without copying raw debug", (reason, expected) => {
  expect(
    gatewayDiagnostic(
      `[WS => Shard 0] Destroying shard\n\tReason: ${reason}\n\tCode: 4200\n\tRecover: Resume`,
    ),
  ).toEqual({ shardId: 0, event: "destroy", reason: expected, code: 4200 });
});
it("retains replay and invalidation facts, dropping credentials, payloads and unknown reasons", () => {
  expect(gatewayDiagnostic("[WS => Shard 1] Resumed and replayed 12 events")).toEqual({
    shardId: 1,
    event: "resumed",
    replayedEvents: 12,
  });
  expect(gatewayDiagnostic("[WS => Shard 0] Invalid session; will attempt to resume: false")).toEqual({
    shardId: 0,
    event: "invalid_session",
    resumable: false,
  });
  expect(
    gatewayDiagnostic(
      "[WS => Shard 0] The gateway closed with an unexpected code 1006, attempting to resume.",
    ),
  ).toEqual({ shardId: 0, event: "closed", code: 1006 });
  expect(gatewayDiagnostic("[WS => Shard 0] Identifying with token: SECRET")).toBeUndefined();
  expect(gatewayDiagnostic("[WS => Shard 0] MESSAGE_CREATE private body")).toBeUndefined();
  expect(gatewayDiagnostic("[WS => Shard 0] Destroying shard\n\tReason: SECRET\n\tCode: 1000")).toEqual({
    shardId: 0,
    event: "destroy",
    reason: "other",
    code: 1000,
  });
});

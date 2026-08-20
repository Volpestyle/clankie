import { VOX_IPC_PROTOCOL_VERSION } from "@clankie/vox-client";
import { describe, expect, it } from "vitest";
import { userSessionHealth } from "../src/health.ts";

describe("user-session health", () => {
  it("requires gateway READY and the exact Vox process protocol", () => {
    const vox = { status: "ready" as const, detail: "vox" };
    expect(
      userSessionHealth({
        gatewayStatus: "ready",
        presenceReady: true,
        vox,
        voxProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
      }).ok,
    ).toBe(true);
    expect(
      userSessionHealth({
        gatewayStatus: "connecting",
        presenceReady: true,
        vox,
        voxProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
      }).ok,
    ).toBe(false);
    expect(
      userSessionHealth({
        gatewayStatus: "ready",
        presenceReady: true,
        vox,
        voxProtocolVersion: 999,
      }).ok,
    ).toBe(false);
    expect(
      userSessionHealth({
        gatewayStatus: "ready",
        presenceReady: false,
        vox,
        voxProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
      }).ok,
    ).toBe(false);
  });

  it("never recovers from a terminal failure inside the same process", () => {
    expect(
      userSessionHealth({
        gatewayStatus: "ready",
        presenceReady: true,
        vox: { status: "ready", detail: "vox" },
        voxProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
        terminalFailure: "Vox exited unexpectedly",
      }).ok,
    ).toBe(false);
    expect(
      userSessionHealth({
        gatewayStatus: "failed",
        presenceReady: false,
        vox: { status: "error", detail: "Vox exited unexpectedly" },
        voxProtocolVersion: VOX_IPC_PROTOCOL_VERSION,
      }).ok,
    ).toBe(false);
  });
});
